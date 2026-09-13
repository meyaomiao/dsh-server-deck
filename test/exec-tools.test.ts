import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost, type HostPick } from '../src/server/resolve-host.ts';
import { clampTimeoutMs, looksLikeWindows, truncateCapture, wrapRemoteCommand } from '../src/server/wrap-command.ts';

const hosts: HostPick[] = [
  { id: 'srv_win', name: 'win', host: '100.82.215.120', port: 22, username: 'xzb17' },
  { id: 'srv_a', name: '124.223.28.13', host: '100.65.187.42', port: 22, username: 'ubuntu' },
  { id: 'srv_b', name: 'prod', host: '100.119.44.89', port: 22, username: 'ubuntu' },
];

test('resolveHost:精确 id / 名 / IP / user@host', () => {
  const byId = resolveHost(hosts, 'srv_win');
  assert.equal(byId.ok, true);
  if (byId.ok) assert.equal(byId.host.id, 'srv_win');
  const byName = resolveHost(hosts, 'win');
  assert.equal(byName.ok, true);
  if (byName.ok) assert.equal(byName.host.id, 'srv_win');
  const byIp = resolveHost(hosts, '100.65.187.42');
  assert.equal(byIp.ok, true);
  if (byIp.ok) assert.equal(byIp.host.id, 'srv_a');
  const byUser = resolveHost(hosts, 'ubuntu@100.119.44.89');
  assert.equal(byUser.ok, true);
  if (byUser.ok) assert.equal(byUser.host.id, 'srv_b');
});

test('resolveHost:空查询 / 未找到 / 歧义', () => {
  assert.equal(resolveHost(hosts, '  ').ok, false);
  assert.equal(resolveHost(hosts, 'no-such').ok, false);
  const amb = resolveHost(hosts, '100.');
  assert.equal(amb.ok, false);
  if (!amb.ok) assert.match(amb.error, /多台/);
});

test('wrapRemoteCommand:Linux 原样,Windows 走 EncodedCommand', () => {
  assert.equal(wrapRemoteCommand('uname -a', 'Ubuntu 24.04.4 LTS'), 'uname -a');
  assert.equal(wrapRemoteCommand('uname -a', undefined), 'uname -a');
  const win = wrapRemoteCommand('hostname', 'Microsoft Windows 11 家庭版');
  assert.equal(win.includes('EncodedCommand'), true);
  assert.equal(win.includes('cmd.exe /c'), true);
  assert.equal(looksLikeWindows('Microsoft Windows 11 家庭版'), true);
  assert.equal(looksLikeWindows('Ubuntu'), false);
});

test('wrapRemoteCommand:已指定 powershell/cmd 则不包装', () => {
  assert.equal(wrapRemoteCommand('cmd.exe /c echo hi', 'Windows'), 'cmd.exe /c echo hi');
  assert.equal(wrapRemoteCommand('powershell.exe -NoProfile -Command Get-Date', 'Windows'), 'powershell.exe -NoProfile -Command Get-Date');
});

test('clampTimeoutMs 与截断', () => {
  assert.equal(clampTimeoutMs(undefined), 60_000);
  assert.equal(clampTimeoutMs(500), 1_000);
  assert.equal(clampTimeoutMs(999_999), 300_000);
  const t = truncateCapture('x'.repeat(40_000));
  assert.equal(t.truncated, true);
  assert.equal(t.text.includes('[truncated'), true);
});
