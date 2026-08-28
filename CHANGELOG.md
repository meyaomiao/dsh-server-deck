# Changelog

## 0.1.0

- Card dashboard per connected host: status, OS, uptime, cores, latency, CPU / memory / disk meters.
- Click a card to open an xterm.js interactive terminal (WebSocket ↔ ssh2 shell).
- Import hosts from `~/.ssh/config` (skips wildcards and git-hosting aliases).
- Dual mount: dsh-better-sidebar tab, or a standalone collapsible right drawer.
- Loopback-only API and PTY routes; secrets in `~/.dsh/server-deck.secrets.json` (0600).
