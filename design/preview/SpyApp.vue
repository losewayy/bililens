<script setup lang="ts">
/**
 * SpyApp.vue —— scroll-spy 专用夹具
 *
 * 为什么单独一个页面，而不是塞进 PreviewApp 的某一栏：
 * 真实的侧边栏里，滚动的是**整个文档**，因此 NoteBody 的
 * IntersectionObserver 用默认 root（视口）是正确的。
 * 若夹具把内容放进一个内部滚动容器，观察器的 root 就与实际不符，
 * 测出来的行为不能代表线上——那是夹具的错，不是产品的错。
 *
 * 所以这里只放一个 NoteBody，让文档自己滚动。
 */
import { computed } from 'vue';

import NoteBody from '@/components/NoteBody.vue';
import { extractSections, injectSectionAnchors, renderMarkdown } from '@/lib/markdown';

/**
 * 生成 8 个章节。
 *
 * 每章刻意放足要点，让整页高度**明显超过视口**——
 * 否则 window.scrollTo 会被浏览器夹到最大滚动量，
 * 「滚到第 5 章」根本滚不过去，断言就会误报成产品有问题。
 * （这个坑真实踩过：章节太矮时高亮只从 sec-0 挪到 sec-1。）
 */
const MD = (() => {
  const lines = ['## 滚动测试'];
  for (let i = 0; i < 8; i++) {
    const t = `${Math.floor((i * 45) / 60)}:${String((i * 45) % 60).padStart(2, '0')}`;
    lines.push(`### [${t}] 第 ${i + 1} 章`);
    for (let j = 0; j < 8; j++) {
      lines.push(`- 第 ${i + 1} 章的第 ${j + 1} 条要点，用于撑开高度以模拟真实长视频笔记`);
    }
    lines.push('');
  }
  return lines.join('\n');
})();

const html = computed(() => injectSectionAnchors(renderMarkdown(MD), extractSections(MD)));
</script>

<template>
  <div class="wrap">
    <div class="body">
      <NoteBody :html="html" @seek="() => {}" />
    </div>
  </div>
</template>

<style scoped>
/* 宽度对齐真实侧边栏 */
.wrap {
  width: 400px;
  margin: 0 auto;
  padding: 12px;
  background: var(--paper);
}

.body {
  display: flex;
}
</style>
