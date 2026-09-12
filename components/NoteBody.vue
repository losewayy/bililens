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
import { onUnmounted, ref, watch } from 'vue';

const props = defineProps<{
  html: string;
  /** 生成中：末尾显示脉冲光标 */
  streaming?: boolean;
}>();

const emit = defineEmits<{ seek: [seconds: number] }>();

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

/** 记录各章节的可见状态 */
const visible = new Set<string>();

/** 重建滚动监听：html 变化（流式增量、切换视频）时章节集合会变 */
function setupSpy(): void {
  observer?.disconnect();
  observer = null;
  visible.clear();

  const el = root.value;
  if (!el) return;

  const heads = Array.from(el.querySelectorAll<HTMLElement>('h3.rail'));
  if (heads.length === 0) return;

  const order = heads.map((h) => h.id);

  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).id;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }

      // 取文档顺序中最靠前的可见章节作为「当前」
      const current = order.find((id) => visible.has(id));
      if (!current) return;

      for (const h of heads) {
        h.classList.toggle('is-active', h.id === current);
      }
    },
    {
      // 顶部让开 sticky 顶栏；底部收窄，使高亮偏向「刚开始读」的那一节
      rootMargin: '-64px 0px -62% 0px',
      threshold: 0,
    },
  );

  for (const h of heads) observer.observe(h);
}

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

onUnmounted(() => {
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
  if (head && root.value) {
    for (const h of root.value.querySelectorAll('h3.rail')) {
      h.classList.toggle('is-active', h === head);
    }
  }

  emit('seek', sec);
}
</script>

<template>
  <article ref="root" class="note" :class="{ 'note--streaming': props.streaming }" @click="onClick">
    <!-- eslint-disable-next-line vue/no-v-html -- 内容已在 markdown.ts 中做过转义 -->
    <div class="note__inner md" v-html="props.html" />
    <span v-if="props.streaming" class="caret" aria-hidden="true" />
  </article>
</template>

<style scoped>
/* ================================================================== *
 * 导轨布局
 *
 * .note 负责左侧留白与那条竖线；h3.rail 反向抵消留白，
 * 使节点能精确落在线上，而标题文字仍与正文左边缘对齐。
 * ================================================================== */

.note {
  position: relative;
  flex: 1;
  min-width: 0;
  padding-left: 46px;
  word-break: break-word;
}

/* 竖线本体：两端渐隐，避免生硬截断 */
.note::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: linear-gradient(
    to bottom,
    transparent 0,
    var(--line-strong) 52px,
    var(--line-strong) calc(100% - 52px),
    transparent 100%
  );
  pointer-events: none;
}

.note__inner {
  display: contents;
}

/* ---------------- 章节标题 = 刻度节点 ---------------- */

.note :deep(h3.rail) {
  position: relative;
  margin: 22px 0 10px;
  margin-left: -46px;
  padding-left: 46px;
  font-size: calc(13.5px * var(--fs));
  font-weight: 640;
  line-height: 1.5;
  color: var(--ink);
  scroll-margin-top: 58px;
}

.note :deep(h3.rail:first-child) {
  margin-top: 6px;
}

/* 空心节点，精确落在竖线上：
   竖线 left:12px + width:2px → 中心 13px
   节点 left:8px + width:10px → 中心 13px  ✓ */
.note :deep(.rail__node) {
  position: absolute;
  left: 8px;
  top: 50%;
  width: 10px;
  height: 10px;
  margin-top: -5px;
  padding: 0;
  border: 2px solid var(--line-strong);
  border-radius: 50%;
  background: var(--paper);
  transition: border-color 0.16s, background 0.16s, transform 0.16s, box-shadow 0.16s;
}

.note :deep(.rail__node:hover) {
  border-color: var(--bili);
  background: var(--bili-wash);
  transform: scale(1.3);
}

/* --- 当前阅读位置：实心粉点 + 光晕 --- */
.note :deep(h3.rail.is-active .rail__node) {
  border-color: var(--bili);
  background: var(--bili);
  transform: scale(1.15);
  box-shadow: 0 0 0 4px var(--bili-wash);
}

.note :deep(h3.rail.is-active) {
  color: var(--ink);
  font-weight: 680;
}

/* 时间刻度：等宽数字，节点之后、标题之前 */
.note :deep(.rail__time) {
  display: inline-block;
  margin-right: 9px;
  padding: 1px 7px;
  border: 1px solid var(--bili-line);
  border-radius: 5px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: calc(11px * var(--fs));
  font-weight: 650;
  line-height: 1.55;
  letter-spacing: 0.2px;
  vertical-align: 1px;
  transition: background 0.16s, color 0.16s, border-color 0.16s;
}

.note :deep(.rail__time:hover) {
  background: var(--bili);
  border-color: var(--bili);
  color: #fff;
}

/* ---------------- 正文内的时间戳（低调） ---------------- */

.note :deep(.ts) {
  display: inline-block;
  margin: 0 1px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: calc(11px * var(--fs));
  font-weight: 600;
  line-height: 1.7;
  transition: background 0.14s, color 0.14s;
}

.note :deep(.ts:hover) {
  background: var(--bili);
  color: #fff;
}

/* ---------------- 标题层级 ---------------- */

.note :deep(h1) {
  margin: 16px 0 8px;
  font-size: calc(17px * var(--fs));
  font-weight: 700;
  letter-spacing: -0.2px;
}

.note :deep(h2) {
  margin: 20px 0 10px;
  font-size: calc(14px * var(--fs));
  font-weight: 670;
  letter-spacing: -0.1px;
  color: var(--ink);
}

.note :deep(h2:first-child) {
  margin-top: 2px;
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
  line-height: 1.78;
  color: var(--ink);
}

.note :deep(ul),
.note :deep(ol) {
  margin: 7px 0;
  padding-left: 20px;
}

.note :deep(li) {
  margin: 5px 0;
  line-height: 1.75;
}

.note :deep(li.sub) {
  margin-left: 12px;
  list-style-type: circle;
  color: var(--ink-soft);
}

.note :deep(li::marker) {
  color: var(--bili);
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
