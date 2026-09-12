<script setup lang="ts">
/**
 * TabBar.vue —— 面板内的功能切换：目录 / 聊天
 *
 * 两者性质不同，这也是为什么值得分成两个页而不是塞在一起：
 *   · 目录：一次性产物，生成后主要是读和导出
 *   · 聊天：持续交互，带着同一份字幕反复追问
 *
 * 圆点表示「该页已有内容」：目录有笔记、聊天有对话。
 * 这样切过去之前就知道那边是不是空的。
 */
import type { PanelTab } from '@/lib/types';

const props = defineProps<{
  tab: PanelTab;
  /** 目录是否已有笔记 */
  hasNote: boolean;
  /** 聊天是否已有对话 */
  hasChat: boolean;
  /** 生成中：禁用切换，避免打断 */
  busy: boolean;
}>();

const emit = defineEmits<{ change: [tab: PanelTab] }>();

const TABS: ReadonlyArray<{ id: PanelTab; label: string; hint: string }> = [
  { id: 'note', label: '目录', hint: '带时间戳的结构化笔记，可导出' },
  { id: 'chat', label: '聊天', hint: '带着这个视频的字幕提问' },
];

function has(tab: PanelTab): boolean {
  return tab === 'note' ? props.hasNote : props.hasChat;
}
</script>

<template>
  <div class="tb" role="tablist">
    <button
      v-for="t in TABS"
      :key="t.id"
      class="tb__item"
      :class="{ 'tb__item--on': tab === t.id }"
      :title="t.hint"
      :disabled="busy"
      role="tab"
      :aria-selected="tab === t.id"
      @click="emit('change', t.id)"
    >
      {{ t.label }}
      <span v-if="has(t.id)" class="tb__dot" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.tb {
  display: flex;
  gap: 18px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
}

.tb__item {
  position: relative;
  padding: 9px 1px 8px;
  border-bottom: 2px solid transparent;
  color: var(--ink-mist);
  font-size: calc(13px * var(--fs));
  font-weight: 560;
  transition: color 0.14s, border-color 0.14s;
}

.tb__item:hover:not(:disabled) {
  color: var(--ink);
}

/* 选中：文字变深 + 下划线。粉色只留给「当前状态」，符合设计规范 */
.tb__item--on {
  border-bottom-color: var(--bili);
  color: var(--ink);
  font-weight: 660;
}

.tb__item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tb__dot {
  position: absolute;
  top: 9px;
  right: -7px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--bili);
}
</style>
