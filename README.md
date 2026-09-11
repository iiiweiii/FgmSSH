# FgmSSH

现代化界面的 Windows SSH 客户端：终端、SFTP 文件管理、服务器监控、端口转发与安全的凭据管理。基于 **Tauri v2**，安装包仅约 5 MB。

[![Release](https://img.shields.io/github/v/release/iiiweiii/FgmSSH)](https://github.com/iiiweiii/FgmSSH/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#开源许可)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)]()
[![Build & Release](https://github.com/iiiweiii/FgmSSH/actions/workflows/build.yml/badge.svg)](https://github.com/iiiweiii/FgmSSH/actions/workflows/build.yml)

> **当前版本：v1.2.10**。推送 `v*` tag 会触发 GitHub Actions 自动构建并上传 Release 草稿，核验后再公开发布。

## 特性

- **SSH 终端**：基于 [xterm.js](https://xtermjs.org/) 5.5，多会话标签页；断线自动重连（指数退避 1–32s，默认开启，可配置最大尝试次数）
- **认证方式**：密码 / 私钥（含口令）/ **系统 SSH-Agent**（Windows OpenSSH Agent 命名管道，私钥不出 agent）
- **连接管理**：新建 / **编辑** / 删除 / 置顶；凭据经 Windows DPAPI 加密落盘
- **SFTP 文件管理**：上传 / 下载 / 断点续传；文件夹整包 zip 下载；远端 `find` 递归搜索；目录同步（终端 `cd` 联动）；**拖拽本地文件到面板即上传**
- **服务器监控**：GPU / CPU / 内存 / 磁盘等指标（5s 自动刷新，GPU 利用率与显存占用折线图）
- **端口转发隧道**：本地端口 → 远端服务的转发（**仅绑定 127.0.0.1**）
- **内置预览**：图片（jpg/png/gif/webp/svg）、PDF、DOCX 在线预览
- **内置文本编辑**：文本类文件内置编辑器，语法高亮，可保存回远端
- **配置加密导出 / 导入**：AES-256-GCM + scrypt 口令加密备份（`.fgm`）
- **常用命令收藏**：本地收藏常用命令，一键发送；支持 `{{变量}}` 模板，发送前临时输入参数
- **设置面板**：当前版本、一键检查更新、界面语言切换（简体中文 / English）
- **应用内更新**：启动后自动检查，发现新版本可在软件内一键下载安装并自动重启（无需手动下载安装包）
- **中英双语**：全界面文案可切换，静态界面与运行时提示一并生效
- **连接效率**：连接置顶、`Ctrl+K` 快速搜索连接、`Ctrl+Shift+F` 命令收藏
- **浅色 / 深色主题**：全局主题切换

## 安全特性

安全是一等公民，以下是本项目的重点设计：

- **凭据加密落盘（DPAPI）**：密码 / 私钥口令使用 Windows DPAPI 加密（`enc:v1:` 格式）；**fail-closed** —— 加密不可用或失败时拒绝写入，绝不落明文
- **主机密钥 TOFU 校验**：首次连接校验主机指纹（`known_hosts` 三态：trusted / unknown / mismatch）；unknown 弹窗确认，mismatch 危险警告（可能中间人攻击）；确认等待 **60s 超时默认拒绝**
- **审计日志**：JSONL 按天滚动，字段白名单 + 内容脱敏（私钥块 / JWT / 长 base64 / `user:pass@` 等）；面板支持按真实操作类型 / 结果筛选
- **配置脱敏视图**：`store_load` 仅向前端返回脱敏视图（密码字段置空 + `hasPassword` 标记），凭据仅在主进程内解密
- **本地文件访问控制**：SFTP 上传 / 下载的本地路径须经对话框登记（`approved_local_paths`，消费即移除），未登记一律拒绝
- **命令注入防护**：监控命令为编译期常量；SFTP 搜索关键字白名单 `[A-Za-z0-9_.-]` + 深度钳制 + 单引号转义
- **严格 CSP**：`script-src 'self'`（无 `unsafe-eval`），PDF worker 走 blob 白名单
- **openExternal 白名单**：仅放行 `http://` / `https://`
- **隧道仅绑本机回环**：端口转发只监听 `127.0.0.1`，绝不监听 `0.0.0.0`

## 快速开始

### 直接下载

从 [Releases](https://github.com/iiiweiii/FgmSSH/releases) 下载最新的 Windows 安装包（文件名形如 `FgmSSH_<版本>_x64-setup.exe`）。

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

> 更详细的构建说明见 [README-BUILD.md](README-BUILD.md)；IPC 契约见 [SPEC.md](SPEC.md)。

## 已知限制

- **系统托盘**：尚未实现（计划中）
- **端口转发**：目前仅支持本地转发（本地端口 → 远端服务），暂无 SOCKS5 动态转发

## v1.2.10 更新内容

- **连接编辑**：已保存的连接可直接编辑（名称 / 主机 / 端口 / 用户 / 认证方式 / 私钥），密码与口令留空即沿用原值，隧道等附加配置不丢失
- **SSH-Agent 认证**：支持系统 SSH-Agent（Windows「OpenSSH Authentication Agent」命名管道；类 Unix 走 `SSH_AUTH_SOCK`），按 agent 中的公钥逐个尝试，私钥不出 agent
- **拖拽上传**：把本地文件拖进 SFTP 面板即可上传（改用 Tauri v2 原生 drag-drop 事件获取真实路径，取代原来「请改用上传对话框」的提示）

## v1.2.9 更新内容

- **应用内更新**：新增启动后静默检查（有新版本显示顶栏徽标，点击打开设置面板）
- 设置面板新增「下载并安装更新」：应用内流式下载（带进度条）→ sha256 校验 → 自替换 → 自动重启，无需手动下载安装包
- CI 额外发布便携版 exe（`FgmSSH_<版本>_x64-portable.exe`）作为应用内更新载荷，同时保留 NSIS 安装包

## v1.2.8 更新内容

- 新增**设置面板**（工具栏齿轮）：当前版本、一键检查更新、界面语言切换
- 新增**中英双语**：全界面文案（含提示与错误消息）可实时切换并持久化
- **修复终端尺寸不同步**：远端 PTY 与本地窗口尺寸失配，导致输入长命令后删除时光标乱跑、内容错乱
- **修复操作日志**：类型下拉改为按真实操作类型动态生成（原选项与日志实际类型不符，筛选恒为空）；移除失效的「清空」按钮
- 界面精简：移除侧边栏品牌区、标签栏「+」按钮、终端下方状态栏；通知改为顶部居中淡入
- SFTP 搜索栏：去掉左侧放大镜，递归搜索改为图标按钮

## 历史版本

- **`v1.1.0-electron`**（tag）：旧 Electron 版（Windows 便携，~80 MB），已存档于该 tag；master 已迁移至 Tauri v2

## 开源许可

本项目以 **MIT** 协议开源。
