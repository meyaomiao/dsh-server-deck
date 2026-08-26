/**
 * server-deck 共享类型(host / client 两半都用)。
 */

/** 认证方式。 */
export type AuthKind = 'password' | 'key' | 'agent';

/** 台账中的一台服务器(公开字段;密码/口令绝不在此结构中落盘或回传)。 */
export interface HostEntry {
  id: string;
  /** 展示名,如「生产网关」。 */
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthKind;
  /** auth='key' 时的私钥路径(只存路径引用,不存私钥内容)。 */
  keyPath?: string;
  tags?: string[];
  notes?: string;
  createdAt: string;
}

/** 客户端提交的主机表单(可含秘密字段,服务端剥离后写入 secrets 文件)。 */
export interface HostInput {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  auth?: unknown;
  keyPath?: unknown;
  tags?: unknown;
  notes?: unknown;
  password?: unknown;
  passphrase?: unknown;
}

/** 一台服务器的实时状态快照。 */
export interface HostStatus {
  id: string;
  state: 'unknown' | 'probing' | 'online' | 'offline';
  latencyMs?: number;
  error?: string;
  osName?: string;
  kernelOrUptime?: string;
  uptimeText?: string;
  cores?: number;
  cpuPercent?: number;
  memPercent?: number;
  diskPercent?: number;
  probedAt?: string;
}
