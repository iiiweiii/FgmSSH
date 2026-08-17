# FgmSSH

现代化界面的 Windows SSH 客户端：终端、SFTP 文件管理、服务器监控、端口转发与安全的凭据管理。基于 **Tauri v2** 重构，相比旧 Electron 版显著减小体积；`v1.2.7` 的 NSIS 安装包约为 5 MB。

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-dea584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#开源许可)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)]()
[![Build & Release](https://github.com/iiiweiii/FgmSSH/actions/workflows/build.yml/badge.svg)](https://github.com/iiiweiii/FgmSSH/actions/workflows/build.yml)

> **当前版本：v1.2.7**。Tauri v2 版已完成 Windows CI 构建验证并产出 NSIS 安装包。
> 推送 `v*` tag 会触发 GitHub Actions 自动构建与上传 Release 草稿；经发布者核验后再公开发布。

## 特性

- **SSH 终端**：基于 [xterm.js](https://xtermjs.org/) 5.5，多会话标签页；断线自动重连（指数退避 1–32s，默认开启，可配置最大尝试次数）
- **SFTP 文件管理**：上传 / 下载 / 断点续传；文件夹整包 zip 下载；远端 `find` 递归搜索；目录同步（终端 `cd` 联动）
- **服务器监控**：GPU / CPU / 内存 / 磁盘等指标（5s 自动刷新，GPU 利用率与显存占用折线图）
- **端口转发隧道**：本地端口 → 远端服务的转发（**仅绑定 127.0.0.1**）
- **内置预览**：图片（jpg/png/gif/webp/svg）、PDF、DOCX 在线预览
- **内置文本编辑**：文本类文件内置编辑器，语法高亮，可保存回远端
- **配置加密导出 / 导入**：AES-256-GCM + scrypt 口令加密备份（`.fgm`）
- **常用命令收藏**：本地收藏常用命令，一键发送；支持 `{{变量}}` 模板，在发送前临时输入参数
- **连接效率功能**：连接置顶（仅保存在本机 UI 偏好中）、`Ctrl+K` 快速搜索连接、`Ctrl+Shift+F` 打开命令收藏
- **浅色 / 深色主题**：全局主题切换
- **更新检查**：通过 GitHub Releases 检查新版本，仅提示、不自动下载 / 升级

## 安全特性

FgmSSH 将安全作为一等公民，以下是本项目的重点设计：

- **凭据加密落盘（DPAPI）**：密码 / 私钥口令使用 Windows DPAPI 加密（`enc:v1:` 格式）；**fail-closed** —— 加密不可用或失败时拒绝写入，绝不落明文
- **主机密钥 TOFU 校验**：首次连接校验主机指纹（`known_hosts` 三态：trusted / unknown / mismatch）；unknown 弹窗确认，mismatch 危险警告（可能中间人攻击）；确认等待 **60s 超时默认拒绝**
- **审计日志**：JSONL 按天滚动，字段白名单 + 内容脱敏（私钥块 / JWT / 长 base64 / `user:pass@` 等）
- **配置脱敏视图**：`store_load` 仅向前端返回脱敏视图（密码字段置空 + `hasPassword` 标记），凭据仅在主进程内解密
- **本地文件访问控制**：SFTP 上传 / 下载的本地路径须经对话框登记（`approved_local_paths`，消费即移除），未登记一律拒绝
- **命令注入防护**：监控命令为编译期常量；SFTP 搜索关键字白名单 `[A-Za-z0-9_.-]` + 深度钳制 + 单引号转义
- **严格 CSP**：`script-src 'self'`（无 `unsafe-eval`），PDF worker 走 blob 白名单
- **openExternal 白名单**：仅放行 `http://` / `https://`
- **隧道仅绑本机回环**：端口转发只监听 `127.0.0.1`，绝不监听 `0.0.0.0`

## 截图

界面包含终端工作区、SFTP 侧栏、连接抽屉、健康监控和主机密钥确认弹窗。欢迎提交截图或使用体验反馈。

## 快速开始

### 直接下载

从 [GitHub Releases](https://github.com/iiiweiii/FgmSSH/releases) 下载最新已公开发布的 Windows NSIS 安装包（文件名形如 `FgmSSH_<版本>_x64-setup.exe`）。

> Release 在构建完成后会先以草稿形式创建；请仅从已公开发布的版本下载。


### 从源码构建

前置依赖：

- **Node.js 18+**（npm 10+）
- **Rust stable**（`rustup`，Windows 目标 `x86_64-pc-windows-msvc`）
- **MSVC Build Tools**（Visual Studio Build Tools 的 C++ 工具链）
- **WebView2 Runtime**（Windows 10/11 通常已内置）

```bash
npm install
npm run tauri dev      # 开发模式（启动 vite + 编译 Rust + 打开窗口）
npm run tauri build    # 生产构建（产物在 src-tauri/target/release/bundle/）
```

> 更详细的构建与迁移说明见 [README-BUILD.md](README-BUILD.md)；IPC 契约见 [SPEC.md](SPEC.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面框架 | [Tauri v2](https://v2.tauri.app)（Rust + WebView2） |
| 后端 | Rust：russh 0.44 / russh-sftp 2.0.0-beta.2 / tokio / futures |
| 终端 | xterm.js 5.5（+ fit / web-links 插件） |
| 前端 | 原生 HTML / JavaScript + Vite 5（无前端框架） |
| 文档预览 | PDF.js（pdfjs-dist）+ Mammoth（DOCX） |
| 凭据 / 加密 | Windows DPAPI、AES-256-GCM（aes-gcm）、scrypt |

## 项目结构

```
fmgssh-tauri/
├── package.json              # 前端依赖 + vite / tauri cli
├── vite.config.js            # vite 配置（port 1420，target chrome105）
├── index.html                # 入口 HTML（保留严格 CSP）
├── src/                      # 前端
│   ├── main.js               # vite 入口（挂 xterm / mammoth 全局）
│   ├── nimbus-bridge.js      # window.nimbus → Tauri IPC 桥接层
│   ├── renderer.js           # 主渲染逻辑（复用 Electron 版）
│   └── theme.js / health-parser.js / editor-highlight.js
│       / file-filter.js / fav-commands.js / gpu-chart.js
└── src-tauri/                # Rust 侧
    ├── Cargo.toml / tauri.conf.json / capabilities/default.json
    └── src/
        ├── lib.rs            # 全部命令注册 + 自定义 URI 协议（预览/文档）
        ├── ssh.rs            # SSH 连接 / 终端 / TOFU / 断线重连（russh）
        ├── hostkey.rs        # known_hosts 指纹库（三态判定）
        ├── credential.rs     # DPAPI 凭据加密（enc:v1:，fail-closed）
        ├── store.rs          # connections.json / settings.json 持久化
        ├── audit.rs          # 审计 JSONL（白名单 + 脱敏）
        ├── sftp.rs           # SFTP 全家桶（断点续传 / zip / 搜索）
        ├── tunnel.rs         # 端口转发（仅 127.0.0.1）
        ├── monitor.rs        # 服务器监控（编译期常量命令表）
        ├── preview_doc.rs    # 图片 / PDF / DOCX 预览与文本编辑
        ├── portable.rs       # 配置加密导出 / 导入（AES-256-GCM + scrypt）
        └── update.rs         # GitHub Releases 更新检查（HTTPS）
```

## 已知限制与计划

- **拖拽上传**：Tauri / WebView2 下前端无法取得拖拽 File 的真实磁盘路径，拖到 SFTP 面板会提示改用「上传文件」对话框（详见 [README-BUILD.md](README-BUILD.md)）
- **SSH Agent 认证**：当前版本暂不支持 SSH Agent 认证方式（支持密码 / 私钥）
- **系统托盘**：尚未实现（计划中）

## v1.2.7 更新内容

- 新增连接置顶，置顶偏好仅保存于本机前端，不影响连接加密配置
- 常用命令支持 `{{变量}}` 模板，值仅在发送前临时输入，不会写入收藏记录
- 新增 `Ctrl+K` 连接搜索与 `Ctrl+Shift+F` 命令收藏快捷键；终端输入区不拦截这两个快捷键
- 优化连接抽屉与命令收藏面板的视觉层级、悬停反馈和输入提示
- GitHub Actions 已成功生成 Windows NSIS 安装包

## 历史版本

- **`v1.1.0-electron`**（tag）：旧 Electron 版（Windows 便携，~80MB），已存档于该 tag
- 仓库 master 已迁移至 Tauri v2；Electron 版代码可在 tag 中查看或 checkout 恢复

## 开源许可

本项目以 **MIT** 协议开源（`package.json` 中声明）。LICENSE 文件待补充。
