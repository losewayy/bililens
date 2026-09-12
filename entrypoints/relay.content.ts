/**
 * entrypoints/relay.content.ts —— 隔离世界（ISOLATED world）中继
 *
 * 职责：在「页面上下文（MAIN world）」与「扩展后台」之间双向转发。
 *
 *   侧边栏 ──chrome.runtime──> relay ──postMessage──> bridge(MAIN) ──fetch──> B站
 *   侧边栏 <──chrome.runtime── relay <──postMessage── bridge(MAIN) <──────────┘
 *
 * 为什么不直接让侧边栏调 B站接口？
 *   ① 侧边栏是扩展源（chrome-extension://），请求 B站 接口属于跨站，
 *      既不带 B站 Cookie，Referer 也不对，会被风控拒绝
 *   ② MAIN world 才能拿到页面同源身份，见 bridge.content.ts 的说明
 *
 * 为什么不直接在页面里调 LLM？
 *   API Key 绝不能暴露在页面上下文（页面脚本可读），且跨域会被 CORS 拦截。
 */

import type {
  BridgeAction,
  BridgeContract,
  BridgeRequestMessage,
  BridgeResponseMessage,
  ContentScriptRequest,
  ContentScriptResponse,
} from '@/lib/types';

export default defineContentScript({
  matches: [
    'https://www.bilibili.com/video/*',
    'https://www.bilibili.com/list/*',
    'https://www.bilibili.com/bangumi/play/*',
    'https://www.bilibili.com/medialist/play/*',
  ],
  runAt: 'document_idle',

  main() {
    /* -------------------------------------------------------------- *
     * 与页面桥通信
     * -------------------------------------------------------------- */

    interface Pending {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: number;
    }

    const pending = new Map<string, Pending>();
    let seq = 0;
    let bridgeReady = false;
    const readyWaiters: Array<() => void> = [];

    function callBridge<K extends BridgeAction>(
      type: K,
      payload: BridgeContract[K]['payload'],
      timeoutMs = 30_000,
    ): Promise<BridgeContract[K]['result']> {
      return new Promise<BridgeContract[K]['result']>((resolve, reject) => {
        const id = `c${++seq}_${Date.now()}`;

        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`与页面通信超时（${type}），请刷新页面后重试`));
        }, timeoutMs);

        pending.set(id, {
          resolve: (v) => {
            window.clearTimeout(timer);
            resolve(v as BridgeContract[K]['result']);
          },
          reject: (e) => {
            window.clearTimeout(timer);
            reject(e);
          },
          timer,
        });

        const req: BridgeRequestMessage = {
          __bililens: 'req',
          id,
          type,
          payload,
        } as BridgeRequestMessage;
        window.postMessage(req, '*');
      });
    }

    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const m = ev.data as BridgeResponseMessage | { __bililens?: string } | undefined;
      if (!m || m.__bililens !== 'res') return;

      const res = m as BridgeResponseMessage;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);

      if (res.ok) p.resolve(res.data);
      else p.reject(new Error(res.error ?? '页面桥接返回未知错误'));
    });

    // 页面桥就绪握手：可能比我们早或晚，两种都要处理
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if ((ev.data as { __bililens?: string } | undefined)?.__bililens === 'ready') {
        bridgeReady = true;
        readyWaiters.splice(0).forEach((fn) => fn());
      }
    });

    /** 等待页面桥就绪；已就绪则立即返回 */
    function whenBridgeReady(): Promise<void> {
      if (bridgeReady) return Promise.resolve();

      return callBridge('ping', undefined, 5000)
        .then(() => {
          bridgeReady = true;
        })
        .catch(
          () =>
            new Promise<void>((resolve) => {
              // document_start 的桥通常已注入，此处兜底等待 'ready' 广播
              readyWaiters.push(resolve);
              window.setTimeout(resolve, 3000);
            }),
        );
    }

    /* -------------------------------------------------------------- *
     * 接收侧边栏指令
     * -------------------------------------------------------------- */

    browser.runtime.onMessage.addListener(
      (
        msg: ContentScriptRequest,
        _sender,
        sendResponse: (r: ContentScriptResponse) => void,
      ) => {
        if (!msg || msg.__target !== 'content') return undefined;

        whenBridgeReady()
          .then(() => callBridge(msg.type, msg.payload as never))
          .then((data) => sendResponse({ ok: true, data }))
          .catch((e: unknown) =>
            sendResponse({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            }),
          );

        return true; // 异步响应
      },
    );

    /* -------------------------------------------------------------- *
     * 主动上报：URL 变化（B站是 SPA，切分P/切视频不刷新页面）
     * -------------------------------------------------------------- */

    let lastHref = location.href;

    window.setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      void browser.runtime
        .sendMessage({ __target: 'background', type: 'urlChanged', href: lastHref })
        .catch(() => undefined); // 后台可能未唤醒，忽略
    }, 1000);

    /* -------------------------------------------------------------- *
     * 首次注入时主动探测一次，让侧边栏能立即显示视频信息
     * -------------------------------------------------------------- */

    void whenBridgeReady()
      .then(() => callBridge('videoInfo', undefined, 15_000))
      .then((info) =>
        browser.runtime
          .sendMessage({ __target: 'background', type: 'videoDetected', info })
          .catch(() => undefined),
      )
      .catch(() => undefined); // 非视频页等情况静默处理
  },
});
