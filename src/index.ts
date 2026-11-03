/**
 * server-deck 能力插件:服务器卡片仪表盘。
 *
 * 服务端(本文件):
 *   - /server-deck/api/*  主机台账 CRUD + 连通测试 + 状态快照 + 趋势查询(仅回环)
 *   - /server-deck/ws/pty 升级路由:xterm 终端 ↔ ssh2 shell 双向桥
 *   - MetricRecorder 常驻采集(默认 10s),与前端是否打开面板无关
 *   - SarBackfill:本地序列未覆盖的窗口,从服务器 sysstat(sar)回填历史
 *   - server_deck_hosts / server_deck_exec:对话里对台账主机非交互 SSH 下发(不走卡片 xterm)
 *
 * 客户端(lib/client.js):双形态挂载——ctx.betterSidebar 可用 → registerTab
 * 「服务器」页签;不可用 → 自绘右侧展开/收起面板(见 src/mount.ts)。
 */

import type {} from '@deepseek-ai/dsh-host-webserver';
import type { Context } from '@deepseek-ai/cordis';
import { HostPool } from './server/pool.ts';
import { createApiRouter } from './server/router.ts';
import { createPtyRoute } from './server/pty.ts';
import type { RequestConnection } from './server/auth.ts';
import { HostStore } from './server/store.ts';
import { MetricStore } from './server/metric-store.ts';
import { MetricRecorder } from './server/recorder.ts';
import { SarBackfill } from './server/backfill.ts';
import { registerExecTools } from './server/exec-tools.ts';

/** Cordis 插件名,loader 诊断使用。 */
const name = 'server-deck';

/** webServer 注册路由;connection 复用宿主准入;tools / systemPrompt 注册对话下发。 */
const inject = ['webServer', 'connection', 'tools', 'systemPrompt'];

/** Cordis 插件体。 */
export function apply(ctx: Context): void {
  let connection: RequestConnection | undefined;
  // Old hosts may lack the service/API; routes still fail closed in that case.
  try { connection = (ctx as unknown as { connection?: RequestConnection }).connection; } catch { /* unavailable */ }
  const store = new HostStore();
  const metrics = new MetricStore();
  const pool = new HostPool(
    (id) => store.get(id),
    (id) => store.getSecret(id),
  );
  const recorder = new MetricRecorder(store, pool, metrics);
  const backfill = new SarBackfill(pool, metrics);
  let disposed = false;

  void (async () => {
    try {
      await store.load();
    } catch (error) {
      console.warn('[server-deck] 台账加载失败(将以空台账运行):', error);
    }
    try {
      await metrics.load();
    } catch (error) {
      console.warn('[server-deck] 指标库加载失败(将以空序列运行):', error);
    }
    if (!disposed) recorder.start();
  })();

  ctx.effect(() => () => {
    disposed = true;
    recorder.stop();
    pool.closeAll();
  }, 'server-deck: dispose connections');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/server-deck/api',
        handler: createApiRouter(store, pool, metrics, recorder, backfill, connection),
      }),
    'server-deck: rest api',
  );

  ctx.effect(() => {
    const route = createPtyRoute(pool, (id) => store.get(id) !== undefined, connection);
    const unregister = ctx.webServer.registerUpgrade(route);
    return () => {
      unregister();
      route.dispose();
    };
  }, 'server-deck: pty upgrade route');

  registerExecTools(ctx as Parameters<typeof registerExecTools>[0], store, pool, recorder);
}

export { inject, name };
