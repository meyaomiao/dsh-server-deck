/**
 * Real React + xterm browser regression; API/WS are fixture-only, with no SSH traffic.
 * Run after pnpm build. Reuse host UI/browser packages without adding production dependencies:
 * SERVER_DECK_UI_REQUIRE_FROM=/path/to/react-dom/package.json \
 * SERVER_DECK_PLAYWRIGHT_REQUIRE_FROM=/path/to/playwright/package.json \
 * SERVER_DECK_CHROMIUM=/path/to/chrome node --test test/terminal-layout.browser.mjs
 * The require-from overrides are optional when those packages are locally resolvable.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      react: dirname(ui.resolve('react/package.json')),
      'react-dom': dirname(ui.resolve('react-dom/package.json')),
    },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SERVER_DECK_CHROMIUM ? { executablePath: process.env.SERVER_DECK_CHROMIUM } : {}),
  });
});
after(async () => { await browser?.close(); });

async function fixture(t, width = 900, overrides = {}) {
  const host = {
    id: 'layout-fixture', name: 'gravity', username: 'tester', host: '192.0.2.10',
    port: 22, auth: 'agent', tags: [], ...overrides,
  };
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'browser must not crash'); });
  await page.addInitScript(() => {
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { setTimeout(() => this.onopen?.({}), 0); }
      send() {}
      close() { this.readyState = 3; }
    };
  });
  await page.route('http://server-deck.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses = {
      '/server-deck/api/hosts': { hosts: [host] },
      '/server-deck/api/status': { statuses: [{ id: host.id, state: 'online' }] },
      '/server-deck/api/metrics/settings': { ok: true, settings: { collectIntervalSec: 30, recording: true } },
      '/server-deck/api/metrics': {
        ok: true, from: Date.now() - 3600_000, to: Date.now(), bucketUsed: '10s', series: [],
      },
    };
    if (path in responses) {
      await route.fulfill({ json: responses[path] });
    } else {
      assert.equal(path, '/', `unexpected fixture request: ${path}`);
      await route.fulfill({ contentType: 'text/html', body: `<style>
        body { margin: 0; --dsw-alias-bg-base: transparent; }
        #fixture { margin: 72px 0 0 80px; width: ${width}px; height: 420px; }
        #root { height: 100%; }
      </style><section id="fixture"><div id="root"></div></section>` });
    }
  });
  await page.goto('http://server-deck.test/');
  await page.addScriptTag({ content: script });
  await page.locator('.sd-card').waitFor();
  return page;
}

async function enterTerminal(page) {
  await page.getByRole('button', { name: '⌨ 终端', exact: true }).click();
  await page.locator('.sd-term-head').waitFor();
}

async function layout(page) {
  return page.evaluate(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      const css = getComputedStyle(el);
      return {
        ...el.getBoundingClientRect().toJSON(), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        display: css.display, overflow: css.overflow, textOverflow: css.textOverflow,
      };
    };
    return {
      app: read('.sd-app'), wrap: read('.sd-term-wrap'), head: read('.sd-term-head'),
      title: read('.sd-term-head .sd-title'), endpoint: read('.sd-term-head .sd-line'),
      body: read('.sd-term-body'),
    };
  });
}

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} vs ${expected}`);

test('terminal renders one header and its single back button returns to cards', async (t) => {
  const page = await fixture(t);
  await enterTerminal(page);
  assert.equal(await page.locator('.sd-toolbar').count(), 0, 'terminal must not render a second app toolbar');
  assert.equal(await page.locator('.sd-term-head').count(), 1);
  assert.equal(await page.locator('.sd-term-head .sd-title').textContent(), 'gravity');
  assert.deepEqual(await page.locator('.sd-app button').allTextContents(), ['← 返回']);
  await page.getByRole('button', { name: '← 返回', exact: true }).click();
  assert.equal(await page.locator('.sd-toolbar h2').textContent(), '服务器');
  assert.equal(await page.locator('.sd-term-wrap').count(), 0);
});

test('terminal stays inside its offset panel at wide and narrow container widths', async (t) => {
  const page = await fixture(t);
  await enterTerminal(page);
  for (const width of [900, 600, 540, 320, 240]) {
    await page.evaluate((value) => { document.querySelector('#fixture').style.width = `${value}px`; }, width);
    const value = await layout(page);
    near(value.wrap.x, value.app.x, `left edge at ${width}px`);
    near(value.wrap.y, value.app.y, `top edge at ${width}px`);
    near(value.wrap.width, value.app.width, `panel width at ${width}px`);
    near(value.wrap.height, value.app.height, `panel height at ${width}px`);
    assert.ok(value.head.x >= value.app.x && value.head.right <= value.app.right + 1);
    assert.ok(value.body.height > 300, 'terminal keeps the remaining vertical space');
    assert.ok(value.app.scrollWidth <= value.app.clientWidth, 'panel must not scroll sideways');
  }
});

test('wide endpoint is readable; long titles/endpoints truncate and narrow panels hide endpoint', async (t) => {
  const normal = await fixture(t);
  await enterTerminal(normal);
  const wide = await layout(normal);
  assert.notEqual(wide.endpoint.display, 'none');
  assert.ok(wide.endpoint.clientWidth >= wide.endpoint.scrollWidth, 'normal endpoint fits at 900px');

  const page = await fixture(t, 700, { name: 'long-host-name-'.repeat(30), host: `${'long-endpoint-'.repeat(30)}.invalid` });
  await enterTerminal(page);
  const long = await layout(page);
  assert.ok(long.title.scrollWidth > long.title.clientWidth);
  assert.equal(long.title.textOverflow, 'ellipsis');
  assert.ok(long.endpoint.scrollWidth > long.endpoint.clientWidth);
  assert.equal(long.endpoint.textOverflow, 'ellipsis');
  assert.ok(long.endpoint.right <= long.head.right, 'endpoint stays inside header');
  await page.evaluate(() => { document.querySelector('#fixture').style.width = '320px'; });
  const narrow = await layout(page);
  assert.equal(narrow.endpoint.display, 'none', 'container width controls endpoint visibility');
  assert.ok(narrow.title.width > 100, 'host name retains usable space');
});

test('card, trend, add and edit views retain their toolbars and navigation', async (t) => {
  const page = await fixture(t);
  const title = page.locator('.sd-toolbar h2');
  assert.equal(await title.textContent(), '服务器');
  await page.getByRole('button', { name: '📈 趋势', exact: true }).click();
  assert.equal(await title.textContent(), '趋势');
  assert.equal(await page.locator('.sd-toolbar').count(), 1);
  await page.getByRole('button', { name: '← 卡片', exact: true }).click();
  await page.getByRole('button', { name: '✎', exact: true }).click();
  assert.equal(await title.textContent(), '编辑主机');
  assert.equal(await page.locator('.sd-form').count(), 1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '＋ 添加', exact: true }).click();
  assert.equal(await title.textContent(), '添加服务器');
  await page.getByRole('button', { name: '← 卡片', exact: true }).click();
  assert.equal(await title.textContent(), '服务器');
});
