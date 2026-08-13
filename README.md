# FgmSSH

现代化界面的 Windows SSH 客户端：终端 + SFTP 文件管理 + 服务器监控（GPU/CPU/内存/磁盘）、断线重连、断点续传、凭据加密（DPAPI）、主机密钥 TOFU 校验、审计日志、浅色/深色主题。

## 技术栈（v2）

- **Tauri v2**（Rust + WebView2）：便携单文件约 **8–15MB**（原 Electron 版 ~80MB）
- 前端：xterm.js + 原生 HTML/JS（无框架）
- SSH 协议：russh（纯 Rust）

## 构建

前置：Rust stable + MSVC Build Tools、Node 18+

```bash
npm install
npm run tauri dev    # 开发
npm run tauri build  # 打包（产物在 src-tauri/target/release/bundle/）
```

详见 [README-BUILD.md](README-BUILD.md) 与 [SPEC.md](SPEC.md)（IPC 契约）。

## 历史版本

- **v1.1.0-electron**（tag）：旧 Electron 版（Windows 便携，~80MB），存档于 `v1.1.0-electron`。
- 本仓库 master 已迁移至 Tauri v2；Electron 版代码可在 tag 中查看或 checkout 恢复。

> 状态：Tauri 版源码已交付，待本机构建验证（代码含 `// TODO(verify)` 标注点）。
