/**
 * FgmSSH - 渲染进程
 * 负责: 界面交互 / xterm 终端渲染 / 标签页管理 / IPC 桥接 / 侧边栏 SFTP 面板 / 图片预览
 */

// ============ 全局状态 ============
let connections = [];          // 已保存的连接配置
let sessions = new Map();      // sessionId -> session 运行时对象
let sessionCounter = 0;
let activeSessionId = null;
let searchKeyword = '';
let fullscreen = false;
let currentSftpSessionId = null; // 当前在侧边栏 SFTP 面板展示的会话 (全局单一实例)
let ctxMenuTarget = null;        // SFTP 文件右键菜单当前目标 { sessionId, entry }; 菜单关闭时清空

// Roadmap 第三梯队 ①: SFTP 文件搜索/过滤 状态 (面板为全局单一实例, 关键字全局共享)
let sftpSearchKeyword = '';      // 客户端即时过滤关键字 (空 = 显示全部)
let sftpSearchRecursive = false; // 递归搜索开关 (服务端 find)
let sftpSearchTimer = null;      // 递归搜索防抖定时器
let sftpSearchResultsOpen = false; // 递归结果列表是否展开
let updateBadgePayload = null;   // Roadmap 第一梯队 ③ (S): 更新检查结果 (点击打开 releases)

// 内置文档查看器状态: docTabs = docId -> doc 运行时对象; activeDocId 当前显示的文档
let docTabs = new Map();
let activeDocId = null;

// 文档扩展名白名单 (与 main.js DOC_EXTENSIONS 保持一致; 图片走 preview, 不在此列)
const DOC_EXTENSIONS = [
  '.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts',
  '.html', '.css', '.xml', '.conf', '.ini', '.csv',
  '.pdf', '.docx', '.doc',
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============ 工具函数 ============
function genId() { return 's' + (++sessionCounter) + '_' + Date.now().toString(36); }

function toast(message, type = 'info') {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 3200);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 归一化挂载点字符串 (与 src/health-parser.js normalizeMountPath 语义一致, 保证两侧一致):
// 去首尾空白 + 折叠连续空白 + 去尾部斜杠 (保留根 '/')。解析层已归一化返回,
// 此处对防御性过滤再做一次归一化, 兼容旧版主进程响应中未归一化的 mounted。
function normalizeMountPath(s) {
  if (s === undefined || s === null) return '';
  let out = String(s).trim().replace(/\s+/g, ' ');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

// ============ 连接配置存储 ============
async function loadConnections() {
  try {
    connections = await window.nimbus.storeLoad();
    if (!Array.isArray(connections)) connections = [];
  } catch (e) {
    connections = [];
  }
  renderConnectionList();
}

async function persistConnections() {
  try {
    const res = await window.nimbus.storeSave(connections);
    if (res && res.ok === false) {
      toast((res.error) || '连接保存失败', 'error');
      return false;
    }
    return true;
  } catch (e) {
    toast('连接保存失败', 'error');
    return false;
  }
}

// ============ 常用命令收藏 (Roadmap ④, 纯前端) ============
// 复用 src/fav-commands.js 纯逻辑模块 (UMD: 浏览器挂 window.FavCommands):
// - 持久化 localStorage (key: nimbus.favCommands), JSON 数组 [{name, cmd, ts}]
// - 点击收藏项 -> 向「当前活动会话终端」注入命令 (cmd + '\r', shell 回车提交)
// - 支持添加 (名称+命令) 与删除; 空命令不添加; 列表渲染统一 escapeHtml (防 XSS)
const favCommands = window.FavCommands ? window.FavCommands.createFavCommands({
  storage: window.localStorage,
  // 发送目标 = 当前活动会话 (已连接); 未连接时返回 no_session 供调用方 toast
  write: (cmd) => {
    const s = activeSessionId ? sessions.get(activeSessionId) : null;
    if (!s || s.status !== 'connected') {
      return Promise.resolve({ ok: false, error: 'no_session' });
    }
    return window.nimbus.write(s.sessionId, cmd);
  },
}) : null;

// ============ 主题 (Roadmap P2: light/dark/auto) ============
// 复用 src/theme.js 纯逻辑模块 (UMD: 浏览器挂 window.NimbusTheme):
// - 本文件位于 body 末尾, 执行时 documentElement 已就绪, 顶部即 init 尽早设置 data-theme,
//   减少浅色偏好用户的首帧深色闪烁 (CSP 禁内联脚本, 无法在 head 内联执行);
// - 所有活动 xterm 实例在切换时同步 term.setOption('theme', ...) (getTerminals 去重注入);
// - 健康监控 GPU 折线图 (SVG 字符串, 不走 CSS 变量): 切换主题时若面板打开则按新配色重绘。
const themeController = (typeof window !== 'undefined' && window.NimbusTheme)
  ? window.NimbusTheme.initTheme({
      storage: window.localStorage,
      doc: document,
      matchMedia: (q) => window.matchMedia(q),
      getTerminals: () => {
        const seen = new Set();
        const terms = [];
        sessions.forEach((s) => {
          if (s && s.term && !seen.has(s.term)) { seen.add(s.term); terms.push(s.term); }
        });
        return terms;
      },
      button: document.getElementById('btnTheme'),
      onThemeChange: () => {
        // 健康监控面板打开时按新主题重绘 GPU 折线图 (配色由 JS 注入, 非 CSS 变量)。
        // 自含 try/catch: 顶部 init 阶段 monitorPanelSessionId 可能尚未初始化 (TDZ)。
        try {
          if (monitorPanelSessionId) refreshMonitor(false);
        } catch (e) { /* 忽略: 初始化阶段面板尚未就绪 */ }
      },
    })
  : null;

// 构建 GPU 折线图绘制参数: 按当前主题注入配色 (缺省 undefined -> gpu-chart 回退深色常量)
function buildGpuChartOpts() {
  if (!themeController || typeof window === 'undefined' || !window.NimbusTheme) return undefined;
  const chartColors = window.NimbusTheme.CHART_COLORS;
  if (!chartColors) return undefined;
  const theme = themeController.currentTheme();
  return { colors: chartColors[theme] || chartColors.dark };
}

// Roadmap 第三梯队 ①: SFTP 文件搜索/过滤 纯逻辑模块 (UMD, index.html 已先加载;
// 测试沙箱未加载时降级 null, 相关功能自动退化为不启用)
const fileFilterApi = (typeof window !== 'undefined' && window.FileFilter) || null;
// Roadmap 第一梯队 ③ (M): 文本编辑增强 (语法高亮 tokenizer + 分段加载判定; 同上降级)
const editorHighlightApi = (typeof window !== 'undefined' && window.EditorHighlight) || null;

// 渲染收藏列表 (favList 事件委托在 init 中绑定一次, 防重复绑定)
function renderFavList() {
  const listEl = $('#favList');
  if (!listEl || !favCommands) return;
  listEl.innerHTML = favCommands.renderList(favCommands.load());
}

function toggleFavPanel() {
  const panel = $('#favPanel');
  if (!panel) return;
  if (panel.style.display === 'flex') {
    panel.style.display = 'none';
  } else {
    renderFavList();
    panel.style.display = 'flex';
    $('#favCmdInput').focus();
  }
}

function closeFavPanel() {
  const panel = $('#favPanel');
  if (panel) panel.style.display = 'none';
}

// 点击收藏项发送命令到当前活动会话终端
function sendFavCommand(ts) {
  const list = favCommands ? favCommands.load() : [];
  const item = list.find((it) => it.ts === Number(ts));
  if (!item) return;
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!s || s.status !== 'connected') {
    toast('请先连接会话', 'info');
    return;
  }
  favCommands.send(item.cmd).then((res) => {
    if (res && res.ok === false && res.error === 'no_session') {
      toast('请先连接会话', 'info');
    } else if (res && res.ok === false) {
      toast('发送命令失败', 'error');
    }
  }).catch(() => {});
}

// 添加收藏: 空命令不添加
function addFavCommand() {
  if (!favCommands) return;
  const name = $('#favNameInput').value.trim();
  const cmd = $('#favCmdInput').value;
  if (!cmd || !cmd.trim()) {
    toast('命令不能为空', 'error');
    $('#favCmdInput').focus();
    return;
  }
  const res = favCommands.add(name, cmd);
  if (!res.ok) {
    toast(res.error === 'empty_cmd' ? '命令不能为空' : '添加失败', 'error');
    return;
  }
  $('#favNameInput').value = '';
  $('#favCmdInput').value = '';
  renderFavList();
  toast('已收藏命令', 'success');
}

// 删除收藏
function deleteFavCommand(ts) {
  if (!favCommands) return;
  favCommands.remove(Number(ts));
  renderFavList();
  toast('已删除收藏', 'info');
}

// ============ 配置加密导出/导入 (Roadmap ⑤) ============
// 交互: 连接抽屉「导出配置 / 导入配置」-> 密码弹窗 -> 主进程完成
// (对话框 + AES-256-GCM 加解密 + 落盘), 渲染层只负责输密码与展示结果。
// 导入策略: 全量替换 (导入后覆盖现有连接配置), 弹窗前 confirm 提示。
let configPwdAction = null; // 'export' | 'import'

function openConfigPwdModal(action) {
  configPwdAction = action;
  $('#configPwdTitle').textContent = action === 'export' ? '导出配置 - 设置加密密码' : '导入配置 - 输入解密密码';
  $('#configPwdHint').textContent = action === 'export'
    ? '备份文件将使用 AES-256-GCM 加密，导入时需输入相同密码。请妥善保管该密码。'
    : '请输入导出备份时设置的密码。密码错误将无法解密。';
  $('#configPwdInput').value = '';
  $('#configPwdModal').style.display = 'flex';
  $('#configPwdInput').focus();
}

function closeConfigPwdModal() {
  $('#configPwdModal').style.display = 'none';
  configPwdAction = null;
}

// 密码弹窗确定: 调主进程 IPC (对话框在 main 内完成)
async function confirmConfigPwd() {
  const action = configPwdAction;
  const password = $('#configPwdInput').value;
  if (!action) return;
  if (!password) {
    toast('请输入密码', 'error');
    $('#configPwdInput').focus();
    return;
  }
  closeConfigPwdModal();
  if (action === 'export') {
    let res;
    try {
      res = await window.nimbus.configExport(password);
    } catch (err) {
      toast('导出异常: ' + (err.message || '未知错误'), 'error');
      return;
    }
    if (res && res.ok) {
      toast(`配置已导出 (${res.count} 条连接)`, 'success');
    } else {
      toast((res && res.error) || '导出失败', 'error');
    }
  } else {
    // 导入: 全量替换确认提示
    if (!confirm('导入将覆盖当前全部连接配置，确定继续吗？')) return;
    let res;
    try {
      res = await window.nimbus.configImport(password);
    } catch (err) {
      toast('导入异常: ' + (err.message || '未知错误'), 'error');
      return;
    }
    if (res && res.ok) {
      toast(`配置已导入 (${res.count} 条连接)`, 'success');
      await loadConnections(); // 刷新渲染层连接列表
    } else {
      toast((res && res.error) || '导入失败', 'error');
    }
  }
}

// ============ 连接抽屉 (侧边栏底部滑出) ============
function openConnDrawer() {
  $('#connDrawer').classList.add('open');
  $('#btnConnections').classList.add('active');
}

function closeConnDrawer() {
  $('#connDrawer').classList.remove('open');
  $('#btnConnections').classList.remove('active');
}

function toggleConnDrawer() {
  const drawer = $('#connDrawer');
  if (drawer.classList.contains('open')) closeConnDrawer();
  else openConnDrawer();
}

// 渲染连接列表到抽屉容器, 并更新侧边栏入口的计数徽标
function renderConnectionList() {
  const list = $('#connDrawerList');
  const keyword = searchKeyword.toLowerCase();
  const filtered = connections.filter((c) =>
    !keyword || c.name.toLowerCase().includes(keyword) || c.host.toLowerCase().includes(keyword)
  );

  // 更新入口按钮计数徽标
  const badge = $('#connCountBadge');
  if (badge) badge.textContent = String(connections.length);

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-list-hint" style="text-align:center;color:var(--text-faint);padding:24px 10px;font-size:12px;">${
      connections.length === 0 ? '暂无保存的连接' : '没有匹配的连接'
    }</div>`;
    return;
  }

  list.innerHTML = filtered.map((c) => {
    const isActive = sessions.has(c.id);
    return `
      <div class="conn-item ${isActive ? 'active' : ''}" data-conn-id="${c.id}" title="连接 ${c.host}:${c.port}">
        <div class="conn-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 10h5M7 14h8"/>
          </svg>
        </div>
        <div class="conn-info">
          <div class="conn-name">${escapeHtml(c.name)}</div>
          <div class="conn-detail">${escapeHtml(c.username)}@${escapeHtml(c.host)}:${c.port}</div>
        </div>
        <button class="conn-del" data-del-id="${c.id}" title="删除连接">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>`;
  }).join('');

  // 事件绑定: 点击连接 -> 打开/切换会话并收起抽屉
  list.querySelectorAll('.conn-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.conn-del')) return;
      const conn = connections.find((c) => c.id === item.dataset.connId);
      if (conn) {
        openSession(conn);
        closeConnDrawer();
      }
    });
  });
  list.querySelectorAll('.conn-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const conn = connections.find((c) => c.id === id);
      if (conn && confirm(`确定删除连接 "${conn.name}" 吗？`)) {
        // 如已连接则先断开
        if (sessions.has(id)) closeSession(id);
        connections = connections.filter((c) => c.id !== id);
        persistConnections();
        renderConnectionList();
        toast('连接已删除', 'info');
      }
    });
  });
}

// ============ 终端实例管理 ============
// 默认 xterm 主题 (深色): 与 src/theme.js XTERM_THEMES.dark 完全一致 (回归不破坏),
// 仅在主题控制器未初始化 / 异常时作为 fallback (与旧版硬编码行为一致)。
const DEFAULT_TERM_THEME = {
  background: '#0e1116',
  foreground: '#e6eaf0',
  cursor: '#4f8cff',
  cursorAccent: '#0e1116',
  selectionBackground: 'rgba(79, 140, 255, 0.35)',
  black: '#0e1116', red: '#ff5d5d', green: '#3ecf8e', yellow: '#f5b64c',
  blue: '#5f9aff', magenta: '#c792ea', cyan: '#4dd0e1', white: '#e6eaf0',
  brightBlack: '#5c6673', brightRed: '#ff8a8a', brightGreen: '#6ee7b7',
  brightYellow: '#ffd87d', brightBlue: '#8ab8ff', brightMagenta: '#dcb0ff',
  brightCyan: '#8be9fd', brightWhite: '#ffffff',
};

// 当前生效的 xterm 主题: 跟随主题控制器 (themeController.currentTheme() ->
// window.NimbusTheme.XTERM_THEMES[theme])。v1.1.0 修复: 浅色主题下新建终端不再硬编码
// 深色, 而是使用浅色主题 (白底深字, ANSI 16 色可读); 主题未初始化/异常时回退深色。
function currentXtermTheme() {
  if (typeof window === 'undefined' || !window.NimbusTheme || !themeController) {
    return DEFAULT_TERM_THEME;
  }
  const themes = window.NimbusTheme.XTERM_THEMES;
  if (!themes) return DEFAULT_TERM_THEME;
  const theme = themeController.currentTheme();
  return themes[theme] || themes.dark || DEFAULT_TERM_THEME;
}

function createTerminal() {
  const term = new window.Terminal({
    fontFamily: '"Cascadia Code", "Consolas", "JetBrains Mono", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'block',
    theme: currentXtermTheme(),
    scrollback: 5000,
    allowProposedApi: true,
    convertEol: false,
  });
  return term;
}

// ============ 终端安全 fit (防御性加固 + 尺寸基准修正) ============
// 背景:
// - fitAddon.fit() 在容器宽度为 0 / 布局尚未稳定时, 会静默计算出无效的 cols (甚至 cols=0);
//   xterm 拿到 cols=0 后渲染器将停止绘制 canvas, 导致终端内容消失, 且后续 layout 稳定后不会自动恢复。
// - FitAddon.proposeDimensions() 以 term.element.parentElement 的 computed height/width 为基准,
//   而 box-sizing:border-box 元素的 computed height 是「含 padding 的整盒高度」, 且它只减去
//   xterm 元素自身的 padding (恒为 0)。若直接把带 padding 的 .terminal-host 当作 fit 基准,
//   rows 会按「含 padding 的整盒高度」计算, 使 .xterm-screen 高度与真实内容区不一致;
//   普通/全屏模式 padding 不同, 偏差还会随切换漂移, 造成内容整体下移。
// 方案:
// 1) 渲染层新增 .terminal-content 无 padding 挂载点 (height:100%), xterm 挂载其上,
//    FitAddon 测量到的就是真实内容区 (padding 不再污染 rows/cols 计算);
// 2) fitSafe 前置校验与尺寸指纹统一用 getTerminalContentSize(hostEl) (client* 减 padding),
//    判定基准与 fit 基准完全一致;
// 3) fit 后双校验 (proposeDimensions 对照), 布局中间态算出的行列与内容区不匹配时补一次 fit;
// 4) 尺寸指纹记忆: 行列与内容区尺寸均未变化时跳过 refresh, 避免无谓 canvas 重排引入累积误差;
// 5) viewport 重置: fit 实际执行后重置 .xterm-viewport 滚动位置, 消除残余滚动偏移;
// 6) syncScreenToContent 统一入口: openSession / activateSession / 全屏切换 / 拖拽结束 /
//    窗口 resize 后均执行「fit + viewport 重置」。
//
// 根因补充 (2026-08-11, CDP 实测确认): 「终端内容整体下移」的真因是 xterm.css 从未被引入 ——
// xterm 官方要求手动引入 @xterm/xterm/css/xterm.css, 其中的 .xterm .xterm-viewport{position:absolute}
// 与 .xterm .xterm-screen{position:relative} 是核心定位规则。缺失时 viewport 退化为 static
// 文档流 (height=实际内容高), 把 screen 整体向下推, 表现为终端内容下移。
// 修复: index.html 在 style.css 之前引入 xterm.css。引入后 viewport/screen 定位由 xterm
// 官方 CSS 管理, 之前「强制 screen.style.height = 内容区高度」的补丁已无必要 (该补丁会与
// xterm 内部 _updateDimensions 的 rows×lineHeight 计算拉锯, 反而可能抖动), 已移除,
// 仅保留 viewport.scrollTop=0 重置。style.css 的 .terminal-host{padding:0 12px 8px} 保留。
const FIT_RETRY_DELAY = 80;  // 重试间隔 (ms)
const FIT_MAX_RETRY = 3;     // 最大重试次数 (防无限循环)

// 计算 hostEl 的真实内容区尺寸 (排除 padding; client* 含 padding 但不含 border/滚动条)
function getTerminalContentSize(hostEl) {
  if (!hostEl || !hostEl.isConnected) return null;
  const style = window.getComputedStyle(hostEl);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const width = hostEl.clientWidth - padX;
  const height = hostEl.clientHeight - padY;
  if (!isFinite(width) || !isFinite(height)) return null;
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// 内容区尺寸指纹: 宽高取整拼接, 用于判断容器尺寸是否真的变化
function contentSizeKey(size) {
  if (!size) return null;
  return Math.round(size.width) + 'x' + Math.round(size.height);
}

// 下一帧布局稳定后执行 (双 rAF, 确保已越过本轮 style/layout/paint, 读到的是新布局尺寸)
function afterLayout(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function fitSafe(session, retryLeft = FIT_MAX_RETRY) {
  if (!session || !session.fitAddon || !session.term || !session.hostEl) return;
  // 容器已从 DOM 移除 (会话已关闭) -> 直接放弃, 无需重试
  if (!document.contains(session.hostEl)) return;
  // 前置校验: 统一以「内容区」(排除 padding) 尺寸为准, 隐藏/布局未稳定 -> 延迟重试
  const contentSize = getTerminalContentSize(session.hostEl);
  if (!contentSize || contentSize.width < 1 || contentSize.height < 1) {
    if (retryLeft > 0) setTimeout(() => fitSafe(session, retryLeft - 1), FIT_RETRY_DELAY);
    return;
  }
  try {
    session.fitAddon.fit();
  } catch (e) {
    console.warn('[fitSafe] fit() 异常:', e);
    if (retryLeft > 0) setTimeout(() => fitSafe(session, retryLeft - 1), FIT_RETRY_DELAY);
    return;
  }
  // 校验 fit 结果: cols/rows 必须有效, 否则延迟重试 (防 xterm 渲染空白)
  if (session.term.cols <= 0 || session.term.rows <= 0) {
    console.warn(`[fitSafe] fit() 结果非法 cols=${session.term.cols} rows=${session.term.rows}, 延迟重试`);
    if (retryLeft > 0) setTimeout(() => fitSafe(session, retryLeft - 1), FIT_RETRY_DELAY);
    return;
  }
  // 双校验: 若 fit 发生在布局中间态, 其行列与当前内容区推算值不一致 -> 补一次 fit
  try {
    const expected = session.fitAddon.proposeDimensions();
    if (expected && (expected.cols !== session.term.cols || expected.rows !== session.term.rows)) {
      session.fitAddon.fit();
    }
  } catch (e) {}
  // 尺寸指纹: 行列与内容区尺寸均未变化 -> 幂等跳过 refresh (避免无谓重排引入累积误差)
  const fitKey = `${session.term.cols}x${session.term.rows}`;
  const contentKey = contentSizeKey(contentSize);
  if (session.lastFitKey === fitKey && session.lastContentKey === contentKey) {
    return;
  }
  session.lastFitKey = fitKey;
  session.lastContentKey = contentKey;
  // viewport 重置: 仅在 fit 实际执行且尺寸变化后做 (幂等跳过分支保持不变)
  alignScreenToContent(session.hostEl, session.term);
  // 强制触发 xterm 重绘, 确保 fit 后 canvas 内容可见
  try { session.term.refresh(0, session.term.rows - 1); } catch (e) {}
}

// viewport 滚动重置: fit 后 .xterm-viewport 可能残留非零 scrollTop, 导致首行被推下/遮住,
// 统一重置为 0。
// 注: 2026-08-11 修复前曾在此强制 screen.style.height = 内容区高度, 那是 xterm.css 缺失
//     (viewport 为 static 把 screen 下推) 时的错误层级补丁; 引入 xterm.css 后 screen 高度由
//     xterm 内部 _updateDimensions 按 rows × lineHeight 自我管理, 强制覆盖反而会与其拉锯,
//     已移除。仅保留 scrollTop 重置 (xterm 不在 fit 时主动清零, 残留滚动仍需兜底)。
function alignScreenToContent(hostEl, term) {
  if (!hostEl || !term || !term.element) return;
  const viewport = term.element.querySelector('.xterm-viewport');
  if (viewport) viewport.scrollTop = 0;
}

// 终端尺寸同步统一入口: fit + viewport 重置
// 在 openSession / activateSession / toggleFullscreen / 拖拽结束 / 窗口 resize 后调用
// 注: fitSafe 内部已在 fit 实际执行且尺寸变化后做 viewport 重置; 此处再兜底执行一次,
//     确保「幂等跳过分支」(行列与内容区尺寸均未变化) 时也能修正 viewport 滚动残留等漂移。
function syncScreenToContent(session) {
  if (!session || !session.hostEl || !session.term) return;
  fitSafe(session);
  alignScreenToContent(session.hostEl, session.term);
}

// 遍历所有会话对终端执行 fit (窗口尺寸变化 / 侧边栏宽度拖拽结束后调用)
function fitAllTerminals() {
  const seen = new Set();
  sessions.forEach((session) => {
    if (seen.has(session)) return;
    seen.add(session);
    if (session.fitAddon && session.hostEl && document.contains(session.hostEl)) {
      syncScreenToContent(session);
    }
  });
}

// 仅对当前活动会话执行 fit (统一走 syncScreenToContent 保护, 含 viewport 重置)
function fitActiveTerminal() {
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  if (s && s.fitAddon) syncScreenToContent(s);
}

// 全屏切换: 切 class -> 等下一帧布局稳定 -> fitSafe (含双校验与尺寸指纹, 幂等)
function toggleFullscreen() {
  fullscreen = !fullscreen;
  document.body.classList.toggle('terminal-fullscreen', fullscreen);
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (s) afterLayout(() => syncScreenToContent(s));
}

// ============ 会话管理 ============
async function openSession(connConfig) {
  const sessionId = genId();
  const connId = connConfig.id || null;

  // 若该连接已有活动会话, 则切换到该标签
  if (connId && sessions.has(connId)) {
    const existing = sessions.get(connId);
    activateSession(existing.sessionId);
    return;
  }

  // 创建 DOM 容器
  const hostEl = document.createElement('div');
  hostEl.className = 'terminal-host';
  hostEl.id = 'host-' + sessionId;

  // xterm 内容区挂载点: 无 padding, height:100%, 作为 fit 尺寸测量基准 (见 fitSafe 注释)
  const contentEl = document.createElement('div');
  contentEl.className = 'terminal-content';
  hostEl.appendChild(contentEl);

  const overlay = document.createElement('div');
  overlay.className = 'term-overlay';
  overlay.innerHTML = `
    <div class="overlay-spinner"></div>
    <div class="overlay-text">正在连接 ${escapeHtml(connConfig.username)}@${escapeHtml(connConfig.host)}:${connConfig.port} ...</div>
  `;
  hostEl.appendChild(overlay);

  $('#terminalArea').appendChild(hostEl);
  $('#terminalArea').style.display = 'flex';
  $('#emptyState').style.display = 'none';
  $('#statusbar').style.display = 'flex';

  // 创建终端
  const term = createTerminal();
  const fitAddon = new window.FitAddon.FitAddon();
  const webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(contentEl);
  term.focus();

  // 会话对象 (SFTP 面板为全局单一实例, fileEl 指向侧边栏 #sftpPanel)
  const session = {
    sessionId,
    connId,
    term,
    fitAddon,
    hostEl,
    overlay,
    name: connConfig.name || `${connConfig.username}@${connConfig.host}`,
    config: { ...connConfig },
    status: 'connecting',
    buffer: '',             // 缓冲等待 ready 前用户输入
    inputBuffer: '',        // 终端输入行缓冲 (R3: 旁路监听完整 cd 命令行, 不影响 write 透传)
    fileEl: $('#sftpPanel'), // 全局 SFTP 面板 DOM (侧边栏内, 所有会话共用)
    currentPath: '/',       // SFTP 当前路径 (按会话保存)
    history: ['/'],         // SFTP 浏览历史 (按会话保存)
    historyIndex: 0,        // 历史索引 (后退)
    fileEntries: [],        // 当前目录条目
    fileEntryMap: null,     // name -> entry 索引 (事件委托用)
    fileReqSeq: 0,          // 目录加载请求序号 (竞态防护)
  };

  // 初次 fit + viewport 重置: 统一走 syncScreenToContent 保护 (校验容器尺寸与 cols/rows,
  // 非法自动延迟重试), 确保下方 connect 上报的 rows/cols 为有效值, 避免首次渲染空白/偏移
  syncScreenToContent(session);

  sessions.set(sessionId, session);
  if (connId) sessions.set(connId, session);

  addTab(session);
  activateSession(sessionId);
  updateStatus('connecting', `正在连接 ${connConfig.host}:${connConfig.port} ...`);

  // 终端输入 -> 主进程 (原样透传; R3 旁路监听 cd 同步, 不影响回显/交互)
  term.onData((data) => {
    if (session.status === 'connected') {
      window.nimbus.write(sessionId, data);
      handleTerminalInputLine(session, data);
    } else {
      session.buffer += data;
    }
  });

  // 调整大小 (ResizeObserver 覆盖窗口缩放 / 侧边栏宽度拖拽导致的容器变化)
  // 拖拽侧边栏期间跳过 fit: 由 pointerup 结束拖拽时统一 syncScreenToContent, 防止每帧 fit 破坏 xterm 状态
  const ro = new ResizeObserver(() => {
    if (document.body.classList.contains('is-resizing')) return;
    syncScreenToContent(session);
  });
  ro.observe(hostEl);
  syncScreenToContent(session);

  // 提交连接
  try {
    await window.nimbus.connect(sessionId, {
      host: connConfig.host,
      port: connConfig.port,
      username: connConfig.username,
      authMethod: connConfig.authMethod || 'password',
      connId: connConfig.id || null,
      password: connConfig.password || '',
      privateKeyPath: connConfig.privateKeyPath || '',
      passphrase: connConfig.passphrase || '',
      rows: term.rows,
      cols: term.cols,
      // 隧道配置随连接透传: 主进程在连接成功后自动建立 (失败不阻塞连接)
      tunnels: Array.isArray(connConfig.tunnels) ? connConfig.tunnels : [],
      // 断线自动重连 (Roadmap 第一梯队 ①): 每连接配置, 默认开 (主进程 autoReconnect !== false)
      autoReconnect: connConfig.autoReconnect,
      autoReconnectMaxAttempts: connConfig.autoReconnectMaxAttempts,
      // 主机密钥指纹校验 (Roadmap 第一梯队 ②, TOFU): 默认开 (主进程 hostKeyVerify !== false)
      hostKeyVerify: connConfig.hostKeyVerify !== false,
    });
  } catch (e) {
    setSessionError(session, '无法发起连接: ' + e.message);
  }
}

function addTab(session) {
  const tab = document.createElement('div');
  tab.className = 'tab connecting';
  tab.id = 'tab-' + session.sessionId;
  tab.dataset.sessionId = session.sessionId;
  tab.innerHTML = `
    <span class="tab-dot"></span>
    <span class="tab-name">${escapeHtml(session.name)}</span>
    <button class="tab-close" title="关闭">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) return;
    activateSession(session.sessionId);
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(session.sessionId);
  });
  session.tabEl = tab;
  $('#tabs').appendChild(tab);
}

function activateSession(sessionId) {
  if (!sessions.has(sessionId)) return;
  activeSessionId = sessionId;
  const session = sessions.get(sessionId);

  // 标签高亮
  $$('.tab').forEach((t) => t.classList.remove('active'));
  session.tabEl.classList.add('active');

  // 主区域只显示终端: 隐藏文档查看器, 恢复 terminalArea 容器
  $('#docViewer').style.display = 'none';
  $('#terminalArea').style.display = 'flex';
  $$('.terminal-host').forEach((h) => (h.style.display = 'none'));
  session.hostEl.style.display = 'block';
  // 下一帧布局稳定后再 fit + focus: 避免 display 切换瞬间容器尺寸未就绪导致 fit 落空/错位
  afterLayout(() => { syncScreenToContent(session); session.term.focus(); });

  // 侧边栏 SFTP 面板跟随活动会话 (已连接则加载其目录, 否则占位)
  showSftpFor(sessionId);

  // 状态栏
  const conn = session.config;
  $('#statusSession').textContent = `${conn.username}@${conn.host}:${conn.port}`;
  const dot = $('#statusDot');
  const isConnecting = session.status === 'connecting' || session.status === 'reconnecting';
  dot.className = 'status-dot ' + (session.status === 'connected' ? 'ok' : isConnecting ? 'connecting' : 'error');
  $('#statusText').textContent =
    session.status === 'connected' ? '已连接' :
    session.status === 'connecting' ? '连接中...' :
    session.status === 'reconnecting' ? '重连中...' :
    session.status === 'error' ? '连接失败' : '已断开';
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try { await window.nimbus.disconnect(sessionId); } catch (e) {}

  // 关闭该会话关联的文档标签 (docViewer 正在显示的文档一并关闭; 会话关闭后文档无法保存/重开)
  const relatedDocIds = [...docTabs.entries()]
    .filter(([, doc]) => doc.sessionId === sessionId)
    .map(([docId]) => docId);
  for (const docId of relatedDocIds) {
    await closeDocTab(docId);
  }

  // 若图片预览正展示该会话的图片, 一并关闭并清理临时文件
  if (previewState.sessionId === sessionId) closePreview();

  // 清理预览缓存中该会话的所有条目, 释放 blobUrl 内存
  for (const key of Array.from(previewCache.keys())) {
    if (key.startsWith(sessionId + ':')) {
      const entry = previewCache.get(key);
      if (entry && entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
      previewCache.delete(key);
    }
  }

  // 清理 (SFTP 面板为全局实例, 无需移除 DOM)
  if (session.connId) sessions.delete(session.connId);
  sessions.delete(sessionId);
  session.tabEl.remove();
  session.hostEl.remove();

  // 更新抽屉连接列表高亮与计数
  renderConnectionList();

  if (activeSessionId === sessionId) {
    activeSessionId = null;
    const remaining = [...sessions.keys()].filter((k) => !k.startsWith('c_'));
    if (remaining.length > 0) {
      activateSession(remaining[remaining.length - 1]);
    } else {
      $('#terminalArea').style.display = 'none';
      $('#emptyState').style.display = 'flex';
      $('#statusbar').style.display = 'none';
      // SFTP 面板回到占位
      showSftpFor(null);
    }
  }

  // 防御: 若关闭的会话恰好是 SFTP 面板当前展示对象, 同步面板 (正常由 activateSession 完成)
  if (currentSftpSessionId === sessionId) showSftpFor(activeSessionId);
}

function setSessionError(session, message) {
  session.status = 'error';
  session.overlay.innerHTML = `
    <div class="overlay-error">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:block;margin:0 auto 10px;"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      ${escapeHtml(message)}
    </div>
  `;
  session.tabEl.classList.remove('connecting');
  session.tabEl.classList.add('error');
  updateStatus('error', '连接失败');
  // 焦点守卫 (与 ready 分支一致): 文档查看器可见时, 后台会话报错不抢焦点, 仅标签标记为 error;
  // 若当前无文档查看器显示, 则正常切换展示错误
  if (!shouldSkipSessionFocus()) {
    activateSession(session.sessionId);
  }
  toast(message, 'error');
}

// 判断是否应跳过 activateSession 抢焦点:
// - 文档查看器当前可见 (activeDocId + docViewer 非 none): 后台会话 ready/error 不应打断用户阅读
// 用户主动点击标签时 tab 已带 active, 此处放行 activateSession (用户意图优先)
function shouldSkipSessionFocus() {
  const docViewerVisible = activeDocId && $('#docViewer').style.display !== 'none';
  return docViewerVisible;
}

function updateStatus(state, text) {
  const dot = $('#statusDot');
  dot.className = 'status-dot ' + state;
  $('#statusText').textContent = text;
}

// ============ 断线自动重连 UI (Roadmap 第一梯队 ①) ============
// 主进程意外断开时发送 reconnect-status 事件:
//   {status:'connecting'|'attempt'|'waiting'|'failed', attempt, maxAttempts} -> 重连中 overlay
//   {status:'gaveup', error?}                                                  -> 重连失败 overlay
//   {status:'success'} 由随后的 ready 事件接管 (ready 会移除 overlay); canceled 由 closeSession 清理
// 重连成功后主进程重新挂接 stream, 渲染层 onData 仍写同一 xterm 实例 (session 模型复用)。

// 展示「已断开 · 重连中 (N/M)」终端 overlay + 标签/状态栏更新
function showReconnectOverlay(session, attempt, maxAttempts) {
  session.status = 'reconnecting';
  const n = Math.max(1, Number(attempt) || 1);
  const m = Math.max(1, Number(maxAttempts) || 5);
  if (session.overlay) session.overlay.remove();
  session.overlay = document.createElement('div');
  session.overlay.className = 'term-overlay';
  session.overlay.innerHTML = `
    <div class="overlay-reconnect">
      <div class="overlay-spinner"></div>
      <div class="overlay-reconnect-text">已断开 · 重连中 (${n}/${m})</div>
    </div>
  `;
  session.hostEl.appendChild(session.overlay);
  session.tabEl.classList.remove('connected');
  session.tabEl.classList.add('connecting');
  updateStatus('connecting', `重连中 (${n}/${m})`);
  // SFTP 面板回到占位 (会话未就绪, 避免对已断开会话发起目录请求)
  if (activeSessionId === session.sessionId) showSftpFor(session.sessionId);
}

// 展示「重连失败」终端 overlay + 标签/状态栏更新 (放弃重连后由主进程清理会话记录)
function showReconnectFailed(session, error) {
  session.status = 'error';
  if (session.overlay) session.overlay.remove();
  session.overlay = document.createElement('div');
  session.overlay.className = 'term-overlay';
  session.overlay.innerHTML = `
    <div class="overlay-error">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:block;margin:0 auto 10px;"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      ${escapeHtml(error ? ('重连失败：' + error) : '重连失败')}
    </div>
  `;
  session.hostEl.appendChild(session.overlay);
  session.tabEl.classList.remove('connecting');
  session.tabEl.classList.add('error');
  updateStatus('error', '重连失败');
  toast(error ? ('重连失败：' + error) : '重连失败', 'error');
}

// ============ 主机密钥指纹校验弹窗 (TOFU, 防中间人) ============
// 多会话并发安全: hostKeyDialogs 按 sessionId 排队, 同一时刻只展示一个弹窗;
// 用户响应时只解决当前展示的会话 (hostKeyActiveSession), 再展示下一个待确认项。
// Esc / 遮罩点击 / 关闭按钮 = 拒绝 (hostKeyReject)。
const hostKeyDialogs = new Map(); // sessionId -> payload (confirm | mismatch)
let hostKeyActiveSession = null;  // 当前正在展示的会话 ID

function getHostKeyModal() { return $('#hostKeyModal'); }

// 展示下一个待确认的主机密钥弹窗 (无待确认则隐藏)
function showNextHostKeyDialog() {
  const first = hostKeyDialogs.keys().next();
  if (first.done) {
    hostKeyActiveSession = null;
    getHostKeyModal().style.display = 'none';
    return;
  }
  hostKeyActiveSession = first.value;
  const p = hostKeyDialogs.get(hostKeyActiveSession);
  if (!p) { hostKeyDialogs.delete(hostKeyActiveSession); showNextHostKeyDialog(); return; }
  renderHostKeyDialog(p);
  getHostKeyModal().style.display = 'flex';
}

// 将 confirm/mismatch 事件入队并展示 (队列保证多会话并发不串台)
function queueHostKeyDialog(payload) {
  if (!payload || !payload.sessionId) return;
  hostKeyDialogs.set(payload.sessionId, payload);
  if (!hostKeyActiveSession) showNextHostKeyDialog();
}

// 渲染弹窗内容 (首次确认 / 不匹配警告两种形态)
function renderHostKeyDialog(p) {
  const mismatch = !!p.storedSha256 || p.mismatch === true;
  const modal = getHostKeyModal();
  modal.classList.toggle('mismatch', mismatch);
  $('#hostKeyTitle').textContent = mismatch ? '⚠️ 主机密钥不匹配' : '首次连接 · 确认主机密钥';
  $('#hostKeyWarning').style.display = mismatch ? 'flex' : 'none';
  $('#hostKeyHost').textContent = `${p.host}:${p.port}`;
  $('#hostKeyAlgo').textContent = p.algorithm || 'unknown';
  $('#hostKeySha').textContent = p.sha256 || '';
  $('#hostKeyMd5').textContent = p.md5 || '';
  const storedWrap = $('#hostKeyStoredWrap');
  if (mismatch) {
    storedWrap.style.display = '';
    $('#hostKeyStoredAlgo').textContent = p.storedAlgorithm || 'unknown';
    $('#hostKeyStoredSha').textContent = p.storedSha256 || '';
  } else {
    storedWrap.style.display = 'none';
  }
  const hint = $('#hostKeyHint');
  if (mismatch) {
    hint.innerHTML = '如确认是服务器端密钥更换 (而非攻击), 可信任新指纹继续连接; 否则请选择「拒绝连接」。';
  } else {
    hint.innerHTML = '首次连接到此主机。请通过可信渠道比对服务器指纹 (例如: <code>ssh-keyscan -t ed25519 ' +
      escapeHtml(String(p.host || '')) + '</code>), 确认无误后再信任。';
  }
  $('#hostKeyAcceptBtn').textContent = mismatch ? '信任新指纹并继续' : '信任并连接';
}

// 关闭当前弹窗并解决 (accept=true -> hostkey:accept, 否则 hostkey:reject)
function resolveHostKeyDialog(accept, override) {
  const sessionId = hostKeyActiveSession;
  if (!sessionId) return;
  hostKeyDialogs.delete(sessionId);
  if (accept) {
    window.nimbus.hostKeyAccept(sessionId, !!override);
  } else {
    window.nimbus.hostKeyReject(sessionId);
  }
  hostKeyActiveSession = null;
  showNextHostKeyDialog();
}

// ============ 主进程事件 ============
function wireIPC() {
  // 主机密钥指纹校验 (TOFU): 首次连接确认 / 不匹配危险警告 (按 sessionId 排队)
  window.nimbus.onHostKeyConfirm((payload) => queueHostKeyDialog(payload));
  window.nimbus.onHostKeyMismatch((payload) => queueHostKeyDialog(Object.assign({ mismatch: true }, payload)));

  // 终端数据
  window.nimbus.onData(({ sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (session) session.term.write(data);
  });

  // 事件
  window.nimbus.onEvent(({ sessionId, type, message, ...rest }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (type === 'ready') {
      session.status = 'connected';
      session.overlay.remove();
      session.tabEl.classList.remove('connecting');
      session.tabEl.classList.add('connected');
      updateStatus('ok', '已连接');
      // 焦点守卫: 文档查看器可见时 -> 不调用 activateSession,
      // 仅更新标签状态, 避免后台终端 ready 抢焦点把刚打开的文档查看器隐藏 (回归 P1)
      if (!shouldSkipSessionFocus()) {
        activateSession(sessionId);
      }
      // 发送缓冲的输入
      if (session.buffer) {
        window.nimbus.write(sessionId, session.buffer);
        session.buffer = '';
      }
      toast(`已连接到 ${session.config.host}`, 'success');
      // 连接成功: 主进程已自动建立该连接配置中的隧道, 面板打开时刷新一次
      if ($('#tunnelOverlay').style.display === 'flex') refreshTunnelList();
    } else if (type === 'error') {
      setSessionError(session, message);
    } else if (type === 'reconnect-status') {
      // 断线自动重连状态 (主进程意外断开/重连尝试/放弃)
      const st = rest && rest.status;
      const attempt = (rest && rest.attempt) || 0;
      const maxAttempts = (rest && rest.maxAttempts) || 5;
      if (st === 'connecting' || st === 'attempt' || st === 'waiting' || st === 'failed') {
        // 重连中 (含下一轮退避等待): 统一展示「已断开 · 重连中 (N/M)」
        if (session.status === 'connected' || session.status === 'closed' || session.status === 'error' || session.status === 'reconnecting') {
          showReconnectOverlay(session, attempt, maxAttempts);
        }
      } else if (st === 'gaveup') {
        showReconnectFailed(session, rest.error);
      }
      // 'success' 由随后的 ready 事件接管; 'canceled' 由 closeSession 清理, 均无需处理
    } else if (type === 'closed') {
      if (session.status === 'connected') {
        session.status = 'closed';
        session.overlay = document.createElement('div');
        session.overlay.className = 'term-overlay';
        session.overlay.innerHTML = `<div class="overlay-error">连接已关闭</div>`;
        session.hostEl.appendChild(session.overlay);
        session.tabEl.classList.remove('connected');
        updateStatus('error', '已断开');
        // SFTP 面板同步: 若当前展示的正是该会话, 回到占位
        if (activeSessionId === sessionId) showSftpFor(sessionId);
      }
    } else if (type === 'tunnel') {
      toast(message, 'success');
      // 面板打开时同步列表 (自动建立/手动新增的隧道即时可见)
      if ($('#tunnelOverlay').style.display === 'flex') refreshTunnelList();
    } else if (type === 'tunnel-error') {
      toast(message, 'error');
      if ($('#tunnelOverlay').style.display === 'flex') refreshTunnelList();
    } else if (type === 'tunnel-stopped') {
      if ($('#tunnelOverlay').style.display === 'flex') refreshTunnelList();
    } else if (type === 'sftp-download-progress') {
      // 单文件下载续传进度 (phase:'downloading') 与文件夹打包进度 (listing/packing) 共用进度条
      if (rest && rest.phase === 'downloading') {
        if (sessionId === sftpFileSessionId && sftpFileKind === 'download' && sessionId === currentSftpSessionId) {
          showSftpProgress(true, rest);
        }
      } else if (sessionId === sftpDownloadSessionId && sessionId === currentSftpSessionId) {
        showSftpProgress(true, rest);
      }
    } else if (type === 'sftp-upload-progress') {
      // 单文件上传/续传进度 (phase:'uploading')
      if (rest && rest.phase === 'uploading') {
        if (sessionId === sftpFileSessionId && sftpFileKind === 'upload' && sessionId === currentSftpSessionId) {
          showSftpProgress(true, rest);
        }
      }
    }
  });
}

// ============ 终端 cd 同步 (R3: 终端 cd 命令 -> SFTP 面板目录跟随) ============
// 原理: 旁路监听 term.onData 的输入流, 在「完整独立行」提交 (\r/\n) 时解析是否为 cd 命令。
// 约束:
// - 不改变 window.nimbus.write 行为: 终端输入永远原样透传, 解析只是旁路监听;
// - 仅匹配完整独立行的 cd (^\s*cd...\s*$), 复合命令如 `cd /x && ls` 不匹配 -> 保守不触发;
// - 全屏程序 (vi/top/less) 内按键序列无 \r 提交整行, 不会误触发;
// - 解析/目录不存在失败 -> 静默忽略, 不打扰终端操作。
function handleTerminalInputLine(session, data) {
  if (!session || typeof data !== 'string') return;
  // 追加输入到行缓冲 (保留同 chunk 内换行之后的残余, 供下一条命令继续累积)
  session.inputBuffer += data;
  // 查找首个行结束符 (\r 或 \n); 尚无完整行则等待更多输入
  const terminator = session.inputBuffer.search(/[\r\n]/);
  if (terminator === -1) return;
  const line = session.inputBuffer.slice(0, terminator);
  // 消费本行后, 一并清除残留换行符 (\r\n 时 \r 已消费但 \n 残留, 避免其占一个 onData 处理槽)
  session.inputBuffer = session.inputBuffer.slice(terminator + 1).replace(/^[\r\n]+/, '');

  // 仅匹配完整独立行的 cd: `cd` / `cd 路径` (前后允许空白), 无参数 -> ~ home
  const m = line.match(/^\s*cd(?:\s+(\S+))?\s*$/);
  if (!m) return;
  const rawPath = m[1] || '~';

  window.nimbus.sftpCdSync(session.sessionId, rawPath).then((res) => {
    // 竞态守卫: 会话已关闭/替换或面板已切换到其他会话 -> 丢弃
    if (sessions.get(session.sessionId) !== session) return;
    if (currentSftpSessionId !== session.sessionId) return;
    if (!res || !res.ok || !res.path) return; // {ok:false} 静默忽略 (目录不存在/解析失败)
    // 带历史入栈 (等同手动进入), 复用 loadDir 已有的 fileReqSeq/currentSftpSessionId 竞态防护
    loadDir(session.sessionId, res.path);
    toast(`已切换到 ${res.path}`, 'success');
  }).catch(() => {}); // IPC 异常同样静默, 不影响终端输入
}

// ============ SFTP 文件浏览面板 (侧边栏全局单一实例) ============

// ---- 内联 SVG 图标 (仅保留渲染文件列表所需) ----
// 注: 操作列按钮已移除, 行操作 (下载/下载ZIP/重命名/删除/预览) 走右键菜单文字项, 无需行内图标
const SVG_FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const SVG_FILE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg>';

// 获取当前在 SFTP 面板展示的会话 (需已连接)
function currentSftpSession() {
  const session = currentSftpSessionId ? sessions.get(currentSftpSessionId) : null;
  if (!session || session.status !== 'connected') return null;
  return session;
}

// 在 SFTP 面板展示指定会话的远程目录 (面板全局单一实例, 跟随活动会话)
// - 会话存在且已连接 -> 加载其目录 (保留各会话自己的 currentPath/history)
// - 未连接 / 无会话 -> 显示占位
function showSftpFor(sessionId) {
  const session = sessionId ? sessions.get(sessionId) : null;
  const connected = !!session && session.status === 'connected';
  currentSftpSessionId = connected ? sessionId : null;

  const pathInput = $('#sftpPathInput');
  const placeholderEl = $('#sftpPlaceholder');
  const tbody = $('#sftpTbody');

  if (!connected) {
    pathInput.value = '';
    placeholderEl.style.display = 'flex';
    $('#sftpTable').style.display = 'none';
    $('#sftpLoading').style.display = 'none';
    $('#sftpEmpty').style.display = 'none';
    tbody.innerHTML = '';
    return;
  }

  // 已连接 -> 展示文件列表并加载该会话当前路径
  pathInput.value = session.currentPath;
  placeholderEl.style.display = 'none';
  $('#sftpTable').style.display = '';
  $('#sftpLoading').style.display = 'none';
  $('#sftpEmpty').style.display = 'none';
  loadDir(sessionId, session.currentPath);
}

// 归一化远端路径: 保证以 / 开头, 去除多余斜杠与末尾斜杠
// 含 .. 段的路径视为非法, 返回 null
function normalizeRemotePath(p) {
  if (!p || p.trim() === '') return '/';
  let s = '/' + p.trim().replace(/^\/+/, '');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s.split('/').some((seg) => seg === '..')) return null;
  return s;
}

// 校验新建/重命名名称合法性: 不允许 / 或 ..
function isValidEntryName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('..');
}

// 拼接远端路径
function joinRemotePath(parent, name) {
  const p = normalizeRemotePath(parent);
  if (p === '/') return '/' + name;
  return p + '/' + name;
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return (i === 0 ? String(val) : val.toFixed(1)) + ' ' + units[i];
}

// 格式化修改时间 (毫秒时间戳 -> 本地时间字符串)
function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 加载目录: pushHistory=false 时仅更新内容(后退用; 面板目录切换默认不联动终端)
// opts.syncTerminal=true 时 (仅右键菜单「cd 进入文件夹」) 目录切换成功后向终端同步 cd
async function loadDir(sessionId, path, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session || !session.fileEl) return;
  const push = opts.pushHistory !== false;

  const pathStr = normalizeRemotePath(path);
  if (pathStr === null) {
    toast('路径包含非法段 (..)', 'error');
    return;
  }

  // 请求序号: 丢弃过期响应, 防止快速切换目录/会话时的竞态
  const seq = ++session.fileReqSeq;
  setFileLoading(session, true);
  const res = await window.nimbus.sftpList(sessionId, pathStr);

  // 响应返回后会话可能已关闭或面板已切换
  if (!sessions.has(sessionId) || !session.fileEl || !document.contains(session.fileEl)) return;
  if (seq !== session.fileReqSeq) return;        // 同会话内的过期响应直接丢弃
  if (currentSftpSessionId !== sessionId) return; // 面板已切换到其他会话, 丢弃
  setFileLoading(session, false);

  if (!res.ok) {
    toast(res.error || '读取目录失败', 'error');
    // 加载失败时回退到当前有效路径
    const pathInput = session.fileEl.querySelector('.sftp-path');
    if (pathInput) pathInput.value = session.currentPath;
    return;
  }

  if (push) {
    // 与历史最后一项相同时不重复入栈 (刷新/重复进入)
    if (session.history[session.historyIndex] !== res.path) {
      session.history = session.history.slice(0, session.historyIndex + 1);
      session.history.push(res.path);
      session.historyIndex = session.history.length - 1;
    }
  }

  session.currentPath = res.path;
  renderFileList(session, res.entries || []);
  const pathInput = session.fileEl.querySelector('.sftp-path');
  if (pathInput) pathInput.value = res.path;

  // 右键菜单「cd 进入文件夹」: 面板目录切换成功后向终端同步 cd (仅显式请求时)
  // 上方 seq/会话存活/currentSftpSessionId 守卫已过滤过期响应; syncTerminalCwd
  // 内部再校验 currentPath 仍为目标路径, 防快速连续操作把 cd 写到错误目录
  if (opts.syncTerminal === true) {
    syncTerminalCwd(session, res.path);
  }
}

// 渲染文件列表表格 (窄栏: 名称/大小/修改时间 三列, 列宽可拖拽)
// 注: 操作列按钮已移除, 所有行操作 (cd/预览/下载/下载ZIP/重命名/删除) 统一走右键菜单;
//     isImageName 保留供右键菜单/双击预览判断图片类型
// Roadmap 第三梯队 ①: 客户端即时过滤 (sftpSearchKeyword 不区分大小写子串, 仅隐藏行,
// 不影响目录结构与行操作; 空关键字恢复全部; 命中子串以 .sftp-name-match 高亮)
function renderFileList(session, entries) {
  session.fileEntries = entries;
  // 构建 name -> entry 索引, 供事件委托 O(1) 查找
  session.fileEntryMap = new Map(entries.map((x) => [x.name, x]));
  const tbody = session.fileEl.querySelector('.sftp-tbody');
  const emptyEl = session.fileEl.querySelector('.sftp-empty');

  if (entries.length === 0) {
    tbody.innerHTML = '';
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';

  // 客户端即时过滤: 空关键字 -> 全部; 否则不区分大小写子串 (纯渲染层, 不影响 fileEntryMap)
  const keyword = String(sftpSearchKeyword || '').trim();
  const kwLower = keyword.toLowerCase();
  const visible = kwLower
    ? entries.filter((en) => en && typeof en.name === 'string' && en.name.toLowerCase().includes(kwLower))
    : entries;

  if (visible.length === 0) {
    // 过滤后无匹配: 保留表头, 显示无匹配提示行 (目录结构不变)
    tbody.innerHTML = `<tr class="sftp-row sftp-no-match"><td colspan="3">没有匹配「${escapeHtml(keyword)}」的文件</td></tr>`;
    return;
  }

  // 所有动态字符串统一 escapeHtml, 防止注入
  tbody.innerHTML = visible.map((entry) => {
    const icon = entry.isDir ? SVG_FOLDER : SVG_FILE;
    const nameSafe = escapeHtml(entry.name);
    const sizeSafe = escapeHtml(entry.isDir ? '-' : formatSize(entry.size));
    const mtimeSafe = escapeHtml(formatTime(entry.mtime));
    // 命中子串高亮: 仅当关键字命中且命中段不含会被 escapeHtml 展开的字符时包裹 span,
    // 避免转义前后偏移错位 (否则退化为仅过滤不高亮, 语义不变)
    let nameHtml = nameSafe;
    if (kwLower && fileFilterApi) {
      const r = fileFilterApi.matchRange(entry.name, keyword);
      // 名称含会被 escapeHtml 展开的字符时, 原始索引无法对齐转义后字符串
      // (命中段在实体之后会切碎实体, 如 a&b.txt 搜 b 切成 a&<span>a</span>mp;b.txt),
      // 此时跳过 span 包裹仅转义显示 (B2 修复)
      if (r && !/[&<>"']/.test(entry.name)) {
        const before = nameSafe.slice(0, r.start);
        const hit = nameSafe.slice(r.start, r.end);
        const after = nameSafe.slice(r.end);
        nameHtml = `${before}<span class="sftp-name-match">${hit}</span>${after}`;
      }
    }
    return `
      <tr class="sftp-row ${entry.isDir ? 'is-dir' : ''}" data-name="${nameSafe}">
        <td class="sftp-cell-name">${icon}<span class="sftp-name" title="${nameSafe}">${nameHtml}</span></td>
        <td class="sftp-cell-size">${sizeSafe}</td>
        <td class="sftp-cell-mtime">${mtimeSafe}</td>
      </tr>`;
  }).join('');
  // 行级双击/右键已由 init 中的 tbody dblclick / contextmenu 事件委托统一处理
}

// 加载中状态切换
function setFileLoading(session, loading) {
  const loadingEl = session.fileEl.querySelector('.sftp-loading');
  const tableEl = session.fileEl.querySelector('.sftp-table');
  if (loading) {
    loadingEl.style.display = 'flex';
    tableEl.style.display = 'none';
  } else {
    loadingEl.style.display = 'none';
    tableEl.style.display = '';
  }
}

// 进入子目录 (双击进入 + 右键菜单「cd 进入文件夹」统一入口)
// - 默认: 仅切换面板目录, 不联动终端 (双击进入/路径跳转保持此行为)
// - opts.syncTerminal=true: 目录加载成功后向终端同步 cd (仅右键菜单「cd 进入文件夹」使用)
function enterDir(session, name, opts = {}) {
  loadDir(session.sessionId, joinRemotePath(session.currentPath, name), opts);
}

// 向终端同步 cd 命令 (仅右键菜单「cd 进入文件夹」触发, 面板目录切换成功后调用)
// - 经 window.nimbus.write 走 PTY 输入通道: 与用户键入等价, shell 真实执行并自然回显;
//   不经过 term.onData, 因此 R3 旁路监听 (终端 cd -> 面板跟随) 不会二次触发 -> 无反馈回路
// - 终端未就绪 (会话断开/无 term) 时静默跳过, 不影响面板切换
// - 路径做单引号 shell 转义, 内部单引号按 '\'' 处理, 防空格/特殊字符断词或注入
function syncTerminalCwd(session, targetPath) {
  if (!session || !session.term || session.status !== 'connected') return;
  // 竞态双保险: 面板当前目录仍为目标目录才写入 (loadDir 内部 seq 守卫已过滤过期响应)
  if (session.currentPath !== targetPath) return;
  const quoted = "'" + targetPath.replace(/'/g, "'\\''") + "'";
  window.nimbus.write(session.sessionId, 'cd ' + quoted + '\r').catch(() => {});
}

// 后退: historyIndex-- 后加载对应历史路径, 不入栈; 仅切换面板目录, 不联动终端
function goBack(session) {
  if (session.historyIndex <= 0) return;
  session.historyIndex--;
  loadDir(session.sessionId, session.history[session.historyIndex], { pushHistory: false });
}

// 刷新当前目录
function refreshDir(session) {
  loadDir(session.sessionId, session.currentPath);
}

// 新建文件夹
async function mkdirPrompt(session) {
  const name = prompt('请输入新文件夹名称', '新建文件夹');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (!isValidEntryName(trimmed)) {
    toast('名称不能包含 / 或 ..', 'error');
    return;
  }
  const remotePath = joinRemotePath(session.currentPath, trimmed);
  const res = await window.nimbus.sftpMkdir(session.sessionId, remotePath);
  if (res.ok) {
    toast('文件夹已创建', 'success');
    loadDir(session.sessionId, session.currentPath);
  } else {
    toast(res.error || '创建文件夹失败', 'error');
  }
}

// 下载文件 (选择本地保存路径; 支持断点续传, 进度经 sftp-download-progress 事件更新)
async function downloadFile(session, entry) {
  const res = await window.nimbus.selectSavePath(entry.name);
  if (!res.ok || !res.path) return;
  const remotePath = joinRemotePath(session.currentPath, entry.name);
  // 单文件下载进度: 代际 + 会话 + kind 三重守卫 (与打包下载互不干扰)
  const gen = ++sftpFileGen;
  sftpFileSessionId = session.sessionId;
  sftpFileKind = 'download';
  showSftpProgress(true, { phase: 'downloading', done: 0, total: 0, currentName: entry.name });
  let dl;
  try {
    dl = await window.nimbus.sftpDownload(session.sessionId, remotePath, res.path);
  } catch (err) {
    dl = { ok: false, error: (err && err.message) || '下载异常' };
  } finally {
    if (gen === sftpFileGen) {
      sftpFileSessionId = null;
      sftpFileKind = null;
      hideSftpProgress();
    }
  }
  if (dl.ok) {
    toast(dl.resumed ? `已续传下载 ${entry.name}` : `已下载 ${entry.name}`, 'success');
  } else {
    toast(dl.error || '下载失败', 'error');
  }
}

// ============ 打包下载/单文件传输进度条 (SFTP 面板顶部) ============
// 代际机制: 每次传输开始 +1; 进度事件仅接受「当前代 + 当前面板会话」, 完成/失败/切换会话后忽略
let sftpDownloadGen = 0;            // 文件夹打包下载代际
let sftpDownloadSessionId = null;   // 文件夹打包下载所属会话
// 单文件上传/下载续传跟踪 (Roadmap 第一梯队 ②): 复用同一进度条, 用 kind 区分
let sftpFileGen = 0;                // 单文件传输代际
let sftpFileSessionId = null;       // 单文件传输所属会话
let sftpFileKind = null;            // 'download' | 'upload'

// 显示/更新 SFTP 面板顶部进度条;
// info: {phase:'listing', scanned} | {phase:'packing', done, total, currentName}
//     | {phase:'downloading'|'uploading', done, total, currentName}
function showSftpProgress(visible, info) {
  const bar = $('#sftpProgress');
  if (!bar) return;
  bar.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  const label = $('#sftpProgressLabel');
  const fill = $('#sftpProgressFill');
  if (!label || !fill) return;
  if (!info || info.phase === 'listing') {
    const scanned = info && info.scanned ? info.scanned : 0;
    label.textContent = `正在扫描... (${scanned} 项)`;
    fill.style.width = '0%';
  } else if (info.phase === 'packing') {
    const done = info.done || 0;
    const total = info.total || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
    const name = info.currentName ? String(info.currentName).split('/').pop() : '';
    label.textContent = `正在打包 ${done}/${total}${name ? ' · ' + name : ''}`;
    fill.style.width = pct + '%';
  } else if (info.phase === 'downloading' || info.phase === 'uploading') {
    const action = info.phase === 'downloading' ? '下载' : '上传';
    const done = info.done || 0;
    const total = info.total || 0;
    const name = info.currentName ? String(info.currentName).split('/').pop() : '';
    if (total <= 0) {
      label.textContent = `正在${action}${name ? ' · ' + name : ''}...`;
      fill.style.width = '0%';
    } else {
      const pct = Math.min(100, Math.round((done / total) * 100));
      label.textContent = `正在${action} ${pct}%${name ? ' · ' + name : ''}`;
      fill.style.width = pct + '%';
    }
  }
}

// 隐藏进度条 (完成/失败后调用)
function hideSftpProgress() {
  showSftpProgress(false, null);
}

// 下载文件夹: 打包为 ZIP 并保存到本地 (进度经 sftp-download-progress 事件更新)
async function downloadDir(session, entry) {
  let res;
  try {
    res = await window.nimbus.selectSavePath(entry.name + '.zip');
  } catch (err) {
    toast('无法打开保存窗口', 'error');
    return;
  }
  if (!res.ok || !res.path) return;

  // 对话框期间会话可能已关闭/切换
  const current = sessions.get(session.sessionId);
  if (!current || current !== session) {
    toast('会话已关闭, 下载已取消', 'error');
    return;
  }

  const remotePath = joinRemotePath(session.currentPath, entry.name);
  const gen = ++sftpDownloadGen; // 本次下载代际
  sftpDownloadSessionId = session.sessionId;
  showSftpProgress(true, { phase: 'listing', scanned: 0 });
  try {
    let dl;
    try {
      dl = await window.nimbus.sftpDownloadFolder(session.sessionId, remotePath, res.path);
    } catch (err) {
      toast('打包下载异常: ' + (err.message || '未知错误'), 'error');
      return;
    }
    if (dl.ok) {
      toast(`已下载 ${entry.name}.zip`, 'success');
    } else {
      toast(dl.error || '打包下载失败', 'error');
    }
  } finally {
    // 仅当仍是本次下载时清理进度条 (并发下载时由最新一代接管)
    if (gen === sftpDownloadGen) {
      sftpDownloadSessionId = null;
      hideSftpProgress();
    }
  }
}

// 删除文件/目录
async function deleteEntry(session, entry) {
  const label = entry.isDir ? '文件夹' : '文件';
  const hint = entry.isDir ? '\n目录将连同内部所有内容一起删除。' : '';
  if (!confirm(`确定删除${label} "${entry.name}" 吗？${hint}`)) return;
  const remotePath = joinRemotePath(session.currentPath, entry.name);
  const res = await window.nimbus.sftpDelete(session.sessionId, remotePath);
  if (res.ok) {
    toast(`已删除 ${entry.name}`, 'success');
    loadDir(session.sessionId, session.currentPath);
  } else {
    toast(res.error || '删除失败', 'error');
  }
}

// 重命名文件/目录
async function renameEntry(session, entry) {
  const newName = prompt('请输入新名称', entry.name);
  if (!newName || !newName.trim() || newName.trim() === entry.name) return;
  const trimmed = newName.trim();
  if (!isValidEntryName(trimmed)) {
    toast('名称不能包含 / 或 ..', 'error');
    return;
  }
  const oldPath = joinRemotePath(session.currentPath, entry.name);
  const newPath = joinRemotePath(session.currentPath, trimmed);
  const res = await window.nimbus.sftpRename(session.sessionId, oldPath, newPath);
  if (res.ok) {
    toast('重命名成功', 'success');
    loadDir(session.sessionId, session.currentPath);
  } else {
    toast(res.error || '重命名失败', 'error');
  }
}

// ============ SFTP 文件右键菜单 ============
// 触发/显示逻辑:
// - 文件行「非操作按钮区域」右键 (contextmenu) -> showContextMenu(e.clientX, e.clientY, ...)
// - 菜单 fixed 定位跟随鼠标; 超出视口右/下边缘时左/上翻转, 防止溢出
// - 左键点击菜单外 / Esc / 列表滚动 / 窗口 resize / 在菜单外再次右键 -> 关闭
// - 每次右键按目标类型 (文件夹 / 图片 / 普通文件) 动态重建菜单项
// 菜单项动作全部复用现有操作函数 (enterDir/downloadFile/downloadDir/renameEntry/deleteEntry/
// openPreview), 其内部原有的 approvedLocalPaths 登记 / confirm 确认等逻辑一个字节不改。

// 显示右键菜单: 记录目标并构建菜单项, 定位到鼠标处 (视口边缘翻转)
function showContextMenu(x, y, session, entry) {
  const menu = $('#sftpContextMenu');
  if (!menu || !session || !entry) return;
  // 记录右键目标: 菜单项动作以此为准 (不是当前行, 防止右键后行被重绘)
  ctxMenuTarget = { sessionId: session.sessionId, entry };

  const isDir = !!entry.isDir;
  const isImage = !isDir && isImageName(entry.name);
  const isDoc = !isDir && !isImage && !!getDocExtension(entry.name);
  const cdItem = menu.querySelector('.ctx-item[data-ctx="cd"]');
  const openItem = menu.querySelector('.ctx-item[data-ctx="open"]');
  const previewItem = menu.querySelector('.ctx-item[data-ctx="preview"]');
  // 下载项用稳定类选择 (ctx-download): 其 data-ctx 在 download/download-dir 间动态切换,
  // 若按 data-ctx 查询, 上次切到 download-dir 后下次就查不到了
  const downloadItem = menu.querySelector('.ctx-item.ctx-download');

  // 动态构建菜单项: 文件夹 -> cd 进入; 图片 -> 预览; 文档白名单 -> 打开; 下载项文案随目标类型切换
  cdItem.style.display = isDir ? '' : 'none';
  openItem.style.display = isDoc ? '' : 'none';
  previewItem.style.display = isImage ? '' : 'none';
  downloadItem.dataset.ctx = isDir ? 'download-dir' : 'download';
  downloadItem.textContent = isDir ? '下载 (ZIP)' : '下载';

  menu.style.display = 'block';
  // 视口边缘翻转: 菜单超出右/下边缘时左/上移 (需先显示才能测量实际尺寸)
  const menuRect = menu.getBoundingClientRect();
  const left = x + menuRect.width > window.innerWidth ? Math.max(0, window.innerWidth - menuRect.width) : x;
  const top = y + menuRect.height > window.innerHeight ? Math.max(0, window.innerHeight - menuRect.height) : y;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

// 隐藏右键菜单: 清空目标, 供菜单外点击/Esc/滚动/resize 调用
function hideContextMenu() {
  const menu = $('#sftpContextMenu');
  if (menu) menu.style.display = 'none';
  ctxMenuTarget = null;
}

// 校验右键目标仍有效: 会话未关闭/切换 + 条目仍在当前目录 (防目录刷新后 stale)
// 返回 { session, entry }; 任一条件不满足返回 null (调用方直接忽略动作)
function resolveCtxMenuTarget() {
  const target = ctxMenuTarget;
  if (!target) return null;
  const session = sessions.get(target.sessionId);
  if (!session || session.status !== 'connected') return null;
  // 当前面板仍展示同一会话 (会话切换/关闭则 hide 不执行)
  if (currentSftpSessionId !== session.sessionId) return null;
  // 用 fileEntryMap 复核条目仍存在 (目录刷新后旧 entry 作废)
  const entry = session.fileEntryMap ? session.fileEntryMap.get(target.entry.name) : null;
  if (!entry) return null;
  return { session, entry };
}

// 菜单项 click 委托 (菜单 DOM 上绑一次): 按 data-ctx 分发到现有操作函数
function onContextMenuClick(e) {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  e.preventDefault();
  // 阻止冒泡到 document click 关闭处理器 (先执行动作再关闭, 避免关闭冲突)
  e.stopPropagation();
  const action = item.dataset.ctx;
  const resolved = resolveCtxMenuTarget();
  hideContextMenu();
  if (!resolved) return; // 会话已切换/关闭或条目已失效: 静默忽略
  const { session, entry } = resolved;
  if (action === 'cd') {
    // cd 进入文件夹: 校验目标是文件夹 -> 复用 enterDir (带终端同步)
    // - 面板: loadDir 内部同步 currentPath + renderFileList + 路径输入框 + 状态栏
    // - 终端: syncTerminal=true -> 目录加载成功后向终端注入 cd 到同一路径
    //   (双击进入不带该选项, 保持「仅切面板」; 后退/路径跳转/打开文档均不联动)
    if (entry.isDir) enterDir(session, entry.name, { syncTerminal: true });
  } else if (action === 'open') {
    // 内置文档查看器 (文档白名单类型; 图片走 preview 不进入)
    openDocViewer(session, entry);
  } else if (action === 'preview') {
    openPreview(session.sessionId, joinRemotePath(session.currentPath, entry.name), entry.name);
  } else if (action === 'download') {
    downloadFile(session, entry);
  } else if (action === 'download-dir') {
    downloadDir(session, entry); // 文件夹 ZIP 打包下载
  } else if (action === 'rename') {
    renameEntry(session, entry);
  } else if (action === 'delete') {
    deleteEntry(session, entry);
  }
}

// 右键菜单事件绑定 (init 时调用一次, 杜绝重复绑定)
function initContextMenu() {
  const menu = $('#sftpContextMenu');
  const tbody = $('#sftpTbody');
  if (!menu || !tbody) return;

  // 1) tbody contextmenu 事件委托: 阻止 Electron/浏览器默认菜单, 打开自定义菜单
  //    (操作列按钮已移除, 行内任意位置右键均弹出菜单)
  tbody.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sftp-row');
    const session = currentSftpSession();
    if (!row || !session || !session.fileEntryMap) return;
    const entry = session.fileEntryMap.get(row.dataset.name);
    if (!entry) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到 window 的关闭处理器 (本事件已打开新菜单)
    showContextMenu(e.clientX, e.clientY, session, entry);
  });

  // 2) 菜单项 click 委托 (菜单 DOM 上绑一次; 菜单在 body 层级, 事件不冒泡到 tbody)
  menu.addEventListener('click', onContextMenuClick);

  // 3) document 左键点击: 菜单外任意处关闭 (菜单项已 stopPropagation, 不受影响)
  document.addEventListener('click', (e) => {
    if (ctxMenuTarget && !e.target.closest('#sftpContextMenu')) hideContextMenu();
  });

  // 4) window contextmenu: 菜单外右键关闭旧菜单 (tbody 内的右键已 stopPropagation 到此)
  window.addEventListener('contextmenu', (e) => {
    if (ctxMenuTarget && !e.target.closest('#sftpContextMenu')) hideContextMenu();
  });

  // 5) 列表滚动 / 窗口 resize: 菜单 fixed 定位不跟随内容, 关闭避免错位
  const scrollable = $('#sftpBody');
  if (scrollable) scrollable.addEventListener('scroll', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
}

// ============ Roadmap 第三梯队 ①: SFTP 文件搜索/过滤 ============
// S 级: 客户端即时过滤 (sftpSearchKeyword -> renderFileList 隐藏行, 纯渲染层)
// M 级: 服务端递归搜索 (sftpSearch IPC -> find, 结果回填列表, 点击进入所在目录/预览)
// 交互细节: 过滤不影响目录结构 (仅隐藏行); 搜索框在空目录也显示; Esc 清空。

// 关闭递归搜索结果列表 (保留过滤状态)
function closeSftpSearchResults() {
  const panel = $('#sftpSearchResults');
  if (panel) panel.style.display = 'none';
  sftpSearchResultsOpen = false;
}

// 渲染递归搜索结果列表
function renderSftpSearchResults(session, res) {
  const panel = $('#sftpSearchResults');
  const list = $('#sftpSearchResultsList');
  const label = $('#sftpSearchResultsLabel');
  const hint = $('#sftpSearchResultsHint');
  if (!panel || !list) return;
  const results = (res && Array.isArray(res.results)) ? res.results : [];
  const total = (res && typeof res.total === 'number') ? res.total : results.length;
  label.textContent = `递归搜索: ${results.length} 条`;
  hint.textContent = res && res.truncated ? `(超过 ${results.length} 条仅显示前 ${results.length} 条)` : `目录 ${session.currentPath} · maxdepth 3`;
  if (results.length === 0) {
    list.innerHTML = `<div class="sftp-search-result-empty">未找到匹配文件</div>`;
  } else {
    list.innerHTML = results.map((r) => {
      const icon = SVG_FILE; // find 结果默认按文件处理 (目录可由点击「进入」)
      const nameSafe = escapeHtml(r.name);
      const dirSafe = escapeHtml(r.dir);
      return `
        <div class="sftp-search-result" data-path="${escapeHtml(r.path)}" data-name="${nameSafe}" data-dir="${dirSafe}">
          ${icon}
          <div class="sftp-search-result-main">
            <div class="sftp-search-result-name" title="${nameSafe}">${nameSafe}</div>
            <div class="sftp-search-result-path" title="${dirSafe}">${dirSafe}</div>
          </div>
        </div>`;
    }).join('');
  }
  panel.style.display = 'flex';
  sftpSearchResultsOpen = true;
}

// 执行服务端递归搜索 (防抖 400ms; 降级失败 -> toast 提示, 不打断当前目录过滤)
async function runSftpRecursiveSearch(session, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw || !session) return;
  const cwd = session.currentPath;
  let res;
  try {
    res = await window.nimbus.sftpSearch(session.sessionId, cwd, kw, 3);
  } catch (err) {
    res = { ok: false, degraded: true, error: (err && err.message) || '递归搜索异常' };
  }
  // 竞态守卫: 会话已关闭/切换或面板已切换 -> 丢弃
  if (!sessions.has(session.sessionId) || currentSftpSessionId !== session.sessionId) return;
  if (!res || !res.ok) {
    closeSftpSearchResults();
    toast((res && res.error) || '递归搜索失败', 'info');
    return;
  }
  renderSftpSearchResults(session, res);
}

// 递归搜索结果点击: 图片 -> 预览; 文档白名单 -> 打开; 其他 -> 进入所在目录
function onSftpSearchResultClick(e) {
  const item = e.target.closest('.sftp-search-result');
  if (!item) return;
  const session = currentSftpSession();
  if (!session) return;
  const path = item.dataset.path;
  const name = item.dataset.name;
  const dir = item.dataset.dir;
  if (!path || !name) return;
  if (isImageName(name)) {
    openPreview(session.sessionId, path, name);
    return;
  }
  if (getDocExtension(name)) {
    // 搜索结果在远端其他目录: 以完整路径打开 (openDocViewer 第三个参数为 remotePath 覆盖)
    openDocViewer(session, { name, isDir: false }, path);
    return;
  }
  // 普通文件: 进入所在目录 (面板切换, 不联动终端)
  loadDir(session.sessionId, dir || '/');
  toast(`已进入 ${dir || '/'}`, 'info');
}

// 绑定 SFTP 搜索栏事件 (init 时调用一次)
function initSftpSearch() {
  const input = $('#sftpSearchInput');
  const recursiveBtn = $('#sftpSearchRecursive');
  const closeBtn = $('#sftpSearchResultsClose');
  const list = $('#sftpSearchResultsList');
  if (!input) return;

  // 即时过滤: 输入即对已加载条目过滤 (纯渲染层); 递归开关开启时同时触发服务端搜索
  input.addEventListener('input', () => {
    sftpSearchKeyword = input.value;
    const session = currentSftpSession();
    if (session) renderFileList(session, session.fileEntries || []);
    clearTimeout(sftpSearchTimer);
    if (sftpSearchRecursive && session && sftpSearchKeyword.trim()) {
      sftpSearchTimer = setTimeout(() => runSftpRecursiveSearch(session, sftpSearchKeyword), 400);
    } else if (!sftpSearchKeyword.trim()) {
      closeSftpSearchResults();
    }
  });

  // Esc 清空 (恢复全部)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    input.value = '';
    sftpSearchKeyword = '';
    closeSftpSearchResults();
    const session = currentSftpSession();
    if (session) renderFileList(session, session.fileEntries || []);
  });

  // 递归搜索开关
  if (recursiveBtn) {
    recursiveBtn.addEventListener('click', () => {
      sftpSearchRecursive = !sftpSearchRecursive;
      recursiveBtn.classList.toggle('active', sftpSearchRecursive);
      if (!sftpSearchRecursive) {
        closeSftpSearchResults();
        return;
      }
      const session = currentSftpSession();
      if (!session) { toast('请先连接会话', 'info'); return; }
      if (!sftpSearchKeyword.trim()) { toast('请输入关键字后点击递归搜索', 'info'); return; }
      runSftpRecursiveSearch(session, sftpSearchKeyword);
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closeSftpSearchResults);
  if (list) list.addEventListener('click', onSftpSearchResultClick);
}

// ============ Roadmap 第一梯队 ③ (S): 更新检查提示 ============
// 主进程启动延迟静默检查 GitHub Releases, 有新版本 -> 广播 update:check 事件;
// 渲染层在顶栏显示「发现新版本 vX.Y.Z」提示, 点击打开 releases 页 (无新版/失败静默)。
function showUpdateBadge(payload) {
  const btn = $('#updateBadge');
  if (!btn || !payload || !payload.hasUpdate) return;
  const version = payload.latest || payload.tag || '';
  updateBadgePayload = payload;
  // GitHub tag_name 通常自带 v 前缀, 拼接前先去重, 避免「发现新版本 vv2.0.1」(B3 修复)
  const displayVersion = version ? (version.startsWith('v') ? version : 'v' + version) : '';
  btn.textContent = displayVersion ? `发现新版本 ${displayVersion}` : '发现新版本';
  btn.style.display = '';
}

// 绑定更新检查事件 (init 时调用一次; 测试沙箱无 onUpdateCheck 时静默跳过)
function initUpdateCheck() {
  if (!window.nimbus || typeof window.nimbus.onUpdateCheck !== 'function') return;
  window.nimbus.onUpdateCheck((payload) => showUpdateBadge(payload));
  const btn = $('#updateBadge');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!updateBadgePayload) return;
      const url = updateBadgePayload.url || '';
      if (url && window.nimbus.openExternal) {
        window.nimbus.openExternal(url).catch(() => {});
      }
    });
  }
}

// 串行上传多个本地文件到会话当前目录 (按钮上传与拖拽上传共用)
// 复用现有链路: 逐个 window.nimbus.sftpUpload (主进程已登记路径) -> 成功/失败 toast -> 完成后刷新目录
// 断点续传: 主进程以远端 stat 为基准续传, 进度经 sftp-upload-progress 事件更新
async function uploadLocalPaths(session, localPaths) {
  if (!session || !Array.isArray(localPaths) || localPaths.length === 0) return 0;
  const targetPath = session.currentPath;
  let okCount = 0;
  for (const localPath of localPaths) {
    // 会话中途关闭则停止后续上传
    if (!sessions.has(session.sessionId)) break;
    const fileName = String(localPath).split(/[\\/]/).pop() || 'file';
    const remotePath = joinRemotePath(targetPath, fileName);
    // 单文件上传进度: 代际 + 会话 + kind 三重守卫 (串行上传, 单文件间不重叠)
    const gen = ++sftpFileGen;
    sftpFileSessionId = session.sessionId;
    sftpFileKind = 'upload';
    showSftpProgress(true, { phase: 'uploading', done: 0, total: 0, currentName: fileName });
    let up;
    try {
      up = await window.nimbus.sftpUpload(session.sessionId, localPath, remotePath);
    } catch (err) {
      up = { ok: false, error: (err && err.message) || '上传异常' };
    } finally {
      if (gen === sftpFileGen) {
        sftpFileSessionId = null;
        sftpFileKind = null;
        hideSftpProgress();
      }
    }
    if (up.ok) {
      okCount++;
    } else {
      toast(up.error || `上传 ${fileName} 失败`, 'error');
    }
  }
  if (okCount > 0) {
    toast(`已上传 ${okCount} 个文件`, 'success');
    loadDir(session.sessionId, targetPath);
  }
  return okCount;
}

// 触发上传: 走主进程系统文件对话框 (本地文件的唯一入口, 支持多选)
async function triggerUpload(session) {
  let res;
  try {
    res = await window.nimbus.selectFile();
  } catch (err) {
    toast('无法打开文件选择窗口', 'error');
    return;
  }
  if (!res.ok || !Array.isArray(res.paths) || res.paths.length === 0) return;

  // 对话框期间会话可能已关闭/切换
  const current = sessions.get(session.sessionId);
  if (!current || current !== session) {
    toast('会话已关闭, 上传已取消', 'error');
    return;
  }

  // 路径已由主进程 dialog:selectFile 登记, 复用共享串行上传
  await uploadLocalPaths(session, res.paths);
}

// ============ SFTP 拖拽上传 (Roadmap ③) ============
// 交互: 将本地文件从系统文件管理器拖到 SFTP 面板区域 (整个面板容器) -> 上传到当前所在目录。
// 取路径: preload 暴露 window.nimbus.getPathForFile(file) (webUtils.getPathForFile 同步调用),
//         仅对真实拖拽产生的 File 对象返回真实路径 (伪造/内存 File 返回空串, 安全边界)。
// 安全: 拖拽路径须先经 sftp:registerUploadPaths 登记到主进程 approvedLocalPaths,
//       再由现有 sftp:upload 消费校验 (与对话框流程同等安全); 文件夹在登记时被主进程过滤。
let sftpDragUploading = false; // 拖拽上传进行中标记 (串行, 防止并发 SFTP 通道冲突)
let sftpDragDepth = 0;         // dragenter/dragleave 嵌套计数 (子元素穿梭时保持高亮)

function clearSftpDropActive() {
  sftpDragDepth = 0;
  const panel = $('#sftpPanel');
  if (panel) panel.classList.remove('sftp-drop-active');
}

function onSftpDragEnter(e) {
  // 防误触: 仅已连接会话展示的面板响应拖拽
  if (!currentSftpSession()) return;
  e.preventDefault();
  sftpDragDepth++;
  const panel = $('#sftpPanel');
  if (panel) panel.classList.add('sftp-drop-active');
}

function onSftpDragOver(e) {
  if (!currentSftpSession()) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onSftpDragLeave(e) {
  sftpDragDepth = Math.max(0, sftpDragDepth - 1);
  if (sftpDragDepth === 0) clearSftpDropActive();
}

// drop 主入口: 过滤目录 -> 取真实路径 -> 登记 -> 串行复用现有 sftpUpload 链路
async function handleSftpDrop(e) {
  e.preventDefault();
  clearSftpDropActive();
  const session = currentSftpSession();
  if (!session) {
    toast('请先连接会话再拖拽上传', 'info');
    return;
  }
  if (sftpDragUploading) {
    toast('上一批上传仍在进行, 请稍候', 'info');
    return;
  }
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return;

  // 目录检测 (webkitGetAsEntry; 文件夹本次不支持递归上传, 提示并忽略)
  let dirCount = 0;
  const items = Array.from(dt.items || []);
  for (const item of items) {
    if (!item || item.kind !== 'file') continue;
    try {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry && entry.isDirectory) dirCount++;
    } catch (err) { /* 无法判型的项忽略 */ }
  }

  // 逐文件取真实本地路径 (preload webUtils.getPathForFile, 同步; 去重)
  const localFiles = Array.from(dt.files);
  const localPaths = [];
  for (const file of localFiles) {
    let p = '';
    try { p = window.nimbus.getPathForFile(file) || ''; } catch (err) { p = ''; }
    if (p && !localPaths.includes(p)) localPaths.push(p);
  }

  if (localPaths.length === 0) {
    if (dirCount > 0) toast('文件夹暂不支持拖拽上传', 'info');
    else toast('无法获取拖拽文件路径', 'error');
    return;
  }
  if (dirCount > 0) toast(`已忽略 ${dirCount} 个文件夹 (暂不支持目录上传)`, 'info');

  // 登记路径 (主进程过滤不存在/目录) -> 仅上传登记成功的路径
  // P0-4: 路径解析与登记全部移到 preload (webUtils.getPathForFile), 渲染层只传真实 File 数组
  let reg;
  try {
    reg = await window.nimbus.sftpRegisterUploadPaths(localFiles);
  } catch (err) {
    toast('拖拽上传失败: ' + (err.message || '未知错误'), 'error');
    return;
  }
  const accepted = (reg && reg.ok && Array.isArray(reg.accepted)) ? reg.accepted : [];
  if (accepted.length === 0) {
    toast('没有可上传的文件 (文件夹暂不支持)', 'info');
    return;
  }

  sftpDragUploading = true;
  try {
    await uploadLocalPaths(session, accepted);
  } finally {
    sftpDragUploading = false;
  }
}

// 绑定 SFTP 面板拖拽事件 (init 时调用一次)
function initSftpDragDrop() {
  const panel = $('#sftpPanel');
  if (!panel) return;
  panel.addEventListener('dragenter', onSftpDragEnter);
  panel.addEventListener('dragover', onSftpDragOver);
  panel.addEventListener('dragleave', onSftpDragLeave);
  panel.addEventListener('drop', handleSftpDrop);
  // 全局禁止拖拽文件触发页面默认行为 (打开文件/跳转); 面板外/未连接时一律忽略
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// ============ 内置文档查看器 ============
// 打开文档 -> 主进程 sftp 下载到 DOC_DIR (nimbus-doc://) -> 文档标签 + 主区域查看器视图。
// 渲染策略 (实测结论 2026-08-11):
// - 方案 A (iframe + Chromium 内置 PDF viewer): 不可行 — Electron 31.7.7 (Chromium 126)
//   内置 PDF viewer 扩展未启用 (plugins:true + file:// 顶层均实测失败)。
// - 方案 B (pdfjs-dist 4.10.38): 可行 — 动态 import + fetch worker 源码为 blob URL
//   (CSP worker-src blob:) + getDocument({url: nimbus-doc://...}) + canvas 渲染。
//   注意: 不能用 v6 (依赖 Promise.try, Chromium 126 不支持), 已锁定 ^4.10.38。
// - docx: mammoth.browser.js (经典 script 从 node_modules 加载) -> convertToHtml(arrayBuffer)。

// 判断文件名扩展名是否在文档白名单内; 返回小写扩展名 (含 .) 或 ''
function getDocExtension(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot).toLowerCase();
  return DOC_EXTENSIONS.includes(ext) ? ext : '';
}

// 打开文档查看器: 下载 + 文档标签 (图片仍走 openPreview, 不进入查看器; 打开文档不额外新建终端)
// 第三个参数 remotePathOverride: 递归搜索结果在远端其他目录时以完整路径打开 (默认当前目录拼接)
async function openDocViewer(session, entry, remotePathOverride) {
  const remotePath = remotePathOverride || joinRemotePath(session.currentPath, entry.name);
  const ext = getDocExtension(entry.name);
  if (!ext) {
    toast('不支持打开该文件类型', 'error');
    return;
  }
  // 主进程内部下载到 DOC_DIR (白名单校验 + 防目录穿越; 大文件分段预览由主进程处理)
  let res;
  try {
    res = await window.nimbus.docOpen(session.sessionId, remotePath);
  } catch (err) {
    toast('打开文档异常: ' + (err.message || '未知错误'), 'error');
    return;
  }
  if (!res || !res.ok) {
    toast((res && res.error) || '打开文档失败', 'error');
    return;
  }
  const doc = {
    docId: genId(),
    name: res.name,
    remotePath,
    sessionId: session.sessionId,
    filename: res.filename,
    url: res.url,
    ext: res.ext,
    isText: !!res.isText,
    // Roadmap 第一梯队 ③ (M): 大文件分段加载 (主进程返回; 旧版/测试桩无这些字段时按全量处理)
    truncated: !!res.truncated,
    totalSize: (res && typeof res.totalSize === 'number') ? res.totalSize : 0,
    previewText: (res && typeof res.previewText === 'string') ? res.previewText : '',
    _text: '',          // 文本类文档当前完整内容 (编辑/高亮共用)
    _editorMode: 'edit', // 'edit' (textarea) | 'view' (语法高亮预览)
  };

  openDocTab(doc);
}

// 创建文档标签 + 渲染内容 + 激活查看器
function openDocTab(doc) {
  docTabs.set(doc.docId, doc);
  // 独立内容容器: 标签切换时复用 (PDF 保持打开, 不重复下载)
  doc.bodyEl = document.createElement('div');
  doc.bodyEl.className = 'doc-content';
  const tab = document.createElement('div');
  tab.className = 'tab doc-tab';
  tab.id = 'doctab-' + doc.docId;
  tab.dataset.docId = doc.docId;
  tab.innerHTML = `
    <span class="tab-dot"></span>
    <span class="tab-name">📄 ${escapeHtml(doc.name)}</span>
    <button class="tab-close" title="关闭">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) return;
    activateDocTab(doc.docId);
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeDocTab(doc.docId);
  });
  doc.tabEl = tab;
  $('#tabs').appendChild(tab);
  renderDocContent(doc);
  activateDocTab(doc.docId);
}

// 激活文档标签: 隐藏终端视图, 显示查看器; 侧边栏 SFTP 面板跟随文档所属会话
function activateDocTab(docId) {
  const doc = docTabs.get(docId);
  if (!doc) return;
  activeDocId = docId;
  $$('.tab').forEach((t) => t.classList.remove('active'));
  doc.tabEl.classList.add('active');

  // 主区域只显示查看器: 隐藏全部终端 host + terminalArea 容器
  $('#terminalArea').style.display = 'none';
  $$('.terminal-host').forEach((h) => (h.style.display = 'none'));
  $('#docViewer').style.display = 'flex';
  $('#emptyState').style.display = 'none';
  $('#statusbar').style.display = 'flex';

  // 标题栏: 文件名 + 保存按钮仅文本类显示 (编辑模式且非分段预览时才允许保存)
  $('#docTitleName').textContent = doc.name;
  updateDocTextControls(doc);

  // 侧边栏保持展示文档所在目录 (复用 showSftpFor 竞态防护)
  showSftpFor(doc.sessionId);

  // 挂载该文档的内容容器 (已渲染则直接复用, PDF 保持打开状态)
  const body = $('#docViewerBody');
  body.innerHTML = '';
  if (!doc.bodyEl) {
    doc.bodyEl = document.createElement('div');
    doc.bodyEl.className = 'doc-content';
  }
  body.appendChild(doc.bodyEl);
  // PDF 切回时容器尺寸可能变化 -> 触发一次重绘 (等比适配)
  if (doc._pdf && typeof doc._pdf.drawPage === 'function') {
    afterLayout(() => doc._pdf.drawPage());
  }
}

// 关闭文档标签: 清理临时文件 + PDF 资源 + 移除标签; 若正显示则激活其他标签/会话
async function closeDocTab(docId) {
  const doc = docTabs.get(docId);
  if (!doc) return;
  try { await window.nimbus.docClose(doc.filename); } catch (e) {}
  // 操作日志 (渲染侧补充: 文档关闭主进程未记录, 属 UI 生命周期事件)
  try { await window.nimbus.auditLog({ type: 'doc.close', target: doc.remotePath, result: 'success', session: doc.sessionId, detail: `关闭文档 ${doc.name}` }); } catch (e) {}
  docTabs.delete(docId);
  if (doc.tabEl) doc.tabEl.remove();
  // 释放 pdfjs 文档资源 (关闭渲染器)
  if (doc._pdf && doc._pdf.pdfDoc) {
    try { doc._pdf.pdfDoc.destroy(); } catch (e) {}
  }
  if (activeDocId === docId) {
    activeDocId = null;
    const remainingDocs = [...docTabs.keys()];
    if (remainingDocs.length > 0) {
      activateDocTab(remainingDocs[remainingDocs.length - 1]);
      return;
    }
    // 无文档标签 -> 隐藏查看器, 回到终端/空状态
    $('#docViewer').style.display = 'none';
    const remainingSessions = [...sessions.keys()].filter((k) => !k.startsWith('c_'));
    if (remainingSessions.length > 0) {
      activateSession(remainingSessions[remainingSessions.length - 1]);
    } else {
      $('#terminalArea').style.display = 'none';
      $('#emptyState').style.display = 'flex';
      $('#statusbar').style.display = 'none';
      showSftpFor(null);
    }
  }
}

// 渲染文档内容到 doc.bodyEl (文本 -> textarea; PDF -> pdfjs canvas; DOCX -> mammoth html)
async function renderDocContent(doc) {
  const el = doc.bodyEl;
  el.innerHTML = '';
  if (doc.isText) {
    renderDocText(doc);
  } else if (doc.ext === '.pdf') {
    renderDocPdf(doc);
  } else if (doc.ext === '.docx') {
    renderDocDocx(doc);
  } else if (doc.ext === '.doc') {
    el.innerHTML = `<div class="doc-error">旧版 .doc 暂不支持，请转存为 .docx 后打开</div>`;
  } else {
    el.innerHTML = `<div class="doc-error">不支持打开该文件类型</div>`;
  }
}

// ---------- Roadmap 第一梯队 ③ (M): 文本编辑增强 ----------
// 文本类文档渲染:
//   - 默认编辑模式 (textarea, 与旧版一致, 回归兼容; 保存语义不变);
//   - 「编辑/高亮」切换: 高亮预览为只读 (语法高亮, 基于扩展名/内容启发, 零依赖);
//   - 大文件分段: 超过阈值 (2MB) 时主进程只返回前 512KB 预览 (只读, 编辑禁用),
//     底部显示「加载全部」按钮; 点击后主进程追加剩余字节 -> 重新 fetch 完整内容 ->
//     恢复可编辑 (保存始终基于完整内容, 不截断文件)。
// XSS: 高亮 HTML 先 escape 再套关键词 span (editorHighlight.highlightText), 无注入面。

// 构建文本类文档的 DOM 容器 (truncate bar + 高亮 pre + textarea; 互斥显示)
function buildDocTextEditor(doc) {
  const el = doc.bodyEl;
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'doc-text-wrap';

  if (doc.truncated) {
    // 大文件分段预览提示栏
    const bar = document.createElement('div');
    bar.className = 'doc-truncate-bar';
    const total = doc.totalSize || 0;
    const preview = doc.previewText ? doc.previewText.length : 0;
    bar.innerHTML = `<span>文件过大，已加载前 ${formatSize(preview)} / 共 ${formatSize(total)}，是否加载全部？</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = '加载全部';
    btn.id = 'docLoadAllBtn';
    btn.addEventListener('click', () => loadFullDoc(doc));
    bar.appendChild(btn);
    wrap.appendChild(bar);
  }

  const pre = document.createElement('pre');
  pre.id = 'docHighlight';
  wrap.appendChild(pre);

  const ta = document.createElement('textarea');
  ta.id = 'docTextArea';
  ta.spellcheck = false;
  wrap.appendChild(ta);

  el.appendChild(wrap);
  doc._wrap = wrap;
}

// 渲染文本类文档 (按当前模式: 编辑 textarea / 高亮 pre; 分段预览强制高亮只读)
// 注意: 元素查询一律走 doc._wrap (bodyEl 挂载到 #docViewerBody 前也可渲染, 避免时序问题)
function renderDocTextView(doc) {
  const wrap = doc._wrap || doc.bodyEl;
  const pre = wrap ? wrap.querySelector('#docHighlight') : null;
  const ta = wrap ? wrap.querySelector('#docTextArea') : null;
  if (!pre || !ta) return;
  const truncated = !!doc.truncated;
  const viewMode = truncated || doc._editorMode === 'view';
  pre.style.display = viewMode ? '' : 'none';
  ta.style.display = viewMode ? 'none' : '';
  if (viewMode) {
    // 语法高亮: 所有内容先 escape 再套关键词 span (零依赖; 超过 500KB 降级纯文本)
    const hl = (editorHighlightApi && typeof editorHighlightApi.highlightText === 'function')
      ? editorHighlightApi.highlightText(doc._text || '', doc.ext || '', {})
      : { html: escapeHtml(doc._text || ''), language: null, degraded: false };
    pre.innerHTML = hl.html;
  } else {
    ta.value = doc._text || '';
  }
  updateDocTextControls(doc);
}

// 同步文档头部控件可见性: 编辑切换按钮 (文本类显示) + 保存按钮 (编辑模式且非分段预览)
function updateDocTextControls(doc) {
  const toggle = $('#docEditToggle');
  const saveBtn = $('#docSaveBtn');
  if (!doc || !doc.isText) {
    if (toggle) toggle.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'none';
    return;
  }
  if (toggle) {
    toggle.style.display = '';
    toggle.textContent = doc._editorMode === 'view' ? '编辑' : '高亮';
  }
  if (saveBtn) {
    // 分段预览只读 (避免误保存截断文件): 仅完整加载且处于编辑模式时可保存
    saveBtn.style.display = (!doc.truncated && doc._editorMode === 'edit') ? '' : 'none';
  }
}

// 编辑 <-> 高亮 模式切换 (docEditToggle 点击; 分段预览时禁用编辑)
function toggleDocEditorMode(doc) {
  if (!doc || !doc.isText) return;
  if (doc.truncated) {
    toast('文件较大，请先点击「加载全部」后再编辑', 'info');
    return;
  }
  const wrap = doc._wrap || doc.bodyEl;
  const ta = wrap ? wrap.querySelector('#docTextArea') : null;
  if (doc._editorMode === 'edit') {
    // 编辑 -> 高亮: 同步当前 textarea 内容到 backing
    if (ta) doc._text = ta.value;
    doc._editorMode = 'view';
  } else {
    // 高亮 -> 编辑: backing 内容回填 textarea
    doc._editorMode = 'edit';
    if (ta) ta.value = doc._text || '';
  }
  renderDocTextView(doc);
}

// 加载全部 (大文件分段预览): 主进程追加剩余字节 -> 重新 fetch 完整内容 -> 恢复可编辑
async function loadFullDoc(doc) {
  if (!doc || !doc.truncated) return;
  let res;
  try {
    res = await window.nimbus.docLoadFull(doc.sessionId, doc.filename);
  } catch (err) {
    toast('加载全部失败: ' + (err.message || '未知错误'), 'error');
    return;
  }
  if (!res || !res.ok) {
    toast((res && res.error) || '加载全部失败', 'error');
    return;
  }
  try {
    const fr = await fetch(doc.url);
    if (!fr.ok) throw new Error('HTTP ' + fr.status);
    doc._text = await fr.text();
  } catch (err) {
    toast('加载全部失败: ' + (err.message || '未知错误'), 'error');
    return;
  }
  // 完成: 标记完整加载, 移除 truncate bar, 切换编辑模式
  doc.truncated = false;
  doc._editorMode = 'edit';
  renderDocTextView(doc);
  toast('已加载全部内容，可编辑保存', 'success');
}

// 文本类文档渲染入口: 大文件 -> 分段预览; 小文件 -> fetch 全量后默认编辑模式
function renderDocText(doc) {
  const el = doc.bodyEl;
  el.innerHTML = '';
  doc._text = '';
  doc._editorMode = 'edit';
  buildDocTextEditor(doc);

  if (doc.truncated) {
    // 分段预览: 直接使用主进程返回的前段内容 (只读, 高亮展示)
    doc._text = doc.previewText || '';
    renderDocTextView(doc);
    return;
  }

  fetch(doc.url).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then((text) => {
    doc._text = text;
    renderDocTextView(doc);
  }).catch((err) => {
    el.innerHTML = `<div class="doc-error">加载失败: ${escapeHtml(err.message)}</div>`;
  });
}

// 保存文本类文档: 经 doc:save 写流覆盖远端文件 (UTF-8)
// 仅编辑模式且完整加载时可保存 (分段预览只读, 保存逻辑基于完整内容)
async function saveDocText(doc) {
  const wrap = doc && (doc._wrap || doc.bodyEl);
  const ta = wrap ? wrap.querySelector('#docTextArea') : null;
  if (!ta || !doc || doc.isText !== true) return;
  if (doc.truncated) {
    toast('文件较大，请先点击「加载全部」后再保存', 'info');
    return;
  }
  const res = await window.nimbus.docSave(doc.sessionId, doc.remotePath, ta.value);
  if (res && res.ok) {
    doc._text = ta.value;
    toast(`已保存 ${doc.name}`, 'success');
  } else {
    toast((res && res.error) || '保存失败', 'error');
  }
}

// PDF: pdfjs-dist 动态 import + blob worker + canvas 渲染 (上一页/下一页/页码/缩放/适应宽度)
async function renderDocPdf(doc) {
  const el = doc.bodyEl;
  el.innerHTML = `
    <div class="pdf-toolbar">
      <button class="icon-btn" id="pdfPrev" title="上一页">◀</button>
      <span class="pdf-page-label" id="pdfPageLabel">1 / 1</span>
      <button class="icon-btn" id="pdfNext" title="下一页">▶</button>
      <span class="pdf-toolbar-sep"></span>
      <button class="icon-btn" id="pdfZoomOut" title="缩小">−</button>
      <span class="pdf-zoom-label" id="pdfZoomLabel">100%</span>
      <button class="icon-btn" id="pdfZoomIn" title="放大">+</button>
      <button class="icon-btn" id="pdfFit" title="适应宽度">⛶</button>
    </div>
    <div class="pdf-stage" id="pdfStage">
      <div class="pdf-empty">正在加载 PDF...</div>
    </div>`;
  const stage = el.querySelector('#pdfStage');

  try {
    // 动态 import pdfjs: 相对路径基于文档 base (src/index.html) -> 项目 node_modules
    const pdfjs = await import('../node_modules/pdfjs-dist/build/pdf.min.mjs');
    // blob worker: fetch worker 源码 -> Blob URL (CSP 需 worker-src blob:; 实测通过)
    let workerOk = false;
    try {
      const workerUrl = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', document.baseURI).toString();
      const wr = await fetch(workerUrl);
      const code = await wr.text();
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      workerOk = true;
    } catch (err) {
      console.warn('[doc-pdf] worker 加载失败, 尝试无 worker 直连:', err);
      // 兜底: workerSrc 指向相对路径, 由 pdfjs 自行尝试加载 (部分环境可工作)
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', document.baseURI).toString();
      workerOk = true;
    }
    const pdfDoc = await pdfjs.getDocument({ url: doc.url }).promise;

    // 渲染状态: 页码/缩放/画布
    const state = {
      pdfDoc,
      page: 1,
      zoom: 100,           // 百分比 (fit 宽度时由容器计算)
      fitWidth: true,      // 默认适应宽度
    };
    state.drawPage = () => drawPdfPage(doc, state, stage);
    doc._pdf = state;

    const prevBtn = el.querySelector('#pdfPrev');
    const nextBtn = el.querySelector('#pdfNext');
    const pageLabel = el.querySelector('#pdfPageLabel');
    const zoomOutBtn = el.querySelector('#pdfZoomOut');
    const zoomInBtn = el.querySelector('#pdfZoomIn');
    const zoomLabel = el.querySelector('#pdfZoomLabel');
    const fitBtn = el.querySelector('#pdfFit');

    const updateNav = () => {
      pageLabel.textContent = `${state.page} / ${state.pdfDoc.numPages}`;
      prevBtn.classList.toggle('disabled', state.page <= 1);
      nextBtn.classList.toggle('disabled', state.page >= state.pdfDoc.numPages);
      zoomLabel.textContent = state.zoom + '%';
    };
    prevBtn.addEventListener('click', () => {
      if (state.page > 1) { state.page--; state.fitWidth = false; state.drawPage(); updateNav(); }
    });
    nextBtn.addEventListener('click', () => {
      if (state.page < state.pdfDoc.numPages) { state.page++; state.fitWidth = false; state.drawPage(); updateNav(); }
    });
    zoomOutBtn.addEventListener('click', () => {
      state.zoom = Math.max(25, state.zoom - 25);
      state.fitWidth = false;
      state.drawPage(); updateNav();
    });
    zoomInBtn.addEventListener('click', () => {
      state.zoom = Math.min(400, state.zoom + 25);
      state.fitWidth = false;
      state.drawPage(); updateNav();
    });
    fitBtn.addEventListener('click', () => {
      state.fitWidth = true;
      state.drawPage(); updateNav();
    });
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomInBtn.click(); else zoomOutBtn.click();
    }, { passive: false });

    // 首次绘制 (等容器布局稳定)
    afterLayout(() => { state.drawPage(); updateNav(); });
  } catch (err) {
    stage.innerHTML = `<div class="doc-error">PDF 加载失败: ${escapeHtml(err.message)}</div>`;
  }
}

// 绘制 PDF 当前页 (适应宽度: 按 stage 宽度等比; 手动缩放: 按百分比)
function drawPdfPage(doc, state, stage) {
  if (!state || !state.pdfDoc) return;
  const page = state.pdfDoc.getPage(state.page);
  page.then((pdfPage) => {
    // 清理旧 canvas
    const old = stage.querySelector('canvas');
    if (old) old.remove();
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    let scale;
    if (state.fitWidth) {
      const avail = Math.max(80, stage.clientWidth - 32);
      scale = avail / baseViewport.width;
      state.zoom = Math.round(scale * 100);
      const zoomLabel = stage.parentElement.querySelector('#pdfZoomLabel');
      if (zoomLabel) zoomLabel.textContent = state.zoom + '%';
    } else {
      scale = state.zoom / 100;
    }
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    stage.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    pdfPage.render({ canvasContext: ctx, viewport }).promise.catch((err) => {
      console.warn('[doc-pdf] 渲染页失败:', err);
    });
  }).catch((err) => {
    console.warn('[doc-pdf] 取页失败:', err);
  });
}

// 轻量 HTML 净化 (mammoth DOCX 输出用, P3): 防止文档内嵌恶意内容在查看器内执行。
// 处理: 剥离 <script> 标签(含内容)、所有 on\w+= 事件属性、javascript: URL、
//       非图片 data: URL (src/href)、<iframe>/<object>/<embed> 危险嵌入标签。
// 放行 data:image/*: DOCX 内嵌图片以 src="data:image/png;base64,..." 形式出现, 属正常功能;
//                   <img> 加载图片数据不执行脚本, 无 XSS 风险 (CSP 第二层防线兜底)。
// 局限: 正则净化不保证覆盖全部 XSS 向量 (编码混淆/嵌套变体等), 应用 CSP 已是第二层防线,
//       本函数仅作纵深防御; 若需更强保证应引入 DOMPurify 等成熟库。
function sanitizeHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  let out = html;
  // 1) 剥离 <script>...</script> (含内容, 大小写不敏感, 允许跨行)
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  // 2) 剥离危险嵌入标签 <iframe>/<object>/<embed> (含开闭标签; 残留文本无执行能力)
  out = out.replace(/<\/?(?:iframe|object|embed)\b[^>]*>/gi, '');
  // 3) 剥离所有事件处理属性 on\w+= (onclick/onerror/onload 等, 单/双引号或裸值)
  out = out.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 4a) 剥离 src/href 属性中 javascript: 协议 URL (单/双引号或裸值, 大小写不敏感)
  out = out.replace(
    /\s(?:src|href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    ''
  );
  // 4b) 剥离 src/href 属性中非图片 data: URL (保留 data:image/* 供 DOCX 内嵌图使用;
  //     (?!image\/) 负向前瞻: 大小写不敏感, 单/双引号或裸值)
  out = out.replace(
    /\s(?:src|href)\s*=\s*(?:"data:(?!image\/)[^"]*"|'data:(?!image\/)[^']*'|data:(?!image\/)[^\s>]+)/gi,
    ''
  );
  return out;
}

// DOCX: mammoth 外部 script -> convertToHtml(arrayBuffer) -> 净化后注入只读 HTML
async function renderDocDocx(doc) {
  const el = doc.bodyEl;
  el.innerHTML = `<div class="docx-loading"><div class="overlay-spinner"></div><span>正在解析 DOCX...</span></div>`;
  try {
    const res = await fetch(doc.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    el.innerHTML = `<div class="docx-content">${sanitizeHtml(result.value || '')}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="doc-error">DOCX 解析失败: ${escapeHtml(err.message)}</div>`;
  }
}

// ============ 可调节布局 (侧边栏宽度 + 表格列宽) ============
// 三列布局: 名称 (加宽承接操作列释放的宽度) / 大小 / 修改时间
const COL_DEFAULTS = { name: 200, size: 62, mtime: 108 };
const COL_MIN_WIDTH = 40;
const COL_MAX_WIDTH = 320;

// 读取持久化的列宽 (合并默认值, 容错)
function loadColWidths() {
  try {
    const raw = localStorage.getItem('nimbus.colWidths');
    return raw ? Object.assign({}, COL_DEFAULTS, JSON.parse(raw)) : Object.assign({}, COL_DEFAULTS);
  } catch (e) {
    return Object.assign({}, COL_DEFAULTS);
  }
}

// 将列宽应用到 <colgroup>
function applyColWidths(widths) {
  document.querySelectorAll('#sftpTable col[data-col]').forEach((col) => {
    const key = col.dataset.col;
    if (typeof widths[key] === 'number' && widths[key] > 0) {
      col.style.width = widths[key] + 'px';
    }
  });
}

// 侧边栏宽度拖拽: pointer 事件 + setPointerCapture, clamp 280~560px
function initSidebarResizer() {
  const resizer = $('#sidebarResizer');
  const sidebar = document.querySelector('.sidebar');
  if (!resizer || !sidebar) return;
  let startX = 0;
  let startW = 0;
  let dragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('active');
    document.body.classList.add('is-resizing');
    e.preventDefault();
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.min(560, Math.max(280, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    // 拖拽中仅更新侧边栏宽度 (让布局跟手), 不再每帧对终端 fit:
    // 连续 fit 在容器宽度不稳定时会算出 cols=0, 导致 xterm 渲染空白。
    // 终端尺寸统一在 pointerup 结束拖拽时 fitSafe 一次。
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.classList.remove('is-resizing');
    localStorage.setItem('nimbus.sidebarWidth', String(sidebar.getBoundingClientRect().width));
    // 拖拽结束: 从缓存重绘当前文件列表, 确保列宽/省略号按新容器重排
    const s = currentSftpSession();
    if (s && s.fileEntries) renderFileList(s, s.fileEntries);
    // 拖拽结束等布局稳定后统一 fit 一次 (rAF 包裹, 避免在中间态计算行列; fitSafe 幂等)
    afterLayout(() => fitActiveTerminal());
  };

  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
}

// 表格列宽拖拽: 表头 th 内的 .col-resizer 手柄, clamp 40~320px
function initColResizers() {
  const table = $('#sftpTable');
  if (!table) return;
  applyColWidths(loadColWidths());

  table.querySelectorAll('.col-resizer').forEach((resizer) => {
    const key = resizer.dataset.col;
    if (!key) return;
    let startX = 0;
    let startW = 0;
    let dragging = false;

    resizer.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      const col = table.querySelector(`col[data-col="${key}"]`);
      startW = col ? (parseFloat(col.style.width) || COL_DEFAULTS[key]) : COL_DEFAULTS[key];
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('active');
      document.body.classList.add('is-resizing');
      e.preventDefault();
      e.stopPropagation();
    });

    resizer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = Math.min(COL_MAX_WIDTH, Math.max(COL_MIN_WIDTH, startW + (e.clientX - startX)));
      const col = table.querySelector(`col[data-col="${key}"]`);
      if (col) col.style.width = w + 'px';
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('active');
      document.body.classList.remove('is-resizing');
      const col = table.querySelector(`col[data-col="${key}"]`);
      const finalW = col ? (parseFloat(col.style.width) || COL_DEFAULTS[key]) : COL_DEFAULTS[key];
      const widths = loadColWidths();
      widths[key] = finalW;
      localStorage.setItem('nimbus.colWidths', JSON.stringify(widths));
    };

    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);
  });
}

// ============ 图片预览 (渲染进程缓存 + 预加载, 切图 <50ms) ============
const PREVIEW_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
const MAX_PREVIEW_CACHE = 30;  // LRU 缓存上限 (图片数, 防内存膨胀)

// 预览缓存: key = `${sessionId}:${remotePath}`
//   - 命中 -> 直接返回 blobUrl, 0 网络/磁盘等待 (切图/重开瞬时)
//   - 未命中 -> 主进程下载到临时文件 -> fetch 转 blob -> 缓存 -> 立即清理临时文件
// LRU: 超出上限时弹出最久未访问条目, URL.revokeObjectURL 释放内存
const previewCache = new Map();

// 预览状态 (全局单一实例)
const previewState = {
  sessionId: null,    // 所属会话
  remotePath: null,   // 远端原始路径 (另存为用)
  name: null,         // 远端文件名
  zoom: 100,          // 缩放百分比 10~300
  rotate: 0,          // 旋转角度 0/90/180/270
  imageList: [],      // 当前目录图片文件列表 [ {name, remotePath} ] (左右切换用)
  imageIndex: -1,     // 当前图片在 imageList 中的索引
  navigating: false,  // 切换锁: 防止连点竞态
  navToken: 0,        // 代际令牌: openPreview/closePreview 递增, 作废在途 nav/open 的过期结果
};

// 判断是否为可预览的图片文件名
function isImageName(name) {
  if (typeof name !== 'string') return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return PREVIEW_IMAGE_EXTS.includes(name.slice(dot + 1).toLowerCase());
}

// LRU 缓存淘汰: 弹出最久未使用条目, 释放 blobUrl
function evictOldestPreviewCacheEntry() {
  if (previewCache.size < MAX_PREVIEW_CACHE) return;
  const firstKey = previewCache.keys().next().value;
  const old = previewCache.get(firstKey);
  if (old && old.blobUrl) URL.revokeObjectURL(old.blobUrl);
  previewCache.delete(firstKey);
}

// 在途请求表: 防止并发的 getOrFetchPreview 对同一图重复下载
// value: Promise<{ok, url, name}>, 调用方 await 同一 Promise 即可共享结果
const previewInFlight = new Map();

// 获取或拉取预览图: 命中缓存 -> 直接返回 blobUrl; 未命中 -> 主进程下载 + fetch 转 blob + 缓存
// 失败兜底: blob 转换失败时直接返回 nimbus-preview:// URL, 临时文件保留供下次重试
async function getOrFetchPreview(sessionId, remotePath, name) {
  const key = sessionId + ':' + remotePath;
  // 1) 缓存命中: 移到末尾 (LRU 刷新), 直接返回
  if (previewCache.has(key)) {
    const entry = previewCache.get(key);
    entry.ts = Date.now();
    previewCache.delete(key);
    previewCache.set(key, entry);
    return { ok: true, url: entry.blobUrl, name: entry.name || name };
  }
  // 2) 已在途: 共享同一 Promise (避免双下载 + 临时文件泄漏)
  if (previewInFlight.has(key)) return previewInFlight.get(key);
  // 3) 缓存未命中: 主进程下载到临时目录 (异步入口放 in-flight 表)
  const promise = (async () => {
    const res = await window.nimbus.previewOpen(sessionId, remotePath);
    if (!res || !res.ok) return res;
    const filename = String(res.url).replace(/^nimbus-preview:\/\//, '');
    const displayName = res.name || name;
    let blobUrl = res.url; // fallback
    try {
      // 读临时文件 -> Blob (经自定义协议, Chromium 流式响应)
      const response = await fetch(res.url);
      if (!response.ok) throw new Error('fetch failed: ' + response.status);
      const blob = await response.blob();
      blobUrl = URL.createObjectURL(blob);
      // LRU 淘汰后写入缓存
      evictOldestPreviewCacheEntry();
      previewCache.set(key, { blobUrl, name: displayName, ts: Date.now(), size: blob.size });
      // 临时文件使命完成, 立即清理 (blob 已在内存, 无需磁盘副本)
      try { await window.nimbus.previewClose(filename); } catch (e) {}
    } catch (e) {
      console.warn('[preview] blob 转换失败, 使用直链 URL:', e);
      // fallback 时保留临时文件供下次重试
    }
    return { ok: true, url: blobUrl, name: displayName };
  })();
  previewInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    previewInFlight.delete(key);
  }
}

// 预加载相邻图片 (N-1 与 N+1), 空闲回调执行不阻塞 UI
// 列表较大 (>20) 时只预加载相邻 ±1, 不全量预加载, 避免内存爆炸
function prefetchAdjacent(sessionId, list, currentIndex) {
  if (!Array.isArray(list) || list.length <= 1) return;
  const adj = [currentIndex - 1, currentIndex + 1].filter((i) => i >= 0 && i < list.length);
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
  for (const i of adj) {
    const target = list[i];
    const key = sessionId + ':' + target.remotePath;
    if (previewCache.has(key)) continue;
    idle(() => {
      getOrFetchPreview(sessionId, target.remotePath, target.name).catch(() => {});
    });
  }
}

// 应用缩放 + 旋转变换并更新百分比标签
function applyPreviewTransform() {
  const img = $('#previewImg');
  if (img) {
    img.style.transform = `rotate(${previewState.rotate}deg) scale(${previewState.zoom / 100})`;
  }
  const label = $('#previewZoomLabel');
  if (label) label.textContent = previewState.zoom + '%';
}

// 打开预览: 优先命中缓存, 未命中走 getOrFetchPreview (主进程下载 + fetch blob + 缓存)
async function openPreview(sessionId, remotePath, name) {
  // 先快照当前目录并构建图片列表 (供左右切换; 顺序与文件列表一致)
  const session = sessions.get(sessionId);
  const dirPath = session ? session.currentPath : null;
  const dirEntries = session && Array.isArray(session.fileEntries) ? session.fileEntries : [];
  const imageList = [];
  for (const entry of dirEntries) {
    if (!entry.isDir && isImageName(entry.name)) {
      imageList.push({ name: entry.name, remotePath: joinRemotePath(dirPath, entry.name) });
    }
  }
  const imageIndex = imageList.findIndex((item) => item.remotePath === remotePath);

  // 作废所有在途 nav/open (本操作为最新一代), 防止过期结果覆盖新状态
  await closePreview();
  const token = previewState.navToken;
  const fetched = await getOrFetchPreview(sessionId, remotePath, name);
  if (!fetched || !fetched.ok) {
    toast((fetched && fetched.error) || '预览失败', 'error');
    return;
  }
  // 代际校验: 期间若有新的 open/close, 本次结果过期 -> 缓存项保留 (LRU 管理), 不再操作 UI
  if (token !== previewState.navToken) return;
  previewState.sessionId = sessionId;
  previewState.remotePath = remotePath;
  previewState.name = fetched.name || name || String(remotePath).split('/').pop() || '';
  previewState.zoom = 100;
  previewState.rotate = 0;
  previewState.imageList = imageList;
  previewState.imageIndex = imageIndex;
  previewState.navigating = false;

  const modal = $('#previewModal');
  const img = $('#previewImg');
  $('#previewTitle').textContent = previewState.name;
  modal.style.display = 'flex';
  img.onerror = () => {
    toast('图片加载失败', 'error');
    closePreview();
  };
  img.src = fetched.url;
  applyPreviewTransform();
  updatePreviewNavState();
  // 异步等待解码完成 (失败不阻塞, 浏览器仍会显示已解码部分; 命中缓存时几乎瞬时完成)
  img.decode().catch(() => {});
  // 空闲时预加载相邻 ±1 (切图时 0 等待)
  prefetchAdjacent(sessionId, imageList, imageIndex);
}

// 关闭预览: 隐藏模态 + 清理状态
// 注: 缓存保留, 下次打开同图直接命中 (LRU 淘汰自行管理); 临时文件已由 getOrFetchPreview 立即清理
async function closePreview() {
  ++previewState.navToken; // 作废所有在途 nav/open, 防止过期结果覆盖/泄漏
  const modal = $('#previewModal');
  if (modal) modal.style.display = 'none';
  const img = $('#previewImg');
  if (img) {
    img.onerror = null;
    img.removeAttribute('src');
  }
  previewState.sessionId = null;
  previewState.remotePath = null;
  previewState.name = null;
  previewState.zoom = 100;
  previewState.rotate = 0;
  previewState.imageList = [];
  previewState.imageIndex = -1;
  previewState.navigating = false;
}

// 缩放步进 (clamp 10%~300%)
function previewZoomBy(delta) {
  previewState.zoom = Math.min(300, Math.max(10, previewState.zoom + delta));
  applyPreviewTransform();
}

// 适应窗口: 按 stage 容器尺寸 contain 计算缩放比
function previewFitToWindow() {
  const img = $('#previewImg');
  const stage = $('#previewStage');
  if (!img || !stage) return;
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  if (!imgW || !imgH) return;
  const stageW = Math.max(1, stage.clientWidth - 40);
  const stageH = Math.max(1, stage.clientHeight - 40);
  const ratio = Math.min(stageW / imgW, stageH / imgH);
  previewState.zoom = Math.round(Math.min(300, Math.max(10, ratio * 100)));
  applyPreviewTransform();
}

// 旋转 90°
function previewRotate90() {
  previewState.rotate = (previewState.rotate + 90) % 360;
  applyPreviewTransform();
}

// 预览窗口「下载」: 走 preview:saveAs -> 系统保存对话框 -> 登记 sftpDownload
async function previewDownload() {
  if (!previewState.sessionId || !previewState.remotePath) {
    toast('预览会话已失效', 'error');
    return;
  }
  const res = await window.nimbus.previewSaveAs(previewState.sessionId, previewState.remotePath);
  if (res && res.ok) {
    toast(`已保存 ${previewState.name}`, 'success');
  } else {
    toast((res && res.error) || '保存失败', 'error');
  }
}

// 更新左右切换按钮状态: 列表<=1 隐藏两个按钮; 第一张禁用左, 最后一张禁用右
function updatePreviewNavState() {
  const prevBtn = $('#previewPrevBtn');
  const nextBtn = $('#previewNextBtn');
  if (!prevBtn || !nextBtn) return;
  const list = previewState.imageList;
  const count = Array.isArray(list) ? list.length : 0;
  const index = previewState.imageIndex;
  // 列表为空 / 仅一张 / 当前图不在目录快照 (index<0) -> 隐藏两个按钮 (避免 next 看似可用却静默无效)
  const hidden = count <= 1 || index < 0;
  prevBtn.style.display = hidden ? 'none' : '';
  nextBtn.style.display = hidden ? 'none' : '';
  prevBtn.classList.toggle('disabled', index <= 0);
  nextBtn.classList.toggle('disabled', index >= count - 1);
}

// 上一张/下一张切换 (delta=±1): 边界不循环, 加锁防连点竞态, 命中缓存瞬时切
async function previewNav(delta) {
  if (previewState.navigating) return;
  const list = previewState.imageList;
  if (!Array.isArray(list) || list.length === 0 || previewState.imageIndex < 0) return;

  const newIndex = previewState.imageIndex + delta;
  if (newIndex < 0 || newIndex >= list.length) {
    toast(newIndex < 0 ? '已是第一张' : '已是最后一张', 'info');
    return;
  }
  const target = list[newIndex];
  if (!target) return;

  // 记录切换前状态: 新图加载失败时回退用
  const prev = {
    sessionId: previewState.sessionId,
    remotePath: previewState.remotePath,
    name: previewState.name,
    imageIndex: previewState.imageIndex,
  };
  const token = previewState.navToken; // 记录本次切换的代际

  previewState.navigating = true;
  try {
    const fetched = await getOrFetchPreview(previewState.sessionId, target.remotePath, target.name);
    if (!fetched || !fetched.ok) {
      toast((fetched && fetched.error) || '切换图片失败', 'error');
      return; // 加载失败: 保持当前图片
    }
    // 代际校验: 期间若发生 close/open, 本次结果过期 -> 缓存项保留 (LRU 管理), 不再操作 UI
    if (token !== previewState.navToken || previewState.sessionId !== prev.sessionId) {
      return;
    }
    // 更新状态 (缩放/旋转复位)
    previewState.remotePath = target.remotePath;
    previewState.name = fetched.name || target.name;
    previewState.imageIndex = newIndex;
    previewState.zoom = 100;
    previewState.rotate = 0;

    const img = $('#previewImg');
    $('#previewTitle').textContent = previewState.name;
    // 切换专用 onerror: 新图加载失败时不关闭预览, 回退到上一张
    img.onerror = () => {
      if (previewState.sessionId === null) return; // 预览已关闭, 不再回退
      toast('图片加载失败', 'error');
      restorePreviewImage(prev);
    };
    img.src = fetched.url;
    applyPreviewTransform();
    updatePreviewNavState();
    img.decode().catch(() => {});
    prefetchAdjacent(previewState.sessionId, list, newIndex);
  } finally {
    previewState.navigating = false;
  }
}

// 切换失败回退: 重新打开切换前的图片并恢复状态 (保持当前图, 不跳转)
async function restorePreviewImage(prev) {
  if (!prev || !prev.sessionId || !prev.remotePath || previewState.sessionId === null) return;
  const token = previewState.navToken; // 记录回退代际
  const fetched = await getOrFetchPreview(prev.sessionId, prev.remotePath, prev.name);
  if (!fetched || !fetched.ok) {
    toast((fetched && fetched.error) || '恢复图片失败', 'error');
    closePreview();
    return;
  }
  // 代际校验: 回退期间若发生新的 open/close, 放弃本次回退
  if (token !== previewState.navToken || previewState.sessionId !== prev.sessionId) {
    return;
  }
  previewState.remotePath = prev.remotePath;
  previewState.name = fetched.name || prev.name;
  previewState.imageIndex = prev.imageIndex;
  previewState.zoom = 100;
  previewState.rotate = 0;

  const img = $('#previewImg');
  $('#previewTitle').textContent = previewState.name;
  img.onerror = () => {
    toast('图片加载失败', 'error');
    closePreview();
  };
  img.src = fetched.url;
  applyPreviewTransform();
  updatePreviewNavState();
  img.decode().catch(() => {});
}

// 预览模态事件绑定 (init 时调用一次)
function initPreviewEvents() {
  const modal = $('#previewModal');
  if (!modal) return;
  $('#previewCloseBtn').addEventListener('click', () => closePreview());
  $('#previewCloseBottom').addEventListener('click', () => closePreview());
  $('#previewZoomOut').addEventListener('click', () => previewZoomBy(-10));
  $('#previewZoomIn').addEventListener('click', () => previewZoomBy(10));
  $('#previewFit').addEventListener('click', previewFitToWindow);
  $('#previewOriginal').addEventListener('click', () => { previewState.zoom = 100; applyPreviewTransform(); });
  $('#previewRotate').addEventListener('click', previewRotate90);
  $('#previewDownload').addEventListener('click', previewDownload);
  // 左右切换按钮 (上一张/下一张)
  $('#previewPrevBtn').addEventListener('click', () => previewNav(-1));
  $('#previewNextBtn').addEventListener('click', () => previewNav(1));
  // 滚轮缩放 (preventDefault 避免页面滚动)
  $('#previewStage').addEventListener('wheel', (e) => {
    if (previewState.sessionId === null) return;
    e.preventDefault();
    previewZoomBy(e.deltaY < 0 ? 10 : -10);
  }, { passive: false });
  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePreview();
  });
}

// ============ 操作日志查看面板 ============
// 打开面板 (渲染侧手动埋点示例: 面板为纯 UI 事件, 主进程不感知, 由 renderer 补充记录)
async function openAuditPanel() {
  $('#auditOverlay').style.display = 'flex';
  try {
    await window.nimbus.auditLog({ type: 'audit.panel', target: '操作日志面板', result: 'success', detail: '打开操作日志面板' });
  } catch (e) {}
  refreshAuditLog();
}

function closeAuditPanel() {
  $('#auditOverlay').style.display = 'none';
}

// 刷新日志列表: 类型/结果筛选 + 最新 N 条 (时间范围简化为条数限制)
async function refreshAuditLog() {
  const typeFilter = $('#auditTypeFilter').value;
  const resultFilter = $('#auditResultFilter').value;
  const limit = parseInt($('#auditLimitSelect').value, 10) || 100;
  const loading = $('#auditLoading');
  const table = $('#auditTable');
  const empty = $('#auditEmpty');
  const tbody = $('#auditTbody');

  loading.style.display = 'flex';
  table.style.display = 'none';
  empty.style.display = 'none';
  empty.textContent = '暂无日志';

  let res;
  try {
    res = await window.nimbus.auditQuery({
      type: typeFilter || undefined,
      result: resultFilter || undefined,
      limit,
    });
  } catch (err) {
    loading.style.display = 'none';
    empty.style.display = 'flex';
    empty.textContent = '查询失败: ' + (err.message || '未知错误');
    return;
  }
  loading.style.display = 'none';

  // 查询失败: 读取 res.error 显示错误, 不展示误导性的空态/共 0 条
  if (res && res.ok === false) {
    const errMsg = (res.error && String(res.error)) ? String(res.error) : '未知错误';
    tbody.innerHTML = '';
    $('#auditCount').textContent = '查询失败';
    empty.textContent = '查询失败: ' + errMsg;
    empty.style.display = 'flex';
    return;
  }

  const items = (res && Array.isArray(res.items)) ? res.items : [];
  const total = (res && typeof res.total === 'number') ? res.total : 0;
  $('#auditCount').textContent = `共 ${total} 条`;

  if (items.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  table.style.display = '';
  tbody.innerHTML = items.map((it) => {
    const ts = escapeHtml(it.ts || '');
    const user = escapeHtml(it.user || '-');
    const typeSafe = escapeHtml(it.type || '-');
    const target = escapeHtml(it.target || '-');
    const resultSafe = escapeHtml(it.result || '-');
    const detail = escapeHtml(it.detail || '');
    const failRow = it.result === 'failure' ? ' audit-row-fail' : '';
    const badge = it.result === 'failure' ? 'badge-fail' : 'badge-ok';
    return `<tr class="${failRow}">
      <td class="audit-cell-ts">${ts}</td>
      <td class="audit-cell-user" title="${user}">${user}</td>
      <td class="audit-cell-type">${typeSafe}</td>
      <td class="audit-cell-target" title="${target}">${target}</td>
      <td class="audit-cell-result ${badge}">${resultSafe}</td>
      <td class="audit-cell-detail" title="${detail}">${detail}</td>
    </tr>`;
  }).join('');
}

// ============ 端口转发隧道管理面板 ============
// 与操作日志面板同构: 展示当前活动会话的隧道列表 (运行中/失败), 并合并显示该连接
// 持久化配置中「未运行」的隧道为「已停止」; 新增隧道会立即建立并持久化到 conn.tunnels
// (连接成功后主进程自动建立); 停止仅移除运行实例, 删除同时从持久化配置移除。
let tunnelPanelSessionId = null; // 面板当前展示的会话 (打开时锁定为活动会话)

function openTunnelPanel() {
  $('#tunnelOverlay').style.display = 'flex';
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  const hint = $('#tunnelSessionHint');
  if (!s) {
    tunnelPanelSessionId = null;
    if (hint) hint.textContent = '请先连接会话';
    renderTunnelList([]);
    return;
  }
  tunnelPanelSessionId = s.sessionId;
  if (hint) hint.textContent = `${s.name} (${s.config.username}@${s.config.host}:${s.config.port})`;
  refreshTunnelList();
}

function closeTunnelPanel() {
  $('#tunnelOverlay').style.display = 'none';
  tunnelPanelSessionId = null;
}

// 刷新隧道列表: 查询当前会话运行实例 + 合并连接持久化配置 (未运行项显示为「已停止」)
async function refreshTunnelList() {
  const s = tunnelPanelSessionId ? sessions.get(tunnelPanelSessionId) : null;
  if (!s) return;
  let live = [];
  try {
    const res = await window.nimbus.tunnelList(s.sessionId);
    if (res && res.ok && Array.isArray(res.tunnels)) live = res.tunnels;
  } catch (e) {
    toast('获取隧道列表失败', 'error');
    return;
  }

  // 合并连接配置: 未在运行列表中的配置项 -> 已停止
  const configured = [];
  if (s.connId) {
    const conn = connections.find((c) => c.id === s.connId);
    if (conn && Array.isArray(conn.tunnels)) configured.push(...conn.tunnels);
  }
  const seenPorts = new Set();
  const rows = live.map((t) => {
    seenPorts.add(Number(t.localPort));
    return Object.assign({}, t, { source: 'live' });
  });
  for (const c of configured) {
    const lp = Number(c.localPort);
    if (seenPorts.has(lp)) continue;
    seenPorts.add(lp);
    rows.push({
      id: null,
      localPort: lp,
      remoteHost: c.remoteHost || '127.0.0.1',
      remotePort: Number(c.remotePort),
      name: c.name || '',
      status: 'stopped',
      createdAt: 0,
      error: null,
      source: 'config',
    });
  }
  renderTunnelList(rows);
}

// 渲染隧道列表行: 本地端口 -> 远端主机:远端端口 + 名称 + 状态 + 创建时间 (+ 错误)
function renderTunnelList(rows) {
  const list = $('#tunnelList');
  const empty = $('#tunnelEmpty');
  if (!list || !empty) return;
  const items = Array.isArray(rows) ? rows : [];
  empty.style.display = items.length === 0 ? 'flex' : 'none';
  if (items.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = items.map((t) => {
    const name = t.name ? `<span class="tunnel-item-name">${escapeHtml(t.name)}</span>` : '';
    const statusLabel = { running: '运行中', starting: '启动中', stopped: '已停止', failed: '失败' }[t.status] || t.status;
    const timeLabel = t.createdAt ? formatTime(t.createdAt) : '-';
    const errorHtml = t.error ? `<div class="tunnel-item-error" title="${escapeHtml(t.error)}">${escapeHtml(t.error)}</div>` : '';
    const stopBtn = (t.status === 'running' || t.status === 'starting')
      ? `<button class="tunnel-btn" data-act="stop" data-port="${t.localPort}" title="停止隧道">停止</button>`
      : '';
    return `
      <div class="tunnel-item" data-tunnel-id="${escapeHtml(t.id || '')}" data-port="${t.localPort}">
        <div class="tunnel-item-main">
          <div class="tunnel-item-title">
            <span>localhost:${t.localPort}</span><span class="tunnel-arrow">→</span><span>${escapeHtml(t.remoteHost)}:${t.remotePort}</span>
            ${name}
          </div>
          <div class="tunnel-item-meta">创建于 ${timeLabel}</div>
          ${errorHtml}
        </div>
        <span class="tunnel-status ${t.status}">${statusLabel}</span>
        <div class="tunnel-item-actions">
          ${stopBtn}
          <button class="tunnel-btn danger" data-act="delete" data-port="${t.localPort}" title="删除隧道 (停止并移出连接配置)">删除</button>
        </div>
      </div>`;
  }).join('');

  // 行内操作事件委托 (stop / delete)
  list.querySelectorAll('.tunnel-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const port = Number(btn.dataset.port);
      if (act === 'stop') stopTunnelItem(port);
      else if (act === 'delete') deleteTunnelItem(port);
    });
  });
}

// 新增隧道: 校验 -> 主进程建立 -> 成功则持久化到连接配置 (下次连接自动建立)
async function addTunnel() {
  const s = tunnelPanelSessionId ? sessions.get(tunnelPanelSessionId) : null;
  if (!s || s.status !== 'connected') {
    toast('会话未连接, 无法创建隧道', 'error');
    return;
  }
  const localPort = parseInt($('#tunnelLocalPort').value, 10);
  const remotePort = parseInt($('#tunnelRemotePort').value, 10);
  const remoteHost = $('#tunnelRemoteHost').value.trim() || '127.0.0.1';
  const name = $('#tunnelName').value.trim();

  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    toast('本地端口无效 (1-65535)', 'error');
    $('#tunnelLocalPort').focus();
    return;
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    toast('远端端口无效 (1-65535)', 'error');
    $('#tunnelRemotePort').focus();
    return;
  }

  const cfg = { localPort, remoteHost, remotePort, name: name || '' };
  let res;
  try {
    res = await window.nimbus.tunnelStart(s.sessionId, cfg);
  } catch (e) {
    toast('创建隧道异常: ' + (e.message || '未知错误'), 'error');
    return;
  }
  if (res && res.ok) {
    toast(`隧道已建立: localhost:${localPort} -> ${remoteHost}:${remotePort}`, 'success');
    // 持久化到连接配置 (下次连接自动建立); 防重复 (同端口不重复写)
    persistTunnelToConnection(s, cfg);
    $('#tunnelLocalPort').value = '';
    $('#tunnelRemoteHost').value = '';
    $('#tunnelRemotePort').value = '';
    $('#tunnelName').value = '';
    refreshTunnelList();
  } else {
    toast((res && res.error) || '创建隧道失败', 'error');
  }
}

// 将隧道配置持久化到该会话对应的连接对象 (conn.tunnels), 随连接列表一起保存
function persistTunnelToConnection(session, cfg) {
  if (!session.connId) return;
  const conn = connections.find((c) => c.id === session.connId);
  if (!conn) return;
  if (!Array.isArray(conn.tunnels)) conn.tunnels = [];
  const lp = Number(cfg.localPort);
  if (conn.tunnels.some((t) => Number(t.localPort) === lp)) return;
  conn.tunnels.push({
    localPort: lp,
    remoteHost: cfg.remoteHost,
    remotePort: Number(cfg.remotePort),
    name: cfg.name || '',
  });
  persistConnections();
}

// 停止隧道: 仅移除运行实例 (配置保留, 仍会显示为「已停止」)
async function stopTunnelItem(localPort) {
  const s = tunnelPanelSessionId ? sessions.get(tunnelPanelSessionId) : null;
  if (!s) return;
  const res = await window.nimbus.tunnelStop(s.sessionId, localPort);
  if (res && res.ok) {
    toast(`隧道已停止: localhost:${localPort}`, 'info');
  } else {
    toast((res && res.error) || '停止隧道失败', 'error');
  }
  refreshTunnelList();
}

// 删除隧道: 先停止运行实例, 再从连接持久化配置移除 (下次连接不再自动建立)
async function deleteTunnelItem(localPort) {
  const s = tunnelPanelSessionId ? sessions.get(tunnelPanelSessionId) : null;
  if (!s) return;
  if (!confirm(`确定删除隧道 localhost:${localPort} 吗？\n将停止该隧道并从连接配置中移除。`)) return;
  await window.nimbus.tunnelStop(s.sessionId, localPort).catch(() => {});
  if (s.connId) {
    const conn = connections.find((c) => c.id === s.connId);
    if (conn && Array.isArray(conn.tunnels)) {
      conn.tunnels = conn.tunnels.filter((t) => Number(t.localPort) !== Number(localPort));
      persistConnections();
    }
  }
  toast('隧道已删除', 'info');
  refreshTunnelList();
}

// ============ 服务器健康监控面板 ============
// 与隧道面板同构: 展示当前活动会话服务器的 基本信息/GPU/CPU/内存/磁盘/负载。
// 数据来源: window.nimbus.monitorFetch (主进程 exec + node 端解析为结构化 JSON),
// 渲染层只负责卡片渲染。默认手动刷新; 「自动刷新」开关每 5s 静默刷新一次。
let monitorPanelSessionId = null; // 面板当前展示的会话 (打开时锁定为活动会话)
let monitorAutoTimer = null;      // 自动刷新定时器句柄
// GPU 折线滚动窗口 (60×5s = 5 分钟): 由 src/gpu-chart.js 纯模块创建, 每次刷新成功
// push 一点 (自动/手动刷新共用, 跟随 5s 自动刷新开关, 无独立定时器), 超出上限自动裁剪。
let monitorGpuHistory = (typeof window !== 'undefined' && window.GpuChart)
  ? window.GpuChart.createGpuHistory({ max: 60 })
  : null;

// 内存展示单位: 解析层保持 MB (内部稳定), 渲染层 MB/1024 -> GB (保留 1 位小数)。
// 进度条百分比计算不变 (MB 比例与 GB 比例等价); 磁盘 (df) 单位保持现状不动。
function formatGB(mb) {
  if (mb === null || mb === undefined || isNaN(mb)) return '-';
  return (mb / 1024).toFixed(1) + ' GB';
}

function openMonitorPanel() {
  $('#monitorOverlay').style.display = 'flex';
  const s = activeSessionId ? sessions.get(activeSessionId) : null;
  const hint = $('#monitorSessionHint');
  const errorEl = $('#monitorError');
  const fetchedEl = $('#monitorFetched');
  if (errorEl) errorEl.style.display = 'none';
  if (fetchedEl) fetchedEl.textContent = '';
  if (!s) {
    monitorPanelSessionId = null;
    stopMonitorAutoRefresh();
    if (hint) hint.textContent = '请先连接会话';
    $('#monitorGrid').innerHTML = '<div class="monitor-card wide"><div class="monitor-na">请先连接 SSH 会话, 再查看服务器健康指标。</div></div>';
    $('#monitorLoading').style.display = 'none';
    return;
  }
  monitorPanelSessionId = s.sessionId;
  if (hint) hint.textContent = `${s.name} (${s.config.username}@${s.config.host}:${s.config.port})`;
  // 重新打开面板时重置 GPU 折线窗口 (避免展示过期/稀疏采样)
  if (monitorGpuHistory) monitorGpuHistory.clear();
  refreshMonitor();
}

function closeMonitorPanel() {
  $('#monitorOverlay').style.display = 'none';
  monitorPanelSessionId = null;
  stopMonitorAutoRefresh();
}

// 停止自动刷新 (关闭面板 / 取消勾选时调用; 幂等)
function stopMonitorAutoRefresh() {
  if (monitorAutoTimer) {
    clearInterval(monitorAutoTimer);
    monitorAutoTimer = null;
  }
  const toggle = $('#monitorAutoToggle');
  if (toggle) toggle.checked = false;
}

// 自动刷新开关: 勾选后每 5s 静默刷新 (面板关闭/会话失效自动停止)
function toggleMonitorAutoRefresh() {
  const toggle = $('#monitorAutoToggle');
  if (!toggle) return;
  stopMonitorAutoRefresh();
  if (!toggle.checked) return;
  if (!monitorPanelSessionId) {
    toggle.checked = false;
    toast('请先连接会话', 'info');
    return;
  }
  monitorAutoTimer = setInterval(() => {
    if (!$('#monitorOverlay') || $('#monitorOverlay').style.display !== 'flex') {
      stopMonitorAutoRefresh();
      return;
    }
    refreshMonitor(true); // 静默刷新: 不弹 toast, 不闪 loading
  }, 5000);
}

// 刷新监控数据: silent=true 时静默刷新 (自动刷新用), 失败仅展示错误文案不弹 toast
async function refreshMonitor(silent) {
  const s = monitorPanelSessionId ? sessions.get(monitorPanelSessionId) : null;
  if (!s) {
    if (!silent) toast('请先连接会话', 'info');
    return;
  }
  const loading = $('#monitorLoading');
  const grid = $('#monitorGrid');
  const errorEl = $('#monitorError');
  const fetchedEl = $('#monitorFetched');
  if (errorEl) errorEl.style.display = 'none';
  if (!silent) {
    loading.style.display = 'flex';
    grid.innerHTML = '';
  }

  let res;
  try {
    res = await window.nimbus.monitorFetch(s.sessionId);
  } catch (err) {
    loading.style.display = 'none';
    if (errorEl) { errorEl.textContent = '获取监控数据异常: ' + (err.message || '未知错误'); errorEl.style.display = 'block'; }
    if (!silent) toast('获取监控数据失败', 'error');
    return;
  }
  loading.style.display = 'none';

  if (!res || res.ok === false) {
    const msg = (res && res.error) ? res.error : '未知错误';
    if (errorEl) { errorEl.textContent = '获取监控数据失败: ' + msg; errorEl.style.display = 'block'; }
    grid.innerHTML = '';
    if (!silent) toast('获取监控数据失败', 'error');
    return;
  }

  if (fetchedEl) fetchedEl.textContent = res.fetchedAt ? `采集于 ${formatMonitorTime(res.fetchedAt)}` : '';
  pushMonitorGpuSample(res);
  renderMonitorCards(res, grid);
}

// 每次刷新成功即向 GPU 折线窗口追加一个采样点 (自动/手动刷新共用)。
// GPU 不可用 (无 nvidia-smi / 解析失败) 时不追加, 卡片展示降级文案, 不影响其他指标。
function pushMonitorGpuSample(res) {
  if (!monitorGpuHistory || !res) return;
  const gpu = res.gpu;
  if (!gpu || gpu.available !== true || !Array.isArray(gpu.gpus) || gpu.gpus.length === 0) return;
  const g = gpu.gpus[0] || {};
  const util = (typeof g.util === 'number' && isFinite(g.util)) ? g.util : null;
  const memPct = (typeof g.memPct === 'number' && isFinite(g.memPct)) ? g.memPct : null;
  if (util === null && memPct === null) return; // 全部指标缺失, 无意义采样
  monitorGpuHistory.push(Date.now(), util, memPct);
}

// 采集时间展示 (ISO -> 本地可读格式)
function formatMonitorTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return iso;
  }
}

// 百分比条颜色: <70 蓝, 70-89 黄, >=90 红
function pctBarClass(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '';
  if (pct >= 90) return ' crit';
  if (pct >= 70) return ' warn';
  return '';
}

// 渲染监控卡片 (全部 escapeHtml, 防止远端输出注入)
function renderMonitorCards(res, grid) {
  const errors = (res.errors && typeof res.errors === 'object') ? res.errors : {};
  const sections = [];
  const errorNote = (key) => (errors[key] ? `<div class="monitor-na">${escapeHtml(errors[key])}</div>` : '<div class="monitor-na">无法获取</div>');

  // ---- 基本信息 (wide) ----
  const info = res.info || {};
  const infoRows = [
    ['服务器', res.identity || '-'],
    ['主机名', info.hostname || '-'],
    ['系统', info.os || '-'],
    ['服务器时间', info.date || '-'],
  ].map(([k, v]) => `<div class="monitor-metric"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join('');
  sections.push(`<div class="monitor-card wide"><h4>基本信息</h4>${infoRows}</div>`);

  // ---- GPU (基本信息下方; 无 nvidia-smi 时降级文案, 不阻塞面板) ----
  const gpu = res.gpu;
  const gpuChartLib = (typeof window !== 'undefined') ? window.GpuChart : null;
  if (gpu && gpu.available === true && Array.isArray(gpu.gpus) && gpu.gpus.length > 0) {
    const g = gpu.gpus[0] || {};
    const count = gpu.gpus.length;
    const gpuName = (g && g.name) ? escapeHtml(g.name) : 'GPU';
    const fmtNum = (v, digits) => (v === null || v === undefined || isNaN(v)) ? '-' : Number(v).toFixed(digits);
    const svg = (gpuChartLib && monitorGpuHistory) ? gpuChartLib.buildGpuChartSvg(monitorGpuHistory.points, buildGpuChartOpts()) : '';
    const chartHtml = svg
      ? `<div class="monitor-gpu-chart">${svg}</div>`
      : '<div class="monitor-na">等待采样数据... (开启自动刷新后每 5 秒采集一次)</div>';
    const nowHtml = `
      <div class="monitor-gpu-now">
        <span class="monitor-gpu-chip"><b>利用率</b>${fmtNum(g.util, 1)}%</span>
        <span class="monitor-gpu-chip"><b>显存</b>${fmtNum(g.memPct, 1)}%</span>
        <span class="monitor-gpu-chip"><b>温度</b>${fmtNum(g.temp, 0)}°C</span>
        <span class="monitor-gpu-chip"><b>功耗</b>${fmtNum(g.power, 1)}W</span>
      </div>`;
    const title = count > 1 ? `GPU (共 ${count} 张卡, 展示第 1 张) · ${gpuName}` : `GPU · ${gpuName}`;
    sections.push(`<div class="monitor-card wide monitor-gpu-card"><h4>${title}</h4>${chartHtml}${nowHtml}</div>`);
  } else {
    sections.push(`<div class="monitor-card wide monitor-gpu-card"><h4>GPU</h4><div class="monitor-na">未检测到 GPU 监控（需要 NVIDIA GPU + nvidia-smi）</div></div>`);
  }

  // ---- CPU (负载 + 使用率) ----
  const load = res.load;
  const cpu = res.cpu;
  if (load || cpu || errors.load || errors.cpu) {
    let loadHtml = '';
    if (load) {
      const l = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
      loadHtml = `<div class="monitor-metric"><span class="k">负载 (1 / 5 / 15 分钟)</span><span class="v">${l(load.load1)} / ${l(load.load5)} / ${l(load.load15)}</span></div>`;
      if (load.up) loadHtml += `<div class="monitor-metric"><span class="k">运行时长</span><span class="v">${escapeHtml(load.up)}</span></div>`;
    } else if (errors.load) {
      loadHtml = errorNote('load');
    }
    let cpuHtml = '';
    if (cpu) {
      const busy = (cpu.user !== null && cpu.system !== null) ? Math.min(100, Math.max(0, cpu.user + cpu.system)) : null;
      const idle = cpu.idle;
      const displayPct = busy !== null ? busy : idle !== null ? (100 - idle) : null;
      cpuHtml = `
        <div class="monitor-metric"><span class="k">CPU 使用率</span><span class="v">${displayPct !== null ? displayPct.toFixed(1) + '%' : '-'}</span></div>
        <div class="monitor-metric"><span class="k">用户 / 系统 / 空闲</span><span class="v">${cpu.user !== null ? cpu.user.toFixed(1) + '%' : '-'} / ${cpu.system !== null ? cpu.system.toFixed(1) + '%' : '-'} / ${idle !== null ? idle.toFixed(1) + '%' : '-'}</span></div>
        <div class="monitor-bar${pctBarClass(displayPct)}"><i style="width:${displayPct !== null ? Math.min(100, Math.max(0, displayPct)) : 0}%"></i></div>`;
    } else if (errors.cpu) {
      cpuHtml = errorNote('cpu');
    }
    sections.push(`<div class="monitor-card"><h4>CPU</h4>${loadHtml}${cpuHtml}</div>`);
  }

  // ---- 内存 (显示单位 GB: 解析层保持 MB, 渲染层 MB/1024 -> GB; 进度条比例不变) ----
  const mem = res.memory;
  if (mem || errors.memory) {
    if (mem) {
      const usedPct = (mem.totalMB > 0) ? Math.min(100, Math.max(0, (mem.usedMB / mem.totalMB) * 100)) : null;
      let swapHtml = '';
      if (mem.swapTotalMB !== null) {
        const swapPct = mem.swapTotalMB > 0 ? Math.min(100, Math.max(0, (mem.swapUsedMB / mem.swapTotalMB) * 100)) : 0;
        swapHtml = `
          <div class="monitor-metric"><span class="k">交换分区</span><span class="v">${formatGB(mem.swapUsedMB)} / ${formatGB(mem.swapTotalMB)}</span></div>
          <div class="monitor-bar${pctBarClass(swapPct)}"><i style="width:${swapPct}%"></i></div>`;
      }
      sections.push(`<div class="monitor-card"><h4>内存</h4>
        <div class="monitor-metric"><span class="k">已用 / 总量</span><span class="v">${formatGB(mem.usedMB)} / ${formatGB(mem.totalMB)}</span></div>
        <div class="monitor-metric"><span class="k">可用</span><span class="v">${formatGB(mem.freeMB)}</span></div>
        <div class="monitor-bar${pctBarClass(usedPct)}"><i style="width:${usedPct !== null ? usedPct : 0}%"></i></div>
        ${swapHtml}
      </div>`);
    } else {
      sections.push(`<div class="monitor-card"><h4>内存</h4>${errorNote('memory')}</div>`);
    }
  }

  // ---- 磁盘 (全部挂载点按使用率降序取前 5 条, 解析层已截断; 不按白名单过滤) ----
  // v1.1.0 起恢复 v21 之前原逻辑: 解析层 fetchMonitorData 直接返回 parseDf(disks, 5)
  // (全部 rows 按 Use% 降序截断 5), 此处直接渲染 res.disks, 不再有白名单过滤逻辑。
  // mounted 再做一次归一化 (与解析层 normalizeMountPath 语义一致), 兼容旧版主进程响应。
  const disks = (Array.isArray(res.disks) ? res.disks : []).map((d) => ({ ...d, mounted: normalizeMountPath(d.mounted) }));
  if (disks.length > 0 || errors.df) {
    const diskHtml = disks.length > 0
      ? disks.map((d) => `
        <div class="monitor-disk-row">
          <span class="monitor-disk-mount" title="${escapeHtml(d.mounted)}">${escapeHtml(d.mounted)}</span>
          <span class="monitor-disk-detail">${escapeHtml(d.size)} / ${escapeHtml(d.used)} / ${escapeHtml(d.avail)}</span>
          <span class="monitor-disk-pct">${escapeHtml(d.usePct)}</span>
          <span class="monitor-disk-bar${pctBarClass(d.usedPct)}"><i style="width:${d.usedPct !== null ? Math.min(100, Math.max(0, d.usedPct)) : 0}%"></i></span>
        </div>`).join('')
      : errorNote('df');
    sections.push(`<div class="monitor-card wide"><h4>磁盘</h4>${diskHtml}</div>`);
  }

  // ---- 汇总错误 (命令级失败提示, 不阻塞面板) ----
  const errKeys = Object.keys(errors).filter((k) => k !== 'df' && k !== 'load' && k !== 'cpu' && k !== 'memory');
  const errText = errKeys.map((k) => `${k}: ${errors[k]}`).join('; ');

  grid.innerHTML = sections.join('');
  const errorEl = $('#monitorError');
  if (errorEl) {
    if (errText) {
      errorEl.textContent = '部分指标采集失败: ' + errText;
      errorEl.style.display = 'block';
    } else {
      errorEl.style.display = 'none';
    }
  }
}

// ============ 新建连接弹窗 ============
function openModal() {
  closeConnDrawer();
  $('#modalOverlay').style.display = 'flex';
  $('#fHost').focus();
}

function closeModal() {
  $('#modalOverlay').style.display = 'none';
}

function getCurrentAuthMethod() {
  return document.querySelector('.auth-tab.active')?.dataset.auth || 'password';
}

function switchAuthPanel(method) {
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.auth === method));
  $('#panel-password').style.display = method === 'password' ? '' : 'none';
  $('#panel-privateKey').style.display = method === 'privateKey' ? '' : 'none';
  $('#panel-agent').style.display = method === 'agent' ? '' : 'none';
}

function handleConnect() {
  const name = $('#fName').value.trim() || null;
  const host = $('#fHost').value.trim();
  const port = parseInt($('#fPort').value, 10) || 22;
  const username = $('#fUser').value.trim();
  const method = getCurrentAuthMethod();

  if (!host) { toast('请输入主机地址', 'error'); $('#fHost').focus(); return; }
  if (!username) { toast('请输入用户名', 'error'); $('#fUser').focus(); return; }
  if (method === 'password' && !$('#fPassword').value) { toast('请输入密码', 'error'); $('#fPassword').focus(); return; }
  if (method === 'privateKey' && !$('#fKeyPath').value) { toast('请选择私钥文件', 'error'); return; }

  const conn = {
    id: 'c_' + Date.now().toString(36),
    name: name || `${username}@${host}:${port}`,
    host,
    port,
    username,
    authMethod: method,
    password: method === 'password' ? $('#fPassword').value : '',
    privateKeyPath: method === 'privateKey' ? $('#fKeyPath').value : '',
    passphrase: method === 'privateKey' ? $('#fPassphrase').value : '',
    // 主机密钥指纹校验 (TOFU): 默认开, 用户可取消勾选关闭
    hostKeyVerify: $('#fHostKeyVerify').checked,
  };

  // 保存连接
  connections.push(conn);
  persistConnections();
  renderConnectionList();

  // 清空表单
  $('#fName').value = ''; $('#fHost').value = ''; $('#fUser').value = '';
  $('#fPassword').value = ''; $('#fKeyPath').value = ''; $('#fPassphrase').value = '';
  switchAuthPanel('password');

  closeModal();
  openSession(conn);
}

// ============ 初始化 ============
async function init() {
  // IPC
  wireIPC();

  // 连接列表
  await loadConnections();

  // 事件绑定
  $('#btnConnections').addEventListener('click', toggleConnDrawer);
  $('#btnNewDrawer').addEventListener('click', openModal);
  $('#btnEmptyNew').addEventListener('click', openModal);
  $('#btnPlus').addEventListener('click', openModal);
  $('#btnCloseModal').addEventListener('click', closeModal);
  $('#btnCancel').addEventListener('click', closeModal);
  $('#btnConnect').addEventListener('click', handleConnect);

  // Roadmap ④: 命令收藏 (标签栏按钮 + 浮层面板)
  $('#btnFav').addEventListener('click', toggleFavPanel);
  $('#favClose').addEventListener('click', closeFavPanel);
  $('#favAddBtn').addEventListener('click', addFavCommand);
  $('#favCmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFavCommand();
  });
  // 收藏列表事件委托 (发送/删除; 列表由 renderFavList 重绘, 委托防重复绑定)
  $('#favList').addEventListener('click', (e) => {
    const sendBtn = e.target.closest('.fav-item-send');
    if (sendBtn) {
      const item = sendBtn.closest('.fav-item');
      if (item) sendFavCommand(item.dataset.ts);
      return;
    }
    const delBtn = e.target.closest('.fav-item-del');
    if (delBtn) {
      const item = delBtn.closest('.fav-item');
      if (item) deleteFavCommand(item.dataset.ts);
    }
  });
  // 点击面板外部关闭 (命令收藏浮层)
  document.addEventListener('click', (e) => {
    const panel = $('#favPanel');
    if (!panel || panel.style.display !== 'flex') return;
    if (e.target.closest('#favPanel') || e.target.closest('#btnFav')) return;
    closeFavPanel();
  });

  // Roadmap ⑤: 配置加密导出/导入 (连接抽屉按钮 + 共享密码弹窗)
  $('#btnExportConfig').addEventListener('click', () => openConfigPwdModal('export'));
  $('#btnImportConfig').addEventListener('click', () => openConfigPwdModal('import'));
  $('#configPwdOk').addEventListener('click', confirmConfigPwd);
  $('#configPwdCancel').addEventListener('click', closeConfigPwdModal);
  $('#configPwdClose').addEventListener('click', closeConfigPwdModal);
  $('#configPwdEye').addEventListener('click', () => {
    const p = $('#configPwdInput');
    p.type = p.type === 'password' ? 'text' : 'password';
  });
  $('#configPwdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmConfigPwd();
  });
  $('#configPwdModal').addEventListener('click', (e) => {
    if (e.target === $('#configPwdModal')) closeConfigPwdModal();
  });

  // Roadmap 第一梯队 ②: 主机密钥指纹校验弹窗 (TOFU, 防中间人)
  // 信任/接受按钮: confirm 形态 -> hostKeyAccept(override=false);
  // mismatch 形态 -> hostKeyAccept(override=true) 覆盖信任新指纹。
  $('#hostKeyAcceptBtn').addEventListener('click', () => {
    const isMismatch = getHostKeyModal().classList.contains('mismatch');
    resolveHostKeyDialog(true, isMismatch);
  });
  $('#hostKeyRejectBtn').addEventListener('click', () => resolveHostKeyDialog(false));
  $('#hostKeyClose').addEventListener('click', () => resolveHostKeyDialog(false));
  $('#hostKeyModal').addEventListener('click', (e) => {
    if (e.target === $('#hostKeyModal')) resolveHostKeyDialog(false);
  });

  // 搜索 (抽屉顶部)
  $('#searchInput').addEventListener('input', (e) => {
    searchKeyword = e.target.value;
    renderConnectionList();
  });

  // 抽屉遮罩点击关闭
  $('.conn-drawer-mask').addEventListener('click', closeConnDrawer);

  // SFTP 面板工具栏 (操作目标 = 当前展示会话)
  $('#sftpBack').addEventListener('click', () => {
    const s = currentSftpSession();
    if (s) goBack(s); else toast('请先连接会话', 'info');
  });
  $('#sftpRefreshBtn').addEventListener('click', () => {
    const s = currentSftpSession();
    if (s) refreshDir(s); else toast('请先连接会话', 'info');
  });
  $('#sftpUploadBtn').addEventListener('click', () => {
    const s = currentSftpSession();
    if (s) triggerUpload(s); else toast('请先连接会话', 'info');
  });
  $('#sftpMkdirBtn').addEventListener('click', () => {
    const s = currentSftpSession();
    if (s) mkdirPrompt(s); else toast('请先连接会话', 'info');
  });
  $('#sftpPathInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const s = currentSftpSession();
    if (!s) { toast('请先连接会话', 'info'); return; }
    const p = normalizeRemotePath(e.target.value);
    if (p === null) {
      toast('路径包含非法段 (..)', 'error');
      return;
    }
    e.target.value = p;
    // 路径输入框跳转: 仅切换面板目录, 不联动终端
    loadDir(s.sessionId, p);
  });

  // 文件列表事件委托 (面板全局唯一, 操作目标 = 当前展示会话)
  // 注: 操作列按钮已移除, 左键 click 委托不再有用途 (操作统一走右键菜单);
  //     仅保留 dblclick (双击进入目录/预览图片) 与 contextmenu (initContextMenu) 委托
  const tbody = $('#sftpTbody');
  tbody.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.sftp-row');
    const session = currentSftpSession();
    if (!row || !session || !session.fileEntryMap) return;
    const entry = session.fileEntryMap.get(row.dataset.name);
    if (!entry) return;
    if (entry.isDir) {
      enterDir(session, entry.name);
    } else if (isImageName(entry.name)) {
      // 图片文件双击触发预览
      openPreview(session.sessionId, joinRemotePath(session.currentPath, entry.name), entry.name);
    }
  });

  // 文件列表右键菜单 (init 时绑定一次, 复用现有操作函数; 与左键 click/双击/列宽拖拽互不影响)
  initContextMenu();

  // Roadmap 第三梯队 ①: SFTP 文件搜索/过滤 (即时过滤 + 递归搜索; init 时绑定一次)
  initSftpSearch();

  // Roadmap 第一梯队 ③ (S): 更新检查提示 (有新版本 -> 顶栏徽标; 失败静默)
  initUpdateCheck();

  // Roadmap ③: SFTP 拖拽上传 (面板区域拖放本地文件 -> 上传到当前目录)
  initSftpDragDrop();

  // 认证方式切换
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchAuthPanel(tab.dataset.auth));
  });

  // 密码显示切换
  $('#btnEye').addEventListener('click', () => {
    const p = $('#fPassword');
    p.type = p.type === 'password' ? 'text' : 'password';
  });

  // 选择私钥文件
  $('#btnPickKey').addEventListener('click', async () => {
    const res = await window.nimbus.selectKeyFile();
    if (res.ok) $('#fKeyPath').value = res.path;
  });

  // 全屏终端 (统一走 toggleFullscreen: rAF 等布局稳定 -> fitSafe, 无魔法延迟)
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);

  // 主题切换按钮 (Roadmap P2): 点击在 light -> dark -> auto 间循环
  // (themeController 在文件顶部已 init 应用持久化偏好; 此处仅绑定交互)
  if (themeController) {
    $('#btnTheme').addEventListener('click', () => themeController.switchTheme());
  } else {
    const btn = $('#btnTheme');
    if (btn) btn.style.display = 'none';
  }

  // 可调节布局: 恢复侧边栏宽度, 绑定宽度/列宽拖拽
  const savedSidebarW = parseFloat(localStorage.getItem('nimbus.sidebarWidth'));
  if (savedSidebarW >= 280 && savedSidebarW <= 560) {
    document.querySelector('.sidebar').style.width = savedSidebarW + 'px';
  }
  initSidebarResizer();
  initColResizers();

  // 窗口尺寸变化: 所有终端统一 fit
  window.addEventListener('resize', fitAllTerminals);

  // 图片预览模态事件
  initPreviewEvents();

  // 文档查看器事件: 保存 (文本类) + 高亮/编辑切换 + 关闭按钮
  $('#docSaveBtn').addEventListener('click', () => {
    const doc = activeDocId ? docTabs.get(activeDocId) : null;
    if (doc && doc.isText) saveDocText(doc);
  });
  $('#docEditToggle').addEventListener('click', () => {
    const doc = activeDocId ? docTabs.get(activeDocId) : null;
    if (doc) toggleDocEditorMode(doc);
  });
  $('#docCloseBtn').addEventListener('click', () => {
    if (activeDocId) closeDocTab(activeDocId);
  });

  // 操作日志面板
  $('#btnAudit').addEventListener('click', openAuditPanel);
  $('#auditCloseBtn').addEventListener('click', closeAuditPanel);
  $('#auditRefreshBtn').addEventListener('click', refreshAuditLog);
  $('#auditTypeFilter').addEventListener('change', refreshAuditLog);
  $('#auditResultFilter').addEventListener('change', refreshAuditLog);
  $('#auditLimitSelect').addEventListener('change', refreshAuditLog);
  $('#auditClearFilterBtn').addEventListener('click', () => {
    $('#auditTypeFilter').value = '';
    $('#auditResultFilter').value = '';
    $('#auditLimitSelect').value = '100';
    refreshAuditLog();
  });
  $('#auditOverlay').addEventListener('click', (e) => {
    if (e.target === $('#auditOverlay')) closeAuditPanel();
  });

  // 端口转发隧道面板
  $('#btnTunnel').addEventListener('click', openTunnelPanel);
  $('#tunnelCloseBtn').addEventListener('click', closeTunnelPanel);
  $('#tunnelRefreshBtn').addEventListener('click', refreshTunnelList);
  $('#tunnelAddBtn').addEventListener('click', addTunnel);
  $('#tunnelOverlay').addEventListener('click', (e) => {
    if (e.target === $('#tunnelOverlay')) closeTunnelPanel();
  });

  // 服务器健康监控面板
  $('#btnMonitor').addEventListener('click', openMonitorPanel);
  $('#monitorCloseBtn').addEventListener('click', closeMonitorPanel);
  $('#monitorRefreshBtn').addEventListener('click', () => refreshMonitor(false));
  $('#monitorAutoToggle').addEventListener('change', toggleMonitorAutoRefresh);
  $('#monitorOverlay').addEventListener('click', (e) => {
    if (e.target === $('#monitorOverlay')) closeMonitorPanel();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openModal();
    }
    // 文档查看器激活且可见时: Ctrl+S 保存文本类文档
    // 守卫: 切到终端标签后 activeDocId 可能残留, 仅查看器可见时拦截保存 (防误存隐藏文档)
    if (activeDocId && $('#docViewer').style.display !== 'none' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const doc = docTabs.get(activeDocId);
      if (doc && doc.isText) saveDocText(doc);
      return;
    }
    // 图片预览打开时: ← → 切换上一张/下一张 (仅预览模态显示时生效, 不影响终端/其他界面)
    if ($('#previewModal').style.display === 'flex' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      previewNav(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      // Esc 优先级: 主机密钥弹窗 (安全拦截, 最高) -> SFTP 右键菜单 -> 连接抽屉 -> 图片预览 -> 新建连接弹窗
      if ($('#hostKeyModal').style.display === 'flex') {
        resolveHostKeyDialog(false);
        return;
      }
      if (ctxMenuTarget) {
        hideContextMenu();
        return;
      }
      // 其次收起连接抽屉
      if ($('#connDrawer').classList.contains('open')) {
        closeConnDrawer();
        return;
      }
      // 再次关闭图片预览
      if ($('#previewModal').style.display === 'flex') {
        closePreview();
        return;
      }
      // 端口转发隧道面板
      if ($('#tunnelOverlay').style.display === 'flex') {
        closeTunnelPanel();
        return;
      }
      // 服务器健康监控面板
      if ($('#monitorOverlay').style.display === 'flex') {
        closeMonitorPanel();
        return;
      }
      // 配置导出/导入密码弹窗
      if ($('#configPwdModal').style.display === 'flex') {
        closeConfigPwdModal();
        return;
      }
      // 命令收藏浮层
      if ($('#favPanel').style.display === 'flex') {
        closeFavPanel();
        return;
      }
      // 操作日志面板
      if ($('#auditOverlay').style.display === 'flex') {
        closeAuditPanel();
        return;
      }
      if ($('#modalOverlay').style.display === 'flex') closeModal();
    }
  });

  // 点击遮罩关闭弹窗
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#modalOverlay')) closeModal();
  });

  // 点击外部区域收起抽屉 (目标不在抽屉或入口按钮内时)
  document.addEventListener('click', (e) => {
    const drawer = $('#connDrawer');
    if (!drawer.classList.contains('open')) return;
    if (e.target.closest('#connDrawer') || e.target.closest('#btnConnections')) return;
    closeConnDrawer();
  });

  // 回车提交
  $$('.modal input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleConnect();
    });
  });

  // 初始: SFTP 面板显示占位
  showSftpFor(null);

  toast('欢迎使用 FgmSSH', 'info');
}

window.addEventListener('DOMContentLoaded', init);