/**
 * scripts/verify-theme.mjs —— 验证选项页在深色模式下确实是深色
 *
 * 【为什么需要这个脚本】
 *
 * 曾经 entrypoints/options/style.css 里写的是：
 *     background: var(--bl-bg-subtle);
 * 而 theme.css 里的令牌其实叫 --paper。CSS 里 var() 引用未定义的变量
 * **不会报错**，只会让整条声明在计算时失效并回落到初始值
 * （background 的初始值是 transparent），于是深色模式下页面依旧白底。
 *
 * 这类错误的麻烦之处在于：构建通过、类型检查通过、浅色模式下看起来
 * 完全正常。只有真正在深色模式下**读一次计算样式**才会暴露。
 *
 * 因此这里做两件事：
 *   [A] 静态扫描：找出所有 var(--x) 里 --x 并未在 theme.css 声明的情况。
 *       不需要浏览器，跑得很快，是这类拼写错误的第一道闸。
 *   [B] 实机验证：把 prefers-color-scheme 模拟成 dark，读 body 的
 *       computed backgroundColor，确认它是不透明的深色，而不是
 *       transparent（说明声明失效）或白色（说明令牌取错值）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const EXT_DIR = join(ROOT, '.output', 'chrome-mv3');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (n, e = '') => {
  pass++;
  console.log(`  \u2713 ${n}${e ? '  ' + e : ''}`);
};
const bad = (n, e = '') => {
  fail++;
  console.log(`  \u2717 ${n}${e ? '  ' + e : ''}`);
};

console.log('='.repeat(64));
console.log('主题：选项页在深色模式下不能是白底');
console.log('='.repeat(64));

/* ================= [A] 静态扫描未定义的 CSS 令牌 ================= */

console.log('\n[A] 静态扫描 var() 引用的令牌');

const themePath = join(ROOT, 'assets', 'theme.css');
if (!existsSync(themePath)) {
  bad('找不到 assets/theme.css');
} else {
  const theme = readFileSync(themePath, 'utf8');
  const defined = new Set(
    [...theme.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
  );

  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.output' || name === '.wxt') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (/\.(css|vue)$/.test(name)) out.push(p);
    }
    return out;
  };

  const files = walk(ROOT);
  const offenders = new Map();

  /**
   * 扫描前先去掉注释。
   * 这个 bug 的修复说明本身就写在 style.css 的注释里，若不去注释，
   * 扫描会把「注释中提到的旧令牌名」当成真的引用，永远报红。
   *
   * 行注释只认「前面是空白或行首」的 //，这样 https:// 不会被误伤。
   */
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

  for (const f of files) {
    const txt = stripComments(readFileSync(f, 'utf8'));
    for (const m of txt.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!defined.has(m[1])) {
        const rel = f.slice(ROOT.length + 1);
        if (!offenders.has(m[1])) offenders.set(m[1], new Set());
        offenders.get(m[1]).add(rel);
      }
    }
  }

  if (offenders.size === 0) {
    ok(`所有 var() 引用都已声明`, `${files.length} 个文件，${defined.size} 个令牌`);
  } else {
    for (const [tok, where] of offenders) {
      bad(`未定义的令牌 ${tok}`, [...where].join(', '));
    }
  }
}

/* ================= [B] 实机读取计算样式 ================= */

console.log('\n[B] 实机：模拟深色模式后读 body 的计算背景');

const PORT = 9400 + Math.floor(Math.random() * 80);
const profile = mkdtempSync(join(tmpdir(), 'bililens-theme-'));

const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

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
      }, 30000);
    });
  };
}

async function cleanup() {
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(700);
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(400);
    }
  }
}

let browserWs = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      browserWs = (await r.json()).webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 未就绪 */
  }
}

if (!browserWs) {
  bad('浏览器未就绪，实机部分跳过');
  await cleanup();
  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
}

const bws = await connect(browserWs);
const bsend = makeSend(bws);
const { id: extensionId } = await bsend('Extensions.loadUnpacked', { path: EXT_DIR });
await sleep(2000);

const target = await bsend('Target.createTarget', {
  url: `chrome-extension://${extensionId}/options.html`,
});
await sleep(2500);

let pageWs = null;
for (let i = 0; i < 25; i++) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const hit = list.find((x) => x.id === target.targetId);
  if (hit?.webSocketDebuggerUrl) {
    pageWs = hit.webSocketDebuggerUrl;
    break;
  }
  await sleep(300);
}

if (!pageWs) {
  bad('无法连接选项页');
  await cleanup();
  process.exit(1);
}

const pws = await connect(pageWs);
const send = makeSend(pws);
await send('Runtime.enable');

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

/** 读 body 与根元素的背景，并解析成 RGB + alpha */
const probe = `
  (() => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    const lum = (c) => (c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : null);
    return {
      body, html,
      bodyLum: lum(body),
      paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
      scheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    };
  })()
`;

async function readWithScheme(scheme) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await sleep(600);
  return evaluate(probe);
}

const light = await readWithScheme('light');
const dark = await readWithScheme('dark');

console.log(`    浅色：scheme=${light.scheme} --paper=${light.paper} bg=${JSON.stringify(light.body)}`);
console.log(`    深色：scheme=${dark.scheme} --paper=${dark.paper} bg=${JSON.stringify(dark.body)}`);

if (dark.scheme !== 'dark') {
  bad('模拟未生效，页面仍认为是浅色，本次结论无效');
} else {
  ok('已模拟 prefers-color-scheme: dark');
}

// 关键断言：深色下 body 必须有不透明的背景，且明显比浅色暗
if (!dark.body) {
  bad('深色下 body 背景无法解析');
} else if (dark.body.a === 0) {
  bad('深色下 body 背景是透明的 —— 说明 background 声明失效了',
      `bg=${JSON.stringify(dark.body)}`);
} else if (dark.bodyLum >= light.bodyLum) {
  bad('深色下 body 背景并不比浅色暗',
      `dark=${dark.bodyLum.toFixed(1)} light=${light.bodyLum.toFixed(1)}`);
} else if (dark.bodyLum > 128) {
  bad('深色下 body 背景仍偏亮（像白底）', `lum=${dark.bodyLum.toFixed(1)}`);
} else {
  ok('深色下 body 是不透明的深色背景', `lum=${dark.bodyLum.toFixed(1)}`);
}

// 令牌本身也要取到深色值
if (dark.paper && dark.paper !== light.paper) {
  ok('--paper 在深色下取到了不同的值', `${light.paper} → ${dark.paper}`);
} else {
  bad('--paper 在深色下没有变化', `${light.paper} → ${dark.paper}`);
}

pws.close();
bws.close();
await cleanup();

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(64));
process.exit(fail > 0 ? 1 : 0);
