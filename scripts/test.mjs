import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = process.argv[2] === 'browser' ? '.browser.mjs' : '.test.ts';
const tests = (await readdir(new URL('../test/', import.meta.url)))
  .filter((name) => name.endsWith(suffix)).sort().map((name) => `test/${name}`);
if (tests.length === 0) throw new Error(`No ${suffix} tests found`);
// Node 20 does not expand quoted test globs; enumerate without relying on shell behavior.
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  cwd: root,
  env: { ...process.env, TZ: 'Asia/Shanghai' },
  stdio: 'inherit',
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
