# Changelog

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
