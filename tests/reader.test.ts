/**
 * tests/reader.test.ts —— 面板流程的关键行为
 *
 * 只锁三件真正会出错、且出错代价很高的事：
 *   ① 笔记与聊天共享同一份素材（聊天不该重复抓字幕）
 *   ② 播放位置默认不发送，只有开关打开时才带
 *   ③ 多标签页不串台：每个面板只认自己那一页
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ================================================================== *
 * 替身
 * ================================================================== */

/** 每次调用模型都记一笔，含它收到的消息（raw 保留原始 content，用于检查图片） */
let llmCalls: Array<{
  sys: string;
  msgs: Array<{ role: string; content: string }>;
  raw: Array<{ role: string; content: unknown }>;
}> = [];

const cache = new Map<string, { markdown: string; createdAt: number }>();

/** v2 形状的会话 */
interface MockSession {
  id: string;
  title: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string; hadImages?: boolean }>;
  createdAt: number;
  updatedAt: number;
}

/** v2 形状的聊天存储：每个视频一组会话 */
const chats = new Map<string, { sessions: MockSession[]; activeId: string }>();

/** 把多模态 content 拍平成文本，便于断言 */
function flatten(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: string }).text) : ''))
      .join('\n');
  }
  return '';
}

/** 上一次请求里带了几张图 */
function imageCount(c: unknown): number {
  if (!Array.isArray(c)) return 0;
  return c.filter((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'image_url')
    .length;
}

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    getCachedNote: async (bvid: string, cid: number) => {
      const hit = cache.get(`${bvid}:${cid}`);
      if (!hit) return null;
      return { key: `${bvid}:${cid}`, bvid, cid, title: 'T', upName: 'U', model: 'm', ...hit };
    },
    putCachedNote: async (n: { bvid: string; cid: number; markdown: string }) => {
      cache.set(`${n.bvid}:${n.cid}`, { markdown: n.markdown, createdAt: Date.now() });
    },
    getChat: async (bvid: string, cid: number) => {
      const rec = chats.get(`${bvid}:${cid}`);
      if (!rec || rec.sessions.length === 0) return null;
      return { key: `${bvid}:${cid}`, bvid, cid, ...rec, updatedAt: Date.now() };
    },
    putChat: async (bvid: string, cid: number, sessions: MockSession[], activeId: string) => {
      chats.set(`${bvid}:${cid}`, { sessions, activeId });
    },
  };
});

/** 当前「活动」标签页 —— 测试里可随时改，用来模拟用户切换标签页 */
let activeTab = { id: 7, url: 'https://www.bilibili.com/video/BV1test' };

let infoQueries: number[] = [];
/** collect 被调用了几次 —— 用来验证「素材只抓一次」 */
let collectCalls = 0;
/** 当前的播放位置，测试里可改 */
let playheadValue: number | null = 932;

const infoFor = (tab: number) => ({
  aid: 1,
  bvid: `BV1tab${tab}`,
  cid: 100 + tab,
  title: '测试视频',
  desc: '',
  upName: 'UP',
  upMid: 2,
  duration: 1200,
  cover: '',
  pubdate: 0,
  view: 0,
  like: 0,
  isBangumi: false,
  pageIndex: 1,
  pageCount: 1,
  partTitle: '',
});

vi.mock('@/composables/useBridge', () => ({
  isBilibiliVideoUrl: (u?: string) => !!u && u.includes('/video/'),
  getActiveTab: async () => activeTab,
  seekVideo: async () => undefined,
  askContent: async (tab: number, type: string) => {
    if (type === 'videoInfo') {
      infoQueries.push(tab);
      return infoFor(tab);
    }
    if (type === 'collect') {
      collectCalls += 1;
      return {
        info: infoFor(tab),
        conclusion: {
          available: true,
          summary: '官方摘要',
          outline: [],
          subtitle: [{ from: 0, to: 5, content: '第一句' }],
          resultType: 2,
          like: 0,
        },
        subtitles: { list: [] },
      };
    }
    if (type === 'playhead') return { seconds: playheadValue };
    return undefined;
  },
}));

vi.mock('@/lib/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm')>('@/lib/llm');
  return {
    ...actual,
    streamChat: async (
      _cfg: unknown,
      messages: Array<{ role: string; content: unknown }>,
      cb: {
        onDelta: (s: string) => void;
        onReasoning?: (s: string) => void;
        onUsage?: (u: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
      },
    ) => {
      // content 可能是「文字 + 图片」的数组，测试里统一拍平成文本
      const flat = messages.map((m) => ({ role: m.role, content: flatten(m.content) }));
      llmCalls.push({ sys: flat[0]?.content ?? '', msgs: flat, raw: messages });
      const isChat = (flat[0]?.content ?? '').includes('刚看完这个视频');
      const text = isChat ? '这是回答 [1:00]' : '## notes 的输出\n\n- 内容 [0:05]';
      cb.onReasoning?.('模型思考中');
      cb.onUsage?.({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
      cb.onDelta(text);
      return text;
    },
  };
});

const { useReader } = await import('@/composables/useReader');
const { DEFAULT_SETTINGS, makeProfile } = await import('@/lib/types');

function settings(
  over: Partial<typeof DEFAULT_SETTINGS> = {},
  profile: Partial<ReturnType<typeof makeProfile>> = {},
) {
  const p = {
    ...makeProfile('custom', { baseURL: 'http://127.0.0.1:9/v1', model: 'test' }, '测试'),
    ...profile,
  };
  return { ...DEFAULT_SETTINGS, ...over, profiles: [p], activeProfileId: p.id };
}

async function settle(reader: ReturnType<typeof useReader>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (!reader.isBusy.value && !reader.chatBusy.value) {
      const p = reader.state.value.phase;
      if (p === 'done' || p === 'error' || p === 'idle') return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function boot(over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const reader = useReader();
  await reader.init(settings(over));
  await settle(reader);
  return reader;
}

beforeEach(() => {
  llmCalls = [];
  cache.clear();
  chats.clear();
  activeTab = { id: 7, url: 'https://www.bilibili.com/video/BV1test' };
  infoQueries = [];
  collectCalls = 0;
  playheadValue = 932;
});

/* ================================================================== *
 * 一、笔记
 * ================================================================== */

describe('生成笔记', () => {
  it('生成后应写入缓存，重新打开直接命中', async () => {
    const first = await boot();
    await first.runNote(settings());
    await settle(first);
    expect(first.state.value.markdown).toContain('notes');
    expect(llmCalls).toHaveLength(1);

    // 新实例，共享同一份 storage
    const second = await boot();
    expect(llmCalls).toHaveLength(1);
    expect(second.state.value.markdown).toContain('notes');
  });
});

/* ================================================================== *
 * 二、聊天
 * ================================================================== */

describe('聊天', () => {
  it('★ 不生成笔记也能直接提问', async () => {
    const reader = await boot();
    expect(reader.state.value.markdown).toBe('');

    await reader.sendChat(settings(), '它讲了什么');
    await settle(reader);

    expect(reader.chat.value).toHaveLength(2);
    expect(reader.chat.value[0]?.content).toBe('它讲了什么');
    expect(reader.chat.value[1]?.content).toContain('回答');
  });

  it('★★ 笔记与聊天共享素材，字幕只抓一次', async () => {
    const reader = await boot();

    await reader.runNote(settings());
    await settle(reader);
    expect(collectCalls).toBe(1);

    await reader.sendChat(settings(), '再问一句');
    await settle(reader);
    await reader.sendChat(settings(), '又问一句');
    await settle(reader);

    // 三次动作（1 次笔记 + 2 次聊天）只应抓一次字幕
    expect(collectCalls).toBe(1);
  });

  it('★ 聊天消息里带着完整字幕', async () => {
    const reader = await boot();
    await reader.sendChat(settings(), '问题');
    await settle(reader);

    const chatCall = llmCalls[llmCalls.length - 1];
    const joined = chatCall?.msgs.map((m) => m.content).join('\n') ?? '';
    expect(joined).toContain('第一句');
    expect(joined).toContain('视频字幕原文');
  });

  it('★ 聊天记录会保存，重新打开还在', async () => {
    const first = await boot();
    await first.sendChat(settings(), '记住我');
    await settle(first);
    expect(first.chat.value).toHaveLength(2);

    const second = await boot();
    expect(second.chat.value).toHaveLength(2);
    expect(second.chat.value[0]?.content).toBe('记住我');
  });

  it('清空后记录不应再被恢复', async () => {
    const first = await boot();
    await first.sendChat(settings(), '一句话');
    await settle(first);
    await first.clearChatHistory();
    expect(first.chat.value).toHaveLength(0);

    const second = await boot();
    expect(second.chat.value).toHaveLength(0);
  });

  it('★★ 新建对话互不串台，切回原对话记录还在', async () => {
    const reader = await boot();
    await reader.sendChat(settings(), '第一段的问题');
    await settle(reader);

    reader.newChatSession();
    expect(reader.chat.value).toHaveLength(0);
    expect(reader.activeChatId.value).not.toBe('');

    await reader.sendChat(settings(), '第二段的问题');
    await settle(reader);
    expect(reader.chat.value).toHaveLength(2);
    expect(reader.chatSessions.value).toHaveLength(2);

    // 新建的排在前面，第二个是原有对话
    const firstId = reader.chatSessions.value[1]?.id;
    await reader.switchChatSession(firstId as string);
    expect(reader.chat.value).toHaveLength(2);
    expect(reader.chat.value[0]?.content).toBe('第一段的问题');
    expect(reader.chat.value[1]?.content).toContain('回答');
  });

  it('★ 会话标题取自第一条用户消息', async () => {
    const reader = await boot();
    await reader.sendChat(settings(), '这是一条用来当标题的消息');
    await settle(reader);
    expect(reader.chatSessions.value[0]?.title).toContain('这是一条');
  });

  it('★ 删除当前对话后回到空态，重开不再恢复', async () => {
    const reader = await boot();
    await reader.sendChat(settings(), '要被删掉的话');
    await settle(reader);

    await reader.deleteChatSession(reader.activeChatId.value);
    expect(reader.chat.value).toHaveLength(0);
    expect(reader.chatSessions.value).toHaveLength(0);

    const second = await boot();
    expect(second.chat.value).toHaveLength(0);
    expect(second.activeChatId.value).toBe('');
  });

  it('★ 思考过程进入气泡但不落盘', async () => {
    const first = await boot();
    await first.sendChat(settings(), '问题');
    await settle(first);
    expect(first.chat.value[1]?.reasoning).toBe('模型思考中');
    expect(first.chat.value[1]?.content).toContain('回答');
    // token 用量同样只留在内存里
    expect(first.chat.value[1]?.usage?.totalTokens).toBe(120);

    // 思考过程与图片一样只活在内存里
    const second = await boot();
    expect(second.chat.value[1]?.reasoning).toBeUndefined();
    expect(second.chat.value[1]?.usage).toBeUndefined();
    expect(second.chat.value[1]?.content).toContain('回答');
  });
});

/* ================================================================== *
 * 三、图片（粘贴截图）
 * ================================================================== */

describe('图片输入', () => {
  const img = { dataURL: 'data:image/jpeg;base64,AAAA', width: 10, height: 10 };

  it('★★ 配置未开启图像输入时，必须明确报错而不是静默丢掉图片', async () => {
    const reader = await boot();
    await reader.sendChat(settings({}, { supportsVision: false }), '这是什么', [img]);
    await settle(reader);

    expect(llmCalls).toHaveLength(0);
    const last = reader.chat.value[reader.chat.value.length - 1];
    expect(last?.error).toContain('图像输入');
  });

  it('★★ 开启后图片以 image_url 块发出', async () => {
    const reader = await boot();
    await reader.sendChat(settings({}, { supportsVision: true }), '这是什么', [img]);
    await settle(reader);

    const lastUser = [...(llmCalls[0]?.raw ?? [])].reverse().find((m) => m.role === 'user');
    expect(imageCount(lastUser?.content)).toBe(1);
    expect(llmCalls[0]?.msgs.map((m) => m.content).join('\n')).toContain('这是什么');
  });

  it('★ 只有图片没有文字也应能发送', async () => {
    const reader = await boot();
    await reader.sendChat(settings({}, { supportsVision: true }), '', [img]);
    await settle(reader);

    expect(reader.chat.value).toHaveLength(2);
    expect(reader.chat.value[1]?.content).toContain('回答');
  });

  it('★ 追问时原图仍在（否则模型第二问就「看不见」了）', async () => {
    const reader = await boot();
    const cfg = settings({}, { supportsVision: true });
    await reader.sendChat(cfg, '这是什么', [img]);
    await settle(reader);
    await reader.sendChat(cfg, '那它和前面有什么关系', []);
    await settle(reader);

    const raw = llmCalls[llmCalls.length - 1]?.raw ?? [];
    expect(raw.filter((m) => imageCount(m.content) > 0)).toHaveLength(1);
  });

  it('★ 图片不会随会话无限累积（只保留最近两轮带图的）', async () => {
    const reader = await boot();
    const cfg = settings({}, { supportsVision: true });
    for (let i = 0; i < 4; i++) {
      await reader.sendChat(cfg, `第 ${i} 问`, [img]);
      await settle(reader);
    }

    const raw = llmCalls[llmCalls.length - 1]?.raw ?? [];
    expect(raw.filter((m) => imageCount(m.content) > 0)).toHaveLength(2);
  });

  it('★★ 没有模型配置时，发消息要给出可操作的提示', async () => {
    const reader = await boot();
    const empty = { ...DEFAULT_SETTINGS, profiles: [], activeProfileId: '' };
    await reader.sendChat(empty, '你好');
    await settle(reader);

    expect(llmCalls).toHaveLength(0);
    expect(reader.chat.value[reader.chat.value.length - 1]?.error).toContain('设置');
  });

  it('★ 图片不落盘，重载后只留一个占位标记', async () => {
    const first = await boot();
    await first.sendChat(settings({}, { supportsVision: true }), '看图', [img]);
    await settle(first);

    const second = await boot();
    expect(second.chat.value[0]?.images).toBeUndefined();
    expect(second.chat.value[0]?.imagesLost).toBe(true);
  });
});

/* ================================================================== *
 * 四、播放位置
 * ================================================================== */

describe('播放位置', () => {
  it('★★ 默认不发送播放位置', async () => {
    const reader = await boot();
    reader.playhead.value = 932;

    await reader.sendChat(settings({ sendPlayhead: false }), '整个视频讲了什么');
    await settle(reader);

    const joined = llmCalls[llmCalls.length - 1]?.msgs.map((m) => m.content).join('\n') ?? '';
    expect(joined).not.toContain('我当前看到');
  });

  it('★★ 开关打开时才附带播放位置', async () => {
    const reader = await boot();
    reader.playhead.value = 932;

    await reader.sendChat(settings({ sendPlayhead: true }), '这里讲了什么');
    await settle(reader);

    const joined = llmCalls[llmCalls.length - 1]?.msgs.map((m) => m.content).join('\n') ?? '';
    expect(joined).toContain('我当前看到');
    expect(joined).toContain('15:32');
  });

  it('开关打开但没有播放位置时不应附带', async () => {
    const reader = await boot();
    reader.playhead.value = null;

    await reader.sendChat(settings({ sendPlayhead: true }), '问题');
    await settle(reader);

    const joined = llmCalls[llmCalls.length - 1]?.msgs.map((m) => m.content).join('\n') ?? '';
    expect(joined).not.toContain('我当前看到');
  });

  it('播放位置只附在最后一条用户消息上，不污染历史', async () => {
    const reader = await boot();
    reader.playhead.value = 60;

    await reader.sendChat(settings({ sendPlayhead: true }), '第一问');
    await settle(reader);
    await reader.sendChat(settings({ sendPlayhead: true }), '第二问');
    await settle(reader);

    const msgs = llmCalls[llmCalls.length - 1]?.msgs ?? [];
    const withPlayhead = msgs.filter((m) => m.content.includes('我当前看到'));
    expect(withPlayhead).toHaveLength(1);
    expect(withPlayhead[0]?.content).toContain('第二问');
  });
});

/* ================================================================== *
 * 五、多标签页
 * ================================================================== */

describe('面板只认自己绑定的标签页', () => {
  it('★ 活动标签页换成别的页时，本面板必须忽略该事件', async () => {
    const reader = await boot();
    const mine = reader.state.value.info?.bvid;
    const before = infoQueries.length;

    activeTab = { id: 99, url: 'https://www.bilibili.com/video/BV1other' };
    await reader.sync(settings());

    expect(infoQueries.length).toBe(before);
    expect(reader.state.value.info?.bvid).toBe(mine);
  });

  it('★ 别的标签页导航到非视频页，不应清空本面板内容', async () => {
    const reader = await boot();
    await reader.runNote(settings());
    await settle(reader);

    activeTab = { id: 99, url: 'https://www.bilibili.com/' };
    await reader.sync(settings());

    expect(reader.state.value.markdown).not.toBe('');
    expect(reader.state.value.info).not.toBeNull();
  });
});
