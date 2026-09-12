/**
 * tests/sse.test.ts —— SSE 流式解析
 *
 * 这是最容易被忽视、也最容易出 bug 的地方：
 * 网络分块不会按 SSE 事件边界切分，一个 JSON 可能被切成两半。
 * 如果按「拿到一块就 JSON.parse」的朴素写法，长笔记必然出现内容丢失。
 */

import { describe, expect, it } from 'vitest';
import {
  SseParser,
  pickDelta,
  pickParts,
  pickUsage,
  parseSseText,
  normalizeBaseURL,
  hostPatternFromBaseURL,
} from '@/lib/llm';

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function delta(content: string) {
  return { choices: [{ delta: { content } }] };
}

describe('SseParser', () => {
  it('应解析单个完整事件', () => {
    const p = new SseParser();
    expect(p.push(sse(delta('你好')))).toBe('你好');
  });

  it('应解析多个连续事件', () => {
    const p = new SseParser();
    const out = p.push(sse(delta('A')) + sse(delta('B')) + sse(delta('C')));
    expect(out).toBe('ABC');
  });

  it('★ 应正确处理被切断的 JSON（分块边界）', () => {
    const p = new SseParser();
    const full = sse(delta('这是一段较长的文本内容'));

    // 逐字符喂入，模拟最恶劣的分块情况
    let out = '';
    for (const ch of full) out += p.push(ch);

    expect(out).toBe('这是一段较长的文本内容');
  });

  it('★ 应正确处理事件边界恰好落在块之间', () => {
    const p = new SseParser();
    const a = sse(delta('AAA'));
    const b = sse(delta('BBB'));

    // 第一块只给到 a 的一半
    const half = Math.floor(a.length / 2);
    const out1 = p.push(a.slice(0, half));
    const out2 = p.push(a.slice(half) + b);

    expect(out1 + out2).toBe('AAABBB');
  });

  it('应忽略心跳与注释行', () => {
    const p = new SseParser();
    const out = p.push(': keep-alive\n\n' + sse(delta('X')) + '\n\n');
    expect(out).toBe('X');
  });

  it('遇到 [DONE] 后应停止解析', () => {
    const p = new SseParser();
    const out = p.push(sse(delta('A')) + 'data: [DONE]\n\n' + sse(delta('B')));
    expect(out).toBe('A');
  });

  it('应忽略无法解析的畸形行而不抛错', () => {
    const p = new SseParser();
    const out = p.push('data: {不是合法JSON\n\n' + sse(delta('OK')));
    expect(out).toBe('OK');
  });

  it('flush 应处理没有换行结尾的尾包', () => {
    const p = new SseParser();
    p.push(sse(delta('A')));
    // 最后一个事件没有结尾换行
    const tail = `data: ${JSON.stringify(delta('B'))}`;
    p.push(tail);
    expect(p.flush()).toBe('B');
  });

  it('应兼容 message.content 形态（非流式响应被当作流读取）', () => {
    const p = new SseParser();
    const out = p.push(`data: ${JSON.stringify({ choices: [{ message: { content: 'M' } }] })}\n\n`);
    expect(out).toBe('M');
  });

  it('应兼容 delta 为 null 的情况', () => {
    const p = new SseParser();
    const out = p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n\n`);
    expect(out).toBe('');
  });
});

describe('pickDelta', () => {
  it('应依次尝试 delta / message / text', () => {
    expect(pickDelta({ choices: [{ delta: { content: 'd' } }] })).toBe('d');
    expect(pickDelta({ choices: [{ message: { content: 'm' } }] })).toBe('m');
    expect(pickDelta({ choices: [{ text: 't' }] })).toBe('t');
  });

  it('对非法输入应返回空串', () => {
    expect(pickDelta(null)).toBe('');
    expect(pickDelta(undefined)).toBe('');
    expect(pickDelta({})).toBe('');
    expect(pickDelta({ choices: [] })).toBe('');
  });
});

describe('parseSseText', () => {
  it('应拼接全部增量', () => {
    const text = sse(delta('甲')) + sse(delta('乙')) + 'data: [DONE]\n\n';
    expect(parseSseText(text)).toBe('甲乙');
  });
});

describe('思考过程（reasoning）提取', () => {
  it('★ reasoning_content 应与正文分开提取，不混进正文', () => {
    const parts = pickParts({
      choices: [{ delta: { content: '答', reasoning_content: '想' } }],
    });
    expect(parts.content).toBe('答');
    expect(parts.reasoning).toBe('想');
  });

  it('★ 兼容 OpenRouter 的 reasoning 字段', () => {
    const parts = pickParts({ choices: [{ delta: { reasoning: '想', content: '答' } }] });
    expect(parts.reasoning).toBe('想');
    expect(parts.content).toBe('答');
  });

  it('普通模型没有思考字段时应返回空', () => {
    expect(pickParts(delta('仅正文')).reasoning).toBe('');
  });

  it('SseParser 应把思考增量送到回调，正文照常返回', () => {
    const seen: string[] = [];
    const p = new SseParser({ onReasoning: (t) => seen.push(t) });
    const out =
      p.push(sse({ choices: [{ delta: { reasoning_content: '先想' } }] })) +
      p.push(sse({ choices: [{ delta: { content: '后答' } }] }));
    expect(seen).toEqual(['先想']);
    expect(out).toBe('后答');
  });

  it('不传回调时思考增量被丢弃（与旧行为一致）', () => {
    const p = new SseParser();
    const out = p.push(sse({ choices: [{ delta: { reasoning_content: 'x' } }] }));
    expect(out).toBe('');
  });
});

describe('token 用量（usage）提取', () => {
  it('★ usage 单独成块（choices 为空）时应触发回调，正文不受影响', () => {
    const seen: unknown[] = [];
    const p = new SseParser({ onUsage: (u) => seen.push(u) });
    const out =
      p.push(sse(delta('答'))) +
      p.push(
        sse({
          choices: [],
          usage: { prompt_tokens: 34211, completion_tokens: 1284, total_tokens: 35495 },
        }),
      );
    expect(out).toBe('答');
    expect(seen).toEqual([{ promptTokens: 34211, completionTokens: 1284, totalTokens: 35495 }]);
  });

  it('缺 total_tokens 时按输入+输出补齐', () => {
    expect(pickUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('没有 usage 或全零时返回 null', () => {
    expect(pickUsage(delta('x'))).toBeNull();
    expect(pickUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBeNull();
    expect(pickUsage(null)).toBeNull();
  });
});

describe('normalizeBaseURL', () => {
  it('应去掉尾部斜杠', () => {
    expect(normalizeBaseURL('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });

  it('缺少协议时应补 https', () => {
    expect(normalizeBaseURL('api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('缺少版本段时应补 /v1', () => {
    expect(normalizeBaseURL('https://api.example.com')).toBe('https://api.example.com/v1');
  });

  it('已含版本段时不应重复补', () => {
    expect(normalizeBaseURL('https://api.siliconflow.cn/v1')).toBe(
      'https://api.siliconflow.cn/v1',
    );
    expect(normalizeBaseURL('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    );
  });

  it('空串应返回空串', () => {
    expect(normalizeBaseURL('')).toBe('');
    expect(normalizeBaseURL('   ')).toBe('');
  });
});

describe('hostPatternFromBaseURL', () => {
  it('应生成正确的 match pattern', () => {
    expect(hostPatternFromBaseURL('https://api.example.com/v1')).toBe(
      'https://api.example.com/*',
    );
  });

  it('应保留端口', () => {
    expect(hostPatternFromBaseURL('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
  });

  it('非法地址应返回 null', () => {
    expect(hostPatternFromBaseURL('')).toBe(null);
  });
});
