/**
 * tests/settings-migration.test.ts —— 旧设置升级到「多配置」结构
 *
 * 这段迁移是**一次性且不可重来**的：用户升级扩展后，
 * 旧的那份 llm 配置若没被搬进新结构，就等于密钥和端点凭空消失，
 * 而用户只会看到「未配置」，根本不知道发生过什么。
 * 因此它值得一个专门的测试，而不是靠肉眼读代码确认。
 */

import { beforeEach, describe, expect, it } from 'vitest';

/** 内存版 storage，代替扩展环境的 chrome.storage.local */
let store: Record<string, unknown> = {};

/*
 * storage.ts 用的是 WXT 的自动导入全局 browser，不是 import 进来的，
 * 因此这里必须挂到 globalThis 上；vi.mock 拦不住一个全局变量。
 */
(globalThis as unknown as { browser: unknown }).browser = {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      },
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  permissions: {
    contains: async () => false,
    request: async () => false,
    remove: async () => undefined,
  },
};

const { loadSettings, saveSettings } = await import('@/lib/storage');
const { DEFAULT_SETTINGS, getActiveProfile } = await import('@/lib/types');

/** 写入一份旧结构的设置（没有 profiles，只有 llm） */
function seedLegacy(llm: Record<string, unknown>): void {
  store = {
    'settings.v1': {
      llm,
      tab: 'chat',
      sendPlayhead: true,
      saveMode: 'download',
      obsidian: { enabled: false, subfolder: 'X', filenameTemplate: '{title}' },
      autoRun: true,
      language: 'en',
    },
  };
}

beforeEach(() => {
  store = {};
});

describe('旧设置迁移', () => {
  it('★★ 旧的单份 llm 配置必须完整搬进 profiles，不能丢密钥', async () => {
    seedLegacy({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-keep-me',
      model: 'deepseek-chat',
      temperature: 0.4,
      maxTokens: 2048,
    });

    const s = await loadSettings();

    expect(s.profiles).toHaveLength(1);
    const p = s.profiles[0]!;
    expect(p.apiKey).toBe('sk-keep-me');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(p.model).toBe('deepseek-chat');
    expect(p.temperature).toBe(0.4);
    expect(p.maxTokens).toBe(2048);
    expect(p.provider).toBe('deepseek');
    expect(p.id).toBeTruthy();
    // 迁移出来的那份必须是当前生效的
    expect(s.activeProfileId).toBe(p.id);
    expect(getActiveProfile(s)?.apiKey).toBe('sk-keep-me');
  });

  it('★ 旧配置的其它字段也要保留（不能因为迁移把用户偏好重置了）', async () => {
    seedLegacy({ provider: 'custom', baseURL: 'http://127.0.0.1:11435/v1', model: 'x' });
    const s = await loadSettings();

    expect(s.tab).toBe('chat');
    expect(s.sendPlayhead).toBe(true);
    expect(s.autoRun).toBe(true);
    expect(s.saveMode).toBe('download');
    expect(s.language).toBe('en');
  });

  it('★ 旧配置是空壳时不生成空 profile（否则用户看到一份没内容的配置）', async () => {
    seedLegacy({ provider: 'custom', baseURL: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 0 });
    const s = await loadSettings();

    expect(s.profiles).toHaveLength(0);
    expect(s.activeProfileId).toBe('');
  });

  it('★ 旧设置没有 fontScale 时补标准档，不会变成 undefined', async () => {
    seedLegacy({ provider: 'custom', baseURL: 'http://127.0.0.1:11435/v1', model: 'x' });
    const s = await loadSettings();
    expect(s.fontScale).toBe('normal');
  });

  it('★ 手工改坏的 fontScale 要收敛到合法档位', async () => {
    store = { 'settings.v1': { ...DEFAULT_SETTINGS, fontScale: '巨大无比' } };
    const s = await loadSettings();
    expect(['normal', 'large', 'xlarge', 'huge']).toContain(s.fontScale);
  });

  it('★ 旧地址缺 /v1 时要顺手补上', async () => {
    seedLegacy({ provider: 'custom', baseURL: 'http://127.0.0.1:11435', model: 'x' });
    const s = await loadSettings();
    expect(s.profiles[0]?.baseURL).toBe('http://127.0.0.1:11435/v1');
  });

  it('完全没有设置时给一份干净的默认值', async () => {
    const s = await loadSettings();
    expect(s.profiles).toEqual([]);
    expect(s.activeProfileId).toBe('');
    expect(s.obsidian.subfolder).toBe(DEFAULT_SETTINGS.obsidian.subfolder);
  });

  it('★ 旧默认 ASR 端口 8765 自动迁移为 18765', async () => {
    store = {
      'settings.v1': {
        ...DEFAULT_SETTINGS,
        localAsr: {
          enabled: true,
          endpoint: 'http://127.0.0.1:8765/api/transcribe',
          timeoutSeconds: 180,
          autoFallback: true,
        },
      },
    };
    const s = await loadSettings();
    expect(s.localAsr.endpoint).toBe('http://127.0.0.1:18765/api/transcribe');
  });

  it('★ 用户自定义的非默认 ASR 端口保持原样不被误改', async () => {
    store = {
      'settings.v1': {
        ...DEFAULT_SETTINGS,
        localAsr: {
          enabled: true,
          endpoint: 'http://192.168.1.100:9999/api/transcribe',
          timeoutSeconds: 240,
          autoFallback: true,
        },
      },
    };
    const s = await loadSettings();
    expect(s.localAsr.endpoint).toBe('http://192.168.1.100:9999/api/transcribe');
  });
});

describe('新结构', () => {
  it('★★ 多份配置能存能读，activeProfileId 指向的那份生效', async () => {
    const s = await loadSettings();
    const a = { ...s, profiles: [
      { id: 'a', name: 'A', provider: 'custom' as const, baseURL: 'http://a.test/v1', apiKey: 'ka', model: 'ma', temperature: 0.3, maxTokens: 0, contextWindow: 0, reasoningEffort: '' as const, supportsVision: false },
      { id: 'b', name: 'B', provider: 'custom' as const, baseURL: 'http://b.test/v1', apiKey: 'kb', model: 'mb', temperature: 0.3, maxTokens: 0, contextWindow: 131072, reasoningEffort: 'high' as const, supportsVision: true },
    ], activeProfileId: 'b' };
    await saveSettings(a);

    const back = await loadSettings();
    expect(back.profiles).toHaveLength(2);
    expect(getActiveProfile(back)?.model).toBe('mb');
    expect(getActiveProfile(back)?.supportsVision).toBe(true);
    expect(getActiveProfile(back)?.contextWindow).toBe(131072);
    // 新字段读写往返后保持原值
    expect(getActiveProfile(back)?.reasoningEffort).toBe('high');
  });

  it('★ activeProfileId 失配时回退到第一份，而不是变成「未配置」', async () => {
    store = {
      'settings.v1': {
        ...DEFAULT_SETTINGS,
        profiles: [
          { id: 'a', name: 'A', provider: 'custom', baseURL: 'http://a.test/v1', apiKey: '', model: 'ma', temperature: 0.3, maxTokens: 0, contextWindow: 0, supportsVision: false },
        ],
        activeProfileId: '已经不存在了',
      },
    };

    const s = await loadSettings();
    expect(getActiveProfile(s)?.id).toBe('a');
  });

  it('★ 缺字段的配置项要被补齐（旧数据或手工改坏都能扛住）', async () => {
    store = {
      'settings.v1': {
        ...DEFAULT_SETTINGS,
        profiles: [{ provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }],
        activeProfileId: '',
      },
    };

    const s = await loadSettings();
    const p = s.profiles[0]!;
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('deepseek');
    expect(p.supportsVision).toBe(false);
    expect(p.temperature).toBe(0.3);
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(p.contextWindow).toBe(0);
    expect(p.reasoningEffort).toBe('');
    // 缺 models 字段时自动将当前 model 种子化为首条已配置模型
    expect(p.models).toBeDefined();
    expect(p.models).toHaveLength(1);
    expect(p.models?.[0]?.model).toBe('deepseek-chat');
  });

  it('★ 思考深度：合法档位保留，手工改坏的值收敛为空（不发参数）', async () => {
    store = {
      'settings.v1': {
        ...DEFAULT_SETTINGS,
        profiles: [
          { id: 'a', name: 'A', provider: 'custom', baseURL: 'http://a.test/v1', apiKey: '', model: 'ma', temperature: 0.3, maxTokens: 0, contextWindow: 0, reasoningEffort: 'xhigh', supportsVision: false },
          { id: 'b', name: 'B', provider: 'custom', baseURL: 'http://b.test/v1', apiKey: '', model: 'mb', temperature: 0.3, maxTokens: 0, contextWindow: 0, reasoningEffort: 'ultra', supportsVision: false },
          { id: 'c', name: 'C', provider: 'custom', baseURL: 'http://c.test/v1', apiKey: '', model: 'mc', temperature: 0.3, maxTokens: 0, contextWindow: 0, reasoningEffort: 'max', supportsVision: false },
        ],
        activeProfileId: 'a',
      },
    };

    const s = await loadSettings();
    expect(s.profiles[0]?.reasoningEffort).toBe('xhigh');
    expect(s.profiles[1]?.reasoningEffort).toBe('');
    expect(s.profiles[2]?.reasoningEffort).toBe('max');
  });

  it('★★ 服务商下多模型预设（models）完整读写与切换往返', async () => {
    const s = await loadSettings();
    const configured = {
      ...s,
      profiles: [
        {
          id: 'siliconflow-main',
          name: '硅基流动',
          provider: 'siliconflow' as const,
          baseURL: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-test',
          model: 'deepseek-ai/DeepSeek-V3',
          temperature: 0.3,
          maxTokens: 4096,
          contextWindow: 65536,
          reasoningEffort: '' as const,
          supportsVision: false,
          models: [
            {
              id: 'm1',
              name: 'DeepSeek V3 (日常/64k)',
              model: 'deepseek-ai/DeepSeek-V3',
              contextWindow: 65536,
              maxTokens: 4096,
              temperature: 0.3,
              reasoningEffort: '' as const,
              supportsVision: false,
            },
            {
              id: 'm2',
              name: 'Qwen 2.5 72B (超长/128k)',
              model: 'Qwen/Qwen2.5-72B-Instruct',
              contextWindow: 131072,
              maxTokens: 8192,
              temperature: 0.2,
              reasoningEffort: '' as const,
              supportsVision: false,
            },
            {
              id: 'm3',
              name: 'Qwen VL (多模态识图)',
              model: 'Qwen/Qwen2-VL-72B-Instruct',
              contextWindow: 32768,
              maxTokens: 2048,
              temperature: 0.3,
              reasoningEffort: '' as const,
              supportsVision: true,
            },
          ],
        },
      ],
      activeProfileId: 'siliconflow-main',
    };

    await saveSettings(configured);

    const reloaded = await loadSettings();
    const prof = getActiveProfile(reloaded);
    expect(prof?.models).toHaveLength(3);
    expect(prof?.models?.[1]?.model).toBe('Qwen/Qwen2.5-72B-Instruct');
    expect(prof?.models?.[1]?.contextWindow).toBe(131072);
    expect(prof?.models?.[2]?.supportsVision).toBe(true);
  });
});
