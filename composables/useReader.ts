/**
 * composables/useReader.ts —— 面板的逻辑中枢
 *
 * 面板里有两个功能页，共享同一份「视频材料」：
 *   · 目录（笔记）：把字幕压成带时间戳的结构化笔记，一次性产物
 *   · 聊天：带着同一份字幕回答追问
 *
 * 【为什么材料要共享】
 * 聊天不需要先生成笔记，但同样需要字幕。若各自去采集，
 * 在聊天里问第一句话就要重新抓一次字幕（慢，且毫无必要）。
 * 因此 collect() 的结果按视频缓存在内存里，两个功能页共用。
 *
 * 【为什么 LLM 调用放在侧边栏】
 * MV3 的 Service Worker 约 30 秒空闲就被回收，
 * 长视频的流式生成放在那里会被拦腰截断。
 * 侧边栏是有 DOM 的扩展页面，生命周期跟随用户可见状态。
 */

import { computed, shallowRef } from 'vue';

import {
  getActiveProfile,
  newProfileId,
  type ChatImage,
  type CollectResult,
  type Conclusion,
  type Settings,
  type SubtitleSegment,
  type TokenUsage,
  type VideoInfo,
} from '@/lib/types';
import {
  buildChatMessages,
  buildNoteMessages,
  streamChat,
  LlmError,
  type ChatMessage,
  type ChatTurn,
} from '@/lib/llm';
import { fmtTokens } from '@/lib/time';
import {
  chatTitleFromTurns,
  getCachedNote,
  getChat,
  putCachedNote,
  putChat,
  type StoredChatSession,
} from '@/lib/storage';
import { extractSections, tidyStreamingMarkdown } from '@/lib/markdown';
import { askContent, getActiveTab, isBilibiliVideoUrl } from './useBridge';

export type Phase = 'idle' | 'loading' | 'collecting' | 'generating' | 'done' | 'error';

/** 聊天里的一条消息 */
export interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
  /**
   * 这一轮附带的图片。
   *
   * 只活在内存里：图片是 base64，一张就几百 KB，
   * chrome.storage.local 的配额约 10 MB，而聊天要存 30 个视频，
   * 落盘必然爆配额。重载后这些字段就没了，界面上会说明。
   */
  images?: ChatImage[];
  /** 这一轮原本有图，但重载后已经丢了（显示占位，别让用户以为图还在） */
  imagesLost?: boolean;
  /** 生成中（末尾显示光标） */
  streaming?: boolean;
  /** 模型的思考过程（思维链）。只活在内存里，与图片一样不落盘 */
  reasoning?: string;
  /** 这轮回答的 token 用量（端点给了才有）。同样不落盘 */
  usage?: TokenUsage;
  /** 出错时的提示 */
  error?: string;
}

export interface ReaderState {
  phase: Phase;
  info: VideoInfo | null;
  conclusion: Conclusion | null;
  subtitleCount: number;
  subtitleSource: string;
  /** 笔记的 Markdown */
  markdown: string;
  error: string;
  status: string;
  model: string;
}

/** 采集到的素材，两个功能页共用 */
interface Material {
  info: VideoInfo;
  conclusion: Conclusion;
  subtitle: SubtitleSegment[];
  subtitleSource: string;
}

export function useReader() {
  const state = shallowRef<ReaderState>({
    phase: 'idle',
    info: null,
    conclusion: null,
    subtitleCount: 0,
    subtitleSource: '',
    markdown: '',
    error: '',
    status: '',
    model: '',
  });

  /** 聊天记录 */
  const chat = shallowRef<ChatBubble[]>([]);
  /**
   * 当前视频的对话列表与活动对话。
   *
   * chat 始终是活动对话的气泡视图；切换对话 = 换一份气泡，
   * 会话本体（含标题、轮次）保存在 chatSessions 里并落盘。
   */
  const chatSessions = shallowRef<StoredChatSession[]>([]);
  const activeChatId = shallowRef('');
  /** 聊天是否正在生成 */
  const chatBusy = shallowRef(false);
  /** 采集素材是否正在进行（聊天首次提问时会触发） */
  const chatStatus = shallowRef('');

  /** 当前视频的播放位置（秒），由 UI 定时刷新 */
  const playhead = shallowRef<number | null>(null);

  let noteController: AbortController | null = null;
  let chatController: AbortController | null = null;
  let inFlightMaterial: Promise<Material> | null = null;
  let tabId: number | null = null;
  let boundTabId: number | null = null;
  let currentKey: string | null = null;

  /**
   * 素材缓存：key 为 `bvid:cid`。
   *
   * 只缓存当前这一个视频——面板一次只看一个视频，
   * 缓存更多只会占内存。切换视频时直接替换。
   */
  let materialCache: { key: string; data: Material } | null = null;

  const sections = computed(() => extractSections(state.value.markdown));

  const renderableMarkdown = computed(() =>
    state.value.phase === 'generating'
      ? tidyStreamingMarkdown(state.value.markdown)
      : state.value.markdown,
  );

  const isBusy = computed(
    () => state.value.phase === 'collecting' || state.value.phase === 'generating',
  );

  function patch(p: Partial<ReaderState>): void {
    state.value = { ...state.value, ...p };
  }

  /* ---------------------------------------------------------------- *
   * 初始化
   * ---------------------------------------------------------------- */

  async function init(settings: Settings): Promise<void> {
    patch({ phase: 'loading', error: '', status: '正在读取当前页面…' });

    const tab = await getActiveTab();
    const activeTabId = tab?.id;
    if (activeTabId === undefined) {
      patch({ phase: 'error', error: '未找到活动标签页' });
      return;
    }
    tabId = activeTabId;
    boundTabId = activeTabId;

    if (!isBilibiliVideoUrl(tab?.url)) {
      currentKey = null;
      clearAll();
      return;
    }

    await loadVideo(activeTabId, settings);
  }

  function clearAll(): void {
    patch({
      phase: 'idle',
      info: null,
      markdown: '',
      conclusion: null,
      subtitleCount: 0,
      subtitleSource: '',
      status: '',
      error: '',
    });
    chat.value = [];
    chatSessions.value = [];
    activeChatId.value = '';
    chatStatus.value = '';
    materialCache = null;
    inFlightMaterial = null;
    noteController?.abort();
    chatController?.abort();
    noteController = null;
    chatController = null;
  }

  async function loadVideo(activeTabId: number, settings: Settings, force = false): Promise<void> {
    try {
      const info = await askContent(activeTabId, 'videoInfo', undefined, 20_000);
      const key = `${info.bvid}:${info.cid}`;

      if (!force && key === currentKey) return;
      currentKey = key;

      // 换了视频：清空上一条笔记与聊天，避免张冠李戴
      patch({
        phase: 'idle',
        info,
        markdown: '',
        conclusion: null,
        subtitleCount: 0,
        subtitleSource: '',
        error: '',
        status: '',
        model: '',
      });
      chat.value = [];
      chatSessions.value = [];
      activeChatId.value = '';
      chatStatus.value = '';
      materialCache = null;
      inFlightMaterial = null;
      noteController?.abort();
      chatController?.abort();
      noteController = null;
      chatController = null;

      // 笔记命中缓存则直接展示，省一次模型调用
      const cached = await getCachedNote(info.bvid, info.cid);
      if (cached) {
        patch({
          phase: 'done',
          markdown: cached.markdown,
          model: cached.model,
          status: `已载入上次结果（${new Date(cached.createdAt).toLocaleString()}）`,
        });
      } else if (settings.autoRun) {
        void runNote(settings);
      }

      // 聊天记录独立于笔记，恢复出来
      const stored = await getChat(info.bvid, info.cid);
      chatSessions.value = stored?.sessions ?? [];
      activeChatId.value = stored?.activeId ?? '';
      chat.value = stored ? bubblesOfTurns(activeTurns(stored)) : [];
    } catch (e) {
      patch({
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
        status: '',
      });
    }
  }

  let pendingSync = false;

  /**
   * 响应标签页切换 / URL 变化。
   *
   * 只有「活动标签页 == 本面板绑定的标签页」时才处理：
   * 本面板被藏起来时仍在运行，会收到属于别的面板的事件，
   * 跟着走就会串台。
   */
  async function sync(settings: Settings): Promise<void> {
    if (isBusy.value || chatBusy.value) {
      pendingSync = true;
      return;
    }

    const tab = await getActiveTab();
    const activeTabId = tab?.id;
    if (activeTabId === undefined) return;

    if (boundTabId !== null && activeTabId !== boundTabId) return;
    if (boundTabId === null) boundTabId = activeTabId;

    if (!isBilibiliVideoUrl(tab?.url)) {
      if (currentKey !== null) {
        currentKey = null;
        tabId = null;
        clearAll();
      }
      return;
    }

    tabId = activeTabId;
    await loadVideo(activeTabId, settings);
  }

  async function flushPendingSync(settings: Settings): Promise<void> {
    if (!pendingSync) return;
    pendingSync = false;
    await sync(settings);
  }

  /* ---------------------------------------------------------------- *
   * 采集素材（两个功能页共用）
   * ---------------------------------------------------------------- */

  function requireTab(): number {
    const id = tabId;
    if (id === null) throw new Error('未定位到目标标签页');
    return id;
  }

  /** 采集素材；命中内存缓存则直接返回，并在并发调用时复用进行中的 Promise */
  async function ensureMaterial(statusCb?: (s: string) => void): Promise<Material> {
    const info = state.value.info;
    if (info) {
      const key = `${info.bvid}:${info.cid}`;
      if (materialCache && materialCache.key === key) return materialCache.data;
    }

    if (inFlightMaterial) {
      statusCb?.('正在获取素材…');
      return inFlightMaterial;
    }

    inFlightMaterial = (async () => {
      try {
        const id = requireTab();
        statusCb?.('正在获取官方 AI 总结与字幕…');

        const res: CollectResult = await askContent(id, 'collect', undefined, 60_000);
        const { info: fresh, conclusion, subtitles } = res;
        const key = `${fresh.bvid}:${fresh.cid}`;

        // 优先用官方 AI 总结自带的全文字幕（免费且即时）
        if (conclusion.available && conclusion.subtitle.length > 0) {
          const data: Material = {
            info: fresh,
            conclusion,
            subtitle: conclusion.subtitle,
            subtitleSource: `B站官方 AI 字幕 · ${conclusion.subtitle.length} 条`,
          };
          materialCache = { key, data };
          return data;
        }

        // 其次用字幕轨（人工字幕优先，其次 AI 字幕）
        if (subtitles.list.length > 0) {
          statusCb?.('正在下载字幕…');
          const sorted = [...subtitles.list].sort((a, b) => (a.isAi ? 1 : 0) - (b.isAi ? 1 : 0));

          for (const track of sorted) {
            try {
              const body = await askContent(id, 'fetchSubtitleBody', { url: track.url }, 30_000);
              if (body.length > 0) {
                const data: Material = {
                  info: fresh,
                  conclusion,
                  subtitle: body,
                  subtitleSource: `${track.lanDoc || track.lan} · ${body.length} 条`,
                };
                materialCache = { key, data };
                return data;
              }
            } catch {
              /* 换下一条字幕轨 */
            }
          }
        }

        const hint =
          subtitles.error ?? (conclusion.available ? '' : conclusion.reason) ?? '未知原因';

        throw new Error(
          `这个视频没有可用的字幕或官方总结（${hint}）。` +
            `目前可直接处理的视频约占七成，剩余视频需要本地语音转写（规划中）。`,
        );
      } finally {
        inFlightMaterial = null;
      }
    })();

    return inFlightMaterial;
  }

  /** 把 Material 转成 buildXxxMessages 需要的形状 */
  function toPayload(m: Material) {
    return {
      info: {
        title: m.info.title,
        upName: m.info.upName,
        duration: m.info.duration,
        bvid: m.info.bvid,
        desc: m.info.desc,
        pageIndex: m.info.pageIndex,
      },
      conclusion: m.conclusion.available
        ? {
            available: true,
            summary: m.conclusion.summary,
            outline: m.conclusion.outline,
          }
        : { available: false },
      subtitle: m.subtitle.map((s) => ({ from: s.from, content: s.content })),
    };
  }

  /* ---------------------------------------------------------------- *
   * 目录：生成笔记
   * ---------------------------------------------------------------- */

  async function runNote(settings: Settings): Promise<void> {
    if (tabId === null) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        patch({ phase: 'error', error: '未找到活动标签页' });
        return;
      }
      tabId = tab.id;
    }

    const cfg = getActiveProfile(settings);
    if (!cfg?.baseURL || !cfg.model) {
      patch({
        phase: 'error',
        error: '尚未配置大模型，请点击右上角「设置」填写 API 地址与模型名。',
      });
      return;
    }

    noteController?.abort();
    noteController = new AbortController();

    try {
      patch({
        phase: 'collecting',
        markdown: '',
        error: '',
        status: '正在获取素材…',
        subtitleCount: 0,
        subtitleSource: '',
      });

      const material = await ensureMaterial((s) => patch({ status: s }));
      currentKey = `${material.info.bvid}:${material.info.cid}`;

      patch({
        phase: 'generating',
        info: material.info,
        conclusion: material.conclusion,
        subtitleCount: material.subtitle.length,
        subtitleSource: material.subtitleSource,
        model: cfg.model,
        status: `已取得 ${material.subtitleSource}，正在生成笔记…`,
      });

      const messages = buildNoteMessages(toPayload(material));

      let acc = '';
      // 用对象包一层：TS 无法追踪「回调里给 let 赋值」的控制流
      const gotUsage: { current: TokenUsage | null } = { current: null };
      const full = await streamChat(cfg, messages, {
        signal: noteController.signal,
        onDelta: (delta) => {
          acc += delta;
          // 每 40 字符刷一次，兼顾流畅与渲染开销
          if (acc.length % 40 < delta.length) patch({ markdown: acc });
        },
        onUsage: (u) => (gotUsage.current = u),
      });

      const usage = gotUsage.current;
      const finalText = full || acc;
      patch({
        phase: 'done',
        markdown: finalText,
        status: usage
          ? `完成 · 输入 ${fmtTokens(usage.promptTokens)} · 输出 ${fmtTokens(usage.completionTokens)} tokens`
          : '完成',
      });

      await putCachedNote({
        bvid: material.info.bvid,
        cid: material.info.cid,
        title: material.info.title,
        upName: material.info.upName,
        markdown: finalText,
        createdAt: Date.now(),
        model: cfg.model,
      });
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        patch({ phase: 'done', status: '已停止生成' });
        return;
      }
      patch({ phase: 'error', error: errText(e), status: '' });
    } finally {
      noteController = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * 聊天
   * ---------------------------------------------------------------- */

  /** 落盘的轮次 → 气泡（图片本体不落盘，只留「已不再保留」标记） */
  function bubblesOfTurns(
    turns: Array<{ role: 'user' | 'assistant'; content: string; hadImages?: boolean }>,
  ): ChatBubble[] {
    return turns.map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.hadImages ? { imagesLost: true } : {}),
    }));
  }

  /** 气泡 → 落盘的轮次。错误气泡与正在流式的尾巴都不算 */
  function turnsOfBubbles(bubbles: ChatBubble[]): StoredChatSession['turns'] {
    return bubbles
      .filter((b) => !b.error && !b.streaming)
      .map((b) => ({
        role: b.role,
        content: b.content,
        ...(b.images?.length ? ({ hadImages: true } as const) : {}),
      }));
  }

  function sessionById(id: string): StoredChatSession | null {
    return chatSessions.value.find((s) => s.id === id) ?? null;
  }

  function activeTurns(stored: { sessions: StoredChatSession[]; activeId: string }): StoredChatSession['turns'] {
    return stored.sessions.find((s) => s.id === stored.activeId)?.turns ?? [];
  }

  function freshSession(): StoredChatSession {
    const now = Date.now();
    return { id: newProfileId(), title: '新对话', turns: [], createdAt: now, updatedAt: now };
  }

  /**
   * 把当前气泡写进活动会话并落盘。
   *
   * 活动会话不存在时（首次发言 / 上一个被删光）在这里补建——
   * 点「＋新建」先切到空视图，真正落盘推迟到第一句话说出口，
   * 避免存下一堆没人说话的空对话。
   */
  async function persistChat(bvid: string, cid: number): Promise<void> {
    const turns = turnsOfBubbles(chat.value);

    let sessions = chatSessions.value;
    let id = activeChatId.value;
    if (!id || !sessionById(id)) {
      const s = freshSession();
      sessions = [s, ...sessions];
      id = s.id;
      activeChatId.value = id;
      chatSessions.value = sessions;
    }

    chatSessions.value = sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            // 标题只在会话还空着时生成一次，之后保持稳定
            title: s.turns.length === 0 ? chatTitleFromTurns(turns) : s.title,
            turns,
            updatedAt: Date.now(),
          }
        : s,
    );
    // 丢弃从未发言的草稿对话，与落盘规则保持一致，免得下拉里堆「新对话（0 条）」
    chatSessions.value = chatSessions.value.filter((s) => s.id === id || s.turns.length > 0);
    await putChat(bvid, cid, chatSessions.value, activeChatId.value);
  }

  /** 新建一个对话并切换过去（空对话要等第一句话发出才落盘） */
  function newChatSession(): void {
    if (chatBusy.value) return;
    const s = freshSession();
    chatSessions.value = [s, ...chatSessions.value];
    activeChatId.value = s.id;
    chat.value = [];
    chatStatus.value = '';
  }

  /** 切换到另一个对话。切换前先把当前对话落盘，防止丢未保存的状态 */
  async function switchChatSession(id: string): Promise<void> {
    if (chatBusy.value || id === activeChatId.value) return;
    const target = sessionById(id);
    if (!target) return;

    const info = state.value.info;
    if (info && activeChatId.value && sessionById(activeChatId.value)) {
      await persistChat(info.bvid, info.cid).catch(() => undefined);
    }
    activeChatId.value = id;
    chat.value = bubblesOfTurns(target.turns);
  }

  /** 删除一个对话；删的是当前对话时就地切到剩下的第一个（或空态） */
  async function deleteChatSession(id: string): Promise<void> {
    if (chatBusy.value) return;
    const rest = chatSessions.value.filter((s) => s.id !== id);
    chatSessions.value = rest;
    if (activeChatId.value === id) {
      activeChatId.value = rest[0]?.id ?? '';
      chat.value = rest[0] ? bubblesOfTurns(rest[0].turns) : [];
    }
    const info = state.value.info;
    if (info) {
      await putChat(info.bvid, info.cid, rest, activeChatId.value).catch(() => undefined);
    }
  }

  /**
   * 发一条消息并等待回复。
   *
   * 不需要先生成笔记：素材是独立采集的，因此可以直接开聊。
   * 代价是第一条消息会多等几秒（在抓字幕），界面上会说明。
   */
  async function sendChat(
    settings: Settings,
    text: string,
    images: ChatImage[] = [],
  ): Promise<void> {
    const content = text.trim();
    // 只有图片没有文字也是合法的一轮（用户常直接贴图问「这是什么」）
    if ((!content && images.length === 0) || chatBusy.value) return;

    const cfg = getActiveProfile(settings);
    if (!cfg?.baseURL || !cfg.model) {
      chat.value = [
        ...chat.value,
        { role: 'user', content, ...(images.length ? { images } : {}) },
        { role: 'assistant', content: '', error: '尚未配置大模型，请先到「设置」填写 API 地址与模型名。' },
      ];
      return;
    }

    /*
     * 图片是明确选择的能力，不做「猜模型支持不支持」——
     * 猜错就是把整轮请求打成 400，用户只会看到「请求失败」。
     * 与其静默失败，不如在这里拦住并说清楚去哪儿打开。
     */
    if (images.length > 0 && !cfg.supportsVision) {
      chat.value = [
        ...chat.value,
        { role: 'user', content, images },
        {
          role: 'assistant',
          content: '',
          error:
            `当前模型「${cfg.model}」在设置里没有开启图像输入。\n` +
            '如果这个模型确实支持看图，请到「设置 → 大模型 → 当前配置」打开「支持图像输入」，再重新发送。',
        },
      ];
      return;
    }

    chat.value = [...chat.value, { role: 'user', content, ...(images.length ? { images } : {}) }];
    chatBusy.value = true;
    chatStatus.value = '';

    chatController?.abort();
    chatController = new AbortController();

    const info = state.value.info;
    const chatKey = info ? `${info.bvid}:${info.cid}` : null;

    try {
      // 第一次提问时这里会真的去抓字幕，之后都命中内存缓存
      const material = await ensureMaterial((s) => (chatStatus.value = s));

      chatStatus.value = '正在思考…';

      patch({
        info: material.info,
        conclusion: material.conclusion,
        subtitleCount: material.subtitle.length,
        subtitleSource: material.subtitleSource,
      });

      // 历史里只保留已完成的消息，当前这条由 buildChatMessages 附加
      const history: ChatTurn[] = chat.value
        .filter((b) => !b.error)
        .map((b) => ({
          role: b.role,
          content: b.content,
          ...(b.images?.length ? { images: b.images } : {}),
        }));

      const messages: ChatMessage[] = buildChatMessages(toPayload(material), history, {
        playhead: settings.sendPlayhead ? playhead.value : null,
      });

      // 先放一个空的助手气泡，流式往里填
      chat.value = [...chat.value, { role: 'assistant', content: '', streaming: true }];
      const idx = chat.value.length - 1;

      let acc = '';
      let reasoningAcc = '';
      const gotUsage: { current: TokenUsage | null } = { current: null };
      const full = await streamChat(cfg, messages, {
        signal: chatController.signal,
        onDelta: (delta) => {
          acc += delta;
          if (acc.length % 30 < delta.length) {
            const next = [...chat.value];
            const cur = next[idx];
            if (cur) next[idx] = { ...cur, content: acc };
            chat.value = next;
          }
        },
        onReasoning: (r) => {
          reasoningAcc += r;
          // 思考可能很长，同样节流刷新
          if (reasoningAcc.length % 120 < r.length) {
            const next = [...chat.value];
            const cur = next[idx];
            if (cur) next[idx] = { ...cur, reasoning: reasoningAcc };
            chat.value = next;
          }
        },
        onUsage: (u) => (gotUsage.current = u),
      });

      const finalText = full || acc;
      const usage = gotUsage.current;
      const next = [...chat.value];
      const cur = next[idx];
      if (cur) {
        next[idx] = {
          role: 'assistant',
          content: finalText,
          // 思考过程与用量只留在内存里，刷新后随「图片已不再保留」一样消失
          ...(reasoningAcc ? { reasoning: reasoningAcc } : {}),
          ...(usage ? { usage } : {}),
        };
      }
      chat.value = next;

      // 存下来，关掉面板再打开还在
      if (chatKey) {
        await persistChat(material.info.bvid, material.info.cid);
      }
    } catch (e: unknown) {
      // 去掉那个空的流式气泡，改成错误提示
      const cleaned = chat.value.filter((b) => !b.streaming);
      if (e instanceof DOMException && e.name === 'AbortError') {
        chat.value = cleaned;
      } else {
        chat.value = [...cleaned, { role: 'assistant', content: '', error: errText(e) }];
      }
    } finally {
      chatBusy.value = false;
      chatStatus.value = '';
      chatController = null;
    }
  }

  /**
   * 清空聊天 = 删掉当前这个对话。
   *
   * 只影响活动对话，其他对话不受影响；删空后再发言会自动建新对话。
   */
  async function clearChatHistory(): Promise<void> {
    const id = activeChatId.value;
    if (id) {
      await deleteChatSession(id);
      return;
    }
    chat.value = [];
  }

  function stopNote(): void {
    noteController?.abort();
    noteController = null;
  }

  function stopChat(): void {
    chatController?.abort();
    chatController = null;
  }

  function stop(target?: 'note' | 'chat'): void {
    if (target === 'note') {
      stopNote();
    } else if (target === 'chat') {
      stopChat();
    } else {
      stopNote();
      stopChat();
    }
  }

  return {
    state,
    chat,
    chatSessions,
    activeChatId,
    chatBusy,
    chatStatus,
    playhead,
    sections,
    renderableMarkdown,
    isBusy,
    init,
    runNote,
    sendChat,
    newChatSession,
    switchChatSession,
    deleteChatSession,
    clearChatHistory,
    stop,
    stopNote,
    stopChat,
    sync,
    flushPendingSync,
    getTabId: () => tabId,
  };
}

function errText(e: unknown): string {
  if (e instanceof LlmError) return [e.message, e.detail].filter(Boolean).join('\n');
  return e instanceof Error ? e.message : String(e);
}
