<script setup lang="ts">
/**
 * VideoHeader.vue —— 视频锚点微卡片（1:1 对齐 mock sp-video-anchor-box）
 */
import { computed } from 'vue';
import type { Conclusion, VideoInfo } from '@/lib/types';
import { fmtDuration } from '@/lib/time';

const props = defineProps<{
  info: VideoInfo;
  conclusion: Conclusion | null;
  materialHint: string;
  subtitleCount: number;
}>();

const durationText = computed(() => fmtDuration(props.info.duration));
const hasOfficial = computed(() => props.conclusion?.available === true);
const hasMaterial = computed(() => props.subtitleCount > 0);

const statusText = computed(() => {
  if (hasOfficial.value && hasMaterial.value) return '官方总结 + 字幕已同步';
  if (hasOfficial.value) return '官方总结已同步';
  if (hasMaterial.value) return `字幕已同步 · ${props.subtitleCount} 条`;
  return '无可用字幕';
});

const isStatusOk = computed(() => hasOfficial.value || hasMaterial.value);
</script>

<template>
  <div class="vh-dock">
    <div class="sp-video-anchor-box">
      <img v-if="info.cover" class="sp-anchor-thumb" :src="info.cover" alt="" loading="lazy" />
      <div v-else class="sp-anchor-thumb sp-anchor-thumb--empty" />

      <div class="sp-anchor-meta">
        <div class="sp-anchor-title" :title="info.title">{{ info.title }}</div>
        <div class="sp-anchor-sub">
          <span class="sp-status-chip" :class="{ 'sp-status-chip--off': !isStatusOk }">
            {{ statusText }}
          </span>
          <span class="sp-anchor-duration">· {{ durationText }}</span>
        </div>
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

.sp-anchor-duration {
  font-family: var(--font-time);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
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
