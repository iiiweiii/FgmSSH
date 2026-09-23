/**
 * FgmSSH - 内置文档查看器 (从 src/renderer.js 按域拆出)
 * ============================================================
 * 职责: 打开文档 -> 下载到 DOC_DIR (nimbus-doc://) -> 文档标签 + 主区域查看器视图。
 *       PDF (pdfjs canvas) / DOCX (mammoth + 净化) / 文本 (编辑 + 语法高亮 + 大文件分段)。
 *
 * 拆分说明 (renderer.js 按域垂直切第一刀):
 *   - 本模块独占文档查看器状态 (docTabs / activeDocId) 与全部渲染逻辑, 通过
 *     createDocViewer(deps) 依赖注入与宿主交互, 不直接引用 renderer 内部变量;
 *   - 宿主 (renderer.js) 只保留调用点: openDocViewer / getDocExtension / closeDocTab /
 *     saveDocText / toggleDocEditorMode / getActiveDoc(Id) / getDocsBySession;
 *   - 不按「视图/逻辑」横切: 本域内大量事件绑定与 DOM 强耦合, 横切会产生循环依赖。
 *
 * 渲染策略 (实测结论 2026-08-11):
 * - 方案 A (iframe + 内置 PDF viewer): 不可行 — 内置 PDF viewer 扩展未启用。
 * - 方案 B (pdfjs-dist 4.10.38): 可行 — 动态 import + fetch worker 源码为 blob URL
 *   (CSP worker-src blob:) + getDocument({url: nimbus-doc://...}) + canvas 渲染。
 *   注意: 不能用 v6 (依赖 Promise.try, 新引擎才支持), 已锁定 ^4.10.38。
 * - docx: mammoth.browser.js (经典 script 加载) -> convertToHtml(arrayBuffer)。
 */

/**
 * @param {object} deps 宿主注入的依赖 (全部为 renderer.js 现有实现, 语义不变)
 * @param {(text: string, ...args: any[]) => string} deps.T 翻译入口
 * @param {(s: string) => string} deps.escapeHtml HTML 转义
 * @param {(msg: string, type?: string) => void} deps.toast 提示
 * @param {() => string} deps.genId 唯一 id 生成
 * @param {(parent: string, name: string) => string} deps.joinRemotePath 远端路径拼接
 * @param {(fn: Function) => void} deps.afterLayout 布局稳定后执行
 * @param {(bytes: number) => string} deps.formatSize 字节格式化
 * @param {(sel: string) => Element|null} deps.$ 单元素查询
 * @param {(sel: string) => NodeList} deps.$$ 多元素查询
 * @param {(sessionId: string|null) => void} deps.showSftpFor 侧边栏 SFTP 面板跟随会话
 * @param {(sessionId: string) => void} deps.activateSession 激活终端会话 (关闭最后一个文档时回退)
 * @param {() => string[]} deps.getTerminalSessionIds 当前终端会话 id 列表 (排除连接预留 id)
 * @param {() => object|null} deps.getEditorHighlight 语法高亮模块 (window.EditorHighlight)
 */
export function createDocViewer(deps) {
  const {
    T, escapeHtml, toast, genId, joinRemotePath, afterLayout, formatSize,
    $, $$, showSftpFor, activateSession, getTerminalSessionIds, getEditorHighlight,
  } = deps;

  // 文档扩展名白名单 (与后端 DOC_EXTENSIONS 保持一致; 图片走 preview, 不在此列)
  const DOC_EXTENSIONS = [
    '.txt', '.log', '.md', '.json', '.yml', '.yaml', '.sh', '.py', '.js', '.ts',
    '.html', '.css', '.xml', '.conf', '.ini', '.csv',
    '.pdf', '.docx', '.doc',
  ];

  // 文档查看器状态: docTabs = docId -> doc 运行时对象; activeDocId 当前显示的文档
  const docTabs = new Map();
  let activeDocId = null;

  // ---------- 对外查询 API ----------
  const getActiveDocId = () => activeDocId;
  const getActiveDoc = () => (activeDocId ? docTabs.get(activeDocId) : null);
  const getDocsBySession = (sessionId) => [...docTabs.entries()]
    .filter(([, doc]) => doc.sessionId === sessionId)
    .map(([docId]) => docId);

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
      toast(T('不支持打开该文件类型'), 'error');
      return;
    }
    // 后端内部下载到 DOC_DIR (白名单校验 + 防目录穿越; 大文件分段预览由后端处理)
    let res;
    try {
      res = await window.nimbus.docOpen(session.sessionId, remotePath);
    } catch (err) {
      toast(T('打开文档异常: ') + (err.message || T('未知错误')), 'error');
      return;
    }
    if (!res || !res.ok) {
      toast((res && res.error) || T('打开文档失败'), 'error');
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
      // 大文件分段加载 (后端返回; 旧版/测试桩无这些字段时按全量处理)
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
      <button class="tab-close" title="${T('关闭')}">
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
    // 操作日志 (渲染侧补充: 文档关闭后端未记录, 属 UI 生命周期事件)
    try { await window.nimbus.auditLog({ type: 'doc.close', target: doc.remotePath, result: 'success', session: doc.sessionId, detail: T('关闭文档 {0}', doc.name) }); } catch (e) {}
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
      const remainingSessions = getTerminalSessionIds();
      if (remainingSessions.length > 0) {
        activateSession(remainingSessions[remainingSessions.length - 1]);
      } else {
        $('#terminalArea').style.display = 'none';
        $('#emptyState').style.display = 'flex';
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
      el.innerHTML = `<div class="doc-error">${T('旧版 .doc 暂不支持，请转存为 .docx 后打开')}</div>`;
    } else {
      el.innerHTML = `<div class="doc-error">${T('不支持打开该文件类型')}</div>`;
    }
  }

  // ---------- 文本编辑增强 ----------
  // 文本类文档渲染:
  //   - 默认编辑模式 (textarea, 保存语义不变);
  //   - 「编辑/高亮」切换: 高亮预览为只读 (语法高亮, 基于扩展名/内容启发, 零依赖);
  //   - 大文件分段: 超过阈值 (2MB) 时后端只返回前 512KB 预览 (只读, 编辑禁用),
  //     底部显示「加载全部」按钮; 点击后后端追加剩余字节 -> 重新 fetch 完整内容 ->
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
      bar.innerHTML = `<span>${T('文件过大，已加载前 {0} / 共 {1}，是否加载全部？', formatSize(preview), formatSize(total))}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = T('加载全部');
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
      const editorHighlightApi = getEditorHighlight();
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
      toggle.textContent = doc._editorMode === 'view' ? T('编辑') : T('高亮');
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
      toast(T('文件较大，请先点击「加载全部」后再编辑'), 'info');
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

  // 加载全部 (大文件分段预览): 后端追加剩余字节 -> 重新 fetch 完整内容 -> 恢复可编辑
  async function loadFullDoc(doc) {
    if (!doc || !doc.truncated) return;
    let res;
    try {
      res = await window.nimbus.docLoadFull(doc.sessionId, doc.filename);
    } catch (err) {
      toast(T('加载全部失败: ') + (err.message || T('未知错误')), 'error');
      return;
    }
    if (!res || !res.ok) {
      toast((res && res.error) || T('加载全部失败'), 'error');
      return;
    }
    try {
      const fr = await fetch(doc.url);
      if (!fr.ok) throw new Error('HTTP ' + fr.status);
      doc._text = await fr.text();
    } catch (err) {
      toast(T('加载全部失败: ') + (err.message || T('未知错误')), 'error');
      return;
    }
    // 完成: 标记完整加载, 移除 truncate bar, 切换编辑模式
    doc.truncated = false;
    doc._editorMode = 'edit';
    renderDocTextView(doc);
    toast(T('已加载全部内容，可编辑保存'), 'success');
  }

  // 文本类文档渲染入口: 大文件 -> 分段预览; 小文件 -> fetch 全量后默认编辑模式
  function renderDocText(doc) {
    const el = doc.bodyEl;
    el.innerHTML = '';
    doc._text = '';
    doc._editorMode = 'edit';
    buildDocTextEditor(doc);

    if (doc.truncated) {
      // 分段预览: 直接使用后端返回的前段内容 (只读, 高亮展示)
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
      el.innerHTML = `<div class="doc-error">${T('加载失败: {0}', escapeHtml(err.message))}</div>`;
    });
  }

  // 保存文本类文档: 经 docSave 写流覆盖远端文件 (UTF-8)
  // 仅编辑模式且完整加载时可保存 (分段预览只读, 保存逻辑基于完整内容)
  async function saveDocText(doc) {
    const wrap = doc && (doc._wrap || doc.bodyEl);
    const ta = wrap ? wrap.querySelector('#docTextArea') : null;
    if (!ta || !doc || doc.isText !== true) return;
    if (doc.truncated) {
      toast(T('文件较大，请先点击「加载全部」后再保存'), 'info');
      return;
    }
    const res = await window.nimbus.docSave(doc.sessionId, doc.remotePath, ta.value);
    if (res && res.ok) {
      doc._text = ta.value;
      toast(T('已保存 {0}', doc.name), 'success');
    } else {
      toast((res && res.error) || T('保存失败'), 'error');
    }
  }

  // ---------- PDF ----------
  // PDF: pdfjs-dist 动态 import + blob worker + canvas 渲染 (上一页/下一页/页码/缩放/适应宽度)
  async function renderDocPdf(doc) {
    const el = doc.bodyEl;
    el.innerHTML = `
      <div class="pdf-toolbar">
        <button class="icon-btn" id="pdfPrev" title="${T('上一页')}">◀</button>
        <span class="pdf-page-label" id="pdfPageLabel">1 / 1</span>
        <button class="icon-btn" id="pdfNext" title="${T('下一页')}">▶</button>
        <span class="pdf-toolbar-sep"></span>
        <button class="icon-btn" id="pdfZoomOut" title="${T('缩小')}">−</button>
        <span class="pdf-zoom-label" id="pdfZoomLabel">100%</span>
        <button class="icon-btn" id="pdfZoomIn" title="${T('放大')}">+</button>
        <button class="icon-btn" id="pdfFit" title="${T('适应宽度')}">⛶</button>
      </div>
      <div class="pdf-stage" id="pdfStage">
        <div class="pdf-empty">${T('正在加载 PDF...')}</div>
      </div>`;
    const stage = el.querySelector('#pdfStage');

    try {
      // 动态 import pdfjs: Tauri/vite 适配 —— 用包标识符代替相对 node_modules 路径
      // (vite 打包下相对路径不可达, 改经包解析, dev/build 均可解析)。
      const pdfjs = await import('pdfjs-dist/build/pdf.min.mjs');
      // blob worker: fetch worker 源码 -> Blob URL (CSP 需 worker-src blob:; 实测通过)
      // worker 源文件 URL 由 nimbus-bridge 经 vite `?url` 资产导入暴露为
      // window.__PDFJS_WORKER_URL__ (dev/build 均为可 fetch 的同源地址), 取来转 Blob URL。
      let workerOk = false;
      try {
        const workerUrl = window.__PDFJS_WORKER_URL__;
        const wr = await fetch(workerUrl);
        const code = await wr.text();
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        workerOk = true;
      } catch (err) {
        console.warn('[doc-pdf] worker 加载失败, 尝试无 worker 直连:', err);
        // 兜底: 直接指向资产 URL, 由 pdfjs 自行尝试加载 (部分环境可工作)
        pdfjs.GlobalWorkerOptions.workerSrc = window.__PDFJS_WORKER_URL__;
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
      stage.innerHTML = `<div class="doc-error">${T('PDF 加载失败: {0}', escapeHtml(err.message))}</div>`;
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

  // ---------- DOCX ----------
  // 轻量 HTML 净化 (mammoth DOCX 输出用): 防止文档内嵌恶意内容在查看器内执行。
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
    // 3) 剥离所有事件处理属性 on\w+= (单/双引号或裸值)
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

  // DOCX: mammoth (全局挂载) -> convertToHtml(arrayBuffer) -> 净化后注入只读 HTML
  async function renderDocDocx(doc) {
    const el = doc.bodyEl;
    el.innerHTML = `<div class="docx-loading"><div class="overlay-spinner"></div><span>${T('正在解析 DOCX...')}</span></div>`;
    try {
      const res = await fetch(doc.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      el.innerHTML = `<div class="docx-content">${sanitizeHtml(result.value || '')}</div>`;
    } catch (err) {
      el.innerHTML = `<div class="doc-error">${T('DOCX 解析失败: {0}', escapeHtml(err.message))}</div>`;
    }
  }

  return {
    openDocViewer,
    getDocExtension,
    closeDocTab,
    saveDocText,
    toggleDocEditorMode,
    getActiveDocId,
    getActiveDoc,
    getDocsBySession,
  };
}
