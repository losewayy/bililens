<script setup lang="ts">
/**
 * entrypoints/sidepanel/App.vue —— 面板外壳
 *
 * 两个功能页，共享同一份视频材料：
 *   · 目录：生成带时间戳的结构化笔记
 *   · 聊天：带着同一份字幕追问
 *
 * 【每个标签页一个实例】
 * 后台把侧边栏声明为标签页级（见 background.ts），
 * 且只有用户点过图标的那一页才启用。因此本组件天然是
 * 「一个视频页一个实例」：多开几个视频页并行精读时互不干扰。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { browser } from 'wxt/browser';

import { useReader } from '@/composables/useReader';
import { askContent, seekVideo } from '@/composables/useBridge';
import { loadSettings, onSettingsChanged, patchSettings } from '@/lib/storage';
import { normalizeFontScale, setFontScale } from '@/lib/fontScale';
import { renderMarkdown, injectSectionAnchors, extractSections } from '@/lib/markdown';
import { exportNote } from '@/lib/export';
import { getActiveProfile, type ChatImage, type PanelTab, type Settings } from '@/lib/types';

import VideoHeader from '@/components/VideoHeader.vue';
import TabBar from '@/components/TabBar.vue';
import NoteBody from '@/components/NoteBody.vue';
import PendingNote from '@/components/PendingNote.vue';
import ChatPanel from '@/components/ChatPanel.vue';

const settings = ref<Settings | null>(null);
const reader = useReader();
const { state, chat, chatSessions, activeChatId, chatBusy, chatStatus, playhead, renderableMarkdown, isBusy } =
  reader;

const exportMsg = ref('');
const exportErr = ref('');

/** 当前功能页（本地状态 + 持久化到设置，下次打开还在这一页） */
const tab = ref<PanelTab>('note');

/* ---------------------------------------------------------------- *
 * 设置加载与视频切换监听
 * ---------------------------------------------------------------- */

let offSettings: (() => void) | null = null;
let offTabActivated: (() => void) | null = null;
let offTabUpdated: (() => void) | null = null;
let offRuntimeMsg: (() => void) | null = null;

/** 防抖：B站是 SPA，URL 会连续变化多次 */
let syncTimer: number | null = null;
function scheduleSync(): void {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    if (settings.value) void reader.sync(settings.value);
  }, 600);
}

onMounted(async () => {
  settings.value = await loadSettings();
  tab.value = settings.value.tab;
  await reader.init(settings.value);

  offSettings = onSettingsChanged((s) => {
    settings.value = s;
    // 字号即时生效：用户在设置页改完一保存，这边不用重开就变
    setFontScale(normalizeFontScale(s.fontScale));
  });

  const onActivated = (): void => scheduleSync();
  browser.tabs.onActivated.addListener(onActivated);
  offTabActivated = () => browser.tabs.onActivated.removeListener(onActivated);

  const onUpdated = (changedTabId: number, info: { url?: string }): void => {
    if (info.url === undefined) return;
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs[0]?.id === changedTabId) scheduleSync();
      })
      .catch(() => undefined);
  };
  browser.tabs.onUpdated.addListener(onUpdated);
  offTabUpdated = () => browser.tabs.onUpdated.removeListener(onUpdated);

  const onRuntimeMsg = (msg: { __target?: string; type?: string }): void => {
    if (msg?.__target === 'background' && msg.type === 'urlChanged') scheduleSync();
  };
  browser.runtime.onMessage.addListener(onRuntimeMsg);
  offRuntimeMsg = () => browser.runtime.onMessage.removeListener(onRuntimeMsg);

  startPlayheadWatch();
});

onUnmounted(() => {
  offSettings?.();
  offTabActivated?.();
  offTabUpdated?.();
  offRuntimeMsg?.();
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  if (playheadTimer !== null) window.clearInterval(playheadTimer);
  reader.stop();
});

/* ---------------------------------------------------------------- *
 * 播放位置轮询
 *
 * 只在「聊天页 + 开关打开」时才轮询——其余时候毫无用处。
 * 间隔 3 秒：足够跟上进度，又不至于让页面桥频繁通信。
 * ---------------------------------------------------------------- */

let playheadTimer: number | null = null;

function startPlayheadWatch(): void {
  if (playheadTimer !== null) return;
  playheadTimer = window.setInterval(() => {
    if (!settings.value?.sendPlayhead || tab.value !== 'chat') return;
    const tabId = reader.getTabId();
    if (tabId === null) return;
    void askContent(tabId, 'playhead', undefined, 3000)
      .then((r) => {
        playhead.value = r.seconds;
      })
      .catch(() => undefined);
  }, 3000);
}

/* ---------------------------------------------------------------- *
 * 渲染
 * ---------------------------------------------------------------- */

const renderedHtml = computed(() => {
  const md = renderableMarkdown.value;
  if (!md) return '';
  return injectSectionAnchors(renderMarkdown(md), extractSections(md));
});

const isStreaming = computed(() => state.value.phase === 'generating');
const configMissing = computed(() => {
  const p = settings.value ? getActiveProfile(settings.value) : null;
  return !p?.baseURL || !p.model;
});

/* ---------------------------------------------------------------- *
 * 操作
 * ---------------------------------------------------------------- */

/**
 * 改单个设置项。
 *
 * 必须走 patchSettings（读-改-写），不能把内存里的整份 settings
 * 直接写回去：面板初始化期间（等 videoInfo 的几秒）设置页可能
 * 刚保存过，整包写回会把那份旧副本盖到新设置上——
 * 「支持图像输入」开关莫名丢失就是这个原因。
 */
async function changeTab(next: PanelTab): Promise<void> {
  tab.value = next;
  await patchSettings({ tab: next });
}

async function setSendPlayhead(value: boolean): Promise<void> {
  await patchSettings({ sendPlayhead: value });
  // 刚打开开关时立刻取一次，别让用户看着 --:-- 等 3 秒
  if (value) {
    const tabId = reader.getTabId();
    if (tabId !== null) {
      void askContent(tabId, 'playhead', undefined, 3000)
        .then((r) => (playhead.value = r.seconds))
        .catch(() => undefined);
    }
  }
}

async function startNote(): Promise<void> {
  if (!settings.value) return;
  await reader.runNote(settings.value);
}

function stop(): void {
  reader.stop();
}

async function onSend(text: string, images: ChatImage[]): Promise<void> {
  if (!settings.value) return;
  await reader.sendChat(settings.value, text, images);
}

/* 聊天的多对话管理（确认框已在 ChatPanel 里做） */
function onNewChat(): void {
  reader.newChatSession();
}

async function onSelectChat(id: string): Promise<void> {
  await reader.switchChatSession(id);
}

function onRemoveChat(id: string): void {
  void reader.deleteChatSession(id);
}

async function onSeek(seconds: number): Promise<void> {
  const tabId = reader.getTabId();
  if (tabId === null) return;
  await seekVideo(tabId, seconds);
}

async function doExport(): Promise<void> {
  exportMsg.value = '';
  exportErr.value = '';

  const s = settings.value;
  const info = state.value.info;
  if (!s || !info) return;
  if (!state.value.markdown) {
    exportErr.value = '还没有可保存的内容';
    return;
  }

  try {
    const where = await exportNote(
      state.value.markdown,
      {
        title: info.title,
        upName: info.upName,
        bvid: info.bvid,
        cid: info.cid,
        pageIndex: info.pageIndex,
        duration: info.duration,
        cover: info.cover,
        pubdate: info.pubdate,
        model: state.value.model,
        createdAt: Date.now(),
      },
      { saveMode: s.saveMode, obsidian: s.obsidian },
    );
    exportMsg.value = `已保存：${where}`;
    setTimeout(() => (exportMsg.value = ''), 5000);
  } catch (e) {
    exportErr.value = e instanceof Error ? e.message : String(e);
  }
}

async function copyMarkdown(): Promise<void> {
  try {
    await navigator.clipboard.writeText(state.value.markdown);
    exportMsg.value = '已复制到剪贴板';
    setTimeout(() => (exportMsg.value = ''), 2600);
  } catch {
    exportErr.value = '复制失败，请手动选择文本';
  }
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

/* ---------------------------------------------------------------- *
 * 素材状态
 * ---------------------------------------------------------------- */

const materialHint = computed(() => {
  const c = state.value.conclusion;
  const n = state.value.subtitleCount;
  if (n > 0) return state.value.subtitleSource;
  if (c && !c.available) return c.reason;
  return '';
});

const hasChat = computed(() => chat.value.length > 0);

/* 生成结束后补一次同步（缓存由 useReader 写入，这里不重复写） */
watch(
  () => state.value.phase,
  async (p) => {
    if (p !== 'done') return;
    if (settings.value) await reader.flushPendingSync(settings.value);
  },
);
</script>

<template>
  <div class="panel">
    <!-- 顶栏 -->
    <header class="bar">
      <div class="bar__brand">
        <img class="bar__mark" :src="browser.runtime.getURL('/icons/icon32.png')" alt="" />
        <span class="bar__name">BiliLens</span>
      </div>
      <button class="bar__gear" title="设置" aria-label="设置" @click="openOptions">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-1.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z"
          />
          <path
            fill="currentColor"
            d="M6.9 1.3h2.2l.3 1.5.9.4 1.4-.7 1.6 1.6-.7 1.4.4.9 1.5.3v2.2l-1.5.3-.4.9.7 1.4-1.6 1.6-1.4-.7-.9.4-.3 1.5H6.9l-.3-1.5-.9-.4-1.4.7-1.6-1.6.7-1.4-.4-.9-1.5-.3V5.7l1.5-.3.4-.9-.7-1.4 1.6-1.6 1.4.7.9-.4.3-1.5Zm1.7 1.4h-.4l-.2 1.1-.3.1-1.2.5-.3.1-.9-.5-.8.8.5.9-.1.3-.5 1.2-.1.3-1.1.2v.4l1.1.2.1.3.5 1.2.1.3-.5.9.8.8.9-.5.3.1 1.2.5.3.1.2 1.1h.4l.2-1.1.3-.1 1.2-.5.3-.1.9.5.8-.8-.5-.9.1-.3.5-1.2.1-.3 1.1-.2v-.4l-1.1-.2-.1-.3-.5-1.2-.1-.3.5-.9-.8-.8-.9.5-.3-.1-1.2-.5-.3-.1-.2-1.1Z"
          />
        </svg>
      </button>
    </header>

    <!-- 未配置模型 -->
    <div v-if="configMissing" class="notice notice--warn">
      <p class="notice__title">还没配置大模型</p>
      <p class="notice__body">
        笔记与聊天都由你自己的模型完成。填入 API 地址与模型名即可，支持任何 OpenAI 兼容端点。
      </p>
      <button class="btn btn--primary" @click="openOptions">去配置</button>
    </div>

    <!-- 读取中 -->
    <div v-else-if="state.phase === 'loading'" class="placeholder">
      <span class="spinner" />
      <p>正在读取当前页面…</p>
    </div>

    <!-- 非视频页 -->
    <div v-else-if="!state.info" class="placeholder">
      <span class="placeholder__glyph">▶</span>
      <p class="placeholder__title">打开一个 B站视频页</p>
      <p class="placeholder__desc">
        侧边栏会自动识别当前视频，可以生成带时间戳的笔记，也可以直接向它提问。
      </p>
    </div>

    <!-- 主内容 -->
    <template v-else>
      <VideoHeader
        :info="state.info"
        :conclusion="state.conclusion"
        :material-hint="materialHint"
        :subtitle-count="state.subtitleCount"
      />

      <TabBar
        :tab="tab"
        :has-note="!!state.markdown"
        :has-chat="hasChat"
        :busy="isBusy || chatBusy"
        @change="changeTab"
      />

      <!-- ============ 目录 ============ -->
      <template v-if="tab === 'note'">
        <!-- 生成按钮独立一行：它是这个页唯一的主操作 -->
        <div class="actbar">
          <button v-if="!isBusy" class="btn btn--primary actbar__go" @click="startNote">
            {{ state.markdown ? '重新生成' : '生成笔记' }}
          </button>
          <button v-else class="btn actbar__go" @click="stop">停止</button>
          <span v-if="isBusy" class="actbar__status">{{ state.status }}</span>
        </div>

        <!-- 错误 -->
        <div v-if="state.phase === 'error'" class="notice notice--error">
          <p class="notice__title">没能完成</p>
          <p class="notice__body notice__body--wrap">{{ state.error }}</p>
          <button class="btn" @click="startNote">重试</button>
        </div>

        <!-- 正文（含时间轴导轨） -->
        <div v-if="state.markdown" class="body">
          <NoteBody :html="renderedHtml" :streaming="isStreaming" @seek="onSeek" />
        </div>

        <!-- 待生成 -->
        <PendingNote v-else-if="!isBusy && state.phase !== 'error'" />

        <!-- 底部操作 -->
        <footer v-if="state.markdown && !isBusy" class="acts">
          <button class="btn btn--primary" @click="doExport">
            {{
              settings?.saveMode === 'obsidian' && settings?.obsidian.enabled
                ? '存入 Obsidian'
                : '下载 .md'
            }}
          </button>
          <button class="btn" @click="copyMarkdown">复制</button>
        </footer>
      </template>

      <!-- ============ 聊天 ============ -->
      <ChatPanel
        v-else
        :bubbles="chat"
        :sessions="chatSessions"
        :active-id="activeChatId"
        :busy="chatBusy"
        :status="chatStatus"
        :send-playhead="settings?.sendPlayhead ?? false"
        :playhead="playhead"
        :ready="!configMissing"
        @send="onSend"
        @stop="stop"
        @seek="onSeek"
        @update:send-playhead="setSendPlayhead"
        @clear="reader.clearChatHistory()"
        @new="onNewChat"
        @select="onSelectChat"
        @remove="onRemoveChat"
      />

      <p v-if="exportMsg" class="toast toast--ok">{{ exportMsg }}</p>
      <p v-if="exportErr" class="toast toast--err">{{ exportErr }}</p>
    </template>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-bottom: 6px;
}

/* ---------------- 顶栏 ---------------- */

.bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}

.bar__brand {
  display: flex;
  align-items: center;
  gap: 7px;
}

.bar__mark {
  width: 18px;
  height: 18px;
  border-radius: 5px;
}

.bar__name {
  font-size: calc(13px * var(--fs));
  font-weight: 660;
  letter-spacing: -0.1px;
}

.bar__gear {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  color: var(--ink-mist);
  transition: background 0.14s, color 0.14s;
}

.bar__gear:hover {
  background: var(--surface-sunken);
  color: var(--ink);
}

/* ---------------- 提示块 ---------------- */

.notice {
  margin: 11px 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.notice__title {
  margin: 0 0 4px;
  font-size: calc(13px * var(--fs));
  font-weight: 620;
}

.notice__body {
  margin: 0 0 10px;
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
  line-height: 1.6;
}

.notice__body--wrap {
  white-space: pre-wrap;
  word-break: break-word;
}

.notice--warn {
  border-color: rgba(199, 122, 8, 0.32);
  background: var(--warn-wash);
}

.notice--error {
  border-color: rgba(217, 59, 71, 0.3);
  background: var(--err-wash);
}

/* ---------------- 占位 ---------------- */

.placeholder {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 64px 30px;
  text-align: center;
}

.placeholder__glyph {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: var(--bili-wash);
  color: var(--bili);
  font-size: calc(15px * var(--fs));
}

.placeholder__title {
  margin: 0;
  font-size: calc(13.5px * var(--fs));
  font-weight: 620;
}

.placeholder__desc {
  margin: 0;
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
  line-height: 1.7;
}

.placeholder p {
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
}

/* ---------------- 操作行 ---------------- */

.actbar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}

.actbar__go {
  flex: 0 0 auto;
}

.actbar__status {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-soft);
  font-size: calc(12px * var(--fs));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spinner {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  border: 2px solid var(--line-strong);
  border-top-color: var(--bili);
  border-radius: 50%;
  animation: spin 0.68s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------------- 正文 ---------------- */

.body {
  display: flex;
  /* 布局限高后，笔记正文自己就是滚动区块 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px;
}

/* ---------------- 底部操作 ---------------- */

.acts {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  margin-top: 14px;
  background: var(--paper);
  border-top: 1px solid var(--line);
}

/* ---------------- 按钮 ---------------- */

.btn {
  padding: 7px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
  font-size: calc(12.5px * var(--fs));
  font-weight: 530;
  transition: background 0.14s, border-color 0.14s, transform 0.08s;
}

.btn:hover {
  background: var(--surface-sunken);
  border-color: var(--ink-faint);
}

.btn:active {
  transform: translateY(1px);
}

.btn--primary {
  border-color: var(--bili);
  background: var(--bili);
  color: #fff;
  font-weight: 560;
}

.btn--primary:hover {
  background: var(--bili-deep);
  border-color: var(--bili-deep);
}

/* ---------------- toast ---------------- */

.toast {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 58px;
  z-index: 30;
  margin: 0;
  padding: 9px 13px;
  border-radius: var(--r-sm);
  font-size: calc(12.5px * var(--fs));
  box-shadow: var(--shadow-2);
}

.toast--ok {
  background: var(--ok);
  color: #fff;
}

.toast--err {
  background: var(--err);
  color: #fff;
}
</style>
