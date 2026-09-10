/**
 * 浏览器端入口:三形态挂载(官方原生栏优先 → better-sidebar 页签 → 独立右侧面板兜底)。
 *
 * - `slots` 是官方原生右侧栏座位注册(`sidebar.right.pane.tab`)的前提,
 *   web 平台核心服务,恒存在;
 * - `betterSidebar` 不进模块级 inject——本插件要在「未安装 better-sidebar」
 *   的场景下装载,该形态经 mountServerDeck 内的动态子插件等待;
 * - `sidebarRightTabs` / `sidebarRight`(DSH 0.1.5+)同样经 mountServerDeck
 *   内的 `ctx.inject([...])` 运行时等待,缺席时静默回退旧形态。
 *   卸载/HMR 经 ctx.effect 级联清理。
 */

import type { Context } from '@deepseek-ai/cordis';
import { mountServerDeck } from './client/mount.ts';

/** Cordis 插件名,loader 诊断使用。 */
const name = 'server-deck';

/** 客户端强制前置:官方座位系统(原生右侧栏内容体注册需要)。 */
const inject = ['slots'];

/** 客户端插件体。 */
export function apply(ctx: Context): void {
  ctx.effect(() => mountServerDeck(ctx as unknown as Parameters<typeof mountServerDeck>[0]), 'server-deck: dual-mode mount');
}

export { inject, name };
