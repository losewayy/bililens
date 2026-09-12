/**
 * tests/llm.test.ts —— 提示词组装与转录压缩
 *
 * 重点验证「时间戳必须来自原文」这一约束在数据层面成立：
 * 模型只能看到带时间戳的转录文本，无法凭空生成。
 */

import { describe, expect, it } from 'vitest';
import { buildNoteMessages, buildMaterial, formatTranscript } from '@/lib/llm';
import { fmtTime } from '@/lib/time';

describe('formatTranscript', () => {
  it('应把分段转成带时间戳的文本行', () => {
    const out = formatTranscript([
      { from: 0, content: '开场白' },
      { from: 65, content: '第一个要点' },
      { from: 3723, content: '接近结尾' },
    ]);

    expect(out).toContain('[0:00] 开场白');
    expect(out).toContain('[1:05] 第一个要点');
    expect(out).toContain('[1:02:03] 接近结尾');
  });

  it('应折叠空白并跳过空内容', () => {
    const out = formatTranscript([
      { from: 0, content: '  多余   空格  ' },
      { from: 1, content: '   ' },
      { from: 2, content: '正常' },
    ]);

    expect(out).toBe('[0:00] 多余 空格\n[0:02] 正常');
  });

  it('空输入应返回空串', () => {
    expect(formatTranscript([])).toBe('');
  });

  it('★ 内容不超限时应完整保留，不做任何压缩', () => {
    const segs = Array.from({ length: 100 }, (_, i) => ({
      from: i * 10,
      content: `第 ${i} 段内容`,
    }));
    const out = formatTranscript(segs, 100_000);
    expect(out).not.toContain('已按等距抽样压缩');
    expect(out.split('\n')).toHaveLength(100);
  });

  it('★ 内容超限时应抽样压缩并明确告知模型', () => {
    const segs = Array.from({ length: 5000 }, (_, i) => ({
      from: i * 5,
      content: `这是一段比较长的字幕内容，用于测试抽样逻辑是否生效，序号 ${i}`,
    }));
    const out = formatTranscript(segs, 20_000);

    expect(out.length).toBeLessThan(40_000);
    expect(out).toContain('已按等距抽样压缩');
  });

  it('★ 压缩后仍应保留首段与末段的时间戳（时间轴覆盖完整）', () => {
    const segs = Array.from({ length: 3000 }, (_, i) => ({
      from: i * 5,
      content: `内容${i}，填充文字让长度足够触发压缩逻辑`,
    }));
    const out = formatTranscript(segs, 10_000);

    expect(out).toContain('[0:00]');

    // 末段必须保留（时间轴覆盖到片尾），用 fmtTime 计算避免手写出错
    const lastFrom = (segs.length - 1) * 5;
    expect(out).toContain(`[${fmtTime(lastFrom)}]`);
    expect(out).toContain('内容2999');
  });
});

describe('buildMessages', () => {
  const info = {
    title: '测试视频',
    upName: '某UP主',
    duration: 600,
    bvid: 'BV1L94y1H7CV',
  };

  it('应生成 system + user 两条消息', () => {
    const msgs = buildNoteMessages({ info });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.role).toBe('user');
  });

  it('system 提示词应包含关键约束', () => {
    const msgs = buildNoteMessages({ info });
    const sys = msgs[0]?.content ?? '';

    expect(sys).toContain('时间戳');
    expect(sys).toContain('不得编造');
    // 底线规则现在表述为「只依据我提供的字幕原文作答」
    expect(sys).toContain('只依据我提供的字幕原文');
    expect(sys).toContain('核心摘要');
  });

  it('user 消息应包含视频信息', () => {
    const msgs = buildNoteMessages({ info });
    const user = msgs[1]?.content ?? '';

    expect(user).toContain('测试视频');
    expect(user).toContain('某UP主');
    expect(user).toContain('https://www.bilibili.com/video/BV1L94y1H7CV');
    expect(user).toContain('10:00');
  });

  it('多P视频链接应带上 p 参数', () => {
    const msgs = buildNoteMessages({ info: { ...info, pageIndex: 3 } });
    expect(msgs[1]?.content).toContain('?p=3');
  });

  it('★ 应包含官方提纲（作为分段参考）', () => {
    const msgs = buildNoteMessages({
      info,
      conclusion: {
        available: true,
        summary: '官方摘要内容',
        outline: [
          {
            title: '第一章',
            timestamp: 0,
            points: [{ timestamp: 10, content: '要点甲' }],
          },
        ],
      },
    });
    const user = msgs[1]?.content ?? '';

    expect(user).toContain('B站官方 AI 提纲');
    expect(user).toContain('第一章');
    expect(user).toContain('[0:10] 要点甲');
    expect(user).toContain('官方摘要内容');
  });

  it('★ 结论不可用时不应出现官方提纲段落', () => {
    const msgs = buildNoteMessages({
      info,
      conclusion: { available: false },
    });
    const user = msgs[1]?.content ?? '';

    expect(user).not.toContain('B站官方 AI 提纲');
  });

  it('应包含字幕原文', () => {
    const msgs = buildNoteMessages({
      info,
      subtitle: [
        { from: 0, content: '大家好' },
        { from: 5, content: '今天我们讲' },
      ],
    });
    const user = msgs[1]?.content ?? '';

    expect(user).toContain('视频字幕原文');
    expect(user).toContain('[0:00] 大家好');
    expect(user).toContain('共 2 条');
  });

  it('应有视频简介', () => {
    const msgs = buildNoteMessages({ info: { ...info, desc: '这是简介' } });
    expect(msgs[1]?.content).toContain('这是简介');
  });

  it('★ 笔记与聊天共用同一份素材（字幕不该拼两遍）', () => {
    const payload = {
      info,
      subtitle: [
        { from: 0, content: '大家好' },
        { from: 5, content: '今天我们讲' },
      ],
    };

    const material = buildMaterial(payload);
    // 笔记的消息里必须原样包含这份素材
    expect(buildNoteMessages(payload)[1]?.content).toContain(material);
  });
});
