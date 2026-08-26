/**
 * 浏览器端入口:双形态挂载(tab 优先,独立右侧面板兜底)。
 *
 * 不把 `betterSidebar` 声明进模块级 inject——本插件要在「未安装
 * better-sidebar」的独立场景下也能装载(自绘右侧面板);装载顺序由
 * mountServerDeck 内部处理(即时探测 + 3s 宽限轮询)。卸载/HMR 经
 * ctx.effect 级联清理。
 */

import type { Context } from '@deepseek-ai/cordis';
import { mountServerDeck } from './client/mount.ts';

/** Cordis 插件名,loader 诊断使用。 */
const name = 'server-deck';

/** 本插件在 client 侧无强制前置服务(双形态自动协商)。 */
const inject: string[] = [];

/** 客户端插件体。 */
export function apply(ctx: Context): void {
  ctx.effect(() => mountServerDeck(ctx as unknown as Parameters<typeof mountServerDeck>[0]), 'server-deck: dual-mode mount');
}

export { inject, name };
