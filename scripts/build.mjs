import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      checked += 1;
    }
  }
}
for (const directory of ['src', 'simulator', 'scripts', 'test', 'acceptance']) await check(directory);
console.log(JSON.stringify({ checked, runtime: process.version }));
