/**
 * entrypoints/background.ts —— MV3 Service Worker
 *
 * 【架构决策一：为什么 LLM 调用不放这里？】
 *
 * MV3 的 Service Worker 会在约 30 秒空闲后被浏览器强制终止。
 * 长视频的流式总结往往要跑 1~3 分钟，若把流式请求放在 SW 里：
 *   · SW 被回收 → 请求中断，用户看到一半的笔记卡死
 *   · 虽有 chrome.alarms / keepalive 等续命技巧，但都属于「对抗平台」，
 *     在 Chrome 版本升级中反复失效，不可靠。
 *
 * 因此本项目的分工是：
 *   · Service Worker（本文件）：只做轻量、可随时中断的协调工作
 *       - 按标签页启用/关闭侧边栏
 *       - 转发内容脚本的主动上报
 *   · 侧边栏（sidepanel）：承载真正的重活
 *       - 它是有 DOM 的扩展页面，生命周期跟随用户可见状态
 *       - 直接发起 LLM 流式请求（已获授权的可选域名权限）
 *
 * 【架构决策二：侧边栏必须「跟着网页走」】
 *
 * Chrome 的侧边栏默认是**窗口级单例**：整个窗口只有一个面板，
 * 内容不随标签页变化。这会导致一个很反直觉的现象——
 * 你在 A 视频页生成了笔记，切到 B 视频页，面板里还是 A 的笔记；
 * 一旦在 B 上重新生成，A 的结果就被覆盖了。
 * 多开几个视频页并行总结时，这个行为完全不可用。
 *
 * 解法是用 sidePanel.setOptions({ tabId, path, enabled }) 把面板
 * 声明为**标签页级**：
 *   · 每个 B站视频页各自拥有独立的面板实例与独立状态
 *   · 切到非视频页时面板自动隐藏（这正是用户预期的「跟着网页走」）
 *   · 切回视频页时面板恢复，且保留该页自己的内容
 */

import type { ContentToBackground, VideoInfo } from '@/lib/types';

/** 与内容脚本 matches 保持一致：只有这些页面才配拥有侧边栏 */
const VIDEO_URL_RE =
  /^https:\/\/www\.bilibili\.com\/(video\/|list\/|bangumi\/play\/|medialist\/play\/)/;

/** 每个标签页最近一次探测到的视频信息（供侧边栏快速展示） */
const tabVideo = new Map<number, VideoInfo>();

/**
 * 用户**亲手点过图标**的标签页。
 *
 * 【为什么需要它】
 * 光凭「是不是 B站视频页」来决定启用面板是不够的：
 * 你在视频 A 点开侧边栏，切到视频 B（同样是视频页），
 * 面板会继续跟着展开——于是 A 正在生成时你切走，那个面板还杵在那儿。
 *
 * 期望的行为是：**展开侧边栏这个动作只对当时那一页有效**。
 * 因此只有被点过图标的标签页才启用面板，其余一律禁用
 * （禁用会让 Chrome 自动收起面板，切回来时又自动恢复）。
 *
 * 【为什么存 storage.session】
 * MV3 的 Service Worker 约 30 秒空闲就被回收，模块级变量会丢失。
 * 若只放内存里，用户切走再切回时这个集合已经空了，
 * 我们会误判成「没点过」而把面板关掉。
 * storage.session 正好符合需求：跨 SW 重启保留，浏览器关闭即清空。
 *
 * 【为什么不在这里加内存缓存】
 * 曾经为了少读一次 storage 而缓存了这个集合，结果它与 storage
 * 变成了两个真相来源：storage 被改动后缓存仍是旧值，
 * 于是「切走再切回」时面板被判成没点过而失效。
 * storage.session 本身就在内存里，读一次的开销可以忽略，
 * 因此这里始终以 storage 为准——单一真相来源比省这一次读取重要得多。
 */
const OPENED_KEY = 'panelOpenedTabs';

async function getOpenedTabs(): Promise<Set<number>> {
  try {
    const raw = await browser.storage.session.get(OPENED_KEY);
    return new Set((raw[OPENED_KEY] as number[] | undefined) ?? []);
  } catch {
    return new Set();
  }
}

async function markOpened(tabId: number, opened: boolean): Promise<void> {
  const set = await getOpenedTabs();
  if (opened) set.add(tabId);
  else set.delete(tabId);
  await browser.storage.session.set({ [OPENED_KEY]: [...set] }).catch(() => undefined);
}

export default defineBackground(() => {
  /* -------------------------------------------------------------- *
   * 标签页级侧边栏：只有点过图标的那一页才启用
   * -------------------------------------------------------------- */

  /**
   * 同步某个标签页的面板启用状态。
   *
   * 刻意**不 await** setOptions：它与随后的 open() 若串行等待，
   * 会出现「open 已按 tabId 调用，但 setOptions 尚未生效」的竞态，
   * 结果是面板被当成全局面板打开（见 chrome-extensions-samples#987）。
   */
  async function syncPanel(tabId: number, url: string | undefined): Promise<void> {
    const set = await getOpenedTabs();
    const shouldEnable = set.has(tabId) && typeof url === 'string' && VIDEO_URL_RE.test(url);

    void browser.sidePanel
      .setOptions(
        shouldEnable
          ? { tabId, path: 'sidepanel.html', enabled: true }
          : { tabId, enabled: false },
      )
      .catch(() => undefined);
  }

  // 切换标签页：新激活的这一页若不是「点过图标的那一页」，禁用即自动收起
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void browser.tabs
      .get(tabId)
      .then((t) => syncPanel(tabId, t.url))
      .catch(() => undefined);
  });

  // 同一标签页内导航（B站是 SPA，切分P/切视频不刷新页面）
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url === undefined && info.status !== 'complete') return;
    void syncPanel(tabId, tab?.url);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabVideo.delete(tabId);
    void markOpened(tabId, false);
  });

  // 浏览器启动时只同步当前这一页，避免为几十个后台标签页空跑一遍
  void browser.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => {
      const t = tabs[0];
      if (t?.id !== undefined) return syncPanel(t.id, t.url);
      return undefined;
    })
    .catch(() => undefined);

  /* -------------------------------------------------------------- *
   * 点击扩展图标 → 在当前标签页打开侧边栏
   * -------------------------------------------------------------- */

  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;

    /*
     * 【顺序：必须先 setOptions 启用，再 open】
     *
     * chrome.sidePanel.open({ tabId }) 只在**该标签页的面板已启用**时才
     * 会打开。否则直接拒绝：
     *     No active side panel for tabId: <id>
     *
     * 而本扩展的 syncPanel() 恰恰会把「没点过图标」的标签页设为禁用，
     * 所以点击处理器里若少了 setOptions，open() 必然失败。
     *
     * 曾经这里就漏了这一步：只标记 opened 就去 open()，点图标毫无反应。
     * 用户只能改用右键菜单里的「打开侧边栏」，而那个是浏览器原生的
     * **全局面板**——它不跟随标签页，切到任何页面都还开着。
     * 两个症状，同一个根因。
     *
     * 【关于 await】
     * 一度以为根因是「await 让用户手势失效」。实测并非如此：在
     * scripts/verify-tabpanel.mjs 的 [2] 段里，await 一次 storage 之后
     * 再 open() 依然成功。真正必需的是上面那条顺序约束，与 await 无关。
     * 这里保持同步发出，只是让顺序最直白、无歧义。
     */
    void browser.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    void browser.sidePanel.open({ tabId }).catch((e: unknown) => {
      console.warn('[BiliLens] 打开侧边栏失败', e);
    });

    // 记账放在后面，不影响上面的调用
    void markOpened(tabId, true);
  });

  // 由我们自己控制何时打开侧边栏（点击图标时），而非自动打开
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => undefined);

  /*
   * 【启动时全局禁用面板 —— 与 manifest 里不写 default_path 同等重要】
   *
   * 这两步是同一个修复的两半，缺一不可：
   *
   *   · manifest 里不声明 side_panel.default_path
   *     → 不存在「全局默认面板」这个回退目标
   *   · 这里全局 setOptions({ enabled: false })
   *     → 任何没有专属配置的标签页，面板都是关的
   *
   * 少了任何一半，切到没配置过的标签页时浏览器都会把面板显示出来，
   * 看起来就像「侧边栏跟着我到处跑」。
   * 参考 GoogleChrome/chrome-extensions-samples#987。
   */
  void browser.sidePanel.setOptions({ enabled: false }).catch(() => undefined);

  /* -------------------------------------------------------------- *
   * 接收内容脚本上报
   * -------------------------------------------------------------- */

  browser.runtime.onMessage.addListener(
    (msg: ContentToBackground, sender, sendResponse: (r: unknown) => void) => {
      if (!msg || msg.__target !== 'background') return undefined;

      const tabId = sender.tab?.id;

      switch (msg.type) {
        case 'videoDetected':
          if (tabId !== undefined) tabVideo.set(tabId, msg.info);
          sendResponse({ ok: true });
          break;

        case 'urlChanged':
          // URL 变了，清掉该 tab 的缓存信息，等 relay 重新探测
          if (tabId !== undefined) tabVideo.delete(tabId);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }

      return false;
    },
  );

  /* -------------------------------------------------------------- *
   * 供侧边栏查询：已缓存的视频信息
   * -------------------------------------------------------------- */

  browser.runtime.onMessage.addListener(
    (
      msg: { __target?: string; type?: string; tabId?: number },
      _sender,
      sendResponse: (r: unknown) => void,
    ) => {
      if (msg?.__target !== 'background-api') return undefined;

      if (msg.type === 'getTabVideo') {
        const id = msg.tabId;
        sendResponse({ ok: true, data: id === undefined ? null : (tabVideo.get(id) ?? null) });
        return false;
      }

      return false;
    },
  );

  console.info('[BiliLens] service worker 已启动');
});
