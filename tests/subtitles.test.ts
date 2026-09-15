/**
 * tests/subtitles.test.ts —— 字幕导出格式转换
 *
 * SRT/VTT 的时间轴格式（毫秒分隔符、进位、补零）是最容易错的地方，
 * 跨小时的时间戳和毫秒进位必须有测试锁住。
 */

import { describe, expect, it } from 'vitest';
import { toSrt, toVtt, toTxt } from '@/lib/subtitles';
import type { SubtitleSegment } from '@/lib/types';

const seg = (from: number, to: number, content: string): SubtitleSegment => ({ from, to, content });

describe('toSrt', () => {
  it('★ 序号连续、时间轴逗号毫秒、跨小时进位正确', () => {
    const srt = toSrt([seg(0, 1.5, '第一句'), seg(3661.25, 3662.5, '第二句')]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n' +
        '2\n01:01:01,250 --> 01:01:02,500\n第二句\n',
    );
  });

  it('★ 空白字幕被过滤且序号不留空洞', () => {
    const srt = toSrt([seg(0, 1, '有内容'), seg(2, 3, '   '), seg(4, 5, '第三句')]);
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:05,000\n第三句');
    expect(srt).not.toContain('3\n');
  });

  it('全部为空时返回空串', () => {
    expect(toSrt([seg(0, 1, '')])).toBe('');
  });
});

describe('toVtt', () => {
  it('★ WEBVTT 头 + 点毫秒分隔', () => {
    const vtt = toVtt([seg(1.25, 2.5, '文本')]);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.250 --> 00:00:02.500');
    expect(vtt).toContain('文本');
  });

  it('无可用字幕时只有头', () => {
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});

describe('toTxt', () => {
  it('★ 纯文本导出无时间戳，纯净文稿格式', () => {
    const txt = toTxt([seg(0, 5, '第一句'), seg(3961, 3965, '第二句')]);
    expect(txt).toBe('第一句\n第二句');
  });
});
