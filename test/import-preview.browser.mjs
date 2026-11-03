/**
 * Real React + Chrome import regression, with intercepted HTTP fixtures and no SSH/server.
 * Run after pnpm build:
 * SERVER_DECK_UI_REQUIRE_FROM=/path/to/react-dom/package.json \
 * SERVER_DECK_PLAYWRIGHT_REQUIRE_FROM=/path/to/playwright/package.json \
 * SERVER_DECK_CHROMIUM=/path/to/chrome \
 * node --experimental-transform-types --test test/import-preview.browser.mjs
 * Overrides are optional when the packages/browser are locally resolvable.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSshImporter } from '../src/server/importer.ts';
import { assertJumpTarget, normalizeInput } from '../src/server/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = createRequire(resolve(process.env.SERVER_DECK_UI_REQUIRE_FROM ?? `${root}/package.json`));
const pw = createRequire(resolve(process.env.SERVER_DECK_PLAYWRIGHT_REQUIRE_FROM ?? `${root}/package.json`));
const { chromium } = pw('playwright');
let browser;
let script;
before(async () => {
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ServerDeckApp } from './src/client/app.tsx';
        import { ensureStyles } from './src/client/styles.ts';
        ensureStyles();
        createRoot(document.getElementById('root')).render(createElement(ServerDeckApp, { visible: false }));`,
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: dirname(ui.resolve('react/package.json')), 'react-dom': dirname(ui.resolve('react-dom/package.json')) },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.SERVER_DECK_CHROMIUM ? { executablePath: process.env.SERVER_DECK_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); });

const block = (name, options = '') => `Host ${name}\n HostName ${name}.example\n User fixture\n${options}\n`;
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const state = { config: options.config ?? block('one') + block('two'), hosts: options.hosts ?? [], writes: [],
    previewCalls: 0, confirmCalls: 0, readError: false, previewStarted: deferred(), confirmStarted: deferred() };
  const store = {
    list: () => state.hosts,
    async create(input) {
      if (options.failName === input.name) throw Error('fixture write failed');
      const { fields } = normalizeInput(input);
      const entry = { ...fields, id: `fixture-${state.hosts.length}`, createdAt: '2026-01-01' };
      assertJumpTarget(entry.id, entry.jumpHostId, state.hosts);
      state.hosts.push(entry);
      state.writes.push(`create:${entry.name}`);
      return entry;
    },
    async update(id, input) {
      const index = state.hosts.findIndex((entry) => entry.id === id);
      const entry = { ...state.hosts[index], ...normalizeInput(input).fields };
      assertJumpTarget(id, entry.jumpHostId, state.hosts);
      state.hosts[index] = entry;
      state.writes.push(`update:${entry.name}`);
      return entry;
    },
  };
  const importer = createSshImporter(store, async () => {
    if (state.readError) throw Error('private fixture details');
    return state.config;
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => { options.previewGate?.resolve(); options.confirmGate?.resolve(); await page.close(); assert.deepEqual(errors, []); });
  await page.route('http://server-deck.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/server-deck/api/import-ssh-config') {
      const request = route.request().postDataJSON();
      try {
        if (request.action === 'preview') {
          state.previewCalls += 1;
          state.previewStarted.resolve();
          if (options.previewGate) await options.previewGate.promise;
          await route.fulfill({ json: await importer.preview() });
        } else {
          assert.equal(request.action, 'confirm');
          assert.deepEqual(Object.keys(request).sort(), ['action', 'fingerprint', 'selectedIds']);
          state.confirmCalls += 1;
          state.confirmStarted.resolve();
          state.selection = request;
          if (options.confirmGate) await options.confirmGate.promise;
          await route.fulfill({ json: await importer.confirm(request) });
        }
      } catch (error) { await route.fulfill({ status: error.status ?? 400, json: { error: error.message } }); }
      return;
    }
    const responses = {
      '/server-deck/api/hosts': { hosts: state.hosts },
      '/server-deck/api/status': { statuses: [] },
      '/server-deck/api/metrics/settings': { ok: true, settings: { collectIntervalSec: 30, recording: true } },
    };
    if (path in responses) await route.fulfill({ json: responses[path] });
    else {
      assert.equal(path, '/', `unexpected fixture request ${path}`);
      await route.fulfill({ contentType: 'text/html', body: `<style>body { margin: 0; background: #111; }
        #fixture { width: 580px; height: 580px; margin: 40px 0 0 60px; } #root { height: 100%; }</style>
        <section id="fixture"><div id="root"></div></section>` });
    }
  });
  await page.goto('http://server-deck.test/');
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: '⤓ 导入', exact: true }).waitFor();
  return { page, state };
}
async function open(page) {
  await page.getByRole('button', { name: '⤓ 导入', exact: true }).click();
  await page.getByText('检测到', { exact: false }).waitFor();
}

test('first click only previews; cancel during detection and after preview never writes', async (t) => {
  const gate = deferred();
  const { page, state } = await fixture(t, { previewGate: gate });
  await page.getByRole('button', { name: '⤓ 导入', exact: true }).click();
  await state.previewStarted.promise;
  assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  gate.resolve();
  await page.getByRole('button', { name: '⤓ 导入', exact: true }).waitFor();
  await open(page);
  assert.equal(await page.getByRole('checkbox', { name: 'one', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'two', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(state.writes, []);
  assert.equal(state.confirmCalls, 0);
});

test('one selected host confirms once; busy disables repeat, selection, cancel and recheck; counts show', async (t) => {
  const gate = deferred();
  const { page, state } = await fixture(t, { confirmGate: gate });
  await open(page);
  await page.getByRole('button', { name: '取消全选', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
  await page.getByRole('checkbox', { name: 'two', exact: true }).check();
  assert.match(await page.locator('.sd-import-summary').textContent(), /将新增 1 台，更新跳板关联 0 台/);
  await page.getByRole('button', { name: '确认导入', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await state.confirmStarted.promise;
  assert.equal(await page.getByRole('button', { name: '导入中…', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '重新检测', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'two', exact: true }).isDisabled(), true);
  assert.equal(state.confirmCalls, 1);
  assert.deepEqual(state.writes, []);
  gate.resolve();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  assert.match(await page.getByRole('status').textContent(), /新增 1 台，更新跳板关联 0 台，跳过 1 条/);
  assert.deepEqual(state.writes, ['create:two']);
  await page.getByRole('button', { name: '返回服务器', exact: true }).click();
  assert.deepEqual(await page.locator('.sd-card .sd-name').allTextContents(), ['two']);
});

test('dependency is included explicitly and invalid rows remain visible and disabled', async (t) => {
  const config = block('target', ' ProxyJump fixture@jump:22') + block('jump') + block('independent')
    + block('broken', ' ProxyJump absent') + 'Host *.internal\n User fixture\n'
    + 'Host github\n HostName github.com\n User git\n' + 'Host missing-user\n HostName missing.example\n';
  const { page, state } = await fixture(t, { config });
  await open(page);
  for (const name of ['broken', '*.internal', 'github', 'missing-user']) {
    assert.equal(await page.getByRole('checkbox', { name, exact: true }).isDisabled(), true);
  }
  assert.match(await page.locator('.sd-import-list').textContent(), /引用不存在/);
  assert.match(await page.locator('.sd-import-list').textContent(), /Git 托管/);
  assert.match(await page.locator('.sd-import-list').textContent(), /缺少用户名/);
  await page.getByRole('button', { name: '取消全选', exact: true }).click();
  await page.getByRole('checkbox', { name: 'target', exact: true }).check();
  const jump = page.getByRole('checkbox', { name: 'jump', exact: true });
  assert.equal(await jump.isChecked(), true);
  assert.equal(await jump.isDisabled(), true);
  assert.match(await page.locator('.sd-import-summary').textContent(), /将新增 2 台.*自动包含 1 个依赖/);
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  assert.deepEqual(state.writes, ['create:jump', 'create:target']);
  assert.equal(state.selection.selectedIds.length, 1);
});

test('stale config error requires another detection; no writes happen before recheck', async (t) => {
  const { page, state } = await fixture(t);
  await open(page);
  state.config += block('three');
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /配置或台账已变更，请重新检测/);
  assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).isDisabled(), true);
  assert.deepEqual(state.writes, []);
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.getByRole('checkbox', { name: 'three', exact: true }).waitFor();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  assert.equal(state.hosts.length, 3);
});

test('existing host repair is selected by default and the result distinguishes updates', async (t) => {
  const hosts = ['target', 'jump'].map((name) => ({ id: name, name, host: `${name}.example`, username: 'fixture', port: 22, auth: 'agent', createdAt: '2026-01-01' }));
  const { page, state } = await fixture(t, { hosts, config: block('target', ' ProxyJump jump') + block('jump') });
  await open(page);
  assert.equal(await page.getByRole('checkbox', { name: 'target', exact: true }).isChecked(), true);
  assert.match(await page.locator('.sd-import-summary').textContent(), /将新增 0 台，更新跳板关联 1 台/);
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  assert.match(await page.getByRole('status').textContent(), /新增 0 台，更新跳板关联 1 台/);
  assert.deepEqual(state.writes, ['update:target']);
  assert.equal(state.hosts[0].jumpHostId, 'jump');
});

test('read and partial write errors are visible; preview fits a narrow panel', async (t) => {
  const { page, state } = await fixture(t, { failName: 'two' });
  state.readError = true;
  await page.getByRole('button', { name: '⤓ 导入', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /无法读取 SSH 配置/);
  state.readError = false;
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.getByRole('checkbox', { name: 'one', exact: true }).waitFor();
  await page.evaluate(() => { document.querySelector('#fixture').style.width = '320px'; });
  const fits = await page.locator('.sd-import').evaluate((element) => element.scrollWidth <= element.clientWidth);
  assert.equal(fits, true, 'import preview remains inside the panel');
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '导入未全部完成' }).waitFor();
  assert.match(await page.getByRole('status').textContent(), /新增 1 台.*跳过 1 条.*two.*失败/);
  assert.deepEqual(state.writes, ['create:one']);
});
