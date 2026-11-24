import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { satisfies } = require('semver') as { satisfies(version: string, range: string): boolean };
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const dependency of [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-client-connection',
]) {
  test(`compatibility: ${dependency} accepts the verified DSH prereleases`, () => {
    const range = pkg.peerDependencies[dependency] ?? '';
    assert.ok(satisfies('0.2.1-rc.5', range), '0.2.1-rc.5 implements requestRejection() and must install without an unmet peer');
    assert.ok(satisfies('0.2.3-alpha.2', range), '0.2.3-alpha.1 replaced it with admit() and must install without an unmet peer');
    assert.ok(satisfies(pkg.devDependencies[dependency], range), 'typecheck must use a declared compatible Host');
    assert.equal(satisfies('0.2.0-rc.2', range), false, 'older unverified request-admission APIs must not be advertised');
  });
}

test('compatibility: client manifest declares the Connection service used by the terminal', () => {
  assert.ok(pkg.dsh.client.inject.includes('slots'));
  assert.ok(pkg.dsh.client.inject.includes('connection'));
});
