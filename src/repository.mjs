import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [] };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
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
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
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

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
