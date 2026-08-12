/**
 * NimbusSSH - 文本编辑增强模块 (editor-highlight)
 * ============================================================
 * 职责 (Roadmap 第一梯队 ③, 纯逻辑增量, 零第三方依赖):
 *   - 极简语法高亮: 基于扩展名/内容启发, 用轻量 tokenizer (正则逐行) 把文本渲染为
 *     带 span 的 HTML。安全: 所有内容先 escape 再套关键词 span (防 XSS)。
 *   - 性能保护: 超过阈值 (默认 500KB) 降级纯文本 (escapeHtml, 无 span)。
 *   - 大文件分段加载阈值逻辑: <2MB 全量 / >2MB 前 512KB 预览 / 加载全部,
 *     供 main.js doc:open 与 renderer 查看器共用同一套判定。
 *
 * 设计要点:
 *   - 不依赖 DOM / window / Electron; UMD 形态: node 下 module.exports,
 *     浏览器 (renderer) 下挂载 window.EditorHighlight, 便于 tests/ 下 node 直跑。
 *   - XSS 说明: 文本内容只出现在 HTML 文本节点 (span 的 class 均为固定常量, 无用户输入
 *     进入属性), 因此 escapeText 仅需转义 & < > 即可阻断标记注入; 降级路径使用完整
 *     escapeHtml (& < > " ') 双保险。
 *   - 高亮为"尽力而为"级别: 不保证覆盖全部语法, 只做注释/字符串/关键字/数字/键值等
 *     高频特征, 超出能力范围的文本保持原文。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EditorHighlight = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 全量高亮最大字节数 (超过则降级纯文本, 避免卡顿)
  const HIGHLIGHT_MAX_BYTES = 500 * 1024;

  // 大文件分段加载阈值 (超过则先加载前段预览)
  const DOC_SEGMENT_THRESHOLD = 2 * 1024 * 1024;
  // 分段预览字节数
  const DOC_PREVIEW_BYTES = 512 * 1024;

  // 转义 (文本节点安全集): & < > 足以阻断标记注入 (内容不进入属性)
  function escapeText(s) {
    return String(s).replace(/[&<>]/g, (c) => (
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
    ));
  }

  // 完整转义 (含引号; 降级/纯文本路径使用)
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- 语言特征表 (极简 tokenizer) ----------

  // 高亮规则: 数组顺序即匹配优先级 (同一位置先匹配者胜), 因此注释/字符串在前,
  // 关键字/数字在后 —— 保证 # 或引号内容不会被后续规则二次包裹/破坏嵌套。
  const LANG_RULES = {
    sh: [
      { re: /#[^\n]*/, cls: 'tok-comment' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-string' },
      { re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|return|exit|local|export|readonly|shift|source|eval|exec|trap|echo|cd|alias|bg|bind|builtin|caller|command|compgen|complete|coproc|declare|dirs|disown|enable|fc|fg|getopts|hash|help|history|jobs|kill|let|logout|mapfile|popd|printf|pushd|pwd|read|readarray|set|suspend|test|times|type|typeset|ulimit|umask|unalias|unset|wait)\b/, cls: 'tok-keyword' },
      { re: /\b(?:true|false|null)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
    bash: [
      { re: /#[^\n]*/, cls: 'tok-comment' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-string' },
      { re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|return|exit|local|export|readonly|shift|source|eval|exec|trap|echo|cd|alias|bg|bind|builtin|caller|command|compgen|complete|coproc|declare|dirs|disown|enable|fc|fg|getopts|hash|help|history|jobs|kill|let|logout|mapfile|popd|printf|pushd|pwd|read|readarray|set|suspend|test|times|type|typeset|ulimit|umask|unalias|unset|wait|[[|]]|&&|\|\|)\b/, cls: 'tok-keyword' },
      { re: /\b(?:true|false|null)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
    js: [
      { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, cls: 'tok-comment' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/, cls: 'tok-string' },
      { re: /\b(?:var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|class|extends|super|this|null|undefined|true|false|async|await|try|catch|finally|throw|yield|import|export|from|default|static|get|set|void|interface|type|enum|implements|private|protected|public|readonly|namespace|declare|abstract|as|satisfies)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
    ts: [
      { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, cls: 'tok-comment' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/, cls: 'tok-string' },
      { re: /\b(?:var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|class|extends|super|this|null|undefined|true|false|async|await|try|catch|finally|throw|yield|import|export|from|default|static|get|set|void|interface|type|enum|implements|private|protected|public|readonly|namespace|declare|abstract|as|satisfies|keyof|infer|unknown|never|any|string|number|boolean|object)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
    py: [
      { re: /#[^\n]*/, cls: 'tok-comment' },
      { re: /"""(?:[^"\\]|\\.)*"""|'''(?:[^'\\]|\\.)*'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-string' },
      { re: /\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|lambda|pass|break|continue|global|nonlocal|yield|assert|raise|del|not|and|or|is|in|None|True|False|async|await|self)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
    json: [
      { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/, cls: 'tok-key' },
      { re: /"(?:[^"\\]|\\.)*"/, cls: 'tok-string' },
      { re: /\b(?:true|false|null)\b/, cls: 'tok-keyword' },
      { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: 'tok-number' },
    ],
    yml: [
      { re: /#[^\n]*/, cls: 'tok-comment' },
      // 注意: 内部捕获组一律用非捕获组 (?:...) —— highlightLine 以 args[i+1]
      // 反推命中规则, 若规则内含捕获组会使后续规则的组号偏移, 导致 string/keyword/number
      // 永远匹配不到外层组而不高亮 (B1 修复: 每条规则外层组号可预测)
      { re: /^(?=\s*-?\s*)(?:\s*)(?:["']?[\w.-]+["']?)(?:\s*:)/, cls: 'tok-key' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-string' },
      { re: /\b(?:true|false|null|yes|no|on|off)\b/, cls: 'tok-keyword' },
      { re: /\b\d+(?:\.\d+)?\b/, cls: 'tok-number' },
    ],
  };

  // 扩展名 -> 语言
  const EXT_TO_LANG = {
    '.sh': 'sh', '.bash': 'bash', '.zsh': 'sh',
    '.js': 'js', '.mjs': 'js', '.cjs': 'js',
    '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts',
    '.py': 'py', '.json': 'json',
    '.yml': 'yml', '.yaml': 'yml',
    '.md': 'md',
  };

  // 内容启发: 对未知/纯文本扩展名, 用 shebang / 特征行判断语言
  function detectByContent(text) {
    if (typeof text !== 'string') return null;
    const firstLines = text.slice(0, 4000);
    if (/^#!.*\b(ba|k|z|)sh\b/m.test(firstLines)) return 'sh';
    if (/^#!.*python[\d.]*/m.test(firstLines)) return 'py';
    if (/^import\s+re\b|^\s*def\s+\w+\s*\(|^\s*class\s+\w+\s*:/m.test(firstLines)) return 'py';
    if (/^\s*(const|let|var)\s+\w+\s*=|^\s*function\s+\w+\s*\(/m.test(firstLines)) return 'js';
    return null;
  }

  /**
   * 判定语言: 扩展名优先, 内容启发兜底。
   * @param {string} ext      - 小写扩展名 (含 .), 如 '.sh'
   * @param {string} content
   * @returns {string|null}
   */
  function detectLanguage(ext, content) {
    if (typeof ext === 'string' && EXT_TO_LANG[ext.toLowerCase()]) {
      return EXT_TO_LANG[ext.toLowerCase()];
    }
    return detectByContent(content);
  }

  // 单行高亮: escape 后按语言规则组合正则, 一次 replace 输出带 span 的 HTML。
  // 规则先于关键字, 保证注释/字符串整体包裹 (不嵌套破坏)。
  function highlightLine(line, lang) {
    const escaped = escapeText(line);
    const rules = LANG_RULES[lang];
    if (!rules) return escaped;
    const combined = new RegExp(rules.map((r) => '(' + r.re.source + ')').join('|'), 'g');
    return escaped.replace(combined, (...args) => {
      const match = args[0];
      for (let i = 0; i < rules.length; i++) {
        if (args[i + 1] !== undefined) {
          return '<span class="' + rules[i].cls + '">' + match + '</span>';
        }
      }
      return match;
    });
  }

  // Markdown 行级高亮: 标题 / 行内代码 / 粗体 / 链接 / 列表标记
  function highlightMdLine(line, inFence) {
    const escaped = escapeText(line);
    if (inFence) {
      return '<span class="tok-codeblock">' + escaped + '</span>';
    }
    let html = escaped;
    // 围栏起始行 (``` / ~~~): 本身高亮
    if (/^(`{3,}|~{3,})/.test(escaped)) {
      return '<span class="tok-fence">' + escaped + '</span>';
    }
    // 标题: # 开头
    if (/^(#{1,6})\s+/.test(escaped)) {
      return escaped.replace(/^(#{1,6}\s+)(.*)$/, '<span class="tok-heading">$1</span><span class="tok-heading-text">$2</span>');
    }
    // 行内代码 `code`
    html = html.replace(/`([^`\n]+)`/g, '<span class="tok-inlinecode">`$1`</span>');
    // 粗体 **text**
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<span class="tok-bold">**$1**</span>');
    // 链接 [text](url)
    html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="tok-link">[$1]($2)</span>');
    return html;
  }

  /**
   * 文本 -> 高亮 HTML。
   * @param {string} text     - 原始文本
   * @param {string} ext      - 扩展名 (含 .), 可为 '' 
   * @param {object} [opts]   - { maxBytes: 高亮上限 (默认 500KB) }
   * @returns {{html: string, language: string|null, degraded: boolean}}
   *   degraded=true 表示超过阈值已降级纯文本 (无 span)。
   */
  function highlightText(text, ext, opts) {
    if (typeof text !== 'string' || text.length === 0) {
      return { html: '', language: null, degraded: false };
    }
    const maxBytes = (opts && opts.maxBytes) || HIGHLIGHT_MAX_BYTES;
    if (text.length > maxBytes) {
      return { html: escapeHtml(text), language: null, degraded: true };
    }
    const lang = detectLanguage(ext, text);
    if (!lang) {
      return { html: escapeHtml(text), language: null, degraded: false };
    }
    if (lang === 'md') {
      let inFence = false;
      const lines = text.split('\n');
      const out = lines.map((ln) => {
        if (/^(`{3,}|~{3,})/.test(ln)) {
          inFence = !inFence;
          return highlightMdLine(ln, false) + '\n';
        }
        return highlightMdLine(ln, inFence) + '\n';
      });
      // 去掉最后一个多余换行 (与普通路径一致: 不引入额外空行)
      if (out.length > 0 && out[out.length - 1].endsWith('\n')) {
        out[out.length - 1] = out[out.length - 1].slice(0, -1);
      }
      return { html: out.join(''), language: lang, degraded: false };
    }
    const html = text.split('\n').map((ln) => highlightLine(ln, lang)).join('\n');
    return { html, language: lang, degraded: false };
  }

  /**
   * 大文件分段加载判定: 是否超过阈值需分段预览。
   * @param {number} totalSize
   * @param {object} [opts] - { segmentThreshold }
   * @returns {boolean}
   */
  function isLargeDoc(totalSize, opts) {
    const threshold = (opts && opts.segmentThreshold) || DOC_SEGMENT_THRESHOLD;
    return typeof totalSize === 'number' && totalSize > threshold;
  }

  /**
   * 分段预览信息。
   * @param {number} totalSize
   * @param {object} [opts] - { previewBytes }
   * @returns {{truncated: boolean, previewBytes: number, totalSize: number}}
   */
  function segmentPreviewInfo(totalSize, opts) {
    const preview = (opts && opts.previewBytes) || DOC_PREVIEW_BYTES;
    const n = typeof totalSize === 'number' && totalSize >= 0 ? totalSize : 0;
    return {
      truncated: isLargeDoc(n, opts),
      previewBytes: Math.min(preview, n),
      totalSize: n,
    };
  }

  return {
    HIGHLIGHT_MAX_BYTES,
    DOC_SEGMENT_THRESHOLD,
    DOC_PREVIEW_BYTES,
    escapeText,
    escapeHtml,
    detectLanguage,
    highlightLine,
    highlightText,
    isLargeDoc,
    segmentPreviewInfo,
  };
}));
