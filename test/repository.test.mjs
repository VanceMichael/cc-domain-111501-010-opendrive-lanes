import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.mjs';

test('records, evidence and cursors survive a reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-test-'));
  try {
    const repository = await new Repository(directory).open();
    await repository.put({ id: 'sample', value: 7 });
    const digest = await repository.retain('/source', 'local sample');
    await repository.cursor('legacy', 'position-1');
    const reopened = await new Repository(directory).open();
    assert.equal(reopened.records()[0].value, 7);
    assert.equal(reopened.snapshot().cursors.legacy, 'position-1');
    assert.equal(reopened.snapshot().evidence[digest].size, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('record ids are required', async () => {
  const repository = new Repository('/unused');
  await assert.rejects(repository.put({ value: 1 }), /id required/);
});
