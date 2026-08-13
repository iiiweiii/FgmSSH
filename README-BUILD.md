# FgmSSH Tauri v2 — 构建文档

本工程由工程保障团队按 `SPEC.md` 生成，将 Electron 版 FgmSSH 前端（`window.nimbus.*` API）
原样迁移到 Tauri v2。**尚未编译验证**：首次构建若遇 russh / windows crate API 差异，
按代码中 `TODO(verify)` 注释修正。

## 目录结构

```
fmgssh-tauri/
├── package.json          # 前端依赖 + vite/tauri cli
├── vite.config.js        # vite 配置 (port 1420, target chrome105)
├── index.html            # 入口 HTML (保留原 CSP)
├── src/
│   ├── main.js           # vite 入口: 挂 xterm/mammoth 全局 -> import bridge + renderer
│   ├── nimbus-bridge.js  # ★ window.nimbus -> Tauri invoke/listen 桥接层
│   ├── renderer.js       # 原样复用 Electron 版 (仅 pdfjs 导入路径适配)
│   └── style.css / theme.js / health-parser.js / editor-highlight.js
│       / file-filter.js / fav-commands.js / gpu-chart.js
└── src-tauri/            # Rust 侧 (backend-core/backend-ext 交付)
```

## 前置条件

- **Rust stable** + **MSVC Build Tools**（`rustup` 安装，Windows 目标 `x86_64-pc-windows-msvc`）
  - Tauri v2 依赖 WebView2 Runtime（Win10/11 通常已内置）
- **Node.js 18+**（本机实测 22 可用），npm 10+
- 无网络代理问题：`cargo` 拉取 crates、`npm` 拉取包均需联网

## 安装与运行

```bash
# 1. 安装前端依赖 (生成 package-lock.json)
npm install

# 2. 开发模式: 启动 vite(1420) + tauri(编译 Rust + 打开窗口)
npm run tauri dev

# 3. 生产构建 (输出 src-tauri/target/release/FgmSSH.exe)
npm run tauri build

# 仅构建前端产物 (不编译 Rust, 供排查 vite 侧问题)
npm run build          # -> dist/
```

> `npm run tauri dev` 等价于 `npx tauri dev`（`npm run tauri` 透传给 @tauri-apps/cli）。
> `tauri dev` 会先 `vite build` 出 `dist/` 再编译 Rust —— 实际 Tauri 模板中 dev 模式
> 由 vite dev server 提供页面；如遇异常，可确认 `src-tauri/tauri.conf.json` 的
> `build.devUrl = "http://localhost:1420"`、`build.frontendDist = "../dist"`。

## 前端加载链路（适配说明）

1. `index.html` 的 CSP meta 在 Electron 版基础上补齐 Tauri v2 IPC 所需源：
   `script-src 'self' blob:`、`connect-src 'self' ipc: http://ipc.localhost nimbus-preview: nimbus-doc: blob: data:`、
   `worker-src 'self' blob:`、`img-src 'self' nimbus-preview: blob: data:`（均无 `unsafe-eval`）。
2. 5 个 UMD 纯逻辑模块（fav-commands / gpu-chart / theme / file-filter / editor-highlight）
   以**经典 script** 顺序加载，挂 `window.FavCommands` 等全局（与 Electron 版一致）。
3. `src/main.js`（module script）：
   - `import '@xterm/xterm/css/xterm.css'`（xterm 定位规则必须存在）
   - 挂 `window.Terminal / FitAddon / WebLinksAddon / mammoth`
   - `import './nimbus-bridge.js'`（定义 `window.nimbus`）
   - `import './renderer.js'`（原样复用，自身在 `DOMContentLoaded` 触发 `init`）
4. `window.nimbus.*` 全部映射到 `SPEC.md` 第 2 节的 Tauri Command；事件经 `listen` 转发到
   `on*` 回调表（`on*` 返回取消函数）。

## 开发模式（CSP 注意事项）

- **生产构建**保持严格 CSP（`script-src 'self'`），与 Electron 版一致。
- **vite dev** 下若 CSP 阻断 HMR / 源码映射（典型报错：`Refused to execute inline script` /
  `Refused to evaluate a string as JavaScript`），二选一：
  1. 在 vite dev 临时把 CSP 中的 `script-src 'self'` 放宽为 `script-src 'self' 'unsafe-eval'`
     （仅 dev 用，改完记得还原）；或
  2. 走 `npm run build` 后用 Tauri 加载生产产物（严格 CSP 全量生效）。
- 已知取舍：拖拽文件上传在 Tauri 下**不支持**（前端无法取得拖拽 File 的真实磁盘路径，
  `webUtils.getPathForFile` 为 Electron 专属）。行为：拖到 SFTP 面板会提示
  「无法获取拖拽文件路径」，请改用面板的「上传文件」对话框。详见 `src/nimbus-bridge.js`
  的 `sftpRegisterUploadPaths` 注释。

## 后端依赖约定（请 backend 侧对齐）

- **CSP 协调（重要）**：Tauri 会把 `src-tauri/tauri.conf.json` 的 `app.security.csp` 与
  `index.html` 的 meta CSP **同时生效（取交集）**。当前已**采用「csp: null」方案**（见
  `src-tauri/tauri.conf.json` 的 `app.security.csp: null`）—— 完全交由 `index.html` meta
  CSP 单一管理，可避免交集拦掉 `nimbus-preview:` / `nimbus-doc:` 自定义协议。
  若需恢复后端 CSP 单一源管理，请确保后端 `app.security.csp.connect-src` 与
  `img-src` 至少包含 `nimbus-preview: nimbus-doc:` 与 `blob: data: ipc: http://ipc.localhost`。
- `index.html` 保留自定义协议 `nimbus-preview://` / `nimbus-doc://`（CSP 已放行）；
  Rust 侧需用 `app.register_uri_scheme_protocol`（或等价机制）注册这两个 scheme，
  并返回对应临时目录文件内容（参考 Electron `main.js` 的 `protocol.handle('nimbus-preview'|'nimbus-doc')`）。
- `dialog_select_save_path` 命令参数名为 `defaultName`；其余命令参数名见
  `src/nimbus-bridge.js` 中 `guardedInvoke` 的键（camelCase，与 `SPEC.md` 第 2 节一致）。
- `ssh:event` payload 需包含 `{ sessionId, type, ...rest }`（renderer 依赖 `type` 分支：
  `ready / error / reconnect-status / closed / tunnel / tunnel-error / tunnel-stopped /
  sftp-download-progress / sftp-upload-progress`）；若后端把 sftp 进度发成独立 Tauri 事件
  `sftp-upload-progress` / `sftp-download-progress`，bridge 已做归一化转发到 `onEvent`。

## TODO(verify) 重点复核点

- `src/nimbus-bridge.js`：
  - `checkAgent` 为占位桩（SPEC 未定义 `ssh_choose_ssh_agent`），renderer 未调用，可忽略或后端补实现；
  - `getPathForFile` 恒返回 `''`（拖拽降级方案）。
- `src/renderer.js`（相对 Electron 版的唯二改动）：
  - pdfjs 动态导入改为包标识符 `import('pdfjs-dist/build/pdf.min.mjs')`；
  - pdfjs worker URL 改从 `window.__PDFJS_WORKER_URL__` 读取（由 bridge 经 vite `?url` 资产导入暴露）。
- 首次 `cargo build` 若 russh / windows crate 的 API 签名与注释不符，按 `TODO(verify)` 修正。
