import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HostEntry, HostInput, ImportPreview } from '../src/types.ts';
import { createSshImporter, type ImportStore } from '../src/server/importer.ts';
import { assertJumpTarget, normalizeInput } from '../src/server/store.ts';

function host(id: string, extra: Partial<HostEntry> = {}): HostEntry {
  return { id, name: id, host: `${id}.example`, username: 'fixture', port: 22, auth: 'agent', createdAt: '2026-01-01', ...extra };
}
class MemoryStore implements ImportStore {
  hosts: HostEntry[];
  writes: string[] = [];
  failName?: string;
  constructor(hosts: HostEntry[] = []) { this.hosts = structuredClone(hosts); }
  list(): readonly HostEntry[] { return this.hosts; }
  async create(input: HostInput): Promise<HostEntry> {
    if (input.name === this.failName) throw new Error('fixture disk failure');
    const { fields, secret } = normalizeInput(input);
    assert.deepEqual(secret, {}, 'import never writes secrets');
    const next = { id: `memory-${this.hosts.length}`, createdAt: '2026-01-01', ...fields } as HostEntry;
    assertJumpTarget(next.id, next.jumpHostId, this.hosts);
    this.hosts.push(next);
    this.writes.push(`create:${next.name}`);
    return next;
  }
  async update(id: string, input: HostInput): Promise<HostEntry> {
    assert.deepEqual(Object.keys(input), ['jumpHostId'], 'repair only changes the jump association');
    const { fields } = normalizeInput(input);
    const index = this.hosts.findIndex((entry) => entry.id === id);
    const next = { ...this.hosts[index], ...fields };
    assertJumpTarget(next.id, next.jumpHostId, this.hosts);
    this.hosts[index] = next;
    this.writes.push(`update:${id}`);
    return next;
  }
}
const block = (name: string, options = ''): string => `Host ${name}\n HostName ${name.split(' ')[0]}.example\n User fixture\n${options}\n`;
const row = (preview: ImportPreview, name: string) => {
  const value = preview.candidates.find((entry) => entry.name === name);
  assert.ok(value, `candidate ${name} exists`);
  return value;
};
const confirmation = (preview: ImportPreview, ...names: string[]) => ({ fingerprint: preview.fingerprint, selectedIds: names.map((name) => row(preview, name).id) });

test('preview is zero-write and explains existing, Git, missing user, wildcard and invalid ports', async () => {
  const store = new MemoryStore([host('old')]);
  const config = block('old') + block('new') + 'Host github\n HostName github.com\n User git\n'
    + 'Host no-user\n HostName private.example\n' + 'Host *.internal\n User fixture\n'
    + block('bad-port', ' Port broken');
  const importer = createSshImporter(store, async () => config);
  const before = structuredClone(store.hosts);
  const preview = await importer.preview();
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.hosts, before);
  assert.equal(row(preview, 'old').action, 'skip');
  assert.match(row(preview, 'old').reason, /已在台账/);
  assert.equal(row(preview, 'new').action, 'create');
  assert.match(row(preview, 'github').reason, /Git/);
  assert.match(row(preview, 'no-user').reason, /缺少用户名/);
  assert.match(row(preview, '*.internal').reason, /通配/);
  assert.match(row(preview, 'bad-port').reason, /端口/);
});

test('preview does not touch the real store files or read a private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'server-deck-import-'));
  const data = join(dir, '.dsh');
  await mkdir(data);
  const ledger = JSON.stringify({ version: 1, hosts: [] });
  const secrets = JSON.stringify({ fixture: { password: 'fixture-only-secret' } });
  await writeFile(join(data, 'server-deck.json'), ledger);
  await writeFile(join(data, 'server-deck.secrets.json'), secrets);
  const code = `import {HostStore} from ${JSON.stringify(new URL('../src/server/store.ts', import.meta.url).href)};
    import {createSshImporter} from ${JSON.stringify(new URL('../src/server/importer.ts', import.meta.url).href)};
    const store = new HostStore(); await store.load();
    const preview = await createSshImporter(store, async () => ${JSON.stringify(block('fresh', ' IdentityFile /does-not-exist/PRIVATE_KEY'))}).preview();
    if(preview.candidates[0].action !== 'create') throw Error('expected preview');
    if(JSON.stringify(preview).includes('PRIVATE_KEY')) throw Error('key path should not be exposed in preview');`;
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], {
    env: { ...process.env, HOME: dir }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(join(data, 'server-deck.json'), 'utf8'), ledger);
  assert.equal(await readFile(join(data, 'server-deck.secrets.json'), 'utf8'), secrets);
});

test('confirm only imports selected independent hosts; a fresh preview is idempotent', async () => {
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => block('one') + block('two'));
  const preview = await importer.preview();
  const result = await importer.confirm(confirmation(preview, 'two'));
  assert.deepEqual(result, { createdCount: 1, updatedCount: 0, skippedCount: 1, includedDependencies: 0 });
  assert.deepEqual(store.hosts.map((entry) => entry.name), ['two']);
  const next = await importer.preview();
  assert.equal(row(next, 'two').action, 'skip');
  await assert.rejects(() => importer.confirm(confirmation(next, 'two')), /不可选择/);
  assert.equal(store.writes.length, 1);
});

for (const reversed of [false, true]) {
  test(`dependencies are created before their target regardless of source order (${reversed})`, async () => {
    const store = new MemoryStore();
    const target = block('target', ' ProxyJump gateway-alias');
    const jump = block('jump gateway-alias');
    const importer = createSshImporter(store, async () => reversed ? jump + target : target + jump);
    const preview = await importer.preview();
    assert.deepEqual(row(preview, 'target').dependencies, [row(preview, 'jump').id]);
    const result = await importer.confirm(confirmation(preview, 'target'));
    assert.equal(result.createdCount, 2);
    assert.equal(result.includedDependencies, 1);
    assert.deepEqual(store.writes, ['create:jump', 'create:target']);
    assert.equal(store.hosts[1].jumpHostId, store.hosts[0].id);
    assert.match(store.hosts[1].notes!, /ProxyJump: gateway-alias/);
  });
}

test('existing targets repair a missing association without duplicating or changing auth/notes', async () => {
  const store = new MemoryStore([host('target', { auth: 'password', notes: 'user note' }), host('jump')]);
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump jump') + block('jump'));
  const preview = await importer.preview();
  assert.equal(row(preview, 'target').action, 'update');
  assert.equal(row(preview, 'target').proxyJump, 'jump');
  const result = await importer.confirm(confirmation(preview, 'target'));
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(store.hosts.length, 2);
  assert.equal(store.hosts[0].jumpHostId, 'jump');
  assert.equal(store.hosts[0].auth, 'password');
  assert.equal(store.hosts[0].notes, 'user note');
  assert.equal(row(await importer.preview(), 'target').action, 'skip');
});

test('only confirmed existing-host repairs invalidate cached connections immediately after update', async () => {
  const store = new MemoryStore([host('target'), host('jump')]);
  const invalidated: string[] = [];
  const config = block('target', ' ProxyJump jump') + block('jump') + block('fresh');
  const importer = createSshImporter(store, async () => config, (id) => {
    assert.equal(store.hosts.find((entry) => entry.id === id)!.jumpHostId, 'jump', 'association updated before invalidation');
    assert.deepEqual(store.writes, ['update:target'], 'invalidation runs before the next selected write');
    invalidated.push(id);
  });
  const preview = await importer.preview();
  assert.deepEqual(invalidated, [], 'preview and skip do not invalidate');
  await importer.confirm(confirmation(preview, 'target', 'fresh'));
  assert.deepEqual(invalidated, ['target']);
  await importer.preview();
  assert.deepEqual(invalidated, ['target'], 'subsequent skipped preview does not invalidate');
  const created: string[] = [];
  const newStore = new MemoryStore();
  const newImporter = createSshImporter(newStore, async () => block('fresh'), (id) => { created.push(id); });
  const newPreview = await newImporter.preview();
  await newImporter.confirm(confirmation(newPreview, 'fresh'));
  assert.deepEqual(created, [], 'new hosts never invalidate existing connections');
});

test('same endpoint aliases coalesce deterministically and references use any alias', async () => {
  const store = new MemoryStore();
  const config = block('jump alias-one') + 'Host alias-two\n HostName jump.example\n User fixture\n' + block('target', ' ProxyJump alias-two');
  const importer = createSshImporter(store, async () => config);
  const preview = await importer.preview();
  assert.equal(preview.candidates.length, 2);
  assert.deepEqual(row(preview, 'jump').aliases, ['jump', 'alias-one', 'alias-two']);
  await importer.confirm(confirmation(preview, 'target'));
  assert.deepEqual(store.writes, ['create:jump', 'create:target']);
});

test('qualified fixture@jump:22 resolves the alias instead of silently falling back to direct', async () => {
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump fixture@jump:22') + block('jump'));
  const preview = await importer.preview();
  assert.equal(row(preview, 'target').action, 'create');
  await importer.confirm(confirmation(preview, 'target'));
  assert.equal(store.hosts[1].jumpHostId, store.hosts[0].id);
});

test('qualified override imports only its derived endpoint and target, preserving key references', async () => {
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump alternate@jump:2222') + block('jump', ' IdentityFile ~/.ssh/fixture-key'));
  const preview = await importer.preview();
  const result = await importer.confirm(confirmation(preview, 'target'));
  assert.equal(result.createdCount, 2);
  assert.equal(store.hosts[0].username, 'alternate');
  assert.equal(store.hosts[0].port, 2222);
  assert.equal(store.hosts[0].host, 'jump.example');
  assert.match(store.hosts[0].keyPath!, /fixture-key$/);
  assert.equal(store.hosts[1].jumpHostId, store.hosts[0].id);
  assert.equal(row(preview, 'jump').action, 'create');
});

test('comma ProxyJump lists become target -> second -> first and keep the original declaration', async () => {
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump j1,j2') + block('j2') + block('j1'));
  const preview = await importer.preview();
  const result = await importer.confirm(confirmation(preview, 'target'));
  assert.equal(result.createdCount, 3);
  assert.deepEqual(store.hosts.map((entry) => entry.name), ['j1', 'j2', 'target']);
  assert.equal(store.hosts[1].jumpHostId, store.hosts[0].id);
  assert.equal(store.hosts[2].jumpHostId, store.hosts[1].id);
  assert.match(store.hosts[2].notes!, /j1,j2/);
});

test('spaced multi-hop lists preserve source text and match nested alias chains', async () => {
  const store = new MemoryStore();
  const declaration = 'j1, fixture@j2:22, j3';
  const config = block('target', ` ProxyJump ${declaration}`) + block('j3', ' ProxyJump j2') + block('j2', ' ProxyJump j1') + block('j1');
  const importer = createSshImporter(store, async () => config);
  const preview = await importer.preview();
  assert.equal(row(preview, 'target').proxyJump, declaration);
  await importer.confirm(confirmation(preview, 'target'));
  assert.deepEqual(store.hosts.map((entry) => entry.name), ['j1', 'j2', 'j3', 'target']);
  for (let i = 1; i < store.hosts.length; i += 1) assert.equal(store.hosts[i].jumpHostId, store.hosts[i - 1].id);
  assert.match(store.hosts.at(-1)!.notes!, /j1, fixture@j2:22, j3/);
});

test('qualified overrides cannot hide unsupported ProxyCommand or invalid jump sources', async () => {
  const config = block('target', ' ProxyJump alternate@jump:2222') + block('jump', ' ProxyCommand fixture-command');
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => config);
  const preview = await importer.preview();
  assert.equal(row(preview, 'target').action, 'invalid');
  assert.match(row(preview, 'target').reason, /ProxyCommand/);
  await assert.rejects(() => importer.confirm(confirmation(preview, 'target')), /不可选择/);
  assert.deepEqual(store.writes, []);
});

test('comma chains preserve different manual jumps on intermediate existing hosts', async () => {
  const store = new MemoryStore([host('j2', { jumpHostId: 'manual' }), host('manual')]);
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump j1,j2') + block('j1') + block('j2'));
  const preview = await importer.preview();
  assert.match(row(preview, 'target').reason, /冲突/);
  assert.equal(row(preview, 'j2').action, 'skip');
  await assert.rejects(() => importer.confirm(confirmation(preview, 'target')), /不可选择/);
  assert.deepEqual(store.writes, []);
  assert.equal(store.hosts[0].jumpHostId, 'manual');
});

test('none creates a direct host; an existing manual association is never cleared', async () => {
  const store = new MemoryStore([host('old', { jumpHostId: 'manual' }), host('manual')]);
  const importer = createSshImporter(store, async () => block('direct', ' ProxyJump none') + block('old', ' ProxyJump none'));
  const preview = await importer.preview();
  assert.equal(row(preview, 'old').action, 'invalid');
  await importer.confirm(confirmation(preview, 'direct'));
  assert.equal(store.hosts.at(-1)!.jumpHostId, undefined);
  assert.equal(store.hosts[0].jumpHostId, 'manual');
});

for (const [name, config, reason] of [
  ['missing', block('broken', ' ProxyJump absent'), /不存在/],
  ['self', block('broken', ' ProxyJump broken'), /自指/],
  ['cycle', block('broken', ' ProxyJump other') + block('other', ' ProxyJump broken'), /循环/],
  ['repeated list', block('broken', ' ProxyJump jump,jump') + block('jump'), /自指|重复/],
  ['invalid port', block('broken', ' ProxyJump fixture@jump:99999') + block('jump'), /端口/],
  ['none list', block('broken', ' ProxyJump jump,none') + block('jump'), /none/],
  ['chain conflict', block('broken', ' ProxyJump j1,j2') + block('j1') + block('j2', ' ProxyJump other') + block('other'), /冲突/],
  ['explicit none conflict', block('broken', ' ProxyJump j1,j2') + block('j1') + block('j2', ' ProxyJump none'), /冲突/],
  ['alias ambiguity', block('broken', ' ProxyJump duplicate') + block('j1 duplicate') + block('j2 duplicate'), /不唯一/],
] as const) {
  test(`${name} is visible and disabled while an independent valid host can import`, async () => {
    const store = new MemoryStore();
    const importer = createSshImporter(store, async () => config + block('independent'));
    const preview = await importer.preview();
    assert.equal(row(preview, 'broken').action, 'invalid');
    assert.match(row(preview, 'broken').reason, reason);
    await assert.rejects(() => importer.confirm(confirmation(preview, 'broken')), /不可选择/);
    assert.deepEqual(store.writes, []);
    await importer.confirm(confirmation(preview, 'independent'));
    assert.deepEqual(store.writes, ['create:independent']);
  });
}

test('multiple comma lists demanding different parents disable both owners, not independent entries', async () => {
  const store = new MemoryStore();
  const config = block('one', ' ProxyJump a,shared') + block('two', ' ProxyJump b,shared') + block('a') + block('b') + block('shared');
  const importer = createSshImporter(store, async () => config);
  const preview = await importer.preview();
  assert.equal(row(preview, 'one').action, 'invalid');
  assert.equal(row(preview, 'two').action, 'invalid');
  assert.equal(row(preview, 'shared').action, 'create');
  await importer.confirm(confirmation(preview, 'shared'));
  assert.equal(store.hosts[0].jumpHostId, undefined);
});

test('different manual jump is preserved and the invalid plan performs zero mutations', async () => {
  const store = new MemoryStore([host('target', { jumpHostId: 'manual' }), host('manual')]);
  const importer = createSshImporter(store, async () => block('target', ' ProxyJump jump') + block('jump'));
  const preview = await importer.preview();
  assert.match(row(preview, 'target').reason, /不同跳板/);
  await assert.rejects(() => importer.confirm(confirmation(preview, 'target')), /不可选择/);
  assert.deepEqual(store.writes, []);
  assert.equal(store.hosts[0].jumpHostId, 'manual');
});

test('duplicate existing endpoints and contradictory endpoint declarations are disabled deterministically', async () => {
  const store = new MemoryStore([host('old'), host('duplicate', { host: 'old.example' })]);
  const preview = await createSshImporter(store, async () => block('old')).preview();
  assert.match(row(preview, 'old').reason, /多个相同/);
  const config = block('one', ' ProxyJump first') + 'Host alias\n HostName one.example\n User fixture\n ProxyJump second\n' + block('first') + block('second');
  assert.match(row(await createSshImporter(new MemoryStore(), async () => config).preview(), 'one').reason, /不同 ProxyJump/);
});

test('configuration and ledger changes reject stale confirmation before any write', async () => {
  const store = new MemoryStore();
  let config = block('target', ' ProxyJump jump') + block('jump');
  const importer = createSshImporter(store, async () => config);
  const preview = await importer.preview();
  config += '\n# changed\n';
  await assert.rejects(() => importer.confirm(confirmation(preview, 'target')), (error: any) => error.status === 409 && /重新检测/.test(error.message));
  const current = await importer.preview();
  store.hosts.push(host('unrelated'));
  await assert.rejects(() => importer.confirm(confirmation(current, 'target')), /台账已变更/);
  assert.deepEqual(store.writes, []);
});

test('arbitrary inputs, unknown IDs, duplicate IDs and empty selections cannot bypass the plan', async () => {
  const store = new MemoryStore();
  const importer = createSshImporter(store, async () => block('valid'));
  const preview = await importer.preview();
  for (const selectedIds of [[], ['unknown'], [row(preview, 'valid').id, row(preview, 'valid').id], [null]]) {
    await assert.rejects(() => importer.confirm({ fingerprint: preview.fingerprint, selectedIds } as any), /有效|不可选择/);
  }
  await importer.confirm({ ...confirmation(preview, 'valid'), host: 'attacker', username: 'attacker' } as any);
  assert.equal(store.hosts[0].host, 'valid.example');
  assert.equal(store.hosts[0].username, 'fixture');
});

test('read failures and write failures are visible with accurate completed counts', async () => {
  const unreadable = createSshImporter(new MemoryStore(), async () => { throw new Error('private path secret'); });
  await assert.rejects(() => unreadable.preview(), /无法读取 SSH 配置/);
  const store = new MemoryStore();
  store.failName = 'two';
  const importer = createSshImporter(store, async () => block('one') + block('two'));
  const preview = await importer.preview();
  const result = await importer.confirm(confirmation(preview, 'one', 'two'));
  assert.match(result.error!, /two.*失败/);
  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.skippedCount, 1);
});

test('concurrent confirmations are refused and stale retries cannot duplicate imported hosts', async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const importer = createSshImporter(store, async () => { if (++reads > 1) await gate; return block('only'); });
  const preview = await importer.preview();
  const request = confirmation(preview, 'only');
  const first = importer.confirm(request);
  await assert.rejects(() => importer.confirm(request), /正在执行/);
  release();
  await first;
  await assert.rejects(() => importer.confirm(request), /已变更/);
  assert.equal(store.writes.length, 1);
});
