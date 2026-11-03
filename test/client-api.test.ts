import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ptyUrl } from '../src/client/api.ts';

function mockPage(
  t: TestContext,
  pageUrl: string,
  transport?: { streamBaseUrl?: string },
  baseURI = pageUrl,
): void {
  for (const [key, value] of Object.entries({
    location: new URL(pageUrl),
    document: { baseURI },
    __DSH_TRANSPORT__: transport,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

for (const [pageUrl, expected] of [
  ['http://127.0.0.1:53613/?session=one#top', 'ws://127.0.0.1:53613/server-deck/ws/pty?host=srv_local&cols=80&rows=24'],
  ['https://dsh.example.test/?session=one#top', 'wss://dsh.example.test/server-deck/ws/pty?host=srv_local&cols=80&rows=24'],
]) {
  test(`ptyUrl: browser stays on the ${new URL(pageUrl).protocol} origin`, (t) => {
    mockPage(t, pageUrl);
    assert.equal(ptyUrl('srv_local', 80, 24), expected);
  });
}

for (const [streamBaseUrl, expected] of [
  ['http://127.0.0.1:19387/', 'ws://127.0.0.1:19387/server-deck/ws/pty?host=srv_desktop&cols=120&rows=40'],
  ['https://host.example.test/', 'wss://host.example.test/server-deck/ws/pty?host=srv_desktop&cols=120&rows=40'],
]) {
  test(`ptyUrl: desktop uses ${streamBaseUrl} instead of dsh-app://app`, (t) => {
    mockPage(t, 'dsh-app://app/', { streamBaseUrl });
    assert.equal(ptyUrl('srv_desktop', 120, 40), expected);
  });
}

test('ptyUrl: transport also overrides an HTTP page origin', (t) => {
  mockPage(t, 'http://ui.example.test/', { streamBaseUrl: 'https://host.example.test:8443/' });
  assert.equal(
    ptyUrl('srv_remote', 100, 30),
    'wss://host.example.test:8443/server-deck/ws/pty?host=srv_remote&cols=100&rows=30',
  );
});

test('ptyUrl: missing streamBaseUrl falls back to document.baseURI', (t) => {
  mockPage(t, 'dsh-app://app/', {}, 'https://fallback.example.test/');
  assert.equal(
    ptyUrl('srv_fallback', 80, 24),
    'wss://fallback.example.test/server-deck/ws/pty?host=srv_fallback&cols=80&rows=24',
  );
});

test('ptyUrl: route resolves relative to the transport base path', (t) => {
  mockPage(t, 'dsh-app://app/', { streamBaseUrl: 'https://host.example.test/dsh/' });
  assert.equal(
    ptyUrl('srv_proxy', 80, 24),
    'wss://host.example.test/dsh/server-deck/ws/pty?host=srv_proxy&cols=80&rows=24',
  );
});

test('ptyUrl: host IDs remain encoded as one query value', (t) => {
  mockPage(t, 'http://127.0.0.1:53613/');
  const hostId = 'srv 中文 +&?/#=token=other';
  const url = new URL(ptyUrl(hostId, 132, 43));
  assert.equal(url.pathname, '/server-deck/ws/pty');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams], [
    ['host', hostId],
    ['cols', '132'],
    ['rows', '43'],
  ]);
});
