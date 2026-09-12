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
  /** 目录是否正在生成（非阻塞） */
  noteBusy?: boolean;
  /** 聊天是否正在生成（非阻塞） */
  chatBusy?: boolean;
  /** 兼容旧属性（不再阻断切换） */
  busy?: boolean;
}>();

const emit = defineEmits<{ change: [tab: PanelTab] }>();

const TABS: ReadonlyArray<{ id: PanelTab; label: string; hint: string }> = [
  { id: 'note', label: '目录', hint: '带时间戳的结构化笔记，可导出' },
  { id: 'chat', label: '聊天', hint: '带着这个视频的字幕提问' },
];

function has(tab: PanelTab): boolean {
  return tab === 'note' ? props.hasNote : props.hasChat;
}

function isTabBusy(tab: PanelTab): boolean {
  return tab === 'note' ? !!props.noteBusy : !!props.chatBusy;
}
</script>

<template>
  <div class="tb machined-segmented" role="tablist">
    <div
      class="machined-slider"
      :style="{ transform: tab === 'chat' ? 'translateX(100%)' : 'translateX(0)' }"
      aria-hidden="true"
    />
    <button
      v-for="t in TABS"
      :key="t.id"
      class="tb__item machined-tab-btn"
      :class="{ 'tb__item--on': tab === t.id, active: tab === t.id }"
      :title="t.hint"
      role="tab"
      :aria-selected="tab === t.id"
      @click="emit('change', t.id)"
    >
      {{ t.label }}
      <span
        v-if="has(t.id) || isTabBusy(t.id)"
        class="tb__dot"
        :class="{ 'tb__dot--busy': isTabBusy(t.id) }"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
.tb {
  display: flex;
  background: var(--bg-sunken);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-md);
  padding: 2px;
  position: relative;
  box-shadow: var(--shadow-sunken);
  margin: 8px 14px 0;
}

.machined-slider {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  box-shadow: var(--shadow-bevel), var(--shadow-card);
  transition: transform 220ms var(--ease);
  z-index: 1;
}

.tb__item {
  flex: 1;
  height: 27px;
  font-size: calc(12px * var(--fs));
  font-weight: 500;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  position: relative;
  z-index: 2;
  border: none;
  background: transparent;
  transition: color var(--duration) var(--ease);
  user-select: none;
  cursor: pointer;
}

.tb__item:hover:not(:disabled) {
  color: var(--text-hero);
}

.tb__item--on {
  color: var(--text-hero);
  font-weight: 600;
}

.tb__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 状态指示小核：保持无文本以防破坏客观断言 */
.tb__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--bili);
  box-shadow: 0 0 0 1.5px var(--bili-wash);
  flex-shrink: 0;
}

.tb__item--on .tb__dot {
  background: var(--bili);
  box-shadow: 0 0 6px var(--bili-glow);
}

/* 后台正在生成时的微光呼吸动画 */
.tb__dot--busy {
  animation: tb-pulse 1.4s ease-in-out infinite;
}

@keyframes tb-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.75;
  }
  50% {
    transform: scale(1.55);
    opacity: 1;
    box-shadow: 0 0 8px var(--bili-glow);
  }
}
</style>
