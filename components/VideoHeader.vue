<script setup lang="ts">
/**
 * VideoHeader.vue —— 视频锚点微卡片（1:1 对齐 mock sp-video-anchor-box）
 *
 * 【字幕下载】
 * 封面右侧一个小按钮，点开选格式（SRT / VTT / 纯文本）直接下载。
 * 数据源两级：官方 AI 总结自带的字幕就在 conclusion 里，零采集直接下载；
 * 字幕轨来源的（官方总结不可用的视频）走 getSubtitles 回调，
 * 会触发一次采集（与目录/聊天共享缓存与去重），按钮转圈等它。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Conclusion, SubtitleSegment, VideoInfo } from '@/lib/types';
import { fmtDuration } from '@/lib/time';
import { downloadSubtitles, SUBTITLE_FORMATS, type SubtitleFormat } from '@/lib/subtitles';

const props = defineProps<{
  info: VideoInfo;
  conclusion: Conclusion | null;
  materialHint: string;
  subtitleCount: number;
  /** 字幕轨兜底来源：官方总结不可用时由面板传入（内部走素材缓存/采集） */
  getSubtitles?: () => Promise<SubtitleSegment[] | null>;
}>();

const durationText = computed(() => fmtDuration(props.info.duration));
const hasOfficial = computed(() => props.conclusion?.available === true);
const hasMaterial = computed(() => props.subtitleCount > 0);
/** 官方总结自带的字幕条数（下载的零等待数据源） */
const officialCount = computed(() =>
  props.conclusion?.available ? props.conclusion.subtitle.length : 0,
);
const hasSubtitles = computed(() => officialCount.value > 0 || hasMaterial.value);

const statusText = computed(() => {
  if (hasOfficial.value && hasMaterial.value) return '官方总结 + 字幕已同步';
  if (hasOfficial.value) return '官方总结已同步';
  if (hasMaterial.value) return `字幕已同步 · ${props.subtitleCount} 条`;
  // 元信息还没回来（预取中/预取失败）——不下「无可用」的结论
  if (isPending.value) return '检测字幕资源…';
  return '无可用字幕';
});

const isStatusOk = computed(() => hasOfficial.value || hasMaterial.value);
const isPending = computed(() => !props.conclusion && !hasMaterial.value);

/* ---------------- 字幕下载 ---------------- */

const menuOpen = ref(false);
const collecting = ref(false);
const anchorEl = ref<HTMLElement | null>(null);

function toggleMenu(): void {
  if (collecting.value) return;
  menuOpen.value = !menuOpen.value;
}

async function pick(format: SubtitleFormat): Promise<void> {
  menuOpen.value = false;
  if (collecting.value) return;

  // 官方总结自带字幕：直接用，零等待
  if (officialCount.value > 0 && props.conclusion?.available) {
    void downloadSubtitles(props.conclusion.subtitle, props.info.title, format);
    return;
  }

  // 字幕轨来源：现场采集一次（有缓存则瞬时）
  if (!props.getSubtitles) return;
  collecting.value = true;
  try {
    const segments = await props.getSubtitles();
    if (segments?.length) {
      await downloadSubtitles(segments, props.info.title, format);
    }
  } finally {
    collecting.value = false;
  }
}

function onDocPointerDown(e: PointerEvent): void {
  if (menuOpen.value && anchorEl.value && !anchorEl.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuOpen.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onDocKeydown);
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onDocKeydown);
});
</script>

<template>
  <div class="vh-dock">
    <div ref="anchorEl" class="sp-video-anchor-box">
      <img v-if="info.cover" class="sp-anchor-thumb" :src="info.cover" alt="" loading="lazy" />
      <div v-else class="sp-anchor-thumb sp-anchor-thumb--empty" />

      <div class="sp-anchor-meta">
        <div class="sp-anchor-title" :title="info.title">{{ info.title }}</div>
        <div class="sp-anchor-sub">
          <span
            class="sp-status-chip"
            :class="{ 'sp-status-chip--off': !isStatusOk && !isPending, 'sp-status-chip--pending': isPending }"
          >
            {{ statusText }}
          </span>
          <span class="sp-anchor-duration">· {{ durationText }}</span>
        </div>
      </div>

      <!-- 字幕下载：有字幕才出现；采集中的兜底路径转圈等待 -->
      <button
        v-if="hasSubtitles"
        class="vh-dl-btn"
        :class="{ 'vh-dl-btn--open': menuOpen }"
        :disabled="collecting"
        title="下载字幕"
        aria-label="下载字幕"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="toggleMenu"
      >
        <span v-if="collecting" class="vh-dl-spinner" aria-hidden="true" />
        <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 1a.75.75 0 0 1 .75.75v6.19l2.22-2.22a.75.75 0 1 1 1.06 1.06L8.5 10.31a.7.7 0 0 1-1 0L3.97 6.78a.75.75 0 0 1 1.06-1.06l2.22 2.22V1.75A.75.75 0 0 1 8 1ZM2.75 12.5h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5Z"
          />
        </svg>
      </button>

      <div v-if="menuOpen" class="vh-dl-menu" role="menu" aria-label="字幕格式">
        <button
          v-for="f in SUBTITLE_FORMATS"
          :key="f.id"
          class="vh-dl-item"
          role="menuitem"
          @click="pick(f.id)"
        >
          {{ f.label }}
          <span class="vh-dl-ext tnum">.{{ f.ext }}</span>
        </button>
      </div>
    </div>

    <p v-if="materialHint && !hasMaterial" class="vh-hint">{{ materialHint }}</p>
  </div>
</template>

<style scoped>
.vh-dock {
  padding: 0 12px 6px;
  background: var(--bg-panel, var(--paper));
}

.sp-video-anchor-box {
  position: relative; /* 下载菜单的定位基准 */
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--bg-sunken, var(--surface-sunken));
  border: 1px solid var(--border-hairline, var(--line));
  border-radius: var(--r-md);
  padding: 6px 9px;
  box-shadow: var(--shadow-sunken);
}

.sp-anchor-thumb {
  width: 42px;
  height: 28px;
  border-radius: 3px;
  object-fit: cover;
  background: var(--bg-surface, var(--surface));
  flex-shrink: 0;
  border: 1px solid var(--border-subtle, var(--line));
}

.sp-anchor-thumb--empty {
  background: var(--bg-surface-active, var(--surface-sunken));
}

.sp-anchor-meta {
  flex: 1;
  min-width: 0;
}

.sp-anchor-title {
  font-size: calc(12px * var(--fs));
  font-weight: 600;
  color: var(--text-main, var(--ink));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}

.sp-anchor-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(10.5px * var(--fs));
  color: var(--text-muted, var(--ink-mist));
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
}

.sp-status-chip {
  color: var(--ok);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 530;
  flex-shrink: 0;
}

.sp-status-chip::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.sp-status-chip--off {
  color: var(--warn);
}

.sp-status-chip--pending {
  color: var(--text-muted, var(--ink-mist));
}

.sp-anchor-duration {
  font-family: var(--font-time);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ---------------- 字幕下载 ---------------- */

.vh-dl-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-subtle, var(--line));
  border-radius: var(--r-sm);
  background: var(--bg-surface, var(--surface));
  color: var(--text-secondary, var(--ink-soft));
  transition: border-color 0.14s, color 0.14s;
}

.vh-dl-btn:hover:not(:disabled),
.vh-dl-btn--open {
  border-color: var(--bili, var(--bili));
  color: var(--bili-deep);
}

.vh-dl-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}

.vh-dl-spinner {
  width: 11px;
  height: 11px;
  border: 2px solid var(--border-medium, var(--line-strong));
  border-top-color: var(--bili);
  border-radius: 50%;
  animation: vh-dl-spin 0.68s linear infinite;
}

@keyframes vh-dl-spin {
  to {
    transform: rotate(360deg);
  }
}

.vh-dl-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 6px;
  z-index: 30;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--border-medium, var(--line-strong));
  border-radius: var(--r-md);
  background: var(--bg-surface, var(--surface));
  box-shadow: var(--shadow-1);
}

.vh-dl-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary, var(--ink-soft));
  font-size: calc(12px * var(--fs));
  text-align: left;
  transition: background 0.14s, color 0.14s;
}

.vh-dl-item:hover {
  background: var(--bg-surface-active, var(--surface-sunken));
  color: var(--text-main, var(--ink));
}

.vh-dl-ext {
  color: var(--text-faint, var(--ink-faint));
  font-family: var(--font-time);
  font-size: calc(10.5px * var(--fs));
}

.vh-hint {
  margin: 6px 0 0;
  padding: 4px 8px;
  border-radius: var(--r-sm);
  background: var(--warn-wash);
  color: var(--warn);
  font-size: calc(11px * var(--fs));
  line-height: 1.4;
}
</style>
