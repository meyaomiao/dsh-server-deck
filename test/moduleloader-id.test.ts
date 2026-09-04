import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractModuleLoaderId(clientJs: string): string {
  const match = clientJs.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  assert.ok(match, 'lib/client.js must contain __ModuleLoader__.load({ id: "..." })');
  return match[1];
}

function extractInsertName(yaml: string): string {
  const withoutComments = yaml
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const insert = withoutComments.match(/insert:\s*\n([\s\S]*)/);
  assert.ok(insert, 'cordis.patch.yml must contain insert:');
  const name = insert[1].match(/^\s*name:\s*(.+)$/m);
  assert.ok(name, 'cordis.patch.yml insert.name not found');
  return name[1].trim().replace(/^['"]|['"]$/g, '');
}

test('ModuleLoader id, package.json name, and cordis.patch.yml insert.name are equal', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string };
  assert.equal(typeof pkg.name, 'string');
  assert.ok(pkg.name.length > 0);

  const clientJs = await readFile(join(root, 'lib/client.js'), 'utf8');
  const moduleId = extractModuleLoaderId(clientJs);

  const yaml = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  const insertName = extractInsertName(yaml);

  assert.equal(moduleId, pkg.name);
  assert.equal(insertName, pkg.name);
});
