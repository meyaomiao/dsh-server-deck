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
  conn: Client;
  /** 跳板链路,从近到远;关闭目标连接时一并断开。 */
  jumps: Client[];
}

/** 建立连接;跳板机递归打开,目标走 forwardOut 的 sock。 */
async function connectClient(conn: Client, cfg: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    conn.on('error', (error) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* 已断 */ }
      reject(error);
    });
    conn.once('ready', () => {
      settled = true;
      resolve();
    });
    try {
      conn.connect(cfg);
    } catch (error) {
      settled = true;
      try { conn.end(); } catch { /* 已断 */ }
      reject(error);
    }
  });
}

/** 在跳板机上向目标地址开一条转发通道。 */
function forwardOut(conn: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error('跳板转发超时'));
    }, READY_TIMEOUT_MS);
    conn.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (done) {
        try { stream?.close(); } catch { /* 已断 */ }
        return;
      }
      done = true;
      clearTimeout(timer);
      if (error !== undefined && error !== null) reject(new Error(`跳板转发失败:${messageOf(error)}`));
      else if (stream === undefined) reject(new Error('跳板转发失败:无返回通道'));
      else resolve(stream);
    });
  });
}

function closeChain(pooled: Pooled): void {
  for (const conn of [pooled.conn, ...pooled.jumps]) {
    try { conn.end(); } catch { /* 已断 */ }
  }
}

/** 每主机一条长连接;exec / shell 复用。 */
export class HostPool {
  private pool = new Map<string, Pooled>();

  constructor(
    private readonly resolveHost: (id: string) => HostEntry | undefined,
    private readonly resolveSecret: (id: string) => { password?: string; passphrase?: string },
  ) {}

  /** 取(或建立)主机的就绪连接。断开时经 close 事件自动出池。 */
  connect(id: string): Promise<Client> {
    const cached = this.pool.get(id);
    if (cached !== undefined) {
      // close 事件已保证缓存只含存活连接
      return Promise.resolve(cached.conn);
    }

    const host = this.resolveHost(id);
    if (host === undefined) return Promise.reject(new Error('主机不存在'));
    return this.open(host, new Set()).then(
      (opened) => {
        const cleanup = (): void => {
          this.pool.delete(id);
          for (const jump of opened.jumps) {
            try { jump.end(); } catch { /* 已断 */ }
          }
        };
        opened.conn.on('close', cleanup);
        opened.conn.on('end', cleanup);
        opened.conn.on('error', cleanup);
        this.pool.set(id, opened);
        return opened.conn;
      },
      (error) => { throw new Error(`SSH 连接失败:${messageOf(error)}`); },
    );
  }

  private async open(host: HostEntry, seen: Set<string>): Promise<Pooled> {
    if (seen.has(host.id)) throw new Error('跳板机存在循环引用');
    seen.add(host.id);
    const jump = host.jumpHostId !== undefined ? this.resolveHost(host.jumpHostId) : undefined;
    if (host.jumpHostId !== undefined && jump === undefined) {
      throw new Error(`跳板机不存在:${host.jumpHostId}`);
    }
    const cfg = await buildConnectConfig(host, this.resolveSecret(host.id));
    let parent: Pooled | undefined;
    if (jump !== undefined) {
      try {
        parent = await this.open(jump, seen);
        cfg.sock = await forwardOut(parent.conn, host.host, host.port);
      } catch (error) {
        if (parent !== undefined) closeChain(parent);
        throw new Error(`经跳板机 ${jump.name} 连接失败:${messageOf(error)}`);
      }
    }
    const conn = new Client();
    try {
      await connectClient(conn, cfg);
    } catch (error) {
      if (parent !== undefined) closeChain(parent);
      throw error;
    }
    return { conn, jumps: parent === undefined ? [] : [parent.conn, ...parent.jumps] };
  }

  /** 独立短连接测试(不占用连接池),返回握手延迟。 */
  async test(host: HostEntry): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const started = Date.now();
    try {
      const opened = await this.open(host, new Set());
      const latencyMs = Date.now() - started;
      closeChain(opened);
      return { ok: true, latencyMs };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
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
    const pooled = this.pool.get(id);
    if (pooled !== undefined) {
      this.pool.delete(id);
      closeChain(pooled);
    }
  }

  closeAll(): void {
    for (const id of [...this.pool.keys()]) this.close(id);
  }
}
