/**
 * tests/time.test.ts —— 时间与文本工具
 */

import { describe, expect, it } from 'vitest';
import {
  fmtCount,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  fmtTimeCompact,
  parseTimestamp,
  sanitizeFilename,
} from '@/lib/time';

describe('fmtTime', () => {
  it('一小时以内应为 m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(5)).toBe('0:05');
    expect(fmtTime(65)).toBe('1:05');
    expect(fmtTime(599)).toBe('9:59');
    expect(fmtTime(3599)).toBe('59:59');
  });

  it('一小时以上应为 h:mm:ss', () => {
    expect(fmtTime(3600)).toBe('1:00:00');
    expect(fmtTime(3723)).toBe('1:02:03');
    expect(fmtTime(86399)).toBe('23:59:59');
  });

  it('应容忍负数与非法输入', () => {
    expect(fmtTime(-5)).toBe('0:00');
    expect(fmtTime(Number.NaN)).toBe('0:00');
  });

  it('应向下取整小数秒', () => {
    expect(fmtTime(65.9)).toBe('1:05');
  });
});

describe('parseTimestamp 与 fmtTime 应互逆', () => {
  const cases: ReadonlyArray<[number, string]> = [
    [0, '0:00'],
    [65, '1:05'],
    [150, '2:30'],
    [3723, '1:02:03'],
    [86399, '23:59:59'],
  ];

  it.each(cases)('秒 %i ↔ "%s"', (sec, text) => {
    expect(fmtTime(sec)).toBe(text);
    expect(parseTimestamp(text)).toBe(sec);
  });

  it('应拒绝非法格式', () => {
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('1:2')).toBeNull();
    expect(parseTimestamp('99:99')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('1:60')).toBeNull();
  });
});

describe('fmtTimeCompact', () => {
  it('应生成无冒号形式，可用于文件名', () => {
    expect(fmtTimeCompact(0)).toBe('0s');
    expect(fmtTimeCompact(65)).toBe('1m5s');
    expect(fmtTimeCompact(3723)).toBe('1h2m3s');
  });

  it('结果不应包含冒号', () => {
    for (const s of [0, 59, 60, 3599, 3600, 86399]) {
      expect(fmtTimeCompact(s)).not.toContain(':');
    }
  });
});

describe('fmtDuration', () => {
  it('应生成中文可读时长', () => {
    expect(fmtDuration(45)).toBe('45 秒');
    expect(fmtDuration(90)).toBe('1 分 30 秒');
    expect(fmtDuration(3600)).toBe('1 小时 0 分');
    expect(fmtDuration(5000)).toBe('1 小时 23 分');
  });
});

describe('fmtCount', () => {
  it('应按中文习惯缩略大数', () => {
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(10000)).toBe('1.0万');
    expect(fmtCount(123456)).toBe('12.3万');
    expect(fmtCount(100000000)).toBe('1.0亿');
  });
});

describe('sanitizeFilename', () => {
  it('★ 应替换 Windows 非法字符', () => {
    const out = sanitizeFilename('a<b>c:d"e/f\\g|h?i*j');
    expect(out).not.toMatch(/[<>:"/\\|?*]/);
    expect(out).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('★ 应去掉结尾的点与空格（Windows 不允许）', () => {
    expect(sanitizeFilename('文件名...')).toBe('文件名');
    expect(sanitizeFilename('文件名   ')).toBe('文件名');
  });

  it('应折叠连续空白', () => {
    expect(sanitizeFilename('a    b')).toBe('a b');
  });

  it('空名称应回退为 untitled', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
  });

  it('★ 应限制长度', () => {
    const long = '标'.repeat(300);
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(120);
  });

  it('应保留中文与常规字符', () => {
    expect(sanitizeFilename('【硬核科普】深度学习入门 (2026)')).toBe(
      '【硬核科普】深度学习入门 (2026)',
    );
  });
});

describe('fmtDate / fmtDateTime', () => {
  it('应生成 YYYY-MM-DD', () => {
    expect(fmtDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('应生成 YYYY-MM-DD HH:mm', () => {
    expect(fmtDateTime(0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
