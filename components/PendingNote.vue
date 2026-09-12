<script setup lang="ts">
/**
 * PendingNote.vue —— 「还没有生成笔记」的空态
 *
 * 存在的意义是把一个容易被误解的瞬间说清楚：
 * 用户切到目录页，但什么都没开始跑。没有这段提示，
 * 空白区域会被读成「卡住了」或「点了没反应」。
 */
</script>

<template>
  <div class="pending">
    <div class="pending__beacon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <line x1="10" y1="9" x2="8" y2="9" />
      </svg>
    </div>
    <p class="pending__title">尚未生成精读笔记</p>
    <p class="pending__desc">
      点下方「生成精读笔记」即可提炼核心要点与时序导轨。想直接追问，可切到「聊天」边看边问。
    </p>
  </div>
</template>

<style scoped>
.pending {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 48px 28px;
  text-align: center;
}

.pending__beacon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  margin-bottom: 4px;
  border-radius: var(--r-md);
  background: var(--bg-sunken);
  border: 1px solid var(--border-subtle);
  color: var(--bili);
  box-shadow: var(--shadow-sunken);
}

.pending__title {
  margin: 0;
  font-size: calc(13px * var(--fs));
  font-weight: 650;
  color: var(--text-hero);
}

.pending__desc {
  margin: 0;
  max-width: 28em;
  color: var(--text-muted);
  font-size: calc(12px * var(--fs));
  line-height: 1.65;
}
</style>
