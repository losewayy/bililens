/**
 * entrypoints/bridge.content.ts —— 运行在页面上下文（MAIN world）
 *
 * 【这是整个方案的关键设计】
 *
 * B站的内容接口（conclusion/get、player/wbi/v2）要求三件事同时成立：
 *   ① 请求携带登录 Cookie（SESSDATA）
 *   ② 带正确的 Wbi 签名
 *   ③ 来源（Referer/Origin）是 bilibili.com
 *
 * 若在扩展进程里发请求，②要自己算（已实现），但①和③需要伪造，
 * 既容易被风控拦截，也要求用户手工导出 Cookie —— 体验很差。
 *
 * 而本脚本运行在 www.bilibili.com 页面内：
 *   · fetch api.bilibili.com 属于同站请求 → Cookie 自动携带
 *   · Referer / Origin 天然正确，无需伪造
 *   · 签名在本地用 lib/wbi.ts 计算
 * 结论：**用户什么都不用配置，装上就是登录态。**
 *
 * 与隔离世界通过 window.postMessage 通信（MAIN world 拿不到 chrome.* API）。
 */

import {
  fetchConclusion,
  fetchNavStatus,
  fetchSubtitleBody,
  fetchSubtitleList,
  fetchVideoInfo,
  parseVideoId,
} from '@/lib/bilibili';
import type {
  BridgeAction,
  BridgeContract,
  BridgeRequestMessage,
  BridgeResponseMessage,
  VideoIdPayload,
} from '@/lib/types';

declare global {
  interface Window {
    __BILILENS_BRIDGE__?: boolean;
  }
}

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
    'https://www.bilibili.com/bangumi/play/*',
    'https://www.bilibili.com/medialist/play/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    if (window.__BILILENS_BRIDGE__) return;
    window.__BILILENS_BRIDGE__ = true;

    /* -------------------------------------------------------------- *
     * 动作实现
     * -------------------------------------------------------------- */

    const handlers: {
      [K in BridgeAction]: (
        payload: BridgeContract[K]['payload'],
      ) => Promise<BridgeContract[K]['result']>;
    } = {
      ping: async () => ({ href: location.href }),

      videoInfo: async () => {
        const href = location.href;
        if (!parseVideoId(href)) throw new Error('当前页面不是 B站视频页');
        return await fetchVideoInfo(href);
      },

      /** 一次性采集：官方总结 + 字幕列表。任一失败不影响另一个 */
      collect: async () => {
        const href = location.href;
        const info = await fetchVideoInfo(href);

        const [conclusion, subtitles] = await Promise.all([
          fetchConclusion(info).catch((e: unknown) => ({
            available: false as const,
            reason: e instanceof Error ? e.message : String(e),
          })),
          fetchSubtitleList(info).catch((e: unknown) => ({
            list: [],
            error: e instanceof Error ? e.message : String(e),
          })),
        ]);

        return { info, conclusion, subtitles };
      },

      aiConclusion: async (p) => await fetchConclusion(p as VideoIdPayload),

      subtitleList: async (p) => await fetchSubtitleList(p as VideoIdPayload),

      fetchSubtitleBody: async (p) =>
        await fetchSubtitleBody((p as { url: string }).url),

      /** 让播放器跳到指定秒数 */
      seek: async (p) => {
        const seconds = (p as { seconds: number }).seconds;
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = seconds;
          // 若处于暂停态，顺手播放，符合「点时间戳继续看」的直觉
          void video.play().catch(() => undefined);
        } else {
          // 兜底：分P 页面通过 hash 定位
          location.hash = `#t=${Math.floor(seconds)}`;
        }
        return { ok: true as const };
      },

      /** 读取当前播放位置。拿不到（如未开始播放）时返回 null */
      playhead: async () => {
        const video = document.querySelector('video');
        const t = video?.currentTime;
        return { seconds: typeof t === 'number' && Number.isFinite(t) ? t : null };
      },

      navStatus: async () => await fetchNavStatus(),
    };

    /* -------------------------------------------------------------- *
     * 消息路由
     * -------------------------------------------------------------- */

    window.addEventListener('message', (ev: MessageEvent) => {
      // 只接受来自本窗口的消息（页面脚本无法伪造 source）
      if (ev.source !== window) return;

      const msg = ev.data as BridgeRequestMessage | undefined;
      if (!msg || msg.__bililens !== 'req') return;

      const reply = (
        ok: boolean,
        data: unknown,
        error: string | null,
      ): void => {
        const res: BridgeResponseMessage = {
          __bililens: 'res',
          id: msg.id,
          ok,
          data,
          error,
        };
        window.postMessage(res, '*');
      };

      const fn = handlers[msg.type];
      if (typeof fn !== 'function') {
        reply(false, null, `未知指令：${String(msg.type)}`);
        return;
      }

      Promise.resolve()
        .then(() => (fn as (p: unknown) => Promise<unknown>)(msg.payload))
        .then((data) => reply(true, data, null))
        .catch((e: unknown) =>
          reply(false, null, e instanceof Error ? e.message : String(e)),
        );
    });

    // 通知隔离世界：桥已就绪（document_start 注入，可能早于对方注册监听）
    window.postMessage({ __bililens: 'ready' }, '*');
  },
});
