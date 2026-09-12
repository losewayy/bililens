/**
 * lib/subtitles.ts —— 字幕导出（SRT / VTT / 纯文本）
 *
 * 数据源是采集层的 SubtitleSegment（秒为单位的 from/to + 文本）。
 * 转换是纯函数以便单测；落盘走 browser.downloads，
 * 与 export.ts 的 Markdown 下载同一通道。
 */

import type { SubtitleSegment } from './types';
import { fmtTime, sanitizeFilename } from './time';

/** 秒 → "HH:MM:SS,mmm"（SRT 用逗号做毫秒分隔） */
function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** 秒 → "HH:MM:SS.mmm"（VTT 用点做毫秒分隔） */
function vttTime(sec: number): string {
  return srtTime(sec).replace(',', '.');
}

/** 去掉空行字幕；SRT 的序号必须连续，因此先过滤再编号 */
function usable(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.filter((s) => String(s.content ?? '').trim());
}

export function toSrt(segments: SubtitleSegment[]): string {
  const body = usable(segments)
    .map(
      (seg, i) =>
        `${i + 1}\n${srtTime(seg.from)} --> ${srtTime(seg.to)}\n${String(seg.content).trim()}`,
    )
    .join('\n\n');
  return body ? `${body}\n` : '';
}

export function toVtt(segments: SubtitleSegment[]): string {
  const body = usable(segments)
    .map(
      (seg, i) =>
        `${i + 1}\n${vttTime(seg.from)} --> ${vttTime(seg.to)}\n${String(seg.content).trim()}`,
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

/** 纯文本：与提示词材料里的字幕格式一致（[mm:ss] 内容） */
export function toTxt(segments: SubtitleSegment[]): string {
  return usable(segments)
    .map((seg) => `[${fmtTime(seg.from)}] ${String(seg.content).trim()}`)
    .join('\n');
}

export type SubtitleFormat = 'srt' | 'vtt' | 'txt';

export const SUBTITLE_FORMATS: ReadonlyArray<{ id: SubtitleFormat; label: string; ext: string }> = [
  { id: 'srt', label: 'SRT 字幕', ext: 'srt' },
  { id: 'vtt', label: 'VTT 字幕', ext: 'vtt' },
  { id: 'txt', label: '纯文本', ext: 'txt' },
];

const MIME: Record<SubtitleFormat, string> = {
  srt: 'application/x-subrip;charset=utf-8',
  vtt: 'text/vtt;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
};

/** 下载字幕文件；文件名已做 Windows 非法字符清理 */
export async function downloadSubtitles(
  segments: SubtitleSegment[],
  baseName: string,
  format: SubtitleFormat,
): Promise<void> {
  const content =
    format === 'srt' ? toSrt(segments) : format === 'vtt' ? toVtt(segments) : toTxt(segments);
  if (!content) return;

  const blob = new Blob([content], { type: MIME[format] });
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({
      url,
      filename: `${sanitizeFilename(baseName)}.${format}`,
      saveAs: false,
    });
  } finally {
    // 交给浏览器读取后释放
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
