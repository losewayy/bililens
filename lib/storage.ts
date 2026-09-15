/**
 * lib/storage.ts —— 设置持久化与运行时权限
 *
 * 两个关键点：
 *  ① 所有设置统一走这里，避免各处直接碰 chrome.storage 导致读写不一致。
 *  ② 大模型端点由用户自填，域名未知，故用 optional_host_permissions，
 *     在保存设置时按需申请该域名的运行时权限。
 */

import {
  DEFAULT_SETTINGS,
  newProfileId,
  type LlmProfile,
  type ReasoningEffort,
  type SavedModelConfig,
  type Settings,
} from './types';
import { hostPatternFromBaseURL, normalizeBaseURL } from './llm';
import { normalizeFontScale } from './fontScale';

const KEY = 'settings.v1';

/** 收敛到合法的思考深度档位；手工改坏存储时不能把非法值发出去 */
function normalizeEffort(raw: unknown): ReasoningEffort {
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max'
    ? raw
    : '';
}

/** 规范化单条保存的模型配置 */
export function normalizeSavedModel(raw: unknown): SavedModelConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<SavedModelConfig>;
  const model = String(m.model ?? '').trim();
  if (!model) return null;
  return {
    id: typeof m.id === 'string' && m.id ? m.id : newProfileId(),
    model,
    name: typeof m.name === 'string' && m.name ? m.name : model,
    contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : 0,
    maxTokens: typeof m.maxTokens === 'number' && m.maxTokens > 0 ? m.maxTokens : 0,
    temperature: typeof m.temperature === 'number' ? m.temperature : 0.3,
    reasoningEffort: normalizeEffort(m.reasoningEffort),
    supportsVision: m.supportsVision === true,
  };
}

/**
 * 规范化一份模型配置：补齐字段 + 规范化 baseURL。
 *
 * 兼容「只有 provider 没有 id/name/supportsVision」的旧对象——
 * 迁移和后续读取都走这里，就不会出现半新半旧的数据。
 */
function normalizeProfile(raw: unknown): LlmProfile {
  const p = (raw ?? {}) as Partial<LlmProfile>;
  const rawModel = String(p.model ?? '');
  const rawContextWindow = typeof p.contextWindow === 'number' && p.contextWindow > 0 ? p.contextWindow : 0;
  const rawMaxTokens = typeof p.maxTokens === 'number' && p.maxTokens > 0 ? p.maxTokens : 0;
  const rawTemperature = typeof p.temperature === 'number' ? p.temperature : 0.3;
  const rawReasoning = normalizeEffort(p.reasoningEffort);
  const rawVision = p.supportsVision === true;

  const rawModels = Array.isArray(p.models)
    ? p.models.map(normalizeSavedModel).filter((m): m is SavedModelConfig => m !== null)
    : [];

  // 如果 models 数组为空但当前配置有 model，自动沉淀为第一份模型预设
  let models = rawModels;
  if (models.length === 0 && rawModel.trim()) {
    models = [
      {
        id: newProfileId(),
        model: rawModel.trim(),
        name: rawModel.trim(),
        contextWindow: rawContextWindow,
        maxTokens: rawMaxTokens,
        temperature: rawTemperature,
        reasoningEffort: rawReasoning,
        supportsVision: rawVision,
      },
    ];
  }

  return {
    id: typeof p.id === 'string' && p.id ? p.id : newProfileId(),
    name: typeof p.name === 'string' && p.name ? p.name : (p.provider ?? '自定义端点'),
    provider: p.provider ?? 'custom',
    baseURL: normalizeBaseURL(String(p.baseURL ?? '')),
    apiKey: String(p.apiKey ?? ''),
    model: rawModel,
    temperature: rawTemperature,
    maxTokens: rawMaxTokens,
    contextWindow: rawContextWindow,
    reasoningEffort: rawReasoning,
    supportsVision: rawVision,
    models,
  };
}

/** 深合并默认值，避免旧版本设置缺字段时炸掉；顺带把旧结构迁移过来 */
function mergeSettings(partial: unknown): Settings {
  const p = (partial ?? {}) as Partial<Settings> & { llm?: unknown };

  /*
   * 迁移：旧版本只有单个 llm: LlmConfig。
   *
   * 必须在这里做，而不是只在设置页做——侧边栏同样调 loadSettings()，
   * 只迁一处的话，用户没打开过设置页时侧边栏会读到空配置。
   * 迁移是无损的：旧 llm 的字段原样搬进第一份 profile。
   */
  const rawProfiles = Array.isArray(p.profiles) ? p.profiles : null;
  const legacy = p.llm && typeof p.llm === 'object' ? p.llm : null;

  let profiles: LlmProfile[];
  let activeProfileId: string;

  if (rawProfiles) {
    profiles = rawProfiles.map(normalizeProfile);
    activeProfileId =
      typeof p.activeProfileId === 'string' && profiles.some((x) => x.id === p.activeProfileId)
        ? p.activeProfileId
        : (profiles[0]?.id ?? '');
  } else if (legacy) {
    const only = normalizeProfile(legacy);
    // 旧配置是空壳（没填过地址也没填过模型）时不生成 profile，
    // 否则用户会看到一份毫无内容的配置，反而困惑
    profiles = only.baseURL || only.model ? [only] : [];
    activeProfileId = profiles[0]?.id ?? '';
  } else {
    profiles = [];
    activeProfileId = '';
  }

  return {
    ...DEFAULT_SETTINGS,
    ...p,
    profiles,
    activeProfileId,
    // 旧版本没有这个字段，手工改坏过也要收敛到合法档位
    fontScale: normalizeFontScale(p.fontScale),
    obsidian: { ...DEFAULT_SETTINGS.obsidian, ...(p.obsidian ?? {}) },
    localAsr: {
      enabled:
        typeof p.localAsr?.enabled === 'boolean'
          ? p.localAsr.enabled
          : DEFAULT_SETTINGS.localAsr.enabled,
      endpoint:
        typeof p.localAsr?.endpoint === 'string' && p.localAsr.endpoint.trim()
          ? p.localAsr.endpoint.trim()
          : DEFAULT_SETTINGS.localAsr.endpoint,
      timeoutSeconds:
        typeof p.localAsr?.timeoutSeconds === 'number' && p.localAsr.timeoutSeconds > 0
          ? p.localAsr.timeoutSeconds
          : DEFAULT_SETTINGS.localAsr.timeoutSeconds,
      autoFallback:
        typeof p.localAsr?.autoFallback === 'boolean'
          ? p.localAsr.autoFallback
          : DEFAULT_SETTINGS.localAsr.autoFallback,
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(KEY);
  return mergeSettings(raw[KEY]);
}

export async function saveSettings(next: Settings): Promise<void> {
  // 顺手规范化 baseURL，避免用户多写/少写斜杠导致请求异常
  const normalized: Settings = {
    ...next,
    profiles: next.profiles.map(normalizeProfile),
  };
  await browser.storage.local.set({ [KEY]: normalized });
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next = mergeSettings({ ...cur, ...patch });
  await saveSettings(next);
  return next;
}

/** 监听设置变化（多页面同步） */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const handler = (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ): void => {
    if (area !== 'local' || !(KEY in changes)) return;
    cb(mergeSettings(changes[KEY]?.newValue));
  };

  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

/* ================================================================== *
 * 运行时域名权限
 * ================================================================== */

/** 当前是否已获得该 API 域名的访问权限 */
export async function hasApiPermission(baseURL: string): Promise<boolean> {
  const pattern = hostPatternFromBaseURL(baseURL);
  if (!pattern) return false;
  try {
    return await browser.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * 申请 API 域名权限。
 * 必须在用户手势（点击事件）中调用，否则浏览器会拒绝。
 */
export async function requestApiPermission(baseURL: string): Promise<boolean> {
  const pattern = hostPatternFromBaseURL(baseURL);
  if (!pattern) return false;
  try {
    if (await browser.permissions.contains({ origins: [pattern] })) return true;
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function revokeApiPermission(baseURL: string): Promise<void> {
  const pattern = hostPatternFromBaseURL(baseURL);
  if (!pattern) return;
  try {
    await browser.permissions.remove({ origins: [pattern] });
  } catch {
    /* 忽略 */
  }
}

/* ================================================================== *
 * 生成结果缓存
 *
 * 每个视频存一份笔记。切 Tab 不会重新生成——笔记是产物，
 * 生成一次就够，反复调用只是白花钱。
 * ================================================================== */

const CACHE_KEY = 'notes.cache.v3';
/** 旧版缓存键（按模式分的、更早不分模式的），读取时顺手清掉 */
const LEGACY_KEYS = ['notes.cache.v1', 'notes.cache.v2'];
const CACHE_LIMIT = 30;

export interface CachedNote {
  /** `${bvid}:${cid}` */
  key: string;
  bvid: string;
  cid: number;
  title: string;
  upName: string;
  markdown: string;
  createdAt: number;
  model: string;
}

function noteKey(bvid: string, cid: number): string {
  return `${bvid}:${cid}`;
}

export async function getCachedNote(bvid: string, cid: number): Promise<CachedNote | null> {
  const raw = await browser.storage.local.get(CACHE_KEY);
  const list = (raw[CACHE_KEY] as CachedNote[] | undefined) ?? [];
  const want = noteKey(bvid, cid);
  return list.find((n) => n.key === want) ?? null;
}

export async function putCachedNote(note: Omit<CachedNote, 'key'>): Promise<void> {
  const raw = await browser.storage.local.get(CACHE_KEY);
  const list = ((raw[CACHE_KEY] as CachedNote[] | undefined) ?? []).filter(
    (n) => n.key !== noteKey(note.bvid, note.cid),
  );
  list.unshift({ ...note, key: noteKey(note.bvid, note.cid) });

  await browser.storage.local.set({ [CACHE_KEY]: list.slice(0, CACHE_LIMIT) });

  // 清掉旧版遗留的缓存，避免占着 storage
  await browser.storage.local.remove(LEGACY_KEYS).catch(() => undefined);
}

export async function clearNoteCache(): Promise<void> {
  await browser.storage.local.remove([CACHE_KEY, ...LEGACY_KEYS]);
}

/* ================================================================== *
 * 聊天记录（按视频存，一个视频可以有多个对话）
 * ================================================================== */

const CHAT_KEY = 'chats.v2';
/** 旧版单串聊天（v1），读到时整体迁移成 v2 后清掉 */
const CHAT_KEY_V1 = 'chats.v1';
const CHAT_LIMIT = 30;
/** 每个视频最多保留多少个对话，超出淘汰最旧的 */
const SESSIONS_PER_VIDEO = 20;
/** 每个对话最多保留多少轮，防止无限增长 */
const CHAT_TURNS_PER_SESSION = 60;

export interface StoredChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** 这一轮原本带图；图片本身不落盘（见 useReader 的说明） */
  hadImages?: boolean;
}

/** 一个对话（会话）。同一视频下互不干扰，可切换、新建、删除 */
export interface StoredChatSession {
  id: string;
  /** 取第一条用户消息生成，空对话为「新对话」 */
  title: string;
  turns: StoredChatTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredChat {
  key: string;
  bvid: string;
  cid: number;
  sessions: StoredChatSession[];
  activeId: string;
  updatedAt: number;
}

/** 会话标题规则：第一条用户消息截前 24 字 */
export function chatTitleFromTurns(turns: StoredChatTurn[]): string {
  const first = turns.find((t) => t.role === 'user');
  const text = (first?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function normalizeTurns(raw: unknown): StoredChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Partial<StoredChatTurn> => !!t && typeof t === 'object')
    .map((t) => ({
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(t.content ?? ''),
      ...(t.hadImages ? { hadImages: true as const } : {}),
    }));
}

function normalizeSession(raw: unknown): StoredChatSession | null {
  const s = (raw ?? {}) as Partial<StoredChatSession>;
  if (typeof s.id !== 'string' || !s.id || !Array.isArray(s.turns)) return null;
  const turns = normalizeTurns(s.turns).slice(-CHAT_TURNS_PER_SESSION);
  return {
    id: s.id,
    title: typeof s.title === 'string' && s.title ? s.title : chatTitleFromTurns(turns),
    turns,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
  };
}

/**
 * 读取整个聊天列表，并把旧 v1 结构一次性迁移成 v2。
 *
 * 迁移必须整体做而不是按视频做：v1 是一个键存所有视频，
 * 若只迁当前视频就删 v1，其余视频的旧聊天会被无声丢掉。
 */
async function loadChatList(): Promise<StoredChat[]> {
  const raw = await browser.storage.local.get([CHAT_KEY, CHAT_KEY_V1]);

  if (Array.isArray(raw[CHAT_KEY])) return raw[CHAT_KEY] as StoredChat[];

  if (!Array.isArray(raw[CHAT_KEY_V1])) return [];
  const migrated: StoredChat[] = (raw[CHAT_KEY_V1] as Array<Record<string, unknown>>)
    .map((old) => {
      const bvid = String(old.bvid ?? '');
      const cid = typeof old.cid === 'number' ? old.cid : 0;
      const turns = normalizeTurns(old.turns).slice(-CHAT_TURNS_PER_SESSION);
      const at = typeof old.updatedAt === 'number' ? old.updatedAt : Date.now();
      const session: StoredChatSession = {
        id: newProfileId(),
        title: chatTitleFromTurns(turns),
        turns,
        createdAt: at,
        updatedAt: at,
      };
      return {
        key: noteKey(bvid, cid),
        bvid,
        cid,
        sessions: turns.length ? [session] : [],
        activeId: session.id,
        updatedAt: at,
      };
    })
    .filter((c) => c.sessions.length > 0);

  if (migrated.length > 0) {
    await browser.storage.local.set({ [CHAT_KEY]: migrated.slice(0, CHAT_LIMIT) });
  }
  await browser.storage.local.remove(CHAT_KEY_V1).catch(() => undefined);
  return migrated;
}

export async function getChat(bvid: string, cid: number): Promise<StoredChat | null> {
  const list = await loadChatList();
  const hit = list.find((c) => c.key === noteKey(bvid, cid));
  if (!hit) return null;

  const sessions = (Array.isArray(hit.sessions) ? hit.sessions : [])
    .map(normalizeSession)
    .filter((s): s is StoredChatSession => s !== null);
  if (sessions.length === 0) return null;

  return {
    ...hit,
    sessions,
    activeId: sessions.some((s) => s.id === hit.activeId) ? hit.activeId : (sessions[0]?.id ?? ''),
  };
}

export async function putChat(
  bvid: string,
  cid: number,
  sessions: StoredChatSession[],
  activeId: string,
): Promise<void> {
  const list = (await loadChatList()).filter((c) => c.key !== noteKey(bvid, cid));

  // 保留调用方给的顺序，只在超限时按 updatedAt 淘汰最旧的
  let kept = sessions.map((s) => ({ ...s, turns: s.turns.slice(-CHAT_TURNS_PER_SESSION) }));
  // 空对话是「点了＋但一句没说」的草稿，不落盘，免得下拉里堆一排「新对话（0 条）」
  kept = kept.filter((s) => s.turns.length > 0);
  if (kept.length > SESSIONS_PER_VIDEO) {
    const drop = new Set(
      [...kept]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, kept.length - SESSIONS_PER_VIDEO)
        .map((s) => s.id),
    );
    kept = kept.filter((s) => !drop.has(s.id));
  }

  list.unshift({
    key: noteKey(bvid, cid),
    bvid,
    cid,
    sessions: kept,
    activeId: kept.some((s) => s.id === activeId) ? activeId : (kept[0]?.id ?? ''),
    updatedAt: Date.now(),
  });
  await browser.storage.local.set({ [CHAT_KEY]: list.slice(0, CHAT_LIMIT) });
}

/** 删除一个视频的全部聊天（所有对话） */
export async function clearChat(bvid: string, cid: number): Promise<void> {
  const list = (await loadChatList()).filter((c) => c.key !== noteKey(bvid, cid));
  await browser.storage.local.set({ [CHAT_KEY]: list });
}
