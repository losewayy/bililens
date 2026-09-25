# Chrome Web Store Listing — BiliLens

> Last Updated: 2026-09-18

## Store Listing

**Extension Name** [REQUIRED]
BiliLens — B站视频 AI 精读

**Short Description** [REQUIRED]
提取 B站视频官方总结与字幕，接入自定义大模型生成带时间戳的结构化笔记与互动问答。

**Detailed Description** [REQUIRED]
BiliLens 是一款专为 B站（bilibili.com）打造的视频 AI 精读扩展。在观看长视频、演讲、网课或播客时，一键提取视频官方 AI 总结或多轨字幕，利用你自己的大语言模型生成分层结构化笔记，并支持基于视频上下文进行深度问答。

主要功能：
• 结构化笔记生成：快速提炼视频要点、核心论点与关键细节，自动生成带时间戳的 Markdown 笔记。
• 播放联动与时间戳跳转：点击笔记或问答中的时间戳，播放器立即无缝跳转至对应视频时刻。
• 伴随式侧边栏（Side Panel）：采用 Chrome 原生侧边栏分屏体验，看视频、记笔记两不耽误。
• 上下文深度对话：边看边聊，支持针对视频内容细节追问，支持截取当前画面参与问答。
• 多模型自由接入：支持 DeepSeek、OpenAI、Claude、智谱 GLM、Moonshot Kimi、SiliconFlow、Ollama 及兼容 OpenAI 格式的任意自建端点。
• 本地离线语音识别（ASR）兜底：遇到无字幕无总结的视频时，支持联动本地离线 ASR 模型自动转写。
• 一键本地导出：笔记可一键导出为标准 Markdown，字幕可一键下载为 JSON。

使用方法：
1. 安装扩展后，进入选项设置页面，配置你常用的大模型 API Key 或本地端点。
2. 打开任意 B站视频播放页面（如 https://www.bilibili.com/video/BV...）。
3. 点击浏览器工具栏的 BiliLens 图标展开侧边栏。
4. 点击“生成精读笔记”或在聊天框中直接向视频提问。

隐私与安全承诺：
• 零数据收集：本扩展不包含任何数据埋点、统计探针或第三方追踪代码。
• 凭据本地保存：你的所有模型 API Key、视频笔记及对话历史均完全存储于本地浏览器（chrome.storage.local），绝不上载至任何中心化中转服务器。
• 免登录无需 Cookie：提取字幕与官方总结完全依赖当前播放页环境，不需要用户录入任何 B站账号 Cookie 或凭据。

免责声明：
BiliLens 为独立开源项目（GPL-3.0 / MIT），非哔哩哔哩（Bilibili）官方产品，与哔哩哔哩官方无任何关联或附属关系。

支持与反馈：
开源仓库与问题反馈：https://github.com/losewayy/bililens/issues

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
提取当前浏览的 B站视频字幕与官方总结内容，并结合用户自备的大语言模型在侧边栏生成结构化笔记与互动问答。

**Primary Language** [REQUIRED]
zh_CN (中文（简体）)

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename / Source |
|-------|-----------|--------|-------------------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `public/icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | 需截取：侧边栏笔记生成态与视频播放界面 |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | 需截取：侧边栏视频问答与时间戳联动态 |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | 需截取：模型配置与设置页面 |
| Small Promo Tile [RECOMMENDED] | 440×280 PNG | ⬜ Not created | 商店橱窗推荐图 |

---

## Permissions Justification

| Permission | Type | Justification (中文说明) | Justification for CWS Dashboard (English) |
|------------|------|-------------------------|-------------------------------------------|
| `storage` | permissions | 用于在用户本地浏览器安全保存大模型配置（API Key、模型名称）、视频笔记缓存及问答历史。 | Used to securely store user LLM provider configurations (API keys, model choices), cached video notes, and chat session history locally on the user device. |
| `sidePanel` | permissions | 提供伴随式侧边栏界面，让用户在观看视频的同时查看笔记和进行对话，不遮挡视频主画面。 | Provides a companion side-by-side reading and chat panel interface that does not obscure the primary video viewing experience. |
| `downloads` | permissions | 允许用户将生成的 Markdown 格式精读笔记或字幕文件直接导出下载到本地磁盘。 | Allows users to export and download generated Markdown reading notes and subtitle transcript files to their local disk. |
| `tabs` | permissions | 探测当前活动标签页的 URL，识别当前是否处于 B站视频播放页，以便动态激活专属侧边栏并同步元信息。 | Queries the active tab URL to detect if the user is currently browsing a Bilibili video page and synchronizes metadata with the sidepanel. |
| `scripting` | permissions | 向 B站视频页安全注入通信桥接脚本，用于读取当前播放进度及在用户点击时间戳时驱动视频跳转播放。 | Injects a lightweight bridge script into Bilibili video pages to inspect playback timestamp and seek video playback when user clicks timestamps. |
| `https://*.bilibili.com/*` | host_permissions | 访问视频详情页和 B站官方总结接口，提取视频基础元信息与官方 AI 提炼文本。 | Required to fetch public video details, episode metadata, and official summary endpoints on Bilibili. |
| `https://*.hdslb.com/*` | host_permissions | 下载存储在 B站官方 CDN（aisubtitle / i0.hdslb.com）上的音轨字幕文件。 | Required to fetch subtitle transcript files stored on Bilibili CDN servers (aisubtitle.hdslb.com). |
| `http://127.0.0.1/*` | host_permissions | 允许连接用户在本地机器部署的离线语音转写服务（ASR），提供无字幕视频的本地兜底转写。 | Allows connecting to an optional user-hosted local offline speech-to-text (ASR) service on localhost. |
| `http://localhost/*` | host_permissions | 同上，支持以 localhost 形式访问本地离线 ASR 转写服务。 | Allows connecting to an optional user-hosted local offline speech-to-text (ASR) service on localhost. |
| `https://*/*`, `http://*/*` | optional_host_permissions | 允许用户在设置中自定义任意第三方兼容 OpenAI 的 AI 提供商或私有部署 API，仅在用户配置并保存时按需动态向浏览器申请，默认不申请。 | Allows users to connect custom OpenAI-compatible LLM endpoints or self-hosted servers. Granted dynamically on demand only when the user configures such an endpoint. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No (不收集任何数据)

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | No | No | API Key 仅由用户自主输入，直接发送给用户配置的大模型服务商 | No |
| Personal communications | No | No | N/A | No |
| Location | No | No | N/A | No |
| Web history | No | No | 仅在本地判断当前页是否为 B站视频，不上传 | No |
| User activity | No | No | N/A | No |
| Website content | 仅本地处理 | 仅当用户发起总结时发送至用户指定的大模型端点 | 用于生成笔记与问答 | 仅用户自己指定的 AI 模型服务商 |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
`https://github.com/losewayy/bililens/blob/main/PRIVACY.md`

---

## Distribution

**Visibility**: Public (公开)
**Regions**: All regions (全球所有区域)

---

## Developer Info

**Publisher Name** [REQUIRED]
BiliLens Open Source Project

**Contact Email** [REQUIRED]
<!-- 请填写你在 Chrome Web Store 开发者后台注册的联络邮箱 -->

**Support URL** [RECOMMENDED]
https://github.com/losewayy/bililens/issues

**Homepage URL** [RECOMMENDED]
https://github.com/losewayy/bililens

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-09-18 | Initial release: Side panel AI reading notes, timestamps seeking, multi-LLM support, local ASR fallback. | Draft |
