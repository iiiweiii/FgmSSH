# FgmSSH Tauri v2 迁移工程规格（IPC 契约 + 项目结构）

**日期**：2026-08-13 ｜ **状态**：实施基准（各模块实现必须遵守本契约）
**目标**：Electron → Tauri v2，保持 `window.nimbus.*` 前端 API 形状不变（前端复用最大化）

## 1. 项目结构

```
fmgssh-tauri/
├── package.json              # @tauri-apps/api + @xterm/xterm + pdfjs-dist + mammoth + vite
├── vite.config.js
├── index.html                # 复用 fmgssh-review/src/index.html，加载 nimbus-bridge.js
├── src/                      # 前端（从 fmgssh-review/src/ 复制并适配）
│   ├── renderer.js           # 原样复用（仅移除 window.nimbus 依赖的 preload 差异）
│   ├── style.css / theme.js / health-parser.js / editor-highlight.js / file-filter.js / fav-commands.js
│   ├── nimbus-bridge.js      # ★ 新增：window.nimbus.* → @tauri-apps/api 桥接层（核心）
│   └── vendor/               # xterm/pdfjs/mammoth 的 npm 引入
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # productName=FgmSSH, identifier=com.fgm.ssh
│   ├── capabilities/default.json
│   ├── icons/                # 复用 assets/icon.png 转 ico
│   └── src/
│       ├── main.rs / lib.rs  # 注册全部 commands + events 发射
│       ├── state.rs          # 全局状态（连接 session 表、approvedLocalPaths、known_hosts 路径）
│       ├── ssh.rs            # SSH 连接/终端/重连/TOFU（russh）
│       ├── hostkey.rs        # known_hosts 指纹（OpenSSH SHA256 无 padding + MD5）
│       ├── credential.rs     # DPAPI 加密（windows crate），enc:v1: 前缀兼容旧 token
│       ├── store.rs          # connections.json / settings.json 持久化（fail-closed 语义）
│       ├── audit.rs          # 审计 JSONL（白名单字段 + 脱敏，兼容 audit-log.js 格式）
│       ├── sftp.rs           # SFTP 全家桶：list/download/upload/resume/zip/search/mkdir/delete/rename/cdSync/registerUploadPaths
│       ├── tunnel.rs         # 端口转发（仅绑 127.0.0.1）
│       ├── monitor.rs        # 远端监控命令执行（编译期常量命令表，64KB/8s 上限）
│       ├── update.rs         # GitHub Releases 更新检查（HTTPS + 5s 超时）
│       └── portable.rs       # 配置导出/导入（AES-256-GCM + scrypt，兼容 config-portable.js）
```

## 2. Tauri Commands 契约（命令名 = 小写下划线，与 window.nimbus 一一对应）

| window.nimbus.*（前端） | Tauri Command | 参数 → 返回 |
|---|---|---|
| connect(sessionId, config) | `ssh_connect` | {sessionId, config:{connId,host,port,username,authMethod,password,privateKeyPath,passphrase,tunnels,autoReconnect,autoReconnectMaxAttempts,hostKeyVerify}} → {ok, error?} |
| write(sessionId, data) | `ssh_write` | {sessionId, data} → {ok, error?} |
| resize(sessionId, rows, cols) | `ssh_resize` | {sessionId, rows, cols} → {ok} |
| disconnect(sessionId) | `ssh_disconnect` | {sessionId} → {ok} |
| monitorFetch(sessionId) | `ssh_monitor_fetch` | {sessionId} → {ok, info, load, memory, disks, cpu, errors} |
| hostKeyAccept(sessionId, override) | `hostkey_accept` | {sessionId, override} → {ok, error?} |
| hostKeyReject(sessionId) | `hostkey_reject` | {sessionId} → {ok} |
| tunnelStart/ssh:tunnel | `tunnel_start` | {sessionId, cfg:{localPort,remoteHost,remotePort}} → {ok, tunnelId, error?} |
| tunnelList | `tunnel_list` | {sessionId} → {ok, tunnels:[]} |
| tunnelStop | `tunnel_stop` | {sessionId, tunnelId} → {ok} |
| sftpList | `sftp_list` | {sessionId, path} → {ok, items:[{name,type,size,mtime}]} |
| sftpDownload | `sftp_download` | {sessionId, remotePath, localPath} → {ok, resumed?, error?} |
| sftpUpload | `sftp_upload` | {sessionId, localPath, remotePath} → {ok, resumed?, error?} |
| sftpRegisterUploadPaths(files) | `sftp_register_upload_paths` | {paths:[String]}（前端 bridge 已用 webUtils 等值逻辑取路径）→ {ok, count, accepted:[]} |
| sftpMkdir | `sftp_mkdir` | {sessionId, path} → {ok} |
| sftpDelete | `sftp_delete` | {sessionId, path} → {ok} |
| sftpRename | `sftp_rename` | {sessionId, oldPath, newPath} → {ok} |
| sftpCdSync | `sftp_cd_sync` | {sessionId, rawPath} → {ok, path} |
| sftpSearch | `sftp_search` | {sessionId, path, keyword, maxDepth} → {ok, results:[]} |
| sftpDownloadFolder | `sftp_download_folder` | {sessionId, remotePath, localZipPath} → {ok} |
| selectKeyFile / selectFile / selectSavePath | `dialog_select_key` / `dialog_select_file` / `dialog_select_save_path` | → {ok, path?} / {ok, path?} / {ok, path?} |
| previewOpen/close/saveAs | `preview_open` / `preview_close` / `preview_save_as` | 同 Electron 语义 |
| docOpen/loadFull/save/close | `doc_open` / `doc_load_full` / `doc_save` / `doc_close` | 同 Electron 语义 |
| storeLoad / storeSave | `store_load` / `store_save` | → 脱敏视图（password/passphrase='' + hasPassword） / {list} → {ok, error?}（fail-closed） |
| settingsLoad / settingsSave | `settings_load` / `settings_save` | → settings / {settings} → {ok} |
| configExport / configImport | `config_export` / `config_import` | {password} → {ok, count?, error?} |
| auditLog / auditQuery | `audit_log` / `audit_query` | {entry} → {ok} / {filters} → {ok, total, items} |
| openExternal(url) | `open_external` | {url} → {ok}（**仅放行 http/https**，其余拒绝） |
| updateCheck | `update_check` | → {ok, hasUpdate?, current?, latest?, url?} |

## 3. 事件（后端 → 前端，前端 bridge 转发为 window.nimbus.on* 回调）

| 事件名 | payload |
|---|---|
| `ssh:data` | {sessionId, data} |
| `ssh:event` | {sessionId, type, data}（连接状态/重连/退出码等） |
| `hostkey:confirm` | {sessionId, host, port, algorithm, fingerprint, md5}（unknown 首次） |
| `hostkey:mismatch` | {sessionId, host, port, algorithm, fingerprint, md5}（危险警告） |
| `update:check` | {ok, hasUpdate?, latest?, url?} |
| `sftp-upload-progress` / `sftp-download-progress` | {sessionId, phase, percent?, transferred?, total?} |

## 4. 安全约束（迁移必须保留，与 Electron 版 P0 一致）

1. **凭据 fail-closed**：credential 加密失败（DPAPI 不可用/抛错）→ `store_save` 拒绝写入并返回错误；绝不落明文。`enc:v1:` 前缀与旧 token 解密兼容（Windows DPAPI 同一用户可解密）。
2. **store_load 脱敏**：password/passphrase 返回空串 + hasPassword/hasPassphrase 布尔；`ssh_connect` 按 connId 从磁盘解密补全。
3. **TOFU 主机密钥**：known_hosts.json 明文（非机密），SHA256 无 padding + MD5 冒号格式；unknown→confirm 事件、mismatch→mismatch 事件（60s 超时默认拒绝）。
4. **拖拽/文件外带防护**：前端 bridge 只把"真实拖拽 File 的路径"交给 `sftp_register_upload_paths`；后端登记时校验存在性+普通文件+数量上限 500，登记进 approvedLocalPaths 供 sftp_upload 消费。
5. **open_external 白名单**：仅 http/https。
6. **审计脱敏**：字段白名单（ts/level/user/session/type/target/result/detail）+ 正则脱敏（PEM/JWT/长 base64/userinfo password@），与 audit-log.js 规则一致。
7. **CSP**：index.html 保留 `script-src 'self'` 无 unsafe-eval；WebView2 下 pdfjs worker 用 blob 白名单。
8. **命令注入防护**：monitor 命令编译期常量；sftp search find 关键字白名单 + maxdepth 钳制 + 单引号转义。

## 5. 依赖选型（纯 Rust 优先，避免 C 依赖编译问题）

- `russh`（SSH，纯 Rust）/ `russh-sftp`（SFTP）/ `futures`
- `tokio`（async runtime，features=full）
- `windows = "0.58"`（DPAPI: Win32::Security::Cryptography::{CryptProtectData,CryptUnprotectData}）
- `aes-gcm = "0.10"` / `scrypt = "0.11"` / `rand`（config-portable 兼容）
- `zip = "2"`（文件夹下载）
- `chrono`（审计时间戳）
- `serde / serde_json`、`thiserror`
- `ureq = { version = "2", features=["tls"] }`（更新检查，rustls，无 OpenSSL）
- `tauri = "2"`、`tauri-plugin-dialog = "2"`（文件对话框）、`tauri-plugin-shell = "2"`（open_external 需自定义校验后调用，或仅用其 API）

## 6. 前端 nimbus-bridge.js 要点

- `window.nimbus = { ... }`，每个方法映射 `invoke('cmd', args)`；`on*` 用 `listen('event', ...)` 注册并返回取消函数。
- 拖拽 File 取路径：Tauri 下前端**无法**用 webUtils（Electron 专属）→ 用 FileSystemHandle 等价？Tauri v2 前端拿不到真实磁盘路径。**解决方案**：拖拽登记改为上传 File 对象流——bridge 将 File 转 ArrayBuffer 经 `sftp_upload_data(sessionId, remotePath, bytes)` 上传；或退化为"拖拽仅提示选择文件对话框"。**实施时二选一并写清注释**（推荐：对话框为主 + 拖拽走 upload_data）。
- xterm/pdfjs/mammoth 均经 npm 引入，vite 打包。

## 7. 交付物与验证

- 全部源码 + Cargo.toml/package.json/tauri.conf.json + 构建文档 README-BUILD.md
- **未编译**：本机无 Rust，交付后需用户 `cargo build` 验证；代码注释中标注 `// TODO(verify): 需本机编译验证` 处为重点复核点
