# FgmSSH

现代化界面的 Windows SSH 客户端 —— 终端 + SFTP 文件管理 + 服务器监控的一体化工具。绿色单文件，下载即用。

![Electron](https://img.shields.io/badge/Electron-31-blue) ![License](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能特性

### 终端
- 多会话标签页终端（xterm.js）
- **终端 ↔ SFTP 面板双向 cd 同步**（终端输入 `cd` 面板跟随；面板右键「cd 进入文件夹」终端同步）
- **断线自动重连**：网络抖动按指数退避自动连回（1s→32s，最多 5 次），会话无缝恢复
- 常用命令收藏夹：一键发送重复命令
- 内置 SSH 隧道/端口转发管理（跳板机、内网穿透、数据库本地直连）

### SFTP 文件管理
- 文件浏览/上传/下载/新建/重命名/删除 + 右键菜单
- **拖拽上传**（多文件，悬停高亮）
- **断点续传**：大文件中断后从断点继续（下载 `.part` 断点、上传以远端为准续写）
- 文件夹 ZIP 打包下载（带进度条）
- 图片预览（左右切换/缩放/旋转/另存为）
- 内置文档查看器：PDF / Word / TXT（**语法高亮**，TXT 可编辑保存回远端，**大文件分段加载**）
- **文件搜索/过滤**：即时过滤 + 服务器端 `find` 递归搜索
- 传输进度条

### 服务器监控（健康监控面板）
- 基本信息（主机名/系统/时间/运行时长）
- **GPU 性能监控**（NVIDIA，零依赖 SVG 折线图，5 秒采集滚动 5 分钟）
- CPU（负载/使用率）/ 内存（GB）/ 磁盘（挂载点白名单可配置）

### 安全与隐私
- **连接凭据加密存储**（Windows DPAPI，旧明文配置自动迁移）
- **配置加密导出/导入**（AES-256-GCM + 用户密码，换机备份）
- **操作日志系统**：JSONL 结构化落盘、三层脱敏（白名单/正则/路径）、条件查询 + 面板查看
- 敏感信息（密码/私钥/token）绝不落盘、不入日志

### 体验
- 浅色 / 深色 / 跟随系统 主题切换（终端同步换色）
- 托盘最小化 + 后台保活（关闭窗口不杀会话，托盘退出才是真退出）
- 启动自动检查更新（有新版顶栏提示）

## 🚀 快速开始

### 直接使用（Windows x64）
下载最新版 `FgmSSH-1.1.0-portable.exe`（单文件绿色版），双击即用，无需安装。
> 首次运行若提示 SmartScreen「未知发布者」，点「更多信息 → 仍要运行」即可。

### 从源码构建
```bash
# 1. 安装依赖
npm install

# 2. 开发运行（或双击 start.bat）
npm start

# 3. 打包 Windows portable 单文件
npm run pack        # 产物在 dist/ 下
```

## 🧪 测试

```bash
# 运行全部单元/回归测试（node 直跑）
node tests/audit-log-test.js
node tests/credential-store-test.js
node tests/tunnel-test.js
node tests/dragdrop-test.js
node tests/favcommands-test.js
node tests/config-portable-test.js
node tests/monitor-test.js
node tests/gpu-chart-test.js
node tests/theme-test.js
node tests/reconnect-test.js
node tests/resume-test.js
node tests/filefilter-test.js
node tests/updatecheck-test.js
node tests/editor-enhance-test.js
# ...（tests/ 下 qa-supplemental-*.js 为长期回归资产）
```
> 部分 E2E（`doc-e2e`、`sftp-ipc` 等）需要真实 SSH 服务器（如 `172.16.11.10:26810`）或 Electron 运行时环境。

## 📚 文档

| 文档 | 说明 |
|------|------|
| [`docs/audit-log.md`](docs/audit-log.md) | 操作日志系统完整方案（schema/脱敏策略/查询接口/扩展指南） |
| [`docs/feature-roadmap.md`](docs/feature-roadmap.md) | 候选功能规划（已实现/待做优先级） |

## 🏗️ 技术栈

Electron 31 · ssh2 · xterm.js 5.5 · pdfjs-dist · mammoth —— 零 UI 框架依赖，绿色单文件分发。

## 📄 License

[MIT](LICENSE) © 2026 iiiweiii
