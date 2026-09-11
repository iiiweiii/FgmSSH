/**
 * FgmSSH - 国际化模块 (i18n)
 * ============================================================
 * 职责:
 *   - 中英词典 (键 = 中文原文, 值 = 英文); 插值文案用 {0}/{1} 占位符;
 *   - t(text, ...args): 查词典并按序替换占位符; 未收录返回原文 (优雅降级);
 *   - 语言持久化 (localStorage) 与切换回调;
 *   - applyDom(root): 翻译静态界面的文本节点与 title/placeholder/aria-label 属性。
 *
 * 设计要点:
 *   - 不依赖 DOM/框架, UMD 形态 (node 下 module.exports, 浏览器挂 window.I18n);
 *   - 动态渲染内容 (列表/面板/提示) 由 renderer.js 在渲染时显式调用 T() 翻译,
 *     applyDom 只处理静态界面, 且跳过用户数据容器 (文件名/连接名/远端输出等);
 *   - 审计类型下拉的中文标签放在本模块 (避免被 renderer 的自动包裹提前求值)。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.I18n = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'fgmssh.lang';
  const DEFAULT_LANG = 'zh';
  const LANGS = [
    { id: 'zh', label: '简体中文' },
    { id: 'en', label: 'English' },
  ];

  // 用户数据/动态内容容器: applyDom 跳过这些子树 (避免翻译文件名/连接名/远端输出)
  const SKIP_IDS = [
    'terminalArea', 'connDrawerList', 'sftpBody', 'sftpSearchResultsList', 'sftpProgress',
    'favList', 'docViewerBody', 'docTitleName', 'auditBody', 'auditCount', 'auditTbody',
    'tunnelList', 'monitorGrid', 'monitorLoading', 'monitorError', 'monitorFetched',
    'tunnelSessionHint', 'previewTitle', 'previewZoomLabel',
    'hostKeyHost', 'hostKeyAlgo', 'hostKeySha', 'hostKeyMd5', 'hostKeyStoredAlgo',
    'hostKeyStoredSha', 'hostKeyHint', 'toastContainer',
  ];

  // 审计操作类型中文短标签 (与后端 audit 事件 type 对应)
  const AUDIT_TYPE_LABELS = {
    'ssh.connect': '连接',
    'ssh.disconnect': '断开',
    'ssh.reconnect': '重连',
    'sftp.list': '列目录',
    'sftp.cd': '切换目录',
    'sftp.upload': '上传',
    'sftp.download': '下载',
    'sftp.downloadFolder': '下载 ZIP',
    'sftp.mkdir': '新建文件夹',
    'sftp.rename': '重命名',
    'sftp.delete': '删除',
    'doc.open': '打开文档',
    'doc.loadFull': '加载全部',
    'doc.save': '保存文档',
    'doc.close': '关闭文档',
    'preview.open': '图片预览',
    'preview.saveAs': '预览另存',
    'tunnel.start': '隧道建立',
    'tunnel.stop': '隧道停止',
    'tunnel.error': '隧道错误',
    'config.export': '配置导出',
    'config.import': '配置导入',
    'audit.panel': '面板操作',
  };

  // ---------------- 词典 ----------------
  const EN = {
    // ===== 通⽤ / 按钮 =====
    '保存': 'Save',
    '编辑': 'Edit',
    '关闭': 'Close',
    '关闭 (Esc)': 'Close (Esc)',
    '关闭 (拒绝)': 'Close (reject)',
    '取消': 'Cancel',
    '确定': 'OK',
    '删除': 'Delete',
    '重命名': 'Rename',
    '预览': 'Preview',
    '打开': 'Open',
    '下载': 'Download',
    '下载 (ZIP)': 'Download (ZIP)',
    '下载 ZIP': 'Download ZIP',
    '上传': 'Upload',
    '添加': 'Add',
    '刷新': 'Refresh',
    '连接': 'Connect',
    '停止': 'Stop',
    '断开': 'Disconnect',
    '重连': 'Reconnect',
    '放大': 'Zoom in',
    '缩小': 'Zoom out',
    '上一页': 'Previous page',
    '下一页': 'Next page',
    '适应宽度': 'Fit width',
    '适应窗口': 'Fit to window',
    '主题': 'Theme',
    '语言': 'Language',
    '设置': 'Settings',
    '版本': 'Version',
    '当前版本': 'Current version',
    '检查更新': 'Check for updates',
    '更新检查': 'Update check',
    '检查中...': 'Checking...',
    '已是最新版本': 'You are up to date',
    '发现新版本 {0}': 'New version {0} available',
    '发现新版本': 'New version available',
    '打开下载页': 'Open download page',
    '检查更新失败': 'Update check failed',
    '下载并安装更新': 'Download and install',
    '正在下载...': 'Downloading...',
    '正在下载 {0}%': 'Downloading {0}%',
    '下载完成，正在安装并重启...': 'Download complete, installing and restarting...',
    '下载失败: {0}': 'Download failed: {0}',
    '安装失败: {0}': 'Install failed: {0}',
    '未找到可用的更新包': 'No installable update package found',
    '确定现在下载并安装 v{0} 吗？应用将自动重启。': 'Download and install v{0} now? The app will restart automatically.',
    '关于': 'About',
    // 语言自身的名称保持原样 (语言选择项)
    '简体中文': '简体中文',

    // ===== 侧边栏 / SFTP =====
    '后退': 'Back',
    '上传文件到当前目录': 'Upload files to the current directory',
    '新建文件夹': 'New folder',
    '过滤当前目录 (Esc 清空)': 'Filter current directory (Esc to clear)',
    '递归搜索当前目录': 'Recursively search the current directory',
    '递归搜索当前目录 (需服务器支持 find, maxdepth 3)': 'Recursively search the current directory (requires find, maxdepth 3)',
    '递归搜索结果': 'Recursive search results',
    '关闭结果列表': 'Close result list',
    '准备中...': 'Preparing...',
    '加载中...': 'Loading...',
    '该目录为空': 'This directory is empty',
    '或将文件拖到此处上传': 'or drop files here to upload',
    '连接后查看远程文件': 'Connect to browse remote files',
    '名称': 'Name',
    '大小': 'Size',
    '修改时间': 'Modified',
    '连接列表': 'Connections',
    '连接列表 (Ctrl+K 搜索)': 'Connections (Ctrl+K to search)',
    '搜索连接': 'Search connections',
    '搜索连接...': 'Search connections...',
    '导出配置': 'Export config',
    '导入配置': 'Import config',
    '将全部连接配置加密导出为备份文件': 'Export all connections to an encrypted backup file',
    '从加密备份文件导入连接配置 (将覆盖现有连接)': 'Import connections from an encrypted backup (overwrites current ones)',
    '新建连接': 'New connection',
    '新建 SSH 连接': 'New SSH connection',

    // ===== 标签栏 / 面板入口 =====
    '全屏终端': 'Fullscreen terminal',
    '命令收藏': 'Saved commands',
    '命令收藏 (Ctrl+Shift+F)': 'Saved commands (Ctrl+Shift+F)',
    '端口转发隧道': 'Port forwarding tunnels',
    '健康监控': 'Health monitor',
    '操作日志': 'Audit log',
    '主题模式: 自动 (点击切换)': 'Theme: auto (click to switch)',
    '点击打开 Releases 页面': 'Click to open the Releases page',

    // ===== 命令收藏 =====
    '点击发送；{{变量}} 会在发送前询问': 'Click to send; {{variables}} are asked before sending',
    '名称 (可选)': 'Name (optional)',
    '命令，例如 tail -f {{logPath}}': 'Command, e.g. tail -f {{logPath}}',

    // ===== 文档查看器 =====
    '文档': 'Document',
    '保存修改到远端': 'Save changes to remote',
    '切换 语法高亮预览 / 纯文本编辑': 'Switch  syntax-highlighted preview / plain-text editing',
    '加载全部': 'Load all',
    '正在加载 PDF...': 'Loading PDF...',
    '正在解析 DOCX...': 'Parsing DOCX...',
    '加载失败: {0}': 'Load failed: {0}',
    'PDF 加载失败: {0}': 'PDF load failed: {0}',
    'DOCX 解析失败: {0}': 'DOCX parsing failed: {0}',
    '旧版 .doc 暂不支持，请转存为 .docx 后打开': 'Legacy .doc is not supported; convert it to .docx first',
    '不支持打开该文件类型': 'This file type cannot be opened',
    '文件较大，请先点击「加载全部」后再编辑': 'File is large; click "Load all" before editing',
    '文件较大，请先点击「加载全部」后再保存': 'File is large; click "Load all" before saving',
    '文件过大，已加载前 {0} / 共 {1}，是否加载全部？': 'File is large; loaded the first {0} of {1}. Load everything?',
    '已加载全部内容，可编辑保存': 'All content loaded; editing enabled',
    '加载全部失败': 'Failed to load all',
    '加载全部失败: ': 'Failed to load all: ',
    '保存文档': 'Save document',
    '关闭文档': 'Close document',
    '关闭文档 {0}': 'Close document {0}',
    '保存失败': 'Save failed',
    '已保存 {0}': 'Saved {0}',
    '高亮': 'Highlight',

    // ===== 图片预览 =====
    '图片预览': 'Image preview',
    '上一张 (←)': 'Previous (←)',
    '下一张 (→)': 'Next (→)',
    '原始大小 (100%)': 'Original size (100%)',
    '旋转 90°': 'Rotate 90°',
    '下载到本地': 'Download to local',
    '图片加载失败': 'Failed to load image',
    '切换图片失败': 'Failed to switch image',
    '恢复图片失败': 'Failed to restore image',
    '预览失败': 'Preview failed',
    '已是第一张': 'Already the first image',
    '已是最后一张': 'Already the last image',
    '预览会话已失效': 'Preview session expired',
    '预览另存': 'Preview save-as',

    // ===== 新建连接弹窗 =====
    '连接名称': 'Connection name',
    '主机地址': 'Host address',
    '端口': 'Port',
    '用户名': 'Username',
    '认证方式': 'Authentication',
    '密码': 'Password',
    '私钥': 'Private key',
    '私钥文件': 'Private key file',
    '浏览...': 'Browse...',
    '点击右侧选择 .pem / .ppk 文件': 'Click the button to choose a .pem / .ppk file',
    '私钥密码 (可选)': 'Key passphrase (optional)',
    '如私钥有加密请填写': 'Fill in if the key is encrypted',
    '使用系统 SSH-Agent (Windows OpenSSH Agent) 中已加载的密钥进行认证': 'Authenticate with keys loaded in the system SSH-Agent (Windows OpenSSH Agent)',
    '主机密钥校验 (TOFU, 防中间人)': 'Host key verification (TOFU, anti-MITM)',
    '首次连接时校验服务器主机密钥指纹并记录, 后续连接自动比对 (TOFU, 防中间人攻击)': 'Verify and record the server host key on first connect, compare afterwards (TOFU, anti-MITM)',
    '例如: 生产服务器': 'e.g. Production server',
    '例如: 192.168.1.100': 'e.g. 192.168.1.100',
    '例如: root': 'e.g. root',
    '密码': 'Password',
    '输入密码': 'Enter password',
    '请输入主机地址': 'Please enter the host',
    '请输入用户名': 'Please enter the username',
    '请输入密码': 'Please enter the password',
    '请选择私钥文件': 'Please select a private key file',
    '支持 密码 / 私钥 / SSH-Agent 三种认证方式': 'Supports password / private key / SSH-Agent',

    // ===== 欢迎/空状态 =====
    '欢迎使用 FgmSSH': 'Welcome to FgmSSH',
    '点击下方按钮或按': 'Click the button below or press',
    '就绪': 'Ready',
    '正在连接': 'Connecting',

    // ===== 主机密钥弹窗 =====
    '主机密钥确认': 'Host key verification',
    '⚠️ 主机密钥不匹配': '⚠️ Host key mismatch',
    '主机密钥不匹配！可能存在中间人攻击': 'Host key mismatch! Possible man-in-the-middle attack',
    '服务器返回的主机密钥与之前记录的指纹不一致。请立即停止连接并联系服务器管理员确认。': 'The server host key does not match the recorded fingerprint. Stop connecting and contact the server administrator immediately.',
    '首次连接 · 确认主机密钥': 'First connection · verify host key',
    '主机': 'Host',
    '算法': 'Algorithm',
    'SHA256 指纹': 'SHA256 fingerprint',
    'MD5 指纹': 'MD5 fingerprint',
    '已存指纹': 'Stored fingerprint',
    '信任并连接': 'Trust and connect',
    '信任新指纹并继续': 'Trust new fingerprint and continue',
    '首次连接到此主机。请通过可信渠道比对服务器指纹 (例如:': 'First connection to this host. Verify the server fingerprint through a trusted channel (e.g.:',
    '), 确认无误后再信任。': '), then trust it if it matches.',
    '如确认是服务器端密钥更换 (而非攻击), 可信任新指纹继续连接; 否则请选择「拒绝连接」。': 'If you are sure the server key was rotated (not an attack), trust the new fingerprint and continue; otherwise choose Reject.',

    // ===== 操作日志 =====
    '全部类型': 'All types',
    '全部结果': 'All results',
    '成功': 'Success',
    '失败': 'Failure',
    '50 条': '50 rows',
    '100 条': '100 rows',
    '200 条': '200 rows',
    '500 条': '500 rows',
    '按操作类型筛选': 'Filter by operation type',
    '按结果筛选': 'Filter by result',
    '显示条数': 'Row count',
    '时间': 'Time',
    '用户': 'User',
    '类型': 'Type',
    '目标': 'Target',
    '结果': 'Result',
    '详情': 'Detail',
    '暂无日志': 'No logs',
    '加载日志...': 'Loading logs...',
    '共 0 条': '0 entries',
    '共 {0} 条': '{0} entries',
    '查询失败': 'Query failed',
    '查询失败: ': 'Query failed: ',
    '日志文件: userData/logs/audit-YYYY-MM-DD.jsonl': 'Log file: userData/logs/audit-YYYY-MM-DD.jsonl',
    '操作日志面板': 'Audit log panel',
    '打开操作日志面板': 'Open audit log panel',
    '面板操作': 'Panel action',
    '列目录': 'List directory',
    '切换目录': 'Change directory',

    // ===== 端口转发面板 =====
    '本地端口': 'Local port',
    '远端主机': 'Remote host',
    '默认 localhost': 'Defaults to localhost',
    '远端端口': 'Remote port',
    '例如 8080': 'e.g. 8080',
    '例如 80': 'e.g. 80',
    '例如 Web 服务': 'e.g. Web service',
    '新增隧道': 'New tunnel',
    '添加隧道': 'Add tunnel',
    '(可选)': '(optional)',
    '暂无隧道。可在下方添加, 配置会随连接保存, 下次连接自动建立。': 'No tunnels. Add one below; it is saved with the connection and restored on the next connect.',
    '运行中': 'Running',
    '启动中': 'Starting',
    '已停止': 'Stopped',
    '隧道建立': 'Tunnel started',
    '隧道停止': 'Tunnel stopped',
    '隧道错误': 'Tunnel error',
    '删除隧道 (停止并移出连接配置)': 'Delete tunnel (stop and remove from connection config)',
    '停止隧道': 'Stop tunnel',
    '创建于 {0}': 'Created at {0}',
    '创建隧道失败': 'Failed to create tunnel',
    '创建隧道异常: ': 'Tunnel creation error: ',
    '本地端口无效 (1-65535)': 'Invalid local port (1-65535)',
    '远端端口无效 (1-65535)': 'Invalid remote port (1-65535)',
    '会话未连接, 无法创建隧道': 'Session not connected; cannot create tunnel',
    '获取隧道列表失败': 'Failed to fetch tunnel list',
    '停止隧道失败': 'Failed to stop tunnel',
    '隧道已建立: localhost:{0} -> {1}:{2}': 'Tunnel established: localhost:{0} -> {1}:{2}',
    '隧道已停止: localhost:{0}': 'Tunnel stopped: localhost:{0}',
    '隧道已删除': 'Tunnel deleted',
    '确定删除隧道 localhost:{0} 吗？\\n将停止该隧道并从连接配置中移除。': 'Delete tunnel localhost:{0}?\\nIt will be stopped and removed from the connection config.',

    // ===== 健康监控面板 =====
    '正在采集服务器指标...': 'Collecting server metrics...',
    '自动刷新': 'Auto-refresh',
    '每 5 秒自动刷新 (避免频繁建立 SSH exec 通道)': 'Auto-refresh every 5s (avoids frequent SSH exec channels)',
    '数据来源: 当前活动会话 (uptime / free / df / top / hostname / nvidia-smi)': 'Source: active session (uptime / free / df / top / hostname / nvidia-smi)',
    '请先连接 SSH 会话, 再查看服务器健康指标。': 'Connect an SSH session first to view server metrics.',
    '等待采样数据... (开启自动刷新后每 5 秒采集一次)': 'Waiting for samples... (collected every 5s with auto-refresh on)',
    '无法获取': 'Unavailable',
    'CPU 使用率': 'CPU usage',
    '内存': 'Memory',
    '已用 / 总量': 'Used / total',
    '可用': 'Free',
    '交换分区': 'Swap',
    '磁盘': 'Disk',
    '负载 (1 / 5 / 15 分钟)': 'Load (1 / 5 / 15 min)',
    '运行时长': 'Uptime',
    '用户 / 系统 / 空闲': 'User / system / idle',
    '基本信息': 'Basic info',
    '主机名': 'Hostname',
    '系统': 'System',
    '服务器': 'Server',
    '服务器时间': 'Server time',
    '利用率': 'Utilization',
    '显存': 'VRAM',
    '温度': 'Temp',
    '功耗': 'Power',
    '未检测到 GPU 监控（需要 NVIDIA GPU + nvidia-smi）': 'No GPU monitoring available (requires an NVIDIA GPU + nvidia-smi)',
    'GPU (共 {0} 张卡, 展示第 1 张) · {1}': 'GPU ({0} devices, showing #1) · {1}',
    '采集于 {0}': 'Sampled at {0}',
    '获取监控数据失败': 'Failed to fetch metrics',
    '获取监控数据失败: ': 'Failed to fetch metrics: ',
    '获取监控数据异常: ': 'Metrics fetch error: ',
    '部分指标采集失败: ': 'Some metrics failed: ',
    '部分指标采集失败: {0}': 'Some metrics failed: {0}',
    '请先连接会话': 'Connect a session first',

    // ===== 配置导出/导入 =====
    '加密密码': 'Encryption password',
    '导出配置 - 设置加密密码': 'Export config - set encryption password',
    '导入配置 - 输入解密密码': 'Import config - enter decryption password',
    '请输入导出备份时设置的密码。密码错误将无法解密。': 'Enter the password set when exporting. A wrong password cannot be decrypted.',
    '备份文件将使用 AES-256-GCM 加密，导入时需输入相同密码。请妥善保管该密码。': 'The backup is encrypted with AES-256-GCM; the same password is required to import. Keep it safe.',
    '导入将覆盖当前全部连接配置，确定继续吗？': 'Importing overwrites all current connections. Continue?',
    '显示/隐藏': 'Show/hide',
    '配置导出': 'Config export',
    '配置导入': 'Config import',
    '导出失败': 'Export failed',
    '导入失败': 'Import failed',
    '导出异常: ': 'Export error: ',
    '导入异常: ': 'Import error: ',
    '配置已导出 ({0} 条连接)': 'Config exported ({0} connections)',
    '配置已导入 ({0} 条连接)': 'Config imported ({0} connections)',

    // ===== SFTP 右键菜单 =====
    'cd 进入文件夹': 'cd into folder',

    // ===== 会话/终端状态与提示 =====
    '已连接': 'Connected',
    '连接中...': 'Connecting...',
    '重连中...': 'Reconnecting...',
    '连接失败': 'Connection failed',
    '已断开': 'Disconnected',
    '连接已关闭': 'Connection closed',
    '重连失败': 'Reconnect failed',
    '重连失败：': 'Reconnect failed: ',
    '重连中 ({0}/{1})': 'Reconnecting ({0}/{1})',
    '已断开 · 重连中 ({0}/{1})': 'Disconnected · reconnecting ({0}/{1})',
    '正在连接 {0}:{1} ...': 'Connecting to {0}:{1} ...',
    '正在连接 {0}@{1}:{2} ...': 'Connecting to {0}@{1}:{2} ...',
    '已连接到 {0}': 'Connected to {0}',
    '连接失败: {0}': 'Connection failed: {0}',
    '连接 {0}:{1}': 'Connect {0}:{1}',
    '未命名连接': 'Unnamed connection',
    '连接保存失败': 'Failed to save connection',
    '连接已删除': 'Connection deleted',
    '删除连接': 'Delete connection',
    '确定删除连接 "{0}" 吗？': 'Delete connection "{0}"?',
    '已置顶连接': 'Connection pinned',
    '已取消置顶连接': 'Connection unpinned',
    '无法发起连接: ': 'Cannot initiate connection: ',
    '无法打开保存窗口': 'Cannot open the save dialog',
    '无法打开文件选择窗口': 'Cannot open the file picker',
    '打开文档': 'Open document',
    '打开文档失败': 'Failed to open document',
    '打开文档异常: ': 'Document open error: ',

    // ===== SFTP 操作提示 =====
    '文件夹已创建': 'Folder created',
    '创建文件夹失败': 'Failed to create folder',
    '名称不能包含 / 或 ..': 'Name cannot contain / or ..',
    '路径包含非法段 (..)': 'Path contains an illegal segment (..)',
    '已进入 {0}': 'Opened {0}',
    '删除失败': 'Delete failed',
    '已删除 {0}': 'Deleted {0}',
    '重命名成功': 'Renamed',
    '重命名失败': 'Rename failed',
    '上传异常': 'Upload error',
    '下载失败': 'Download failed',
    '下载异常': 'Download error',
    '打包下载失败': 'Archive download failed',
    '打包下载异常: ': 'Archive download error: ',
    '已下载 {0}': 'Downloaded {0}',
    '已下载 {0}.zip': 'Downloaded {0}.zip',
    '已续传下载 {0}': 'Resumed download {0}',
    '上传 {0} 失败': 'Failed to upload {0}',
    '上传 {0} 失败: {1}': 'Failed to upload {0}: {1}',
    '已上传 {0} 个文件': 'Uploaded {0} files',
    '已上传 {0} 个文件{1}': 'Uploaded {0} files{1}',
    ', {0} 个失败': ', {0} failed',
    '已忽略 {0} 个文件夹 (暂不支持目录上传)': 'Ignored {0} folders (directory upload not supported)',
    '文件夹暂不支持拖拽上传': 'Folders cannot be drag-and-dropped',
    '没有可上传的文件 (文件夹暂不支持)': 'No files to upload (folders not supported)',
    '请先连接会话再拖拽上传': 'Connect a session before dragging files in',
    '上一批上传仍在进行, 请稍候': 'The previous upload batch is still running; please wait',
    '会话已关闭, 上传已取消': 'Session closed; upload canceled',
    '会话已关闭, 下载已取消': 'Session closed; download canceled',
    '拖拽上传失败: ': 'Drag-and-drop upload failed: ',
    '读取目录失败': 'Failed to read directory',
    '没有匹配「{0}」的文件': 'No files matching "{0}"',
    '未找到匹配文件': 'No matching files',
    '递归搜索失败': 'Recursive search failed',
    '递归搜索异常': 'Recursive search error',
    '递归搜索: {0} 条': 'Recursive search: {0} results',
    '目录 {0} · maxdepth 3': 'Directory {0} · maxdepth 3',
    '(超过 {0} 条仅显示前 {1} 条)': '(over {0} matches, showing the first {1})',
    '请输入关键字后点击递归搜索': 'Enter a keyword, then click recursive search',
    '已切换到 {0}': 'Switched to {0}',
    '确定删除{0} "{1}" 吗？{2}': 'Delete {0} "{1}"?{2}',
    '\n目录将连同内部所有内容一起删除。': '\nThe folder and all its contents will be deleted.',
    '文件': 'File',
    '文件夹': 'Folder',
    '请输入新名称': 'Enter a new name',
    '请输入新文件夹名称': 'Enter a new folder name',
    '输入 ': 'Enter ',
    ' 的值': ' value',

    // ===== 命令收藏提示 =====
    '已收藏命令': 'Command saved',
    '已删除收藏': 'Favorite removed',
    '命令不能为空': 'Command cannot be empty',
    '添加失败': 'Failed to add',
    '命令模板变量不能超过 10 个': 'A command template can have at most 10 variables',
    '发送命令失败': 'Failed to send command',

    // ===== 进度条 =====
    '正在扫描... ({0} 项)': 'Scanning... ({0} items)',
    '正在打包 {0}/{1}{2}': 'Packing {0}/{1}{2}',
    '正在下载{0}...': 'Downloading{0}...',
    '正在上传{0}...': 'Uploading{0}...',
    '正在下载 {0}%{1}': 'Downloading {0}%{1}',
    '正在上传 {0}%{1}': 'Uploading {0}%{1}',

    // ===== 杂项 =====
    '未知错误': 'Unknown error',
    '全部': 'All',
  };

  function format(text, args) {
    if (!args || args.length === 0) return text;
    return text.replace(/\{(\d+)\}/g, (m, d) => {
      const v = args[Number(d)];
      return v === undefined || v === null ? m : String(v);
    });
  }

  // 原文缓存: 支持语言来回切换 (中文模式恢复原文; 英文模式写回译文)
  const origText = new WeakMap();   // textNode -> 原文
  const origAttrs = new WeakMap();  // element  -> { title: 原文, ... }

  function createI18n(opts) {
    const o = opts || {};
    const doc = o.doc || (typeof document !== 'undefined' ? document : null);
    const store = (o.storage && typeof o.storage.getItem === 'function') ? o.storage : null;
    let current = DEFAULT_LANG;

    try {
      const saved = store ? store.getItem(STORAGE_KEY) : null;
      if (saved && LANGS.some((l) => l.id === saved)) current = saved;
    } catch (e) { /* 读取失败用默认语言 */ }

    /** 翻译: 中文模式返回原文; 英文模式查词典, 未收录返回原文 (优雅降级) */
    function t(text, ...args) {
      const key = String(text);
      if (current !== 'en') return format(key, args);
      const hit = EN[key];
      return format(hit === undefined ? key : hit, args);
    }

    function lang() { return current; }

    function setLang(id) {
      if (!LANGS.some((l) => l.id === id) || id === current) return false;
      current = id;
      try { if (store) store.setItem(STORAGE_KEY, id); } catch (e) { /* 忽略持久化失败 */ }
      if (doc && doc.documentElement) doc.documentElement.setAttribute('lang', id === 'zh' ? 'zh-CN' : 'en');
      applyDom(doc);
      if (typeof o.onChange === 'function') o.onChange(id);
      return true;
    }

    function skipped(el) {
      let node = el;
      while (node && node !== doc) {
        if (node.id && SKIP_IDS.indexOf(node.id) !== -1) return true;
        if (node.dataset && node.dataset.i18nSkip === '1') return true;
        node = node.parentNode;
      }
      return false;
    }

    /**
     * 翻译静态界面 (文本节点 + title/placeholder/aria-label 属性), 可逆:
     * - en: 首次翻译时缓存原文, 之后写译文;
     * - zh: 从缓存恢复原文。
     * 跳过用户数据容器 (文件名/连接名/远端输出/动态列表等)。
     */
    function applyDom(root) {
      const scope = root || doc;
      if (!scope || !doc || !doc.createTreeWalker) return;
      const toEn = current === 'en';
      // 文本节点
      const walker = doc.createTreeWalker(scope, 4 /* SHOW_TEXT */, null);
      const nodes = [];
      let n = walker.nextNode();
      while (n) { nodes.push(n); n = walker.nextNode(); }
      for (const node of nodes) {
        const val = node.nodeValue;
        if (!val) continue;
        if (!toEn) {
          const orig = origText.get(node);
          if (orig !== undefined) node.nodeValue = orig;
          continue;
        }
        if (!/[\u4e00-\u9fff]/.test(val)) continue;
        if (skipped(node.parentNode)) continue;
        const core = val.trim();
        if (!core || EN[core] === undefined) continue;
        if (origText.get(node) === undefined) origText.set(node, val);
        const at = val.indexOf(core);
        node.nodeValue = val.slice(0, at) + EN[core] + val.slice(at + core.length);
      }
      // 属性
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        for (const el of scope.querySelectorAll('[' + attr + ']')) {
          let saved = origAttrs.get(el);
          if (!saved) { saved = {}; origAttrs.set(el, saved); }
          if (!toEn) {
            if (saved[attr] !== undefined) el.setAttribute(attr, saved[attr]);
            continue;
          }
          if (skipped(el)) continue;
          const v = el.getAttribute(attr);
          if (!v || EN[v.trim()] === undefined) continue;
          if (saved[attr] === undefined) saved[attr] = v;
          el.setAttribute(attr, EN[v.trim()]);
        }
      }
    }

    return { t, lang, setLang, applyDom, LANGS, STORAGE_KEY, AUDIT_TYPE_LABELS };
  }

  return { createI18n, LANGS, STORAGE_KEY, AUDIT_TYPE_LABELS, EN };
}));
