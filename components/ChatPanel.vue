<script setup lang="ts">
/**
 * ChatPanel.vue —— 聊天页
 *
 * 带着这个视频的字幕追问。不需要先生成笔记：素材是独立采集的，
 * 因此打开就能问（第一条消息会多等几秒在抓字幕，界面上会说明）。
 *
 * 【时间戳是可点的】
 * 回答里的 [15:00] 会渲染成可点胶囊，点了视频跳过去。
 * 笔记里的时间戳是「目录」，聊天里的是「引用」——同一套渲染，两种用法。
 *
 * 【播放位置默认不发送】
 * 多数追问是关于整个视频的，带上播放位置反而会让模型
 * 误以为「在问当前这一段」。因此做成开关，默认关。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import type { ChatBubble } from '@/composables/useReader';
import type { StoredChatSession } from '@/lib/storage';
import { renderMarkdown } from '@/lib/markdown';
import { fmtTokens } from '@/lib/time';
import { fileToChatImage, imageFilesFromClipboard, MAX_IMAGES_PER_TURN } from '@/lib/image';
import type { ChatImage } from '@/lib/types';

const props = defineProps<{
  bubbles: ChatBubble[];
  /** 这个视频的所有对话（顶部切换栏用） */
  sessions: StoredChatSession[];
  /** 当前对话 id */
  activeId: string;
  busy: boolean;
  /** 采集/思考中的提示文字 */
  status: string;
  /** 是否附带播放位置 */
  sendPlayhead: boolean;
  /** 当前播放位置（秒），null 表示还没取到 */
  playhead: number | null;
  /** 是否已配置模型 */
  ready: boolean;
}>();

const emit = defineEmits<{
  send: [text: string, images: ChatImage[]];
  stop: [];
  seek: [seconds: number];
  'update:sendPlayhead': [value: boolean];
  clear: [];
  new: [];
  select: [id: string];
  remove: [id: string];
}>();

const draft = ref('');
const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

/* ---------------- 滚动：跟随 + 快速跳转 ---------------- */

/**
 * 自动跟随与手动滚动会打架：流式输出每次刷新都把滚动条摁到底，
 * 用户往上翻旧消息就被拽回来。因此只在「用户本来就在底部附近」时跟随；
 * 一旦手动离开底部就停止跟随，由 ↓ 按钮负责回来。
 */
const NEAR_EDGE = 64;

/** 是否自动跟随到底部 */
const follow = ref(true);
/** 跳转按钮的显示状态：不在顶部才给 ↑，不在底部才给 ↓ */
const atTop = ref(true);
const atBottom = ref(true);

/**
 * ↑ ↓ 互斥，任何时刻至多显示一个：
 * 不在底部 → ↓（回到底部并继续跟随，这是聊天里的主导航动作）；
 * 已在底部但不在顶部 → ↑（跳回对话开头重看第一轮）。
 */
const jumpMode = computed<'down' | 'up' | null>(() => {
  if (!atBottom.value) return 'down';
  if (!atTop.value) return 'up';
  return null;
});

/**
 * 真正的滚动容器。
 *
 * 侧边栏的布局没有限高（.panel 是 min-height:100vh），长对话时
 * 发生滚动的是文档根，消息区自己 scrollHeight 恒等于 clientHeight，
 * 绑在它身上的 scroll 事件永远不会触发；预览台等有界布局里
 * 滚动的才是消息区自己。两种情况都兼容。
 */
function realScroller(): HTMLElement | null {
  const el = scroller.value;
  if (el && el.scrollHeight > el.clientHeight + 1) return el;
  return (document.scrollingElement as HTMLElement | null) ?? el;
}

function updateJumpState(): void {
  const el = realScroller();
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_EDGE;
  atTop.value = el.scrollTop < NEAR_EDGE;
}

function onScroll(): void {
  updateJumpState();
  // 手动滚回底部附近 = 恢复跟随
  const el = realScroller();
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_EDGE;
}

function smoothBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function jumpTop(): void {
  realScroller()?.scrollTo({ top: 0, behavior: smoothBehavior() });
}

function jumpBottom(): void {
  follow.value = true;
  const el = realScroller();
  el?.scrollTo({ top: el.scrollHeight, behavior: smoothBehavior() });
}

/** 新内容进来：跟随中才滚到底，否则只刷新按钮状态 */
watch(
  () => [props.bubbles.length, props.bubbles[props.bubbles.length - 1]?.content.length],
  async () => {
    await nextTick();
    if (follow.value) {
      const el = realScroller();
      if (el) el.scrollTop = el.scrollHeight;
    }
    updateJumpState();
  },
);

/** 待发送的图片（尚未发给模型） */
const attachments = ref<ChatImage[]>([]);
/** 粘贴/处理图片时的提示（例如图片过大、模型不支持） */
const pasteHint = ref('');
/** 正在解码图片 */
const reading = ref(false);
/** 点开的图片（放大查看）。侧边栏很窄，缩略图看不清内容 */
const preview = ref<string | null>(null);

/** 把播放位置格式化成 mm:ss */
const playheadText = computed(() => {
  const t = props.playhead;
  if (t === null || !Number.isFinite(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
});

/** 助手消息渲染成 HTML（复用与笔记相同的渲染器，时间戳因此可点） */
function htmlOf(b: ChatBubble): string {
  return b.error ? '' : renderMarkdown(b.content);
}

/** 输入框随内容增高，但不超过一屏的三分之一 */
function autoGrow(): void {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

function submit(): void {
  const text = draft.value.trim();
  // 允许「只有图片没有文字」：贴张截图问「这里讲了什么」很常见
  if ((!text && attachments.value.length === 0) || props.busy) return;

  const images = attachments.value;
  draft.value = '';
  attachments.value = [];
  pasteHint.value = '';
  void nextTick(autoGrow);
  emit('send', text, images);
}

/* ---------------- 图片粘贴 ---------------- */

/**
 * 处理粘贴。
 *
 * 只在剪贴板里确实有图片时才 preventDefault——
 * 否则会把普通文本粘贴也拦下来，用户会发现粘不了字。
 */
async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = imageFilesFromClipboard(e.clipboardData);
  if (files.length === 0) return;
  e.preventDefault();

  const room = MAX_IMAGES_PER_TURN - attachments.value.length;
  if (room <= 0) {
    pasteHint.value = `一次最多 ${MAX_IMAGES_PER_TURN} 张图`;
    return;
  }

  reading.value = true;
  pasteHint.value = '';
  const added: ChatImage[] = [];
  for (const file of files.slice(0, room)) {
    try {
      added.push(await fileToChatImage(file));
    } catch (err) {
      pasteHint.value = err instanceof Error ? err.message : String(err);
    }
  }
  if (added.length) attachments.value = [...attachments.value, ...added];
  if (files.length > room) pasteHint.value = `一次最多 ${MAX_IMAGES_PER_TURN} 张图，多余的已忽略`;
  reading.value = false;
}

function removeAttachment(i: number): void {
  attachments.value = attachments.value.filter((_, idx) => idx !== i);
  pasteHint.value = '';
}

/** Enter 发送，Shift+Enter 换行 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

/** 点击气泡里的时间戳 → 跳转 */
function onClick(ev: MouseEvent): void {
  const hit = (ev.target as HTMLElement | null)?.closest('[data-seek]') as HTMLElement | null;
  if (!hit) return;
  const sec = Number(hit.dataset['seek']);
  if (Number.isFinite(sec)) emit('seek', sec);
}

/* ---------------- 对话切换 ---------------- */

/**
 * 对话切换用自绘下拉，不能用原生 <select>——
 * 它的选项列表是浏览器级弹层，会贴着窄侧边栏飞到浏览器外面去。
 * 自绘的锚定在会话栏里，宽度不超过面板。
 */
const sessOpen = ref(false);
const sessbarEl = ref<HTMLElement | null>(null);

/** 触发按钮上显示的当前对话名 */
const activeTitle = computed(
  () => props.sessions.find((s) => s.id === props.activeId)?.title ?? '新对话',
);

function closeSessPop(): void {
  sessOpen.value = false;
}

function onPickSession(id: string): void {
  closeSessPop();
  emit('select', id);
}

function onNewSession(): void {
  closeSessPop();
  emit('new');
}

function onRemoveSession(): void {
  if (props.busy || !props.activeId) return;
  if (confirm('删除当前对话？其他对话不受影响。')) {
    closeSessPop();
    emit('remove', props.activeId);
  }
}

/** 点面板外或按 Esc 时收起 */
function onDocPointerDown(e: PointerEvent): void {
  if (sessOpen.value && sessbarEl.value && !sessbarEl.value.contains(e.target as Node)) {
    closeSessPop();
  }
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeSessPop();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onDocKeydown);
  // 侧边栏里真正滚的是文档根，scroll 事件挂在 window 上才收得到
  window.addEventListener('scroll', onScroll, { passive: true });
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('scroll', onScroll);
});

/* ---------------- 思考过程（默认折叠） ---------------- */

/** 用户手动点开/收起过的气泡；未记录的一律折叠 */
const thinkToggled = ref<Record<number, boolean>>({});

function thinkOpen(i: number): boolean {
  return thinkToggled.value[i] ?? false;
}

function toggleThink(i: number): void {
  thinkToggled.value = { ...thinkToggled.value, [i]: !thinkOpen(i) };
}

/** 切换对话时：重置展开状态与跟随，定位到该对话的末尾 */
watch(
  () => props.activeId,
  async () => {
    thinkToggled.value = {};
    follow.value = true;
    await nextTick();
    const el = realScroller();
    if (el) el.scrollTop = el.scrollHeight;
    updateJumpState();
  },
);

const SUGGESTIONS = [
  '用三句话概括这个视频',
  '它的核心结论是什么？依据是什么',
  '有哪些说法是作者的个人观点而非事实',
];

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="chat">
    <!-- 对话切换栏：一个视频可以有多段互不干扰的对话 -->
    <div ref="sessbarEl" class="sessbar">
      <button
        class="sessbar__trigger"
        :disabled="busy || sessions.length === 0"
        :aria-expanded="sessOpen"
        title="切换对话"
        @click="sessOpen = !sessOpen"
      >
        <span class="sessbar__cur">{{ activeTitle }}</span>
        <span class="sessbar__chev" :class="{ 'sessbar__chev--open': sessOpen }" aria-hidden="true">
          ▾
        </span>
      </button>
      <button class="sessbar__btn" title="新建对话" :disabled="busy" @click="onNewSession">
        ＋
      </button>
      <button
        v-if="activeId"
        class="sessbar__btn sessbar__btn--del"
        title="删除当前对话"
        :disabled="busy"
        @click="onRemoveSession"
      >
        ×
      </button>

      <!-- 下拉列表：锚定在面板内，不会超出侧边栏 -->
      <div v-if="sessOpen" class="sesspop" role="listbox" aria-label="对话列表">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="sesspop__row"
          :class="{ 'sesspop__row--cur': s.id === activeId }"
          role="option"
          :aria-selected="s.id === activeId"
          @click="onPickSession(s.id)"
        >
          <span class="sesspop__dot" aria-hidden="true" />
          <span class="sesspop__title">{{ s.title }}</span>
          <span class="sesspop__count tnum">{{ s.turns.length }} 条</span>
        </button>
      </div>
    </div>

    <!-- 消息区（外层是跳转按钮的定位容器） -->
    <div class="chat__wrap">
      <div ref="scroller" class="chat__scroll" @click="onClick" @scroll.passive="onScroll">
      <!-- 空态：给几个起手式，避免用户对着空框发呆 -->
      <div v-if="bubbles.length === 0" class="hello">
        <p class="hello__title">问这个视频的任何问题</p>
        <p class="hello__desc">
          它读的是这个视频的完整字幕，回答里会带可点的时间戳。
        </p>
        <div class="hello__chips">
          <button
            v-for="s in SUGGESTIONS"
            :key="s"
            class="chip"
            :disabled="busy || !ready"
            @click="emit('send', s, [])"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <template v-else>
        <div
          v-for="(b, i) in bubbles"
          :key="i"
          class="msg"
          :class="`msg--${b.role}`"
        >
          <div v-if="b.error" class="msg__error">{{ b.error }}</div>
          <template v-else>
            <!-- 思考过程：默认折叠，点开才看 -->
            <div v-if="b.reasoning" class="think">
              <button class="think__head" @click="toggleThink(i)">
                <span class="think__arrow" :class="{ 'think__arrow--open': thinkOpen(i) }">
                  ▸
                </span>
                {{ b.streaming && !b.content ? '思考中…' : '思考过程' }}
              </button>
              <div v-if="thinkOpen(i)" class="think__body">{{ b.reasoning }}</div>
            </div>
            <!-- 这一轮带的图：用户消息里直接显示缩略图 -->
            <div v-if="b.images?.length" class="msg__imgs">
              <img
                v-for="(img, k) in b.images"
                :key="k"
                class="msg__img"
                :src="img.dataURL"
                :alt="`附图 ${k + 1}`"
                @click="preview = img.dataURL"
              />
            </div>
            <p v-else-if="b.imagesLost" class="msg__lost">（这一轮的图片已不再保留）</p>
            <!-- eslint-disable-next-line vue/no-v-html -- 已在 markdown.ts 中转义 -->
            <div class="msg__body md" v-html="htmlOf(b)" />
            <div v-if="b.usage" class="msg__usage tnum">
              输入 {{ fmtTokens(b.usage.promptTokens) }} · 输出
              {{ fmtTokens(b.usage.completionTokens) }} tokens
            </div>
          </template>
          <span v-if="b.streaming" class="caret" aria-hidden="true" />
        </div>
      </template>
      </div>
    </div>

    <!-- 进行中 -->
    <div v-if="busy" class="chat__status">
      <span class="spinner" />
      <span class="chat__statusText">{{ status || '正在思考…' }}</span>
      <button class="chat__stop" @click="emit('stop')">停止</button>
    </div>

    <!-- 输入区 -->
    <div class="composer">
      <!-- 快速跳转：锚在输入框上沿，只显示一个（↑/↓ 互斥） -->
      <button
        v-if="jumpMode === 'up'"
        class="jumpbar__btn"
        title="到顶部"
        @click="jumpTop"
      >
        ↑
      </button>
      <button
        v-else-if="jumpMode === 'down'"
        class="jumpbar__btn"
        title="回到底部并继续跟随新消息"
        @click="jumpBottom"
      >
        ↓
      </button>

      <!-- 待发送的图片 -->
      <div v-if="attachments.length" class="attaches">
        <div v-for="(img, i) in attachments" :key="i" class="attach">
          <img class="attach__img" :src="img.dataURL" :alt="`待发送附图 ${i + 1}`" />
          <button class="attach__del" title="移除这张图" @click="removeAttachment(i)">×</button>
        </div>
      </div>

      <p v-if="reading" class="composer__hint">正在处理图片…</p>
      <p v-else-if="pasteHint" class="composer__hint composer__hint--warn">{{ pasteHint }}</p>

      <textarea
        ref="input"
        v-model="draft"
        class="composer__input"
        rows="1"
        placeholder="问点什么…（Enter 发送，Shift+Enter 换行，可直接粘贴截图）"
        :disabled="!ready"
        @input="autoGrow"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <div class="composer__bar">
        <!-- 播放位置开关：默认关，因为多数问题是关于整个视频的 -->
        <button
          class="toggle"
          :class="{ 'toggle--on': sendPlayhead }"
          :disabled="!ready"
          :title="
            sendPlayhead
              ? '发送时会带上当前播放位置，便于问「这里讲了什么」'
              : '不附带播放位置。问整个视频的问题时更准确'
          "
          :aria-pressed="sendPlayhead"
          @click="emit('update:sendPlayhead', !sendPlayhead)"
        >
          <span class="toggle__box" aria-hidden="true" />
          <span class="toggle__label tnum">播放位置 {{ playheadText }}</span>
        </button>

        <button v-if="bubbles.length > 0" class="composer__clear" @click="emit('clear')">
          清空
        </button>

        <button
          class="composer__send"
          :disabled="busy || (!draft.trim() && attachments.length === 0) || !ready"
          @click="submit"
        >
          发送
        </button>
      </div>
    </div>

    <!-- 放大查看 -->
    <div v-if="preview" class="preview" @click="preview = null">
      <img class="preview__img" :src="preview" alt="附图预览" />
      <p class="preview__tip">点击任意处关闭</p>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/* ---------------- 消息区 ---------------- */

/* 跳转按钮的定位容器 */
.chat__wrap {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.chat__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 12px 4px;
}

.msg {
  margin-bottom: 12px;
  font-size: calc(12.5px * var(--fs));
  line-height: 1.72;
  word-break: break-word;
}

/* 用户消息：右对齐的浅底气泡，与助手回答区分开 */
.msg--user {
  margin-left: auto;
  max-width: 88%;
  padding: 7px 11px;
  border-radius: var(--r-md);
  background: var(--surface-sunken);
  white-space: pre-wrap;
}

/* 助手回答：不加气泡，让它读起来像正文而不是聊天记录 */
.msg--assistant {
  color: var(--ink);
}

/* ---------------- 对话切换栏 ---------------- */

.sessbar {
  position: relative; /* 下拉列表的定位基准 */
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--paper);
}

.sessbar__trigger {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(11.5px * var(--fs));
  text-align: left;
  transition: border-color 0.14s;
}

.sessbar__trigger:hover:not(:disabled) {
  border-color: var(--line-strong);
}

.sessbar__trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sessbar__cur {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessbar__chev {
  flex: 0 0 auto;
  color: var(--ink-mist);
  font-size: calc(9px * var(--fs));
  transition: transform 0.16s;
}

.sessbar__chev--open {
  transform: rotate(180deg);
}

/* 下拉列表：绝对定位在会话栏内，宽度即面板宽，绝不超出侧边栏 */
.sesspop {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  right: 8px;
  z-index: 30;
  max-height: 264px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}

.sesspop__row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-soft);
  font-size: calc(12px * var(--fs));
  text-align: left;
  transition: background 0.14s, color 0.14s;
}

.sesspop__row:hover {
  background: var(--surface-sunken);
  color: var(--ink);
}

/* 当前对话用品牌粉标记——粉色只用于「当前」，与全界面规则一致 */
.sesspop__row--cur,
.sesspop__row--cur:hover {
  background: var(--bili-wash);
  color: var(--bili-deep);
}

.sesspop__dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line-strong);
}

.sesspop__row--cur .sesspop__dot {
  background: var(--bili);
}

.sesspop__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sesspop__count {
  flex: 0 0 auto;
  color: var(--ink-mist);
  font-size: calc(10.5px * var(--fs));
}

.sessbar__btn {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(13px * var(--fs));
  line-height: 1;
  transition: border-color 0.14s, color 0.14s;
}

.sessbar__btn:hover:not(:disabled) {
  border-color: var(--bili);
  color: var(--bili-deep);
}

.sessbar__btn--del:hover:not(:disabled) {
  border-color: var(--err);
  color: var(--err);
}

.sessbar__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------------- 思考过程（默认折叠） ---------------- */

.think {
  margin-bottom: 6px;
}

.think__head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  color: var(--ink-mist);
  font-size: calc(11px * var(--fs));
  transition: color 0.14s;
}

.think__head:hover {
  color: var(--ink-soft);
}

.think__arrow {
  display: inline-block;
  font-size: calc(10px * var(--fs));
  transition: transform 0.16s;
}

.think__arrow--open {
  transform: rotate(90deg);
}

.think__body {
  max-height: 220px;
  margin-top: 4px;
  padding: 7px 9px;
  border-left: 2px solid var(--line-strong);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--surface-sunken);
  color: var(--ink-mist);
  font-size: calc(11.5px * var(--fs));
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
}

.msg__error {
  padding: 8px 11px;
  border: 1px solid rgba(217, 59, 71, 0.3);
  border-radius: var(--r-sm);
  background: var(--err-wash);
  color: var(--err);
  white-space: pre-wrap;
}

/* ---------------- 消息里的图片 ---------------- */

.msg__imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}

.msg__img {
  width: 86px;
  height: 86px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  object-fit: cover;
  cursor: zoom-in;
  transition: border-color 0.14s;
}

.msg__img:hover {
  border-color: var(--bili);
}

.msg__lost {
  margin: 0 0 4px;
  color: var(--ink-faint);
  font-size: calc(11px * var(--fs));
  font-style: italic;
}

/* 回答末尾的 token 用量：低存在感的一行小字 */
.msg__usage {
  margin-top: 4px;
  color: var(--ink-faint);
  font-size: calc(10.5px * var(--fs));
  font-family: var(--font-time);
}

/* 用户消息里的图片与文字都在同一个气泡里，靠右对齐 */
.msg--user .msg__imgs {
  justify-content: flex-end;
}

.msg :deep(p) {
  margin: 0 0 8px;
}

.msg :deep(p:last-child) {
  margin-bottom: 0;
}

.msg :deep(ul),
.msg :deep(ol) {
  margin: 6px 0;
  padding-left: 19px;
}

.msg :deep(li) {
  margin: 3px 0;
}

.msg :deep(li::marker) {
  color: var(--bili);
}

.msg :deep(h1),
.msg :deep(h2),
.msg :deep(h3),
.msg :deep(h4) {
  margin: 10px 0 5px;
  font-size: calc(12.5px * var(--fs));
  font-weight: 650;
}

.msg :deep(strong) {
  font-weight: 650;
}

/* 行内代码/表格/代码块/链接/公式的样式在全局 .md 作用域（theme.css） */

/* 时间戳胶囊（聊天里是「引用」，点了跳转） */
.msg :deep(.ts) {
  display: inline-block;
  margin: 0 1px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--bili-wash);
  color: var(--bili-deep);
  font-size: calc(11px * var(--fs));
  font-weight: 600;
  transition: background 0.14s, color 0.14s;
}

.msg :deep(.ts:hover) {
  background: var(--bili);
  color: #fff;
}

/* ---------------- 空态 ---------------- */

.hello {
  padding: 26px 8px;
  text-align: center;
}

.hello__title {
  margin: 0 0 5px;
  font-size: calc(13px * var(--fs));
  font-weight: 620;
}

.hello__desc {
  margin: 0 0 14px;
  color: var(--ink-soft);
  font-size: calc(12.5px * var(--fs));
  line-height: 1.7;
}

.hello__chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}

.chip {
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(12px * var(--fs));
  text-align: left;
  transition: background 0.14s, border-color 0.14s, color 0.14s;
}

.chip:hover:not(:disabled) {
  border-color: var(--bili-line);
  background: var(--bili-wash);
  color: var(--bili-deep);
}

.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------------- 进行中 ---------------- */

.chat__status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  color: var(--ink-soft);
  font-size: calc(12px * var(--fs));
}

.chat__statusText {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat__stop {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(11.5px * var(--fs));
}

.chat__stop:hover {
  background: var(--surface-sunken);
  color: var(--ink);
}

/* ---------------- 输入区 ---------------- */

.composer {
  position: relative; /* 跳转按钮的定位基准 */
  padding: 8px 12px 10px;
  border-top: 1px solid var(--line);
  background: var(--paper);
}

/* 快速跳转：浮在输入框上沿的右侧，不占布局空间 */
.jumpbar__btn {
  position: absolute;
  right: 12px;
  bottom: calc(100% + 6px);
  z-index: 20;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(13px * var(--fs));
  line-height: 1;
  box-shadow: var(--shadow-1);
  transition: border-color 0.14s, color 0.14s;
}

.jumpbar__btn:hover {
  border-color: var(--bili);
  color: var(--bili-deep);
}

/* 待发送的缩略图 */
.attaches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 7px;
}

.attach {
  position: relative;
  width: 54px;
  height: 54px;
}

.attach__img {
  width: 100%;
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  object-fit: cover;
}

.attach__del {
  position: absolute;
  top: -5px;
  right: -5px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  color: var(--ink-soft);
  font-size: calc(12px * var(--fs));
  line-height: 1;
  box-shadow: var(--shadow-1);
}

.attach__del:hover {
  border-color: var(--err);
  color: var(--err);
}

.composer__hint {
  margin: 0 0 6px;
  color: var(--ink-mist);
  font-size: calc(11.5px * var(--fs));
}

.composer__hint--warn {
  color: var(--warn);
}

.composer__input {
  display: block;
  width: 100%;
  max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
  font-size: calc(12.5px * var(--fs));
  line-height: 1.6;
  resize: none;
  overflow-y: auto;
  transition: border-color 0.14s;
}

.composer__input:focus {
  border-color: var(--bili);
  outline: none;
}

.composer__input:disabled {
  background: var(--surface-sunken);
  cursor: not-allowed;
}

.composer__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}

/* 播放位置开关 */
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-mist);
  font-size: calc(11px * var(--fs));
  transition: background 0.14s, border-color 0.14s, color 0.14s;
}

.toggle:hover:not(:disabled) {
  border-color: var(--line-strong);
  color: var(--ink-soft);
}

.toggle--on {
  border-color: var(--bili-line);
  background: var(--bili-wash);
  color: var(--bili-deep);
}

.toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle__box {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  transition: background 0.14s;
}

.toggle--on .toggle__box {
  background: var(--bili);
  border-color: var(--bili);
}

.toggle__label {
  white-space: nowrap;
}

.composer__clear {
  margin-left: auto;
  padding: 4px 8px;
  color: var(--ink-mist);
  font-size: calc(11.5px * var(--fs));
}

.composer__clear:hover {
  color: var(--ink-soft);
}

.composer__send {
  padding: 5px 15px;
  border: 1px solid var(--bili);
  border-radius: var(--r-sm);
  background: var(--bili);
  color: #fff;
  font-size: calc(12.5px * var(--fs));
  font-weight: 560;
  transition: background 0.14s, border-color 0.14s;
}

.composer__send:hover:not(:disabled) {
  background: var(--bili-deep);
  border-color: var(--bili-deep);
}

.composer__send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ---------------- 生成中光标 ---------------- */

.caret {
  display: inline-block;
  width: 6px;
  height: 13px;
  margin-left: 2px;
  border-radius: 2px;
  background: var(--bili);
  vertical-align: -2px;
  animation: blink 1.05s steps(2, start) infinite;
}

/* ---------------- 图片放大 ---------------- */

.preview {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
}

.preview__img {
  max-width: 100%;
  max-height: 82vh;
  border-radius: var(--r-sm);
  object-fit: contain;
}

.preview__tip {
  margin: 0;
  color: rgba(255, 255, 255, 0.7);
  font-size: calc(11.5px * var(--fs));
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

.spinner {
  width: 11px;
  height: 11px;
  flex: 0 0 auto;
  border: 2px solid var(--line-strong);
  border-top-color: var(--bili);
  border-radius: 50%;
  animation: spin 0.68s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
