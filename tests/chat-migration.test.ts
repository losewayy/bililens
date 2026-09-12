/**
 * tests/chat-migration.test.ts —— 旧聊天（chats.v1 单串）升级到 v2 多对话
 *
 * 与设置迁移同类：旧记录若没被完整搬进新结构，
 * 用户重开面板就会发现聊天记录消失，且无法找回。
 * 迁移必须是「整体」的——v1 一个键存所有视频，
 * 只迁当前视频就删键会无声丢掉其余视频的记录。
 */

import { beforeEach, describe, expect, it } from 'vitest';

/** 内存版 storage，代替扩展环境的 chrome.storage.local */
let store: Record<string, unknown> = {};

/*
 * storage.ts 用的是 WXT 的自动导入全局 browser，必须挂到 globalThis 上。
 */
(globalThis as unknown as { browser: unknown }).browser = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  permissions: {
    contains: async () => false,
    request: async () => false,
    remove: async () => undefined,
  },
};

const { getChat, putChat, clearChat, chatTitleFromTurns } = await import('@/lib/storage');

beforeEach(() => {
  store = {};
});

describe('聊天 v1 → v2 迁移', () => {
  it('★★ 旧的单串聊天必须完整变成一个会话，不能丢内容', async () => {
    store['chats.v1'] = [
      {
        key: 'BV1:100',
        bvid: 'BV1',
        cid: 100,
        turns: [
          { role: 'user', content: '旧视频里的问题' },
          { role: 'assistant', content: '旧的回答 [1:00]' },
          { role: 'user', content: '带图的一问', hadImages: true },
        ],
        updatedAt: 1700000000000,
      },
    ];

    const got = await getChat('BV1', 100);
    expect(got).not.toBeNull();
    expect(got?.sessions).toHaveLength(1);
    expect(got?.sessions[0]?.turns).toHaveLength(3);
    expect(got?.sessions[0]?.turns[2]?.hadImages).toBe(true);
    expect(got?.sessions[0]?.title).toContain('旧视频里的问题');
    expect(got?.activeId).toBe(got?.sessions[0]?.id);

    // 读取即迁移：v2 落盘，v1 清掉
    expect(Array.isArray(store['chats.v2'])).toBe(true);
    expect(store['chats.v1']).toBeUndefined();
  });

  it('★★ 迁移一个视频不能丢掉其他视频的旧聊天', async () => {
    store['chats.v1'] = [
      {
        key: 'BV1:100',
        bvid: 'BV1',
        cid: 100,
        turns: [{ role: 'user', content: 'A 的问题' }],
        updatedAt: 1,
      },
      {
        key: 'BV2:200',
        bvid: 'BV2',
        cid: 200,
        turns: [{ role: 'user', content: 'B 的问题' }],
        updatedAt: 2,
      },
    ];

    const a = await getChat('BV1', 100);
    expect(a?.sessions[0]?.turns[0]?.content).toBe('A 的问题');

    // 同一次会话里再打开另一个视频，旧记录必须还在
    const b = await getChat('BV2', 200);
    expect(b?.sessions[0]?.turns[0]?.content).toBe('B 的问题');
  });

  it('没有旧记录时返回 null', async () => {
    expect(await getChat('BVnone', 1)).toBeNull();
  });

  it('putChat 保留调用方给的会话顺序，并限制单会话轮数', async () => {
    const mk = (id: string, n: number): Parameters<typeof putChat>[2][number] => ({
      id,
      title: `对话 ${id}`,
      turns: Array.from({ length: n }, (_, i) => ({
        role: 'user' as const,
        content: `消息 ${i}`,
      })),
      createdAt: 1,
      updatedAt: 1,
    });

    await putChat('BV1', 100, [mk('a', 5), mk('b', 3)], 'a');
    const got = await getChat('BV1', 100);
    expect(got?.sessions.map((s) => s.id)).toEqual(['a', 'b']);

    await putChat('BV1', 100, [mk('c', 80)], 'c');
    const got2 = await getChat('BV1', 100);
    expect(got2?.sessions[0]?.turns.length).toBeLessThanOrEqual(60);
  });

  it('clearChat 删掉该视频的全部对话', async () => {
    store['chats.v1'] = [
      {
        key: 'BV1:100',
        bvid: 'BV1',
        cid: 100,
        turns: [{ role: 'user', content: '旧问题' }],
        updatedAt: 1,
      },
    ];
    await clearChat('BV1', 100);
    expect(await getChat('BV1', 100)).toBeNull();
  });

  it('chatTitleFromTurns：空对话叫「新对话」，长消息截断', () => {
    expect(chatTitleFromTurns([])).toBe('新对话');
    expect(
      chatTitleFromTurns([{ role: 'user', content: '短问题' }]),
    ).toBe('短问题');
    const long = chatTitleFromTurns([{ role: 'user', content: 'x'.repeat(40) }]);
    expect(long.length).toBe(25); // 24 字 + 省略号
    expect(long.endsWith('…')).toBe(true);
  });
});
