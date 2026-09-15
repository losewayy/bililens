<script setup lang="ts">
/**
 * NoteBody.vue —— 笔记正文 + 时间轴导轨（签名元素）
 *
 * 【签名元素】左侧一条贯穿全篇的竖线，每个章节标题都是线上的一个刻度节点：
 *
 *     ┊
 *     ●  3:15  一对一、聚合来源与工程化信任
 *     ┊          · 反刍意见：只有一个老师会只剩单一视角
 *     ┊          · 回应：把来源和界面混为一谈……
 *     ┊
 *     ○  4:22  系统两大核心原则
 *     ┊
 *
 * 实心节点 = 当前阅读位置（本组件自己用 IntersectionObserver 计算）。
 * 这条线不是装饰：它就是「视频时间被压成文字」这件事本身的可视化，
 * 也替代了旧版右侧那列与正文脱节的独立导航。
 *
 * 职责边界：谁渲染导轨，谁负责点亮节点——因此滚动监听放在本组件内，
 * 而不是让父组件对本组件渲染出的 DOM 做手术。
 *
 * 安全说明：html 来自 lib/markdown.ts，该模块采用
 * 「先转义原文、再插入自有标签」的策略，模型输出里的标签只会显示为纯文本。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps<{
  html: string;
  /** 生成中：末尾显示脉冲光标 */
  streaming?: boolean;
  /** 视频当前播放时间（秒），用于导轨与实际播放进度联动 */
  playhead?: number | null;
}>();

const emit = defineEmits<{ seek: [seconds: number] }>();

const root = ref<HTMLElement | null>(null);
const spineTop = ref('0px');
const spineHeight = ref('0px');
const fillHeight = ref('0px');
let observer: IntersectionObserver | null = null;

/** 记录各章节的可见状态 */
const visible = new Set<string>();

interface ChapterItem {
  el: HTMLElement;
  id: string;
  sec: number;
}

function getChapterItems(): ChapterItem[] {
  const el = root.value;
  if (!el) return [];
  const heads = Array.from(el.querySelectorAll<HTMLElement>('h3.rail'));
  return heads.map((h) => {
    const btn = h.querySelector<HTMLElement>('[data-seek]');
    const raw = btn?.dataset['seek'];
    const sec = raw !== undefined ? Number(raw) : NaN;
    return { el: h, id: h.id, sec: Number.isFinite(sec) ? sec : 0 };
  });
}

function updateChapterStates(currentId?: string): void {
  const el = root.value;
  if (!el) return;
  const chapters = getChapterItems();
  if (chapters.length === 0) {
    spineTop.value = '0px';
    spineHeight.value = '0px';
    fillHeight.value = '0px';
    return;
  }

  const firstChapter = chapters[0];
  const lastChapter = chapters[chapters.length - 1];
  if (!firstChapter || !lastChapter) {
    spineTop.value = '0px';
    spineHeight.value = '0px';
    fillHeight.value = '0px';
    return;
  }

  const startY = firstChapter.el.offsetTop + firstChapter.el.offsetHeight / 2;
  const endY = lastChapter.el.offsetTop + lastChapter.el.offsetHeight / 2;
  spineTop.value = `${Math.round(startY)}px`;
  spineHeight.value = `${Math.max(0, Math.round(endY - startY))}px`;

  // 1. 若外部传入了有效的 playhead，优先根据视频实际播放进度匹配激活章节
  let activeId = currentId;
  const hasPlayhead =
    typeof props.playhead === 'number' &&
    Number.isFinite(props.playhead) &&
    props.playhead >= 0;

  if (hasPlayhead) {
    const ph = props.playhead as number;
    let matched = firstChapter;
    for (const c of chapters) {
      if (c.sec <= ph) {
        matched = c;
      } else {
        break;
      }
    }
    activeId = matched.id;
  } else if (!activeId) {
    activeId = firstChapter.id;
  }

  // 2. 更新类名（is-active / is-visited）
  let found = false;
  for (const c of chapters) {
    if (c.id === activeId) {
      c.el.classList.add('is-active');
      c.el.classList.remove('is-visited');
      found = true;
    } else if (!found && activeId) {
      c.el.classList.remove('is-active');
      c.el.classList.add('is-visited');
    } else {
      c.el.classList.remove('is-active');
      c.el.classList.remove('is-visited');
    }
  }

  // 3. 计算进度线填充高度 (fillHeight，从首个节点圆心延伸至当前播放进度)
  const activeIdx = chapters.findIndex((c) => c.id === activeId);
  const activeChapter = chapters[activeIdx];
  if (activeChapter) {
    const activeY = activeChapter.el.offsetTop + activeChapter.el.offsetHeight / 2;
    const nextChapter = hasPlayhead ? chapters[activeIdx + 1] : undefined;

    if (nextChapter && typeof props.playhead === 'number') {
      const ph = props.playhead;
      const curSec = activeChapter.sec;
      const nextSec = nextChapter.sec;
      const nextY = nextChapter.el.offsetTop + nextChapter.el.offsetHeight / 2;

      let ratio = 0;
      if (nextSec > curSec) {
        ratio = Math.max(0, Math.min(1, (ph - curSec) / (nextSec - curSec)));
      }
      const currentY = activeY + ratio * (nextY - activeY);
      fillHeight.value = `${Math.max(0, Math.round(currentY - startY))}px`;
    } else {
      fillHeight.value = `${Math.max(0, Math.round(activeY - startY))}px`;
    }
  } else {
    fillHeight.value = '0px';
  }
}

/** 重建滚动监听：html 变化（流式增量、切换视频）时章节集合会变 */
function setupSpy(): void {
  observer?.disconnect();
  observer = null;
  visible.clear();

  const el = root.value;
  if (!el) return;

  const heads = Array.from(el.querySelectorAll<HTMLElement>('h3.rail'));
  if (heads.length === 0) {
    spineTop.value = '0px';
    spineHeight.value = '0px';
    fillHeight.value = '0px';
    return;
  }

  const order = heads.map((h) => h.id);

  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).id;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }

      // 未收到有效播放进度时，由视口阅读位置驱动高亮
      const hasPlayhead =
        typeof props.playhead === 'number' &&
        Number.isFinite(props.playhead) &&
        props.playhead >= 0;
      if (!hasPlayhead) {
        const current = order.find((id) => visible.has(id)) ?? order[0];
        updateChapterStates(current);
      }
    },
    {
      // 顶部让开 sticky 顶栏；底部收窄，使高亮偏向「刚开始读」的那一节
      rootMargin: '-64px 0px -62% 0px',
      threshold: 0,
    },
  );

  for (const h of heads) observer.observe(h);
  // 初始化默认状态
  updateChapterStates(order[0]);
}

/*
 * 监听播放时间变化，实时驱动章节高亮与导轨进度
 */
watch(
  () => props.playhead,
  () => {
    updateChapterStates();
  },
);

/*
 * 只在章节结构变化时重建观察器。
 * 不监听 html 长度——流式生成时每个增量都会变，会导致观察器被高频重建。
 */
watch(
  () => {
    const el = root.value;
    if (!el) return '';
    // 用章节 id 序列作为「结构指纹」
    return Array.from(el.querySelectorAll('h3.rail'))
      .map((h) => h.id)
      .join(',');
  },
  () => setupSpy(),
  { immediate: true, flush: 'post' },
);

function onResize(): void {
  updateChapterStates();
}

onMounted(() => {
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  observer?.disconnect();
  observer = null;
});

function onClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  // 任何带 data-seek 的元素都可跳转（章节刻度、正文时间戳）
  const hit = target.closest('[data-seek]') as HTMLElement | null;
  if (!hit) return;

  const raw = hit.dataset['seek'];
  if (!raw) return;

  const sec = Number(raw);
  if (!Number.isFinite(sec)) return;

  // 立即点亮所点章节，不等滚动结束——避免「点了没反应」的错觉
  const head = hit.closest('h3.rail') as HTMLElement | null;
  if (head) {
    updateChapterStates(head.id);
  }

  emit('seek', sec);
}
</script>

<template>
  <article ref="root" class="note" :class="{ 'note--streaming': props.streaming }" @click="onClick">
    <div class="timeline-spine" :style="{ top: spineTop, height: spineHeight }" aria-hidden="true" />
    <div class="timeline-spine-fill" :style="{ top: spineTop, height: fillHeight }" aria-hidden="true" />
    <!-- eslint-disable-next-line vue/no-v-html -- 内容已在 markdown.ts 中做过转义 -->
    <div class="note__inner md" v-html="props.html" />
    <span v-if="props.streaming" class="caret" aria-hidden="true" />
  </article>
</template>

<style scoped>
/* ================================================================== *
 * 精密社论时序导轨布局 (Precision Editorial Timeline)
 *
 * .note 负责左侧留白与中轴轨道；h3.rail 形成卡片式锁定锚点，
 * 使节点能精确落在线上，而标题文字与正文左边缘保持严谨对齐。
 * ================================================================== */

.note {
  position: relative;
  flex: 1;
  min-width: 0;
  padding-left: 34px;
  word-break: break-word;
}

/* 贯穿式精密中轴导轨：始于首个章节节点圆心，终于末尾章节节点圆心，绝不穿透核心摘要卡片 */
.timeline-spine {
  position: absolute;
  left: 11px;
  width: 2px;
  border-radius: 1px;
  background: var(--rail-spine, var(--line));
  pointer-events: none;
  z-index: 0;
  transition: top 240ms var(--ease), height 240ms var(--ease);
}

/* 动态填充的平滑进度线：自首个章节节点延伸至当前播放/阅读位置 */
.timeline-spine-fill {
  position: absolute;
  left: 11px;
  width: 2px;
  border-radius: 1px;
  background: linear-gradient(180deg, var(--bili) 0%, var(--rail-filled, rgba(251, 114, 153, 0.75)) 100%);
  pointer-events: none;
  z-index: 1;
  transition: top 240ms var(--ease), height 240ms var(--ease);
}

.note__inner {
  display: contents;
}

/* ---------------- 章节标题 = 卡片式刻度节点 ---------------- */

.note :deep(h3.rail) {
  position: relative;
  margin: 16px 0 8px;
  margin-left: -34px;
  padding: 6px 10px 6px 34px;
  border-radius: var(--r-md);
  border: 1px solid transparent;
  border-left: 2.5px solid transparent;
  font-size: calc(13px * var(--fs));
  font-weight: 620;
  line-height: 1.45;
  color: var(--ink);
  scroll-margin-top: 58px;
  transition: all var(--duration) var(--ease);
  cursor: pointer;
}

.note :deep(h3.rail:first-child) {
  margin-top: 4px;
}

.note :deep(h3.rail:hover) {
  background: var(--surface-hover);
  border-color: var(--line);
}

/* 当前激活章节：珊瑚粉左锁边 + 微渐变底色 */
.note :deep(h3.rail.is-active) {
  background: linear-gradient(90deg, var(--bili-wash) 0%, var(--surface) 55%);
  border-color: var(--line);
  border-left: 2.5px solid var(--bili);
  box-shadow: var(--shadow-card);
  color: var(--ink);
  font-weight: 680;
}

/* 播放中指示徽章 */
.note :deep(h3.rail.is-active)::after {
  content: '▶ 播放中';
  display: inline-flex;
  align-items: center;
  font-size: 9.5px;
  font-weight: 700;
  color: var(--bili);
  background: var(--bili-wash);
  border: 1px solid var(--bili-line);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 15px;
  letter-spacing: 0.4px;
  margin-left: 8px;
  vertical-align: middle;
}

/* 多态微引脚：未激活状态（静止中空微圆核，中轴 X=12px） */
.note :deep(.rail__node) {
  position: absolute;
  left: 8px;
  top: 50%;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  padding: 0;
  border: 1.5px solid var(--line-strong);
  border-radius: 50%;
  background: var(--paper);
  transition: all var(--duration) var(--ease);
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.note :deep(.rail__node:hover) {
  border-color: var(--ink-soft);
  background: var(--surface-sunken);
  transform: scale(1.3);
}

/* 已播放历史章节：实心珊瑚粉核 */
.note :deep(h3.rail.is-visited .rail__node) {
  width: 8px;
  height: 8px;
  margin-top: -4px;
  border: 1.5px solid var(--bili);
  background: var(--bili);
  opacity: 0.65;
}

/* 当前激活章节：17px 呼吸光晕微孔圈 + 内嵌矢量播放三角符文 */
.note :deep(h3.rail.is-active .rail__node) {
  width: 17px;
  height: 17px;
  left: 3.5px;
  margin-top: -8.5px;
  border: 1.5px solid var(--bili);
  background: var(--paper);
  box-shadow: 0 0 0 3px var(--bili-wash), 0 0 8px var(--bili-glow);
  animation: precisionPulse 2.8s infinite cubic-bezier(0.4, 0, 0.6, 1);
  color: var(--bili);
  opacity: 1;
}

.note :deep(h3.rail.is-active .rail__node)::after {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  border-left: 5px solid var(--bili);
  margin-left: 1.5px;
}

@keyframes precisionPulse {
  0%, 100% {
    box-shadow: 0 0 0 3px var(--bili-wash), 0 0 8px rgba(251, 114, 153, 0.2);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(251, 114, 153, 0.18), 0 0 12px rgba(251, 114, 153, 0.35);
  }
}

/* 时间刻度：精密等宽芯片 */
.note :deep(.rail__time) {
  display: inline-block;
  margin-right: 8px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-sunken);
  color: var(--ink-mist);
  font-family: var(--font-time);
  font-size: calc(11px * var(--fs));
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  letter-spacing: 0.2px;
  vertical-align: 0;
  transition: all var(--duration) var(--ease);
}

.note :deep(h3.rail:hover .rail__time) {
  color: var(--ink);
  border-color: var(--line-strong);
}

.note :deep(h3.rail.is-active .rail__time) {
  color: var(--bili);
  background: var(--bili-wash);
  border-color: var(--bili-line);
}

/* ---------------- 正文内的时间戳（低调） ---------------- */

.note :deep(.ts) {
  display: inline-block;
  margin: 0 2px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--bili-wash);
  border: 1px solid var(--bili-line);
  color: var(--bili-deep);
  font-family: var(--font-time);
  font-size: calc(11px * var(--fs));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
  transition: all var(--duration) var(--ease);
  cursor: pointer;
}

.note :deep(.ts:hover) {
  background: var(--bili);
  color: #fff;
  border-color: var(--bili);
}

/* ---------------- 标题层级 ---------------- */

.note :deep(h1) {
  margin: 16px 0 8px;
  font-size: calc(17px * var(--fs));
  font-weight: 700;
  letter-spacing: -0.2px;
}

/* 核心摘要卡片化 (Executive Card) */
.note :deep(h2:first-of-type) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0 -34px;
  padding: 10px 14px 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-bottom: none;
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  font-size: calc(11px * var(--fs));
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  box-shadow: var(--shadow-bevel);
}

.note :deep(h2:first-of-type)::before {
  content: 'EXECUTIVE SUMMARY ·';
  font-size: calc(10px * var(--fs));
  color: var(--bili);
  font-weight: 800;
}

.note :deep(h2:first-of-type + p) {
  margin: 0 0 18px -34px;
  padding: 0 14px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-top: none;
  border-radius: 0 0 var(--r-lg) var(--r-lg);
  font-size: calc(12.5px * var(--fs));
  color: var(--text-secondary);
  line-height: 1.64;
  box-shadow: var(--shadow-card);
}

.note :deep(h2:not(:first-of-type)) {
  margin: 22px 0 10px -34px;
  padding: 4px 12px;
  font-size: calc(13px * var(--fs));
  font-weight: 700;
  letter-spacing: -0.1px;
  color: var(--text-hero);
  border-left: 2.5px solid var(--border-medium);
}

.note :deep(h4),
.note :deep(h5),
.note :deep(h6) {
  margin: 13px 0 6px;
  font-size: calc(13px * var(--fs));
  font-weight: 620;
}

/* ---------------- 段落与列表 ---------------- */

.note :deep(p) {
  margin: 8px 0;
  font-size: calc(13px * var(--fs));
  line-height: 1.78;
  color: var(--ink);
}

.note :deep(ul),
.note :deep(ol) {
  margin: 6px 0 12px;
  padding-left: 0;
  list-style: none;
}

.note :deep(li) {
  position: relative;
  margin: 6px 0;
  padding-left: 14px;
  font-size: calc(12.5px * var(--fs));
  line-height: 1.64;
  color: var(--text-secondary);
}

.note :deep(li)::before {
  content: '';
  position: absolute;
  left: 2px;
  top: calc(0.55em + 1px);
  width: 4px;
  height: 1.5px;
  background: var(--border-medium);
  border-radius: 1px;
}

.note :deep(li.sub) {
  margin-left: 12px;
  font-size: calc(12px * var(--fs));
  color: var(--text-muted);
}

/* ---------------- 引用 ---------------- */

.note :deep(blockquote) {
  margin: 10px 0;
  padding: 7px 13px;
  border-left: 2px solid var(--bili);
  background: var(--bili-wash);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}

.note :deep(blockquote p) {
  margin: 3px 0;
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
}

/* ---------------- 行内元素 ---------------- */

.note :deep(strong) {
  font-weight: 650;
  color: var(--ink);
}

.note :deep(em) {
  color: var(--ink-soft);
  font-style: italic;
}

.note :deep(hr) {
  margin: 18px 0;
  border: none;
  border-top: 1px solid var(--line);
}

/* ================================================================== *
 * 生成中的脉冲光标
 * ================================================================== */

.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 3px;
  border-radius: 2px;
  background: var(--bili);
  vertical-align: -2px;
  animation: blink 1.05s steps(2, start) infinite;
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.15;
  }
}
</style>
