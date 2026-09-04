# Changelog

## 0.2.0

- 独立「趋势」视图与卡片视图切换:每台主机 CPU / 内存 / 磁盘三张独立 SVG 趋势图,展示最新值与窗口均值(悬停看最高 / 最低 / 样本数)。
- 时间窗口:1 小时(滚动,默认)/ 24 小时(滚动)/ 一周 / 一个月(按本地自然日 0 点对齐,含今天)/ 自定义(≤31 天)。
- 展示粒度:自动 / 10s / 30s / 1m / 5m / 15m / 1h;单次查询上限 1200 点,超限自动升档。
- 主机侧常驻采集(默认 10s,可选 30s / 1m / 5m),与面板是否打开无关;离线也记一条用于画断档。
- 时序落盘 `~/.dsh/server-deck-metrics/{hostId}/`(raw 3h / 1m 24h / 15m 7d / 1h 31d);删除主机级联清理。
- 查询窗口早于本地记录时,自动从服务器 sysstat(`sar -u` / `sar -r`)回填历史 CPU / 内存(限频 10 分钟;磁盘容量无法回填)。
- `GET /status` 改为读采集快照;`?force=1` 才立即探测;趋势图 hover 竖线 + 悬浮数值卡。

## 0.1.1

- Compatible with DeepSeek Harness `0.1.2-alpha.4` (also `0.1.1-rc.2`).
- Drop `@deepseek-ai/dsh-client-runtime` from `dsh.client.inject` — that package was removed in DSH 0.1.2-alpha.1. Client still dual-mounts via nested `betterSidebar` fiber.
- Peer `@deepseek-ai/dsh-host-webserver` is now `0.1.1-rc.2 || >=0.1.2-alpha.2` so npm semver accepts the alpha line.

## 0.1.0

- Card dashboard per connected host: status, OS, uptime, cores, latency, CPU / memory / disk meters.
- Click a card to open an xterm.js interactive terminal (WebSocket ↔ ssh2 shell).
- Import hosts from `~/.ssh/config` (skips wildcards and git-hosting aliases).
- Dual mount: dsh-better-sidebar tab, or a standalone collapsible right drawer.
- Loopback-only API and PTY routes; secrets in `~/.dsh/server-deck.secrets.json` (0600).
