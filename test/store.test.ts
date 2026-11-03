import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostEntry } from '../src/types.ts';

// store.ts 的 DSH_DIR 在模块加载期固定到 ~/.dsh;单测通过 chdir 不影响它,
// 因此这里只测 normalizeInput 的校验逻辑(经 create/update 路径间接覆盖会污染
// 真实台账——改为直接构造并断言纯校验行为)。
// 为保持零侵入,这里用临时目录 + 模块级 monkey-patch 不可行(ESM 只读绑定),
// 故仅测「非法输入被拒」这一层。

test('normalizeInput 拒绝非法字段(store.create 前置校验)', async () => {
  const mod = await import('../src/server/store.ts');
  // 通过一个不落盘的实例无法绕过 HOME……改为直接调用内部逻辑:
  // create() 在写入前抛错,不会触碰文件系统。
  const store = new mod.HostStore();
  await assert.rejects(
    () => store.create({ host: 'x', username: 'u', auth: 'nope' }),
    /auth/,
  );
  await assert.rejects(
    () => store.create({ host: '', username: 'u', auth: 'agent' }),
    /必填|无效/,
  );
  await assert.rejects(
    () => store.create({ host: 'h', username: 'u', auth: 'key', port: 99999 }),
    /port/,
  );
  void join;
  void mkdtemp;
  void tmpdir;
});

test('normalizeInput 规范化 jumpHostId', async () => {
  const { normalizeInput } = await import('../src/server/store.ts');
  assert.equal(normalizeInput({ jumpHostId: '  srv_1  ' }).fields.jumpHostId, 'srv_1');
  assert.equal(normalizeInput({ jumpHostId: null }).fields.jumpHostId, undefined);
  assert.equal(normalizeInput({ jumpHostId: '   ' }).fields.jumpHostId, undefined);
  assert.throws(() => normalizeInput({ jumpHostId: 1 }), /jumpHostId/);
});

function host(id: string, jumpHostId?: string): HostEntry {
  return {
    id,
    name: id,
    host: '127.0.0.1',
    port: 22,
    username: 'u',
    auth: 'agent',
    jumpHostId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('assertJumpTarget 接受链式跳板并拒绝自指 / 缺失 / 环', async () => {
  const { assertJumpTarget } = await import('../src/server/store.ts');
  const a = host('a');
  const b = host('b', 'a');
  const c = host('c', 'b');
  assert.doesNotThrow(() => assertJumpTarget('d', 'c', [a, b, c]));
  assert.doesNotThrow(() => assertJumpTarget('d', undefined, [a, b, c]));
  assert.throws(() => assertJumpTarget('a', 'a', [a]), /自身/);
  assert.throws(() => assertJumpTarget('a', 'missing', [a]), /不存在/);
  assert.throws(() => assertJumpTarget('a', 'b', [host('a', 'c'), host('b', 'a'), host('c', 'b')]), /循环/);
  assert.throws(() => assertJumpTarget('a', 'b', [a, host('b', 'missing')]), /链路不完整/);
});
