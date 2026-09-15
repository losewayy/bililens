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
const {
  state,
  chat,
  chatSessions,
  activeChatId,
  chatBusy,
  chatStatus,
  playhead,
  renderableMarkdown,
  isBusy,
  stopNote,
  stopChat,
} = reader;

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

const isCopied = ref(false);

async function copyMarkdown(): Promise<void> {
  try {
    await navigator.clipboard.writeText(state.value.markdown);
    isCopied.value = true;
    setTimeout(() => (isCopied.value = false), 2000);
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
    <!-- 顶栏：品牌与微工具 -->
    <header class="sp-header-dock">
      <div class="sp-brand-row">
        <div class="sp-brand-badge-group">
          <span class="sp-monogram">B</span>
          <span class="sp-product-title">BiliLens</span>
        </div>
        <div class="sp-tools-cluster">
          <button
            v-if="state.markdown"
            class="sp-icon-button"
            :class="{ 'success-flash': isCopied || exportMsg.length > 0 }"
            :title="settings?.saveMode === 'obsidian' && settings?.obsidian.enabled ? '存入 Obsidian' : '复制 Markdown'"
            @click="settings?.saveMode === 'obsidian' && settings?.obsidian.enabled ? doExport() : copyMarkdown()"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </button>
          <button class="sp-icon-button" title="设置" aria-label="设置" @click="openOptions">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
          </button>
        </div>
      </div>

      <!-- 视频锚点微卡片 -->
      <VideoHeader
        v-if="state.info"
        :info="state.info"
        :conclusion="state.conclusion"
        :material-hint="materialHint"
        :subtitle-count="state.subtitleCount"
        :get-subtitles="reader.getSubtitles"
      />
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
      <TabBar
        :tab="tab"
        :has-note="!!state.markdown"
        :has-chat="hasChat"
        :note-busy="isBusy"
        :chat-busy="chatBusy"
        @change="changeTab"
      />

      <!-- 主视口内容容器 -->
      <main class="panel__content">
        <!-- ============ 目录 ============ -->
        <div v-show="tab === 'note'" class="tab-pane tab-pane--note">
          <!-- 正在生成状态条 -->
          <div v-if="isBusy" class="note-generating-bar">
            <div class="note-generating-progress-rail">
              <div
                class="note-generating-progress-bar"
                :class="{ 'is-determinate': typeof state.progressPercent === 'number' }"
                :style="typeof state.progressPercent === 'number' ? { width: Math.min(100, Math.max(2, state.progressPercent)) + '%' } : {}"
              />
            </div>
            <span class="spinner" />
            <span class="note-generating-status">{{ state.status || '正在生成精读笔记…' }}</span>
          </div>

          <!-- 错误 -->
          <div v-if="state.phase === 'error'" class="notice notice--error">
            <p class="notice__title">{{ state.errorTitle || '任务未能完成' }}</p>
            <p class="notice__body notice__body--wrap">{{ state.error }}</p>
            <div class="notice__actions">
              <button
                v-if="
                  state.errorCategory === 'model_not_configured' ||
                  state.errorCategory === 'provider_error' ||
                  state.errorCategory === 'asr_not_started' ||
                  state.errorCategory === 'no_subtitle'
                "
                class="btn btn--primary"
                @click="openOptions"
              >
                前往设置
              </button>
              <button class="btn" @click="startNote">重试</button>
            </div>
          </div>

          <!-- 正文（含时间轴导轨） -->
          <div v-if="state.markdown" class="body">
            <NoteBody :html="renderedHtml" :streaming="isStreaming" @seek="onSeek" />
          </div>

          <!-- 待生成 -->
          <PendingNote v-else-if="!isBusy && state.phase !== 'error'" />
        </div>

        <!-- ============ 聊天 ============ -->
        <div v-show="tab === 'chat'" class="tab-pane tab-pane--chat">
          <ChatPanel
            :bubbles="chat"
            :sessions="chatSessions"
            :active-id="activeChatId"
            :busy="chatBusy"
            :status="chatStatus"
            :send-playhead="settings?.sendPlayhead ?? false"
            :playhead="playhead"
            :ready="!configMissing"
            @send="onSend"
            @stop="stopChat"
            @seek="onSeek"
            @update:send-playhead="setSendPlayhead"
            @clear="reader.clearChatHistory()"
            @new="onNewChat"
            @select="onSelectChat"
            @remove="onRemoveChat"
          />
        </div>
      </main>

      <!-- 固定底舱容器（完全脱离内部滚动层与页面切换动画，杜绝任何位移与跳动） -->
      <div v-if="tab === 'note'" class="sp-bottom-dock-container">
        <div class="sp-dock-footer">
          <button
            v-if="!isBusy"
            class="machined-btn-primary"
            @click="startNote"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path v-if="state.markdown" d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              <polygon v-else points="5 3 19 12 5 21 5 3" />
            </svg>
            <span>{{ state.markdown ? '重新生成精读' : '生成精读笔记' }}</span>
          </button>
          <button
            v-else
            class="machined-btn-primary machined-btn-stop"
            @click="stopNote"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <span>停止生成</span>
          </button>

          <template v-if="state.markdown && !isBusy">
            <button
              v-if="settings?.saveMode === 'obsidian' && settings?.obsidian.enabled"
              class="machined-btn-ghost"
              @click="doExport"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span>存入 Obsidian</span>
            </button>
            <button
              class="machined-btn-ghost"
              :class="{ 'is-copied': isCopied }"
              @click="copyMarkdown"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{{ isCopied ? '已复制' : '复制 MD' }}</span>
            </button>
          </template>
        </div>
      </div>

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
  background: var(--paper);
  overflow: hidden;
}

.panel__content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.tab-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  animation: paneFade 150ms var(--ease);
}

@keyframes paneFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.tab-pane--note {
  overflow-y: auto;
}

.tab-pane--chat {
  height: 100%;
}

/* ---------------- 顶栏 ---------------- */

.sp-header-dock {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg-panel);
}

.sp-brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.sp-brand-badge-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-monogram {
  width: 17px;
  height: 17px;
  border-radius: 4px;
  background: var(--bili);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sp-product-title {
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text-hero);
}

.sp-tools-cluster {
  display: flex;
  align-items: center;
  gap: 3px;
}

.sp-icon-button {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  transition: all var(--duration) var(--ease);
  position: relative;
  background: transparent;
  border: none;
  cursor: pointer;
}

.sp-icon-button:hover {
  background: var(--bg-surface-hover);
  color: var(--text-hero);
}

.sp-icon-button.success-flash {
  color: var(--ok);
  background: var(--ok-wash);
  animation: iconFlash 1.4s var(--ease);
}

@keyframes iconFlash {
  0%,
  100% {
    transform: scale(1);
  }
  30% {
    transform: scale(1.15);
  }
}

/* ---------------- 提示块 ---------------- */

.notice {
  margin: 11px 12px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
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

.notice__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
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
  border: 1px solid var(--bili-line);
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

/* ---------------- 正在生成状态条 ---------------- */

.note-generating-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: var(--bili-wash);
  border-bottom: 1px solid var(--bili-line);
  color: var(--bili);
  font-size: calc(12px * var(--fs));
  font-weight: 550;
  overflow: hidden;
}

.note-generating-progress-rail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(251, 114, 153, 0.16);
  overflow: hidden;
}

.note-generating-progress-bar {
  width: 45%;
  height: 100%;
  background: var(--bili);
  border-radius: 2px;
  animation: progress-slide 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.note-generating-progress-bar.is-determinate {
  animation: none;
  transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 0 8px rgba(251, 114, 153, 0.5);
}

@keyframes progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(260%);
  }
}

.note-generating-status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
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
  flex: 1;
  min-height: 0;
  padding: 4px 12px 14px;
}

/* ---------------- 固定底舱容器 ---------------- */

.sp-bottom-dock-container {
  flex-shrink: 0;
  background: var(--bg-glass);
  backdrop-filter: blur(20px);
  border-top: 1px solid var(--border-hairline);
  position: relative;
  z-index: 10;
}

.sp-dock-footer {
  padding: 10px 14px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.machined-btn-primary {
  flex: 1;
  height: 32px;
  background: var(--bili);
  color: #fff;
  border-radius: var(--r-md);
  font-size: calc(12.5px * var(--fs));
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: all var(--duration) var(--ease);
  border: none;
  cursor: pointer;
}

.machined-btn-primary:hover {
  background: var(--bili-hover);
  transform: translateY(-0.5px);
}

.machined-btn-primary:active {
  transform: translateY(0);
}

.machined-btn-stop {
  background: var(--bg-surface);
  color: var(--text-hero);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-bevel);
}

.machined-btn-stop:hover {
  background: var(--err-wash);
  color: var(--err);
  border-color: var(--err);
}

.machined-btn-ghost {
  height: 32px;
  padding: 0 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  font-size: calc(12px * var(--fs));
  font-weight: 500;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 5px;
  box-shadow: var(--shadow-bevel);
  transition: all var(--duration) var(--ease);
  cursor: pointer;
}

.machined-btn-ghost:hover {
  background: var(--bg-surface-hover);
  color: var(--text-hero);
  border-color: var(--border-medium);
}

.machined-btn-ghost.is-copied {
  color: var(--ok);
  border-color: var(--ok);
  background: var(--ok-wash);
}

/* ---------------- 基础按钮兼容 ---------------- */

.btn {
  padding: 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
  font-size: calc(12.5px * var(--fs));
  font-weight: 530;
  box-shadow: var(--shadow-card);
  transition: all var(--duration) var(--ease);
}

.btn:hover {
  background: var(--surface-hover);
  border-color: var(--ink-mist);
}

.btn:active {
  transform: translateY(0.5px);
}

.btn--primary {
  border-color: var(--bili);
  background: var(--bili);
  color: #fff;
  font-weight: 560;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.btn--primary:hover {
  background: var(--bili-hover);
  border-color: var(--bili-hover);
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
