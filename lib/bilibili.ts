/**
 * lib/bilibili.ts —— B站接口客户端（运行在页面上下文 MAIN world）
 *
 * 为什么放在页面里跑：见 entrypoints/bridge.content.ts 的说明。
 * 本模块只负责「取数」，不含任何 UI 逻辑，便于单测。
 */

import { encWbi, keyFromUrl, type WbiKeys } from './wbi';
import {
  NotLoggedInError,
  type Conclusion,
  type NavStatus,
  type PageInfo,
  type SubtitleListResult,
  type SubtitleSegment,
  type SubtitleTrack,
  type VideoInfo,
} from './types';

const API = 'https://api.bilibili.com';

/** WBI 密钥缓存有效期 */
const WBI_TTL_MS = 30 * 60 * 1000;

/* ================================================================== *
 * 低层请求
 * ================================================================== */

interface BiliEnvelope<T> {
  code: number;
  message: string;
  ttl?: number;
  data?: T;
}

async function getJson<T>(url: string): Promise<BiliEnvelope<T>> {
  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  return (await resp.json()) as BiliEnvelope<T>;
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined | null>,
): Promise<BiliEnvelope<T>> {
  const q = params ? buildQuery(params) : '';
  return getJson<T>(`${API}${path}${q ? '?' + q : ''}`);
}

/* ================================================================== *
 * WBI 签名请求
 * ================================================================== */

let wbiCache: (WbiKeys & { fetchedAt: number }) | null = null;

/** 取出 WBI 密钥并缓存 */
export async function getWbiKeys(force = false): Promise<WbiKeys> {
  if (!force && wbiCache && Date.now() - wbiCache.fetchedAt < WBI_TTL_MS) {
    return { imgKey: wbiCache.imgKey, subKey: wbiCache.subKey };
  }

  const j = await apiGet<{ wbi_img?: { img_url?: string; sub_url?: string } }>(
    '/x/web-interface/nav',
  );

  const wbi = j.data?.wbi_img;
  if (!wbi?.img_url || !wbi.sub_url) {
    throw new Error('无法获取 Wbi 签名密钥（nav 接口异常），请确认已登录 B站');
  }

  const keys: WbiKeys = {
    imgKey: keyFromUrl(wbi.img_url),
    subKey: keyFromUrl(wbi.sub_url),
  };
  wbiCache = { ...keys, fetchedAt: Date.now() };
  return keys;
}

/** 测试辅助：清空密钥缓存 */
export function __resetWbiCache(): void {
  wbiCache = null;
}

async function signedGet<T>(
  path: string,
  params: Record<string, string | number | undefined | null>,
): Promise<BiliEnvelope<T>> {
  const keys = await getWbiKeys();
  const qs = encWbi(params, keys);
  return getJson<T>(`${API}${path}?${qs}`);
}

/* ================================================================== *
 * 视频信息
 * ================================================================== */

interface RawViewData {
  aid: number;
  bvid: string;
  cid: number;
  title: string;
  desc?: string;
  duration: number;
  pic?: string;
  pubdate?: number;
  owner?: { mid?: number; name?: string };
  stat?: { view?: number; like?: number };
  pages?: Array<{ cid: number; page: number; part: string; duration: number }>;
}

/** 当前 URL 是第几个分P（?p=2 → 2），默认 1 */
export function currentPageIndex(href: string): number {
  const m = href.match(/[?&]p=(\d+)/);
  if (!m) return 1;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 判断 URL 是否属于 B站。
 * 解析失败（例如传入相对路径）时返回 true，保持宽松，
 * 以免在非绝对 URL 场景下误判。
 */
function isBilibiliHost(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host === 'bilibili.com' || host.endsWith('.bilibili.com');
  } catch {
    return true;
  }
}

/** 从 URL 中解析出视频标识；非 B站 域名一律返回 null */
export function parseVideoId(href: string): { bvid?: string; aid?: number; ep?: string } | null {
  if (!isBilibiliHost(href)) return null;

  let m: RegExpMatchArray | null;

  if ((m = href.match(/\/video\/(BV[0-9A-Za-z]+)/))) return { bvid: m[1] as string };
  if ((m = href.match(/\/video\/(av\d+)/i))) return { aid: Number((m[1] as string).slice(2)) };
  if ((m = href.match(/[?&]bvid=(BV[0-9A-Za-z]+)/))) return { bvid: m[1] as string };
  if ((m = href.match(/\/bangumi\/play\/(ep\d+|ss\d+)/))) return { ep: m[1] as string };

  return null;
}

/** 多P视频：按当前页选对 cid */
export function resolveCid(
  base: Omit<VideoInfo, 'pageIndex' | 'pageCount' | 'partTitle'> & { pages?: PageInfo[] },
  href: string,
): VideoInfo {
  const pages = base.pages ?? [];
  const idx = currentPageIndex(href);

  const { pages: _omit, ...rest } = base;

  if (pages.length > 1) {
    const hit = pages.find((p) => p.page === idx) ?? pages[0]!;
    return {
      ...rest,
      cid: hit.cid,
      pageIndex: hit.page,
      pageCount: pages.length,
      partTitle: hit.part,
    };
  }

  return { ...rest, pageIndex: 1, pageCount: Math.max(1, pages.length), partTitle: '' };
}

async function fetchBangumi(
  ep: string,
): Promise<Omit<VideoInfo, 'pageIndex' | 'pageCount' | 'partTitle'>> {
  const epId = ep.replace(/\D/g, '');
  const j = await apiGet<{
    title?: string;
    up_info?: { uname?: string; mid?: number };
    episodes?: Array<{
      aid: number;
      bvid: string;
      cid: number;
      ep_id: number;
      long_title?: string;
      share_copy?: string;
      duration?: number;
      cover?: string;
    }>;
  }>('/pgc/view/web/season', { ep_id: epId });

  if (j.code !== 0 || !j.data) {
    throw new Error(`番剧信息获取失败：${j.message}（${j.code}）`);
  }

  const list = j.data.episodes ?? [];
  const hit = list.find((e) => `ep${e.ep_id}` === ep) ?? list[0];
  if (!hit) throw new Error('未找到剧集信息');

  return {
    aid: hit.aid,
    bvid: hit.bvid,
    cid: hit.cid,
    title: `${j.data.title ?? ''}${hit.long_title ? ' — ' + hit.long_title : ''}`,
    desc: hit.share_copy ?? '',
    upName: j.data.up_info?.uname ?? '',
    upMid: j.data.up_info?.mid ?? 0,
    duration: hit.duration ? Math.round(hit.duration / 1000) : 0,
    cover: hit.cover ?? '',
    pubdate: 0,
    view: 0,
    like: 0,
    isBangumi: true,
  };
}

/** 获取视频基础信息（公开接口，无需登录） */
export async function fetchVideoInfo(href: string): Promise<VideoInfo> {
  const id = parseVideoId(href);
  if (!id) throw new Error('当前页面不是 B站视频页');

  if (id.ep) {
    const b = await fetchBangumi(id.ep);
    return resolveCid(b, href);
  }

  const j = await apiGet<RawViewData>('/x/web-interface/view', id);
  if (j.code !== 0 || !j.data) {
    throw new Error(`视频信息获取失败：${j.message}（${j.code}）`);
  }

  const d = j.data;
  const pages: PageInfo[] = (d.pages ?? []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    duration: p.duration,
  }));

  return resolveCid(
    {
      aid: d.aid,
      bvid: d.bvid,
      cid: d.cid,
      title: d.title,
      desc: (d.desc ?? '').slice(0, 500),
      upName: d.owner?.name ?? '',
      upMid: d.owner?.mid ?? 0,
      duration: d.duration,
      cover: d.pic ?? '',
      pubdate: d.pubdate ?? 0,
      view: d.stat?.view ?? 0,
      like: d.stat?.like ?? 0,
      isBangumi: false,
      pages,
    },
    href,
  );
}

/* ================================================================== *
 * 官方 AI 总结
 * ================================================================== */

interface RawConclusion {
  code?: number;
  stid?: string;
  like_num?: number;
  model_result?: {
    result_type?: number;
    summary?: string;
    outline?: Array<{
      title?: string;
      timestamp?: number;
      part_outline?: Array<{ timestamp?: number; content?: string }>;
    }>;
    subtitle?: Array<{
      part_subtitle?: Array<{ content?: string; start_timestamp?: number; end_timestamp?: number }>;
    }>;
  } | null;
}

/**
 * 获取 B站官方 AI 总结。
 *
 * 这是本项目最省事的一环：一次请求即可拿到
 * 「整段摘要 + 分段提纲（带时间戳）+ AI 字幕全文」，
 * 且完全免费、无需经过用户的大模型。
 */
export async function fetchConclusion(p: {
  aid: number;
  bvid: string;
  cid: number;
  upMid: number;
}): Promise<Conclusion> {
  const j = await signedGet<RawConclusion>('/x/web-interface/view/conclusion/get', {
    aid: p.aid,
    bvid: p.bvid,
    cid: p.cid,
    up_mid: p.upMid,
  });

  if (j.code === -101) throw new NotLoggedInError();
  if (j.code === -403) return { available: false, reason: '该视频访问权限不足，无法读取官方总结' };
  if (j.code !== 0) return { available: false, reason: `官方总结接口异常：${j.message}` };

  const d = j.data ?? {};
  const mr = d.model_result;

  if (d.code === -1) {
    return { available: false, reason: '该视频不支持 AI 摘要（可能为敏感内容）' };
  }
  if (!mr || d.code === 1) {
    return {
      available: false,
      reason:
        d.code === 1
          ? '该视频尚未被 B站 AI 总结过（可能未识别到语音）'
          : '该视频没有官方 AI 总结',
    };
  }

  const outline = (mr.outline ?? []).map((o) => ({
    title: o.title ?? '',
    timestamp: o.timestamp ?? 0,
    points: (o.part_outline ?? []).map((pt) => ({
      timestamp: pt.timestamp ?? 0,
      content: pt.content ?? '',
    })),
  }));

  const subtitle: SubtitleSegment[] = [];
  for (const seg of mr.subtitle ?? []) {
    for (const s of seg.part_subtitle ?? []) {
      subtitle.push({
        from: s.start_timestamp ?? 0,
        to: s.end_timestamp ?? 0,
        content: s.content ?? '',
      });
    }
  }

  return {
    available: true,
    summary: mr.summary ?? '',
    outline,
    subtitle,
    resultType: mr.result_type ?? 0,
    like: d.like_num ?? 0,
  };
}

/* ================================================================== *
 * 字幕
 * ================================================================== */

/** 规范化字幕地址：// 开头补 https: */
export function normalizeSubtitleUrl(url: string): string {
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

/** 获取字幕轨列表（人工字幕 + AI 字幕） */
export async function fetchSubtitleList(p: {
  aid: number;
  bvid: string;
  cid: number;
}): Promise<SubtitleListResult> {
  const j = await signedGet<{
    subtitle?: {
      subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }>;
    };
  }>('/x/player/wbi/v2', { aid: p.aid, bvid: p.bvid, cid: p.cid });

  if (j.code === -101) throw new NotLoggedInError();
  if (j.code !== 0) return { list: [], error: `字幕接口异常：${j.message}` };

  const list: SubtitleTrack[] = (j.data?.subtitle?.subtitles ?? []).map((s) => {
    const lan = s.lan ?? '';
    return {
      lan,
      lanDoc: s.lan_doc ?? lan,
      url: normalizeSubtitleUrl(s.subtitle_url ?? ''),
      isAi: /^ai-/.test(lan),
    };
  });

  return { list: list.filter((t) => t.url) };
}

interface RawSubtitleBody {
  body?: Array<{ from?: number; to?: number; content?: string }>;
}

/** 拉取字幕主体内容 */
export async function fetchSubtitleBody(url: string): Promise<SubtitleSegment[]> {
  const resp = await fetch(normalizeSubtitleUrl(url), {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  if (!resp.ok) throw new Error(`字幕文件下载失败 HTTP ${resp.status}`);

  const j = (await resp.json()) as RawSubtitleBody;
  return (j.body ?? []).map((s) => ({
    from: s.from ?? 0,
    to: s.to ?? 0,
    content: s.content ?? '',
  }));
}

/**
 * 挑选最合适的字幕轨。
 * 优先级：中文人工字幕 > 中文 AI 字幕 > 任意人工 > 任意 AI > 第一条
 */
export function pickBestTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  if (!tracks.length) return null;

  const isZh = (t: SubtitleTrack): boolean =>
    /zh|cn|中文/i.test(t.lan) || /中文|简体|繁體/.test(t.lanDoc);

  return (
    tracks.find((t) => isZh(t) && !t.isAi) ??
    tracks.find((t) => isZh(t) && t.isAi) ??
    tracks.find((t) => !t.isAi) ??
    tracks.find((t) => t.isAi) ??
    tracks[0] ??
    null
  );
}

/* ================================================================== *
 * 登录态
 * ================================================================== */

export async function fetchNavStatus(): Promise<NavStatus> {
  const j = await apiGet<{
    isLogin?: boolean;
    uname?: string;
    mid?: number;
    vipStatus?: number;
  }>('/x/web-interface/nav');

  return {
    isLogin: Boolean(j.data?.isLogin),
    uname: j.data?.uname ?? '',
    mid: j.data?.mid ?? 0,
    vip: j.data?.vipStatus === 1,
  };
}

/**
 * 获取纯音频流直链（DASH 格式中的低码率音轨）
 * 仅用于无官方字幕时提交给本地 ASR 转录服务兜底
 */
export async function fetchAudioStreamUrl(p: {
  aid: number;
  bvid: string;
  cid: number;
}): Promise<string | null> {
  try {
    const j = await signedGet<{
      dash?: {
        audio?: Array<{ id?: number; baseUrl?: string; base_url?: string }>;
      };
    }>('/x/player/wbi/playurl', {
      avid: p.aid,
      bvid: p.bvid,
      cid: p.cid,
      fnval: 16,
      fnver: 0,
      fourk: 0,
    });

    if (j.code !== 0 || !j.data?.dash?.audio?.length) {
      return null;
    }

    const audios = j.data.dash.audio;
    const stream = audios[0]?.baseUrl || audios[0]?.base_url;
    return stream ? normalizeSubtitleUrl(stream) : null;
  } catch {
    return null;
  }
}
