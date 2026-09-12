# AGENTS.md —— BiliLens 开发约定

> 给在这个仓库里干活的 agent。**动手前先读这一篇。**
> 面向用户的功能说明在 `README.md`，两篇不重复。

---

## 一、先跑起来

```bash
pnpm check          # 类型检查 + 单元测试 + 构建（日常只需这一条）
pnpm compile        # 只跑 vue-tsc
pnpm test           # 只跑 vitest
pnpm build          # wxt build → .output/chrome-mv3
```

需要真实浏览器 / 真实网络的验证（**按需跑，不要每次都跑**）：

```bash
node scripts/verify-tabpanel.mjs   # 侧边栏「只对点过图标的那一页有效」
node scripts/verify-theme.mjs      # 深色模式不是白屏
pnpm e2e                           # 扩展加载 → 注入 → 真实调 B站接口
pnpm verify:live                   # WBI 签名是否仍被 B站服务端接受
pnpm shot                          # 选项页 + 侧边栏截图，含字号/底栏等样式契约断言
pnpm shot:components               # 用真实 .vue 组件渲染并截图
pnpm prompt chat                   # 打印真正发出去的提示词（note / chat）
```

改完要让用户**在 `chrome://extensions` 点 ⟳ 重载扩展并刷新 B站页面**。
改了 `wxt.config.ts` 的 manifest 部分尤其必须——不重载就完全看不到变化。

---

## 二、技术栈与不可动的约束

WXT 0.21 + Vite 8 + Vue 3.5 + **TypeScript 5.9.3（锁死，不要升 7）** + Vitest 5。

**TypeScript 必须停在 5.9.3。** TS 7（Go 重写版）不再导出 `./lib/tsc`，而 `vue-tsc@3.x` 依赖该内部路径，
结果是 **`.vue` 模板的类型检查静默失效**——不报错，但也不再检查。用最新版在这里是错的。

`tsconfig.json` 开了 `strict` + `noUnusedLocals` + `noUnusedParameters`。
未使用的变量/导入会直接编译失败，别留半成品导入。

---

## 三、架构：三条必须理解的链路

### 1. 素材怎么拿到（两个 world 分工）

```
B站页面 (MAIN world)          ISOLATED world            扩展页面
bridge.content.ts   ←→   relay.content.ts   ←→   sidepanel / options
  · 同源身份                · 持有 chrome.* API       · 发起 LLM 请求
  · Cookie 自动携带          · 双向中继                 · 有 DOM，不会被回收
  · 算 WBI 签名
```

- **MAIN world** 才有页面的同源身份（Cookie + Referer 天然正确），但拿不到 `chrome.*`
- **ISOLATED world** 反过来
- 两边靠 `window.postMessage` 通信，协议定义在 `lib/types.ts` 的 `BridgeContract`

**这就是本项目不需要填 Cookie 的原因**——别改成在扩展里伪造 Cookie。

### 2. LLM 调用为什么在侧边栏

MV3 的 Service Worker 约 30 秒空闲就被回收，长视频流式总结要跑 1~3 分钟。
放 SW 里必然被拦腰截断。侧边栏是有 DOM 的扩展页面，生命周期跟随可见状态。

**`background.ts` 只做轻量协调**（开关侧边栏、转发上报）。不要往里加长任务。

### 3. 侧边栏是标签页级的

每个 B站视频页有**独立的面板实例和独立状态**。见 `entrypoints/background.ts`。

---

## 四、踩过的坑（别重犯）

### 侧边栏

1. **`side_panel.default_path` 必须在构建产物里删掉。**
   WXT 只要发现 sidepanel 入口就**无条件**注入它，在 `manifest` 配置里不写拦不住。
   已在 `wxt.config.ts` 的 `build:manifestGenerated` 钩子里 `delete`。
   该字段语义是「全局默认面板」——任何没有专属配置的标签页都会回退显示它，
   于是表现为「侧边栏跟着标签页到处跑」。这是那个 bug 的**真正根因**，
   `enabled: false` 只是「该 tab 无专属配置」，不阻止全局回退。

2. **`open({ tabId })` 要求该 tab 的面板已启用**，否则报 `No active side panel for tabId`。
   点击处理器里 `setOptions` 必须**先于** `open`。

3. **「await 让用户手势失效」是错误判断。** 实测 await 一次 storage 后再 `open()` 依然成功。
   真正必需的是上面那条顺序约束。别照着这个假结论改代码。

4. **`hostPatternFromBaseURL` 必须用 `u.host` 而非 `u.hostname`。**
   hostname 丢端口，`http://127.0.0.1:11435` 授权后依然连不上。

5. **headless Chrome 不渲染侧边栏。** 用 CDP target 列表检测面板可见性会恒返回 false，
   是无效探针。这类只能真机人工确认。

### WXT / 构建

6. **`modules` 数组里不能写本地模块相对路径**（会相对 WXT 自身 dist 解析而报 Cannot find module）。
   用 config 内联 `hooks`。
7. **`modules: ['@wxt-dev/module-vue']` 必须字符串形式。** 传对象报 `Cannot find package '[object Object]'`。

### 测试

8. **`browser` 是 WXT 的自动导入全局，不是 `import` 进来的。**
   `vi.mock('wxt/browser')` **拦不住它**——必须挂到 `globalThis` 上。
   见 `tests/settings-migration.test.ts`。
9. **断言「配置」不等于断言「行为」。**
   旧测试断言 `getOptions({tabId}).enabled === false` 全绿，但用户实际看到面板仍展开。
   验证要断言**用户能观测到的结果**。

### 样式

10. **字号必须写成 `calc(Npx * var(--fs))`。**
    界面字号统一由 `--fs` 缩放（档位写在 `<html data-font>`）。
    漏写一处，那一处就不会跟着用户的字号设置变。
    `--lh` 是界面行高，`--lh-read` 是长文阅读区行高——**两者随字号的变化方向相反**，
    大字要略收比例，否则行距松得连不成段。
11. **`assets/theme.css` 的令牌块是平的。** 往 `:root` 里加令牌时，
    注意别把它们误插进后面的 `[data-font='…']` 档位块里——那会让该令牌只在某一档生效。

---

## 五、设置与存储

全部收口在 `lib/storage.ts`，**不要在别处直接碰 `chrome.storage`**。
任何写入都必须走 `saveSettings` / `patchSettings` 的读-改-写——
侧边栏曾把内存里的整份 settings 直接写回，面板初始化的几秒空窗里
设置页刚保存的内容被旧副本冲掉，「支持图像输入」开关丢失就是这个原因。

| 键 | 内容 | 说明 |
| --- | --- | --- |
| `settings.v1` | `Settings` | 唯一真相来源 |
| `notes.cache.v3` | 笔记缓存 | 限 30 个视频 |
| `chats.v2` | 聊天记录（多对话） | 限 30 视频 × 20 对话 × 60 轮，**只存文本**；旧 `chats.v1` 读取时整体迁移成 v2 后清掉 |
| `obsidianDir` | 目录句柄 | `lib/export.ts` |
| `panelOpenedTabs` | 点过图标的 tab | `storage.session`，见 background |

### 加字段 / 改结构时

**迁移必须写在 `lib/storage.ts` 的 `mergeSettings()` 里，不能只写在设置页。**
侧边栏同样调 `loadSettings()`——只迁一处的话，用户没打开过设置页时侧边栏会读到空配置。

迁移是**一次性且不可重来**的：漏了就是用户的密钥凭空消失，而他们只会看到「未配置」。
改这里必须补 `tests/settings-migration.test.ts`。

现状：`Settings.llm` 已换成 `profiles: LlmProfile[]` + `activeProfileId`（多配置），
旧结构由 `mergeSettings` 自动迁移。`LlmProfile extends LlmConfig`，
所以 `streamChat(cfg, …)` 可以直接吃一个 profile。

### 图片不落盘

聊天粘贴的图片只在内存里，重载后显示「已不再保留」占位。
`chrome.storage.local` 配额约 10MB，而聊天要存 30 个视频，base64 入盘必然爆配额。
要持久化必须加 `unlimitedStorage` 权限或做淘汰策略——**先跟用户确认**。
模型的思考过程（`reasoning_content`）同理：解析并折叠展示，但不落盘。

---

## 六、提示词

`lib/llm.ts` 里两份，用途严格分开：

| 常量 | 用途 | 谁用 |
| --- | --- | --- |
| `NOTE_SYSTEM` | 目录（生成笔记） | `buildNoteMessages` |
| `CHAT_SYSTEM` | 聊天（多轮追问） | `buildChatMessages` |

改完用 `pnpm prompt note` / `pnpm prompt chat` **导出真实提示词确认**，
不要凭记忆复述。两份共用 `COMMON_RULES`（时间戳不得编造等底线）。

聊天回答的篇幅问题踩过坑：只写「宁可长一点」模型会忽略，
必须给**可执行的判断标准**（「如果这段回答拿去替换原视频，读者能不能得到同样的信息」）。

---

## 七、验证的尺度

用户明确反对过度设计重型测试。每次加检查前先问：

> **「如果这项检查失败，会改变我的决定吗？」** 不会就别跑。

- 逻辑/数据层（SSE 分块、WBI 签名、markdown 转义、迁移）→ 值得写单测
- 样式与交互 → 优先用 `pnpm shot` 的**客观断言**（算出来的 px、`scrollWidth`），
  而不是「截图看起来对」
- 真机观感（侧边栏渲染、深色模式）→ 人工确认，别造无效探针

`pnpm check` 全绿 ≠ 功能可用。交付时要**如实说明哪些没有验证**。

---

## 八、和这位用户协作

1. **先给结论，再说理由。** 不要开场铺垫一堆探查过程。
2. **他不想做选择题。** 给方案，别给「你要 A 还是 B」。
3. **他讨厌 looping。** 想到就立刻发工具调用，不要在脑内反复排练。
4. **全程中文。** 注释、文档、回复都用中文；标识符、命令、路径保持英文。
5. **改动范围与请求相称。** 不要顺手重构无关部分。
6. 注释要写**为什么**（取舍、踩过的坑），不要复述代码在做什么。

---

## 九、目录速查

```
entrypoints/
  background.ts         Service Worker：仅轻量协调
  bridge.content.ts     【MAIN world】同源调 B站 API + WBI 签名
  relay.content.ts      【ISOLATED】双向中继
  sidepanel/            侧边栏 UI（承载 LLM 调用）
  options/              设置页 UI
lib/
  wbi.ts                WBI 签名 + 自实现 MD5（无依赖）
  bilibili.ts           B站接口客户端
  llm.ts                流式客户端 + SSE 解析器 + 提示词
  image.ts              粘贴图片的降采样与编码
  fontScale.ts          字号档位
  markdown.ts           自写渲染器（先转义再生成标签，防 XSS）
  export.ts             下载 / 直写 Obsidian
  storage.ts            设置持久化 + 迁移 + 运行时域名授权
  types.ts              领域模型 + 类型化消息协议
components/             Vue 组件
composables/useReader.ts  面板逻辑中枢（笔记与聊天共享素材）
tests/                  单元测试
scripts/                图标生成 + 验证/截图脚本
assets/theme.css        设计令牌（颜色、字号、导轨）
```
