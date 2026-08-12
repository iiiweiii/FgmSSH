/**
 * NimbusSSH - 主题控制模块 (theme)
 * ============================================================
 * 职责 (Roadmap P2, 纯前端增量):
 *   - 三态主题: 'light' (强制浅色) / 'dark' (强制深色) / 'auto' (跟随系统 prefers-color-scheme)。
 *   - 持久化: localStorage key `nimbus.theme`; 首次启动读取并应用, 损坏值回退 'auto'。
 *   - DOM 应用: 设置 document.documentElement.dataset.theme = 'light'|'dark',
 *     与 src/style.css 的 `:root[data-theme="light"]` / `:root[data-theme="dark"]` 变量集联动。
 *   - xterm 同步: 切换时遍历注入的 getTerminals() 实例调 term.setOption('theme', ...),
 *     深色沿用 renderer createTerminal 现有深色主题, 浅色为白底深字自定义主题。
 *   - 健康监控 GPU 折线图配色 (SVG 为字符串, 不随 CSS 变量变化): CHART_COLORS 供渲染层注入。
 *
 * 设计要点:
 *   - 不依赖 DOM / window / Electron 全局 (除调用方显式注入); UMD 形态: node 下
 *     module.exports, 浏览器 (renderer) 下挂载 window.NimbusTheme, 便于 tests/ 下 node 直跑。
 *   - createThemeController(opts) 工厂: opts 全部可选注入 { storage, doc, matchMedia,
 *     getTerminals, button, onThemeChange }, 测试可 mock 全部依赖。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NimbusTheme = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'nimbus.theme';
  const DEFAULT_THEME = 'auto';
  const THEMES = ['light', 'dark', 'auto'];

  // 按钮/提示文案
  const THEME_LABELS = {
    light: '浅色',
    dark: '深色',
    auto: '自动',
  };
  // 按钮图标 (preference 维度): light=☀ / dark=☾ / auto=◐
  const THEME_ICONS = {
    light: '☀',
    dark: '☾',
    auto: '◐',
  };

  // xterm 主题: dark 与 renderer.js createTerminal() 现有深色主题完全一致 (回归不破坏);
  // light 为白底深字 + VSCode Light 风格 ANSI 16 色。
  const XTERM_THEMES = {
    dark: {
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
    },
    light: {
      background: '#ffffff',
      foreground: '#24292f',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(9, 105, 218, 0.25)',
      black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
      blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#24292f',
      brightBlack: '#57606a', brightRed: '#d1242f', brightGreen: '#2da44e',
      brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9',
      brightCyan: '#3192aa', brightWhite: '#6e7781',
    },
  };

  // GPU 折线图配色 (SVG 字符串, CSS 变量无法进入): dark 与 gpu-chart.js 现有常量一致,
  // light 为浅色网格/文字 + 高对比曲线。
  const CHART_COLORS = {
    dark: { util: '#4f8cff', mem: '#3ecf8e', grid: '#1f2733', text: '#5c6673', axis: '#2d3542' },
    light: { util: '#2f6fed', mem: '#1f9d63', grid: '#d0d5dd', text: '#8a94a3', axis: '#c4cad4' },
  };

  // 归一化偏好: 仅接受 light/dark/auto; null/undefined/损坏值一律回退默认 auto
  function normalize(pref) {
    if (pref === 'light' || pref === 'dark' || pref === 'auto') return pref;
    return DEFAULT_THEME;
  }

  // 解析实际生效主题: auto -> 跟随 systemTheme (无系统信息时按深色处理, 与旧版默认一致)
  function resolveTheme(pref, systemTheme) {
    const p = normalize(pref);
    if (p === 'auto') {
      return systemTheme === 'light' ? 'light' : 'dark';
    }
    return p;
  }

  /**
   * 创建主题控制器 (纯逻辑 + 注入依赖)。
   * @param {object} [opts]
   * @param {object} [opts.storage] - localStorage 形状 { getItem, setItem } (可 mock)
   * @param {object} [opts.doc] - document 形状, 需含 documentElement (可 mock)
   * @param {Function} [opts.matchMedia] - (query) => { matches, addEventListener, addListener } (可 mock)
   * @param {Function} [opts.getTerminals] - () => xterm 实例数组, 每个含 setOption('theme', theme)
   * @param {HTMLElement} [opts.button] - 顶栏主题按钮 (含 .theme-state-icon / .theme-state-label)
   * @param {Function} [opts.onThemeChange] - (resolvedTheme, preference) => void, 切换后回调
   * @returns {object} 控制器 { init, apply, currentTheme, getPreference, setPreference, switchTheme, ... }
   */
  function createThemeController(opts) {
    const o = opts || {};
    const storage = o.storage || null;
    const doc = o.doc || (typeof document !== 'undefined' ? document : null);
    const matchMediaFn = o.matchMedia ||
      (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (q) => window.matchMedia(q)
        : null);
    const getTerminals = (typeof o.getTerminals === 'function') ? o.getTerminals : (() => []);
    const onThemeChange = (typeof o.onThemeChange === 'function') ? o.onThemeChange : null;
    const button = o.button || null;

    let pref = DEFAULT_THEME;       // 用户偏好 (持久化值)
    let mql = null;                 // prefers-color-scheme MediaQueryList (auto 监听用)

    // 读取当前系统主题 (深色/浅色); 无法获取时返回 null (auto 模式按深色兜底)
    function getSystemTheme() {
      if (!matchMediaFn) return null;
      try {
        const q = matchMediaFn('(prefers-color-scheme: dark)');
        return q && q.matches ? 'dark' : 'light';
      } catch (e) {
        return null;
      }
    }

    // 当前实际生效主题 ('light' | 'dark')
    function currentTheme() {
      return resolveTheme(pref, getSystemTheme());
    }

    // 同步所有活动 xterm 实例的主题
    function syncTerminals(theme) {
      const themeObj = XTERM_THEMES[theme] || XTERM_THEMES.dark;
      const terms = getTerminals();
      if (!Array.isArray(terms)) return;
      terms.forEach((term) => {
        if (term && typeof term.setOption === 'function') {
          try { term.setOption('theme', themeObj); } catch (e) { /* 单实例失败不影响其余 */ }
        }
      });
    }

    // 更新顶栏按钮状态 (标题/当前模式图标/状态 data 属性)
    function updateButton() {
      if (!button) return;
      const resolved = currentTheme();
      const prefLabel = THEME_LABELS[pref] || THEME_LABELS.auto;
      const resolvedLabel = THEME_LABELS[resolved] || THEME_LABELS.dark;
      button.dataset.theme = pref;
      button.title = '主题模式: ' + prefLabel + '（当前 ' + resolvedLabel + '），点击切换';
      const iconEl = button.querySelector ? button.querySelector('.theme-state-icon') : null;
      const labelEl = button.querySelector ? button.querySelector('.theme-state-label') : null;
      if (iconEl) iconEl.textContent = THEME_ICONS[pref] || THEME_ICONS.auto;
      if (labelEl) labelEl.textContent = '主题';
    }

    // 应用主题: 设置 data-theme + 同步 xterm + 回调; 返回实际生效主题
    function apply(prefValue) {
      pref = normalize(prefValue);
      const theme = currentTheme();
      if (doc && doc.documentElement) {
        doc.documentElement.setAttribute('data-theme', theme);
      }
      syncTerminals(theme);
      updateButton();
      if (onThemeChange) {
        try { onThemeChange(theme, pref); } catch (e) { /* 回调异常不影响主题应用 */ }
      }
      return theme;
    }

    // 读取持久化偏好 (损坏/缺失 -> auto)
    function getPreference() {
      return pref;
    }

    // 设置偏好: 持久化 + 应用; 返回实际生效主题
    function setPreference(prefValue) {
      const p = normalize(prefValue);
      pref = p;
      if (storage) {
        try { storage.setItem(STORAGE_KEY, p); } catch (e) { /* localStorage 不可用时仅内存生效 */ }
      }
      return apply(p);
    }

    // 循环切换: light -> dark -> auto -> light; 返回实际生效主题
    function switchTheme() {
      const idx = THEMES.indexOf(pref);
      const next = THEMES[(idx + 1) % THEMES.length];
      return setPreference(next);
    }

    // 初始化: 读取 storage 偏好 + 注册系统主题监听 (auto 模式跟随 OS 变化); 返回实际生效主题
    function init() {
      let stored = null;
      if (storage) {
        try { stored = storage.getItem(STORAGE_KEY); } catch (e) { stored = null; }
      }
      pref = normalize(stored);

      if (matchMediaFn) {
        try {
          mql = matchMediaFn('(prefers-color-scheme: dark)');
          const onChange = () => {
            // 仅 auto 模式下系统主题变化需要重新应用 (强制模式不受影响)
            if (pref === 'auto') apply(pref);
          };
          if (mql) {
            if (typeof mql.addEventListener === 'function') {
              mql.addEventListener('change', onChange);
            } else if (typeof mql.addListener === 'function') {
              mql.addListener(onChange); // 旧式 Safari/Electron 兼容
            }
          }
        } catch (e) {
          mql = null;
        }
      }

      return apply(pref);
    }

    return {
      STORAGE_KEY,
      DEFAULT_THEME,
      THEMES,
      THEME_LABELS,
      THEME_ICONS,
      XTERM_THEMES,
      CHART_COLORS,
      normalize,
      resolveTheme,
      getSystemTheme,
      init,
      apply,
      currentTheme,
      getPreference,
      setPreference,
      switchTheme,
    };
  }

  // 便捷入口: 创建控制器并立即 init (renderer 顶部调用, 尽早应用减少主题闪烁)
  function initTheme(opts) {
    const ctrl = createThemeController(opts);
    ctrl.init();
    return ctrl;
  }

  return {
    STORAGE_KEY,
    DEFAULT_THEME,
    THEMES,
    THEME_LABELS,
    THEME_ICONS,
    XTERM_THEMES,
    CHART_COLORS,
    normalize,
    resolveTheme,
    createThemeController,
    initTheme,
  };
}));
