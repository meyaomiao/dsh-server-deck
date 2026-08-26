import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig } from '../src/server/sshconfig.ts';

test('解析常规条目', () => {
  const r = parseSshConfig([
    'Host prod-gw',
    '  HostName 10.0.0.1',
    '  User root',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  ProxyJump bastion',
    '',
    'Host *',
    '  Compression yes',
  ].join('\n'));
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.alias, 'prod-gw');
  assert.equal(c.hostname, '10.0.0.1');
  assert.equal(c.user, 'root');
  assert.equal(c.port, 2222);
  assert.ok(c.identityFile !== undefined && !c.identityFile.startsWith('~'));
  assert.equal(c.proxyJump, 'bastion');
});

test('跳过通配 Host 与注释', () => {
  const r = parseSshConfig([
    '# comment',
    'Host web-* db?',
    '  User x',
    'Host real',
    '  User y # inline',
  ].join('\n'));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].alias, 'real');
  assert.equal(r.candidates[0].user, 'y');
});

test('Include 被记录', () => {
  const r = parseSshConfig('Include ~/.ssh/config.d/*\nHost a\n  User u');
  assert.equal(r.includes.length, 1);
  assert.equal(r.candidates[0].alias, 'a');
});

test('多别名行记录全部别名', () => {
  const r = parseSshConfig([
    'Host 1.2.3.4 prod-gw alias-b',
    '  HostName 1.2.3.4',
    '  User ubuntu',
    'Host *',
    '  Compression yes',
  ].join('\n'));
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.alias, '1.2.3.4');
  assert.deepEqual(c.aliases, ['1.2.3.4', 'prod-gw', 'alias-b']);
});
