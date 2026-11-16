import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { createDocumentSource, roadDocument, junctionDocument } from './source-helper.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

async function session(source, run) {
  const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
  try { await run(await new Repository(directory).open(), directory); }
  finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
}

// 矩阵 1/2（原有断言，不删改）：跨文件复合身份、confirmed 与来源；重复投递与重开不膨胀。
test('source records retain the product relationships rather than a file preview', async () => {
  const source = await createSource({ scenario: 'feature' });
  await session(source, async repository => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const records = repository.records();
    assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.equal(records[0].status, 'confirmed');
    assert.ok(records[0].sourcePaths.includes('road-1.xodr'));
    assert.ok(records[0].sourcePaths.includes('road-2.xodr'));
    assert.ok(repository.snapshot().notes.some(note => note.kind === 'unresolved-link' && note.junction === 'j1'));
  });
});

test('repeated delivery after reopen preserves business identities and original evidence', async () => {
  const source = await createSource({ scenario: 'feature' });
  await session(source, async (repository, directory) => {
    const first = await collect({ base: source.base, repository, mode: 'managed' });
    const evidence = Object.keys(repository.snapshot().evidence);
    const reopened = await new Repository(directory).open();
    const second = await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
    // 第二次全部走条件请求，原始字节不重复留存，关系不膨胀。
    assert.equal(second.newlyRetained, 0);
    assert.equal(second.conditionalHits, 3);
    assert.equal(reopened.relationships().length, 1);
    assert.ok(first.complete === false && second.complete === false);
  });
});

// 矩阵 3：缺路口文件只让相关连接未决，路网不伪装闭合；补件后恢复且只重解释受影响对象。
test('a missing junction document keeps only its links unresolved and recovers on delivery', async () => {
  const roadOne = roadDocument({
    id: 'r1', path: 'road-1.xodr', junction: 'j9',
    link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  });
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async (repository, directory) => {
    const before = await collect({ base: source.base, repository, mode: 'managed' });
    const missingNote = repository.unresolved().find(entry => entry.reason === 'junction-document-missing');
    assert.ok(missingNote);
    assert.equal(missingNote.junction, 'j9');
    assert.ok(missingNote.locations[0].includes('road[id=r1]'));    // 直连不受影响，仍然 confirmed；但存在未决，complete 必须为 false。
    assert.equal(repository.relationships().length, 1);
    assert.equal(before.complete, false);

    const junction = junctionDocument({ id: 'j9', incomingRoad: 'r1', connectingRoad: 'r2' });
    const recovered = await createDocumentSource([roadOne, roadTwo, junction]);
    try {
      const reopened = await new Repository(directory).open();
      const after = await collect({ base: recovered.base, repository: reopened, mode: 'managed' });
      assert.equal(after.newlyRetained, 1); // 只新留存补交往返的一份
      assert.ok(!reopened.unresolved().some(entry => entry.reason === 'junction-document-missing'));
      const history = reopened.history();
      assert.ok(history.some(event => event.event === 'resolved' && event.id.includes('junction-document-missing')));
      assert.ok(history.some(event => event.event === 'confirmed' && event.id.startsWith('junction:j9:')));
      // 两份道路资料未变化，走条件请求；补件后无未决、无隔离，完整性两层都闭合。
      assert.equal(after.conditionalHits, 2);
      assert.equal(after.complete, true);
    } finally { await recovered.close(); }
  });
});

// 矩阵 3：临时 503 与 404 缺件只隔离对应文档，已确认内容保留，恢复后闭合。
test('document failures are isolated per document and never erase confirmed topology', async () => {
  const roadOne = roadDocument({
    id: 'r1', path: 'road-1.xodr',
    link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  });
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async (repository, directory) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(repository.relationships().length, 1);
    source.state.failDoc = 'r2';
    const failed = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(failed.documentLevel.degraded, 1);
    assert.equal(failed.complete, false);
    // 旧证据仍在，confirmed 关系不凭空消失；诊断指向具体文档。
    assert.equal(repository.relationships().length, 1);
    const note = repository.snapshot().notes.find(item => item.kind === 'document-unavailable' && item.documentId === 'r2');
    assert.ok(note && note.status === 503);
    assert.ok(note.detail.includes('previously retained'));
    source.state.failDoc = null;
    const reopened = await new Repository(directory).open();
    const recovered = await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.equal(recovered.complete, true);
    assert.equal(recovered.documentLevel.degraded, 0);
    assert.equal(recovered.documentLevel.missingOrFailed, 0);
    // 恢复后活动故障索引关闭，诊断在 notes 与 history 中都有 resolved 留痕，可再次打开。
    assert.deepEqual(reopened.snapshot().documentNotes, {});
    assert.ok(reopened.snapshot().notes.some(note => note.kind === 'document-unavailable' && note.resolvedAt));
    assert.ok(reopened.history().some(event => event.event === 'resolved' && event.id.includes('document-unavailable')));
  });
});

// 矩阵 4：round=2 修订使旧连接失去 confirmed，保留单侧矛盾与旧版拓扑证据。
test('a revision withdraws the old confirmed link while preserving topology evidence', async () => {
  const source = await createSource({ scenario: 'feature' });
  await session(source, async (repository, directory) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const firstHistoryLength = repository.history().length;
    source.state.round = 2;
    await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(repository.records().filter(record => record.status === 'confirmed').length, 0);
    const contradiction = repository.unresolved().find(entry => entry.reason === 'one-sided-lane-link');
    assert.ok(contradiction, 'the revised predecessor must surface as a one-sided contradiction');
    assert.ok(contradiction.sourcePaths.includes('road-2.xodr'));
    const history = repository.history();
    const withdrawn = history.find(event => event.event === 'withdrawn' && event.id === fixture.expectedIds[0]);
    assert.ok(withdrawn && withdrawn.previous && withdrawn.previous.status === 'confirmed');
    assert.ok(history.length > firstHistoryLength);
    // 旧版原始字节与解释仍然可核对，未被覆盖：修订为 road-2 新增一个 digest。
    const evidence = repository.snapshot().evidence;
    assert.equal(Object.keys(evidence).length, 4);
    const retainedRoadTwo = Object.values(evidence).filter(item => item.documentId === 'road-2');
    assert.equal(retainedRoadTwo.length, 2);
    const interpretations = repository.interpretations();
    assert.ok(Object.values(interpretations).some(parsed => parsed.documentId === 'road-2' && parsed.revision === 2));
    assert.ok(Object.values(interpretations).some(parsed => parsed.documentId === 'road-2' && parsed.revision === 1));
    assert.equal(repository.snapshot().complete ?? false, false);
  });
});

// 数据边界：边界宽度归零时不照搬对侧声明，连接保持未决。
test('a zero-width boundary never copies the counterpart connection declaration', async () => {
  const roadOne = roadDocument({
    id: 'r1', path: 'road-1.xodr', width: '0',
    link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  });
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async repository => {
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    assert.deepEqual(repository.relationships(), []);
    const entry = repository.unresolved().find(item => item.reason === 'boundary-width-zero');
    assert.ok(entry);
    assert.equal(entry.from.road, 'r1');
    assert.ok(entry.sourcePaths.includes('road-1.xodr'));
    assert.equal(result.complete, false);
  });
});

// 数据边界：未建模字段被隔离诊断，不能被称作已解释。
test('unmodeled fields are isolated and block the complete interpretation claim', async () => {
  const roadOne = roadDocument({
    id: 'r1', path: 'road-1.xodr',
    link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  });
  roadOne.body = roadOne.body.replace('</road>', '<elevation s="0" a="1"/></road>');
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async repository => {
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(repository.relationships().length, 1);
    assert.ok(repository.snapshot().notes.some(note => note.kind === 'isolated-field' && note.element === 'elevation'));
    assert.equal(result.complete, false);
    // 重复投递不重复刷同一条隔离诊断。
    await collect({ base: source.base, repository, mode: 'managed' });
    const count = repository.snapshot().notes.filter(note => note.kind === 'isolated-field').length;
    const again = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(repository.snapshot().notes.filter(note => note.kind === 'isolated-field').length, count);
    assert.equal(again.complete, false);
  });
});

// 矩阵 5：在原件已留存、关系尚未提交的边界终止，重开能识别待完成工作并补齐。
test('a process stopped after raw retention resumes from evidence without re-fetching', async () => {
  const roadOne = roadDocument({
    id: 'r1', path: 'road-1.xodr',
    link: '<successor elementType="road" elementId="r2" contactPoint="start"/>',
    laneLink: '<successor id="-1"/>',
  });
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async (repository, directory) => {
    await assert.rejects(collect({
      base: source.base, repository, mode: 'managed',
      hooks: { onPhase: phase => { if (phase === 'interpreted') throw new Error('simulated process termination'); } },
    }), /simulated process termination/);
    // 原件与文档索引已落盘，关系尚未提交。
    const interrupted = repository.snapshot();
    assert.equal(Object.keys(interrupted.evidence).length, 2);
    assert.equal(Object.keys(interrupted.relationships).length, 0);
    assert.equal(interrupted.cursors.managed.phase, 'interpreted');

    const reopened = await new Repository(directory).open();
    const resumed = await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.equal(resumed.newlyRetained, 0);
    assert.equal(resumed.conditionalHits, 2);
    assert.equal(reopened.relationships().length, 1);
    assert.equal(reopened.records()[0].id, 'r1:0:-1->r2:0:-1');
    assert.equal(reopened.snapshot().cursors.managed.phase, 'committed');
  });
});

// 数据边界：边界宽度无法求值时同样不得确认，且不得借用对侧宽度。
test('a boundary without an evaluable width polynomial stays unresolved', async () => {
  const roadOne = {
    id: 'r1', path: 'road-1.xodr',
    body: `<OpenDRIVE><road id="r1" length="10" junction="-1">
    <link><successor elementType="road" elementId="r2" contactPoint="start"/></link>
    <lanes><laneSection s="0"><right><lane id="-1" type="driving">
    <link><successor id="-1"/></link></lane></right></laneSection></lanes></road></OpenDRIVE>`,
  };
  const roadTwo = roadDocument({
    id: 'r2', path: 'road-2.xodr',
    link: '<predecessor elementType="road" elementId="r1" contactPoint="end"/>',
    laneLink: '<predecessor id="-1"/>',
  });
  const source = await createDocumentSource([roadOne, roadTwo]);
  await session(source, async repository => {
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    assert.deepEqual(repository.relationships(), []);
    const entry = repository.unresolved().find(item => item.reason === 'boundary-width-unknown');
    assert.ok(entry);
    assert.equal(entry.from.road, 'r1');
    assert.equal(result.complete, false);
  });
});

// 路口 laneLink 的缺失车道不得被同号车道默认值掩盖。
test('a junction laneLink to an absent lane stays unresolved instead of matching by number', async () => {
  const roadOne = roadDocument({ id: 'r1', path: 'road-1.xodr', laneLink: '' });
  const roadThree = roadDocument({ id: 'r3', path: 'road-3.xodr', laneLink: '', width: '3.5' });
  const junction = junctionDocument({ incomingRoad: 'r1', connectingRoad: 'r3', from: '-1', to: '-9' });
  const source = await createDocumentSource([roadOne, roadThree, junction]);
  await session(source, async repository => {
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    assert.deepEqual(repository.relationships(), []);
    const entry = repository.unresolved().find(item => item.reason === 'junction-lane-missing');
    assert.ok(entry);
    assert.equal(entry.junction, 'j1');
    assert.equal(result.complete, false);
  });
});
