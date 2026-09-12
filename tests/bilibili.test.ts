/**
 * tests/bilibili.test.ts —— B站数据层的纯函数逻辑
 *
 * 这里只测不需网络的纯逻辑：
 *   · URL 解析（BV号 / av号 / 番剧 / 分P）
 *   · 多P视频的 cid 选择（选错会导致字幕和视频对不上）
 *   · 字幕轨优先级
 *   · 字幕地址规范化
 */

import { describe, expect, it } from 'vitest';
import {
  currentPageIndex,
  normalizeSubtitleUrl,
  parseVideoId,
  pickBestTrack,
  resolveCid,
} from '@/lib/bilibili';
import type { PageInfo, SubtitleTrack, VideoInfo } from '@/lib/types';

/* ---------------- URL 解析 ---------------- */

describe('parseVideoId', () => {
  it('应解析标准 BV 号链接', () => {
    expect(parseVideoId('https://www.bilibili.com/video/BV1L94y1H7CV')).toEqual({
      bvid: 'BV1L94y1H7CV',
    });
  });

  it('应解析带查询参数与分P的链接', () => {
    expect(parseVideoId('https://www.bilibili.com/video/BV1L94y1H7CV?p=3&t=10')).toEqual({
      bvid: 'BV1L94y1H7CV',
    });
  });

  it('应解析 av 号链接', () => {
    expect(parseVideoId('https://www.bilibili.com/video/av170001')).toEqual({ aid: 170001 });
  });

  it('应解析 bvid 查询参数形式', () => {
    expect(parseVideoId('https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD')).toEqual({
      bvid: 'BV1xx411c7mD',
    });
  });

  it('应解析番剧 ep 链接', () => {
    expect(parseVideoId('https://www.bilibili.com/bangumi/play/ep123456')).toEqual({
      ep: 'ep123456',
    });
  });

  it('应解析番剧 ss 链接', () => {
    expect(parseVideoId('https://www.bilibili.com/bangumi/play/ss28747')).toEqual({
      ep: 'ss28747',
    });
  });

  it('非视频页应返回 null', () => {
    expect(parseVideoId('https://www.bilibili.com/')).toBeNull();
    expect(parseVideoId('https://www.bilibili.com/account/history')).toBeNull();
    expect(parseVideoId('https://example.com/video/BV1xx')).toBeNull();
  });
});

describe('currentPageIndex', () => {
  it('无 p 参数应为 1', () => {
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx')).toBe(1);
  });

  it('应解析 p 参数', () => {
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx?p=5')).toBe(5);
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx?foo=1&p=12')).toBe(12);
  });

  it('非法 p 值应回退为 1', () => {
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx?p=abc')).toBe(1);
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx?p=0')).toBe(1);
    expect(currentPageIndex('https://www.bilibili.com/video/BV1xx?p=-3')).toBe(1);
  });
});

/* ---------------- 多P视频的 cid 选择 ---------------- */

describe('resolveCid', () => {
  const base = {
    aid: 1,
    bvid: 'BV1xx',
    cid: 100,
    title: '合辑',
    desc: '',
    upName: 'UP',
    upMid: 9,
    duration: 600,
    cover: '',
    pubdate: 0,
    view: 0,
    like: 0,
    isBangumi: false,
  };

  const pages: PageInfo[] = [
    { cid: 101, page: 1, part: '第一集', duration: 300 },
    { cid: 102, page: 2, part: '第二集', duration: 300 },
    { cid: 103, page: 3, part: '第三集', duration: 300 },
  ];

  it('★ 多P视频应选中当前分P的 cid', () => {
    const info = resolveCid({ ...base, pages }, 'https://www.bilibili.com/video/BV1xx?p=2');
    expect(info.cid).toBe(102);
    expect(info.pageIndex).toBe(2);
    expect(info.pageCount).toBe(3);
    expect(info.partTitle).toBe('第二集');
  });

  it('无 p 参数时应选第一个分P', () => {
    const info = resolveCid({ ...base, pages }, 'https://www.bilibili.com/video/BV1xx');
    expect(info.cid).toBe(101);
    expect(info.pageIndex).toBe(1);
  });

  it('p 超出范围时应回退到第一个分P', () => {
    const info = resolveCid({ ...base, pages }, 'https://www.bilibili.com/video/BV1xx?p=99');
    expect(info.cid).toBe(101);
  });

  it('单P视频应保留原 cid 且 pageCount 为 1', () => {
    const info = resolveCid({ ...base, pages: [] }, 'https://www.bilibili.com/video/BV1xx');
    expect(info.cid).toBe(100);
    expect(info.pageCount).toBe(1);
  });

  it('★ 结果中不应残留 pages 字段（避免冗余数据传给模型）', () => {
    const info = resolveCid({ ...base, pages }, 'https://www.bilibili.com/video/BV1xx');
    expect('pages' in info).toBe(false);
  });

  it('应返回完整的 VideoInfo 字段', () => {
    const info: VideoInfo = resolveCid({ ...base, pages }, 'https://www.bilibili.com/video/BV1xx');
    expect(info.bvid).toBe('BV1xx');
    expect(info.aid).toBe(1);
    expect(info.title).toBe('合辑');
  });
});

/* ---------------- 字幕地址与优先级 ---------------- */

describe('normalizeSubtitleUrl', () => {
  it('★ 协议相对地址应补上 https:', () => {
    expect(normalizeSubtitleUrl('//aisubtitle.hdslb.com/bfs/ai_subtitle/xx.json')).toBe(
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/xx.json',
    );
  });

  it('已是绝对地址应保持不变', () => {
    const u = 'https://aisubtitle.hdslb.com/x.json';
    expect(normalizeSubtitleUrl(u)).toBe(u);
  });
});

describe('pickBestTrack', () => {
  const track = (
    lan: string,
    lanDoc: string,
    isAi: boolean,
    url = 'https://x/y.json',
  ): SubtitleTrack => ({ lan, lanDoc, url, isAi });

  it('★ 应优先选择中文人工字幕', () => {
    const tracks = [
      track('en-US', 'English', false),
      track('ai-zh', '中文（自动生成）', true),
      track('zh-CN', '中文（中国）', false),
    ];
    expect(pickBestTrack(tracks)?.lan).toBe('zh-CN');
  });

  it('无人工中文时应选中文 AI 字幕', () => {
    const tracks = [track('en-US', 'English', false), track('ai-zh', '中文（自动生成）', true)];
    expect(pickBestTrack(tracks)?.lan).toBe('ai-zh');
  });

  it('无中文字幕时应退回任意人工字幕', () => {
    const tracks = [track('ai-en', 'English 自动', true), track('ja-JP', '日本語', false)];
    expect(pickBestTrack(tracks)?.lan).toBe('ja-JP');
  });

  it('仅有 AI 字幕时应选 AI 字幕', () => {
    const tracks = [track('ai-en', 'English 自动', true)];
    expect(pickBestTrack(tracks)?.lan).toBe('ai-en');
  });

  it('空列表应返回 null', () => {
    expect(pickBestTrack([])).toBeNull();
  });

  it('lanDoc 含中文也应识别', () => {
    const tracks = [track('custom', '简体中文', false)];
    expect(pickBestTrack(tracks)?.lan).toBe('custom');
  });

  it('★ isAi 应正确识别 ai- 前缀', () => {
    const t = track('ai-zh', '中文（自动生成）', true);
    expect(t.isAi).toBe(true);
    expect(track('zh-CN', '中文', false).isAi).toBe(false);
  });
});
