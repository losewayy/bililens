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
    <span class="pending__glyph" aria-hidden="true">✎</span>
    <p class="pending__title">还没有生成笔记</p>
    <p class="pending__desc">
      点上方「生成笔记」开始。想直接提问的话，切到「聊天」——它同样能读到这个视频的字幕。
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
  gap: 6px;
  padding: 40px 30px 52px;
  text-align: center;
}

.pending__glyph {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 3px;
  border: 1px dashed var(--line-strong);
  border-radius: 50%;
  color: var(--ink-mist);
  font-size: calc(15px * var(--fs));
}

.pending__title {
  margin: 0;
  font-size: calc(13px * var(--fs));
  font-weight: 620;
}

.pending__desc {
  margin: 0;
  max-width: 30em;
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
  line-height: 1.7;
}
</style>
