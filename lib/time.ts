/**
 * lib/time.ts —— 时间与文本工具
 */

/** 秒 → "m:ss" 或 "h:mm:ss"，用于展示与时间戳标记 */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

/** 秒 → 用于文件名/URL 的无冒号形式，如 "1h02m03s" */
export function fmtTimeCompact(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${r}s`].filter(Boolean).join('');
}

/** 解析 "mm:ss" / "h:mm:ss" / "1:02:03" 为秒数；无法解析返回 null */
export function parseTimestamp(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

/** 秒 → "2026-02-14 15:04" 形式（本地时区） */
export function fmtDateTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 秒 → "YYYY-MM-DD"（本地时区） */
export function fmtDate(unixSec?: number): string {
  const d = unixSec === undefined ? new Date() : new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 大数字 → "1.2万" / "3.4亿" */
export function fmtCount(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/** token 数 → 紧凑展示：987 / 12.3k / 3.4M */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((v / 1_000_000) * 10) / 10}M`;
}

/**
 * 秒 → "1 小时 23 分" 形式
 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/**
 * 清理标题，使其可安全用作文件名。
 * Windows 非法字符：< > : " / \ | ? *  以及控制字符
 */
export function sanitizeFilename(name: string, maxLen = 120): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    // Windows 不允许文件名以点或空格结尾
    .replace(/[. ]+$/, '')
    .trim();
  const safe = cleaned || 'untitled';
  return safe.length > maxLen ? safe.slice(0, maxLen).trim() : safe;
}
