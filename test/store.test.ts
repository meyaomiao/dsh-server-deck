import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
