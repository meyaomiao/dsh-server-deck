import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json'], { encoding: 'utf8' }))[0];
const published = JSON.parse(execFileSync(npm, [
  'view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json',
], { encoding: 'utf8' }));
assert.equal(published, packed.integrity, 'The npm release must match the freshly rebuilt tag contents');
console.log(`${pkg.name}@${pkg.version}: published integrity matches the rebuilt tag`);
