import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = {
      records: {}, cursors: {}, evidence: {}, notes: [],
      // managed 模式的持久化结构，旧存储打开时自动补齐：
      documents: {},       // 已取得文件索引：文档 id -> 当前版本与 digest
      interpretations: {}, // 规范化解释：digest -> 解析结果与来源
      relationships: {},   // 当前已确认关系 id -> 解释记录
      history: [],         // 拓扑证据的追加式版本流水（从不删除或改写）
      unresolvedKeys: {},  // 当前未决关系键 -> note，用于重复投递去重
      isolatedKeys: {},    // 已隔离的未建模字段键，重复解释不重复诊断
      documentNotes: {},   // 当前文档级缺件/失败键 -> note
      managedRecordIds: [], // 由 managed 模式写入 records 的关系 id，撤回时按集合清理
    };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      this.state = { ...this.state, ...saved };
      for (const key of ['documents', 'interpretations', 'relationships', 'unresolvedKeys', 'isolatedKeys', 'documentNotes']) {
        this.state[key] = { ...(this.state[key] ?? {}) };
      }
      this.state.managedRecordIds = [...(this.state.managedRecordIds ?? [])];
      this.state.history = [...(this.state.history ?? [])];
      this.state.notes = [...(this.state.notes ?? [])];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    // 同一 digest 重复投递只刷新来源元数据，原始字节不复制、不膨胀。
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length,
      retainedAt: this.state.evidence[digest]?.retainedAt ?? new Date().toISOString() };
    await this.save();
    return digest;
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push(structuredClone(value));
    await this.save();
  }

  // 一次性提交一次 managed 解释：当前视图、未决索引、版本流水在同一次 save 内落盘，
  // 保证“原始资料已保存、关系尚未提交”的中断只会停在可识别的待完成状态。
  async commitManaged({ documents, interpretations, confirmed, unresolved, isolated, documentNotes, runId, sourceRevision }) {
    // 先深克隆旧视图：后续会整体替换 state.relationships，
    // 否则 withdrawn/revised 事件里的 previous 会随新视图一起被清空。
    const previousConfirmed = new Map(Object.entries(structuredClone(this.state.relationships)));
    const nextConfirmed = new Map(confirmed.map(record => [record.id, record]));
    const history = this.state.history;
    const now = new Date().toISOString();

    for (const [id, record] of nextConfirmed) {
      const previous = previousConfirmed.get(id);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
        history.push({ seq: history.length + 1, runId, at: now, event: previous ? 'revised' : 'confirmed',
          id, sourceRevision, record: structuredClone(record),
          previous: previous ? structuredClone(previous) : null });
      }
    }
    for (const [id, previous] of previousConfirmed) {
      if (!nextConfirmed.has(id)) {
        history.push({ seq: history.length + 1, runId, at: now, event: 'withdrawn',
          id, sourceRevision, record: null, previous: structuredClone(previous) });
      }
    }

    const nextKeys = new Set();
    for (const entry of unresolved) {
      const key = unresolvedKey(entry);
      nextKeys.add(key);
      if (!this.state.unresolvedKeys[key]) {
        const note = structuredClone({ ...entry, key, runId, sourceRevision });
        this.state.notes.push(note);
        history.push({ seq: history.length + 1, runId, at: now, event: 'unresolved',
          id: key, sourceRevision, record: structuredClone(entry), previous: null });
      }
      this.state.unresolvedKeys[key] = { ...structuredClone(entry), key, runId, sourceRevision };
    }
    for (const [key, previous] of Object.entries(this.state.unresolvedKeys)) {
      if (!nextKeys.has(key)) {
        history.push({ seq: history.length + 1, runId, at: now, event: 'resolved',
          id: key, sourceRevision, record: null, previous: structuredClone(previous) });
        delete this.state.unresolvedKeys[key];
      }
    }
    for (const entry of isolated) {
      const key = isolatedKey(entry);
      if (this.state.isolatedKeys[key]) continue;
      const note = { kind: 'isolated-field', key, runId, sourceRevision, ...structuredClone(entry) };
      this.state.notes.push(note);
      this.state.isolatedKeys[key] = note;
    }

    const nextDocumentKeys = new Set();
    for (const note of documentNotes ?? []) {
      nextDocumentKeys.add(note.key);
      if (!this.state.documentNotes[note.key]) {
        const opened = structuredClone(note);
        this.state.notes.push(opened);
        history.push({ seq: history.length + 1, runId, at: now, event: 'unresolved',
          id: note.key, sourceRevision, record: opened, previous: null });
      }
      this.state.documentNotes[note.key] = structuredClone(note);
    }
    for (const [key, previous] of Object.entries(this.state.documentNotes)) {
      if (nextDocumentKeys.has(key)) continue;
      const resolved = { ...structuredClone(previous), resolvedAt: now };
      this.state.notes.push(resolved);
      history.push({ seq: history.length + 1, runId, at: now, event: 'resolved',
        id: key, sourceRevision, record: resolved, previous: structuredClone(previous) });
      delete this.state.documentNotes[key];
    }

    this.state.documents = structuredClone(documents);
    this.state.interpretations = structuredClone(interpretations);
    this.state.relationships = Object.fromEntries(nextConfirmed);
    // 已确认关系同时发布到现有 records 接口；只清理本模式此前发布的 id，
    // legacy 预览记录（如 road-1）继续可读。旧版本已由 history 留痕，不在此删除证据。
    for (const id of this.state.managedRecordIds) delete this.state.records[id];
    for (const [id, record] of nextConfirmed) this.state.records[id] = structuredClone(record);
    this.state.managedRecordIds = [...nextConfirmed.keys()];
    this.state.cursors.managed = { runId, phase: 'committed', sourceRevision, at: now };
    await this.save();
  }

  documents() {
    return structuredClone(this.state.documents);
  }

  interpretations() {
    return structuredClone(this.state.interpretations);
  }

  relationships() {
    return Object.values(structuredClone(this.state.relationships));
  }

  history() {
    return structuredClone(this.state.history);
  }

  unresolved() {
    return Object.values(structuredClone(this.state.unresolvedKeys));
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}

function unresolvedKey(entry) {
  return [
    entry.reason,
    entry.junction ?? '',
    entry.connection ?? '',
    entry.from?.road ?? '',
    entry.from?.sectionS ?? '',
    entry.from?.lane ?? '',
    entry.to?.road ?? '',
    entry.to?.lane ?? '',
    (entry.locations ?? []).join('|'),
  ].join('|');
}

function isolatedKey(entry) {
  return [entry.path ?? '', entry.location ?? '', entry.element ?? ''].join('|');
}
