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
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        this.pool.delete(id);
        try { conn.end(); } catch { /* 已断 */ }
        reject(new Error(`SSH 连接失败:${messageOf(error)}`));
      };
      conn.on('ready', () => {
        if (settled) return;
        settled = true;
        conn.on('close', () => this.pool.delete(id));
        conn.on('end', () => this.pool.delete(id));
        conn.on('error', () => this.pool.delete(id));
        this.pool.set(id, { conn });
        resolve(conn);
      });
      conn.on('error', fail);
      buildConnectConfig(host, this.resolveSecret(id))
        .then((cfg) => conn.connect(cfg))
        .catch(fail);
    });
  }

  /** 独立短连接测试(不占用连接池),返回握手延迟。 */
  test(host: HostEntry): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const started = Date.now();
    return new Promise((resolve) => {
      const conn = new Client();
      const finish = (result: { ok: true; latencyMs: number } | { ok: false; error: string }): void => {
        try { conn.end(); } catch { /* 已断 */ }
        resolve(result);
      };
      conn.on('ready', () => finish({ ok: true, latencyMs: Date.now() - started }));
      conn.on('error', (error) => finish({ ok: false, error: messageOf(error) }));
      buildConnectConfig(host, this.resolveSecret(host.id))
        .then((cfg) => conn.connect(cfg))
        .catch((error) => finish({ ok: false, error: messageOf(error) }));
    });
  }

  /** 在主机上执行单条命令(走池内长连接)。 */
  exec(id: string, command: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      try { pooled.conn.end(); } catch { /* 已断 */ }
    }
  }

  closeAll(): void {
    for (const id of [...this.pool.keys()]) this.close(id);
  }
}
