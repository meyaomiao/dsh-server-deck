import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });

// 0) 生成 xterm.css 的 TS 字符串模块(client 运行时经 ensureStyles 注入,
//    ModuleLoader 包装只加载 JS,css 文件无法单独下发)。
const xtermCss = await readFile(
  new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url),
  'utf8',
);
const generated = `/** 由 scripts/build.mjs 从 @xterm/xterm/css/xterm.css 自动生成,勿手改。 */\nexport const XTERM_CSS = ${JSON.stringify(xtermCss)};\n`;
await writeFile(new URL('../src/client/xterm-css.generated.ts', import.meta.url), generated);

// 1) 服务端入口:host 台账 + ssh2 连接池 + REST + WS PTY 桥。
//    ssh2/ws 是 Node 侧 CommonJS 依赖,必须留给 Node 原生加载;否则 esbuild
//    会把它们包进 ESM 并生成运行时 require(),DSH loader 下无法启动。
//    cpu-features 与 *.node 原生绑定则继续 external,缺失时回退纯 JS。
const nativeExternal = {
  name: 'native-external',
  setup(builder) {
    builder.onResolve({ filter: /\.(node|feature)$/ }, (args) => ({ path: args.path, external: true }));
  },
};

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['ssh2', 'ws', 'cpu-features'],
  plugins: [nativeExternal],
});

// 2) 浏览器端:ModuleLoader 工厂包装(与 github-workbench / better-sidebar 同格式)。
//    react / react-dom / 平台模块不打包;xterm + fit addon 打包进 bundle。
//    注册 id 必须等于 package.json name:DSH Desktop 2.0.5 起会校验二者一致。
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  'var module = { exports: {} };',
  'var exports = module.exports;',
].join('\n');
const footer = '\nreturn module.exports;\n}});';

await build({
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react-dom/*', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
});

console.log('server-deck: lib/index.js + lib/client.js 构建完成');
