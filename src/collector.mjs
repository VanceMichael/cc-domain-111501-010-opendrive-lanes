import { readFile } from 'node:fs/promises';
import { json, request } from './http.mjs';
import { preview } from './preview.mjs';
import { runManaged } from './managed.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

export async function collect({ base, repository, mode, hooks } = {}) {
  if (mode === 'managed') {
    return runManaged({ base, repository, hooks });
  }
  const catalog = await json(base, fixture.entry);
  const first = catalog.documents[0];
  const response = await request(base, first.href);
  if (!response.ok) throw new Error(`document status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = await repository.retain(first.path, bytes, { etag: response.headers.get('etag'), revision: first.revision });
  const result = preview(bytes.toString('utf8'), first.format);
  await repository.put({ id: first.id, path: first.path, ...result, digest });
  await repository.cursor('preview', { document: first.id, revision: first.revision });
  return { imported: 1, complete: false, mode: 'legacy' };
}
