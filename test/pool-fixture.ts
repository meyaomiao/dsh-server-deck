import type { TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { HostPool } from '../src/server/pool.ts';
import type { HostEntry } from '../src/types.ts';

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function host(id: string, jumpHostId?: string): HostEntry {
  return { id, name: id, host: `${id}.invalid`, port: 22, username: 'fixture', auth: 'password', jumpHostId, createdAt: '' };
}

export interface ObservedClient {
  conn: Client;
  cfg: ConnectConfig;
  ended: boolean;
}

export function fixture(t: TestContext, hosts = [host('gateway'), host('jump', 'gateway'), host('target', 'jump')]) {
  const clients: ObservedClient[] = [];
  const channels: ClientChannel[] = [];
  const forwards: Array<{ host: string; finish: (error?: Error) => ClientChannel }> = [];
  let connect = (_client: ObservedClient): void => {};
  let forward = (_host: string): 'hold' | 'error' | 'throw' | undefined => undefined;
  t.mock.method(Client.prototype, 'connect', function (this: Client, cfg: ConnectConfig) {
    const client = { conn: this, cfg, ended: false };
    clients.push(client);
    connect(client);
    return this;
  });
  t.mock.method(Client.prototype, 'end', function (this: Client) {
    const client = clients.find((c) => c.conn === this);
    if (client !== undefined && !client.ended) {
      client.ended = true;
      queueMicrotask(() => this.emit('close'));
    }
    return this;
  });
  t.mock.method(Client.prototype, 'forwardOut', function (
    this: Client, _src: string, _srcPort: number, target: string, _port: number,
    callback: (error?: Error, channel?: ClientChannel) => void,
  ) {
    const behavior = forward(target);
    if (behavior === 'throw') throw new Error('fixture synchronous forward failure');
    const finish = (error?: Error): ClientChannel => {
      const channel = new PassThrough() as unknown as ClientChannel;
      channel.close = () => { channel.destroy(); return channel; };
      channels.push(channel);
      callback(error, channel);
      return channel;
    };
    forwards.push({ host: target, finish });
    if (behavior !== 'hold') queueMicrotask(() => finish(behavior === 'error' ? new Error('fixture forward refusal') : undefined));
    return this;
  });
  connect = (client) => { queueMicrotask(() => client.conn.emit('ready')); };
  const pool = new HostPool((id) => hosts.find((h) => h.id === id), () => ({ password: 'fixture-password' }));
  t.after(async () => {
    pool.closeAll();
    for (const client of clients) client.conn.end();
    for (const channel of channels) channel.close();
    await flush();
  });
  return {
    pool, clients, channels, forwards, hosts,
    onConnect(behavior: typeof connect) { connect = behavior; },
    onForward(behavior: typeof forward) { forward = behavior; },
  };
}

/** Bound failure cases too: the old pool never settles a pre-ready close. */
export async function outcome(promise: Promise<unknown>): Promise<'resolved' | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error)),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('fixture: did not settle'), 150); }),
    ]);
  } finally { clearTimeout(timer); }
}
