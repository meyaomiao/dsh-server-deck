import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTerminalConnection, openTerminalWebSocket } from '../src/client/terminal-connection.ts';

test('terminal uses the injected authenticated Connection carrier with logical path and parameters', () => {
  const socket = {} as WebSocket;
  const paths: string[] = [];
  const connection = {
    openWebSocket(path: string) {
      assert.equal(this, connection);
      paths.push(path);
      return socket;
    },
  };
  const dispose = installTerminalConnection(connection);
  try {
    assert.equal(openTerminalWebSocket('ws://127.0.0.1:43210/server-deck/ws/pty?host=test%2Fhost&cols=120&rows=40'), socket);
    assert.equal(openTerminalWebSocket('wss://host.example/prefix/server-deck/ws/pty?host=test&cols=80&rows=24'), socket);
    assert.deepEqual(paths, [
      '/server-deck/ws/pty?host=test%2Fhost&cols=120&rows=40',
      '/server-deck/ws/pty?host=test&cols=80&rows=24',
    ]);
  } finally { dispose(); }
  assert.throws(() => openTerminalWebSocket('ws://127.0.0.1/server-deck/ws/pty'), /鉴权连接/);
});

test('terminal refuses a missing host carrier rather than constructing an unauthenticated socket', () => {
  for (const connection of [undefined, {}]) {
    const dispose = installTerminalConnection(connection);
    try {
      assert.throws(() => openTerminalWebSocket('ws://127.0.0.1/server-deck/ws/pty'), /鉴权连接/);
    } finally { dispose(); }
  }
});

test('disposing an old client plugin cannot clear a replacement connection', () => {
  const first = installTerminalConnection({ openWebSocket: () => { throw new Error('stale'); } });
  const socket = {} as WebSocket;
  const second = installTerminalConnection({ openWebSocket: () => socket });
  first();
  assert.equal(openTerminalWebSocket('wss://127.0.0.1:444/server-deck/ws/pty?host=test'), socket);
  second();
  assert.throws(() => openTerminalWebSocket('ws://127.0.0.1/server-deck/ws/pty'), /鉴权连接/);
});
