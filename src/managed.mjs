import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, request } from './http.mjs';
import { parseOpenDrive } from './opendrive.mjs';
import { interpretTopology } from './topology.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

// managed 结构化接入：
// 阶段 planned -> fetched -> interpreted -> committed，每阶段写游标，
// 在“原件已留存、关系尚未提交”的边界终止进程后，重跑可凭 raw 证据与游标识别待办并继续。
export async function runManaged({ base, repository, entry = fixture.entry, hooks = {} }) {
  const runId = randomUUID();
  const state = repository.snapshot();
  reconcileDocuments(repository, state);

  const catalog = await json(base, entry);
  const plan = catalog.documents.map(({ id, path, href, format, revision }) =>
    ({ id, path, href, format, revision }));
  await repository.cursor('managed', {
    runId, phase: 'planned', sourceRevision: catalog.revision, at: new Date().toISOString(), plan,
  });
  await hooks.onPhase?.('planned', { runId, plan });

  const documents = repository.documents();
  const failures = [];
  let newlyRetained = 0;
  let conditionalHits = 0;

  for (const doc of plan) {
    const known = documents[doc.id];
    const response = await request(base, doc.href, known?.etag ? { headers: { 'if-none-match': known.etag } } : {});
    if (response.status === 304 && known) {
      conditionalHits += 1;
      continue;
    }
    if (response.status === 304) {
      failures.push({
        id: doc.id, path: doc.path, status: 304, reason: 'conditional-hit-without-evidence',
        degraded: false, digest: null,
      });
      continue;
    }
    if (!response.ok) {
      // 缺件/临时失败只隔离对应文档：有旧版本就继续用旧证据解释，已确认内容不凭空消失。
      failures.push({
        id: doc.id, path: doc.path, status: response.status,
        reason: response.status === 404 ? 'not-delivered' : 'temporarily-unavailable',
        degraded: Boolean(known), digest: known?.digest ?? null,
      });
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = await repository.retain(doc.path, bytes, {
      etag: response.headers.get('etag'), revision: doc.revision, documentId: doc.id,
    });
    if (!known || known.digest !== digest) newlyRetained += 1;
    const previousRevisions = known?.digest && known.digest !== digest
      ? [...(known.revisions ?? []), { digest: known.digest, revision: known.revision, etag: known.etag }]
      : known?.revisions ?? [];
    documents[doc.id] = {
      id: doc.id, path: doc.path, format: doc.format, revision: doc.revision,
      etag: response.headers.get('etag'), digest, fetchedAt: new Date().toISOString(),
      revisions: previousRevisions,
    };
    repository.state.documents = structuredClone(documents);
    await repository.save();
  }

  await repository.cursor('managed', {
    runId, phase: 'fetched', sourceRevision: catalog.revision,
    at: new Date().toISOString(), failures: structuredClone(failures),
  });
  await hooks.onPhase?.('fetched', { runId, failures });

  const available = plan
    .map(doc => documents[doc.id])
    .filter(document => document && document.format === 'xml');
  const cached = repository.interpretations();
  // 历史解释按 digest 保留：版本链或当前索引仍引用的旧 digest 不随重解析被清除，
  // 这样补交/修订后下游仍能核对旧版拓扑证据。
  const referencedDigests = new Set();
  for (const document of Object.values(documents)) {
    referencedDigests.add(document.digest);
    for (const version of document.revisions ?? []) referencedDigests.add(version.digest);
  }
  const interpretations = {};
  for (const [digest, parsed] of Object.entries(cached)) {
    if (referencedDigests.has(digest)) interpretations[digest] = parsed;
  }
  const parsedDocuments = [];
  for (const document of available) {
    let parsed = interpretations[document.digest];
    if (!parsed) {
      const bytes = await readRaw(repository, document.digest);
      parsed = parseOpenDrive(bytes.toString('utf8'), {
        path: document.path, documentId: document.id, revision: document.revision,
      });
    }
    interpretations[document.digest] = parsed;
    parsedDocuments.push(parsed);
  }

  const topology = interpretTopology(parsedDocuments);
  appendJunctionReferenceNotes({ parsedDocuments, unresolved: topology.unresolved });
  const isolated = topology.isolated;

  await repository.cursor('managed', {
    runId, phase: 'interpreted', sourceRevision: catalog.revision,
    at: new Date().toISOString(),
    confirmed: topology.confirmed.map(record => record.id),
    unresolved: topology.unresolved.map(entry => entry.reason),
  });
  await hooks.onPhase?.('interpreted', { runId, topology });

  const documentNotes = failures.map(failure => ({
    kind: 'document-unavailable',
    key: ['document-unavailable', failure.id, failure.status].join('|'),
    documentId: failure.id, path: failure.path, status: failure.status,
    reason: failure.reason, degraded: failure.degraded,
    detail: failure.degraded
      ? `document ${failure.id} is currently ${failure.reason}; the previously retained revision ${failure.digest} remains the interpretation evidence`
      : `document ${failure.id} is ${failure.reason}; links depending on it stay unresolved`,
    observedAt: new Date().toISOString(),
  }));

  await repository.commitManaged({
    documents,
    interpretations,
    confirmed: topology.confirmed,
    unresolved: topology.unresolved,
    isolated,
    documentNotes,
    runId,
    sourceRevision: catalog.revision,
  });
  await hooks.onPhase?.('committed', { runId });

  const after = repository.snapshot();
  const documentLevel = {
    total: plan.length,
    available: available.length,
    missingOrFailed: failures.filter(failure => !failure.degraded).length,
    degraded: failures.filter(failure => failure.degraded).length,
  };
  const relationLevel = {
    confirmed: topology.confirmed.length,
    unresolved: Object.keys(after.unresolvedKeys).length,
    isolated: Object.keys(after.isolatedKeys ?? {}).length,
  };
  return {
    mode: 'managed',
    runId,
    sourceRevision: catalog.revision,
    imported: documentLevel.available,
    newlyRetained,
    conditionalHits,
    documentLevel,
    relationLevel,
    // 完整性区分两层：任一文档缺件/失败（含凭旧证据降级）、任一连接未决或字段未解释，
    // 都不能宣称闭合；降级保留已确认内容，但 complete 仍必须为 false。
    complete: documentLevel.missingOrFailed === 0
      && documentLevel.degraded === 0
      && relationLevel.unresolved === 0
      && relationLevel.isolated === 0,
  };
}

// raw 证据按内容 digest 留存；即使进程在关系提交前终止，evidence 中的 documentId
// 也足以重建已取得文件索引，重跑不会重复抓取或丢失来源。
function reconcileDocuments(repository, state) {
  const rebuilt = { ...(state.documents ?? {}) };
  const evidenceDigestsByDoc = new Map();
  for (const [digest, metadata] of Object.entries(state.evidence ?? {})) {
    if (!metadata.documentId) continue;
    if (!evidenceDigestsByDoc.has(metadata.documentId)) evidenceDigestsByDoc.set(metadata.documentId, []);
    evidenceDigestsByDoc.get(metadata.documentId).push(digest);
  }
  for (const [documentId, digests] of evidenceDigestsByDoc) {
    const indexed = rebuilt[documentId];
    // 已有索引（含版本链）优先：evidence 中可能同时存在新旧多版 digest，
    // 绝不能用旧 digest 覆盖崩溃前已写入的当前索引。
    if (indexed && digests.includes(indexed.digest)) continue;
    if (indexed) continue;
    const digest = digests[digests.length - 1];
    const metadata = state.evidence[digest];
    rebuilt[documentId] = {
      id: documentId,
      path: metadata.origin,
      format: 'xml',
      revision: metadata.revision ?? null,
      etag: metadata.etag ?? null,
      digest,
      fetchedAt: metadata.retainedAt ?? null,
      reconciledFromEvidence: true,
    };
  }
  repository.state.documents = rebuilt;
}

async function readRaw(repository, digest) {
  return readFile(join(repository.directory, 'raw', digest));
}

// 道路声明归属某个 junction、但资料组里没有对应 junction 文件时，只让相关连接未决。
function appendJunctionReferenceNotes({ parsedDocuments, unresolved }) {
  const knownJunctions = new Set(parsedDocuments.flatMap(document =>
    document.junctions.map(junction => junction.id)));
  const seen = new Set();
  for (const document of parsedDocuments) {
    for (const road of document.roads) {
      if (!road.junction || road.junction === '-1' || knownJunctions.has(road.junction)) continue;
      const key = `${road.id}|${road.junction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unresolved.push({
        kind: 'unresolved-link',
        reason: 'junction-document-missing',
        junction: road.junction,
        connection: null,
        from: { road: road.id },
        to: null,
        detail: `road ${road.id} belongs to junction ${road.junction}, but no junction document was delivered`,
        sourcePaths: [document.sourcePath],
        locations: [`/OpenDRIVE/road[id=${road.id}]@junction`],
        observedAt: new Date().toISOString(),
      });
    }
  }
}
