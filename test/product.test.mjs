import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';
import { preview } from '../src/preview.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

test('single document preview persists original evidence and survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-preview-'));
  const source = await createSource();
  try {
    const repository = await new Repository(directory).open();
    const result = await collect({ base: source.base, repository });
    assert.equal(result.imported, 1);
    const original = repository.records()[0];
    assert.ok(original.digest && original.bytes > 0);
    await collect({ base: source.base, repository });
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.records().length, 1);
    assert.equal(reopened.records()[0].digest, original.digest);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('source exposes entity cache semantics and explicit missing states', async () => {
  const source = await createSource({ scenario: 'feature' });
  try {
    const catalog = await (await fetch(source.base + fixture.entry)).json();
    assert.equal(catalog.documents.length, fixture.documents.length);
    const first = catalog.documents[0];
    const response = await fetch(source.base + first.href);
    const cached = await fetch(source.base + first.href, { headers: { 'if-none-match': response.headers.get('etag') } });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    source.state.failDoc = first.id;
    assert.equal((await fetch(source.base + first.href)).status, 503);
  } finally { await source.close(); }
});

test('preview refuses an empty source and never expands external definitions', () => {
  assert.throws(() => preview('', 'text'), /empty/);
  assert.throws(() => preview('<!DOCTYPE x><x/>', 'xml'), /external/);
});
