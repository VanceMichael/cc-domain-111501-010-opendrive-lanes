    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { readFile, mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createSource } from '../simulator/source.mjs';
    import { collect } from '../src/collector.mjs';
    import { Repository } from '../src/repository.mjs';
    const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

    async function session(run) {
      const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
      const source = await createSource({ scenario: 'feature' });
      try { await run(source, await new Repository(directory).open(), directory); }
      finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
    }

    test('source records retain the product relationships rather than a file preview', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const records = repository.records();
        assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
assert.equal(records[0].status, 'confirmed'); assert.ok(records[0].sourcePaths.includes('road-1.xodr')); assert.ok(records[0].sourcePaths.includes('road-2.xodr')); assert.ok(repository.snapshot().notes.some(note => note.kind === 'unresolved-link' && note.junction === 'j1'));
      });
    });

    test('repeated delivery after reopen preserves business identities and original evidence', async () => {
      await session(async (source, repository, directory) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const evidence = Object.keys(repository.snapshot().evidence);
        const reopened = await new Repository(directory).open();
        await collect({ base: source.base, repository: reopened, mode: 'managed' });
        assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
      });
    });
