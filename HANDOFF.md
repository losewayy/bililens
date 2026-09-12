# BiliLens 交接文档

> 给接手的新 Session。请先完整读一遍，再动手。
> 项目根目录：`C:\Users\oooo\Desktop\哔哩哔哩\bililens`

---

## 一、项目是什么

Chrome MV3 扩展：把 B站视频的**官方 AI 总结 + 字幕**交给用户自己的大模型，生成带时间戳的结构化笔记，并能就视频内容聊天。

用户核心诉求：**不要繁琐**。原话「我不太希望还需要我去把视频下下来，再通过 ASR 引擎转化成文本，然后再由 AI 进行总结」。

技术栈：WXT 0.21.4 + Vite 8 + Vue 3.5 + **TypeScript 5.9.3（不要升 TS 7）** + Vitest。

---

## 二、当前代码状态（务必先确认）

### ✅ 已完成且已验证

| 项 | 状态 |
|---|---|
| 侧边栏「跟着标签页跑」的 bug | 已修，`verify-tabpanel.mjs` 17/0 |
| 设置页深色模式白屏 | 已修，`verify-theme.mjs` 4/0 |
| `vue-tsc` | 0 错误 |
| 单测 | 158/158 |
| `wxt build` | 通过，377 kB |

### ⚠️ 已改但**未构建、未验证**

`lib/llm.ts` 的 `CHAT_SYSTEM` 已被我改过一版（让回答更展开、禁止反问客套）。
**这个改动没有经过 typecheck / build / 实测。** 接手后先看一眼是否合理，不满意可以直接再改。

### ❌ 完全未开始

下面三个需求，一行代码都没写。

---

## 三、三个待办需求

### 需求 1：聊天回答太简短

**用户原话**：「聊天（CHAT_SYSTEM）的 Prompt 影响有点大了，他说话太简短了」

**现象**：用户问「你先给我总结一下讲了什么吧」，模型用一句话带过，且爱反问（「你现在看到哪一块了？」）、爱客套（「可以，随时」）。

**位置**：`lib/llm.ts` 的 `CHAT_SYSTEM`（约 200 行）

**我已做的改动**（待你判断是否够）：
- 把「默认 2-5 句」改成「篇幅跟着问题走」，区分具体事实 vs 需要展开的问题
- 新增第 5 条：不要反问、不要客套
- 格式放宽：允许 `###` 小标题

**建议**：改完用 `pnpm prompt`（`scripts/dump-prompts.mjs`）导出实际提示词确认，再真机试一轮。

---

### 需求 2：支持配置多个 Provider + 模型选择器

**用户原话**：
> 「设置中能否配置多个Provider？并且我发现你既然可以拉取模型了，那就不需要我再手动去填了，直接给一个选择器，我自己选择模型不就好了吗？」

**现状**：
- `Settings.llm` 是**单个** `LlmConfig`（`lib/types.ts:236`、`:256`、`:270`）
- 设置页已有服务商预设卡片 + 模型列表，但模型列表要靠用户手动点「测试连接」才填充（`entrypoints/options/App.vue:522-541`）

**我的设计决定**（未实施，供参考，你可以推翻）：

```ts
// lib/types.ts
export interface LlmProfile {
  id: string;          // 稳定 id（crypto.randomUUID）
  name: string;        // 用户可改的显示名，默认取服务商 label
  provider: ProviderId;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface Settings {
  profiles: LlmProfile[];
  activeProfileId: string;
  // 删掉 llm: LlmConfig
}
```

关键点：
- **保持 `LlmConfig` 的字段形状不变**，让 `streamChat(cfg, ...)` 零改动 —— profile 本身就是一份 LlmConfig + id/name
- 加一个 `getActiveProfile(settings): LlmProfile | null` 辅助函数
- **必须做迁移**：`loadSettings()` 里若发现旧 `llm` 字段且无 `profiles`，自动转成一个 profile。`lib/storage.ts:16-24` 的 `mergeSettings` 是迁移的正确位置
- 模型选择器：用原生 `<select>`（用户说的「选择器」），在 baseURL + apiKey 齐全且已授权域名时**自动拉取** `/models`（`listModels()` 已存在，`lib/llm.ts:609`），不要再让用户点按钮
- 保留手动输入作为兜底（部分中转站不支持 `/models`）

**受影响的文件**（已 grep 确认，共 26 处引用）：
- `lib/types.ts`、`lib/storage.ts`、`lib/llm.ts`
- `composables/useReader.ts`：362、392、399、418、445、491 行
- `entrypoints/options/App.vue`：461、486、491、501、516、536、549、553、573、602 行
- `tests/reader.test.ts:125`

---

### 需求 3：聊天框粘贴图片

**用户原话**：「我尝试了Ctrl+V和粘贴，没有办法在聊天框粘贴图片」

**现状**：`components/ChatPanel.vue` 的 textarea **完全没有 paste 处理**，所以图片被浏览器丢弃。

**我的设计决定**（未实施，供参考）：

1. **粘贴处理**：`@paste` 事件，从 `e.clipboardData.items` 里筛 `type.startsWith('image/')`
2. **粘贴后先降采样**：canvas 缩到最长边 ~1280px，导 JPEG 0.82。既省 token 又省存储
3. **发送格式**：OpenAI 多模态 content 数组
   ```ts
   { role: 'user', content: [
       { type: 'text', text: '...' },
       { type: 'image_url', image_url: { url: dataURL } },
   ]}
   ```
   需要把 `ChatTurn.content` / `ChatMessage.content` 从 `string` 放宽为联合类型
4. **存储：建议图片只在本次会话内存中保留，不落盘**。理由：`chrome.storage.local` 默认配额约 10MB，而聊天记录限 30 个视频 × 60 轮，图片落盘极易爆配额。重载后用户消息旁显示「图片已不再保留」占位。
   → **这是一个需要你确认的取舍**，若用户要求持久化，必须加 `unlimitedStorage` 权限或做图片淘汰策略
5. 输入框上方显示缩略图 + 删除按钮

**⚠️ 重要未知**：用户当前端点是 `http://127.0.0.1:11435/v1`，模型 `deepseek/deepseek-v4.1-flash`（本地网关）。**这个模型是否支持视觉输入未经验证**。动手前建议先确认，否则功能做了也用不了。若模型不支持，应给出明确报错而不是静默失败。

---

## 四、踩过的坑（别重犯）

1. **`side_panel.default_path` 必须在构建产物里删掉**。WXT 会**无条件**注入它（`node_modules/wxt/dist/core/utils/manifest.mjs:163-176`），配置里不写拦不住。已在 `wxt.config.ts` 挂 `build:manifestGenerated` 钩子删除。这是「侧边栏跟着标签页跑」的真正根因 —— `enabled:false` 只是「该 tab 无专属配置」，不阻止全局回退面板。

2. **`open({tabId})` 要求该 tab 面板已启用**，否则报 `No active side panel for tabId`。所以点击处理器里 `setOptions` 必须先于 `open`。

3. **「await 让用户手势失效」是错误判断**。实测 await 一次 storage 后再 `open()` 依然成功。别照着这个假结论改代码。

4. **WXT 的 `modules` 数组里不能写本地模块相对路径**（会相对 WXT 自身 dist 解析而报 Cannot find module）。用 config 内联 `hooks`。

5. **`modules: ['@wxt-dev/module-vue']` 必须字符串形式**，传对象报 `Cannot find package '[object Object]'`。

6. **TS 锁 5.9.3**。TS 7（Go 重写版）不再导出 `./lib/tsc`，会导致 `.vue` 模板类型检查**静默失效**。

7. **`hostPatternFromBaseURL` 必须用 `u.host` 而非 `u.hostname`** —— hostname 丢端口，本地服务授权后仍连不上。

8. **测试陷阱**：断言「配置」不等于断言「行为」。旧测试断言 `getOptions({tabId}).enabled === false` 全绿，但用户实际看到面板仍展开。验证要断言用户能观测到的结果。

9. **headless Chrome 不渲染侧边栏**，用 CDP target 列表检测面板可见性会恒返回 false（无效探针）。这类需真机人工确认。

---

## 五、环境与命令

```bash
pnpm check          # vue-tsc 类型检查
pnpm test           # vitest
pnpm build          # wxt build → .output/chrome-mv3
node scripts/verify-tabpanel.mjs   # 侧边栏（17 项）
node scripts/verify-theme.mjs      # 深色模式（4 项）
pnpm prompt         # 导出实际提示词
```

- Chrome Beta 154：`C:\Program Files\Google\Chrome Beta\Application\chrome.exe`
- Node v24.15.0，pnpm
- 用户端点：`http://127.0.0.1:11435/v1`，模型 `deepseek/deepseek-v4.1-flash`
- **改完必须让用户在 `chrome://extensions` 点 ⟳ 重载扩展并刷新 B站页面**（若改了 manifest 尤其必须）

---

## 六、和这位用户协作的注意事项（很重要）

1. **他会明确抱怨 looping**。我在本次会话中两次陷入「反复输出无意义的内部草稿而不发出工具调用」的退化循环，浪费大量 token，他非常不满。**想到就立刻发工具调用，不要在脑内反复排练。**

2. **他讨厌过度设计和重型测试**。原话：
   > 「你做的活太重了，你的测试不能轻量化吗？甚至你就不要做测试了，我自己亲自体验一番不就行了吗」
   > 「你要学会 Adaptive thinking…你不要什么事情都做这么重，太浪费时间了」

   验证要克制：**「如果这项检查失败，会改变我的决定吗？」** 不会就别跑。

3. **他不想做选择**。原话：「你直接根据这个技能自己去设计吧，我不想去选择」。给方案，别给选择题。

4. 全程用中文。改完要如实说明哪些**没有验证**，不要假装全绿。

5. 他要求「先给结论，再说理由」，不要开场先铺垫一堆探查过程。

---

## 七、建议的接手顺序

1. 先跑 `pnpm check && pnpm test && node scripts/verify-tabpanel.mjs && node scripts/verify-theme.mjs`，确认基线是绿的
2. 看 `lib/llm.ts` 的 `CHAT_SYSTEM`，判断我改的那版够不够，不够就再改，然后用 `pnpm prompt` + 真机确认
3. 做需求 2（多 Provider + 模型选择器）—— 改动面最大，先做
4. 做需求 3（图片粘贴）—— 动手前先确认用户模型是否支持视觉
