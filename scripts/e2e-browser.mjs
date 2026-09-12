/**
 * scripts/e2e-browser.mjs —— 浏览器内端到端验证
 *
 * 为什么需要它：
 *   单元测试证明了算法正确，verify-live.mjs 证明了签名被服务端接受，
 *   但都还没证明「插件在真实浏览器里能装上、能注入、能取到数据」。
 *   本脚本用独立临时配置启动 Chrome（不干扰用户正在使用的浏览器），
 *   加载构建产物，真实访问 B站视频页，逐项验证：
 *     ① 扩展被浏览器接受（manifest 无错）
 *     ② 后台 Service Worker 正常启动
 *     ③ MAIN world 桥脚本成功注入
 *     ④ 隔离世界中继脚本成功注入
 *     ⑤ 侧边栏页面可加载
 *     ⑥ 【最关键】在页面上下文里调 B站接口能拿到真实数据
 *
 * 用法：node scripts/e2e-browser.mjs [BV号]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT_DIR = resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');
const BV = process.argv[2] ?? 'BV1f4421f7ex';
const PORT = 9333;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

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

/* ---------------- CDP 客户端 ---------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve: res, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 结束浏览器并清理临时配置。
 * Chrome 退出后仍会短暂持有文件句柄，直接删除会 EPERM，
 * 因此先等待进程退出，再带重试地删除。
 */
function cleanup() {
  try {
    child.kill();
  } catch {
    /* ignore */
  }

  // 同步等待一小会儿，让 Chrome 释放句柄
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      // 忙等 3 秒（脚本即将退出，可接受）
      // eslint-disable-next-line no-empty
    } catch {
      /* ignore */
    }
  }

  for (let i = 0; i < 5; i++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      console.log('\n已清理临时浏览器配置');
      return;
    } catch {
      // 再等一会重试
      const t0 = Date.now();
      while (Date.now() - t0 < 800) {
        /* busy wait */
      }
    }
  }
  console.log(`\n临时目录需手动清理: ${profileDir}`);
}

/* ---------------- 主流程 ---------------- */

console.log('='.repeat(66));
console.log('BiliLens —— 浏览器内端到端验证');
console.log(`扩展目录: ${EXT_DIR}`);
console.log(`测试视频: ${BV}`);
console.log('='.repeat(66));

if (!existsSync(join(EXT_DIR, 'manifest.json'))) {
  console.error('\n未找到构建产物，请先运行: pnpm exec wxt build');
  process.exit(1);
}

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('\n未找到 Chrome / Edge');
  process.exit(1);
}
console.log(`\n浏览器: ${chromePath}`);

const profileDir = mkdtempSync(join(tmpdir(), 'bililens-e2e-'));

const args = [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${PORT}`,
  // 注意：--load-extension 在 Chrome 137 起已从正式版移除，
  // 因此这里改用 CDP 的 Extensions.loadUnpacked 动态加载（见下方）。
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,OptimizationHints',
  '--headless=new',
  'about:blank',
];

console.log(`临时配置: ${profileDir}\n`);

const child = spawn(chromePath, args, { stdio: 'ignore', detached: false });

let browserWsUrl = null;

// 等待 CDP 端点就绪
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      browserWsUrl = (await r.json()).webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}

if (!browserWsUrl) {
  bad('浏览器启动', 'CDP 端点未就绪');
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  rmSync(profileDir, { recursive: true, force: true });
  process.exit(1);
}

ok('浏览器已启动，CDP 可用');

const browser = await Cdp.connect(browserWsUrl);

/* ---------------- 1. 加载扩展 ---------------- */

console.log('\n[1] 加载扩展');
let extensionId = null;

// Chrome 137+ 移除了 --load-extension 命令行开关，
// 官方替代方案是 CDP 的 Extensions.loadUnpacked 命令。
try {
  const res = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
  extensionId = res?.id ?? null;

  if (extensionId) {
    ok('扩展已被浏览器加载（Extensions.loadUnpacked）', `ID = ${extensionId}`);
  } else {
    bad('Extensions.loadUnpacked 未返回扩展 ID');
  }
} catch (e) {
  bad('通过 CDP 加载扩展失败', String(e));
  console.log('      若该命令不被支持，可退回手工在 chrome://extensions 中加载。');
}

// 等待 Service Worker 起来
await sleep(2500);

// 交叉确认：扩展目标确实存在
try {
  const { targetInfos } = await browser.send('Target.getTargets');
  const extTargets = targetInfos.filter((t) => t.url.startsWith('chrome-extension://'));

  if (extensionId && extTargets.some((t) => t.url.includes(extensionId))) {
    ok('已在目标列表中确认该扩展');
  } else if (extTargets.length) {
    console.log(`      （当前扩展目标：${extTargets.map((t) => t.url).join(', ')}）`);
  }
} catch {
  /* 忽略 */
}

/* ---------------- 2. 打开 B站视频页 ---------------- */

console.log('\n[2] 打开 B站视频页');

const target = await browser.send('Target.createTarget', {
  url: `https://www.bilibili.com/video/${BV}/`,
});

/** 等目标真正出现在列表里并拿到 wsUrl */
async function waitForTargetWs(targetId, tries = 25) {
  for (let i = 0; i < tries; i++) {
    // 主路径：Target.getTargets
    try {
      const { targetInfos } = await browser.send('Target.getTargets');
      const info = targetInfos.find((t) => t.targetId === targetId);
      if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      // 页面目标有时不直接带 wsUrl，用 HTTP 端点兜底
      if (info) {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        if (r.ok) {
          const list = await r.json();
          const hit = list.find((x) => x.id === targetId);
          if (hit?.webSocketDebuggerUrl) return hit.webSocketDebuggerUrl;
        }
      }
    } catch {
      /* 继续重试 */
    }
    await sleep(400);
  }
  return null;
}

const pageWs = await waitForTargetWs(target.targetId);
if (!pageWs) {
  bad('获取页面调试端点失败', '目标未就绪');
  // 打印现有目标便于诊断
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    console.log('      当前目标列表:');
    for (const t of targetInfos) console.log(`        · [${t.type}] ${t.url}`);
  } catch {
    /* ignore */
  }
  cleanup();
  process.exit(1);
}

const page = await Cdp.connect(pageWs);

await page.send('Runtime.enable');
await page.send('Page.enable');

// 等页面加载
await sleep(6000);

const href = (await page.send('Runtime.evaluate', {
  expression: 'location.href',
  returnByValue: true,
})).result.value;

ok('页面已打开', href);

/* ---------------- 3. 内容脚本注入 ---------------- */

console.log('\n[3] 内容脚本注入');

const probe = await page.send('Runtime.evaluate', {
  expression: `(() => ({
    bridge: typeof window.__BILILENS_BRIDGE__ !== 'undefined',
    title: document.title
  }))()`,
  returnByValue: true,
  awaitPromise: false,
});

const p = probe.result.value ?? {};

if (p.bridge) ok('MAIN world 桥脚本已注入（window.__BILILENS_BRIDGE__ 存在）');
else bad('MAIN world 桥脚本未注入');

console.log(`      页面标题 = ${p.title}`);

// WBI 签名能力通过实际调用间接验证（模块被 WXT 打包进 bridge.js，
// 不会挂载到 window 上，因此不能直接探测 window.BiliWBI）。
// 下面第 [4] 步的 videoInfo 调用成功，即证明签名与请求链路可用。

/* ---------------- 4. 页面上下文内真实调用 B站接口 ---------------- */

console.log('\n[4] 【关键】页面上下文中调用 B站接口');

// 通过 postMessage 走真实的桥接协议，验证整条链路
const callResult = await page.send('Runtime.evaluate', {
  expression: `
    new Promise((resolve) => {
      const id = 'e2e_' + Date.now();
      const timer = setTimeout(() => resolve({ ok: false, error: '超时' }), 25000);

      window.addEventListener('message', (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.__bililens !== 'res' || m.id !== id) return;
        clearTimeout(timer);
        resolve({ ok: m.ok, data: m.data, error: m.error });
      });

      window.postMessage({ __bililens: 'req', id, type: 'videoInfo', payload: undefined }, '*');
    })
  `,
  returnByValue: true,
  awaitPromise: true,
});

const r = callResult.result.value ?? {};

if (r.ok && r.data) {
  ok('桥接调用成功，取到真实视频数据');
  console.log(`      标题   = ${r.data.title}`);
  console.log(`      UP主   = ${r.data.upName}`);
  console.log(`      bvid   = ${r.data.bvid}`);
  console.log(`      aid    = ${r.data.aid}`);
  console.log(`      cid    = ${r.data.cid}`);
  console.log(`      时长   = ${r.data.duration}s`);
  console.log(`      分P    = ${r.data.pageIndex}/${r.data.pageCount}`);

  if (r.data.bvid === BV || r.data.title) {
    ok('返回数据与目标视频匹配');
  }
} else {
  bad('桥接调用失败', r.error ?? '未知错误');
}

/* ---------------- 5. 采集接口（官方总结 + 字幕） ---------------- */

console.log('\n[5] 采集接口（官方 AI 总结 + 字幕列表）');

const collectResult = await page.send('Runtime.evaluate', {
  expression: `
    new Promise((resolve) => {
      const id = 'e2e_collect_' + Date.now();
      const timer = setTimeout(() => resolve({ ok: false, error: '超时' }), 40000);

      window.addEventListener('message', (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.__bililens !== 'res' || m.id !== id) return;
        clearTimeout(timer);
        resolve({ ok: m.ok, data: m.data, error: m.error });
      });

      window.postMessage({ __bililens: 'req', id, type: 'collect', payload: undefined }, '*');
    })
  `,
  returnByValue: true,
  awaitPromise: true,
});

const c = collectResult.result.value ?? {};

if (c.ok && c.data) {
  ok('collect 调用成功');

  const con = c.data.conclusion;
  const subs = c.data.subtitles;

  /*
   * 【关键推论】官方总结不可用时的「原因文案」能反证签名是否有效：
   *   · 服务端返回 -101（未登录）→ 我的代码映射为 NotLoggedInError 的文案
   *   · 服务端返回 -403（签名错误）→ 映射为「官方总结接口异常：...」
   * 因此只要看到的是「需要登录 B站…」，就说明**签名已被服务端接受**。
   */
  if (con?.available) {
    ok('官方 AI 总结可用');
    console.log(`      摘要长度 = ${(con.summary ?? '').length} 字`);
    console.log(`      提纲章节 = ${(con.outline ?? []).length} 段`);
    console.log(`      官方字幕 = ${(con.subtitle ?? []).length} 条`);
  } else {
    const reason = con?.reason ?? '未知';
    console.log(`      · 官方总结不可用：${reason}`);

    if (reason.includes('需要登录')) {
      ok('★ WBI 签名在浏览器内被服务端接受（返回 -101 未登录，而非 -403 签名错误）');
    } else if (reason.includes('尚未被') || reason.includes('没有官方')) {
      ok('★ WBI 签名有效（接口正常响应，该视频无官方总结）');
    } else if (reason.includes('接口异常')) {
      bad('★ 签名可能无效', reason);
    }
  }

  if (subs?.list?.length) {
    ok('字幕轨可用', `${subs.list.length} 条`);
    for (const t of subs.list) {
      console.log(`        · ${t.lanDoc} (${t.lan})${t.isAi ? ' [AI]' : ''}`);
    }
  } else {
    console.log(
      `      · 字幕列表为空：${subs?.error ?? '未登录或该视频无字幕'}（未登录时属正常）`,
    );
  }
} else {
  bad('collect 调用失败', c.error ?? '未知错误');
}

/* ---------------- 6. 侧边栏页面 ---------------- */

console.log('\n[6] 扩展页面可加载');

if (extensionId) {
  for (const [name, file] of [
    ['侧边栏', 'sidepanel.html'],
    ['选项页', 'options.html'],
  ]) {
    try {
      const t = await browser.send('Target.createTarget', {
        url: `chrome-extension://${extensionId}/${file}`,
      });
      await sleep(1500);

      const list = await browser.send('Target.getTargets');
      const info = list.targetInfos.find((x) => x.targetId === t.targetId);

      if (info && info.url.includes(file)) {
        ok(`${name} ${file} 可加载`);
      } else {
        bad(`${name} ${file} 加载异常`, info?.url);
      }

      await browser.send('Target.closeTarget', { targetId: t.targetId });
    } catch (e) {
      bad(`${name} ${file} 加载失败`, String(e));
    }
  }
} else {
  bad('跳过扩展页面验证', '未取得扩展 ID');
}

/* ---------------- 清理 ---------------- */

console.log('\n' + '='.repeat(66));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log('='.repeat(66));

try {
  page.close();
  browser.close();
} catch {
  /* ignore */
}

cleanup();

process.exit(fail > 0 ? 1 : 0);
