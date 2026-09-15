/**
 * lib/llm.ts —— 大模型调用层（OpenAI 兼容协议 + SSE 流式）
 *
 * 设计取舍：
 *   只依赖 `/chat/completions` 这一事实标准端点，因此天然兼容
 *   OpenAI / DeepSeek / 硅基流动 / Moonshot / 智谱 / OpenRouter /
 *   各类中转站 / Ollama(/v1) / LM Studio / vLLM / one-api / new-api。
 *   用户只需填 baseURL + apiKey + model，无需改任何代码。
 *
 *   流式解析手写实现（不引第三方 SDK），原因：
 *     ① 需要在 Service Worker 里减小体积
 *     ② 各家 SDK 对中转站的兼容性反而更差
 *     ③ SSE 分块边界必须自己控制，避免 JSON 被截断
 */

import type { ChatImage, LlmConfig, ProviderId, TokenUsage } from './types';
import { fmtTime } from './time';

/* ================================================================== *
 * 服务商预设
 * ================================================================== */

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseURL: string;
  model: string;
  /** 该服务商的定位说明 —— 帮助用户判断"这是谁、适不适合我" */
  blurb: string;
  /** 部署方式分组，编码真实差异（不是装饰性分类） */
  group: 'cloud-cn' | 'cloud-global' | 'local';
  /** 官方标识文件名（位于 public/logos/），无则回退为首字母 */
  logo?: string;
  hint?: string;
}

/**
 * 服务商预设。
 *
 * 顺序与分组反映真实差异：国内直连 / 海外 / 本地自建。
 * 用户在设置页看到的不是一排等价的按钮，而是"三类不同的东西"。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    blurb: '国内聚合，模型最全',
    group: 'cloud-cn',
    logo: 'siliconflow.png',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    blurb: '便宜、长文本强',
    group: 'cloud-cn',
    logo: 'deepseek.svg',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    blurb: '超长上下文',
    group: 'cloud-cn',
    logo: 'moonshot.png',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    blurb: '国内老牌',
    group: 'cloud-cn',
    logo: 'zhipu.png',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    blurb: '质量标杆',
    group: 'cloud-global',
    logo: 'openai.png',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.0-flash-001',
    blurb: '一个 key 走遍各家',
    group: 'cloud-global',
    logo: 'openrouter.svg',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    blurb: '本机运行，数据不出门',
    group: 'local',
    logo: 'ollama.svg',
    hint: '需先运行 ollama serve',
  },
  {
    id: 'custom',
    label: '自定义端点',
    baseURL: '',
    model: '',
    blurb: '中转站或自建服务',
    group: 'local',
    hint: '任何 OpenAI 兼容端点',
  },
] as const;

/** 分组标题（编码真实差异：部署方式） */
export const PROVIDER_GROUPS: ReadonlyArray<{
  id: ProviderPreset['group'];
  title: string;
  note: string;
}> = [
  { id: 'cloud-cn', title: '国内云端', note: '直连快，无需代理' },
  { id: 'cloud-global', title: '海外云端', note: '模型质量高，可能需网络条件' },
  { id: 'local', title: '本地 / 自建', note: '数据不出本机，或你已有的端点' },
];

/** 规范化 baseURL：去尾斜杠；若用户只填了域名则补 /v1 */
export function normalizeBaseURL(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // 若结尾不是版本段，且没有 /chat/completions，补 /v1（多数中转站遵循此约定）
  if (!/\/(v\d+|api\/paas\/v\d+)$/i.test(u) && !/\/chat\/completions$/i.test(u)) {
    u = `${u}/v1`;
  }
  return u;
}

/**
 * 由 baseURL 推出 host 匹配模式，用于申请运行时域名权限。
 *
 * 注意必须用 u.host 而不是 u.hostname —— hostname 会丢掉端口号，
 * 导致本地服务（如 Ollama 的 http://localhost:11434）授权后依然无法访问。
 */
export function hostPatternFromBaseURL(baseURL: string): string | null {
  try {
    const u = new URL(normalizeBaseURL(baseURL));
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/* ================================================================== *
 * 提示词
 *
 * 只有两种用途，各自一份完整的系统提示：
 *   · 笔记：把视频压成带时间戳的结构化笔记（一次性产物）
 *   · 聊天：带着同一份字幕回答追问（多轮）
 * 两者不共享格式约束，因此不会互相污染。
 * ================================================================== */

/** 两种用途共用的底线规则 */
const COMMON_RULES = `通用要求：
- 只依据我提供的字幕原文作答，不得引入原文没有的信息；原文语焉不详处如实说明，不要臆测。
- 字幕大多由 ASR 引擎自动转写，可能不完全精准：同音字、术语误识、断句不通、
  标点缺失都可能出现。遇到语义不通或明显用词错误时，请结合上下文自行理解与纠正，
  不要照抄错误的用词，也不必专门指出「字幕有误」。
- 引用具体内容时，在句末标注该内容在视频中的时间，格式为 [mm:ss] 或 [h:mm:ss]。
  只能使用字幕中出现过的时间，**绝对不得编造或估算**。
- 需要对比多项信息（概念、步骤、优缺点）时，用 Markdown 表格呈现，而不是堆成列表。
- 数学内容一律用 LaTeX：行内公式写 $...$，独立公式写 $$...$$；
  不要用 Unicode 符号拼凑分式、上下标或矩阵。
- 不要写「以下是」「希望对你有帮助」「综上所述」这类过场话，直接给结果。`;

/** 生成笔记用的系统提示 */
export const NOTE_SYSTEM = `你是一位极擅长把长视频「压缩成可快速消化的结构化中文笔记」的内容分析师。

严格遵守以下要求：
1. **信息密度优先**：删掉所有客套、铺垫、重复、口头禅，只保留干货。
2. **结构化**：用二级标题分章节，章节顺序与视频推进顺序一致。
3. **必须标注时间戳**：每个章节标题后标注该章节的起始时间，格式为 [mm:ss] 或 [h:mm:ss]。
4. **要点要具体**：每章节下用无序列表写 2-6 条，写明具体结论、数据、方法、案例，
   禁止出现「讲了 xxx」「介绍了 xxx」这类空话。
5. **开头给摘要**：正文前用一段 100-200 字总述，说清「这个视频解决什么问题、结论是什么」。
6. **结尾给速览**：最后用 3-5 条一行式 Take-away 收尾。

${COMMON_RULES}

输出格式（严格遵守，不要有任何前言或结语）：

## 核心摘要
（100-200 字总述）

## 章节笔记
### [mm:ss] 章节标题
- 要点
- 要点

## 关键 Take-away
- 结论`;

/** 聊天用的系统提示 */
export const CHAT_SYSTEM = `你是一位刚看完这个视频的助手，正在和用户讨论它的内容。

严格遵守以下要求：

1. **像对话一样回答**：直接回答问题，不要复述问题，不要写「根据视频内容」「以下是」这类开场。

2. **篇幅由问题决定，不是由「简洁」决定**：
   - 问一个具体事实（「第几分钟提到 X」「作者叫什么」）：一两句话答完，这是对的。
   - 问「讲了什么」「怎么理解 X」「帮我梳理一下」「为什么」这类需要展开的问题：
     必须给出完整回答。默认标准是**分点写清楚，每点一到三句**，
     整体通常在 300 字以上；结论、依据、例子、时间戳都给出来。
     这种问题用一句话答完，就是失败的回答。
   - 判断标准：如果这段回答拿去替换原视频，读者能不能得到同样的信息？
     不能，就说明写少了。

3. **展开时用结构，不要堆成一大段**：用小标题分点，每条先给结论再给依据，
   引用具体内容时带上时间戳。不要为了显得完整而重复同一个意思。

4. **忠于字幕**：字幕里没提到的就说没提到，不要用常识去补。
   不要把「B站官方摘要」当成你自己的判断来复述。

5. **允许追问**：如果问题含糊（例如「这里」指代不明），先按最合理的理解回答，
   再补一句你在按什么理解回答。

6. **不要反问、不要客套**：答完就停。不要写「你想了解哪方面」「你现在看到哪一块了」
   这类把球踢回去的话，也不要用「可以，随时」开头。除非问题确实无法回答，
   否则直接把答案给出来。一次回答里最多留一个追问，而且必须是回答完之后才问。

7. **用户可能贴图**：如果这一轮带了图片，图里通常是视频截图或评论区截图。
   把它当作问题的上下文一起回答，并在必要时说明你从图里看到了什么。

${COMMON_RULES}

格式：不要用一级标题（#）。长回答用 ### 小标题分段，需要列举时用无序列表。`;

/* ================================================================== *
 * 上下文组装
 * ================================================================== */

export interface BuildPayload {
  info: {
    title: string;
    upName: string;
    duration: number;
    bvid: string;
    desc?: string;
    pageIndex?: number;
  };
  conclusion?: {
    available: boolean;
    summary?: string;
    outline?: Array<{
      title: string;
      timestamp: number;
      points: Array<{ timestamp: number; content: string }>;
    }>;
  };
  subtitle?: Array<{ from: number; content: string }>;
}

/**
 * OpenAI 兼容协议里的内容块。
 *
 * 纯文本消息用 string 即可，只有带图时才需要数组形式——
 * 这样绝大多数请求的报文形状保持原样，不会因为支持图片而变重。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

/** 把「文字 + 图片」组装成 content 字段；没有图片时退化为纯字符串 */
export function buildUserContent(text: string, images?: ChatImage[]): MessageContent {
  if (!images?.length) return text;
  return [
    { type: 'text', text },
    ...images.map((img) => ({
      type: 'image_url' as const,
      image_url: { url: img.dataURL },
    })),
  ];
}

/**
 * 根据模型的上下文窗口 (contextWindow) 与单次最大输出 (maxTokens) 动态计算字幕的安全字符预算。
 *
 * 【为什么需要自适应预算】
 * 以前固定写死 90,000 字符（约 45k tokens）。遇到 8k / 16k / 32k 的小上下文模型时会直接报 400
 * context_length_exceeded；而遇到 128k / 1M 的长上下文模型时，又会白白抽样浪费掉完整字幕。
 * 本函数预留系统提示、视频元数据与最大输出预算后，按安全字符比例将剩余 Token 换算为字幕字符数。
 */
export function calculateTranscriptBudget(contextWindow = 0, maxTokens = 0): number {
  if (contextWindow <= 0) return 90_000;
  // 预留系统提示(~1000) + 视频信息提纲(~1500) + 用户任务要求(~500) = 3000 tokens
  const reservedOutput = maxTokens > 0 ? maxTokens : 4096;
  const overhead = 3000 + reservedOutput;
  const availableTokens = Math.max(2000, contextWindow - overhead);
  // 中文字符在分词中通常 1 token 对应 1.2 ~ 1.5 字符，取保守系数 1.3
  return Math.max(6_000, Math.floor(availableTokens * 1.3));
}

/** 字幕转「带时间戳的纯文本」，并在过长时做保持时间轴覆盖的抽样 */
export function formatTranscript(
  segments: Array<{ from: number; content: string }>,
  maxChars = 90_000,
): string {
  if (!segments?.length) return '';

  const lines = segments
    .map((s) => {
      const txt = String(s.content ?? '').replace(/\s+/g, ' ').trim();
      return txt ? `[${fmtTime(s.from)}] ${txt}` : '';
    })
    .filter(Boolean);

  const text = lines.join('\n');
  if (text.length <= maxChars) return text;

  // 超长：等距抽样，保留首尾，确保时间轴覆盖完整
  const step = Math.max(1, Math.ceil(lines.length / Math.max(1, Math.floor(maxChars / 60))));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i % step === 0 || i >= lines.length - 3) kept.push(lines[i] as string);
  }
  return `${kept.join('\n')}\n\n（注：原文过长，已按等距抽样压缩，时间轴覆盖保持完整）`;
}

export interface BuildMaterialOptions {
  /** 字幕抽样字符上限；留空时根据 contextWindow / maxTokens 自动计算或取默认 90,000 */
  maxChars?: number;
  /** 模型上下文窗口（Tokens） */
  contextWindow?: number;
  /** 模型单次最大输出（Tokens） */
  maxTokens?: number;
}

/**
 * 组装「视频材料」—— 笔记与聊天共用同一份。
 *
 * 【为什么抽出来】
 * 聊天不需要先生成笔记，但同样需要字幕。若两个功能各拼一份上下文，
 * 不仅重复，还会出现「笔记里有的信息聊天里没有」这类不一致。
 * 现在两个入口都调用它，材料完全一致。
 */
export function buildMaterial(payload: BuildPayload, options?: BuildMaterialOptions): string {
  const { info, conclusion, subtitle } = payload;
  const parts: string[] = [];

  const pageSuffix = info.pageIndex && info.pageIndex > 1 ? `?p=${info.pageIndex}` : '';
  parts.push(
    [
      '# 视频信息',
      `标题：${info.title}`,
      `UP主：${info.upName || '未知'}`,
      `时长：${fmtTime(info.duration)}`,
      `链接：https://www.bilibili.com/video/${info.bvid}${pageSuffix}`,
    ].join('\n'),
  );

  if (info.desc) parts.push(`# 视频简介\n${info.desc}`);

  const c = conclusion;
  if (c?.available && c.outline?.length) {
    const outlineTxt = c.outline
      .map((o) => {
        const pts = o.points
          .map((p) => `    · [${fmtTime(p.timestamp)}] ${p.content}`)
          .join('\n');
        return `  ${o.title} [${fmtTime(o.timestamp)}]\n${pts}`;
      })
      .join('\n');
    parts.push(`# B站官方 AI 提纲（可参考其分段结构，但表达须重新组织）\n${outlineTxt}`);
  }

  if (c?.available && c.summary) {
    parts.push(`# B站官方 AI 摘要（仅供参考，不要直接照抄）\n${c.summary}`);
  }

  if (subtitle?.length) {
    const budget =
      typeof options?.maxChars === 'number' && options.maxChars > 0
        ? options.maxChars
        : calculateTranscriptBudget(options?.contextWindow ?? 0, options?.maxTokens ?? 0);

    parts.push(
      `# 视频字幕原文（带时间戳，共 ${subtitle.length} 条）\n${formatTranscript(subtitle, budget)}`,
    );
  }

  return parts.join('\n\n');
}

/** 组装「生成笔记」的两条消息 */
export function buildNoteMessages(
  payload: BuildPayload,
  options?: BuildMaterialOptions,
): ChatMessage[] {
  return [
    { role: 'system', content: NOTE_SYSTEM },
    {
      role: 'user',
      content: `${buildMaterial(payload, options)}\n\n# 任务\n请把上面这个视频整理成结构化中文笔记，严格按系统提示的输出格式。`,
    },
  ];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** 这一轮用户消息附带的图片（仅本次会话内存中，不落盘） */
  images?: ChatImage[];
}

/**
 * 最多保留多少轮「带图的用户消息」。
 *
 * 【为什么不是只保留最后一轮】
 * 贴图之后往往要连着追问（「这里讲了什么」→「那前面那段呢」），
 * 只留最后一轮的话，第二问开始模型就看不到原图了，
 * 只能靠它自己上一轮的回答复述——用户会立刻发现「你刚才明明看到图了」。
 *
 * 【为什么要设上限】
 * 图片每轮都要重传，不设限就会随着会话无限累积。
 * 两张图相对几万 token 的字幕只是零头，因此留 2 轮，
 * 既覆盖连续追问，又不会失控。
 */
const IMAGE_KEEP_TURNS = 2;

export interface BuildChatOptions extends BuildMaterialOptions {
  /** 当前播放位置（秒）。为 null 表示用户关闭了「附带播放位置」 */
  playhead?: number | null;
}

/**
 * 组装「聊天」的消息序列。
 *
 * 结构：system → 材料（作为第一轮 user）→ 历史对话
 *
 * 【为什么材料要伪装成一轮 user/assistant】
 * 只放 system 里也可以，但那样模型容易把字幕当成「指令」而不是「资料」。
 * 走一轮「这是资料 / 好的我了解了」的对话，后续追问会稳定得多，
 * 也是各家工具处理长文档的通行做法。
 *
 * 【前缀缓存契约——改这个函数前必读】
 * 各家（OpenAI / DeepSeek / Qwen / SiliconFlow / vLLM / SGLang…）的
 * 隐式前缀缓存都靠「与上一次请求逐字节一致的开头」命中，命中部分按约
 * 一折到五折计费。本函数刻意做成：
 *   ① 静态在前、易变在后——system 与材料完全静态，唯一逐轮变化的
 *      只有最后一条用户消息（含播放位置注记）；
 *   ② 历史只追加、从不改写——第 N 轮请求的前缀就是第 N-1 轮的全文。
 * 因此不得往 system / 材料里插入时间戳、随机数、轮次相关内容；
 * 材料字符串必须由同一视频确定性生成（buildMaterial 无 Date/random/locale）。
 * 已知的有界破坏点：IMAGE_KEEP_TURNS 淘汰旧图轮时，该消息形状会变，
 * 其后消息当轮不命中——但材料大块在此之前仍命中，损失可接受。
 *
 * 【播放位置默认不带】
 * 多数追问是关于整个视频的（「它到底想说明什么」），
 * 此时带上播放位置反而会让模型误以为「在问当前这一段」。
 * 因此只有用户在界面上明确打开时才附上。
 */
export function buildChatMessages(
  payload: BuildPayload,
  history: ChatTurn[],
  options: BuildChatOptions = {},
): ChatMessage[] {
  const material = buildMaterial(payload, options);

  const msgs: ChatMessage[] = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'user', content: `${material}\n\n以上是这个视频的全部资料，请先阅读。` },
    { role: 'assistant', content: '好的，我已经看完了这个视频的字幕，你可以直接问我。' },
  ];

  // 只有明确开启且确实拿到了播放位置时才附上
  const ph = options.playhead;
  const playheadNote =
    typeof ph === 'number' && Number.isFinite(ph) ? `\n\n（我当前看到 ${fmtTime(ph)} 处。）` : '';

  // 只给最后 IMAGE_KEEP_TURNS 轮带图的用户消息保留图片
  const withImages: number[] = [];
  history.forEach((t, i) => {
    if (t.role === 'user' && t.images?.length) withImages.push(i);
  });
  const keepImages = new Set(withImages.slice(-IMAGE_KEEP_TURNS));

  history.forEach((turn, i) => {
    const isLastUser = turn.role === 'user' && i === history.length - 1;
    const text = isLastUser ? `${turn.content}${playheadNote}` : turn.content;

    msgs.push({
      role: turn.role,
      content: buildUserContent(text, keepImages.has(i) ? turn.images : undefined),
    });
  });

  return msgs;
}

/* ================================================================== *
 * 流式调用
 * ================================================================== */

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  /**
   * 思考过程（思维链）增量。模型 / 网关输出 reasoning_content 时才会有；
   * 不发任何额外请求参数，因此对不支持思考的端点零影响。
   */
  onReasoning?: (text: string) => void;
  /** token 用量。端点在流里带 usage 块时才会有（cmdgo-bridge 固定发，多数端点要 stream_options） */
  onUsage?: (usage: TokenUsage) => void;
  signal?: AbortSignal;
}

export interface StreamParts {
  content: string;
  reasoning: string;
}

/** 从响应 JSON 的 usage 块提取用量；形状不对返回 null */
export function pickUsage(json: unknown): TokenUsage | null {
  if (!json || typeof json !== 'object') return null;
  const u = (json as { usage?: unknown }).usage;
  if (!u || typeof u !== 'object') return null;
  const r = u as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = num(r['prompt_tokens']);
  const completion = num(r['completion_tokens']);
  const total = num(r['total_tokens']) || prompt + completion;
  if (prompt === 0 && completion === 0) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/**
 * 从一条 SSE JSON 中提取正文与思考增量。
 *
 * 字段取自事实标准：`reasoning_content`（DeepSeek / vLLM / SGLang / LM Studio）、
 * `reasoning`（OpenRouter 等网关）。两者都不出现就是普通非思考模型。
 */
export function pickParts(json: unknown): StreamParts {
  if (!json || typeof json !== 'object') return { content: '', reasoning: '' };
  const j = json as {
    choices?: Array<{
      delta?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
      message?: { content?: string | null; reasoning_content?: string | null };
      text?: string | null;
    }>;
  };
  const c = j.choices?.[0];
  if (!c) return { content: '', reasoning: '' };
  return {
    content: c.delta?.content ?? c.message?.content ?? c.text ?? '',
    reasoning: c.delta?.reasoning_content ?? c.delta?.reasoning ?? c.message?.reasoning_content ?? '',
  };
}

/** 从一条 SSE JSON 中提取增量文本，兼容多种返回形态 */
export function pickDelta(json: unknown): string {
  return pickParts(json).content;
}

/** 解析 SSE 文本（非流式兜底用） */
export function parseSseText(text: string): string {
  let out = '';
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const d = l.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      out += pickDelta(JSON.parse(d));
    } catch {
      /* 忽略半截 JSON */
    }
  }
  return out;
}

/**
 * 增量解析器：把任意分块的 SSE 字节流解析为文本增量。
 * 抽成独立类以便单测（分块边界是最容易出错的地方）。
 */
export interface SseParserHooks {
  /** 思考增量回调；不传时思考内容被静默丢弃（与旧行为一致） */
  onReasoning?: (text: string) => void;
  /** token 用量回调；流里出现 usage 块时触发（通常一次） */
  onUsage?: (usage: TokenUsage) => void;
}

export class SseParser {
  private buffer = '';
  private done = false;

  constructor(private readonly hooks: SseParserHooks = {}) {}

  /** 喂入一段文本，返回本次新增的正文增量 */
  push(chunk: string): string {
    if (this.done) return '';
    this.buffer += chunk;

    let out = '';
    let idx: number;

    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);

      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue; // 空行 / 心跳
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.done = true;
        break;
      }

      try {
        const json = JSON.parse(data);
        const { content, reasoning } = pickParts(json);
        if (reasoning) this.hooks.onReasoning?.(reasoning);
        // usage 可能单独成块（choices 为空），也可能搭在最后一个内容块上
        const usage = pickUsage(json);
        if (usage) this.hooks.onUsage?.(usage);
        out += content;
      } catch {
        /* 忽略无法解析的行 */
      }
    }

    return out;
  }

  /** 流结束时冲刷残余缓冲 */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest.startsWith('data:')) return '';
    const data = rest.slice(5).trim();
    if (!data || data === '[DONE]') return '';
    try {
      const json = JSON.parse(data);
      const { content, reasoning } = pickParts(json);
      if (reasoning) this.hooks.onReasoning?.(reasoning);
      const usage = pickUsage(json);
      if (usage) this.hooks.onUsage?.(usage);
      return content;
    } catch {
      return '';
    }
  }
}

export function getProviderLabel(providerId?: string): string {
  const hit = PROVIDER_PRESETS.find((p) => p.id === providerId);
  return hit ? hit.label : providerId || '大模型服务商';
}

export function isLocalEndpoint(urlOrBase: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(urlOrBase);
}

export type LlmErrorCode =
  | 'NOT_CONFIGURED'     // 忘配置模型或关键信息（API Key / 模型名）
  | 'NETWORK_ERROR'      // 无法连接（本地未启动服务或云端网络不可达）
  | 'AUTH_ERROR'         // 401 / 403 API Key 无效或未授权
  | 'NOT_FOUND'          // 404 端点路径错误
  | 'RATE_LIMIT'         // 429 配额用尽或限流
  | 'SERVER_ERROR'       // 500/502/503/504 服务商宕机或内部错误
  | 'BAD_REQUEST'        // 400 参数格式或多模态/上下文超限
  | 'UNKNOWN';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
    readonly code: LlmErrorCode = 'UNKNOWN',
    readonly providerLabel?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function buildRequest(cfg: LlmConfig, messages: ChatMessage[]): {
  url: string;
  init: RequestInit;
  providerLabel: string;
} {
  const providerLabel = getProviderLabel(cfg.provider);
  const base = normalizeBaseURL(cfg.baseURL);
  if (!base) {
    throw new LlmError(
      '尚未配置 API 地址。请打开插件设置选择服务商并填写 API 地址。',
      undefined,
      undefined,
      'NOT_CONFIGURED',
      providerLabel,
    );
  }
  if (!cfg.model.trim()) {
    throw new LlmError(
      '尚未配置模型名称。请打开插件设置填写或选择要使用的模型。',
      undefined,
      undefined,
      'NOT_CONFIGURED',
      providerLabel,
    );
  }

  // 云端服务商但未填写 API Key 检查
  const isCloud = cfg.provider && cfg.provider !== 'ollama' && cfg.provider !== 'custom';
  if (isCloud && !cfg.apiKey.trim()) {
    throw new LlmError(
      `服务商「${providerLabel}」尚未配置 API Key。请前往设置页填入有效密钥后再使用。`,
      undefined,
      undefined,
      'NOT_CONFIGURED',
      providerLabel,
    );
  }

  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey.trim()) headers['Authorization'] = `Bearer ${cfg.apiKey.trim()}`;

  const body: Record<string, unknown> = {
    model: cfg.model.trim(),
    messages,
    stream: true,
    temperature: cfg.temperature,
  };
  // 仅在显式设置时附带，避免部分严格服务商对 0 / null 报错
  if (cfg.maxTokens > 0) body['max_tokens'] = cfg.maxTokens;
  // 思考深度：只在用户明确选了档位时发送；空串 = 让模型用默认深度
  if (cfg.reasoningEffort) body['reasoning_effort'] = cfg.reasoningEffort;

  return {
    url,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    providerLabel,
  };
}

/**
 * 流式对话。
 * @returns 完整文本
 */
export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  cb: StreamCallbacks,
): Promise<string> {
  const { url, init, providerLabel } = buildRequest(cfg, messages);
  if (cb.signal) init.signal = cb.signal;

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(msg)) {
      if (isLocalEndpoint(url)) {
        throw new LlmError(
          `无法连接本地模型服务（${url}）。\n请检查：本地大模型程序（如 Ollama / LM Studio / vLLM）是否已开启并正常监听对应端口。`,
          undefined,
          msg,
          'NETWORK_ERROR',
          providerLabel,
        );
      }
      throw new LlmError(
        `无法连接大模型服务商「${providerLabel}」（${url}）。\n请检查：① 本地网络连接或代理是否正常 ② 服务商服务器是否正常在线。`,
        undefined,
        msg,
        'NETWORK_ERROR',
        providerLabel,
      );
    }
    throw new LlmError(`网络请求异常: ${msg}`, undefined, msg, 'NETWORK_ERROR', providerLabel);
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 600);
    } catch {
      /* 忽略 */
    }

    let code: LlmErrorCode = 'UNKNOWN';
    let hint = '';

    if (resp.status === 401 || resp.status === 403) {
      code = 'AUTH_ERROR';
      hint = `服务商「${providerLabel}」鉴权失败 (HTTP ${resp.status})：API Key 无效、已过期或余额不足。请前往「设置」检查您的 API Key 并确认账户额度。`;
    } else if (resp.status === 404) {
      code = 'NOT_FOUND';
      hint = `服务商「${providerLabel}」端点未找到 (HTTP 404)：请求地址（${url}）错误，请检查设置中 API 地址是否有多写或遗漏 /v1 等路径。`;
    } else if (resp.status === 429) {
      code = 'RATE_LIMIT';
      hint = `服务商「${providerLabel}」请求过于频繁或配额耗尽 (HTTP 429)：已触发服务商速率限制，请稍后重试或前往服务商控制台查询账户额度。`;
    } else if (resp.status >= 500 && resp.status <= 599) {
      code = 'SERVER_ERROR';
      hint = `大模型服务商「${providerLabel}」服务端异常 (HTTP ${resp.status})：服务商当前可能过载或临时故障，请稍后重试或前往「设置」切换其他可用模型。`;
    } else if (resp.status === 400 && /context|length|token|maximum context/i.test(detail)) {
      code = 'BAD_REQUEST';
      hint = `服务商「${providerLabel}」提示上下文超长 (HTTP 400)：内容超出模型单次最大窗口，请在设置中适当调小上下文窗口或换用更大上下文的模型。`;
    } else if (resp.status === 400 && /image|vision|multimodal|content/i.test(detail)) {
      code = 'BAD_REQUEST';
      hint = `模型「${cfg.model}」可能不支持图像输入 (HTTP 400)：若附带了图片，请前往设置确认该模型是否具备视觉能力。`;
    } else {
      code = 'BAD_REQUEST';
      hint = `服务商「${providerLabel}」请求失败 (HTTP ${resp.status})`;
    }

    throw new LlmError(hint, resp.status, detail, code, providerLabel);
  }

  // 极端情况：服务端未返回流，退化读取
  if (!resp.body) {
    const text = await resp.text();
    const full = parseSseText(text);
    if (full) {
      cb.onDelta(full);
      return full;
    }
    throw new LlmError('服务端未返回可读流', undefined, undefined, 'SERVER_ERROR', providerLabel);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser({ onReasoning: cb.onReasoning, onUsage: cb.onUsage });
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    const delta = parser.push(text);
    if (delta) {
      full += delta;
      cb.onDelta(delta);
    }
  }

  // 冲刷解码器与解析器的残余
  const tail = decoder.decode();
  if (tail) {
    const delta = parser.push(tail);
    if (delta) {
      full += delta;
      cb.onDelta(delta);
    }
  }
  const flushed = parser.flush();
  if (flushed) {
    full += flushed;
    cb.onDelta(flushed);
  }

  return full;
}

/** 拉取模型列表（设置页「测试连接」用） */
export async function listModels(cfg: Pick<LlmConfig, 'baseURL' | 'apiKey'>): Promise<string[]> {
  const base = normalizeBaseURL(cfg.baseURL);
  if (!base) throw new LlmError('请先填写 API 地址', undefined, undefined, 'NOT_CONFIGURED');

  const headers: Record<string, string> = {};
  if (cfg.apiKey.trim()) headers['Authorization'] = `Bearer ${cfg.apiKey.trim()}`;

  let resp: Response;
  try {
    resp = await fetch(`${base}/models`, { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(msg)) {
      if (isLocalEndpoint(base)) {
        throw new LlmError(
          `无法连接本地服务（${base}），请确认本地模型服务已启动并正在监听对应端口`,
          undefined,
          msg,
          'NETWORK_ERROR',
        );
      }
      throw new LlmError(
        `无法连接到服务商地址（${base}），请检查网络、代理设置或 API 地址是否正确`,
        undefined,
        msg,
        'NETWORK_ERROR',
      );
    }
    throw new LlmError(`网络请求异常: ${msg}`, undefined, msg, 'NETWORK_ERROR');
  }

  if (!resp.ok) {
    const hint =
      resp.status === 401 || resp.status === 403
        ? '（鉴权失败，请检查 API Key）'
        : resp.status === 404
          ? '（端点未找到，该地址可能不支持 /models 接口）'
          : '';
    throw new LlmError(
      `HTTP ${resp.status}${hint}`,
      resp.status,
      undefined,
      resp.status === 401 || resp.status === 403 ? 'AUTH_ERROR' : resp.status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR',
    );
  }

  const j = (await resp.json()) as { data?: Array<{ id?: string }> };
  return (j.data ?? []).map((m) => m.id ?? '').filter(Boolean);
}
