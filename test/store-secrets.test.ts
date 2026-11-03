import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HostStore } from '../src/server/store.ts';

for (const field of ['password', 'passphrase'] as const) {
  test(`HostStore PATCH ${field}:null removes only that secret and persists the reset`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'server-deck-store-test-'));
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('server-deck-store-test-'));
    t.after(() => rm(absolute, { recursive: true, force: true }));
    const store = new HostStore(directory);
    await store.load();
    const entry = await store.create({ host: 'fixture.invalid', username: 'fixture', auth: 'password', password: 'fixture-password', passphrase: 'fixture-passphrase' });
    const remaining = field === 'password' ? { passphrase: 'fixture-passphrase' } : { password: 'fixture-password' };
    const updated = await store.update(entry.id, { [field]: null });
    assert.deepEqual(store.getSecret(entry.id), remaining);
    assert.equal('password' in updated, false);
    assert.equal('passphrase' in updated, false);
    const secretsPath = join(directory, 'server-deck.secrets.json');
    assert.deepEqual(JSON.parse(await readFile(secretsPath, 'utf8')), { [entry.id]: remaining });
    assert.equal((await stat(secretsPath)).mode & 0o777, 0o600);
    const loaded = new HostStore(directory);
    await loaded.load();
    assert.deepEqual(loaded.getSecret(entry.id), remaining);
    await loaded.update(entry.id, { password: null, passphrase: null });
    assert.deepEqual(loaded.getSecret(entry.id), {});
    assert.deepEqual(JSON.parse(await readFile(secretsPath, 'utf8')), {});
  });
}
