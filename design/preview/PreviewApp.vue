<script setup lang="ts">
/**
 * PreviewApp.vue —— 组件预览台
 *
 * 用 Vite 编译**真实的 .vue 组件**再截图，因此图里的每一个时间戳胶囊、
 * 每一根导轨连线都来自线上代码本身，而不是手写的等价 HTML。
 *
 * 由 scripts/shoot-preview.mjs 驱动，它同时做客观断言。
 */
import { computed, ref } from 'vue';

import NoteBody from '@/components/NoteBody.vue';
import TabBar from '@/components/TabBar.vue';
import PendingNote from '@/components/PendingNote.vue';
import ChatPanel from '@/components/ChatPanel.vue';
import { extractSections, injectSectionAnchors, renderMarkdown } from '@/lib/markdown';
import type { ChatBubble } from '@/composables/useReader';

/* ---------------- 样例笔记（验证时间轴导轨） ---------------- */

const NOTES_MD = `## 核心摘要

视频讨论如何用 AI 实现高效学习：把传统教学的多对多关系改成双向一对一，由 AI 作为聚合多来源的单一界面，内置验证与事实检查以建立信任。

## 章节笔记

### [0:01] 目标与结构

- 目标：找到用 AI 把学习效率优化到极致的做法
- 视频结构：先讲方法逻辑与系统设计，再做现场演示

### [1:42] 多来源学习的认知成本与信任成本

- 学生要适应很多教学风格、符号体系、可信度水平和界面
- 更深层代价是信任：面对不熟悉来源，大脑会本能观望

### [3:15] 一对一、聚合来源与工程化信任

- 反对意见：只有一个老师会只剩单一视角
- 回应：把来源和界面混为一谈；一位老师不减少来源数量，而是聚合所有来源

## 关键 Take-away

- 最优教学路径：减少已掌握内容、避开暂时不能理解内容
`;

const renderedNotes = computed(() =>
  injectSectionAnchors(renderMarkdown(NOTES_MD), extractSections(NOTES_MD)),
);

/* ---------------- 样例聊天 ---------------- */

const CHAT: ChatBubble[] = [
  { role: 'user', content: '它到底想说明什么？' },
  {
    role: 'assistant',
    reasoning:
      '用户问的是整段视频的主张。字幕里反复出现「聚合来源」「单一界面」，\n加上关于信任成本的论证，可以确定核心论点，再配两三个时间戳即可。',
    usage: { promptTokens: 34211, completionTokens: 1284, totalTokens: 35495 },
    content:
      '核心主张是：AI 应该充当**聚合多来源的单一界面**，而不是又一个老师。\n\n它给出的理由是：\n\n- 学生的认知成本主要来自适应不同风格与界面 [1:42]\n- 更深的成本是信任——面对陌生来源会本能观望 [1:42]\n- 因此信任不能靠慢慢建立，而要工程化内置 [3:15]\n\n所以它不是「用一个 AI 取代老师」，而是把来源数量与界面数量解耦。',
  },
  { role: 'user', content: '15 分钟那里讲了什么？' },
  {
    role: 'assistant',
    content: '那里在做现场演示，用 Obsidian 配合模型学习微分形式 [15:00]，重点是把精力放在材料本身而不是后勤。',
  },
];

const draftChat = ref<ChatBubble[]>(CHAT);

/* 会话栏样例：预览两个对话的切换态 */
const SESSIONS = [
  { id: 's-2', title: '它到底想说明什么', turns: CHAT, createdAt: 2, updatedAt: 2 },
  { id: 's-1', title: '上一段对话', turns: [], createdAt: 1, updatedAt: 1 },
];

function onSend(text: string): void {
  draftChat.value = [
    ...draftChat.value,
    { role: 'user', content: text },
    { role: 'assistant', content: '（预览台不发真实请求）' },
  ];
}
</script>

<template>
  <div class="stage">
    <!-- 1. 目录：时间轴导轨 -->
    <section class="frame">
      <p class="frame__label">目录 · NoteBody.vue（时间轴导轨）</p>
      <div class="panel">
        <TabBar tab="note" :has-note="true" :has-chat="true" :busy="false" @change="() => {}" />
        <div class="body">
          <NoteBody :html="renderedNotes" @seek="() => {}" />
        </div>
      </div>
    </section>

    <!-- 2. 目录空态 -->
    <section class="frame">
      <p class="frame__label">目录 · 待生成</p>
      <div class="panel">
        <TabBar tab="note" :has-note="false" :has-chat="false" :busy="false" @change="() => {}" />
        <PendingNote />
      </div>
    </section>

    <!-- 3. 聊天：有对话 -->
    <section class="frame">
      <p class="frame__label">聊天 · ChatPanel.vue（含可点时间戳）</p>
      <div class="panel panel--chat">
        <TabBar tab="chat" :has-note="true" :has-chat="true" :busy="false" @change="() => {}" />
        <ChatPanel
          :bubbles="draftChat"
          :sessions="SESSIONS"
          active-id="s-2"
          :busy="false"
          status=""
          :send-playhead="true"
          :playhead="932"
          :ready="true"
          @send="onSend"
          @stop="() => {}"
          @seek="() => {}"
          @update:send-playhead="() => {}"
          @clear="() => {}"
          @new="() => {}"
          @select="() => {}"
          @remove="() => {}"
        />
      </div>
    </section>

    <!-- 4. 聊天空态（起手式） -->
    <section class="frame">
      <p class="frame__label">聊天 · 空态（起手式）</p>
      <div class="panel panel--chat">
        <TabBar tab="chat" :has-note="false" :has-chat="false" :busy="false" @change="() => {}" />
        <ChatPanel
          :bubbles="[]"
          :sessions="[]"
          active-id=""
          :busy="false"
          status=""
          :send-playhead="false"
          :playhead="null"
          :ready="true"
          @send="() => {}"
          @stop="() => {}"
          @seek="() => {}"
          @update:send-playhead="() => {}"
          @clear="() => {}"
          @new="() => {}"
          @select="() => {}"
          @remove="() => {}"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.stage {
  display: flex;
  gap: 22px;
  align-items: flex-start;
  padding: 22px;
  background: var(--surface-sunken);
  min-height: 100vh;
}

.frame {
  margin: 0;
}

.frame__label {
  margin: 0 0 7px;
  color: var(--ink-mist);
  font-family: var(--font-time);
  font-size: 11px;
}

/* 模拟 Chrome 侧边栏的真实宽度 */
.panel {
  display: flex;
  flex-direction: column;
  width: 400px;
  min-height: 620px;
  padding-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

/* 聊天页需要定高，输入区才能贴在底部 */
.panel--chat {
  height: 620px;
  min-height: 0;
}

.body {
  display: flex;
  padding: 8px 12px 0;
}
</style>
