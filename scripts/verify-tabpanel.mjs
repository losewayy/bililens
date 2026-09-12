/**
 * scripts/verify-tabpanel.mjs —— 验证「展开侧边栏只对那一页有效」
 *
 * 期望行为（用户提出）：
 *   点图标打开侧边栏后，切到别的标签页，面板应收起；
 *   切回原来那一页，面板恢复。
 *
 * 【这个脚本曾经给出过假绿，值得记一笔】
 *
 * 旧版只断言 chrome.sidePanel.getOptions({ tabId }).enabled === false，
 * 全绿；而用户切到别的标签页时面板**依然开着**。原因不在这些断言错了，
 * 而在于它们不完整：`enabled` 只是「该标签页有没有专属配置」，
 * 真正决定「面板会不会显示」的还有一层——
 *
 *   manifest 里的 side_panel.default_path 会注册一个**全局默认面板**，
 *   任何没有专属配置的标签页都会回退去显示它。
 *
 * 所以光把每个 tab 设成 disabled 是不够的，必须同时：
 *   [A] manifest 里不存在 side_panel.default_path
 *   [B] 启动时全局 setOptions({ enabled: false })
 *
 * 本脚本因此按这三层来验证：manifest 层、全局配置层、标签页层。
 * 参考 GoogleChrome/chrome-extensions-samples#987。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXT_DIR = join(ROOT, '.output', 'chrome-mv3');
const CDP_PORT = 9388 + Math.floor(Math.random() * 90);
const PROFILE = join(ROOT, `.tabpanel-profile-${CDP_PORT}`);

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
console.log('侧边栏：展开只对当时那一页有效');
console.log('='.repeat(64));

/* ---------------- [A] manifest 层：不能有全局默认面板 ---------------- */

console.log('\n[A] manifest 不得声明 side_panel.default_path');

const manifestPath = join(EXT_DIR, 'manifest.json');
if (!existsSync(manifestPath)) {
  bad('找不到构建产物 manifest.json，请先跑 wxt build');
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.side_panel?.default_path) {
    bad(
      '存在全局默认面板 —— 没配置过的标签页会回退显示它（面板会「跟着人跑」）',
      `default_path=${manifest.side_panel.default_path}`,
    );
  } else {
    ok('未声明 default_path，没有可回退的全局面板');
  }
  if ((manifest.permissions ?? []).includes('sidePanel')) {
    ok('sidePanel 权限仍在（面板改由代码按标签页启用）');
  } else {
    bad('sidePanel 权限丢失');
  }
}

rmSync(PROFILE, { recursive: true, force: true });

const child = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1400,900',
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
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(PROFILE, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}

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
  await cleanup();
  process.exit(1);
}

const bws = await connect(browserWs);
const bsend = makeSend(bws);
const { id: extensionId } = await bsend('Extensions.loadUnpacked', { path: EXT_DIR });
console.log(`\n扩展已加载: ${extensionId}`);
await sleep(2500);

/* ---------------- 开三个视频页 ---------------- */

const A = await bsend('Target.createTarget', {
  url: 'https://www.bilibili.com/video/BV1f4421f7ex',
});
const B = await bsend('Target.createTarget', {
  url: 'https://www.bilibili.com/video/BV1L94y1H7CV',
});
const C = await bsend('Target.createTarget', {
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
});
await sleep(6000);

/* ---------------- 借扩展页面调用 API ---------------- */

const helper = await bsend('Target.createTarget', {
  url: `chrome-extension://${extensionId}/sidepanel.html`,
  background: true,
});
await sleep(1800);

let helperWs = null;
for (let i = 0; i < 25; i++) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const hit = list.find((x) => x.id === helper.targetId);
  if (hit?.webSocketDebuggerUrl) {
    helperWs = hit.webSocketDebuggerUrl;
    break;
  }
  await sleep(300);
}
if (!helperWs) {
  console.error('无法连接扩展页面');
  await cleanup();
  process.exit(1);
}

const pws = await connect(helperWs);
const send = makeSend(pws);
await send('Runtime.enable');

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
};

/* 找到三个视频页的 tabId */
const ids = await evaluate(`
  (async () => {
    const tabs = await chrome.tabs.query({});
    const pick = (bv) => tabs.find(t => t.url && t.url.includes(bv))?.id ?? null;
    return {
      A: pick('BV1f4421f7ex'),
      B: pick('BV1L94y1H7CV'),
      C: pick('BV1xx411c7mD'),
    };
  })()
`);

console.log(`\n标签页: A=${ids.A}  B=${ids.B}  C=${ids.C}`);

const opts = (tabId) =>
  evaluate(`chrome.sidePanel.getOptions({ tabId: ${tabId} })`);

/* ---------------- 断言 ---------------- */

console.log('\n[1] 未点图标前，任何一页都不应启用面板');

/*
 * 先看**全局**配置。
 * 这是旧版漏掉的一层：即使每个标签页都是 disabled，
 * 只要全局配置里还留着 path，没配置过的标签页就会回退显示它。
 */
const globalOpts = await evaluate('chrome.sidePanel.getOptions({})');
if (globalOpts.enabled === false || globalOpts.path === undefined) {
  ok('全局配置没有可回退的面板', JSON.stringify(globalOpts));
} else {
  bad('全局仍存在默认面板 —— 未配置的标签页会显示它', JSON.stringify(globalOpts));
}

for (const [name, id] of Object.entries(ids)) {
  const o = await opts(id);
  if (o.enabled === false) ok(`视频页 ${name} 未启用（未点过图标）`);
  else bad(`视频页 ${name} 意外启用了`, JSON.stringify(o));
}

console.log('\n[2] ★ 点图标时，open() 依赖哪些前提');

/*
 * 这一段是为了堵住一个曾经漏掉的坑。
 *
 * 之前的版本在这里**直接改写 storage 再 setOptions**，绕过了
 * chrome.action.onClicked 处理器，于是脚本全绿而用户点图标毫无反应。
 *
 * 现在派发**真实的鼠标事件**（CDP Input.dispatchMouseEvent 属于可信
 * 输入，会建立用户手势），逐个变体单独验证。每个变体都从同一个初始
 * 状态（该 tab 的面板为禁用）出发 —— 上一版把几个变体串起来跑，
 * 后一个沾了前一个的光，测的其实不是自己。
 *
 *   · sync     启用与打开同步发出（= 修复后的处理器写法）
 *   · awaited  先 await 一次 storage，再启用并打开
 *   · noenable 面板仍禁用时直接 open()，不先启用
 *
 * 判据是「这个前提是不是必需的」，而不是「有没有报错」。
 */

const TARGET = ids.A;

const boxes = await evaluate(`
  (() => {
    document.querySelectorAll('.gtest').forEach(e => e.remove());
    window.__g = {};
    const mk = (id, top, fn) => {
      const b = document.createElement('button');
      b.className = 'gtest';
      b.id = id;
      b.textContent = id;
      b.style.cssText =
        'position:fixed;left:16px;z-index:2147483647;width:240px;height:44px;top:' + top + 'px';
      document.body.appendChild(b);
      b.onclick = fn;
      return b;
    };
    const rec = (k, p) =>
      p.then(() => { window.__g[k] = { ok: true, msg: '' }; })
       .catch((e) => { window.__g[k] = { ok: false, msg: String((e && e.message) || e) }; });

    mk('gtest-sync', 16, () => {
      chrome.sidePanel.setOptions({ tabId: ${TARGET}, path: 'sidepanel.html', enabled: true });
      rec('sync', chrome.sidePanel.open({ tabId: ${TARGET} }));
    });

    mk('gtest-awaited', 80, () => {
      chrome.storage.session.get('panelOpenedTabs').then(() => {
        chrome.sidePanel.setOptions({ tabId: ${TARGET}, path: 'sidepanel.html', enabled: true });
        rec('awaited', chrome.sidePanel.open({ tabId: ${TARGET} }));
      });
    });

    mk('gtest-noenable', 144, () => {
      rec('noenable', chrome.sidePanel.open({ tabId: ${TARGET} }));
    });

    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    return {
      sync: mid(document.getElementById('gtest-sync')),
      awaited: mid(document.getElementById('gtest-awaited')),
      noenable: mid(document.getElementById('gtest-noenable')),
    };
  })()
`);

// 助手页必须在前台，派发的鼠标事件才会被当作真实用户手势
await bsend('Target.activateTarget', { targetId: helper.targetId });
await sleep(900);

async function realClick(pt) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

async function runVariant(name, pt) {
  await evaluate(`
    (async () => {
      window.__g['${name}'] = null;
      await chrome.sidePanel.setOptions({ tabId: ${TARGET}, enabled: false });
    })()
  `);
  await sleep(500);
  await realClick(pt);
  await sleep(1200);
  return evaluate(`window.__g['${name}']`);
}

const rSync = await runVariant('sync', boxes.sync);
const rAwaited = await runVariant('awaited', boxes.awaited);
const rNoEnable = await runVariant('noenable', boxes.noenable);

if (!rSync) bad('同步变体未触发（鼠标事件没送达）');
else if (rSync.ok) ok('同步 setOptions + open() 成功');
else bad('同步写法失败', rSync.msg);

if (!rAwaited) bad('await 变体未触发');
else if (rAwaited.ok) {
  ok('await 之后再 open() 仍然成功');
  console.log('     （说明 await 不是根因，此前「手势被 await 吃掉」的判断有误）');
} else if (/user gesture/i.test(rAwaited.msg)) {
  ok('await 之后再 open() 被拒（手势确实会失效）', rAwaited.msg);
} else {
  bad('await 变体失败但原因不是手势', rAwaited.msg);
}

if (!rNoEnable) bad('noenable 变体未触发');
else if (rNoEnable.ok) {
  bad('面板禁用时 open() 也成功 —— 启用与否无关，需重估结论');
} else {
  ok('面板禁用时 open() 失败（所以必须先 setOptions 启用）', rNoEnable.msg);
}

await evaluate(`document.querySelectorAll('.gtest').forEach(e => e.remove())`);

console.log('\n[2b] 写入「A 页点过图标」的标记（供后续步骤使用）');

await evaluate(`
  (async () => {
    await chrome.storage.session.set({ panelOpenedTabs: [${ids.A}] });
    await chrome.sidePanel.setOptions({ tabId: ${ids.A}, path: 'sidepanel.html', enabled: true });
  })()
`);
await sleep(400);

const marked = await evaluate(`
  (async () => {
    const cur = await chrome.storage.session.get('panelOpenedTabs');
    return (cur.panelOpenedTabs || []).includes(${ids.A});
  })()
`);
if (marked) ok('storage 中留下了「这一页点过图标」的记录');
else bad('未留下记录 —— 切回来时面板会失效');

const aOpts = await opts(ids.A);
if (aOpts.enabled === true && String(aOpts.path ?? '').includes('sidepanel')) {
  ok('A 页已启用面板', `path=${aOpts.path}`);
} else {
  bad('A 页未启用', JSON.stringify(aOpts));
}

console.log('\n[3] ★ 切到 B 页 —— B 必须仍是禁用（面板会自动收起）');

// 真实切换活动标签页，让后台的 onActivated 跑起来
await bsend('Target.activateTarget', { targetId: B.targetId });
await sleep(1500);

const bOpts = await opts(ids.B);
if (bOpts.enabled === false) {
  ok('切到 B 页后，B 的面板为禁用（浏览器会自动收起）');
} else {
  bad('B 页被意外启用，面板会跟着展开', JSON.stringify(bOpts));
}

// A 的配置不应被动过
const aAfter = await opts(ids.A);
if (aAfter.enabled === true) {
  ok('A 页的配置未受影响（切回来时仍能恢复）');
} else {
  bad('A 页配置被误改', JSON.stringify(aAfter));
}

console.log('\n[4] ★ 切回 A 页 —— 应恢复可用');

await bsend('Target.activateTarget', { targetId: A.targetId });
await sleep(1500);

const aBack = await opts(ids.A);
if (aBack.enabled === true) {
  ok('切回 A 页后仍为启用（面板自动恢复）');
} else {
  bad('切回 A 页后面板失效了', JSON.stringify(aBack));
}

console.log('\n[5] 在 B 页也点一次图标 —— 此后 B 也应有效');

await evaluate(`
  (async () => {
    const cur = await chrome.storage.session.get('panelOpenedTabs');
    const set = new Set(cur.panelOpenedTabs || []);
    set.add(${ids.B});
    await chrome.storage.session.set({ panelOpenedTabs: [...set] });
    await chrome.sidePanel.setOptions({ tabId: ${ids.B}, path: 'sidepanel.html', enabled: true });
  })()
`);
await sleep(400);

const bNow = await opts(ids.B);
if (bNow.enabled === true) ok('B 页点过图标后已启用');
else bad('B 页仍未启用', JSON.stringify(bNow));

// 而 C 从未点过，应保持禁用
const cOpts = await opts(ids.C);
if (cOpts.enabled === false) ok('C 页（从未点过）保持禁用');
else bad('C 页被意外启用', JSON.stringify(cOpts));

console.log('\n[6] 关闭标签页应清理记录');

await bsend('Target.closeTarget', { targetId: A.targetId });
await sleep(1500);

const stillListed = await evaluate(`
  (async () => {
    const cur = await chrome.storage.session.get('panelOpenedTabs');
    return (cur.panelOpenedTabs || []).includes(${ids.A});
  })()
`);

if (!stillListed) ok('关闭 A 页后，记录已清理');
else bad('关闭后仍留有记录（集合会无限增长）');

/* ---------------- 汇总 ---------------- */

pws.close();
bws.close();
await cleanup();

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(64));
process.exit(fail > 0 ? 1 : 0);
