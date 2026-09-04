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

/** 趋势时间窗口。1h/24h 为滚动窗口;7d/30d 按本地自然日对齐。 */
export type MetricRangeKind = '1h' | '24h' | '7d' | '30d' | 'custom';

/** 趋势展示粒度。10s 配合 10s 探针,受单次查询 1200 点上限约束。 */
export type MetricBucket = '10s' | '30s' | '1m' | '5m' | '15m' | '1h';

/** 一次采集样本(落盘 JSONL 一行)。 */
export interface MetricSample {
  t: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  latencyMs?: number;
  online: boolean;
}

/** 对齐到 bucket 后的一个点;空桶不出现,图上断开。 */
export interface MetricPoint {
  t: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  latencyMs?: number;
  online: boolean;
}

/** 某一指标在窗口内的摘要(仅统计 online 且该字段有值的样本)。 */
export interface MetricFieldSummary {
  latest?: number;
  avg?: number;
  max?: number;
  min?: number;
  samples: number;
}

/** 一台主机在某窗口内的序列。 */
export interface HostMetricSeries {
  hostId: string;
  from: number;
  to: number;
  bucket: MetricBucket;
  bucketUsed: MetricBucket;
  points: MetricPoint[];
  cpu: MetricFieldSummary;
  mem: MetricFieldSummary;
  disk: MetricFieldSummary;
}

/** 采集设置(主机侧常驻)。 */
export interface MetricsSettings {
  /** 默认 10(10s 探针);可选 10/30/60/300。 */
  collectIntervalSec: 10 | 30 | 60 | 300;
  recording: boolean;
  pausedHostIds: string[];
}
