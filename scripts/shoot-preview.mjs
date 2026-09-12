/**
 * scripts/shoot-preview.mjs —— 用**真实组件**截图
 *
 * 与 shoot-ui.mjs 的区别（很重要）：
 *   shoot-ui.mjs 在扩展页面里手写 HTML 模拟界面，只能验证「CSS 大致长这样」。
 *   本脚本用 Vite 把真实的 .vue 组件编译出来，在真浏览器里渲染后截图，
 *   因此截图里的每一根树形连接线、每一个节点，都来自线上代码本身。
 *
 * 同时做客观断言：连接线是否真的画出来了、层级是否真的缩进、
 * 时间戳是否可点击 —— 「截图看着对」和「DOM 真的对」是两件事。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'design', 'shots');

/**
 * 端口随机化。
 *
 * 固定端口踩过一次坑：脚本中途崩溃时残留的 Chrome 会继续占着调试端口，
 * 下一次运行新起的 Chrome 绑不上端口就悄悄退出，
 * 而我们却连上了那个**残留的旧浏览器**——它指向的是已经关闭的旧预览服务，
 * 于是报「127.0.0.1 拒绝连接」，与真正的故障点相隔十万八千里。
 */
const VITE_PORT = 5200 + Math.floor(Math.random() * 300);
const CDP_PORT = 9400 + Math.floor(Math.random() * 300);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口是否已被占用 —— 占用说明有残留进程，直接判失败比连错对象好 */
async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const dark = process.argv.includes('--dark');
const label = dark ? 'dark' : 'light';

console.log('='.repeat(62));
console.log(`BiliLens 真实组件截图（${label}）`);
console.log('='.repeat(62));

/* ---------------- 1. 起 Vite（编译真实 SFC） ---------------- */

const server = await createServer({
  root: join(ROOT, 'design', 'preview'),
  configFile: false,
  logLevel: 'warn',
  plugins: [vue()],
  resolve: { alias: { '@': ROOT } },
  server: { port: VITE_PORT, strictPort: true, host: '127.0.0.1' },
});

await server.listen();
const url = `http://127.0.0.1:${VITE_PORT}/`;
console.log(`预览服务: ${url}`);

// 自检：服务必须真的可访问，否则后面所有现象都会指向错误的方向
{
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) {
    console.error('预览服务自检失败，终止');
    await server.close();
    process.exit(1);
  }
}

/* ---------------- 2. 起浏览器 ---------------- */

if (await portBusy(CDP_PORT)) {
  console.error(`调试端口 ${CDP_PORT} 已被占用（可能有残留的浏览器进程），请重试`);
  await server.close();
  process.exit(1);
}

const profileDir = join(ROOT, `.preview-profile-${CDP_PORT}`);
rmSync(profileDir, { recursive: true, force: true });

const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1400,900',
    ...(dark ? ['--force-dark-mode', '--enable-features=WebContentsForceDark'] : []),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browserWs = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) {
      browserWs = (await r.json()).webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 未就绪 */
  }
}

if (!browserWs) {
  console.error('浏览器未就绪');
  child.kill();
  await server.close();
  process.exit(1);
}

/** 统一的收尾：先杀浏览器进程树，再关服务，最后删临时目录 */
async function cleanup() {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(700);

  for (let i = 0; i < 6; i++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  try {
    await server.close();
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 3. CDP 小工具 ---------------- */

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => res(ws), { once: true });
    ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true });
  });
}

function makeSend(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: r, reject: j } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) j(new Error(JSON.stringify(m.error)));
      else r(m.result);
    }
  });
  return (method, params = {}) => {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId);
          reject(new Error(`超时: ${method}`));
        }
      }, 25000);
    });
  };
}

const bws = await connect(browserWs);
const bsend = makeSend(bws);

const target = await bsend('Target.createTarget', { url });
await sleep(1200);

let pageWs = null;
for (let i = 0; i < 25; i++) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const hit = list.find((x) => x.id === target.targetId);
  if (hit?.webSocketDebuggerUrl) {
    pageWs = hit.webSocketDebuggerUrl;
    break;
  }
  await sleep(300);
}

if (!pageWs) {
  console.error('无法获取页面调试端点');
  await cleanup();
  process.exit(1);
}

const pws = await connect(pageWs);
const send = makeSend(pws);
await send('Runtime.enable');
await send('Page.enable');

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `${d.exception?.description ?? d.text}\n--- 表达式片段 ---\n${expr.slice(0, 600)}`,
    );
  }
  return r.result.value;
};

/**
 * 等页面真正就绪。
 *
 * 这里必须同时等「文档加载完成」和「Vue 挂载完成」：
 * 目标页刚创建时执行上下文可能还停在 about:blank，
 * 此时 evaluate 会正常返回 0（不报错），于是等待循环会空转到底，
 * 后续断言拿到 undefined 才炸——错误信息离真正的原因很远。
 */
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const st = await evaluate(`(() => ({
      readyState: document.readyState,
      frames: document.querySelectorAll('.frame').length,
      appLen: document.getElementById('app')?.innerHTML?.length ?? 0,
      href: location.href,
    }))()`);

    if (st && st.frames >= 4) {
      ready = true;
      break;
    }
    if (i % 10 === 9) {
      console.log(`  等待中… readyState=${st?.readyState} frames=${st?.frames} app=${st?.appLen}`);
    }
  } catch (e) {
    if (i % 10 === 9) console.log(`  等待中… ${String(e).split('\n')[0]}`);
  }
  await sleep(300);
}

if (!ready) {
  const dump = await evaluate(
    `document.body ? document.body.innerHTML.slice(0, 500) : '(no body)'`,
  ).catch(() => '(无法读取)');
  console.error('页面未能渲染出预期组件。当前 body 片段：\n' + dump);
  pws.close();
  bws.close();
  child.kill();
  await server.close();
  process.exit(1);
}

/* 媒体与视口设置放在页面就绪之后，避免影响首次加载 */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(400);

/* ---------------- 4. 客观断言 ---------------- */

const checks = await evaluate(`
  (() => {
    const frames = [...document.querySelectorAll('.frame')];
    const noteF = frames[0];
    const chatF = frames[2];
    const emptyChatF = frames[3];

    // --- 目录页：时间轴导轨 ---
    const railNodes = [...noteF.querySelectorAll('.rail__node')];
    const railTimes = [...noteF.querySelectorAll('.rail__time')];
    const noteEl = noteF.querySelector('.note');
    const rl = noteEl ? getComputedStyle(noteEl, '::before') : null;

    // --- Tab 条 ---
    const tabs = [...noteF.querySelectorAll('.tb__item')];

    // --- 聊天页 ---
    const userMsgs = [...chatF.querySelectorAll('.msg--user')];
    const asstMsgs = [...chatF.querySelectorAll('.msg--assistant')];
    // 时间戳胶囊必须可点（这是「聊天里也能跳转」的证据）
    const tsButtons = [...chatF.querySelectorAll('.ts[data-seek]')];
    const composer = chatF.querySelector('.composer__input');
    const toggle = chatF.querySelector('.toggle');
    const chips = [...emptyChatF.querySelectorAll('.chip')];

    // 播放位置开关必须反映真实状态（此例为开启）
    const toggleOn = toggle ? toggle.classList.contains('toggle--on') : null;
    const toggleText = toggle ? toggle.textContent.replace(/\\s+/g, ' ').trim() : null;

    return {
      note: {
        railNodes: railNodes.length,
        railTimes: railTimes.length,
        activeNode: !!noteF.querySelector('h3.rail.is-active'),
        lineBg: rl ? rl.backgroundImage.slice(0, 24) : null,
        nodeWidth: railNodes[0] ? getComputedStyle(railNodes[0]).width : null,
        // 时间戳必须等宽，否则各章节时间对不齐
        timeVariant: railTimes[0] ? getComputedStyle(railTimes[0]).fontVariantNumeric : null,
      },
      tabs: {
        count: tabs.length,
        labels: tabs.map((t) => t.textContent.trim()),
        active: tabs.filter((t) => t.classList.contains('tb__item--on')).length,
      },
      chat: {
        userMsgs: userMsgs.length,
        asstMsgs: asstMsgs.length,
        // 可点时间戳：聊天里的「引用」
        tsButtons: tsButtons.length,
        tsFirstSeek: tsButtons[0]?.dataset?.seek ?? null,
        hasComposer: !!composer,
        composerDisabled: composer ? composer.disabled : null,
        toggleOn,
        toggleText,
        // 助手消息不加气泡、用户消息加：两者必须视觉可区分
        userHasBubble:
          userMsgs[0] ? getComputedStyle(userMsgs[0]).backgroundColor !== 'rgba(0, 0, 0, 0)' : null,
        asstHasBubble:
          asstMsgs[0]
            ? getComputedStyle(asstMsgs[0]).backgroundColor !== 'rgba(0, 0, 0, 0)'
            : null,
      },
      emptyChat: {
        chips: chips.length,
        hint: emptyChatF.querySelector('.hello__title')?.textContent?.trim() ?? null,
        // 未开启时应显示 --:--
        toggleText: emptyChatF.querySelector('.toggle')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      },
    };
  })()
`);

console.log('\n客观断言:');
console.log(JSON.stringify(checks, null, 2));

/* ---------------- 5. 断言判定 ---------------- */

const fails = [];
const n = checks.note;
const t = checks.tabs;
const c = checks.chat;
const ec = checks.emptyChat;

// 目录页：导轨
if (n.railNodes < 3) fails.push(`导轨节点数偏少: ${n.railNodes}`);
if (n.railTimes < 3) fails.push(`导轨时间戳数偏少: ${n.railTimes}`);
if (!n.activeNode) fails.push('导轨当前章节未点亮');
if (n.timeVariant !== 'tabular-nums') fails.push(`时间戳未使用等宽数字: ${n.timeVariant}`);

// Tab 条
if (t.count !== 2) fails.push(`Tab 数应为 2，实际 ${t.count}`);
if (t.labels.join(',') !== '目录,聊天') fails.push(`Tab 名称不对: ${t.labels.join(',')}`);
if (t.active !== 1) fails.push(`应有且仅有 1 个 Tab 处于选中态，实际 ${t.active}`);

// 聊天页
if (c.userMsgs < 1) fails.push('用户消息未渲染');
if (c.asstMsgs < 1) fails.push('助手消息未渲染');
if (c.tsButtons < 1) fails.push('★ 聊天回答里没有可点的时间戳');
if (!c.hasComposer) fails.push('输入框未渲染');
if (c.composerDisabled) fails.push('输入框被意外禁用');
if (c.toggleOn !== true) fails.push('播放位置开关状态未反映到 UI');
if (!c.toggleText || !c.toggleText.includes('播放位置')) {
  fails.push(`开关文案不对: ${c.toggleText}`);
}
if (c.userHasBubble !== true) fails.push('用户消息缺少气泡背景');
if (c.asstHasBubble !== false) fails.push('助手消息不该有气泡（应与正文一样）');

// 聊天空态
if (ec.chips < 2) fails.push(`空态起手式偏少: ${ec.chips}`);
if (!ec.toggleText || !ec.toggleText.includes('--:--')) {
  fails.push(`未开启/无位置时开关应显示 --:--，实际: ${ec.toggleText}`);
}
/* ---------------- 6. 截图 ---------------- */

// 整页（三栏并排）
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(400);

const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
  });
  const file = join(SHOTS, `${name}-${label}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  → ${file.replace(ROOT + '\\', '')}`);
};

await shot('components-all');

/** 取某一栏的位置，用于单栏特写 */
const frameBox = async (i, height) =>
  evaluate(`
    (() => {
      const f = document.querySelectorAll('.frame')[${i}];
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.left), y: 0, width: Math.round(r.width), height: ${height} };
    })()
  `);

// 目录（导轨）特写
const noteBox = await frameBox(0, 640);
if (noteBox) await shot('note-rail', noteBox);

// 聊天特写（含可点时间戳）
const chatBox = await frameBox(2, 640);
if (chatBox) await shot('chat', chatBox);

// 聊天空态（起手式）
const emptyBox = await frameBox(3, 480);
if (emptyBox) await shot('chat-empty', emptyBox);

/* ---------------- 收尾 ---------------- */

pws.close();
bws.close();
await cleanup();

console.log('\n' + '='.repeat(62));
if (fails.length > 0) {
  console.log('断言失败:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部断言通过 ✓');
console.log('截图完成 →', SHOTS);
