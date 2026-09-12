/**
 * lib/fontScale.ts —— 侧边栏字号档位
 *
 * 侧边栏只有 ~320px 宽，13px 的字在 2K 屏上确实吃力。
 * 这里提供一个有限的档位，而不是让用户填任意数值：
 * 字号是整体比例，随手填一个 22px 会把标题层级、按钮高度、
 * 时间戳胶囊全部撑坏；四档足够覆盖「有点小 → 明显偏大」。
 */

import { browser } from 'wxt/browser';

import type { Settings } from './types';

/** 档位。顺序即从小到大，界面上的「A」也按这个顺序排 */
export const FONT_SCALES = [
  { id: 'normal', label: '标准', ratio: 1 },
  { id: 'large', label: '大', ratio: 1.15 },
  { id: 'xlarge', label: '更大', ratio: 1.3 },
  { id: 'huge', label: '最大', ratio: 1.45 },
] as const;

export type FontScale = (typeof FONT_SCALES)[number]['id'];

const KEY = 'settings.v1';

/** 把档位写到 <html data-font> 上；CSS 里的 --fs 由它决定 */
export function setFontScale(scale: FontScale): void {
  document.documentElement.dataset['font'] = scale;
}

/**
 * 从设置里读出档位并应用。
 *
 * @param forceDefault 设置页传 true —— 设置页永远用标准字号，
 *                     免得用户把字号调大后连这一项都找不到。
 */
export async function applyFontScale(forceDefault = false): Promise<void> {
  if (forceDefault) {
    setFontScale('normal');
    return;
  }

  try {
    const raw = await browser.storage.local.get(KEY);
    const s = raw[KEY] as Partial<Settings> | undefined;
    setFontScale(normalizeFontScale(s?.fontScale));
  } catch {
    setFontScale('normal');
  }
}

/** 把任意输入收敛到一个合法档位（旧数据 / 手工改坏都能扛） */
export function normalizeFontScale(v: unknown): FontScale {
  return FONT_SCALES.some((f) => f.id === v) ? (v as FontScale) : 'normal';
}
