/**
 * composables/useBridge.ts —— 侧边栏与内容脚本的通信封装
 *
 * 侧边栏不能直接调 B站 接口（跨源、无 Cookie），
 * 所有数据都必须经由 内容脚本 → 页面桥 取得。
 */

import { browser, type Browser } from 'wxt/browser';
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import type {
  BridgeAction,
  BridgeContract,
  ContentScriptRequest,
  ContentScriptResponse,
} from '@/lib/types';

/** B站视频页匹配规则（与 manifest 中的内容脚本保持一致） */
const VIDEO_URL_RE =
  /^https:\/\/www\.bilibili\.com\/(video\/|list\/|bangumi\/play\/|medialist\/play\/)/;

export function isBilibiliVideoUrl(url: string | undefined): boolean {
  return typeof url === 'string' && VIDEO_URL_RE.test(url);
}

/** 取当前活动标签页 */
export async function getActiveTab(): Promise<Browser.tabs.Tab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/**
 * 向内容脚本发指令。
 * 若内容脚本尚未注入（例如插件刚安装、页面未刷新），会尝试用
 * chrome.scripting 动态注入，避免要求用户手动刷新页面。
 */
export async function askContent<K extends BridgeAction>(
  tabId: number,
  type: K,
  payload: BridgeContract[K]['payload'],
  timeoutMs = 30_000,
): Promise<BridgeContract[K]['result']> {
  await ensureContentScript(tabId);

  const msg: ContentScriptRequest = { __target: 'content', type, payload };

  return new Promise<BridgeContract[K]['result']>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`请求超时（${type}）。可尝试刷新 B站页面后重试。`));
    }, timeoutMs);

    browser.tabs
      .sendMessage(tabId, msg)
      .then((res: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const r = res as ContentScriptResponse | undefined;
        if (!r) {
          reject(new Error('内容脚本无响应，请刷新 B站页面后重试'));
          return;
        }
        if (r.ok) resolve(r.data as BridgeContract[K]['result']);
        else reject(new Error(r.error));
      })
      .catch((e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `无法与页面通信：${e instanceof Error ? e.message : String(e)}。请刷新 B站页面后重试。`,
          ),
        );
      });
  });
}

/**
 * 确保内容脚本已注入。
 * 通过一次 ping 探测；失败则动态注入两个世界的脚本。
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, {
      __target: 'content',
      type: 'ping',
      payload: undefined,
    } satisfies ContentScriptRequest);
    return; // 已就绪
  } catch {
    /* 未注入，继续下面的动态注入 */
  }

  try {
    const manifest = browser.runtime.getManifest();
    const scripts = manifest.content_scripts ?? [];

    // MAIN world 的桥必须先注入
    const mainScripts = scripts.filter((s) => (s as { world?: string }).world === 'MAIN');
    const isoScripts = scripts.filter((s) => (s as { world?: string }).world !== 'MAIN');

    for (const group of [
      { scripts: mainScripts, world: 'MAIN' as const },
      { scripts: isoScripts, world: undefined },
    ]) {
      for (const s of group.scripts) {
        const files = s.js;
        if (!files?.length) continue;

        // 这些路径来自本扩展自身的 manifest，必然存在于打包产物中，
        // 但 manifest.content_scripts.js 的类型是普通 string[]，
        // WXT 要求的是 ScriptPublicPath（模板字面量）故此处需要断言。
        const injectable = files as ScriptPublicPath[];

        if (group.world) {
          await browser.scripting.executeScript({
            target: { tabId },
            files: injectable,
            world: group.world,
          });
        } else {
          await browser.scripting.executeScript({
            target: { tabId },
            files: injectable,
          });
        }
      }
    }

    // 给脚本一点时间完成 'ready' 握手
    await new Promise((r) => setTimeout(r, 400));
  } catch (e) {
    throw new Error(
      `无法注入页面脚本：${e instanceof Error ? e.message : String(e)}。` +
        `请确认当前是 B站视频页面，或刷新页面后重试。`,
    );
  }
}

/** 让视频跳转到指定秒数 */
export async function seekVideo(tabId: number, seconds: number): Promise<void> {
  try {
    await askContent(tabId, 'seek', { seconds }, 5000);
  } catch {
    /* 跳转失败不阻塞阅读 */
  }
}
