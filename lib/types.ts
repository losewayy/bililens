/**
 * lib/types.ts —— 领域模型与消息协议
 *
 * 这里定义全项目共享的类型。所有跨上下文通信都在此收口，
 * 因此编译期就能发现「某一端改了字段名、另一段没跟上」这类错误。
 */

/* ================================================================== *
 * 一、B站领域模型
 * ================================================================== */

/** 分P信息（多P视频） */
export interface PageInfo {
  cid: number;
  /** 第几个分P，从 1 开始 */
  page: number;
  /** 分P标题 */
  part: string;
  /** 时长（秒） */
  duration: number;
}

/** 视频基础信息 */
export interface VideoInfo {
  aid: number;
  bvid: string;
  /** 当前分P的 cid */
  cid: number;
  title: string;
  /** 简介，已截断 */
  desc: string;
  upName: string;
  upMid: number;
  /** 总时长（秒） */
  duration: number;
  cover: string;
  pubdate: number;
  view: number;
  like: number;
  /** 是否为番剧/影视（走 PGC 接口） */
  isBangumi: boolean;
  /** 当前是第几个分P */
  pageIndex: number;
  /** 共几个分P */
  pageCount: number;
  /** 当前分P标题 */
  partTitle: string;
}

/** 字幕分段（带时间轴，单位秒） */
export interface SubtitleSegment {
  from: number;
  to: number;
  content: string;
}

/** 一条可用字幕轨 */
export interface SubtitleTrack {
  /** 语言代码，如 zh-CN / ai-zh */
  lan: string;
  /** 语言显示名，如「中文（自动生成）」 */
  lanDoc: string;
  /** 字幕 JSON 地址 */
  url: string;
  /** 是否为 AI 生成字幕 */
  isAi: boolean;
}

/** 官方 AI 提纲中的一个要点 */
export interface OutlinePoint {
  timestamp: number;
  content: string;
}

/** 官方 AI 提纲中的一个章节 */
export interface OutlineSection {
  title: string;
  timestamp: number;
  points: OutlinePoint[];
}

/** B站官方 AI 总结接口的可用结果 */
export interface ConclusionAvailable {
  available: true;
  /** 整段摘要 */
  summary: string;
  /** 分段提纲 */
  outline: OutlineSection[];
  /** 官方识别出的 AI 字幕（固定中文） */
  subtitle: SubtitleSegment[];
  /** 0 无摘要 / 1 仅摘要 / 2 摘要+提纲 */
  resultType: number;
  like: number;
}

/** 官方 AI 总结不可用 */
export interface ConclusionUnavailable {
  available: false;
  /** 不可用原因（面向用户展示） */
  reason: string;
}

export type Conclusion = ConclusionAvailable | ConclusionUnavailable;

/** 字幕列表获取结果 */
export interface SubtitleListResult {
  list: SubtitleTrack[];
  /** 顶层错误（例如接口异常），有值时 list 通常为空 */
  error?: string;
}

/** 一次采集的完整结果 */
export interface CollectResult {
  info: VideoInfo;
  conclusion: Conclusion;
  subtitles: SubtitleListResult;
  audioUrl?: string | null;
}

/* ================================================================== *
 * 二、跨上下文消息协议
 * ================================================================== */

/** 页面桥（MAIN world）支持的动作 */
export type BridgeAction =
  | 'ping'
  | 'videoInfo'
  | 'collect'
  | 'aiConclusion'
  | 'subtitleList'
  | 'fetchSubtitleBody'
  | 'seek'
  | 'playhead'
  | 'navStatus';

/** 需要视频标识的动作的载荷 */
export interface VideoIdPayload {
  aid: number;
  bvid: string;
  cid: number;
  upMid: number;
}

/** 动作 → 载荷 / 返回值的映射，保证调用处类型正确 */
export interface BridgeContract {
  ping: { payload: undefined; result: { href: string } };
  videoInfo: { payload: undefined; result: VideoInfo };
  collect: { payload: undefined; result: CollectResult };
  aiConclusion: { payload: VideoIdPayload; result: Conclusion };
  subtitleList: { payload: VideoIdPayload; result: SubtitleListResult };
  fetchSubtitleBody: { payload: { url: string }; result: SubtitleSegment[] };
  seek: { payload: { seconds: number }; result: { ok: true } };
  /** 读取当前播放位置（秒），拿不到时为 null */
  playhead: { payload: undefined; result: { seconds: number | null } };
  navStatus: { payload: undefined; result: NavStatus };
}

export interface NavStatus {
  isLogin: boolean;
  uname: string;
  mid: number;
  vip: boolean;
}

/* --- 页面 ↔ 隔离世界（window.postMessage）--- */

export interface BridgeRequestMessage<K extends BridgeAction = BridgeAction> {
  readonly __bililens: 'req';
  readonly id: string;
  readonly type: K;
  readonly payload: BridgeContract[K]['payload'];
}

export interface BridgeResponseMessage {
  readonly __bililens: 'res';
  readonly id: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly error: string | null;
}

export interface BridgeReadyMessage {
  readonly __bililens: 'ready';
}

export type BridgeInbound = BridgeRequestMessage | BridgeReadyMessage;
export type BridgeOutbound = BridgeResponseMessage | BridgeReadyMessage;

/* --- 侧边栏 ↔ 内容脚本（chrome.tabs.sendMessage）--- */

export interface ContentScriptRequest {
  readonly __target: 'content';
  readonly type: BridgeAction;
  readonly payload: unknown;
}

export type ContentScriptResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/* --- 内容脚本 → 后台（主动上报）--- */

export interface UrlChangedMessage {
  readonly __target: 'background';
  readonly type: 'urlChanged';
  readonly href: string;
}

export interface VideoDetectedMessage {
  readonly __target: 'background';
  readonly type: 'videoDetected';
  readonly info: VideoInfo;
}

export type ContentToBackground = UrlChangedMessage | VideoDetectedMessage;

/* ================================================================== *
 * 三、设置
 * ================================================================== */

/** 侧边栏字号档位。取值定义在 lib/fontScale.ts */
export type FontScale = 'normal' | 'large' | 'xlarge' | 'huge';

export type ProviderId =
  | 'custom'
  | 'siliconflow'
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'openrouter'
  | 'openai'
  | 'ollama';

/** 面板内的功能页 */
export type PanelTab = 'note' | 'chat';

/** 落盘方式 */
export type SaveMode = 'download' | 'obsidian';

/**
 * 思考深度档位（对应请求参数 reasoning_effort）。
 *
 * 取值即网关的事实标准词表：cmdgo-bridge 的模型目录就是
 * `low, medium, high, xhigh, max`；WorkBuddy2API 会按模型支持档自动降级。
 * 空串 = 不发送该参数，模型用自己的默认思考深度。
 */
export type ReasoningEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 流式结束后拿到的 token 用量（端点愿意给才有） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 已配置的模型项（属于某个 Provider Profile）。
 * 独立记忆该模型的参数：上下文窗口、最大输出、图像支持、温度与思考深度。
 */
export interface SavedModelConfig {
  /** 稳定 id */
  id: string;
  /** 模型调用标识，如 "deepseek-chat" 或 "gpt-4o" */
  model: string;
  /** 用户自定义显示别名（可选，如 "DeepSeek V3 主力"） */
  name?: string;
  /** 上下文窗口大小（Token 数量），0 表示不限制/按默认安全基线 */
  contextWindow: number;
  /** 单次最大输出 Token，0 表示不限制 */
  maxTokens: number;
  /** 生成多样性，默认 0.3 */
  temperature: number;
  /** 思考深度档位 */
  reasoningEffort: ReasoningEffort;
  /** 是否支持图像输入（多模态） */
  supportsVision: boolean;
}

export interface LlmConfig {
  provider: ProviderId;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 0 表示不限制 */
  maxTokens: number;
  /** 上下文窗口大小（Token 数量），0 表示不限制/按默认安全基线（约 90,000 字符） */
  contextWindow: number;
  /**
   * 思考深度档位；空串不发送（见 ReasoningEffort 说明）。
   */
  reasoningEffort: ReasoningEffort;
  /**
   * 该模型是否支持图像输入（多模态）。
   *
   * 【为什么默认 false】
   * 插件无法可靠地判断某个模型是否多模态——同一个端点下不同模型的
   * 能力不同，靠模型名猜会在非多模态模型上把整轮请求打成 400。
   * 因此默认关，由用户在设置里明确打开；未打开时粘贴图片会给出
   * 明确提示，而不是把图片悄悄丢掉。
   */
  supportsVision: boolean;
}

/**
 * 一份具名的模型配置。
 *
 * 【为什么是 extends 而不是重新写一遍字段】
 * profile 本身就必须能直接当 LlmConfig 用，这样 streamChat(cfg, …)
 * 一行都不用改。多出来的只有「怎么称呼它」和「怎么引用它」。
 */
export interface LlmProfile extends LlmConfig {
  /** 稳定 id，切换与引用都靠它（不是数组下标，避免删除后错位） */
  id: string;
  /** 用户可改的显示名，默认取服务商名 */
  name: string;
  /**
   * 该配置档案（服务商账号）下保存的模型预设列表。
   * 用户可随时保存多个常用模型，并在界面上一键切换。
   */
  models?: SavedModelConfig[];
}

/** 聊天里粘贴的一张图片。只在本次会话的内存里保留，不落盘 */
export interface ChatImage {
  /** data:image/jpeg;base64,… */
  dataURL: string;
  width: number;
  height: number;
}

export interface ObsidianConfig {
  /** 是否启用目录直写 */
  enabled: boolean;
  /** 子文件夹（相对所选目录） */
  subfolder: string;
  /** 文件名模板，支持 {title} {up} {date} {bvid} */
  filenameTemplate: string;
}

export interface LocalAsrConfig {
  /** 是否在官方字幕缺失时自动启用本地 ASR 兜底 */
  enabled: boolean;
  /** 本地 ASR 服务转录接口完整 URL */
  endpoint: string;
  /** 超时上限（秒） */
  timeoutSeconds: number;
  /** 是否在无字幕时全自动转写 */
  autoFallback: boolean;
}

export interface Settings {
  /** 已保存的模型配置，可以有多份（云端 / 本地各一份等） */
  profiles: LlmProfile[];
  /** 当前使用哪一份；空串表示还没配置 */
  activeProfileId: string;
  /** 上次停留在哪个功能页 */
  tab: PanelTab;
  /** 聊天时是否附带当前播放位置 */
  sendPlayhead: boolean;
  saveMode: SaveMode;
  obsidian: ObsidianConfig;
  /** 本地 ASR 兜底配置 */
  localAsr: LocalAsrConfig;
  /** 打开视频页时是否自动开始精读 */
  autoRun: boolean;
  /** 默认总结语言 */
  language: 'zh' | 'en';
  /** 侧边栏字号档位。只影响侧边栏，不影响设置页 */
  fontScale: FontScale;
}

export const DEFAULT_SETTINGS: Settings = {
  // 首次安装没有任何配置；设置页会引导用户新建第一份
  profiles: [],
  activeProfileId: '',
  tab: 'note',
  // 默认关：多数时候用户问的是整个视频的问题，
  // 带上播放位置反而会让模型误以为「在问当前这一段」。
  sendPlayhead: false,
  saveMode: 'obsidian',
  obsidian: {
    enabled: false,
    subfolder: 'BiliLens',
    filenameTemplate: '{title}',
  },
  localAsr: {
    enabled: true,
    endpoint: 'http://127.0.0.1:18765/api/transcribe',
    timeoutSeconds: 180,
    autoFallback: true,
  },
  autoRun: false,
  language: 'zh',
  fontScale: 'normal',
};

/* ------------------------------------------------------------------ *
 * 模型配置的读写辅助
 *
 * 收口在这里，避免「活动配置」这个概念散落在设置页、侧边栏、
 * 存储层三处各推一遍，最后谁也不知道该以哪份为准。
 * ------------------------------------------------------------------ */

/** 生成一个稳定的 profile id */
export function newProfileId(): string {
  // randomUUID 需要安全上下文；扩展页满足，但仍留一条退路，
  // 免得在非 https 的调试页里直接抛错。
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 取当前生效的配置；没有配置或 id 失配时返回 null */
export function getActiveProfile(s: Settings): LlmProfile | null {
  return s.profiles.find((p) => p.id === s.activeProfileId) ?? null;
}

/** 新建一份配置，字段取服务商预设的默认值 */
export function makeProfile(
  provider: ProviderId,
  preset: { baseURL: string; model: string },
  name: string,
): LlmProfile {
  const model = preset.model;
  const initialModel: SavedModelConfig | undefined = model
    ? {
        id: newProfileId(),
        model,
        name: model,
        contextWindow: 0,
        maxTokens: 0,
        temperature: 0.3,
        reasoningEffort: '',
        supportsVision: false,
      }
    : undefined;

  return {
    id: newProfileId(),
    name,
    provider,
    baseURL: preset.baseURL,
    model,
    apiKey: '',
    temperature: 0.3,
    maxTokens: 0,
    contextWindow: 0,
    reasoningEffort: '',
    supportsVision: false,
    models: initialModel ? [initialModel] : [],
  };
}

/* ================================================================== *
 * 四、错误
 * ================================================================== */

/** 需要用户登录 B站 时抛出 */
export class NotLoggedInError extends Error {
  readonly code = 'NOT_LOGIN' as const;
  constructor(message = '需要登录 B站 才能读取该数据，请先在浏览器中登录 bilibili.com') {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

/** 页面脚本未注入（例如当前不是视频页） */
export class BridgeUnavailableError extends Error {
  readonly code = 'BRIDGE_UNAVAILABLE' as const;
  constructor(message = '当前页面未就绪，请打开一个 B站视频页面后重试') {
    super(message);
    this.name = 'BridgeUnavailableError';
  }
}

/**
 * 结构化错误分类（用于准确提示问题环节并引导用户处理）
 */
export type ErrorCategory =
  | 'model_not_configured' // 忘配置模型（未选模型、未填 API 地址/模型名、云端未填 API Key）
  | 'provider_error'       // 模型配置了，但打不通（网络超时、连接被拒、401/403、429、500/502/503/504 等）
  | 'asr_not_started'      // 本地 ASR 服务未开启（Failed to fetch / Connection refused / 端口未监听）
  | 'asr_error'            // 本地 ASR 运行异常（转录超时、显存不足 500、解码失败等）
  | 'no_subtitle'          // 视频无官方字幕且本地 ASR 未启用
  | 'generic';             // 其它未知或通用错误
