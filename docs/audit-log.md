# NimbusSSH 操作日志系统 (Audit Log) 设计说明

> 本文档描述 NimbusSSH 的完整操作日志实现方案：日志 Schema、脱敏策略、写入路径、
> 查询接口用法、性能说明，以及如何扩展新的操作类型。

---

## 1. 概述

NimbusSSH 在**主进程**中实现了一个轻量、低侵入的操作日志模块 `src/audit-log.js`：

- 每次关键操作（连接/断开/SFTP 文件操作/文档打开保存/图片预览等）自动记录一条**结构化 JSON** 日志；
- 采用 **JSON Lines** 格式持久化（每行一条独立 JSON），按天滚动 `audit-YYYY-MM-DD.jsonl`；
- 写入为**异步 fire-and-forget**，经主进程唯一写入口 + 串行队列，保证不阻塞业务、不交错、不丢失；
- 内建**白名单字段** + **正则脱敏**，密码/私钥/token 一律不落盘；
- 提供 IPC 查询接口 `window.nimbus.auditQuery()` 与轻量日志查看面板（渲染层）。

埋点原则：**统一在主进程 IPC handler 的成功/失败分支埋点**，不在渲染进程按钮事件里散落；
渲染层仅补充主进程感知不到的纯 UI 事件（如打开日志面板、关闭文档标签）。

---

## 2. 日志 Schema（固定字段，白名单策略）

每条日志为**单行 JSON**，只允许下列字段落盘（`_sanitize` 白名单策略，其余字段一律丢弃）：

| 字段     | 类型   | 必填 | 说明                                                                 |
| -------- | ------ | ---- | -------------------------------------------------------------------- |
| `ts`     | string | ✅   | ISO 8601 时间戳，自动生成（忽略调用方传入值，保证单调可排序）        |
| `level`  | string | ✅   | 日志级别，默认 `INFO`                                                 |
| `user`   | string | ✅   | 用户标识：`username@host`（NimbusSSH 无登录体系，用连接用户名/主机）  |
| `session`| string | ✅   | 会话 ID（渲染层 `sessionId`）                                        |
| `type`   | string | ✅   | 操作类型（见下）                                                      |
| `target` | string | ✅   | 操作对象/目标：远程路径 / 文件名 / `host:port`                        |
| `result` | string | ✅   | 操作结果：`success` / `failure`                                       |
| `detail` | string | 可选 | 详细描述（自由文本，统一过脱敏）                                      |

示例（一行）：

```json
{"ts":"2026-08-12T05:04:03.123Z","level":"INFO","user":"root@192.168.1.10","session":"s1_m1x2k","type":"sftp.mkdir","target":"/[REDACTED]/data","result":"success","detail":"新建文件夹"}
```

### 2.1 操作类型（type）约定

采用「点分」命名，兼顾分类与精确筛选；与文档/预览/终端功能一一对应：

| type                  | 触发场景                                   |
| --------------------- | ------------------------------------------ |
| `connect`             | SSH 连接成功 / 失败                        |
| `disconnect`          | 断开连接（用户主动 / 远端关闭 / 窗口关闭） |
| `sftp.list`           | 列出目录内容                               |
| `sftp.cd`             | 终端 cd 同步（目录切换）                   |
| `sftp.upload`         | 上传文件                                   |
| `sftp.download`       | 下载文件                                   |
| `sftp.downloadFolder` | 文件夹 ZIP 打包下载                        |
| `sftp.mkdir`          | 新建文件夹                                 |
| `sftp.rename`         | 重命名                                     |
| `sftp.delete`         | 删除文件/目录                              |
| `doc.open`            | 内置文档查看器打开文档                     |
| `doc.save`            | 文档编辑保存回远端                         |
| `doc.close`           | 关闭文档标签（渲染层补充）                 |
| `preview.open`        | 图片预览                                   |
| `preview.saveAs`      | 预览图片另存为                             |
| `audit.panel`         | 打开/操作日志面板（渲染层补充）            |

> 对应 PRD 的概念分类：`view`≈`sftp.list`/`preview.open`，`edit`≈`doc.save`，
> `login`≈`connect`，`delete`≈`sftp.delete`，`upload/download/mkdir/rename/cd/open-doc`
> 均有独立 type。需要时可按 type 前缀归类。

---

## 3. 脱敏策略（安全）

三层防线，**密码/私钥/SSH 握手细节一律不落盘**：

1. **字段白名单**：`_sanitize()` 只保留上表 8 个字段，调用方误传 `password`/`privateKey`/`passphrase` 等一律丢弃。
2. **正则脱敏 `redact(text)`**（应用于 `user`/`session`/`type`/`target`/`detail` 所有字符串）：
   - PEM 私钥块：`-----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----` 整块替换为 `[REDACTED:private-key]`；
   - OpenSSH 私钥块同理；
   - 敏感键值对：`password=` / `passphrase=` / `secret=` / `token=` / `api_key=` / `auth=` 的取值替换为 `[REDACTED]`；
   - JWT 形态 token（`eyJ...`）替换为 `[REDACTED:token]`；
   - 连续 65+ 字符 base64（疑似密钥材料）替换为 `[REDACTED:long-base64]`（宁可误伤不漏敏感）；
   - URI userinfo 密码段：`user:password@host`（如 `ssh://root:secretpw@1.2.3.4`）的密码段替换为 `[REDACTED]`（保留用户名，置于大块替换之后，避免破坏已替换占位符）。
3. **路径用户名段替换 `redactPath(p, user)`**：
   - 保留路径可读性（便于定位问题），但将「等于当前用户名」的路径段替换为 `[REDACTED]`；
   - 例：`user=root@1.2.3.4`，`/root/data` → `/[REDACTED]/data`；`/home/root/x` → `/home/[REDACTED]/x`；
   - 用户名长度 < 2 时不替换，防止单字母段误伤。

**明确声明**：SFTP 路径可能含敏感目录名，本系统保留路径但做用户名段脱敏；
SSH 握手/协商细节在埋点层就不写入（埋点只写 `friendlySSHError` 的友好诊断文案），脱敏正则只是第二道防线。

---

## 4. 写入路径与文件滚动

- 日志目录：`app.getPath('userData')/logs`
  - 安装版：`%APPDATA%/<appName>/logs`
  - **portable 版：`%APPDATA%/NimbusSSH/logs`**（userData 稳定可写，不随临时解压目录消失）
- 文件名：`audit-YYYY-MM-DD.jsonl`（按天滚动，`getCurrentLogFile()` 取当天文件）
- 目录在 `app.whenReady` 中创建（`initAuditLog({ dir })`），失败仅警告不阻塞启动。

---

## 5. 性能与并发（设计说明）

- **异步非阻塞**：`logAudit()` 仅做内存组装 + `JSON.stringify`，随后把写入任务挂到 Promise 队列上立即返回；业务路径**绝不 await、绝无同步 IO**（无 `appendFileSync`）。
- **写入队列**：`writeQueue = writeQueue.then(() => appendFile(...))` 串行化；主进程单事件循环天然串行，队列保证**顺序**且每条 append 是一次完整 write，行不交错。
- **不丢失**：appendFile 回调错误仅 `console.warn` 一次，不抛给业务；正常路径队列 resolve，测试可用 `flush()` 等待全部落盘。
- **多窗口**：同一 app 多窗口共用同一日志文件，由主进程（`audit:log`/内部埋点）作为**唯一写入口**，无并发写冲突。
- **查询**：`queryAudit()` 在用户触发时才读文件（非热路径），按天读取并过滤；超大单日文件可后续优化为流式读取（当前量级 `readFileSync` 足够）。

---

## 6. 查询接口用法

### 6.1 渲染层 IPC（`window.nimbus`）

```js
// 手动补充记录（UI 事件等主进程感知不到的操作）
await window.nimbus.auditLog({ type: 'audit.panel', target: '操作日志面板', result: 'success', detail: '打开面板' });

// 查询
const res = await window.nimbus.auditQuery({
  from: '2026-08-12T00:00:00Z', // 可选: ISO 时间起
  to: '2026-08-12T23:59:59Z',   // 可选: ISO 时间止
  user: 'root',                 // 可选: 用户标识子串 (不区分大小写)
  type: 'sftp.upload',          // 可选: 精确类型; 支持逗号多选 'sftp.list,sftp.upload'
  result: 'failure',            // 可选: success | failure
  limit: 100,                   // 可选: 分页大小 (默认 100, 上限 1000)
  offset: 0,                    // 可选: 偏移
});
// => { ok: true, total: 123, items: [{ts,level,user,session,type,target,result,detail}, ...] }
// items 按 ts 降序 (最新在前)
```

### 6.2 Node 直调（主进程 / 测试）

```js
const auditLog = require('./src/audit-log');
auditLog.initAuditLog({ dir: '/path/to/logs' });
auditLog.logAudit({ type: 'connect', target: '1.2.3.4:22', result: 'success', user: 'root@1.2.3.4', session: 's1', detail: 'ok' });
const { total, items } = await auditLog.queryAudit({ type: 'sftp.list', result: 'failure', limit: 20 });
await auditLog.flush(); // 冲刷队列 (测试/退出前)
```

---

## 7. 埋点清单

| 位置 (main.js)                    | type                | 分支         |
| --------------------------------- | ------------------- | ------------ |
| `conn.on('ready')`                | `connect`           | success      |
| `conn.on('error')`                | `connect`           | failure      |
| `conn.on('close')` (远端/网络)    | `disconnect`        | success      |
| `ipcMain ssh:disconnect`          | `disconnect`        | success      |
| `win.on('closed')` 会话清理       | `disconnect`        | success      |
| `sftp:list`                       | `sftp.list`         | 成功/失败    |
| `sftp:download`                   | `sftp.download`     | 成功/失败    |
| `sftp:upload`                     | `sftp.upload`       | 成功/失败    |
| `sftp:mkdir`                      | `sftp.mkdir`        | 成功/失败    |
| `sftp:rename`                     | `sftp.rename`       | 成功/失败    |
| `sftp:delete`                     | `sftp.delete`       | 成功/失败    |
| `sftp:cdSync`                     | `sftp.cd`           | 成功/失败    |
| `sftp:downloadFolder`             | `sftp.downloadFolder`| 成功/失败   |
| `preview:open`                    | `preview.open`      | 成功/失败    |
| `preview:saveAs`                  | `preview.saveAs`    | 成功/失败    |
| `doc:open`                        | `doc.open`          | 成功/失败    |
| `doc:save`                        | `doc.save`          | 成功/失败    |

渲染层补充（低侵入，仅追加调用，不改既有逻辑）：
- `openAuditPanel` → `type:'audit.panel'`（打开面板）
- `closeDocTab` → `type:'doc.close'`（关闭文档标签，主进程不记录）

统一入口 `logAuditOp(type, winId, sessionId, target, result, detail)` 自动补 `user`（从会话对象取 `username@host`）与 `session`。

---

## 8. 如何扩展新操作类型

新增一个操作类型的埋点只需 3 步：

1. **埋点**（main.js 的 IPC handler 成功/失败分支，或渲染层补充）：
   ```js
   logAuditOp('my.op', e.sender.id, sessionId, targetPath, res.ok ? 'success' : 'failure', res.error);
   // 或渲染层: window.nimbus.auditLog({ type:'my.op', target, result, session, detail })
   ```
2. **面板筛选**（可选）：在 `src/index.html` 的 `#auditTypeFilter` 中加一个 `<option>`；
3. **文档/测试**（可选）：在 `docs/audit-log.md` 类型表与 `tests/audit-log-test.js` 静态断言 `expectedTypes` 中登记。

无需改动 `src/audit-log.js`——schema 固定、白名单与脱敏自动生效；若新类型需要特别的脱敏规则，在 `redact()` / `redactPath()` 中追加正则即可。

---

## 9. 测试

```bash
node tests/audit-log-test.js
```

覆盖：落盘 JSON Lines 格式与字段齐全、redact 脱敏（密码/私钥/token）、queryAudit 筛选与分页、
200 次并发写入不丢行不交错、`_sanitize` 白名单、main/preload/renderer/index 埋点静态断言。
