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
  type ErrorCategory,
  type Settings,
  type SubtitleSegment,
  type TokenUsage,
  type VideoInfo,
} from '@/lib/types';
import {
  buildChatMessages,
  buildNoteMessages,
  getProviderLabel,
  isLocalEndpoint,
  streamChat,
  LlmError,
  type ChatMessage,
  type ChatTurn,
} from '@/lib/llm';
import { fmtTokens } from '@/lib/time';
import { requestAsrTranscription, AsrError, getEndpointPort } from '@/lib/asr';
import {
  chatTitleFromTurns,
  getCachedNote,
  getChat,
  loadSettings,
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
  errorTitle?: string;
  errorCategory?: ErrorCategory | null;
  status: string;
  progressPercent?: number | null;
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
    errorTitle: '',
    errorCategory: null,
    status: '',
    progressPercent: null,
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
    patch({ phase: 'loading', error: '', errorTitle: '', errorCategory: null, status: '正在读取当前页面…' });

    const tab = await getActiveTab();
    const activeTabId = tab?.id;
    if (activeTabId === undefined) {
      patch({ phase: 'error', errorTitle: '未找到活动标签页', errorCategory: 'generic', error: '未找到活动标签页' });
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
      errorTitle: '',
      errorCategory: null,
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
        errorTitle: '',
        errorCategory: null,
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

      /*
       * 预取官方总结（元信息），让顶部状态与字幕下载按钮打开即准确——
       * 否则 conclusion/subtitleCount 在用户第一次发起笔记或聊天之前
       * 一直是空值，头部会误报「无可用字幕」。
       * 失败静默：后续动作触发的采集仍会拿到，界面不下错结论即可。
       */
      void askContent(
        activeTabId,
        'aiConclusion',
        { aid: info.aid, bvid: info.bvid, cid: info.cid, upMid: info.upMid },
        15_000,
      )
        .then((conclusion) => {
          if (currentKey !== key) return; // 期间已切到别的视频
          patch({
            conclusion,
            // 只在还没人填过时用官方字幕条数兜底，不覆盖字幕轨来源的计数
            subtitleCount:
              conclusion.available && state.value.subtitleCount === 0
                ? conclusion.subtitle.length
                : state.value.subtitleCount,
          });
        })
        .catch(() => undefined);

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

        // 兜底：若开启了本地 ASR，自动发起转写
        const currentSettings = await loadSettings();
        const asrConfig = currentSettings.localAsr;
        if (asrConfig?.enabled && asrConfig.endpoint) {
          const asrProgress = (msg: string, percent?: number) => {
            patch({
              status: msg,
              progressPercent: typeof percent === 'number' ? percent : null,
            });
            statusCb?.(msg);
          };
          asrProgress('未找到官方字幕，正在通过本地 ASR 转写音轨…', 0);
          try {
            const segments = await requestAsrTranscription(
              asrConfig.endpoint,
              {
                bvid: fresh.bvid,
                cid: fresh.cid,
                audioUrl: res.audioUrl ?? undefined,
              },
              asrProgress,
              asrConfig.timeoutSeconds,
            );
            patch({ progressPercent: null });
            if (segments.length > 0) {
              const data: Material = {
                info: fresh,
                conclusion,
                subtitle: segments,
                subtitleSource: `本地 ASR 转写 · ${segments.length} 条`,
              };
              materialCache = { key, data };
              return data;
            }
          } catch (asrErr) {
            patch({ progressPercent: null });
            console.warn('[useReader] 本地 ASR 转写失败，回退到报错提示:', asrErr);
            throw asrErr;
          }
        }

        throw new Error(
          `这个视频没有可用的字幕或官方总结（${hint}）。` +
            `如需处理无字幕视频，请在设置中开启本地 ASR 服务。`,
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
        patch({ phase: 'error', errorTitle: '未找到活动标签页', errorCategory: 'generic', error: '未找到活动标签页' });
        return;
      }
      tabId = tab.id;
    }

    const cfg = getActiveProfile(settings);
    if (!cfg?.baseURL || !cfg.model.trim()) {
      patch({
        phase: 'error',
        errorCategory: 'model_not_configured',
        errorTitle: '大模型未配置',
        error: '尚未配置大模型。精读笔记与智能问答均需大模型驱动，请点击下方「前往设置」选择服务商并填写模型信息。',
        status: '',
      });
      return;
    }

    const isCloud = cfg.provider && cfg.provider !== 'ollama' && cfg.provider !== 'custom';
    if (isCloud && !cfg.apiKey.trim()) {
      patch({
        phase: 'error',
        errorCategory: 'model_not_configured',
        errorTitle: '未配置 API Key',
        error: `当前所选服务商「${getProviderLabel(cfg.provider)}」尚未配置 API Key。请点击下方「前往设置」填写密钥后再使用。`,
        status: '',
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
        errorTitle: '',
        errorCategory: null,
        status: '正在获取素材…',
        subtitleCount: 0,
        subtitleSource: '',
      });

      let material: Material;
      try {
        material = await ensureMaterial((s) => patch({ status: s }));
      } catch (materialErr) {
        if (materialErr instanceof DOMException && materialErr.name === 'AbortError') {
          patch({ phase: 'done', status: '已停止' });
          return;
        }

        if (materialErr instanceof AsrError) {
          if (materialErr.code === 'ASR_NOT_STARTED') {
            const asrPort = getEndpointPort(settings.localAsr?.endpoint || '');
            patch({
              phase: 'error',
              errorCategory: 'asr_not_started',
              errorTitle: '本地 ASR 服务未开启',
              error: `${materialErr.message}\n\n💡 操作指引：请在本地运行 start-server.ps1 启动服务（确保 ${asrPort} 端口正常在线），开启后再点击下方「重试」。`,
              status: '',
            });
            return;
          }
          if (materialErr.code === 'ASR_TIMEOUT') {
            patch({
              phase: 'error',
              errorCategory: 'asr_error',
              errorTitle: '本地 ASR 转写超时',
              error: materialErr.message,
              status: '',
            });
            return;
          }
          patch({
            phase: 'error',
            errorCategory: 'asr_error',
            errorTitle: '本地 ASR 转写异常',
            error: materialErr.message,
            status: '',
          });
          return;
        }

        patch({
          phase: 'error',
          errorCategory: 'no_subtitle',
          errorTitle: '该视频无可用字幕',
          error: errText(materialErr),
          status: '',
        });
        return;
      }

      currentKey = `${material.info.bvid}:${material.info.cid}`;

      patch({
        phase: 'generating',
        info: material.info,
        conclusion: material.conclusion,
        subtitleCount: material.subtitle.length,
        subtitleSource: material.subtitleSource,
        model: cfg.model,
        status: `已成功同步 ${material.subtitleSource}，正在通过大模型生成笔记…`,
      });

      try {
        const messages = buildNoteMessages(toPayload(material), {
          contextWindow: cfg.contextWindow,
          maxTokens: cfg.maxTokens,
        });

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
      } catch (llmErr) {
        if (llmErr instanceof DOMException && llmErr.name === 'AbortError') {
          patch({ phase: 'done', status: '已停止生成' });
          return;
        }

        let cat: ErrorCategory = 'provider_error';
        let title = '大模型服务商异常';
        let advice = '请前往服务商控制台核查服务运行状态、API Key 是否有效及账户可用余额。';

        if (llmErr instanceof LlmError) {
          if (llmErr.code === 'NOT_CONFIGURED') {
            cat = 'model_not_configured';
            title = '大模型未配置';
            advice = '请点击下方「前往设置」填写模型服务商及密钥。';
          } else if (llmErr.code === 'NETWORK_ERROR') {
            title = isLocalEndpoint(cfg.baseURL) ? '本地模型服务未开启' : '大模型服务商无法连接';
            advice = isLocalEndpoint(cfg.baseURL)
              ? '请确认本地大模型程序（如 Ollama / LM Studio 等）已启动并正在监听对应端口。'
              : '请排查本地网络、代理或大模型服务商官方服务器可用性。';
          } else if (llmErr.code === 'AUTH_ERROR') {
            title = '大模型鉴权失败';
            advice = 'API Key 无效、已过期或余额不足，请前往「设置」检查您的 API Key 并核实账户。';
          } else if (llmErr.code === 'RATE_LIMIT') {
            title = '大模型请求限流 (429)';
            advice = '触发服务商速率限制或配额已耗尽，请稍后再试或前往服务商平台查询。';
          } else if (llmErr.code === 'SERVER_ERROR') {
            title = '大模型服务商故障 (5xx)';
            advice = '服务商服务器出现临时故障或过载，建议稍后重试或在设置中切换为其他服务商。';
          } else if (llmErr.code === 'NOT_FOUND') {
            title = '大模型端点错误 (404)';
            advice = '请在设置中检查 API 地址，确认是否多写或缺少了 /v1 等版本路径。';
          }
        }

        patch({
          phase: 'error',
          errorCategory: cat,
          errorTitle: title,
          error: `字幕已转写就绪（共 ${material.subtitle.length} 条），但连接大模型失败：\n${errText(llmErr)}\n\n💡 排查建议：${advice}`,
          status: '',
        });
      }
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
    if (!cfg?.baseURL || !cfg.model.trim()) {
      chat.value = [
        ...chat.value,
        { role: 'user', content, ...(images.length ? { images } : {}) },
        {
          role: 'assistant',
          content: '',
          error: '【大模型未配置】尚未配置大模型。请点击右上角「设置」选择服务商并填写模型信息。',
        },
      ];
      return;
    }

    const isCloud = cfg.provider && cfg.provider !== 'ollama' && cfg.provider !== 'custom';
    if (isCloud && !cfg.apiKey.trim()) {
      chat.value = [
        ...chat.value,
        { role: 'user', content, ...(images.length ? { images } : {}) },
        {
          role: 'assistant',
          content: '',
          error: `【未配置 API Key】当前服务商「${getProviderLabel(cfg.provider)}」尚未填写 API Key，请先前往「设置」配置密钥后再提问。`,
        },
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
        contextWindow: cfg?.contextWindow,
        maxTokens: cfg?.maxTokens,
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
      // 去掉那个空的流式气泡，改成分类错误提示
      const cleaned = chat.value.filter((b) => !b.streaming);
      if (e instanceof DOMException && e.name === 'AbortError') {
        chat.value = cleaned;
      } else {
        let prefix = '【大模型调用失败】';
        let tip = '';
        if (e instanceof LlmError) {
          if (e.code === 'NOT_CONFIGURED') {
            prefix = '【大模型未配置】';
            tip = '\n💡 请前往右上角「设置」配置模型参数与 API Key。';
          } else if (e.code === 'NETWORK_ERROR') {
            prefix = isLocalEndpoint(cfg?.baseURL ?? '') ? '【本地模型服务未开启】' : '【大模型服务商无法连接】';
            tip = isLocalEndpoint(cfg?.baseURL ?? '')
              ? '\n💡 请检查本地模型服务（如 Ollama / LM Studio）是否已启动并正在监听该端口。'
              : '\n💡 请排查本地网络、代理设置或服务商平台运行状态。';
          } else if (e.code === 'AUTH_ERROR') {
            prefix = '【大模型鉴权失败】';
            tip = '\n💡 请前往「设置」核对 API Key 是否有效或账户余额是否充足。';
          } else if (e.code === 'RATE_LIMIT') {
            prefix = '【大模型请求限流】';
            tip = '\n💡 触发服务商频率或额度限制，请稍后重试。';
          } else if (e.code === 'SERVER_ERROR') {
            prefix = '【大模型服务商故障】';
            tip = '\n💡 服务商服务器异常，请稍后重试或切换其他服务商。';
          } else if (e.code === 'NOT_FOUND') {
            prefix = '【大模型端点错误 (404)】';
            tip = '\n💡 请在设置中检查 API 地址是否有误（是否多写或少写了 /v1）。';
          }
        } else if (e instanceof AsrError) {
          if (e.code === 'ASR_NOT_STARTED') {
            const asrPort = getEndpointPort(settings.localAsr?.endpoint || '');
            prefix = '【本地 ASR 服务未开启】';
            tip = `\n💡 请运行 start-server.ps1 启动本地语音识别服务（确保 ${asrPort} 端口正常在线）。`;
          } else {
            prefix = '【本地 ASR 转写异常】';
          }
        }
        chat.value = [...cleaned, { role: 'assistant', content: '', error: `${prefix}\n${errText(e)}${tip}` }];
      }
    } finally {
      chatBusy.value = false;
      chatStatus.value = '';
      chatController = null;
    }
  }

  /**
   * 供字幕导出用的字幕段。
   *
   * 命中素材缓存时零开销；未采集过会触发一次采集（与目录/聊天共享
   * inFlightMaterial 去重）。失败返回 null，由 UI 静默收场。
   */
  async function getSubtitles(): Promise<SubtitleSegment[] | null> {
    try {
      const m = await ensureMaterial();
      return m.subtitle;
    } catch {
      return null;
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
    getSubtitles,
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
