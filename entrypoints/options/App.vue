<script setup lang="ts">
/**
 * entrypoints/options/App.vue —— 设置页
 *
 * 结构（相较旧版是重构，不是换皮）：
 *   · 顶部：身份 + 实时配置摘要（一眼知道"我现在用的是什么"）
 *   · 左侧：目录（01/02/03 是真实的配置顺序）+ 完成状态 + 当前位置
 *   · 右侧：三个分区
 *      01 大模型 —— 服务商按「部署方式」分组为身份卡（真实 logo + 定位说明）
 *      02 笔记行为
 *      03 保存位置
 *   · 连通性：把「域名授权」与「测试连接」合并为一个区块
 *     （旧版把它们拆成一条绿框和一个按钮，但它们描述的是同一件事）
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
  type FontScale,
  type LlmProfile,
  type ProviderId,
  type Settings,
} from '@/lib/types';
import { FONT_SCALES, normalizeFontScale } from '@/lib/fontScale';

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

/**
 * 拉到的模型列表。
 *
 * modelsFor 记的是「这份列表属于哪一份配置」——
 * 切换配置后列表必须先失效，否则会把 A 端点的模型
 * 展示在 B 端点的下拉框里，选出来的模型名必然请求失败。
 */
const modelList = ref<string[]>([]);
const modelsFor = ref('');
const loadingModels = ref(false);
const modelErr = ref('');

const dirName = ref<string | null>(null);
const permGranted = ref(false);

const fsSupported = supportsFileSystemAccess();

/* ================================================================== *
 * 载入
 * ================================================================== */

onMounted(async () => {
  settings.value = await loadSettings();
  // 一个配置都没有时先建一份空的，否则用户面对的是个没有输入框的页面
  if (settings.value.profiles.length === 0) {
    const first = makeProfile('custom', { baseURL: '', model: '' }, '自定义端点');
    settings.value = { ...settings.value, profiles: [first], activeProfileId: first.id };
  }
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

/**
 * 地址失焦：先把地址规范化，再重判权限，最后重拉模型列表。
 *
 * 三步必须按顺序：地址没规范化就判权限会漏掉端口，
 * 权限没拿到就拉列表必然 401。
 */
async function onEndpointBlur(): Promise<void> {
  const p = active.value;
  if (!p) return;
  p.baseURL = normalizeBaseURL(p.baseURL);
  await refreshPermission();
  void refreshModels();
}

/* ================================================================== *
 * 当前配置
 *
 * 页面上所有输入框都直接绑在这一个对象上，因此「切换配置」
 * 只是换一个引用，不需要把十几个字段各搬一遍。
 * ================================================================== */

const active = computed<LlmProfile | null>(() => getActiveProfile(settings.value));

/**
 * 切换当前使用的配置。
 *
 * 切换即视为「我以后就用这个了」，因此直接落到设置里——
 * 否则用户切完不点保存，侧边栏用的还是旧的那份，很难理解。
 */
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
  testResult.value = null;
  modelErr.value = '';
  await save();
  void refreshModels();
}

async function removeProfile(id: string): Promise<void> {
  const target = settings.value.profiles.find((p) => p.id === id);
  if (!target) return;
  if (!confirm(`删除配置「${target.name}」？`)) return;

  const rest = settings.value.profiles.filter((p) => p.id !== id);
  // 一个都不剩时补一份空的，保证页面上始终有东西可编辑
  const fallback =
    rest.length > 0 ? rest : [makeProfile('custom', { baseURL: '', model: '' }, '自定义端点')];
  const nextActive =
    settings.value.activeProfileId === id ? (fallback[0]?.id ?? '') : settings.value.activeProfileId;

  settings.value = { ...settings.value, profiles: fallback, activeProfileId: nextActive };
  testResult.value = null;
  modelErr.value = '';
  await save();
  void refreshModels();
}

/**
 * 模型列表：配置一变就自动拉。
 *
 * 用户的原话是「你既然可以拉取模型了，那就不需要我再手动去填了」——
 * 所以不再要求点「测试连接」。拉不到（中转站不实现 /models）时
 * 保留手动输入，并把原因写在旁边，而不是静默失败。
 */
async function refreshModels(): Promise<void> {
  const p = active.value;
  modelList.value = [];
  modelErr.value = '';

  if (!p?.baseURL.trim()) return;
  // 没有密钥也能拉（本地 Ollama 等），但云端端点会 401，试一下无妨
  if (!(await hasApiPermission(p.baseURL))) return;

  // 请求发出后用户可能已经切到别的配置，回来时必须丢弃，
  // 否则会把 A 端点的模型塞进 B 端点的下拉框
  const token = p.id;
  loadingModels.value = true;
  try {
    const models = await listModels(p);
    if (active.value?.id !== token) return;
    modelsFor.value = token;
    modelList.value = models;
    if (models.length === 0) modelErr.value = '该端点未返回模型列表，请手动填写模型名';
  } catch (e) {
    // 401/403 几乎总是「密钥还没填」，直说比抛一个 HTTP 码有用
    if (e instanceof LlmError && (e.status === 401 || e.status === 403)) {
      modelErr.value = '填写 API 密钥后会自动拉取模型列表，也可以直接手填模型名';
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
 * 派生状态
 * ================================================================== */

const presets = PROVIDER_PRESETS;

/** 按部署方式分组 —— 分组编码真实差异，不是装饰性分类 */
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

/** 温度偏离推荐区间时提示 —— 总结任务 0.2~0.4 之外会更容易跑偏 */
const tempOffRange = computed(
  () => (active.value?.temperature ?? 0.3) > 0.5 || (active.value?.temperature ?? 0.3) < 0.1,
);

const dirty = computed(
  () => loaded.value && JSON.stringify(settings.value) !== savedSnapshot.value,
);

/** 顶部实时摘要：让用户一眼看清当前配置 */
const summary = computed(() => {
  const p = active.value;
  return [
    {
      key: '模型',
      value: modelConfigured.value
        ? `${p?.name || currentPreset.value?.label || '自定义'} · ${p?.model}`
        : '未配置',
      ok: modelConfigured.value,
    },
    {
      key: '聊天附带位置',
      value: settings.value.sendPlayhead ? '开启' : '关闭',
      ok: true,
    },
    {
      key: '保存到',
      value: obscureDirEnabled.value ? `Obsidian · ${dirName.value}` : '浏览器下载',
      ok: true,
    },
  ];
});

/**
 * 服务商 logo 的路径类型。
 *
 * 这里列出的是 scripts/fetch-logos.mjs 实际抓到的文件，
 * 与 public/logos/ 一一对应。用字面量联合类型而非宽泛的模板字符串，
 * 是为了让 TS 能校验文件名拼写（写错即编译报错，而不是运行时裂图）。
 */
type LogoPath =
  | '/logos/siliconflow.png'
  | '/logos/deepseek.svg'
  | '/logos/moonshot.png'
  | '/logos/zhipu.png'
  | '/logos/openai.png'
  | '/logos/openrouter.svg'
  | '/logos/ollama.svg'
  | '/logos/bilibili.svg';

/** 取 public 目录下的资源 URL。WXT 会在 prepare 时校验路径确实存在 */
function assetUrl(path: LogoPath | '/icons/icon48.png'): string {
  return browser.runtime.getURL(path);
}

/** 服务商 logo 的完整 URL。文件名为空时返回 null，模板渲染首字母占位 */
function logoUrl(file?: string): string | null {
  return file ? assetUrl(`/logos/${file}` as LogoPath) : null;
}

/* ================================================================== *
 * 服务商
 * ================================================================== */

function applyPreset(id: ProviderId): void {
  const p = presets.find((x) => x.id === id);
  const cur = active.value;
  if (!p || !cur) return;

  // 先记下改之前是谁，否则下面判断「名字是否被用户改过」时
  // 拿到的已经是新服务商，判断必然失效
  const before = presets.find((x) => x.id === cur.provider);

  cur.provider = id;
  // 自定义端点保留用户已填内容，避免误清
  if (id !== 'custom') {
    cur.baseURL = p.baseURL;
    cur.model = p.model;
    // 名字还没被用户改过（等于旧的服务商名）时跟着换，省一次输入
    if (!cur.name || cur.name === before?.label) cur.name = p.label;
  }
  testResult.value = null;
  modelList.value = [];
  modelsFor.value = '';
  modelErr.value = '';
  void refreshPermission().then(() => refreshModels());
}

/* ================================================================== *
 * 连通性（权限 + 测试，合并为一个区块）
 * ================================================================== */

/** 区块整体状态：决定配色与文案 */
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
      return '正在测试连接…';
    case 'failed':
      return '连接失败';
    case 'need-permission':
      return '需要授权该域名';
    default:
      return '域名已授权，可以连接';
  }
});

const connNote = computed(() => {
  switch (connState.value) {
    case 'unconfigured':
      return '选择上面的服务商，或直接填入你自己的端点地址';
    case 'testing':
      return '正在向该端点请求模型列表';
    case 'failed':
      return testResult.value?.msg ?? '';
    case 'need-permission':
      return '浏览器要求逐个域名授权，插件才能调用模型服务';
    default:
      return testResult.value?.ok ? testResult.value.msg : `已授权 ${hostPattern.value ?? ''}`;
  }
});

async function grantPermission(): Promise<void> {
  const ok = await requestApiPermission(active.value?.baseURL ?? '');
  permGranted.value = ok;
  if (ok) {
    testResult.value = null;
    // 刚拿到权限就顺手把模型列表拉回来，省得用户再点一次
    void refreshModels();
  } else {
    testResult.value = { ok: false, msg: '授权被拒绝。没有该域名的访问权限，插件无法调用模型服务。' };
  }
}

async function testConnection(): Promise<void> {
  const p = active.value;
  if (!p) return;

  testing.value = true;
  testResult.value = null;
  modelList.value = [];

  try {
    // 测试前先落盘，保证测的就是将要使用的配置
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);
    await refreshPermission();

    if (needsPermission.value) {
      testResult.value = { ok: false, msg: '尚未授权该域名，请先点「授权域名」。' };
      return;
    }

    const models = await listModels(p);
    modelsFor.value = p.id;
    modelList.value = models;

    const hit = !p.model || models.includes(p.model);
    testResult.value = {
      ok: true,
      msg: models.length
        ? `连接成功，返回 ${models.length} 个可用模型${hit ? '' : '。注意：当前填写的模型名不在列表中，请确认拼写'}`
        : '连接成功。该端点未返回模型列表，可直接填写模型名',
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

/**
 * 下拉框选中一个模型。
 *
 * 原生 <select> 用 @change 而不是 v-model：v-model 需要一个
 * 稳定的字符串 ref，而这里的「当前值」来自活动配置，
 * 直接改它更直白，也避免中间态被写回。
 */
function onModelPick(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  const p = active.value;
  if (!p) return;
  if (v === '__manual__') {
    manualModel.value = true;
    return;
  }
  p.model = v;
  manualModel.value = false;
}

/** 用户是否选择了「手动填写模型名」 */
const manualModel = ref(false);

/** 当前下拉框应该显示什么 */
const modelSelectValue = computed(() => {
  const p = active.value;
  if (!p) return '';
  if (manualModel.value) return '__manual__';
  return modelList.value.includes(p.model) ? p.model : '__manual__';
});

/* ================================================================== *
 * Obsidian 目录
 * ================================================================== */

async function chooseDir(): Promise<void> {
  try {
    dirName.value = await pickObsidianDir();
    settings.value.obsidian.enabled = true;
    await saveSettings(settings.value);
    savedSnapshot.value = JSON.stringify(settings.value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return; // 用户取消
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

/* ================================================================== *
 * 保存
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
  if (!confirm('恢复默认设置？已保存的配置与 API 密钥都会被清空。')) return;
  const fresh = structuredClone(DEFAULT_SETTINGS);
  const first = makeProfile('custom', { baseURL: '', model: '' }, '自定义端点');
  settings.value = { ...fresh, profiles: [first], activeProfileId: first.id };
  manualModel.value = false;
  modelList.value = [];
  void save();
}

/*
 * 切换配置时把「手动填写模型名」重置掉。
 *
 * 这个开关是界面的临时状态，不属于配置本身；
 * 不重置的话，切到另一份配置后下拉框会停在「手动填写」上，
 * 而用户明明什么都没做。
 */
watch(
  () => settings.value.activeProfileId,
  () => {
    manualModel.value = false;
    testResult.value = null;
  },
);

/* ================================================================== *
 * 左侧目录的当前位置指示（与侧边栏时间轴同一套「你在这里」语言）
 * ================================================================== */

const SECTIONS = [
  { id: 'sec-model', no: '01', title: '大模型' },
  { id: 'sec-behavior', no: '02', title: '聊天' },
  { id: 'sec-display', no: '03', title: '外观' },
  { id: 'sec-output', no: '04', title: '保存位置' },
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
 * 字号
 *
 * 只作用于侧边栏。
 *
 * 【为什么设置页自己不跟着放大】
 * 用户把侧边栏字号调到最大之后，如果设置页也跟着变大，
 * 他很可能连「字号」这一项都翻不到——等于把自己的退路堵死了。
 * 所以设置页永远是标准字号，改用一小段「样张」来展示效果：
 * 样张按所选档位渲染，用户照样能判断大小，但页面本身不会失控。
 * ================================================================== */

const fontScales = FONT_SCALES;

/** 当前选中的档位 */
const fontScale = computed<FontScale>(() => normalizeFontScale(settings.value.fontScale));

/**
 * 样张正文的字号。
 *
 * 直接算出字符串而不是把倍率交给模板里的算术——
 * vue-tsc 不会在模板字符串内解包 ref，写 `${13 * ref}` 会报类型错。
 */
const sampleFontSize = computed(() => {
  const ratio = FONT_SCALES.find((f) => f.id === fontScale.value)?.ratio ?? 1;
  return `${13 * ratio}px`;
});

/** 各分区的完成状态，显示在目录里 */
function sectionDone(id: string): boolean {
  if (id === 'sec-model') return modelConfigured.value;
  // 外观与保存位置随时可改，不存在「没配好」的状态
  return true;
}
</script>

<template>
  <div v-if="loaded" class="page">
    <!-- ============ 顶部 ============ -->
    <header class="masthead">
      <div class="masthead__brand">
        <img class="masthead__mark" :src="assetUrl('/icons/icon48.png')" alt="" />
        <div class="masthead__text">
          <h1>BiliLens <span class="masthead__ver">设置</span></h1>
          <p>把 B站视频变成带时间戳的结构化笔记</p>
        </div>
      </div>

      <div class="masthead__bili">
        <img :src="assetUrl('/logos/bilibili.svg')" alt="" />
        <span>适用于 bilibili</span>
      </div>
    </header>

    <!-- 实时配置摘要：一眼看清"我现在用的是什么" -->
    <div class="summary">
      <div v-for="s in summary" :key="s.key" class="summary__cell">
        <span class="summary__key">{{ s.key }}</span>
        <span class="summary__val" :class="{ 'summary__val--off': !s.ok }">{{ s.value }}</span>
      </div>
    </div>

    <!-- ============ 主体：目录 + 分区 ============ -->
    <div class="layout">
      <nav class="toc" aria-label="设置目录">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          class="toc__item"
          :class="{ 'toc__item--on': activeSection === s.id }"
          :aria-current="activeSection === s.id ? 'true' : undefined"
          @click="goSection(s.id)"
        >
          <span class="toc__no tnum">{{ s.no }}</span>
          <span class="toc__title">{{ s.title }}</span>
          <span class="toc__state" :class="{ 'toc__state--done': sectionDone(s.id) }">
            {{ sectionDone(s.id) ? '✓' : '·' }}
          </span>
        </button>
      </nav>

      <main class="panes">
        <!-- ======== 01 大模型 ======== -->
        <section id="sec-model" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">01</span>
            <div>
              <h2>大模型</h2>
              <p>笔记由你自己的模型生成。支持任何 OpenAI 兼容端点。</p>
            </div>
          </div>

          <!-- 配置：可以有多份，选一份当前使用 -->
          <div class="field">
            <div class="picks__head">
              <span class="label">模型配置</span>
              <button class="btn btn--ghost btn--sm" @click="addProfile">+ 新建配置</button>
            </div>

            <div class="picks">
              <div
                v-for="p in settings.profiles"
                :key="p.id"
                class="pick"
                :class="{ 'pick--on': p.id === settings.activeProfileId }"
              >
                <button class="pick__main" :title="p.baseURL || '尚未填写地址'" @click="selectProfile(p.id)">
                  <span class="pick__radio" aria-hidden="true" />
                  <span class="pick__body">
                    <span class="pick__name">{{ p.name }}</span>
                    <span class="pick__sub tnum">
                      {{ p.model || '未选择模型' }}
                      <template v-if="p.supportsVision"> · 可看图</template>
                    </span>
                  </span>
                </button>
                <button
                  v-if="settings.profiles.length > 1"
                  class="pick__del"
                  title="删除这份配置"
                  @click="removeProfile(p.id)"
                >
                  ×
                </button>
              </div>
            </div>

            <p class="hint">
              切换即生效，侧边栏立刻用新配置。云端和本地各留一份，就不用每次重填密钥
            </p>
          </div>

          <template v-if="active">
            <!-- 当前配置的名称 -->
            <div class="field">
              <label class="label" for="pname">配置名称</label>
              <input
                id="pname"
                v-model="active.name"
                class="input"
                type="text"
                placeholder="例如：DeepSeek 云端 / 本地网关"
              />
            </div>

            <!-- 服务商：按部署方式分组 -->
            <div class="field">
              <span class="label">选择服务商</span>

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

            <!-- 端点与凭据 -->
            <div class="field">
              <label class="label" for="baseurl">API 地址</label>
              <input
                id="baseurl"
                v-model="active.baseURL"
                class="input"
                type="text"
                placeholder="https://your-endpoint.com/v1"
                spellcheck="false"
                @blur="onEndpointBlur"
              />
              <p class="hint">填到 <code>/v1</code> 为止，插件会自动补 <code>/chat/completions</code></p>
            </div>

            <div class="two">
              <div class="field">
                <label class="label" for="apikey">API 密钥</label>
                <input
                  id="apikey"
                  v-model="active.apiKey"
                  class="input"
                  type="password"
                  placeholder="sk-…"
                  spellcheck="false"
                  autocomplete="off"
                />
                <p class="hint">只存在本机浏览器，不上传任何第三方</p>
              </div>

              <div class="field">
                <label class="label" for="model">模型名称</label>

                <!-- 拉到了就直接给选择器，不用用户再手打一遍 -->
                <select
                  v-if="modelList.length"
                  id="model"
                  class="input select"
                  :value="modelSelectValue"
                  @change="onModelPick"
                >
                  <option v-for="m in modelList" :key="m" :value="m">{{ m }}</option>
                  <option value="__manual__">手动填写…</option>
                </select>

                <input
                  v-if="!modelList.length || manualModel"
                  id="model-manual"
                  v-model="active.model"
                  class="input"
                  :class="{ 'input--stacked': modelList.length }"
                  type="text"
                  placeholder="deepseek-chat"
                  spellcheck="false"
                />

                <p v-if="loadingModels" class="hint">正在拉取该端点的模型列表…</p>
                <p v-else-if="modelErr" class="hint hint--warn">{{ modelErr }}</p>
                <p v-else-if="modelList.length" class="hint">
                  已从端点拉到 {{ modelList.length }} 个模型，直接选即可
                </p>
                <p v-else class="hint">填好地址并授权域名后会自动拉取模型列表，拉不到可手填</p>
              </div>
            </div>

            <!-- 生成参数 -->
            <div class="two">
              <div class="field">
                <label class="label" for="temp">
                  温度 <span class="label__num tnum">{{ active.temperature.toFixed(1) }}</span>
                </label>
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
                      ? '偏高，总结容易偏离原文。建议 0.2 ~ 0.4'
                      : '当前在推荐区间内，数值越低越忠实原文'
                  }}
                </p>
              </div>

              <div class="field">
                <label class="label" for="maxtok">最大输出 Token</label>
                <input
                  id="maxtok"
                  v-model.number="active.maxTokens"
                  class="input"
                  type="number"
                  min="0"
                  step="512"
                  placeholder="0"
                />
                <p class="hint">留 0 由服务端决定</p>
              </div>
            </div>

            <!-- 思考深度：对应 reasoning_effort。default 不发参数，
                 其余原样传档位值；改动即保存，与图像输入开关同理 -->
            <div class="field">
              <label class="label" for="effort">思考深度</label>
              <select id="effort" v-model="active.reasoningEffort" class="input select" @change="save">
                <option value="">default（不发送参数）</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
              </select>
              <p class="hint">档位超出模型支持范围时由网关自动降级</p>
            </div>

            <!-- 连通性：权限与测试合为一个区块 -->
            <div class="conn" :class="`conn--${connState}`">
              <span class="conn__dot" />
              <div class="conn__body">
                <p class="conn__title">{{ connTitle }}</p>
                <p class="conn__note">{{ connNote }}</p>
                <p v-if="hostPattern" class="conn__host tnum">{{ hostPattern }}</p>
              </div>
              <div class="conn__acts">
                <button
                  v-if="needsPermission"
                  class="btn btn--primary btn--sm"
                  @click="grantPermission"
                >
                  授权域名
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

            <!-- 图像输入：无法自动判断，因此交给用户明确开关。
                 改动即保存——这个开关必须立即可靠，
                 用户不会想到「列表里的可看图徽章」和「真正落盘」是两回事 -->
            <label class="toggle">
              <input v-model="active.supportsVision" type="checkbox" @change="save" />
              <span class="toggle__box" />
              <span class="toggle__text">
                <strong>支持图像输入</strong>
                <em>
                  打开后，聊天框里可以直接粘贴截图提问。同一个端点下不同模型能力不同，
                  插件无法自动判断，所以由你指定；模型不支持时打开它，请求会直接报错。
                </em>
              </span>
            </label>
          </template>
        </section>

        <!-- ======== 02 聊天 ======== -->
        <section id="sec-behavior" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">02</span>
            <div>
              <h2>聊天</h2>
              <p>侧边栏里可以向视频提问。这里决定提问时默认带上什么。</p>
            </div>
          </div>

          <label class="toggle">
            <input v-model="settings.sendPlayhead" type="checkbox" />
            <span class="toggle__box" />
            <span class="toggle__text">
              <strong>提问时附带当前播放位置</strong>
              <em>
                默认关闭。多数问题是关于整个视频的，带上位置反而会让模型
                误以为你在问当前这一段；只有想问「这里讲了什么」时才需要打开。
              </em>
            </span>
          </label>

          <label class="toggle">
            <input v-model="settings.autoRun" type="checkbox" />
            <span class="toggle__box" />
            <span class="toggle__text">
              <strong>打开视频页自动生成笔记</strong>
              <em>省一次点击，但每个新视频都会消耗模型额度</em>
            </span>
          </label>
        </section>

        <!-- ======== 03 外观 ======== -->
        <section id="sec-display" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">03</span>
            <div>
              <h2>外观</h2>
              <p>侧边栏显示得舒不舒服，这里调。</p>
            </div>
          </div>

          <div class="field">
            <span class="label">侧边栏字号</span>

            <div class="sizes">
              <button
                v-for="f in fontScales"
                :key="f.id"
                class="size"
                :class="{ 'size--on': fontScale === f.id }"
                @click="settings.fontScale = f.id"
              >
                <span class="size__a" :style="{ fontSize: `${13 * f.ratio}px` }">A</span>
                <span class="size__label">{{ f.label }}</span>
              </button>
            </div>

            <!-- 样张：按所选档位渲染，但设置页本身不变大 -->
            <div class="sample">
              <p class="sample__head">
                <span class="sample__time tnum">[12:04]</span>
                <span class="sample__title">视频里的一段笔记标题</span>
              </p>
              <p class="sample__body" :style="{ fontSize: sampleFontSize }">
                这一段按你选的字号显示，正文是这个大小。侧边栏里的笔记、聊天回答、
                时间戳都会一起变化。
              </p>
            </div>

            <p class="hint">
              只影响侧边栏，设置页保持标准字号。保存后侧边栏会立即变化
            </p>
          </div>
        </section>

        <!-- ======== 04 保存位置 ======== -->
        <section id="sec-output" class="pane">
          <div class="pane__head">
            <span class="pane__no tnum">04</span>
            <div>
              <h2>保存位置</h2>
              <p>笔记生成完之后去哪里。</p>
            </div>
          </div>

          <div class="field">
            <span class="label">保存方式</span>
            <div class="seg">
              <button
                class="seg__item"
                :class="{ 'seg__item--on': settings.saveMode === 'download' }"
                @click="settings.saveMode = 'download'"
              >
                浏览器下载
              </button>
              <button
                class="seg__item"
                :class="{ 'seg__item--on': settings.saveMode === 'obsidian' }"
                :disabled="!fsSupported"
                @click="settings.saveMode = 'obsidian'"
              >
                直写 Obsidian 目录
              </button>
            </div>
            <p v-if="!fsSupported" class="hint hint--warn">
              当前浏览器不支持目录直写，需要 Chrome / Edge 86 以上
            </p>
          </div>

          <template v-if="settings.saveMode === 'obsidian' && fsSupported">
            <div class="field">
              <span class="label">Obsidian 库目录</span>
              <div class="dir">
                <span class="dir__icon" :class="{ 'dir__icon--on': !!dirName }">
                  {{ dirName ? '✓' : '—' }}
                </span>
                <span class="dir__name" :class="{ 'dir__name--empty': !dirName }">
                  {{ dirName ?? '尚未选择' }}
                </span>
                <button class="btn btn--ghost btn--sm" @click="chooseDir">
                  {{ dirName ? '重新选择' : '选择目录' }}
                </button>
                <button v-if="dirName" class="btn btn--ghost btn--sm" @click="clearDir">
                  清除
                </button>
              </div>
              <p class="hint">
                选你的 Obsidian 库根目录即可，笔记写入其下的子文件夹。浏览器只在你点击时授予权限
              </p>
            </div>

            <div class="two">
              <div class="field">
                <label class="label" for="subfolder">子文件夹</label>
                <input
                  id="subfolder"
                  v-model="settings.obsidian.subfolder"
                  class="input"
                  type="text"
                  placeholder="BiliLens"
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
            <p class="hint hint--vars">
              可用变量：<code>{title}</code> 标题 · <code>{up}</code> UP主 · <code>{date}</code> 日期 ·
              <code>{bvid}</code> 视频号
            </p>
          </template>
        </section>
      </main>
    </div>

    <!-- ============ 底部：保存 ============ -->
    <footer class="foot">
      <span v-if="dirty" class="foot__dirty">有未保存的改动</span>
      <span v-else-if="savedFlash" class="foot__ok">已保存</span>
      <span v-else class="foot__idle">所有改动均已保存</span>

      <div class="foot__acts">
        <button class="btn btn--quiet" @click="resetAll">恢复默认</button>
        <button class="btn btn--primary" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* 全部使用单类选择器，避免特异性互相抵消 */

.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 30px 28px 88px;
}

/* ---------------- 顶部 ---------------- */

.masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.masthead__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.masthead__mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
}

.masthead__text h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 680;
  letter-spacing: -0.2px;
}

.masthead__ver {
  margin-left: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-mist);
  letter-spacing: 0;
}

.masthead__text p {
  margin: 2px 0 0;
  color: var(--ink-soft);
  font-size: 12.5px;
}

/* bilibili 标识：说明适用范围，克制使用 */
.masthead__bili {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 7px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  color: var(--ink-mist);
  font-size: 11.5px;
  white-space: nowrap;
}

.masthead__bili img {
  width: 15px;
  height: 15px;
  object-fit: contain;
}

/* ---------------- 配置摘要 ---------------- */

.summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin-bottom: 22px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--line);
  overflow: hidden;
}

.summary__cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 11px 15px;
  background: var(--surface);
}

.summary__key {
  color: var(--ink-mist);
  font-size: 10.5px;
  letter-spacing: 0.4px;
}

.summary__val {
  color: var(--ink);
  font-size: 13px;
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary__val--off {
  color: var(--warn);
}

/* ---------------- 布局：目录 + 分区 ---------------- */

.layout {
  display: grid;
  grid-template-columns: 168px 1fr;
  gap: 30px;
  align-items: start;
}

.toc {
  position: sticky;
  top: 26px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.toc__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  color: var(--ink-soft);
  font-size: 12.5px;
  text-align: left;
  transition: background 0.14s, color 0.14s;
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

.toc__no {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ink-faint);
}

.toc__item--on .toc__no {
  color: var(--bili);
}

.toc__title {
  flex: 1;
}

.toc__state {
  color: var(--ink-faint);
  font-size: 11px;
}

.toc__state--done {
  color: var(--ok);
}

/* ---------------- 分区 ---------------- */

.panes {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.pane {
  padding: 22px 24px 24px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow-1);
  scroll-margin-top: 24px;
}

.pane__head {
  display: flex;
  gap: 13px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.pane__no {
  flex: 0 0 auto;
  color: var(--bili);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding-top: 3px;
}

.pane__head h2 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 660;
  letter-spacing: -0.1px;
}

.pane__head p {
  margin: 3px 0 0;
  color: var(--ink-soft);
  font-size: 12.5px;
}

/* ---------------- 表单 ---------------- */

.field {
  margin-bottom: 18px;
}

.label {
  display: block;
  margin-bottom: 7px;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 570;
}

.label__num {
  margin-left: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-sunken);
  color: var(--ink-soft);
  font-size: 11px;
  font-weight: 600;
}

.input {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
  font-size: 12.5px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.input:focus {
  outline: none;
  border-color: var(--bili);
  box-shadow: 0 0 0 3px var(--bili-wash);
}

.input::placeholder {
  color: var(--ink-faint);
}

.range {
  width: 100%;
  accent-color: var(--bili);
}

.select {
  cursor: pointer;
  appearance: auto;
}

/* 选择器在上、手动输入框在下时给一点间距，避免看起来是同一个控件 */
.input--stacked {
  margin-top: 6px;
}

.hint {
  margin: 6px 0 0;
  color: var(--ink-mist);
  font-size: 11.5px;
  line-height: 1.55;
}

.hint--warn {
  color: var(--warn);
}

.hint--vars {
  margin-top: -6px;
}

.hint code,
.conn code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  font-family: var(--font-time);
  font-size: 11px;
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

@media (max-width: 760px) {
  .two,
  .summary {
    grid-template-columns: 1fr;
  }
  .layout {
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .toc {
    position: static;
    flex-direction: row;
    overflow-x: auto;
  }
}

/* ---------------- 字号档位 ---------------- */

.sizes {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.size {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  padding: 10px 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  transition: border-color 0.15s, background 0.15s;
}

.size:hover {
  border-color: var(--line-strong);
}

.size--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1px var(--bili) inset;
}

/* 每个按钮里的 A 用对应倍率渲染 —— 不用读文字就能比出大小 */
.size__a {
  color: var(--ink);
  font-weight: 640;
  line-height: 1.1;
}

.size--on .size__a {
  color: var(--bili-deep);
}

.size__label {
  color: var(--ink-mist);
  font-size: 11px;
}

.size--on .size__label {
  color: var(--bili-deep);
}

/* 样张 */
.sample {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-sunken);
}

.sample__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
}

.sample__time {
  padding: 1px 7px;
  border: 1px solid var(--bili-line);
  border-radius: 5px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: 11px;
  font-weight: 650;
}

.sample__title {
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 640;
}

/* 字号由行内 style 给（跟着所选档位），行高用与侧边栏同一套规则 */
.sample__body {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.75;
}

/* ---------------- 配置列表 ---------------- */

.picks__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}

.picks__head .label {
  margin-bottom: 0;
}

.picks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.pick {
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  transition: border-color 0.15s, background 0.15s;
}

.pick:hover {
  border-color: var(--line-strong);
}

.pick--on {
  border-color: var(--bili);
  background: var(--bili-wash);
  box-shadow: 0 0 0 1px var(--bili) inset;
}

.pick__main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  text-align: left;
}

/* 单选圆点：一眼看出「现在用的是哪一份」 */
.pick__radio {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border: 1.5px solid var(--line-strong);
  border-radius: 50%;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.pick--on .pick__radio {
  border-color: var(--bili);
  box-shadow: inset 0 0 0 3px var(--bili);
}

.pick__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.pick__name {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 570;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick__sub {
  color: var(--ink-mist);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick__del {
  flex: 0 0 auto;
  padding: 4px 12px;
  color: var(--ink-faint);
  font-size: 15px;
  line-height: 1;
}

.pick__del:hover {
  color: var(--err);
}

/* ---------------- 服务商分组与卡片 ---------------- */

.group {
  margin-bottom: 14px;
}

.group__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 7px;
}

.group__title {
  color: var(--ink-soft);
  font-size: 11px;
  font-weight: 620;
  letter-spacing: 0.4px;
}

.group__note {
  color: var(--ink-faint);
  font-size: 11px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 8px;
}

.card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  text-align: left;
  transition: border-color 0.15s, background 0.15s, transform 0.08s;
}

.card:hover {
  border-color: var(--line-strong);
  background: var(--surface-sunken);
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
  width: 30px;
  height: 30px;
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
  font-weight: 580;
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

/* ---------------- 连通性区块 ---------------- */

.conn {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  padding: 13px 15px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-sunken);
}

.conn__dot {
  width: 8px;
  height: 8px;
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
  font-size: 12.5px;
  font-weight: 580;
}

.conn__note {
  margin: 2px 0 0;
  color: var(--ink-mist);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.conn__host {
  margin: 3px 0 0;
  color: var(--ink-faint);
  font-size: 11px;
}

.conn__acts {
  display: flex;
  flex: 0 0 auto;
  gap: 7px;
}

.conn--ok {
  border-color: rgba(15, 157, 110, 0.3);
  background: var(--ok-wash);
}
.conn--ok .conn__dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-wash);
}

.conn--need-permission {
  border-color: rgba(199, 122, 8, 0.32);
  background: var(--warn-wash);
}
.conn--need-permission .conn__dot {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-wash);
}

.conn--failed {
  border-color: rgba(217, 59, 71, 0.3);
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
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 var(--bili-wash);
  }
  50% {
    opacity: 0.5;
    box-shadow: 0 0 0 5px var(--bili-wash);
  }
}

/* ---------------- 分段控件 ---------------- */

.seg {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-sunken);
}

.seg__item {
  padding: 6px 14px;
  border-radius: var(--r-sm);
  color: var(--ink-soft);
  font-size: 12.5px;
  font-weight: 500;
  transition: background 0.14s, color 0.14s;
}

.seg__item:hover:not(:disabled) {
  color: var(--ink);
}

.seg__item--on {
  background: var(--surface);
  color: var(--bili-deep);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

.seg__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------------- 开关 ---------------- */

.toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.toggle:hover {
  border-color: var(--line-strong);
}

.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle__box {
  position: relative;
  width: 32px;
  height: 18px;
  flex: 0 0 auto;
  margin-top: 1px;
  border-radius: 9px;
  background: var(--line-strong);
  transition: background 0.18s;
}

.toggle__box::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform 0.18s;
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
  font-size: 12.5px;
  font-weight: 570;
}

.toggle__text em {
  display: block;
  margin-top: 2px;
  color: var(--ink-mist);
  font-size: 11.5px;
  font-style: normal;
}

/* ---------------- 目录选择 ---------------- */

.dir {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface-sunken);
}

.dir__icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--line);
  color: var(--ink-mist);
  font-size: 11px;
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
  font-size: 12.5px;
  font-weight: 550;
}

.dir__name--empty {
  color: var(--ink-faint);
  font-weight: 400;
}

/* ---------------- 按钮 ---------------- */

.btn {
  padding: 8px 16px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 530;
  white-space: nowrap;
  transition: background 0.14s, border-color 0.14s, transform 0.08s;
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
  font-weight: 560;
}

.btn--primary:hover:not(:disabled) {
  background: var(--bili-deep);
  border-color: var(--bili-deep);
}

/* ---------------- 底部 ----------------
 *
 * 这里必须用**不透明**背景。
 *
 * 早先写的是 linear-gradient(to top, var(--paper) 72%, transparent)，
 * 想做一个「渐隐」的柔和边缘。但底栏是 position:sticky 压在内容上的，
 * 渐变顶部那 28% 全透明，于是滚动时下方的表单就从底栏里透出来，
 * 看起来像页面渲染坏了（实测重叠 48px）。
 *
 * 现在改成实色 + 一条上边框，与侧边栏底栏保持一致：
 * 分隔靠边框，不靠透明度——透明度在这里只会变成「漏底」。
 *
 * 负外边距用来抵消 .page 的左右内边距（28px），
 * 让底栏背景铺满整个内容列；否则两侧各留 28px 透明缝隙，
 * 滚动内容会从缝里露出来。padding 再把内容推回原位。
 * z-index 同样必要，否则内容会盖在底栏之上。
 */

.foot {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 22px -28px -88px;
  padding: 14px 28px;
  background: var(--paper);
  border-top: 1px solid var(--line);
}

.foot__dirty {
  color: var(--warn);
  font-size: 12.5px;
  font-weight: 550;
}

.foot__ok {
  color: var(--ok);
  font-size: 12.5px;
  font-weight: 550;
}

.foot__idle {
  color: var(--ink-faint);
  font-size: 12.5px;
}

.foot__acts {
  display: flex;
  gap: 9px;
}
</style>
