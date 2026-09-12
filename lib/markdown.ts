/**
 * lib/markdown.ts —— Markdown 渲染器（专为本项目定制）
 *
 * 【签名元素：时间轴导轨】
 * 章节标题（###）被渲染成一条贯穿全篇的竖线上的「刻度节点」：
 *
 *     ●─── 3:15  一对一、聚合来源与工程化信任
 *     │            · 要点
 *     │            · 要点
 *     ○─── 4:22  系统两大核心原则
 *
 * 这条导轨是 BiliLens 独有的结构——它的依据是：
 * 这个产品的全部价值就是把线性的视频时间压成可扫读的文字，
 * 因此「时间」理应是界面上唯一被强化的东西。
 *
 * 安全策略：**先对原文做 HTML 转义，再插入自有标签**。
 * 模型输出属于不可信内容（一段被投毒的字幕可能诱导模型输出
 * <img onerror=...>），因此在扩展页面里 innerHTML 必须有这层防护。
 */

import katex from 'katex';

import { fmtTime, parseTimestamp } from './time';

/** HTML 转义（含引号）。所有文本进 HTML 前必须过这一层 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把被转义的实体还原回字符（用于从已转义文本里取出的 TeX） */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 渲染一段 TeX。KaTeX 输出的 HTML 由它自己转义，可安全进入 innerHTML；
 * trust 保持默认关闭，禁掉 \href 之类会产生可点链接的命令。
 */
function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
      maxSize: 100,
      maxExpand: 200,
    });
  } catch {
    return escapeHtml(tex);
  }
}

/**
 * 从文本中摘出公式，换成占位符（占位符对转义与其余规则透明）。
 *
 * $$…$$ 与 \[…\] 为独立公式，\(…\) 与 $…$ 为行内公式。
 * 行内 $ 需要防误伤（价格「$5，省了 $3」）：
 * 内容两端不得贴空白、不含 CJK、不是纯数字，
 * 且要么带 TeX 特征符（\ ^ _ { } = 等），要么是短字母数字记号（如 $AB$）。
 */
function extractMath(input: string, stash: (tex: string, display: boolean) => string): string {
  let out = input;

  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(tex.trim(), true));
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => stash(tex.trim(), true));
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => stash(tex.trim(), false));

  out = out.replace(/\$(\S(?:[^$\n]*?\S)?)\$/g, (m, tex: string) => {
    const t = tex.trim();
    if (/^\d+([.,]\d+)?$/.test(t)) return m; // $100$ —— 价格，不是公式
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(t)) return m; // 中文不是 TeX
    // 特征符必须包含 ()'——r(A)、|A|、A' 这类裸记号是数学内容里最高频的写法
    const hasSignal = /[\\^_{}=+*/<>|~()'-]/.test(t);
    const isShortToken = /^[\w.]{1,8}$/.test(t);
    if (!hasSignal && !isShortToken) return m;
    return stash(tex, false);
  });

  return out;
}

export interface InlineOptions {
  /**
   * 时间戳是否渲染为导轨节点样式。
   * 章节标题里用 true（醒目、可点击跳转），
   * 正文列表里用 false（低调，避免粉色泛滥）。
   */
  rail?: boolean;
}

/** 行内元素：代码、公式、链接、粗体、斜体、时间戳 */
export function renderInline(text: string, opts: InlineOptions = {}): string {
  // 行内代码最先摘出：其中的 $、*、[mm:ss] 都不该被后续规则误伤
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 公式在转义**之前**摘出，拿到的是原始 TeX；KaTeX 自己负责转义
  const maths: Array<{ tex: string; display: boolean }> = [];
  out = extractMath(out, (tex, display) => {
    maths.push({ tex, display });
    return `\u0000M${maths.length - 1}\u0000`;
  });

  out = escapeHtml(out);

  // 链接：协议白名单写在正则里，javascript: 之类进不来；
  // URL 此刻已被转义（引号是 &quot;），属性注入被阻断
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );

  // 粗体
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 斜体（避开已生成的标签属性）
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 时间戳
  out = out.replace(/\[((?:\d+:)?\d{1,2}:\d{2})\]/g, (_m, ts: string) => {
    const sec = parseTimestamp(ts);
    if (sec === null) return `[${ts}]`;

    if (opts.rail) {
      // 导轨节点 + 等宽时间刻度
      return (
        `<button type="button" class="rail__node" data-seek="${sec}" ` +
        `aria-label="跳转到 ${ts}"></button>` +
        `<button type="button" class="rail__time tnum" data-seek="${sec}">${ts}</button>`
      );
    }

    // 正文内的时间戳：低调的等宽小标
    return `<button type="button" class="ts tnum" data-seek="${sec}" title="跳转到 ${ts}">${ts}</button>`;
  });

  // 还原行内代码（摘出时是原文，这里补转义）
  out = out.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => {
    return `<code>${escapeHtml(codes[Number(i)] ?? '')}</code>`;
  });

  // 还原公式（KaTeX 输出可安全进 innerHTML）
  out = out.replace(/\u0000M(\d+)\u0000/g, (_m, i: string) => {
    const m = maths[Number(i)];
    if (!m) return '';
    return renderMath(unescapeEntities(m.tex), m.display);
  });

  return out;
}

/**
 * 渲染 Markdown 子集为 HTML。
 * 支持：# ~ #### 标题、无序/有序列表、引用、水平线、围栏代码块、表格、段落、行内元素。
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];

  /* --- 列表状态：用「缩进栈」实现真正的嵌套 ---
     每个栈层代表一个已打开的 <ul>/<ol>。
     liOpen 记录该层最后一个 <li> 是否仍开着——它可能正承载一个更深的
     子列表，此时绝不能提前闭合，否则浏览器会把子列表挤成同级兄弟节点。 */
  interface ListLevel {
    indent: number;
    type: 'ul' | 'ol';
    liOpen: boolean;
  }
  const listStack: ListLevel[] = [];

  /* 列表整体先攒进独立缓冲，收尾时作为一个整体入栈。
     这样 `<li>A<ul>…</ul></li>` 会连成一行——
     既便于阅读产物，也让「嵌套是否正确」在字符串层面即可断言。 */
  let listBuf = '';
  const listPush = (s: string): void => {
    listBuf += s;
  };
  const flushList = (): void => {
    if (listBuf) {
      html.push(listBuf);
      listBuf = '';
    }
  };

  let inQuote = false;
  let para: string[] = [];

  /** 关闭最内层列表（先收它自己的 li，再收标签） */
  const closeLevel = (): void => {
    const lv = listStack.pop();
    if (!lv) return;
    if (lv.liOpen) listPush('</li>');
    listPush(`</${lv.type}>`);
    if (listStack.length === 0) flushList();
  };

  const closeAllLists = (): void => {
    while (listStack.length > 0) closeLevel();
    flushList();
  };

  /** 缩进折算成宽度：制表符按 4 空格计 */
  const indentWidth = (raw: string): number => {
    let w = 0;
    for (const ch of raw) w += ch === '\t' ? 4 : 1;
    return w;
  };

  /** 处理一个列表项，按缩进开/关层级 */
  const pushItem = (indent: number, type: 'ul' | 'ol', content: string): void => {
    // 1) 回退：关闭所有比当前项更深的层级
    while (listStack.length > 0) {
      const top = listStack[listStack.length - 1] as ListLevel;
      if (indent >= top.indent) break;
      closeLevel();
    }

    const top = listStack[listStack.length - 1];

    if (!top) {
      // 新的最外层列表
      listPush(`<${type}>`);
      listStack.push({ indent, type, liOpen: false });
    } else if (indent > top.indent) {
      // 更深一层：开子列表，嵌在当前尚未闭合的 <li> 内部
      listPush(`<${type}>`);
      listStack.push({ indent, type, liOpen: false });
    } else if (type !== top.type) {
      // 同缩进但换了列表类型：关掉重开
      closeLevel();
      listPush(`<${type}>`);
      listStack.push({ indent, type, liOpen: false });
    } else if (top.liOpen) {
      // 同层同级：先收上一个条目
      listPush('</li>');
      top.liOpen = false;
    }

    const cur = listStack[listStack.length - 1] as ListLevel;
    listPush(`<li>${renderInline(content)}`);
    cur.liOpen = true;
  };

  const closeQuote = (): void => {
    if (inQuote) {
      html.push('</blockquote>');
      inQuote = false;
    }
  };

  const flushPara = (): void => {
    if (para.length) {
      html.push(`<p>${renderInline(para.join(' '))}</p>`);
      para = [];
    }
  };

  const closeAll = (): void => {
    flushPara();
    closeAllLists();
    closeQuote();
  };

  /* --- 表格 --- */

  /** 分隔行：| --- | :---: | ---: */
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  /** 拆一行表格行：去掉首尾管道后按 | 切分；\| 是转义的竖线（写 |A| 这类记号用），不参与分列 */
  const splitRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s
      .replace(/\\\|/g, '\u0000')
      .split('|')
      .map((c) => c.trim().replace(/\u0000/g, '|'));
  };

  /** 分隔行的单元格 → 对齐方向（left 是默认，不写 style） */
  const alignOf = (mark: string): 'left' | 'center' | 'right' => {
    const l = mark.startsWith(':');
    const r = mark.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    return 'left';
  };

  const alignStyle = (a: string): string => (a === 'left' ? '' : ` style="text-align:${a}"`);

  const renderTable = (header: string[], aligns: string[], rows: string[][]): string => {
    const th = header
      .map((c, k) => `<th${alignStyle(aligns[k] ?? 'left')}>${renderInline(c)}</th>`)
      .join('');
    const body = rows
      .map(
        (r) =>
          `<tr>${header
            .map((_c, k) => `<td${alignStyle(aligns[k] ?? 'left')}>${renderInline(r[k] ?? '')}</td>`)
            .join('')}</tr>`,
      )
      .join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
  };

  /* --- 围栏代码块状态 --- */
  let fence: string[] | null = null;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li] as string;
    const line = raw.trimEnd();

    // 代码块内部：除结束围栏外全部原样收集（保留缩进，不做任何行内处理）
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        html.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.push(raw);
      }
      continue;
    }

    if (!line.trim()) {
      closeAll();
      continue;
    }

    // 围栏开始（```lang 的语言标记忽略——不做语法高亮）
    if (/^\s*```/.test(line)) {
      closeAll();
      fence = [];
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    const nextLine = lines[li + 1] ?? '';
    if (line.includes('|') && TABLE_SEP.test(nextLine)) {
      closeAll();
      const aligns = splitRow(nextLine).map(alignOf);
      const header = splitRow(line);
      const rows: string[][] = [];
      li += 2;
      while (li < lines.length) {
        const rowLine = lines[li] as string;
        if (!rowLine.trim() || !rowLine.includes('|')) break;
        rows.push(splitRow(rowLine));
        li += 1;
      }
      li -= 1; // 抵消 for 的自增
      html.push(renderTable(header, aligns, rows));
      continue;
    }

    // 标题：### 走导轨（这是签名元素），其余标题常规处理
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAll();
      const level = Math.min(6, (h[1] as string).length);
      const body = h[2] as string;

      if (level === 3) {
        html.push(`<h3 class="rail">${renderInline(body, { rail: true })}</h3>`);
      } else {
        html.push(`<h${level}>${renderInline(body)}</h${level}>`);
      }
      continue;
    }

    // 水平线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeAll();
      html.push('<hr>');
      continue;
    }

    // 引用
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      closeAllLists();
      if (!inQuote) {
        html.push('<blockquote>');
        inQuote = true;
      }
      html.push(`<p>${renderInline(q[1] as string)}</p>`);
      continue;
    }
    closeQuote();

    // 无序列表
    const ul = line.match(/^([ \t]*)[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      pushItem(indentWidth(ul[1] as string), 'ul', ul[2] as string);
      continue;
    }

    // 有序列表
    const ol = line.match(/^([ \t]*)\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      pushItem(indentWidth(ol[1] as string), 'ol', ol[2] as string);
      continue;
    }

    // 段落
    closeAllLists();
    para.push(line.trim());
  }

  // 流被截断时围栏可能没有闭合：有内容就照常渲染，别整块丢掉
  if (fence !== null && fence.length > 0) {
    html.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  }
  fence = null;

  closeAll();
  return html.join('\n');
}

/** 清理流式过程中出现的「半截」标记：未闭合的 ** 与反引号 */
export function tidyStreamingMarkdown(md: string): string {
  let out = md;
  if ((out.match(/\*\*/g) ?? []).length % 2 !== 0) {
    out = out.replace(/\*\*([^*]*)$/, '$1');
  }
  if ((out.match(/`/g) ?? []).length % 2 !== 0) {
    out = out.replace(/`([^`]*)$/, '$1');
  }
  return out;
}

/* ================================================================== *
 * 章节抽取（供 UI 导航与时间轴高亮使用）
 * ================================================================== */

export interface RenderedSection {
  /** 章节标题（已剥离时间戳） */
  title: string;
  /** 时间戳（秒），无则 null */
  seconds: number | null;
  /** 时间戳文本（如 "3:15"），无则空串 */
  timeText: string;
  /** DOM id，用于滚动定位 */
  id: string;
}

/** 从 Markdown 中抽取 ### 级标题 */
export function extractSections(md: string): RenderedSection[] {
  const out: RenderedSection[] = [];

  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^###\s+(.*)$/);
    if (!m) continue;

    let title = (m[1] as string).trim();
    let seconds: number | null = null;
    let timeText = '';

    const ts = title.match(/\[((?:\d+:)?\d{1,2}:\d{2})\]\s*/);
    if (ts) {
      seconds = parseTimestamp(ts[1] as string);
      timeText = ts[1] as string;
      title = title.replace(ts[0], '').trim();
    }

    out.push({
      title: title || '未命名章节',
      seconds,
      timeText,
      id: `sec-${out.length}`,
    });
  }

  return out;
}

/**
 * 给渲染后的 h3 注入 id。
 * 导轨结构里 h3 已经是 `<h3 class="rail">`，
 * 这里把它变成 `<h3 class="rail" id="sec-N">`。
 */
export function injectSectionAnchors(html: string, sections: RenderedSection[]): string {
  let i = 0;
  return html.replace(/<h3 class="rail">/g, () => {
    const s = sections[i];
    i += 1;
    return s ? `<h3 class="rail" id="${s.id}">` : '<h3 class="rail">';
  });
}

export { fmtTime };
