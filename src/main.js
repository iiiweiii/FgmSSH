/**
 * FgmSSH Tauri v2 - vite 入口 (index.html 的 <script type="module" src="/src/main.js">)
 * ============================================================
 * 职责:
 *   1. 把第三方库挂到 window 全局, 供原样复用的 src/renderer.js 使用:
 *        - @xterm/xterm + addon-fit + addon-web-links (renderer 用 new window.Terminal / FitAddon / WebLinksAddon)
 *        - mammoth (renderer 用 window.mammoth.convertToHtml)
 *   2. import nimbus-bridge: 定义 window.nimbus (与 Electron preload 暴露的 API 形状一一对应)
 *   3. import renderer.js: 原样复用 (顶部注册 DOMContentLoaded -> init, 内部自初始化)
 *
 * 加载顺序保障:
 *   - 6 个 UMD 纯逻辑模块 (fav-commands/gpu-chart/theme/file-filter/editor-highlight/
 *     health-parser) 以副作用 import 在本模块顶部执行, 挂好 window.FavCommands 等全局
 *     (原经典 script 写法 vite 无法打入 dist, 生产构建会 404, 详见下方 2.5 节);
 *   - 本模块 (module, 默认 deferred) 在其后执行, 此时 window 全局已就绪。
 */

// ---------- 1. xterm 全局挂载 ----------
// 官方样式必须随包引入 (含 viewport/screen 定位规则, 缺失会导致终端内容下移)
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// renderer.js 的兼容调用形态:
//   new window.Terminal({...})                     -> @xterm/xterm 的 Terminal
//   new window.FitAddon.FitAddon()                 -> addon-fit (命名空间对象, 兼容 UMD 挂法)
//   new window.WebLinksAddon.WebLinksAddon()       -> addon-web-links
window.Terminal = Terminal;
window.FitAddon = { FitAddon };
window.WebLinksAddon = { WebLinksAddon };

// ---------- 2. mammoth 全局挂载 ----------
// renderer.js 调用形态: await window.mammoth.convertToHtml({ arrayBuffer })
// 注意: mammoth 包的 main 指向 node CJS 版 (lib/index.js, 依赖 fs/path 等内置模块),
// 浏览器必须用包内自带的 browserify 产物 mammoth.browser.js (原 Electron 版即经典 script 引入);
// vite 经 esbuild 预打包做 UMD->ESM 互操作, 兜底取 .default 防多包一层。
import mammoth from 'mammoth/mammoth.browser.js';
window.mammoth = (mammoth && mammoth.default) ? mammoth.default : mammoth;

// ---------- 2.5 UMD 纯逻辑模块 (副作用导入, 修复生产构建 404) ----------
// 修复: 原 index.html 以经典 script 引用这些文件, vite 无法将其打入 dist (生产构建
// 下 404, window.FavCommands/HealthParser 等全局缺失导致应用崩溃)。改为副作用 import:
// UMD 包裹在 ESM 作用域下 module 未定义 -> 走 else 分支挂到 window (self=window)。
// 执行顺序在 renderer.js 导入之前, 与经典 script 语义一致。
import './fav-commands.js';
import './gpu-chart.js';
import './theme.js';
import './file-filter.js';
import './editor-highlight.js';
import './health-parser.js';

// ---------- 3. window.nimbus 桥接层 (核心适配) ----------
import './nimbus-bridge.js';

// ---------- 4. 原样复用 renderer.js ----------
// renderer.js 自身在文件末尾注册 window.addEventListener('DOMContentLoaded', init),
// 无需在此手动触发初始化。
import './renderer.js';
