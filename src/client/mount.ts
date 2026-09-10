/**
 * 三形态挂载(官方原生栏优先 → better-sidebar 页签 → 独立面板兜底):
 *
 * ⚠️ 平台事实(实测):cordis 对未声明 inject 的服务属性访问直接抛错
 * (`cannot get property ... without inject`),且各插件拿到的是兄弟上下文——
 * 「轮询探测 ctx.betterSidebar」永远失败(github-workbench 的旧方案即因此
 * 静默降级成抽屉)。因此这里改为:
 *   - 形态〇(DSH 0.1.5+):`ctx.inject(['sidebarRightTabs'])` 等官方原生
 *     右侧栏服务 → 注册 tab 类型(kind `server-deck`)+ `sidebar.right.pane.tab`
 *     / `.title` 座位挂内容体。参照 better-sidebar 0.19 的 native/index.ts:
 *     座位声明早于服务 provide,不能靠声明触发,必须等服务本身。
 *   - 形态一(旧宿主):外层插件无强制 inject,内层用
 *     `ctx.plugin({inject:['betterSidebar']})` 动态子插件,由 cordis 原生等待
 *     服务就绪(better-sidebar 未安装时该 fiber 永远 INACTIVE,静默无害)。
 *   - 形态二:宽限期内两种页签都未就绪 → 先开抽屉兜底,页签后到自动收掉。
 *
 * 双入口仲裁(防双入口):native 激活时若 sidebar 页签已挂则收掉;
 * sidebar 服务先到、native 服务后到时同样切到 native。native 座位消失
 * (仅 HMR/卸载)时置回 none,重载后恢复。
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ServerDeckApp } from './app.tsx';
import { loadPanelWidth, savePanelWidth } from './config.ts';
import { ensureStyles } from './styles.ts';

export const TAB_ID = 'server-deck:servers';

/** 官方原生右侧栏:本插件的实现 id(kind 的 openTab 名)。 */
const NATIVE_ID = 'dsh-server-deck';
const NATIVE_KIND = 'server-deck';

/** 内层子插件上下文的最小形状。 */
interface InnerCtx {
  betterSidebar: SidebarRegistryLike;
  effect(fn: () => (() => void) | void, label?: string): void;
}
interface PluginSpec {
  name?: string;
  inject?: string[];
  apply: (ctx: InnerCtx) => void;
}

/** 官方原生 tab 类型注册表(ctx.sidebarRightTabs)的最小形状。 */
interface NativeTabRegistry {
  register(definition: {
    id: string;
    kind: string;
    patterns?: readonly string[];
    priority?: 'extension' | 'builtin' | 'fallback';
    canOpen?: (address: string) => boolean;
    title: (address: string) => string;
    guide?: readonly { order: number; title: () => string; icon?: unknown }[];
  }): () => void;
}

/** 官方原生栏导航控制器(ctx.sidebarRight)的最小形状。 */
interface NativeSidebarRight {
  openTab(kind: string, options?: Record<string, unknown>): void;
}

/** 官方座位系统(ctx.slots)的最小形状。 */
interface SlotsLike {
  inject(name: string, fn: () => (() => void) | void): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

interface InjectedServices {
  get(name: 'sidebarRightTabs'): NativeTabRegistry | undefined;
  get(name: 'sidebarRight'): NativeSidebarRight | undefined;
}

interface MountCtx {
  plugin?: (spec: PluginSpec) => { dispose?: () => void } | void;
  inject?: (
    deps: readonly string[],
    fn: (ctx: InjectedServices) => (() => void) | void,
  ) => { dispose?: () => void };
  slots?: SlotsLike;
}

interface SidebarRegistryLike {
  registerTab(descriptor: Record<string, unknown>): () => void;
  openTab?(seed: Record<string, unknown>): void;
}

const GRACE_MS = 3_000;

/** 机架式服务器图标(双机箱+指示灯+槽位);currentColor 跟随宿主主题。 */
function serverIcon(size: number = 16): React.ReactNode {
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    'aria-hidden': true, style: { flex: 'none', display: 'block' },
  },
    createElement('rect', { x: 1.5, y: 2.2, width: 13, height: 4.9, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 }),
    createElement('rect', { x: 1.5, y: 8.9, width: 13, height: 4.9, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 }),
    createElement('circle', { cx: 4.6, cy: 4.65, r: 1, fill: 'currentColor' }),
    createElement('circle', { cx: 4.6, cy: 11.35, r: 1, fill: 'currentColor' }),
    createElement('path', { d: 'M7.5 4.65h4.3M7.5 11.35h4.3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
  );
}

/** 原生座位的内容体:框架注入 sessionId,这里恒可见(仅活动 pane 渲染)。 */
function NativeBody(): React.ReactNode {
  return createElement(ServerDeckApp, { visible: true });
}

/** 原生座位的标签标题:静态文案,忽略框架 props。 */
function NativeTitle(): React.ReactNode {
  return '服务器';
}

export function mountServerDeck(ctx: MountCtx): () => void {
  ensureStyles();

  // hash 自举:#sd-* 开头的深链在页签就绪后主动打开。供深链/截图/外部触发使用。
  const bootHash = typeof location !== 'undefined' && location.hash.startsWith('#sd-')
    ? location.hash
    : null;

  /** 当前挂载形态:'none' | 'native' | 'sidebar'。 */
  let form: 'none' | 'native' | 'sidebar' = 'none';
  let nativeDisposer: (() => void) | null = null;
  let tabDisposer: (() => void) | null = null;
  let drawerDisposer: (() => void) | null = null;
  let fiberDisposer: (() => void) | undefined;
  let seatDisposer: (() => void) | undefined;

  let nativeOpen: (() => void) | null = null;
  let sidebarOpen: (() => void) | null = null;

  /** 深链/外部触发的统一打开入口(按当前形态分派)。 */
  const openActiveTab = (): void => {
    if (form === 'native') nativeOpen?.();
    else if (form === 'sidebar') sidebarOpen?.();
  };

  const descriptor = {
    id: TAB_ID,
    title: () => '服务器',
    icon: serverIcon,
    order: 45,
    single: true,
    component: (props: { visible: boolean }) =>
      createElement(ServerDeckApp, { visible: props.visible }),
  };

  // ---------- 形态〇:官方原生右侧栏(DSH 0.1.5+) ----------

  if (typeof ctx.inject === 'function') {
    try {
      const seat = ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
        const tabs = injected.get('sidebarRightTabs');
        if (tabs === undefined || typeof tabs.register !== 'function') return;
        const sidebarRight = injected.get('sidebarRight');

        // 双入口仲裁:better-sidebar 页签已挂 → 收掉,切到原生。
        if (form === 'sidebar') {
          tabDisposer?.();
          tabDisposer = null;
        }
        form = 'native';

        // 阶段一:tab 类型(页面型,无 patterns;extension 优先级)。
        const disposeType = tabs.register({
          id: NATIVE_ID,
          kind: NATIVE_KIND,
          priority: 'extension',
          title: () => '服务器',
          guide: [{
            order: 45,
            title: () => '服务器',
            icon: (props: { size?: number }) => serverIcon(props.size ?? 16),
          }],
        });

        // 阶段二:内容体 + 标签标题座位(以实现 id 为 key)。
        const slots = ctx.slots;
        const disposeSlots: (() => void)[] = [];
        if (slots !== undefined) {
          disposeSlots.push(
            slots.inject('sidebar.right.pane.tab', () => slots.register({
              name: 'sidebar.right.pane.tab',
              key: NATIVE_ID,
              inject: (sessionId: string) => ({ sessionId }),
            }, NativeBody)),
            slots.inject('sidebar.right.pane.tab.title', () => slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: NATIVE_ID,
              inject: () => ({}),
            }, NativeTitle)),
          );
        } else {
          console.warn('[server-deck] ctx.slots 不可用,原生内容体未注册');
        }

        nativeOpen = (): void => {
          try { sidebarRight?.openTab(NATIVE_KIND); }
          catch (error) { console.warn('[server-deck] 原生 openTab 失败:', error); }
        };

        nativeDisposer = (): void => {
          for (const dispose of disposeSlots.reverse()) dispose();
          disposeType();
          nativeOpen = null;
          if (form === 'native') form = 'none';
        };

        if (bootHash !== null) nativeOpen();
        (globalThis as Record<string, unknown>).__serverDeck = { open: openActiveTab };

        // 原生页签已挂:独立抽屉若已兜底开启,收掉(宽度偏好已持久化)。
        if (drawerDisposer !== null) {
          drawerDisposer();
          drawerDisposer = null;
        }

        return nativeDisposer;
      });
      seatDisposer = typeof seat?.dispose === 'function' ? () => seat.dispose?.() : undefined;
    } catch (error) {
      console.warn('[server-deck] 原生右侧栏等待启动失败:', error);
    }
  }

  // ---------- 形态一:better-sidebar 页签(旧宿主回退) ----------

  if (typeof ctx.plugin === 'function') {
    try {
      const fiber = ctx.plugin({
        name: 'server-deck:sidebar-tab',
        inject: ['betterSidebar'],
        apply: (inner) => {
          inner.effect(() => {
            // 双入口仲裁:原生栏已激活 → 本形态静默让位。
            if (form === 'native') return () => undefined;
            try {
              tabDisposer = inner.betterSidebar.registerTab(descriptor) ?? null;
            } catch (error) {
              console.warn('[server-deck] registerTab 失败:', error);
              return;
            }
            form = 'sidebar';
            sidebarOpen = (): void => {
              try {
                // path 种子使本次成为内容型打开 → 面板自动展开
                inner.betterSidebar.openTab?.({ type: TAB_ID, path: '#auto', title: '服务器' });
              } catch (error) { console.warn('[server-deck] open 失败:', error); }
            };
            if (bootHash !== null) {
              try {
                inner.betterSidebar.openTab?.({ type: TAB_ID, path: '#boot', title: '服务器' });
              } catch (error) {
                console.warn('[server-deck] 深链打开页签失败:', error);
              }
            }
            (globalThis as Record<string, unknown>).__serverDeck = { open: openActiveTab };
            // 页签已挂:独立抽屉若已兜底开启,收掉(宽度偏好已持久化)
            if (drawerDisposer !== null) {
              drawerDisposer();
              drawerDisposer = null;
            }
            return () => {
              tabDisposer = null;
              sidebarOpen = null;
              if (form === 'sidebar') form = 'none';
            };
          }, 'server-deck: register tab');
        },
      });
      fiberDisposer = typeof fiber?.dispose === 'function' ? () => fiber.dispose?.() : undefined;
    } catch (error) {
      console.warn('[server-deck] 动态子插件启动失败:', error);
    }
  } else {
    console.warn('[server-deck] ctx.plugin 不可用,仅独立面板形态可用');
  }

  // ---------- 形态二:宽限期内无任何页签 → 独立右侧面板兜底 ----------

  const started = Date.now();
  const timer = setInterval(() => {
    if (form !== 'none' || drawerDisposer !== null) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - started > GRACE_MS) {
      clearInterval(timer);
      drawerDisposer = mountStandalone();
    }
  }, 250);

  return () => {
    clearInterval(timer);
    drawerDisposer?.();
    nativeDisposer?.();
    tabDisposer?.();
    seatDisposer?.();
    fiberDisposer?.();
  };
}

// ---------- 形态二:独立右侧面板 ----------

function mountStandalone(): () => void {
  const host = document.createElement('div');
  host.setAttribute('data-serverdeck-host', '');
  host.style.cssText = [
    'position:fixed', 'top:0', 'right:0', 'bottom:0', 'z-index:40',
    'display:flex', 'align-items:stretch', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(host);

  const width = loadPanelWidth();
  const panel = document.createElement('div');
  panel.style.cssText = [
    'pointer-events:auto', 'width:100%', 'height:100%', 'position:relative',
    'display:flex', 'flex-direction:column',
    'background:var(--dsw-alias-bg-layer-1,#16181d)',
    'border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))',
    'box-shadow:-12px 0 32px rgba(0,0,0,.22)',
    'color:var(--dsw-alias-label-primary,#e6edf3)',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  ].join(';');
  host.appendChild(panel);

  const inner = document.createElement('div');
  inner.style.cssText = 'flex:1;min-height:0;position:relative';
  panel.appendChild(inner);

  // 收起/展开开关(贴分隔线左缘)
  const toggle = document.createElement('button');
  toggle.title = '收起服务器面板';
  toggle.textContent = '›';
  toggle.style.cssText = [
    'position:absolute', 'left:-13px', 'top:50%', 'transform:translateY(-50%)', 'z-index:5',
    'width:26px', 'height:52px', 'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))',
    'border-radius:8px', 'background:var(--dsw-alias-bg-layer-2,#1c1f26)',
    'color:var(--dsw-alias-label-secondary,#9aa1ab)', 'cursor:pointer', 'font-size:14px', 'padding:0',
  ].join(';');
  panel.appendChild(toggle);

  // 右缘竖条(收起态显示)
  const edge = document.createElement('button');
  edge.textContent = '服务器';
  edge.title = '展开服务器面板';
  edge.style.cssText = [
    'position:fixed', 'right:0', 'top:50%', 'transform:translateY(-50%)', 'z-index:41',
    'writing-mode:vertical-rl', 'padding:16px 7px', 'letter-spacing:.18em', 'font-size:12px',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))', 'border-right:none',
    'border-radius:10px 0 0 10px', 'background:var(--dsw-alias-bg-layer-2,#1c1f26)',
    'color:var(--dsw-alias-label-secondary,#9aa1ab)', 'cursor:pointer', 'display:none', 'pointer-events:auto',
  ].join(';');
  document.body.appendChild(edge);

  // 拖缘调宽
  const resizer = document.createElement('div');
  resizer.style.cssText = [
    'position:absolute', 'left:-3px', 'top:0', 'bottom:0', 'width:6px',
    'cursor:col-resize', 'z-index:6', 'pointer-events:auto',
  ].join(';');
  panel.appendChild(resizer);

  let root: Root | null = createRoot(inner);
  let observer: IntersectionObserver | null = null;
  let visible = true;

  function render(): void {
    root?.render(createElement(ServerDeckApp, { visible }));
  }

  function setCollapsed(v: boolean): void {
    host.style.display = v ? 'none' : 'flex';
    edge.style.display = v ? 'inline-flex' : 'none';
  }
  toggle.addEventListener('click', () => setCollapsed(true));
  edge.addEventListener('click', () => setCollapsed(false));

  let dragStartX = 0;
  let startWidth = width;
  function onDown(e: PointerEvent): void {
    dragStartX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onMove(e: PointerEvent): void {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    const w = Math.min(760, Math.max(380, Math.round(startWidth + (dragStartX - e.clientX))));
    host.style.width = `${w}px`;
  }
  function onUp(e: PointerEvent): void {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    savePanelWidth(panel.getBoundingClientRect().width);
  }
  resizer.addEventListener('pointerdown', onDown);
  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onUp);

  // 可见性观察(等价 tab 形态的 visible 门控)
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      render();
    }, { threshold: 0 });
    observer.observe(panel);
  }

  host.style.width = `${width}px`;
  render();

  return () => {
    observer?.disconnect();
    root?.unmount();
    root = null;
    host.remove();
    edge.remove();
  };
}
