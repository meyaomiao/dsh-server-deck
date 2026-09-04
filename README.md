# DSH Server Deck 🖧

**DeepSeek Harness 的服务器卡片仪表盘** —— 已连接服务器的卡片视图(在线状态 / CPU / 内存 / 磁盘 / 延迟),点卡片进入 xterm.js 交互终端;独立趋势视图记录并可视化一段时间的 CPU / 内存 / 磁盘变化。

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-server-deck)](https://www.npmjs.com/package/dsh-server-deck)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

<p align="center">
  <img src="docs/screenshots/dashboard.png" width="420" alt="服务器卡片仪表盘">
</p>

## ✨ 功能一览

### 卡片式服务器仪表盘
每台服务器一张卡,**状态一目了然**:

| 元素 | 说明 |
|---|---|
| 🟢🟡🔴⚪ 状态点 | 在线(带呼吸光晕)/ 离线 / 探测中 / 未知 |
| 系统信息行 | OS 名称(Linux PRETTY_NAME / macOS 回退)、运行时长、核数、握手延迟 |
| 三条用量条 | CPU · 内存 · 磁盘,<60% 绿 / ≥60% 黄 / ≥85% 红 |
| 错误详情 | 离线时内联展示失败原因(悬停看全文) |

自动刷新周期可选 **手动 / 10s / 15s / 30s / 60s**(读主机侧快照,不再现场 SSH);「刷新」按钮强制立即探测一轮。

### 📈 趋势视图
卡片与趋势两个独立视图互相切换(不是叠在卡片里)。每台主机 **CPU / 内存 / 磁盘各一张独立图**(不叠线):

| 项 | 说明 |
|---|---|
| 窗口 | 1 小时(滚动,默认)/ 24 小时(滚动)/ 一周 / 一个月(本地自然日 0 点起,含今天)/ 自定义(≤31 天) |
| 粒度 | 自动 / 10s / 30s / 1m / 5m / 15m / 1h;单次查询上限 1200 点,超限自动升档 |
| 摘要 | 最新值 + 窗口均值;悬停竖线读该时刻数值,tooltip 含最高 / 最低 / 样本数 |
| 采集 | 主机侧常驻,默认 10s(可选 30s / 1m / 5m),与面板是否打开无关;离线也记一条用于画断档 |
| 落盘 | `~/.dsh/server-deck-metrics/{hostId}/`:raw 3h、1m 24h、15m 7d、1h 31d;删除主机级联清理 |
| 历史回填 | 窗口早于本地记录时,尝试 `sar -u` / `sar -r`(sysstat)回填 CPU / 内存;磁盘容量无法回填 |

打开「服务器」页签 → 点工具栏「📈 趋势」。窗口默认 1 小时滚动;「24 小时」也是滚动过去 24 小时,不是当天 0 点起。刚启用时图上可能只有右侧一小段,等几个采集周期就会铺开。

<p align="center">
  <img src="docs/screenshots/trend.png" width="420" alt="趋势视图:每机三张独立 CPU / 内存 / 磁盘图">
</p>

### ⌨ 点卡片进交互终端
xterm.js 全功能终端:5000 行回滚、256 色、窗口尺寸实时同步、光标闪烁。Node 半区做 WebSocket ↔ ssh2 shell 双向桥。

<p align="center">
  <img src="docs/screenshots/terminal.png" width="420" alt="交互终端">
</p>

### ⤓ 一键导入 `~/.ssh/config`
解析标准 ssh config(Host / HostName / User / Port / IdentityFile / ProxyJump),自动:
- 跳过通配条目(`Host *`)与已存在主机;
- **跳过 Git 托管平台密钥别名**(如 `Host github.com-xxx` / `User git`——它们不是可管理的服务器);
- 多别名行(`Host 1.2.3.4 prod-gw`)优先取语义化别名做展示名。

### ＋ 手动添加主机
密码 / 私钥文件(+口令)/ SSH Agent 三种认证;连接测试按钮即时反馈延迟。

<p align="center">
  <img src="docs/screenshots/add-host.png" width="420" alt="添加服务器表单">
</p>

## 🔀 双形态挂载

| 环境 | 形态 |
|---|---|
| 安装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 注册为侧边栏「🖥 服务器」页签(order 45),原生 tab chrome、设置页开关、visible 门控轮询 |
| 未安装 | 自绘右侧可展开/收起面板:右缘竖条开关 + 拖缘调宽,宽度持久化 |

装载顺序无关:client 入口不声明强制依赖,由内层动态子插件等待服务就绪后注册页签并自动收起独立面板。

## 📦 安装

```bash
# 方式〇:npm 安装(推荐)
dsh plugin --profile web add dsh-server-deck

# 方式一:从 GitHub 直接装(dsh CLI,免 npm)
dsh plugin --profile web add github:meyaomiao/dsh-server-deck

# 方式二:克隆后本地挂载
git clone https://github.com/meyaomiao/dsh-server-deck.git
cd dsh-server-deck && pnpm install && pnpm build
dsh plugin --profile web add .
```

安装后**重启 `dsh web`**(host 半新增了路由与常驻采集器),浏览器 Ctrl+F5 强刷。侧边栏「+」菜单出现「服务器」页签即成功。

## 🔐 安全模型

- 所有 API 与 PTY 升级路由**仅回环放行**(127.0.0.1/::1),防 DNS rebinding 与局域网直连;
- 密码 / 私钥口令单独存放 `~/.dsh/server-deck.secrets.json`(0600),台账文件不含秘密,**API 响应永不回传**;
- 删除主机仅移出台账并断开连接池,不会在远端执行任何操作;
- 指标采集通过一段只读 POSIX sh 探针脚本(`top`/`free`/`df`/`uptime`,Linux 与 macOS 宽容双兼容),解析失败的字段显示「—」。

## 🏗️ 架构

```
┌─ Client(lib/client.js)──────────────────┐   ┌─ Host(lib/index.js)─────────────────────┐
│ better-sidebar 页签 ⇄ 独立抽屉 双形态     │◄──│ /server-deck/api/*  REST(仅回环)         │
│ React 卡片网格 / 趋势图 / 表单 / xterm.js │WS▶│ /server-deck/ws/pty ws↔ssh2 PTY 桥      │
└─────────────────────────────────────────┘   │ ssh2 连接池 · 台账 ~/.dsh/*.json         │
                                              │ MetricRecorder 常驻采集(默认 10s)        │
                                              └─────────────────────────────────────────┘
```

## 🛠️ 开发

```bash
pnpm install
pnpm build       # esbuild:server bundle + client bundle(ModuleLoader 包装)
pnpm typecheck   # tsc --noEmit
pnpm test        # ssh config / 探针解析 / 台账校验 / 窗口粒度 / sar 回填 / 时序落盘
```

## 📋 兼容性

- DeepSeek Harness `0.1.1-rc.2` 与 `0.1.2-alpha.4`(web profile)
- DSH `0.1.2-alpha.1` 起已删除 `@deepseek-ai/dsh-client-runtime`;本包从 0.1.1 起不再把它写进 `dsh.client.inject`
- dsh-better-sidebar **可选**(未装时走独立抽屉形态);升 alpha.4 时侧栏请用 `dsh-better-sidebar@alpha`
- Node ≥ 20;被管理服务器只需开放 SSH(无需预装任何东西)。趋势回填依赖远端 `sar`(sysstat),未装则静默跳过。

改仓库前先读 [CONTRIBUTING.md](./CONTRIBUTING.md)（Issue → 分支 → Draft PR）。思考原则见 [AI-ISSUE-WORKFLOW.md](./AI-ISSUE-WORKFLOW.md)。

## License

[MIT](LICENSE)
