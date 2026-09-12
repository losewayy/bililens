<script setup lang="ts">
/**
 * VideoHeader.vue —— 视频信息头
 *
 * 相较旧版做了压缩：封面缩到 44px 方形，元信息并成一行，
 * 素材状态收为行内小字 —— 把纵向空间让给笔记正文。
 */
import { computed } from 'vue';
import type { Conclusion, VideoInfo } from '@/lib/types';
import { fmtCount, fmtDuration } from '@/lib/time';

const props = defineProps<{
  info: VideoInfo;
  conclusion: Conclusion | null;
  materialHint: string;
  subtitleCount: number;
}>();

const durationText = computed(() => fmtDuration(props.info.duration));
const viewText = computed(() => (props.info.view ? `${fmtCount(props.info.view)} 播放` : ''));

const hasOfficial = computed(() => props.conclusion?.available === true);
const hasMaterial = computed(() => props.subtitleCount > 0);

/** 多P视频时显示当前是第几 P */
const pageText = computed(() =>
  props.info.pageCount > 1 ? `P${props.info.pageIndex}/${props.info.pageCount}` : '',
);
</script>

<template>
  <section class="vh">
    <img v-if="info.cover" class="vh__cover" :src="info.cover" alt="" loading="lazy" />

    <div class="vh__main">
      <h1 class="vh__title" :title="info.title">{{ info.title }}</h1>

      <p class="vh__meta">
        <span class="vh__up">{{ info.upName || '未知UP' }}</span>
        <span class="vh__dot">·</span>
        <span class="tnum">{{ durationText }}</span>
        <template v-if="viewText">
          <span class="vh__dot">·</span>
          <span class="tnum">{{ viewText }}</span>
        </template>
        <template v-if="pageText">
          <span class="vh__dot">·</span>
          <span class="tnum">{{ pageText }}</span>
        </template>
      </p>

      <!-- 素材状态：开跑前让用户知道素材够不够 -->
      <p class="vh__mat">
        <span class="chip" :class="hasOfficial ? 'chip--on' : 'chip--off'">
          {{ hasOfficial ? '官方总结' : '无官方总结' }}
        </span>
        <span class="chip" :class="hasMaterial ? 'chip--on' : 'chip--off'">
          {{ hasMaterial ? `字幕 ${subtitleCount}` : '无字幕' }}
        </span>
        <span v-if="info.partTitle" class="vh__part" :title="info.partTitle">
          {{ info.partTitle }}
        </span>
      </p>
    </div>
  </section>

  <p v-if="materialHint && !hasMaterial" class="vh-hint">{{ materialHint }}</p>
</template>

<style scoped>
.vh {
  display: flex;
  gap: 10px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid var(--line);
}

.vh__cover {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  object-fit: cover;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface-sunken);
}

.vh__main {
  min-width: 0;
  flex: 1;
}

.vh__title {
  margin: 0 0 3px;
  font-size: calc(13px * var(--fs));
  font-weight: 640;
  line-height: 1.45;
  letter-spacing: -0.1px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.vh__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 5px;
  color: var(--ink-mist);
  font-size: calc(11.5px * var(--fs));
  white-space: nowrap;
  overflow: hidden;
}

.vh__up {
  color: var(--bili-deep);
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vh__dot {
  color: var(--ink-faint);
}

.vh__mat {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  min-width: 0;
}

/* 素材徽章：行内小字，不抢视觉 */
.chip {
  padding: 1px 7px;
  border-radius: 20px;
  font-size: calc(10.5px * var(--fs));
  font-weight: 550;
  white-space: nowrap;
}

.chip--on {
  background: var(--ok-wash);
  color: var(--ok);
}

.chip--off {
  background: var(--surface-sunken);
  color: var(--ink-faint);
}

.vh__part {
  margin-left: 2px;
  color: var(--ink-faint);
  font-size: calc(10.5px * var(--fs));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-hint {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--warn-wash);
  color: var(--warn);
  font-size: calc(11.5px * var(--fs));
  line-height: 1.55;
}
</style>
