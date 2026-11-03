/**
 * ssh2 连接管理:每主机复用长连接(exec/shell 共享),test 走独立短连接。
 */

import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { HostEntry } from '../types.ts';

const READY_TIMEOUT_MS = 10_000;

/** 连接配置构造(秘密从 store 注入,不进台账)。 */
export async function buildConnectConfig(
  host: HostEntry,
  secret: { password?: string; passphrase?: string },
  overrides?: Partial<ConnectConfig>,
): Promise<ConnectConfig> {
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };
  if (host.auth === 'password') {
    if (secret.password === undefined) throw new Error('该主机未保存密码');
    cfg.password = secret.password;
  } else if (host.auth === 'key') {
    if (host.keyPath === undefined || host.keyPath.length === 0) throw new Error('该主机未配置私钥路径');
    try {
      cfg.privateKey = await readFile(host.keyPath, 'utf8');
    } catch (error) {
      throw new Error(`读取私钥失败 ${host.keyPath}:${error instanceof Error ? error.message : String(error)}`);
    }
    if (secret.passphrase !== undefined) cfg.passphrase = secret.passphrase;
  } else {
    // agent:SSH_AUTH_SOCK 由环境提供;缺失时 ssh2 会报错,信息足够定位
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return { ...cfg, ...overrides };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface Pooled {
  promise: Promise<Client>;
  /** 包含目标和全部跳板,在异步连接前固定依赖。 */
  hostIds: Set<string>;
  clients: Client[];
  channels: Set<ClientChannel>;
  abort: AbortController;
}

/** 生命周期监听由调用方在 connect 前安装;abort 同时结束 pending 等待。 */
function connectClient(conn: Client, cfg: ConnectConfig, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      conn.off('ready', ready);
      signal.removeEventListener('abort', aborted);
    };
    const ready = (): void => { cleanup(); resolve(); };
    const aborted = (): void => { cleanup(); reject(signal.reason); };
    if (signal.aborted) { aborted(); return; }
    conn.once('ready', ready);
    signal.addEventListener('abort', aborted, { once: true });
    try { conn.connect(cfg); } catch (error) { cleanup(); reject(error); }
  });
}

/** 取消/超时/同步 throw 都清理 timer;晚到回调返回的通道立即关闭。 */
function forwardOut(conn: Client, host: string, port: number, signal: AbortSignal): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error: unknown): void => { if (!done) { cleanup(); reject(error); } };
    const aborted = (): void => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error('跳板转发超时')), READY_TIMEOUT_MS);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    try {
      conn.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (done || error !== undefined && error !== null || stream === undefined) {
          try { stream?.close(); } catch { /* 已断 */ }
          if (!done) fail(new Error(`跳板转发失败:${error ? messageOf(error) : '无返回通道'}`));
          return;
        }
        cleanup();
        resolve(stream);
      });
    } catch (error) { fail(error); }
  });
}

/** 每主机一条长连接;exec / shell 复用,并发建立共享同一个任务。 */
export class HostPool {
  private pool = new Map<string, Pooled>();
  /** 包含独立 test,确保退出也能取消尚在握手/转发的短连接。 */
  private active = new Set<Pooled>();

  constructor(
    private readonly resolveHost: (id: string) => HostEntry | undefined,
    private readonly resolveSecret: (id: string) => { password?: string; passphrase?: string },
  ) {}

  connect(id: string): Promise<Client> {
    const cached = this.pool.get(id);
    if (cached !== undefined) return cached.promise;
    const host = this.resolveHost(id);
    if (host === undefined) return Promise.reject(new Error('主机不存在'));
    try {
      const opened = this.start(host, () => {
        // 旧连接的迟到事件不能删除同 id 的替代连接。
        if (this.pool.get(id) === opened) this.pool.delete(id);
      });
      this.pool.set(id, opened);
      return opened.promise;
    } catch (error) {
      return Promise.reject(new Error(`SSH 连接失败:${messageOf(error)}`));
    }
  }

  private start(host: HostEntry, onClose: () => void = () => {}): Pooled {
    const hosts: HostEntry[] = [];
    const hostIds = new Set<string>();
    let current: HostEntry | undefined = host;
    while (current !== undefined) {
      if (hostIds.has(current.id)) throw new Error('跳板机存在循环引用');
      hostIds.add(current.id);
      hosts.unshift({ ...current });
      const jumpId: string | undefined = current.jumpHostId;
      current = jumpId === undefined ? undefined : this.resolveHost(jumpId);
      if (jumpId !== undefined && current === undefined) throw new Error(`跳板机不存在:${jumpId}`);
    }
    const opened: Pooled = {
      // 延后启动,先登记整个任务;同步 close 也能取消尚未创建的 Client。
      promise: Promise.resolve().then(() => this.open(hosts, opened)).catch((error: unknown) => {
        this.stop(opened, error);
        throw new Error(`SSH 连接失败:${messageOf(error)}`);
      }),
      hostIds, clients: [], channels: new Set(), abort: new AbortController(),
    };
    opened.abort.signal.addEventListener('abort', onClose, { once: true });
    this.active.add(opened);
    return opened;
  }

  private stop(opened: Pooled, error: unknown = new Error('SSH 连接已关闭')): void {
    if (opened.abort.signal.aborted) return;
    this.active.delete(opened);
    opened.abort.abort(error);
    for (const channel of opened.channels) {
      try { channel.close(); } catch { /* 已断 */ }
    }
    for (const conn of [...opened.clients].reverse()) {
      try { conn.end(); } catch { /* 已断 */ }
    }
  }

  private async open(hosts: HostEntry[], opened: Pooled): Promise<Client> {
    const signal = opened.abort.signal;
    let parent: Client | undefined;
    for (const host of hosts) {
      signal.throwIfAborted();
      const cfg = await buildConnectConfig(host, this.resolveSecret(host.id));
      signal.throwIfAborted();
      if (parent !== undefined) {
        try {
          const channel = await forwardOut(parent, host.host, host.port, signal);
          if (signal.aborted || channel.destroyed) {
            try { channel.close(); } catch { /* 已断 */ }
            signal.throwIfAborted();
            throw new Error('跳板转发通道已关闭');
          }
          opened.channels.add(channel);
          channel.once('close', () => this.stop(opened, new Error('跳板转发通道已关闭')));
          channel.on('error', (error: Error) => this.stop(opened, error));
          signal.throwIfAborted();
          cfg.sock = channel;
        } catch (error) {
          throw new Error(`经跳板机连接失败:${messageOf(error)}`);
        }
      }
      const conn = new Client();
      opened.clients.push(conn);
      // 必须先于 connect/ready:forwarded sock 可同步触发 ready/end/close。
      conn.on('error', (error) => this.stop(opened, error));
      conn.on('end', () => this.stop(opened, new Error('SSH 连接已断开')));
      conn.on('close', () => this.stop(opened));
      await connectClient(conn, cfg, signal);
      signal.throwIfAborted();
      parent = conn;
    }
    signal.throwIfAborted();
    return parent!;
  }

  /** 独立短连接测试(不占用连接池),返回握手延迟。 */
  async test(host: HostEntry): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const started = Date.now();
    let opened: Pooled | undefined;
    try {
      opened = this.start(host);
      await opened.promise;
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      if (opened !== undefined) this.stop(opened);
    }
  }

  /** 在主机上执行单条命令(走池内长连接)。登录壳会解释这条命令,探针不要走这里。 */
  exec(id: string, command: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.runExec(id, command, timeoutMs);
  }

  /**
   * 把脚本交给 /bin/sh -s(stdin)。命令本身对 fish/zsh 无特殊语法。
   * /bin/sh 不存在时再试 sh -s。
   */
  execSh(id: string, script: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const body = script.endsWith('\n') ? script : `${script}\n`;
    return this.runExec(id, '/bin/sh -s', timeoutMs, body).then((result) => {
      if (result.code === 127) return this.runExec(id, 'sh -s', timeoutMs, body);
      return result;
    }).catch((error) => {
      const msg = messageOf(error);
      if (!/exec 失败|No such file|not found/i.test(msg)) throw error;
      return this.runExec(id, 'sh -s', timeoutMs, body);
    });
  }

  private runExec(
    id: string,
    command: string,
    timeoutMs: number,
    stdin?: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.connect(id).then(
      (conn) =>
        new Promise((resolve, reject) => {
          conn.exec(command, (error, stream) => {
            if (error !== undefined && error !== null) {
              reject(new Error(`exec 失败:${messageOf(error)}`));
              return;
            }
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
              stream.close();
              resolve({ code: null, stdout, stderr: `${stderr}\n[server-deck] 命令超时(${timeoutMs}ms)` });
            }, timeoutMs);
            stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            stream.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
            stream.on('close', (code: number | null) => {
              clearTimeout(timer);
              resolve({ code, stdout, stderr });
            });
            if (stdin !== undefined) {
              stream.write(stdin);
              stream.end();
            }
          });
        }),
      (error) => { throw error; },
    );
  }

  /** 打开交互式 shell(PTY 终端用)。 */
  shell(id: string, cols: number, rows: number): Promise<ClientChannel> {
    return this.connect(id).then(
      (conn) =>
        new Promise((resolve, reject) => {
          conn.shell({ cols, rows, term: 'xterm-256color' }, (error, stream) => {
            if (error !== undefined && error !== null) reject(new Error(`打开 shell 失败:${messageOf(error)}`));
            else resolve(stream);
          });
        }),
      (error) => { throw error; },
    );
  }

  close(id: string): void {
    for (const opened of [...this.active]) {
      if (opened.hostIds.has(id)) this.stop(opened);
    }
  }

  closeAll(): void {
    for (const opened of [...this.active]) this.stop(opened);
  }
}
