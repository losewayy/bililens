<script setup lang="ts">
/**
 * entrypoints/options/App.vue —— 设置页（现代化精致双栏工作台）
 *
 * 架构特点：
 *   · 顶部：品牌标识 + 实时配置状态卡片
 *   · 左侧：高精度导航侧栏（集成 SVG 图标、层级标题与实时完成状态指示器）
 *   · 右侧：聚焦面板
 *      01 大模型 —— 胶囊式 Profile 切换栏 + 紧凑品牌磁贴 + 密钥显隐与智能参数
 *      02 聊天行为 —— 现代交互开关卡片
 *      03 阅读外观 —— 阶梯式字号选择器 + macOS 风格真实微缩视窗样张
 *      04 存储位置 —— 浏览器下载 / Obsidian 库直写与文件名模板快速插值
 *      05 语音识别 —— 本地极速 ASR 服务与健康度检测
 *   · 底部：通透毛玻璃浮动操作底栏（防遮挡设计、呼吸态保存动效）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { browser } from 'wxt/browser';

import {
  PROVIDER_GROUPS,
  PROVIDER_PRESETS,
  listModels,
  normalizeBaseURL,
  hostPatternFromBaseURL,
  LlmError,
} from '@/lib/llm';
import {
  forgetObsidianDir,
  getSavedObsidianDir,
  pickObsidianDir,
  supportsFileSystemAccess,
} from '@/lib/export';
import {
  hasApiPermission,
  loadSettings,
  requestApiPermission,
  saveSettings,
} from '@/lib/storage';
import {
  DEFAULT_SETTINGS,
  getActiveProfile,
  makeProfile,
  newProfileId,
  type FontScale,
  type LlmProfile,
  type ProviderId,
  type SavedModelConfig,
  type Settings,
} from '@/lib/types';
import { FONT_SCALES, normalizeFontScale } from '@/lib/fontScale';
import { checkAsrHealth } from '@/lib/asr';

/* ================================================================== *
 * 状态
 * ================================================================== */

const settings = ref<Settings>(structuredClone(DEFAULT_SETTINGS));
const loaded = ref(false);

/** 已保存内容的快照，用于判断"是否有未保存改动" */
const savedSnapshot = ref('');

const saving = ref(false);
const savedFlash = ref(false);

const testing = ref(false);
const testResult = ref<{ ok: boolean; msg: string } | null>(null);

/** 是否明文查看 API 密钥 */
const showApiKey = ref(false);

/** 拉到的模型列表 */
const modelList = ref<string[]>([]);
const modelsFor = ref('');
const loadingModels = ref(false);
const modelErr = ref('');

const dirName = ref<string | null>(null);
const permGranted = ref(false);

const fsSupported = supportsFileSystemAccess();

/** 当前选中的模型预设 ID 与展示别名 */
const activeModelId = ref('');
const activeModelAlias = ref('');
const savedModelFlash = ref(false);

/* ================================================================== *
 * 载入
 * ================================================================== */

onMounted(async () => {
  settings.value = await loadSettings();
  if (settings.value.profiles.length === 0) {
    const first = makeProfile('custom', { baseURL: '', model: '' }, '自定义端点');
    settings.value = { ...settings.value, profiles: [first], activeProfileId: first.id };
  }
  initActiveModel();
  savedSnapshot.value = JSON.stringify(settings.value);
  loaded.value = true;

  dirName.value = (await getSavedObsidianDir())?.name ?? null;

  await refreshPermission();
  void refreshModels();
  await nextTick();
  setupSpy();
});

onUnmounted(() => {
  spy?.disconnect();
  spy = null;
});

async function refreshPermission(): Promise<void> {
  permGranted.value = await hasApiPermission(active.value?.baseURL ?? '');
}

async function onEndpointBlur(): Promise<void> {
  const p = active.value;
  if (!p) return;
  p.baseURL = normalizeBaseURL(p.baseURL);
  await refreshPermission();
  void refreshModels();
}

/* ================================================================== *
 * 当前配置 (Profiles)
 * ================================================================== */

const active = computed<LlmProfile | null>(() => getActiveProfile(settings.value));

async function selectProfile(id: string): Promise<void> {
  if (!settings.value.profiles.some((p) => p.id === id)) return;
  settings.value = { ...settings.value, activeProfileId: id };
  testResult.value = null;
  modelErr.value = '';
  await save();
  void refreshModels();
}

async function addProfile(): Promise<void> {
  const base = presets.find((p) => p.id === 'custom');
  const p = makeProfile('custom', { baseURL: base?.baseURL ?? '', model: '' }, '新配置');
  settings.value = {
    ...settings.value,
    profiles: [...settings.value.profiles, p],
    activeProfileId: p.id,
  };
  initActiveModel();
  testResult.value = null;
  modelErr.value = '';
  await save();
  void refreshModels();
}

async function removeProfile(id: string): Promise<void> {
  const target = settings.value.profiles.find((p) => p.id === id);
  if (!target) return;
  if (!confirm(`确定删除配置「${target.name}」吗？`)) return;

  const rest = settings.value.profiles.filter((p) => p.id !== id);
  const fallback =
    rest.length > 0 ? rest : [makeProfile('custom', { baseURL: '', model: '' }, '自定义端点')];
  const nextActive =
    settings.value.activeProfileId === id ? (fallback[0]?.id ?? '') : settings.value.activeProfileId;

  settings.value = { ...settings.value, profiles: fallback, activeProfileId: nextActive };
  initActiveModel();
  testResult.value = null;
  modelErr.value = '';
  await save();
  void refreshModels();
}

async function refreshModels(): Promise<void> {
  const p = active.value;
  modelList.value = [];
  modelErr.value = '';

  if (!p?.baseURL.trim()) return;
  if (!(await hasApiPermission(p.baseURL))) return;

  const token = p.id;
  loadingModels.value = true;
  try {
    const models = await listModels(p);
    if (active.value?.id !== token) return;
    modelsFor.value = token;
    modelList.value = models;
    if (models.length === 0) modelErr.value = '该端点未返回模型列表，请手动填写模型名';
  } catch (e) {
    if (e instanceof LlmError && (e.status === 401 || e.status === 403)) {
      modelErr.value = '请填写 API 密钥，授权后会自动拉取模型列表';
    } else if (e instanceof LlmError) {
      modelErr.value = `拉取模型列表失败（${e.message}），可手动填写模型名`;
    } else {
      modelErr.value = '拉取模型列表失败，可手动填写模型名';
    }
  } finally {
    loadingModels.value = false;
  }
}

/* ================================================================== *
 * 派生状态与预设
 * ================================================================== */

const presets = PROVIDER_PRESETS;

const groupedProviders = computed(() =>
  PROVIDER_GROUPS.map((g) => ({
    ...g,
    items: presets.filter((p) => p.group === g.id),
  })).filter((g) => g.items.length > 0),
);

const currentPreset = computed(
  () => presets.find((p) => p.id === active.value?.provider) ?? null,
);

const hostPattern = computed(() => hostPatternFromBaseURL(active.value?.baseURL ?? ''));

const needsPermission = computed(() => !!hostPattern.value && !permGranted.value);

const modelConfigured = computed(
  () => !!active.value?.baseURL.trim() && !!active.value?.model.trim(),
);

const obscureDirEnabled = computed(
  () => settings.value.saveMode === 'obsidian' && settings.value.obsidian.enabled && !!dirName.value,
);

const tempOffRange = computed(
  () => (active.value?.temperature ?? 0.3) > 0.5 || (active.value?.temperature ?? 0.3) < 0.1,
);

const dirty = computed(
  () => loaded.value && JSON.stringify(settings.value) !== savedSnapshot.value,
);

/** 顶部实时状态摘要 */
const summary = computed(() => {
  const p = active.value;
  return [
    {
      key: '当前模型',
      value: modelConfigured.value
        ? `${p?.name || currentPreset.value?.label || '自定义'} · ${activeModelAlias.value || p?.model}${p?.contextWindow ? ` (${formatTokens(p.contextWindow)})` : ''}`
        : '未配置',
      ok: modelConfigured.value,
      badge: modelConfigured.value ? '已就绪' : '待配置',
    },
    {
      key: '问答附带位置',
      value: settings.value.sendPlayhead ? '当前播放点' : '全局问答',
      ok: true,
      badge: settings.value.sendPlayhead ? '开' : '关',
    },
    {
      key: '笔记保存方式',
      value: obscureDirEnabled.value ? `Obsidian · ${dirName.value}` : '浏览器下载',
      ok: true,
      badge: obscureDirEnabled.value ? '库直写' : '下载',
    },
    {
      key: '本地 ASR 引擎',
      value: settings.value.localAsr?.enabled ? '生肉自动转录' : '已关闭',
      ok: settings.value.localAsr?.enabled,
      badge: settings.value.localAsr?.enabled ? 'GPU 加速' : '未开启',
    },
  ];
});

type LogoPath =
  | '/logos/siliconflow.png'
  | '/logos/deepseek.svg'
  | '/logos/moonshot.png'
  | '/logos/zhipu.png'
  | '/logos/openai.png'
  | '/logos/openrouter.svg'
  | '/logos/ollama.svg'
  | '/logos/bilibili.svg';

function assetUrl(path: LogoPath | '/icons/icon48.png'): string {
  return browser.runtime.getURL(path);
}

function logoUrl(file?: string): string | null {
  return file ? assetUrl(`/logos/${file}` as LogoPath) : null;
}

function applyPreset(id: ProviderId): void {
  const p = presets.find((x) => x.id === id);
  const cur = active.value;
  if (!p || !cur) return;

  const before = presets.find((x) => x.id === cur.provider);

  cur.provider = id;
  if (id !== 'custom') {
    cur.baseURL = p.baseURL;
    cur.model = p.model;
    cur.contextWindow = 0;
    cur.maxTokens = 0;
    if (!cur.name || cur.name === before?.label) cur.name = p.label;
    const initialModel: SavedModelConfig = {
      id: newProfileId(),
      name: p.model,
      model: p.model,
      contextWindow: 0,
      maxTokens: 0,
      temperature: cur.temperature ?? 0.3,
      reasoningEffort: cur.reasoningEffort,
      supportsVision: cur.supportsVision,
    };
    cur.models = [initialModel];
    activeModelId.value = initialModel.id;
    activeModelAlias.value = initialModel.name || '';
  }
  testResult.value = null;
  modelList.value = [];
  modelsFor.value = '';
  modelErr.value = '';
  void refreshPermission().then(() => refreshModels());
}

/* ================================================================== *
 * 连通性
 * ================================================================== */

type ConnState = 'ok' | 'need-permission' | 'testing' | 'failed' | 'unconfigured';

const connState = computed<ConnState>(() => {
  if (!(active.value?.baseURL ?? '').trim()) return 'unconfigured';
  if (testing.value) return 'testing';
  if (testResult.value && !testResult.value.ok) return 'failed';
  if (needsPermission.value) return 'need-permission';
  return 'ok';
});

const connTitle = computed(() => {
  switch (connState.value) {
    case 'unconfigured':
      return '尚未填写 API 地址';
    case 'testing':
      return '正在向端点测试连接…';
    case 'failed':
      return '连接或验证失败';
    case 'need-permission':
      return '需要授权端点域名';
    default:
      return '域名已授权，服务已就绪';
  }
});

const connNote = computed(() => {
  switch (connState.value) {
    case 'unconfigured':
      return '请选择常用服务商预设，或填入你自己的 OpenAI 兼容端点';
    case 'testing':
      return '正在验证 HTTP 连通性并拉取模型列表';
    case 'failed':
      return testResult.value?.msg ?? '网络请求未成功响应';
    case 'need-permission':
      return '浏览器要求逐个域名授予网络请求权限，插件才能正常调用模型';
    default:
      return testResult.value?.ok ? testResult.value.msg : `已授权 ${hostPattern.value ?? ''}`;
  }
});

async function grantPermission(): Promise<void> {
  const ok = await requestApiPermission(active.value?.baseURL ?? '');
  permGranted.value = ok;
  if (ok) {
    testResult.value = null;
    void refreshModels();
  } else {
    testResult.value = { ok: false, msg: '授权被取消。无该域名访问权限，插件无法调用模型服务。' };
  }
}

async function testConnection(): Promise<void> {
  const p = active.value;
  if (!p) return;

  testing.value = true;
  testResult.value = null;
  modelList.value = [];

  try {
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);
    await refreshPermission();

    if (needsPermission.value) {
      testResult.value = { ok: false, msg: '尚未授权该域名，请先点击「立即授权」。' };
      return;
    }

    const models = await listModels(p);
    modelsFor.value = p.id;
    modelList.value = models;

    const hit = !p.model || models.includes(p.model);
    testResult.value = {
      ok: true,
      msg: models.length
        ? `连接成功，返回 ${models.length} 个模型${hit ? '' : '（当前模型名不在列表中，请检查拼写）'}`
        : '连接成功。该端点支持调用，但未公开模型列表',
    };
  } catch (e) {
    const msg =
      e instanceof LlmError
        ? `${e.message}${e.status ? `（HTTP ${e.status}）` : ''}`
        : e instanceof Error
          ? e.message
          : String(e);
    testResult.value = { ok: false, msg };
  } finally {
    testing.value = false;
  }
}

function onModelPick(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  const p = active.value;
  if (!p) return;
  if (v === '__manual__') {
    manualModel.value = true;
    return;
  }
  p.model = v;
  if (!activeModelAlias.value || activeModelAlias.value === activeModelId.value) {
    activeModelAlias.value = v;
  }
  manualModel.value = false;
}

const manualModel = ref(false);

const modelSelectValue = computed(() => {
  const p = active.value;
  if (!p) return '';
  if (manualModel.value) return '__manual__';
  return modelList.value.includes(p.model) ? p.model : '__manual__';
});

/* ================================================================== *
 * 服务商模型库与精准参数管理 (Saved Models & Workbench)
 * ================================================================== */

const savedModels = computed<SavedModelConfig[]>(() => {
  const p = active.value;
  if (!p) return [];
  if (!Array.isArray(p.models)) p.models = [];
  return p.models;
});

function initActiveModel(): void {
  const p = active.value;
  if (!p) return;
  if (!Array.isArray(p.models) || p.models.length === 0) {
    p.models = [
      {
        id: newProfileId(),
        name: p.model || '默认模型',
        model: p.model,
        contextWindow: p.contextWindow ?? 0,
        maxTokens: p.maxTokens ?? 0,
        temperature: p.temperature ?? 0.3,
        reasoningEffort: p.reasoningEffort,
        supportsVision: p.supportsVision,
      },
    ];
  }
  const matched = p.models.find((m) => m.model === p.model) ?? p.models[0];
  if (matched) {
    activeModelId.value = matched.id;
    activeModelAlias.value = matched.name || matched.model;
  }
}

function selectSavedModel(m: SavedModelConfig): void {
  const p = active.value;
  if (!p) return;
  activeModelId.value = m.id;
  activeModelAlias.value = m.name || m.model;
  p.model = m.model;
  p.contextWindow = m.contextWindow ?? 0;
  p.maxTokens = m.maxTokens ?? 0;
  if (typeof m.temperature === 'number') p.temperature = m.temperature;
  if (m.reasoningEffort !== undefined) p.reasoningEffort = m.reasoningEffort;
  if (m.supportsVision !== undefined) p.supportsVision = m.supportsVision;
  manualModel.value = false;
  void save();
}

function startNewModel(): void {
  const p = active.value;
  if (!p) return;
  activeModelId.value = newProfileId();
  activeModelAlias.value = '';
  p.model = '';
  p.contextWindow = 0;
  p.maxTokens = 0;
  manualModel.value = true;
}

function saveCurrentModel(): void {
  const p = active.value;
  if (!p) return;
  if (!Array.isArray(p.models)) p.models = [];

  const existingIdx = p.models.findIndex((m) => m.id === activeModelId.value);
  const name = activeModelAlias.value.trim() || p.model || '未命名模型';

  const cfg: SavedModelConfig = {
    id: activeModelId.value || newProfileId(),
    name,
    model: p.model,
    contextWindow: p.contextWindow ?? 0,
    maxTokens: p.maxTokens ?? 0,
    temperature: p.temperature,
    reasoningEffort: p.reasoningEffort,
    supportsVision: p.supportsVision,
  };

  if (existingIdx >= 0) {
    p.models[existingIdx] = cfg;
  } else {
    p.models.push(cfg);
    activeModelId.value = cfg.id;
  }

  void save();
  savedModelFlash.value = true;
  window.setTimeout(() => (savedModelFlash.value = false), 2000);
}

function removeSavedModel(id: string): void {
  const p = active.value;
  if (!p || !Array.isArray(p.models)) return;
  const target = p.models.find((m) => m.id === id);
  if (!target) return;
  if (!confirm(`确定从服务商中删除模型预设「${target.name || target.model}」吗？`)) return;

  p.models = p.models.filter((m) => m.id !== id);
  if (p.models.length === 0) {
    const fallback: SavedModelConfig = {
      id: newProfileId(),
      name: p.model || '默认模型',
      model: p.model,
      contextWindow: p.contextWindow ?? 0,
      maxTokens: p.maxTokens ?? 0,
      temperature: p.temperature ?? 0.3,
      reasoningEffort: p.reasoningEffort,
      supportsVision: p.supportsVision,
    };
    p.models = [fallback];
    selectSavedModel(fallback);
  } else if (activeModelId.value === id) {
    if (p.models[0]) {
      selectSavedModel(p.models[0]);
    }
  } else {
    void save();
  }
}

function setContextWindowPreset(tokens: number): void {
  const p = active.value;
  if (!p) return;
  p.contextWindow = tokens;
}

function setMaxTokensPreset(tokens: number): void {
  const p = active.value;
  if (!p) return;
  p.maxTokens = tokens;
}

function formatTokens(n: number | undefined): string {
  if (!n || n <= 0) return '默认';
  if (n >= 1048576) return `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

/* ================================================================== *
 * Obsidian
 * ================================================================== */

async function chooseDir(): Promise<void> {
  try {
    dirName.value = await pickObsidianDir();
    settings.value.obsidian.enabled = true;
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    testResult.value = { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

async function clearDir(): Promise<void> {
  await forgetObsidianDir();
  dirName.value = null;
  settings.value.obsidian.enabled = false;
  await saveSettings(settings.value);
  savedSnapshot.value = JSON.stringify(settings.value);
}

function insertTemplateVar(variable: string): void {
  settings.value.obsidian.filenameTemplate += `{${variable}}`;
}

/* ================================================================== *
 * 本地 ASR
 * ================================================================== */

const asrTesting = ref(false);
const asrTestResult = ref<{ ok: boolean; msg: string } | null>(null);

async function testAsrConnection(): Promise<void> {
  if (!settings.value.localAsr.endpoint.trim()) return;
  asrTesting.value = true;
  asrTestResult.value = null;

  try {
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);

    const res = await checkAsrHealth(settings.value.localAsr.endpoint);
    asrTestResult.value = {
      ok: res.ok,
      msg: res.ok ? `服务正常：${res.message}` : `服务异常：${res.message}`,
    };
  } catch (e) {
    asrTestResult.value = {
      ok: false,
      msg: e instanceof Error ? e.message : String(e),
    };
  } finally {
    asrTesting.value = false;
  }
}

/* ================================================================== *
 * 保存与重置
 * ================================================================== */

async function save(): Promise<void> {
  saving.value = true;
  try {
    const p = active.value;
    if (p) p.baseURL = normalizeBaseURL(p.baseURL);
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);
    await refreshPermission();

    savedFlash.value = true;
    window.setTimeout(() => (savedFlash.value = false), 2400);
  } finally {
    saving.value = false;
  }
}

function resetAll(): void {
  if (!confirm('确定恢复默认设置？已保存的配置与 API 密钥都会被清空。')) return;
  const fresh = structuredClone(DEFAULT_SETTINGS);
  const first = makeProfile('custom', { baseURL: '', model: '' }, '自定义端点');
  settings.value = { ...fresh, profiles: [first], activeProfileId: first.id };
  manualModel.value = false;
  modelList.value = [];
  initActiveModel();
  void save();
}

watch(
  () => settings.value.activeProfileId,
  () => {
    manualModel.value = false;
    testResult.value = null;
    initActiveModel();
  },
);

/* ================================================================== *
 * 导航目录与监听
 * ================================================================== */

const SECTIONS = [
  { id: 'sec-model', no: '01', title: '大模型', desc: '端点、密钥与模型配置' },
  { id: 'sec-behavior', no: '02', title: '聊天', desc: '对话习惯与自动触发' },
  { id: 'sec-display', no: '03', title: '外观', desc: '侧边栏字号与排版样张' },
  { id: 'sec-output', no: '04', title: '保存位置', desc: 'Obsidian 库与下载模式' },
  { id: 'sec-asr', no: '05', title: '语音识别', desc: '本地极速 Qwen3-ASR 兜底' },
] as const;

const activeSection = ref<string>('sec-model');
let spy: IntersectionObserver | null = null;

function setupSpy(): void {
  spy?.disconnect();
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) activeSection.value = (e.target as HTMLElement).id;
      }
    },
    { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
  );

  for (const s of SECTIONS) {
    const el = document.getElementById(s.id);
    if (el) spy.observe(el);
  }
}

function goSection(id: string): void {
  activeSection.value = id;
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ================================================================== *
 * 外观字号与样张
 * ================================================================== */

const fontScales = FONT_SCALES;

const fontScale = computed<FontScale>(() => normalizeFontScale(settings.value.fontScale));

const currentFontRatio = computed(() => {
  return FONT_SCALES.find((f) => f.id === fontScale.value)?.ratio ?? 1;
});

const sampleFontSize = computed(() => `${13 * currentFontRatio.value}px`);

function sectionDone(id: string): boolean {
  if (id === 'sec-model') return modelConfigured.value;
  if (id === 'sec-asr') return !settings.value.localAsr.enabled || !!settings.value.localAsr.endpoint.trim();
  return true;
}
</script>

<template>
  <div v-if="loaded" class="page">
    <!-- ============ 顶部 Masthead ============ -->
    <header class="masthead">
      <div class="masthead__brand">
        <div class="masthead__mark-box">
          <img class="masthead__mark" :src="assetUrl('/icons/icon48.png')" alt="BiliLens Logo" />
        </div>
        <div class="masthead__text">
          <div class="masthead__title-row">
            <h1>BiliLens</h1>
            <span class="masthead__badge">设置工作台</span>
          </div>
          <p>把 B站长视频提炼为带时间戳与精准对齐的结构化高能笔记</p>
        </div>
      </div>

      <div class="masthead__bili">
        <img :src="assetUrl('/logos/bilibili.svg')" alt="" />
        <span>适用于 bilibili 视频与番剧</span>
      </div>
    </header>

    <!-- ============ 实时配置状态卡片栏 ============ -->
    <section class="summary" aria-label="当前运行摘要">
      <div v-for="s in summary" :key="s.key" class="summary__cell">
        <div class="summary__meta">
          <span class="summary__key">{{ s.key }}</span>
          <span class="summary__badge" :class="{ 'summary__badge--ok': s.ok }">{{ s.badge }}</span>
        </div>
        <div class="summary__val-wrap">
          <span class="summary__dot" :class="{ 'summary__dot--ok': s.ok }" />
          <span class="summary__val" :class="{ 'summary__val--off': !s.ok }" :title="s.value">
            {{ s.value }}
          </span>
        </div>
      </div>
    </section>

    <!-- ============ 主体双栏布局 ============ -->
    <div class="layout">
      <!-- 左侧精密导航侧栏 -->
      <aside class="toc-col">
        <nav class="toc" aria-label="设置导航">
          <div class="toc__header">
            <span class="toc__caption">配置导航</span>
            <span class="toc__count">5 项</span>
          </div>

          <div class="toc__list">
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              class="toc__item"
              :class="{ 'toc__item--on': activeSection === s.id }"
              :aria-current="activeSection === s.id ? 'true' : undefined"
              @click="goSection(s.id)"
            >
              <div class="toc__icon-wrap">
                <!-- 01 大模型 -->
                <svg v-if="s.id === 'sec-model'" viewBox="0 0 24 24" class="toc__icon" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                <!-- 02 聊天 -->
                <svg v-else-if="s.id === 'sec-behavior'" viewBox="0 0 24 24" class="toc__icon" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <!-- 03 外观 -->
                <svg v-else-if="s.id === 'sec-display'" viewBox="0 0 24 24" class="toc__icon" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                  <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                  <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                  <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
                </svg>
                <!-- 04 保存 -->
                <svg v-else-if="s.id === 'sec-output'" viewBox="0 0 24 24" class="toc__icon" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <!-- 05 语音识别 -->
                <svg v-else viewBox="0 0 24 24" class="toc__icon" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </div>

              <div class="toc__text">
                <div class="toc__title-row">
                  <span class="toc__no tnum">{{ s.no }}</span>
                  <span class="toc__title">{{ s.title }}</span>
                </div>
                <span class="toc__desc">{{ s.desc }}</span>
              </div>

              <span class="toc__state" :class="{ 'toc__state--done': sectionDone(s.id) }">
                {{ sectionDone(s.id) ? '✓' : '·' }}
              </span>
            </button>
          </div>
        </nav>
      </aside>

      <!-- 右侧聚焦面板区域 -->
      <main class="panes">
        <!-- ================= 01 大模型 ================= -->
        <section id="sec-model" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">01</span>
            <div class="pane__head-info">
              <h2>大模型配置</h2>
              <p>支持任何兼容 OpenAI 协议的云端或本地端点。多套配置即切即用，独立记忆密钥与模型。</p>
            </div>
          </div>

          <!-- 模型配置档案胶囊切换栏 -->
          <div class="field">
            <div class="picks__head">
              <label class="label">配置档案 (Profiles)</label>
              <button class="btn btn--ghost btn--sm" @click="addProfile">
                <span class="btn__plus">+</span> 新建配置
              </button>
            </div>

            <div class="picks-grid">
              <div
                v-for="p in settings.profiles"
                :key="p.id"
                class="pick-card"
                :class="{ 'pick-card--on': p.id === settings.activeProfileId }"
              >
                <button
                  class="pick-card__main"
                  :title="p.baseURL || '尚未填写地址'"
                  @click="selectProfile(p.id)"
                >
                  <span class="pick-card__radio" aria-hidden="true" />
                  <div class="pick-card__info">
                    <span class="pick-card__name">{{ p.name }}</span>
                    <div class="pick-card__tags">
                      <span class="pick-card__model tnum">{{ p.model || '未选择模型' }}</span>
                      <span v-if="p.supportsVision" class="tag tag--vision">视觉支持</span>
                    </div>
                  </div>
                </button>
                <button
                  v-if="settings.profiles.length > 1"
                  class="pick-card__del"
                  title="删除此配置"
                  @click="removeProfile(p.id)"
                >
                  ×
                </button>
              </div>
            </div>

            <p class="hint">
              💡 随时在云端商业端点与本地局域网（如 Ollama）间一键切换，侧边栏无缝共享。
            </p>
          </div>

          <template v-if="active">
            <!-- 配置别名 -->
            <div class="field">
              <label class="label" for="pname">配置别名</label>
              <input
                id="pname"
                v-model="active.name"
                class="input"
                type="text"
                placeholder="例如：DeepSeek 官方 / 本地 GPU 实验"
              />
            </div>

            <!-- 服务商精炼磁贴 -->
            <div class="field">
              <label class="label">选择服务商预设</label>

              <div v-for="g in groupedProviders" :key="g.id" class="group">
                <div class="group__head">
                  <span class="group__title">{{ g.title }}</span>
                  <span class="group__note">{{ g.note }}</span>
                </div>

                <div class="cards">
                  <button
                    v-for="p in g.items"
                    :key="p.id"
                    class="card"
                    :class="{ 'card--on': active.provider === p.id }"
                    :title="p.hint ?? p.baseURL"
                    @click="applyPreset(p.id)"
                  >
                    <span v-if="logoUrl(p.logo)" class="logo-tile card__logo">
                      <img :src="logoUrl(p.logo)!" alt="" />
                    </span>
                    <span v-else class="logo-tile card__logo card__logo--text">
                      {{ p.label.slice(0, 1) }}
                    </span>

                    <span class="card__body">
                      <span class="card__name">{{ p.label }}</span>
                      <span class="card__blurb">{{ p.blurb }}</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 凭据与地址整合区 -->
            <div class="card-box">
              <div class="two">
                <div class="field">
                  <label class="label" for="baseurl">API 接口地址 (Base URL)</label>
                  <div class="input-wrap">
                    <input
                      id="baseurl"
                      v-model="active.baseURL"
                      class="input input--code"
                      type="text"
                      placeholder="https://api.deepseek.com/v1"
                      spellcheck="false"
                      @blur="onEndpointBlur"
                    />
                  </div>
                  <p class="hint">填写至 <code>/v1</code> 根路径，BiliLens 会自动规范请求端点</p>
                </div>

                <div class="field">
                  <label class="label" for="apikey">API 密钥 (API Key)</label>
                  <div class="input-action-wrap">
                    <input
                      id="apikey"
                      v-model="active.apiKey"
                      class="input input--secret"
                      :type="showApiKey ? 'text' : 'password'"
                      placeholder="sk-…"
                      spellcheck="false"
                      autocomplete="off"
                    />
                    <button
                      type="button"
                      class="input-icon-btn"
                      :title="showApiKey ? '隐藏密钥' : '显示明文'"
                      @click="showApiKey = !showApiKey"
                    >
                      {{ showApiKey ? '🙈' : '👁️' }}
                    </button>
                  </div>
                  <p class="hint">密钥严格保存在本地存储中，绝不上传任何第三方代理</p>
                </div>
              </div>
            </div>

            <!-- 服务商已保存模型库 (可多模型自由保存与一键切换) -->
            <div class="field">
              <div class="picks__head">
                <div class="picks__meta">
                  <label class="label">服务商模型库 (Configured Models)</label>
                  <span class="picks__sub">独立保存该端点下的多个模型，切换即刻载入专属上下文与生成参数</span>
                </div>
                <button type="button" class="btn btn--ghost btn--sm" @click="startNewModel">
                  <span class="btn__plus">+</span> 新增模型
                </button>
              </div>

              <div v-if="savedModels.length" class="model-chips-grid">
                <div
                  v-for="m in savedModels"
                  :key="m.id"
                  class="model-chip"
                  :class="{ 'model-chip--on': m.id === activeModelId || (!activeModelId && m.model === active.model) }"
                >
                  <button
                    type="button"
                    class="model-chip__main"
                    :title="`模型 ID: ${m.model}`"
                    @click="selectSavedModel(m)"
                  >
                    <span class="model-chip__radio" aria-hidden="true" />
                    <div class="model-chip__info">
                      <span class="model-chip__name">{{ m.name || m.model }}</span>
                      <span class="model-chip__id tnum">{{ m.model || '未设定模型' }}</span>
                      <div class="model-chip__badges">
                        <span class="tag tag--ctx tnum">
                          {{ m.contextWindow ? `${formatTokens(m.contextWindow)} 窗口` : '默认窗口' }}
                        </span>
                        <span v-if="m.maxTokens" class="tag tag--tok tnum">
                          Max {{ formatTokens(m.maxTokens) }}
                        </span>
                        <span v-if="m.supportsVision" class="tag tag--vision">视觉</span>
                      </div>
                    </div>
                  </button>
                  <button
                    v-if="savedModels.length > 1"
                    type="button"
                    class="model-chip__del"
                    title="从当前服务商中删除此模型预设"
                    @click="removeSavedModel(m.id)"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>

            <!-- 当前模型精准参数工作台 -->
            <div class="workbench">
              <div class="workbench__head">
                <div class="workbench__title-row">
                  <span class="workbench__tag">参数工作台</span>
                  <span class="workbench__model tnum">{{ activeModelAlias || active.model || '未设定模型' }}</span>
                </div>
                <p class="workbench__desc">
                  针对当前选中的模型独立调整上下文预算与输出限制。调优完毕后点击下方「保存当前模型配置」。
                </p>
              </div>

              <!-- 模型选择与别名 -->
              <div class="two">
                <div class="field">
                  <div class="label-row">
                    <label class="label" for="model">模型名称 / 标识 (Model ID)</label>
                    <button
                      type="button"
                      class="link-action"
                      :disabled="loadingModels || !active.baseURL"
                      @click="refreshModels"
                    >
                      {{ loadingModels ? '拉取中…' : '🔄 刷新模型' }}
                    </button>
                  </div>

                  <select
                    v-if="modelList.length"
                    id="model"
                    class="input select"
                    :value="modelSelectValue"
                    @change="onModelPick"
                  >
                    <option v-for="m in modelList" :key="m" :value="m">{{ m }}</option>
                    <option value="__manual__">✍️ 手动指定其他模型名称…</option>
                  </select>

                  <input
                    v-if="!modelList.length || manualModel"
                    id="model-manual"
                    v-model="active.model"
                    class="input"
                    :class="{ 'input--stacked': modelList.length }"
                    type="text"
                    placeholder="例如：deepseek-chat 或 qwen-plus"
                    spellcheck="false"
                  />

                  <p v-if="loadingModels" class="hint hint--info">正在向该端点请求可用模型列表…</p>
                  <p v-else-if="modelErr" class="hint hint--warn">{{ modelErr }}</p>
                  <p v-else-if="modelList.length" class="hint hint--ok">
                    已拉取 {{ modelList.length }} 个模型，在下拉框中点选即生效
                  </p>
                  <p v-else class="hint">填入地址与密钥后点击测试或刷新，将自动列出所有模型</p>
                </div>

                <div class="field">
                  <label class="label" for="model-alias">展示别名 (Model Alias)</label>
                  <input
                    id="model-alias"
                    v-model="activeModelAlias"
                    class="input"
                    type="text"
                    placeholder="例如：DeepSeek V3 (日常主力)"
                  />
                  <p class="hint">便于在侧边栏与模型库中直观区分，如标注模型版本或特定用途</p>
                </div>
              </div>

              <!-- 上下文窗口与最大输出 (带快捷档位按钮) -->
              <div class="two">
                <div class="field">
                  <div class="label-row">
                    <label class="label" for="ctxwindow">上下文窗口容量 (Context Window)</label>
                    <span class="label__num tnum">{{ formatTokens(active.contextWindow) }}</span>
                  </div>
                  <input
                    id="ctxwindow"
                    v-model.number="active.contextWindow"
                    class="input tnum"
                    type="number"
                    min="0"
                    step="1024"
                    placeholder="0（默认自适应）"
                  />
                  <div class="pill-presets">
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': (active.contextWindow ?? 0) === 0 }"
                      @click="setContextWindowPreset(0)"
                    >
                      默认
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 16384 }"
                      @click="setContextWindowPreset(16384)"
                    >
                      16k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 32768 }"
                      @click="setContextWindowPreset(32768)"
                    >
                      32k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 65536 }"
                      @click="setContextWindowPreset(65536)"
                    >
                      64k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 131072 }"
                      @click="setContextWindowPreset(131072)"
                    >
                      128k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 262144 }"
                      @click="setContextWindowPreset(262144)"
                    >
                      256k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.contextWindow === 1048576 }"
                      @click="setContextWindowPreset(1048576)"
                    >
                      1M
                    </button>
                  </div>
                  <p class="hint">
                    💡 智能字幕预算：BiliLens 将据此动态压缩长视频字幕，避免超出模型上下文报错 400
                  </p>
                </div>

                <div class="field">
                  <div class="label-row">
                    <label class="label" for="maxtok">单次最大输出 (Max Tokens)</label>
                    <span class="label__num tnum">{{ active.maxTokens ? formatTokens(active.maxTokens) : '不限' }}</span>
                  </div>
                  <input
                    id="maxtok"
                    v-model.number="active.maxTokens"
                    class="input tnum"
                    type="number"
                    min="0"
                    step="512"
                    placeholder="0（不限）"
                  />
                  <div class="pill-presets">
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': (active.maxTokens ?? 0) === 0 }"
                      @click="setMaxTokensPreset(0)"
                    >
                      不限
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.maxTokens === 2048 }"
                      @click="setMaxTokensPreset(2048)"
                    >
                      2k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.maxTokens === 4096 }"
                      @click="setMaxTokensPreset(4096)"
                    >
                      4k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.maxTokens === 8192 }"
                      @click="setMaxTokensPreset(8192)"
                    >
                      8k
                    </button>
                    <button
                      type="button"
                      class="pill-preset"
                      :class="{ 'pill-preset--on': active.maxTokens === 16384 }"
                      @click="setMaxTokensPreset(16384)"
                    >
                      16k
                    </button>
                  </div>
                  <p class="hint">设为 0 时不作人为截断，由服务端根据模型原生窗口上限完整输出</p>
                </div>
              </div>

              <!-- 多样性与思考链深度 -->
              <div class="two">
                <div class="field">
                  <div class="label-row">
                    <label class="label" for="temp">生成多样性 (Temperature)</label>
                    <span class="label__num tnum">{{ active.temperature.toFixed(1) }}</span>
                  </div>
                  <input
                    id="temp"
                    v-model.number="active.temperature"
                    class="range"
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                  />
                  <p class="hint" :class="{ 'hint--warn': tempOffRange }">
                    {{
                      tempOffRange
                        ? '⚠️ 数值偏高，容易出现发散或幻觉。建议设定在 0.2 ~ 0.4'
                        : '当前为黄金区间，生成结论准确并严格忠实于原视频'
                    }}
                  </p>
                </div>

                <div class="field">
                  <label class="label" for="effort">思考链深度 (Reasoning Effort)</label>
                  <select id="effort" v-model="active.reasoningEffort" class="input select">
                    <option value="">default（由模型自行权衡）</option>
                    <option value="low">low（轻量快速思考）</option>
                    <option value="medium">medium（标准深度推理）</option>
                    <option value="high">high（充分展开推演）</option>
                    <option value="xhigh">xhigh（极深思考链）</option>
                    <option value="max">max（最强计算预算）</option>
                  </select>
                  <p class="hint">仅对支持思考模式的模型生效；常规模型会自动忽略该参数</p>
                </div>
              </div>

              <!-- 图像理解卡片 -->
              <div class="field">
                <label class="label">图像理解 (Vision)</label>
                <label class="toggle-card">
                  <input v-model="active.supportsVision" type="checkbox" />
                  <span class="toggle__box" />
                  <div class="toggle-card__text">
                    <strong>支持聊天粘贴截图</strong>
                    <p>模型支持多模态识图时开启，可在侧边栏直接贴图追问</p>
                  </div>
                </label>
              </div>

              <!-- 工作台保存条 -->
              <div class="workbench__action-bar">
                <div class="workbench__action-info">
                  <span v-if="savedModelFlash" class="save-toast">✓ 已保存至服务商模型库</span>
                  <span v-else class="workbench__action-tip">已在此配置独立维护该模型的各项参数</span>
                </div>
                <button type="button" class="btn btn--primary btn--sm" @click="saveCurrentModel">
                  💾 保存当前模型配置
                </button>
              </div>
            </div>

            <!-- 连通性健康指示面板 -->
            <div class="conn" :class="`conn--${connState}`">
              <span class="conn__dot" />
              <div class="conn__body">
                <p class="conn__title">{{ connTitle }}</p>
                <p class="conn__note">{{ connNote }}</p>
                <p v-if="hostPattern" class="conn__host tnum">权限规则: {{ hostPattern }}</p>
              </div>
              <div class="conn__acts">
                <button
                  v-if="needsPermission"
                  class="btn btn--primary btn--sm"
                  @click="grantPermission"
                >
                  立即授权域名
                </button>
                <button
                  class="btn btn--sm"
                  :disabled="testing || needsPermission || !active.baseURL"
                  @click="testConnection"
                >
                  {{ testing ? '测试中…' : '测试连接' }}
                </button>
              </div>
            </div>
          </template>
        </section>

        <!-- ================= 02 聊天 ================= -->
        <section id="sec-behavior" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">02</span>
            <div class="pane__head-info">
              <h2>聊天与交互行为</h2>
              <p>决定侧边栏向视频提问时的上下文构造逻辑与自动化行为。</p>
            </div>
          </div>

          <div class="toggles-grid">
            <label class="toggle toggle-interactive">
              <input v-model="settings.sendPlayhead" type="checkbox" />
              <span class="toggle__box" />
              <div class="toggle__text">
                <strong>提问时默认附带播放进度</strong>
                <em>
                  开启后向模型追加「当前观看至 mm:ss」；关闭时模型仅回答全视频综合脉络。
                </em>
              </div>
            </label>

            <label class="toggle toggle-interactive">
              <input v-model="settings.autoRun" type="checkbox" />
              <span class="toggle__box" />
              <div class="toggle__text">
                <strong>打开视频播放页自动开始解析</strong>
                <em>
                  进入播放页后无需手动点击「生成笔记」，自动开始调用模型。
                </em>
              </div>
            </label>
          </div>
        </section>

        <!-- ================= 03 外观 ================= -->
        <section id="sec-display" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">03</span>
            <div class="pane__head-info">
              <h2>阅读外观与排版样张</h2>
              <p>调节侧边栏正文、标题与公式的字号比例。通过微缩视窗实时预览排版效果。</p>
            </div>
          </div>

          <div class="field">
            <label class="label">侧边栏字号比例</label>

            <div class="sizes">
              <button
                v-for="f in fontScales"
                :key="f.id"
                class="size"
                :class="{ 'size--on': fontScale === f.id }"
                @click="settings.fontScale = f.id"
              >
                <span class="size__preview" :style="{ fontSize: `${12 * f.ratio}px` }">Aa</span>
                <span class="size__label">{{ f.label }}</span>
                <span class="size__ratio tnum">{{ f.ratio.toFixed(2) }}x</span>
              </button>
            </div>

            <!-- macOS 风格实时视窗微缩样张 -->
            <div class="mock-window">
              <div class="mock-window__bar">
                <div class="mock-window__controls">
                  <span class="mock-dot mock-dot--red" />
                  <span class="mock-dot mock-dot--yellow" />
                  <span class="mock-dot mock-dot--green" />
                </div>
                <span class="mock-window__title">BiliLens 侧边栏实时排版视窗</span>
                <span class="mock-window__ratio-badge tnum">{{ (currentFontRatio * 100).toFixed(0) }}% 渲染</span>
              </div>

              <div class="sample" :style="{ fontSize: sampleFontSize }">
                <div class="sample__header-row">
                  <span class="sample__time tnum">[03:42]</span>
                  <span class="sample__title">第三章：Transformer 结构与长文本注意机制</span>
                </div>
                <div class="sample__content">
                  <p class="sample__body">
                    自注意力权重计算公式体现为矩阵点积缩放：
                    <span class="sample__formula">$$\mathrm{Attention}(Q,K,V) = \mathrm{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V$$</span>
                    在侧边栏中，不论是核心段落、嵌套列表还是数学公式，都将严格按照当前选中的字号比例进行自适应放大。
                  </p>
                  <ul class="sample__list">
                    <li>列表第一级要点：行间距自动与字号倍率对齐，保持极高阅读清晰度。</li>
                    <li>
                      二级细分拆解：即使在深色模式下，文字与时间戳也保持精密层次。
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <p class="hint">
              设置页本身固定保持标准字号，以防误调过大无法还原；所作改动将在保存后即时同步至侧边栏。
            </p>
          </div>
        </section>

        <!-- ================= 04 保存位置 ================= -->
        <section id="sec-output" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">04</span>
            <div class="pane__head-info">
              <h2>存储与笔记导出</h2>
              <p>决定生成的 Markdown 笔记流向：直接下载至系统目录，或实时同步到本地知识库。</p>
            </div>
          </div>

          <div class="field">
            <label class="label">笔记存储目标</label>
            <div class="seg">
              <button
                class="seg__item"
                :class="{ 'seg__item--on': settings.saveMode === 'download' }"
                @click="settings.saveMode = 'download'"
              >
                📥 浏览器直接下载
              </button>
              <button
                class="seg__item"
                :class="{ 'seg__item--on': settings.saveMode === 'obsidian' }"
                :disabled="!fsSupported"
                @click="settings.saveMode = 'obsidian'"
              >
                💎 直写 Obsidian 本地知识库
              </button>
            </div>
            <p v-if="!fsSupported" class="hint hint--warn">
              ⚠️ 当前浏览器环境不支持 File System Access API，需 Chrome / Edge 86 以上版本
            </p>
          </div>

          <template v-if="settings.saveMode === 'obsidian' && fsSupported">
            <div class="card-box">
              <div class="field">
                <label class="label">Obsidian Vault 库目录</label>
                <div class="dir">
                  <span class="dir__icon" :class="{ 'dir__icon--on': !!dirName }">
                    {{ dirName ? '✓' : '📁' }}
                  </span>
                  <span class="dir__name" :class="{ 'dir__name--empty': !dirName }">
                    {{ dirName ?? '尚未授权选择本地知识库根目录' }}
                  </span>
                  <div class="dir__acts">
                    <button class="btn btn--sm" @click="chooseDir">
                      {{ dirName ? '重新选择' : '选择库根目录' }}
                    </button>
                    <button v-if="dirName" class="btn btn--quiet btn--sm" @click="clearDir">
                      解除绑定
                    </button>
                  </div>
                </div>
                <p class="hint">
                  授权访问 Obsidian Vault 根目录后，笔记将自动归档至指定的子目录中。
                </p>
              </div>

              <div class="two">
                <div class="field">
                  <label class="label" for="subfolder">保存子目录路径</label>
                  <input
                    id="subfolder"
                    v-model="settings.obsidian.subfolder"
                    class="input"
                    type="text"
                    placeholder="例如：BiliNotes/Tech"
                  />
                </div>
                <div class="field">
                  <label class="label" for="fn">文件名模板</label>
                  <input
                    id="fn"
                    v-model="settings.obsidian.filenameTemplate"
                    class="input"
                    type="text"
                    placeholder="{title}"
                  />
                </div>
              </div>

              <div class="template-chips">
                <span class="template-chips__label">快速插入变量：</span>
                <button type="button" class="chip" @click="insertTemplateVar('title')">{title} 标题</button>
                <button type="button" class="chip" @click="insertTemplateVar('up')">{up} UP主</button>
                <button type="button" class="chip" @click="insertTemplateVar('date')">{date} 日期</button>
                <button type="button" class="chip" @click="insertTemplateVar('bvid')">{bvid} 稿件号</button>
              </div>
            </div>
          </template>
        </section>

        <!-- ================= 05 语音识别 ================= -->
        <section id="sec-asr" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">05</span>
            <div class="pane__head-info">
              <h2>语音识别 (本地极速 ASR)</h2>
              <p>当 B 站原视频缺乏官方 AI 总结与 CC 字幕时，自动调用本地 GPU 极速转写精确逐字稿。</p>
            </div>
          </div>

          <label class="toggle toggle-interactive">
            <input v-model="settings.localAsr.enabled" type="checkbox" />
            <span class="toggle__box" />
            <div class="toggle__text">
              <strong>开启本地 Qwen3-ASR 自动兜底</strong>
              <em>
                利用本地 RTX 显卡（支持 Q4_K 轻量化模型）离线转录生肉视频，杜绝云端额度消耗与隐私泄露。
              </em>
            </div>
          </label>

          <template v-if="settings.localAsr.enabled">
            <div class="card-box" style="margin-top: 14px;">
              <div class="field">
                <label class="label" for="asr-endpoint">ASR 服务端点 (HTTP Endpoint)</label>
                <div class="row">
                  <input
                    id="asr-endpoint"
                    v-model="settings.localAsr.endpoint"
                    class="input input--code"
                    type="text"
                    placeholder="http://127.0.0.1:18765/api/transcribe"
                  />
                  <button
                    class="btn btn--sm"
                    :disabled="asrTesting || !settings.localAsr.endpoint.trim()"
                    @click="testAsrConnection"
                  >
                    {{ asrTesting ? '探测中…' : '检测连通性' }}
                  </button>
                </div>
                <p v-if="asrTestResult" class="hint" :class="asrTestResult.ok ? 'hint--ok' : 'hint--warn'">
                  {{ asrTestResult.msg }}
                </p>
                <p v-else class="hint">
                  默认本地推理服务端口为 <code>18765</code>。点击连通性检测可校验 <code>/health</code> 接口。
                </p>
              </div>

              <div class="two">
                <div class="field">
                  <label class="label" for="asr-timeout">超时截断时间（秒）</label>
                  <input
                    id="asr-timeout"
                    v-model.number="settings.localAsr.timeoutSeconds"
                    class="input"
                    type="number"
                    min="30"
                    max="1800"
                  />
                  <p class="hint">针对多小时超长视频的最长转录等待时间（推荐 180 ~ 300 秒）</p>
                </div>

                <div class="field">
                  <label class="label">无感处理模式</label>
                  <label class="toggle-card">
                    <input v-model="settings.localAsr.autoFallback" type="checkbox" />
                    <span class="toggle__box" />
                    <div class="toggle-card__text">
                      <strong>全自动静默转录</strong>
                      <p>检测到无字幕时直接呼起本地 GPU 跑全链路，免去二次点击确认</p>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          </template>
        </section>
      </main>
    </div>

    <!-- ============ 底部毛玻璃浮动操作栏 ============ -->
    <footer class="foot">
      <div class="foot__status">
        <span v-if="dirty" class="foot__dot foot__dot--dirty" />
        <span v-else-if="savedFlash" class="foot__dot foot__dot--ok" />
        <span v-else class="foot__dot foot__dot--idle" />

        <span v-if="dirty" class="foot__dirty">配置已修改，尚未保存</span>
        <span v-else-if="savedFlash" class="foot__ok">配置已保存并即时生效</span>
        <span v-else class="foot__idle">所有设置项均与本地存储同步</span>
      </div>

      <div class="foot__acts">
        <button class="btn btn--quiet" @click="resetAll">恢复出厂配置</button>
        <button class="btn btn--primary" :disabled="saving || !dirty" @click="save">
          <span v-if="saving" class="btn__spinner" />
          {{ saving ? '正在同步…' : '保存设置' }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ================================================================== *
 * 页面工作台总布局与容器
 * ================================================================== */

.page {
  max-width: 1140px;
  margin: 0 auto;
  padding: 32px 32px 100px;
}

/* ---------------- 顶部 Masthead ---------------- */

.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}

.masthead__brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.masthead__mark-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
}

.masthead__mark {
  width: 32px;
  height: 32px;
  border-radius: 6px;
}

.masthead__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.masthead__text h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--ink);
}

.masthead__badge {
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--bili-wash);
  color: var(--bili);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.masthead__text p {
  margin: 4px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.4;
}

.masthead__bili {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 500;
  box-shadow: var(--shadow-1);
  white-space: nowrap;
}

.masthead__bili img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

/* ---------------- 状态卡片摘要栏 ---------------- */

.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.summary__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  transition: transform 0.15s, border-color 0.15s;
}

.summary__cell:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.summary__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.summary__key {
  color: var(--ink-mist);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.3px;
}

.summary__badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-sunken);
  color: var(--ink-mist);
  font-size: 10px;
  font-weight: 600;
}

.summary__badge--ok {
  background: var(--ok-wash);
  color: var(--ok);
}

.summary__val-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.summary__dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ink-faint);
}

.summary__dot--ok {
  background: var(--ok);
  box-shadow: 0 0 0 2px var(--ok-wash);
}

.summary__val {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary__val--off {
  color: var(--warn);
}

/* ---------------- 双栏工作台主布局 ---------------- */

.layout {
  display: grid;
  grid-template-columns: 210px 1fr;
  gap: 28px;
  align-items: start;
}

/* 导航侧栏 */
.toc-col {
  position: sticky;
  top: 24px;
}

.toc {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
}

.toc__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}

.toc__caption {
  font-size: 11px;
  font-weight: 650;
  color: var(--ink-mist);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.toc__count {
  font-size: 10.5px;
  color: var(--ink-faint);
}

.toc__list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.toc__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--r-md);
  color: var(--ink-soft);
  text-align: left;
  transition: all 0.15s ease;
  position: relative;
}

.toc__item:hover {
  background: var(--surface-sunken);
  color: var(--ink);
}

.toc__item--on {
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-weight: 600;
}

.toc__icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}

.toc__icon {
  width: 16px;
  height: 16px;
  color: inherit;
  opacity: 0.85;
}

.toc__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.toc__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toc__no {
  font-size: 10px;
  font-weight: 700;
  color: var(--ink-faint);
}

.toc__item--on .toc__no {
  color: var(--bili);
}

.toc__title {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc__desc {
  font-size: 10.5px;
  color: var(--ink-mist);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc__item--on .toc__desc {
  color: var(--bili-deep);
  opacity: 0.85;
}

.toc__state {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 50%;
  font-size: 11px;
  color: var(--ink-faint);
}

.toc__state--done {
  color: var(--ok);
  background: var(--ok-wash);
  font-weight: 700;
}

/* ---------------- 右侧主面板 ---------------- */

.panes {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.pane {
  padding: 24px 26px 26px;
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  scroll-margin-top: 24px;
}

.pane__head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 22px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.pane__no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: var(--r-sm);
  background: var(--bili-wash);
  color: var(--bili);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.pane__head-info h2 {
  margin: 0;
  font-size: 16.5px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--ink);
}

.pane__head-info p {
  margin: 3px 0 0;
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.5;
}

/* ---------------- 表单与控件系统 ---------------- */

.field {
  margin-bottom: 18px;
}

.field:last-child {
  margin-bottom: 0;
}

.label {
  display: block;
  margin-bottom: 7px;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}

.label-row .label {
  margin-bottom: 0;
}

.label__num {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: 11.5px;
  font-weight: 700;
}

.input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
  transition: all 0.16s ease;
}

.input:focus {
  outline: none;
  border-color: var(--bili);
  box-shadow: 0 0 0 3px var(--bili-wash);
}

.input::placeholder {
  color: var(--ink-faint);
}

.input--code {
  font-family: var(--font-time);
  font-size: 12.5px;
}

.input--secret {
  letter-spacing: 1px;
}

.input-action-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-action-wrap .input {
  padding-right: 38px;
}

.input-icon-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  color: var(--ink-mist);
  font-size: 13px;
  transition: background 0.12s;
}

.input-icon-btn:hover {
  background: var(--surface-sunken);
  color: var(--ink);
}

.link-action {
  font-size: 11.5px;
  color: var(--bili);
  font-weight: 550;
  transition: opacity 0.14s;
}

.link-action:hover:not(:disabled) {
  opacity: 0.8;
}

.link-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.range {
  width: 100%;
  accent-color: var(--bili);
  cursor: pointer;
}

.select {
  cursor: pointer;
  appearance: auto;
}

.input--stacked {
  margin-top: 8px;
}

.hint {
  margin: 6px 0 0;
  color: var(--ink-mist);
  font-size: 11.5px;
  line-height: 1.55;
}

.hint code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  font-family: var(--font-time);
  font-size: 11px;
}

.hint--warn {
  color: var(--warn);
}

.hint--ok {
  color: var(--ok);
}

.hint--info {
  color: var(--bili);
}

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.row {
  display: flex;
  gap: 8px;
}

.row .input {
  flex: 1;
  min-width: 0;
}

.card-box {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--surface-sunken);
  margin-bottom: 18px;
}

.params-box {
  margin-bottom: 18px;
}

/* ---------------- 模型配置 Profile 胶囊网格 ---------------- */

.picks__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.btn__plus {
  margin-right: 2px;
  font-weight: 700;
}

.picks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.pick-card {
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  transition: all 0.16s ease;
  position: relative;
  overflow: hidden;
}

.pick-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-1);
}

.pick-card--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1px var(--bili) inset;
}

.pick-card__main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
}

.pick-card__radio {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border: 1.8px solid var(--line-strong);
  border-radius: 50%;
  transition: all 0.15s;
}

.pick-card--on .pick-card__radio {
  border-color: var(--bili);
  box-shadow: inset 0 0 0 3.5px var(--bili);
}

.pick-card__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pick-card__name {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-card__tags {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pick-card__model {
  color: var(--ink-mist);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.tag--vision {
  background: rgba(16, 185, 129, 0.12);
  color: var(--ok);
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.pick-card__del {
  flex: 0 0 auto;
  padding: 6px 12px;
  color: var(--ink-faint);
  font-size: 16px;
  line-height: 1;
  transition: color 0.14s;
}

.pick-card__del:hover {
  color: var(--err);
}

/* ---------------- 服务商已保存模型库微磁贴 ---------------- */

.picks__sub {
  display: block;
  margin-top: 2px;
  color: var(--ink-mist);
  font-size: 11.5px;
}

.model-chips-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.model-chip {
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  transition: all 0.16s ease;
  position: relative;
  overflow: hidden;
}

.model-chip:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-1);
}

.model-chip--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1px var(--bili) inset;
}

.model-chip__main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
}

.model-chip__radio {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border: 1.8px solid var(--line-strong);
  border-radius: 50%;
  transition: all 0.15s;
}

.model-chip--on .model-chip__radio {
  border-color: var(--bili);
  box-shadow: inset 0 0 0 3.5px var(--bili);
}

.model-chip__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.model-chip__name {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chip__id {
  color: var(--ink-mist);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chip__badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
}

.tag--ctx {
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
  border: 1px solid rgba(59, 130, 246, 0.25);
}

.tag--tok {
  background: rgba(245, 158, 11, 0.1);
  color: #d97706;
  border: 1px solid rgba(245, 158, 11, 0.25);
}

@media (prefers-color-scheme: dark) {
  .tag--ctx {
    background: rgba(59, 130, 246, 0.18);
    color: #60a5fa;
    border-color: rgba(59, 130, 246, 0.35);
  }
  .tag--tok {
    background: rgba(245, 158, 11, 0.18);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.35);
  }
}

.model-chip__del {
  flex: 0 0 auto;
  padding: 6px 12px;
  color: var(--ink-faint);
  font-size: 16px;
  line-height: 1;
  transition: color 0.14s;
}

.model-chip__del:hover {
  color: var(--err);
}

/* ---------------- 当前模型精准参数工作台 ---------------- */

.workbench {
  margin-bottom: 20px;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--surface-sunken);
  box-shadow: var(--shadow-card);
}

.workbench__head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px dashed var(--line);
}

.workbench__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workbench__tag {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--bili);
  color: #fff;
  letter-spacing: 0.3px;
}

.workbench__model {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--ink);
}

.workbench__desc {
  margin: 4px 0 0;
  color: var(--ink-mist);
  font-size: 11.5px;
}

/* ---------------- 快捷档位胶囊组 ---------------- */

.pill-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.pill-preset {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 11px;
  font-weight: 600;
  transition: all 0.14s ease;
  cursor: pointer;
}

.pill-preset:hover {
  border-color: var(--line-strong);
  color: var(--ink);
  background: var(--surface-hover);
}

.pill-preset--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-weight: 700;
}

/* ---------------- 工作台保存条 ---------------- */

.workbench__action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.workbench__action-tip {
  color: var(--ink-mist);
  font-size: 12px;
}

.save-toast {
  color: var(--ok);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  animation: fadeIn 0.2s ease;
}

/* ---------------- 服务商卡片网格 ---------------- */

.group {
  margin-bottom: 14px;
}

.group__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.group__title {
  color: var(--ink-soft);
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.3px;
}

.group__note {
  color: var(--ink-faint);
  font-size: 11px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}

.card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  text-align: left;
  transition: all 0.15s ease;
}

.card:hover {
  border-color: var(--line-strong);
  background: var(--surface-sunken);
  transform: translateY(-1px);
}

.card:active {
  transform: translateY(1px);
}

.card--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1px var(--bili) inset;
}

.card__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--surface);
  box-shadow: var(--shadow-1);
}

.card__logo img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.card__logo--text {
  color: var(--ink-mist);
  font-size: 13px;
  font-weight: 700;
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.card__name {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card__blurb {
  color: var(--ink-mist);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------------- 连通性指示卡片 ---------------- */

.conn {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-sunken);
  transition: all 0.2s ease;
}

.conn__dot {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ink-faint);
  box-shadow: 0 0 0 3px transparent;
}

.conn__body {
  flex: 1;
  min-width: 0;
}

.conn__title {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.conn__note {
  margin: 3px 0 0;
  color: var(--ink-mist);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.conn__host {
  margin: 4px 0 0;
  color: var(--ink-faint);
  font-size: 11px;
  font-family: var(--font-time);
}

.conn__acts {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.conn--ok {
  border-color: rgba(16, 185, 129, 0.35);
  background: var(--ok-wash);
}
.conn--ok .conn__dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-wash);
}

.conn--need-permission {
  border-color: rgba(199, 122, 8, 0.35);
  background: var(--warn-wash);
}
.conn--need-permission .conn__dot {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-wash);
}

.conn--failed {
  border-color: rgba(217, 59, 71, 0.35);
  background: var(--err-wash);
}
.conn--failed .conn__dot {
  background: var(--err);
  box-shadow: 0 0 0 3px var(--err-wash);
}

.conn--testing .conn__dot {
  background: var(--bili);
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 0 var(--bili-wash);
  }
  50% {
    opacity: 0.5;
    box-shadow: 0 0 0 6px var(--bili-wash);
  }
}

/* ---------------- 开关组件体系 ---------------- */

.toggles-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toggle {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.toggle-interactive:hover {
  border-color: var(--line-strong);
  background: var(--surface-sunken);
}

.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle__box {
  position: relative;
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  margin-top: 1px;
  border-radius: 10px;
  background: var(--line-strong);
  transition: background 0.18s;
}

.toggle__box::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.toggle input:checked + .toggle__box {
  background: var(--bili);
}

.toggle input:checked + .toggle__box::after {
  transform: translateX(14px);
}

.toggle input:focus-visible + .toggle__box {
  outline: 2px solid var(--bili);
  outline-offset: 2px;
}

.toggle__text strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.toggle__text em {
  display: block;
  margin-top: 3px;
  color: var(--ink-mist);
  font-size: 12px;
  font-style: normal;
  line-height: 1.45;
}

.toggle-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--surface);
  cursor: pointer;
  transition: all 0.14s;
}

.toggle-card:hover {
  border-color: var(--bili);
  background: var(--surface-sunken);
}

.toggle-card input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle-card input:checked + .toggle__box {
  background: var(--bili);
}

.toggle-card input:checked + .toggle__box::after {
  transform: translateX(14px);
}

.toggle-card__text strong {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
}

.toggle-card__text p {
  margin: 1px 0 0;
  font-size: 11px;
  color: var(--ink-mist);
}

/* ---------------- 外观字号与样张 ---------------- */

.sizes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}

.size {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 12px 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  transition: all 0.15s ease;
}

.size:hover {
  border-color: var(--line-strong);
  background: var(--surface-sunken);
}

.size--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1.5px var(--bili) inset;
}

.size__preview {
  color: var(--ink);
  font-weight: 700;
  line-height: 1.2;
}

.size--on .size__preview {
  color: var(--bili-deep);
}

.size__label {
  color: var(--ink-mist);
  font-size: 11.5px;
  font-weight: 550;
}

.size--on .size__label {
  color: var(--bili-deep);
}

.size__ratio {
  font-size: 10px;
  color: var(--ink-faint);
}

/* macOS 风格视窗微缩样张 */
.mock-window {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  box-shadow: var(--shadow-2);
  background: var(--surface-sunken);
}

.mock-window__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.mock-window__controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mock-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.mock-dot--red { background: #ff5f56; }
.mock-dot--yellow { background: #ffbd2e; }
.mock-dot--green { background: #27c93f; }

.mock-window__title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-mist);
}

.mock-window__ratio-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bili-wash);
  color: var(--bili);
  font-size: 10.5px;
  font-weight: 600;
}

.sample {
  padding: 16px 20px;
  background: var(--surface-sunken);
  transition: font-size 0.16s ease;
}

.sample__header-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.sample__time {
  padding: 2px 8px;
  border: 1px solid var(--bili-line);
  border-radius: 6px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: 0.9em;
  font-weight: 700;
}

.sample__title {
  color: var(--ink);
  font-size: 1.1em;
  font-weight: 700;
}

.sample__content {
  color: var(--ink-soft);
  line-height: 1.7;
}

.sample__body {
  margin: 0 0 10px;
}

.sample__formula {
  display: inline-block;
  padding: 2px 6px;
  margin: 0 4px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-family: var(--font-time);
  font-size: 0.92em;
  color: var(--ink);
}

.sample__list {
  margin: 0;
  padding-left: 18px;
}

.sample__list li {
  margin-bottom: 4px;
}

/* ---------------- 分段控件 (Seg) ---------------- */

.seg {
  display: inline-flex;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-sunken);
}

.seg__item {
  padding: 7px 16px;
  border-radius: var(--r-sm);
  color: var(--ink-soft);
  font-size: 12.5px;
  font-weight: 550;
  transition: all 0.14s ease;
}

.seg__item:hover:not(:disabled) {
  color: var(--ink);
}

.seg__item--on {
  background: var(--surface);
  color: var(--bili-deep);
  font-weight: 650;
  box-shadow: var(--shadow-1);
}

.seg__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------------- 目录选择器 ---------------- */

.dir {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--surface);
}

.dir__icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--surface-sunken);
  color: var(--ink-mist);
  font-size: 12px;
  font-weight: 700;
}

.dir__icon--on {
  background: var(--ok-wash);
  color: var(--ok);
}

.dir__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.dir__name--empty {
  color: var(--ink-faint);
  font-weight: 400;
}

.dir__acts {
  display: flex;
  gap: 6px;
}

.template-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: -6px;
}

.template-chips__label {
  font-size: 11px;
  color: var(--ink-mist);
}

.chip {
  padding: 3px 8px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 11px;
  font-family: var(--font-time);
  transition: all 0.12s;
}

.chip:hover {
  background: var(--bili-wash);
  border-color: var(--bili-line);
  color: var(--bili-deep);
}

/* ---------------- 基础按钮 ---------------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 18px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  transition: all 0.14s ease;
}

.btn:hover:not(:disabled) {
  background: var(--surface-sunken);
  border-color: var(--ink-faint);
}

.btn:active:not(:disabled) {
  transform: translateY(1px);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn--sm {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: var(--r-sm);
}

.btn--ghost {
  background: transparent;
}

.btn--quiet {
  border-color: transparent;
  background: transparent;
  color: var(--ink-mist);
}

.btn--quiet:hover:not(:disabled) {
  background: var(--surface-sunken);
  color: var(--err);
}

.btn--primary {
  border-color: var(--bili);
  background: var(--bili);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(251, 114, 153, 0.3);
}

.btn--primary:hover:not(:disabled) {
  background: var(--bili-deep);
  border-color: var(--bili-deep);
  box-shadow: 0 2px 6px rgba(251, 114, 153, 0.4);
}

.btn__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---------------- 底部悬浮毛玻璃操作栏 ---------------- */

.foot {
  position: sticky;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 32px -32px -100px;
  padding: 16px 32px;
  background: var(--paper);
  border-top: 1px solid var(--line);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.04);
}


.foot__status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.foot__dot--dirty {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-wash);
  animation: breathe 1.5s ease-in-out infinite;
}

.foot__dot--ok {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-wash);
}

.foot__dot--idle {
  background: var(--ink-faint);
}

@keyframes breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.9); }
}

.foot__dirty {
  color: var(--warn);
  font-size: 13px;
  font-weight: 600;
}

.foot__ok {
  color: var(--ok);
  font-size: 13px;
  font-weight: 600;
}

.foot__idle {
  color: var(--ink-mist);
  font-size: 13px;
}

.foot__acts {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ---------------- 响应式断点适配 ---------------- */

@media (max-width: 900px) {
  .summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .layout {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .toc-col {
    position: static;
  }
  .toc__list {
    flex-direction: row;
    overflow-x: auto;
  }
  .toc__desc {
    display: none;
  }
}

@media (max-width: 640px) {
  .page {
    padding: 20px 16px 88px;
  }
  .summary {
    grid-template-columns: 1fr;
  }
  .two {
    grid-template-columns: 1fr;
  }
  .sizes {
    grid-template-columns: repeat(2, 1fr);
  }
  .foot {
    margin: 20px -16px -88px;
    padding: 14px 16px;
  }
}
</style>
