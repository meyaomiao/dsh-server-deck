/**
 * server-deck 能力插件:服务器卡片仪表盘。
 *
 * 服务端(本文件):
 *   - /server-deck/api/*  主机台账 CRUD + 连通测试 + 全量状态探测(仅回环)
 *   - /server-deck/ws/pty 升级路由:xterm 终端 ↔ ssh2 shell 双向桥
 *
 * 客户端(lib/client.js):双形态挂载——ctx.betterSidebar 可用 → registerTab
 * 「服务器」页签;不可用 → 自绘右侧展开/收起面板(见 src/mount.ts)。
 */

import type {} from '@deepseek-ai/dsh-host-webserver';
import type { Context } from '@deepseek-ai/cordis';
import { HostPool } from './server/pool.ts';
import { createApiRouter } from './server/router.ts';
import { createPtyRoute } from './server/pty.ts';
import { HostStore } from './server/store.ts';

/** Cordis 插件名,loader 诊断使用。 */
const name = 'server-deck';

/** 本插件依赖的上下文服务:webServer 注册 HTTP 与 upgrade 路由。 */
const inject = ['webServer'];

/** Cordis 插件体。 */
export function apply(ctx: Context): void {
  const store = new HostStore();
  const pool = new HostPool(
    (id) => store.get(id),
    (id) => store.getSecret(id),
  );

  void store.load().catch((error) => {
    console.warn('[server-deck] 台账加载失败(将以空台账运行):', error);
  });
  ctx.effect(() => () => pool.closeAll(), 'server-deck: dispose connections');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/server-deck/api',
        handler: createApiRouter(store, pool),
      }),
    'server-deck: rest api',
  );

  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade(createPtyRoute(pool, (id) => store.get(id) !== undefined)),
    'server-deck: pty upgrade route',
  );
}

export { inject, name };
