/**
 * tests/nested-list.test.ts —— 嵌套列表渲染
 *
 * 这是「思维导图」模式能否工作的地基：
 * 思维导图的层级完全依赖 Markdown 的缩进嵌套。
 * 若渲染器把缩进拍平（每个缩进项都变成同级的 <li>），
 * 三层结构就会塌成一层，用户看到的就是一堆并列的短句而不是导图。
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/lib/markdown';

/**
 * 用栈校验 HTML 标签是否成对且不交叉。
 * 这是「拍平」类 bug 的照妖镜：即使视觉上像嵌套，
 * 只要标签闭合顺序错了，浏览器就会重排成完全不同的树。
 */
function checkNesting(html: string): { ok: boolean; reason?: string } {
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = (m[2] as string).toLowerCase();
    const attrs = m[3] ?? '';

    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;

    if (closing) {
      const top = stack.pop();
      if (top !== tag) {
        return { ok: false, reason: `期望 </${String(top)}>，实际 </${tag}>` };
      }
    } else {
      stack.push(tag);
    }
  }

  return stack.length > 0 ? { ok: false, reason: `未闭合：${stack.join(' > ')}` } : { ok: true };
}

describe('嵌套列表（思维导图的地基）', () => {
  it('★ 两级缩进应产生真正嵌套的 ul', () => {
    const html = renderMarkdown('- 主题\n  - 分支');
    expect(html).toContain('<li>主题<ul>');
    expect(html).toContain('</ul></li>');
  });

  it('★ 三级缩进应产生三层嵌套', () => {
    const html = renderMarkdown('- L1\n  - L2\n    - L3');
    expect(html).toMatch(/<li>L2<ul><li>L3<\/li><\/ul><\/li>/);
  });

  it('★ 缩进回退时应正确闭合', () => {
    const html = renderMarkdown('- A\n  - A1\n- B');
    expect(html).toMatch(/<li>A<ul><li>A1<\/li><\/ul><\/li><li>B<\/li>/);
  });

  it('★ 不应再使用扁平的 sub 方案', () => {
    expect(renderMarkdown('- A\n  - B')).not.toContain('class="sub"');
  });

  it('★ 生成结果必须是合法嵌套（多层混合）', () => {
    const md = '- 主题\n  - 分支A\n    - 要点1\n    - 要点2\n  - 分支B\n- 主题2';
    const r = checkNesting(renderMarkdown(md));
    expect(r.ok, r.reason).toBe(true);
  });

  it('应支持 4 空格缩进', () => {
    expect(renderMarkdown('- A\n    - B')).toContain('<li>A<ul>');
  });

  it('应支持制表符缩进', () => {
    expect(renderMarkdown('- A\n\t- B')).toContain('<li>A<ul>');
  });

  it('有序列表嵌套应工作', () => {
    expect(renderMarkdown('1. A\n   1. B')).toContain('<li>A<ol>');
  });

  it('嵌套列表后接段落应正确闭合', () => {
    const html = renderMarkdown('- A\n  - B\n\n段落');
    const r = checkNesting(html);
    expect(r.ok, r.reason).toBe(true);
    expect(html).toContain('<p>段落</p>');
  });

  it('★ 四级嵌套也应合法', () => {
    const r = checkNesting(renderMarkdown('- 1\n  - 2\n    - 3\n      - 4'));
    expect(r.ok, r.reason).toBe(true);
  });

  it('混合 ul 与 ol 的嵌套应合法', () => {
    const r = checkNesting(renderMarkdown('- A\n  1. B\n  2. C\n- D'));
    expect(r.ok, r.reason).toBe(true);
  });

  it('同缩进切换列表类型应正确闭合', () => {
    const html = renderMarkdown('- A\n1. B');
    const r = checkNesting(html);
    expect(r.ok, r.reason).toBe(true);
    expect(html).toContain('</ul>');
    expect(html).toContain('<ol>');
  });

  it('★ 嵌套列表后接标题应正确闭合', () => {
    const html = renderMarkdown('- A\n  - B\n## 标题');
    const r = checkNesting(html);
    expect(r.ok, r.reason).toBe(true);
    expect(html).toContain('<h2>标题</h2>');
  });

  it('嵌套项里的时间戳仍应可点击', () => {
    const html = renderMarkdown('- A\n  - [1:23] 要点');
    expect(html).toContain('data-seek="83"');
  });
});
