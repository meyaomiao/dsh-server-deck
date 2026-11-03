import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HostStore } from '../src/server/store.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'server-deck-default-name-'));
  t.after(async () => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('server-deck-default-name-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const store = new HostStore(directory);
  await store.load();
  return {
    store,
    async reload() {
      const loaded = new HostStore(directory);
      await loaded.load();
      return loaded;
    },
  };
}

const connection = { username: 'tester', host: 'fixture.invalid', auth: 'agent' };

test('HostStore create defaults empty and whitespace names to user@host and persists them', async (t) => {
  const { store, reload } = await fixture(t);
  for (const name of ['', ' \t\n ', undefined]) {
    const entry = await store.create({ ...connection, name });
    assert.equal(entry.name, 'tester@fixture.invalid');
    assert.deepEqual((await reload()).get(entry.id), JSON.parse(JSON.stringify(entry)));
  }
});

test('HostStore update clears a name to the new connection default and persists it', async (t) => {
  const { store, reload } = await fixture(t);
  for (const name of ['', ' \t\n ']) {
    const original = await store.create({ ...connection, name: 'custom name' });
    const updated = await store.update(original.id, {
      name, username: ' next-user ', host: ' next-host.invalid ',
    });
    assert.equal(updated.name, 'next-user@next-host.invalid');
    assert.equal(updated.username, 'next-user');
    assert.equal(updated.host, 'next-host.invalid');
    assert.deepEqual((await reload()).get(original.id), JSON.parse(JSON.stringify(updated)));
  }
});

test('HostStore trims ordinary names and preserves a name when an update omits it', async (t) => {
  const { store, reload } = await fixture(t);
  const original = await store.create({ ...connection, name: '  Production gateway \t' });
  assert.equal(original.name, 'Production gateway');
  const renamed = await store.update(original.id, { name: '\n Renamed gateway  ' });
  assert.equal(renamed.name, 'Renamed gateway');
  const updated = await store.update(original.id, { username: 'new-user', host: 'new-host.invalid' });
  assert.equal(updated.name, 'Renamed gateway');
  assert.deepEqual((await reload()).get(original.id), JSON.parse(JSON.stringify(updated)));
});

test('HostStore rejects null and non-string names on create and update without persisting changes', async (t) => {
  const { store, reload } = await fixture(t);
  const original = await store.create({ ...connection, name: 'Original' });
  for (const name of [null, 0, 42, true, {}, [], ['name']]) {
    await assert.rejects(() => store.create({ ...connection, name }), /name 无效/);
    await assert.rejects(() => store.update(original.id, { name }), /name 无效/);
  }
  assert.deepEqual(store.list(), [original]);
  assert.deepEqual((await reload()).list(), JSON.parse(JSON.stringify([original])));
});
