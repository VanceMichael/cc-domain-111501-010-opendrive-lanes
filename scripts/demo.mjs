import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();
  const result = await collect({ base: source.base, repository, mode: 'managed' });
  console.log(JSON.stringify({ result, records: repository.records(), state: repository.snapshot(),
    requests: source.requests }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
