/**
 * tests/markdown.test.ts —— Markdown 渲染与 XSS 防护
 *
 * 关键前提：模型输出属于**不可信内容**。
 * 若直接 innerHTML，一个被投毒的视频字幕就可能让模型输出 <img onerror=...>，
 * 进而在扩展页面（拥有 chrome.* 权限的来源）里执行脚本。
 * 因此这里必须验证「先转义、再生成标签」的策略确实生效。
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  extractSections,
  injectSectionAnchors,
  renderMarkdown,
  tidyStreamingMarkdown,
} from '@/lib/markdown';

describe('escapeHtml', () => {
  it('应转义全部 HTML 敏感字符', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

describe('renderMarkdown 的安全性', () => {
  it('★ 不应把 <script> 渲染为真实标签', () => {
    const html = renderMarkdown('正常文本 <script>alert(1)</script> 结尾');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('★ 不应把 img onerror 渲染为真实标签', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('★ 标题与列表中的注入也应被转义', () => {
    const md = '# <iframe src=evil>\n- <b onmouseover=hack>条目';
    const html = renderMarkdown(md);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<b onmouseover');
    expect(html).toContain('&lt;iframe');
  });

  it('★ 行内代码中的标签应保持转义', () => {
    const html = renderMarkdown('使用 `<div>` 标签');
    expect(html).toContain('<code>');
    expect(html).toContain('&lt;div&gt;');
    expect(html).not.toContain('<div>');
  });
});

describe('renderMarkdown 的渲染能力', () => {
  it('应渲染各级标题', () => {
    expect(renderMarkdown('# 一级')).toContain('<h1>一级</h1>');
    expect(renderMarkdown('## 二级')).toContain('<h2>二级</h2>');
    // ### 是时间轴导轨的刻度节点，因此带 rail 类（见「导轨」用例）
    expect(renderMarkdown('### 三级')).toContain('<h3 class="rail">三级</h3>');
  });

  it('应渲染无序列表', () => {
    const html = renderMarkdown('- 甲\n- 乙\n- 丙');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>甲</li>');
    expect(html).toContain('<li>丙</li>');
    expect(html).toContain('</ul>');
  });

  it('应渲染有序列表', () => {
    const html = renderMarkdown('1. 第一\n2. 第二');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>第一</li>');
  });

  it('应在列表与段落之间正确闭合标签', () => {
    const html = renderMarkdown('段落甲\n\n- 项\n\n段落乙');
    expect(html).toContain('<p>段落甲</p>');
    expect(html).toContain('</ul>');
    expect(html).toContain('<p>段落乙</p>');
    // 不应出现标签嵌套错误
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('<p>段落乙</p>'));
  });

  it('应渲染粗体与斜体', () => {
    expect(renderMarkdown('这是 **重点** 内容')).toContain('<strong>重点</strong>');
    expect(renderMarkdown('这是 *强调* 内容')).toContain('<em>强调</em>');
  });

  it('应渲染引用块', () => {
    const html = renderMarkdown('> 引用内容');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('引用内容');
  });

  it('应渲染水平线', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
  });

  it('空输入应返回空串', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('时间戳渲染（核心交互）', () => {
  it('★ 章节标题的时间戳应渲染为导轨节点（签名元素）', () => {
    const html = renderMarkdown('### [02:30] 章节标题');

    // 刻度节点（可点击跳转）
    expect(html).toContain('class="rail__node"');
    expect(html).toContain('data-seek="150"');
    // 等宽时间刻度
    expect(html).toContain('class="rail__time tnum"');
    expect(html).toContain('>02:30<');
    // 标题本体仍保留
    expect(html).toContain('章节标题');
  });

  it('★ 正文里的时间戳应渲染为低调的 .ts（非导轨节点）', () => {
    const html = renderMarkdown('前面 [02:30] 后面');

    expect(html).toContain('class="ts tnum"');
    expect(html).toContain('data-seek="150"');
    // 正文不应出现导轨节点，否则粉色会泛滥
    expect(html).not.toContain('rail__node');
  });

  it('★ 章节节点应支持 h:mm:ss 形式', () => {
    const html = renderMarkdown('### [1:02:03] 内容');
    // 1*3600 + 2*60 + 3 = 3723
    expect(html).toContain('data-seek="3723"');
  });

  it('应支持 0 秒', () => {
    expect(renderMarkdown('### [00:00] 开头')).toContain('data-seek="0"');
  });

  it('非时间格式的方括号应原样保留', () => {
    const html = renderMarkdown('[重要] 提示');
    expect(html).toContain('[重要]');
    expect(html).not.toContain('data-seek');
  });

  it('超出 59 分的伪时间戳不应被当作时间戳', () => {
    const html = renderMarkdown('[99:99] 文本');
    expect(html).not.toContain('data-seek');
  });

  it('★ 导轨节点应带无障碍标签', () => {
    const html = renderMarkdown('### [02:30] 标题');
    expect(html).toContain('aria-label="跳转到 02:30"');
  });
});

describe('extractSections', () => {
  it('应抽取 ### 标题为章节', () => {
    const md = [
      '## 摘要',
      '一些内容',
      '### [00:00] 开场',
      '内容',
      '### [02:30] 核心论点',
      '内容',
    ].join('\n');

    const secs = extractSections(md);
    expect(secs).toHaveLength(2);
    expect(secs[0]).toMatchObject({ title: '开场', seconds: 0, timeText: '00:00' });
    expect(secs[1]).toMatchObject({ title: '核心论点', seconds: 150, timeText: '02:30' });
  });

  it('应忽略 ## 级标题', () => {
    expect(extractSections('## 摘要\n### 章节')).toHaveLength(1);
  });

  it('无时间戳的章节 seconds 应为 null 且 timeText 为空', () => {
    const secs = extractSections('### 没有时间戳的标题');
    expect(secs[0]?.seconds).toBeNull();
    expect(secs[0]?.timeText).toBe('');
    expect(secs[0]?.title).toBe('没有时间戳的标题');
  });

  it('应生成唯一的锚点 id', () => {
    const secs = extractSections('### A\n### B\n### C');
    const ids = secs.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['sec-0', 'sec-1', 'sec-2']);
  });

  it('★ 抽取与渲染的章节数必须一致（否则导轨会错位）', () => {
    const md = [
      '## 摘要',
      '段落',
      '### [00:00] 第一章',
      '- 要点',
      '### [01:30] 第二章',
      '- 要点',
      '### [03:00] 第三章',
    ].join('\n');

    const secs = extractSections(md);
    const html = renderMarkdown(md);
    const railCount = (html.match(/<h3 class="rail">/g) ?? []).length;

    expect(railCount).toBe(secs.length);
    expect(railCount).toBe(3);
  });
});

describe('injectSectionAnchors', () => {
  it('应把 id 注入到导轨标题上', () => {
    const md = '### A\n### B';
    const html = renderMarkdown(md);
    const secs = extractSections(md);
    const out = injectSectionAnchors(html, secs);

    expect(out).toContain('<h3 class="rail" id="sec-0">');
    expect(out).toContain('<h3 class="rail" id="sec-1">');
  });

  it('★ 注入后 id 数量应与章节数一致', () => {
    const md = '### A\n### B\n### C';
    const html = renderMarkdown(md);
    const out = injectSectionAnchors(html, extractSections(md));

    const ids = out.match(/id="sec-\d+"/g) ?? [];
    expect(ids).toHaveLength(3);
  });
});

describe('tidyStreamingMarkdown', () => {
  it('★ 应清理流式中未闭合的粗体标记', () => {
    expect(tidyStreamingMarkdown('这是 **未完')).toBe('这是 未完');
  });

  it('已闭合的粗体应保持不变', () => {
    expect(tidyStreamingMarkdown('这是 **完整** 的')).toBe('这是 **完整** 的');
  });

  it('★ 应清理未闭合的行内代码', () => {
    expect(tidyStreamingMarkdown('使用 `未完')).toBe('使用 未完');
  });

  it('已闭合的代码应保持不变', () => {
    expect(tidyStreamingMarkdown('使用 `code` 完毕')).toBe('使用 `code` 完毕');
  });
});

describe('表格', () => {
  it('★ 渲染表头/分隔行/对齐，单元格内时间戳可点', () => {
    const md = ['| 概念 | 时间 |', '| :--- | ---: |', '| 秩 | [2:52] |', '| 行列式 | [4:19] |'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<td>秩</td>');
    expect(html).toContain('<th>概念</th>');
    expect(html).toContain('<th style="text-align:right">时间</th>');
    expect(html).toContain('<td style="text-align:right">');
    expect(html).toContain('data-seek="172"');
    expect(html).toContain('行列式');
  });

  it('没有分隔行的竖线文本不是表格', () => {
    expect(renderMarkdown('a | b')).not.toContain('<table>');
  });
});

describe('围栏代码块', () => {
  it('★ 保留缩进、内容转义、不做行内处理', () => {
    const md = ['前文', '', '```python', 'if a < b:', '    print("hi **x**")', '```', '后文'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<pre><code>');
    expect(html).toContain('if a &lt; b:');
    expect(html).toContain('    print(&quot;hi **x**&quot;)');
    expect(html).not.toContain('<strong>');
  });

  it('未闭合的围栏也照常渲染（流被截断）', () => {
    const html = renderMarkdown('```js\nconst a = 1;');
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
  });
});

describe('链接', () => {
  it('★ http(s) 渲染为 <a>，新窗口打开', () => {
    const html = renderMarkdown('看[这个文档](https://katex.org)了解');
    expect(html).toContain(
      '<a href="https://katex.org" target="_blank" rel="noopener noreferrer">这个文档</a>',
    );
  });

  it('javascript: 协议不渲染为链接（原样文本）', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))');
    expect(html).not.toContain('<a ');
  });
});

describe('公式（KaTeX）', () => {
  it('★ 行内 $ 与独立 $$ 都渲染成 KaTeX', () => {
    const html = renderMarkdown('秩为 $r(A)$，且 $$\frac{a}{b}$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
  });

  it('价格与中文内容不当作公式', () => {
    const html = renderMarkdown('花了 $100，省了 $3，那个 $5，这个 $10 元');
    expect(html).not.toContain('katex');
  });

  it('$r(A)$ 这类裸函数记号也要渲染（截图回归）', () => {
    const html = renderMarkdown('所有非零子式的最高阶数称为 $A$ 的秩，记作 $r(A)$');
    expect(html).toContain('katex');
    expect(html).not.toContain('$');
  });

  it('表格单元格里的转义竖线不该切断列（|A| 记号）', () => {
    const md = ['| 公式 | 说明 |', '| :--- | :--- |', '| $\\|A\\| > 0$ | 行列式为正 |'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('katex');
    expect(html).toContain('行列式为正');
  });

  it('行内代码里的 $ 不是公式', () => {
    const html = renderMarkdown('写 `$x^2$` 字面量');
    expect(html).not.toContain('katex');
    expect(html).toContain('<code>$x^2$</code>');
  });

  it('★ TeX 里的 HTML 无法注入（KaTeX 自行转义）', () => {
    const html = renderMarkdown('$\\text{<img src=x onerror=alert(1)>}$');
    expect(html).toContain('katex');
    expect(html).not.toContain('<img');
  });
});
