/**
 * scripts/shoot-ui.mjs —— 给重构后的界面截图（设计验证）
 *
 * 设计不看图等于没做。本脚本用真实浏览器加载扩展，
 * 打开选项页与侧边栏，注入一段样例笔记，截图到 design/shots/。
 *
 * 同时做几项客观断言（控件是否渲染、logo 是否加载成功），
 * 因为「截图看起来对」和「DOM 真的对」是两件事。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXT_DIR = join(ROOT, '.output', 'chrome-mv3');
const SHOTS = join(ROOT, 'design', 'shots');
const PORT = 9337;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dark = process.argv.includes('--dark');
const label = dark ? 'dark' : 'light';

console.log('='.repeat(60));
console.log(`BiliLens 界面截图（${label}）`);
console.log('='.repeat(60));

const profileDir = mkdtempSync(join(tmpdir(), 'bililens-shot-'));

const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--force-device-scale-factor=2',
    '--window-size=1440,1000',
    // 强制配色方案，便于出浅色/深色两套图
    ...(dark ? ['--force-dark-mode', '--enable-features=WebContentsForceDark'] : []),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browserWs = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
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
  console.error('浏览器未就绪');
  child.kill();
  process.exit(1);
}

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
  return (method, params = {}, sessionId) => {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
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

let extensionId = null;
try {
  const r = await bsend('Extensions.loadUnpacked', { path: EXT_DIR });
  extensionId = r?.id ?? null;
  console.log(`扩展已加载: ${extensionId}`);
} catch (e) {
  console.error('扩展加载失败:', e.message);
  child.kill();
  process.exit(1);
}

await sleep(2200);

/** 页面会话：返回 { send, evaluate, screenshot, close } */
async function openPage(url) {
  const t = await bsend('Target.createTarget', { url });

  // 扩展页面有时只在 HTTP /json/list 里带 webSocketDebuggerUrl，
  // 因此两条路都试，并按 URL 兜底匹配。
  let wsUrl = null;
  for (let i = 0; i < 25; i++) {
    await sleep(350);

    try {
      const list = await bsend('Target.getTargets');
      const info = list.targetInfos.find((x) => x.targetId === t.targetId);
      if (info?.webSocketDebuggerUrl) {
        wsUrl = info.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 继续 */
    }

    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const list = await r.json();
        const hit =
          list.find((x) => x.id === t.targetId) ??
          list.find((x) => x.url === url) ??
          list.find((x) => x.url.includes(url.split('/').pop()));
        if (hit?.webSocketDebuggerUrl) {
          wsUrl = hit.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {
      /* 继续 */
    }
  }

  if (!wsUrl) throw new Error('无法获取页面调试端点: ' + url);

  const ws = await connect(wsUrl);
  const send = makeSend(ws);
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };

  const screenshot = async (name, opts = {}) => {
    let params = { format: 'png', captureBeyondViewport: true };

    if (opts.clip) {
      params = { ...params, clip: { ...opts.clip, scale: 2 } };
    }

    const r = await send('Page.captureScreenshot', params);
    const file = join(SHOTS, `${name}-${label}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  → ${file.replace(ROOT + '\\', '')}`);
    return file;
  };

  return { send, evaluate, screenshot, targetId: t.targetId, close: () => ws.close() };
}

/* ================================================================== *
 * 浅色/深色偏好注入
 * ================================================================== */

const emulation = {
  'prefers-color-scheme': dark ? 'dark' : 'light',
};

async function applyEmulation(send) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
}

/* ================================================================== *
 * 1. 选项页
 * ================================================================== */

console.log('\n[1] 选项页');
const opts = await openPage(`chrome-extension://${extensionId}/options.html`);
await applyEmulation(opts.send);

// 灌入一份示例配置，让界面处于"已配置"状态（否则看到的是空态）
await opts.evaluate(`
  (async () => {
    const profile = {
      id: 'demo-cloud',
      name: 'DeepSeek 云端',
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-demo-key-not-real-000000000000',
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 0,
      supportsVision: false
    };
    const s = {
      profiles: [
        profile,
        {
          id: 'demo-local',
          name: '本地网关',
          provider: 'custom',
          baseURL: 'http://127.0.0.1:11435/v1',
          apiKey: '',
          model: 'deepseek/deepseek-v4.1-flash',
          temperature: 0.3,
          maxTokens: 0,
          supportsVision: true
        }
      ],
      activeProfileId: profile.id,
      tab: 'note',
      sendPlayhead: false,
      saveMode: 'obsidian',
      obsidian: { enabled: true, subfolder: 'BiliLens', filenameTemplate: '{title}' },
      autoRun: false,
      language: 'zh'
    };
    await chrome.storage.local.set({ 'settings.v1': s });
    return true;
  })()
`);

// 重新加载以应用
await opts.send('Page.reload');
await sleep(2200);
await applyEmulation(opts.send);
await sleep(400);

// 客观断言：关键结构是否真的渲染
const checks = await opts.evaluate(`
  (() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];

    const imgs = qa('.card__logo img');
    return {
      providerCards: qa('.card').length,
      groups: qa('.group').length,
      logoImgs: imgs.length,
      // 图片是否真的加载成功（naturalWidth > 0）
      logosLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      logosFailed: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
      tocItems: qa('.toc__item').length,
      summaryCells: qa('.summary__cell').length,
      panes: qa('.pane').length,
      hasConn: !!q('.conn'),
      connClass: q('.conn') ? q('.conn').className : '',
      dirName: q('.dir__name') ? q('.dir__name').textContent.trim() : null,
      // 样式是否真的生效（scoped 是否命中）
      cardBorderRadius: q('.card') ? getComputedStyle(q('.card')).borderRadius : null,
      biliAccent: getComputedStyle(document.documentElement).getPropertyValue('--bili').trim(),

      // 底部保存栏必须不透明。
      // 它用 position:sticky 压在内容上，若背景带透明（曾用过渐变），
      // 滚动时下方表单会透出来，看起来像页面坏了。
      foot: (() => {
        const f = q('.foot');
        if (!f) return null;
        const cs = getComputedStyle(f);
        const fb = f.getBoundingClientRect();
        let maxOverlap = 0;
        for (const el of qa('.field, .card, input')) {
          const b = el.getBoundingClientRect();
          const ov = Math.min(b.bottom, fb.bottom) - Math.max(b.top, fb.top);
          if (ov > maxOverlap) maxOverlap = Math.round(ov);
        }
        return {
          bg: cs.backgroundColor,
          hasGradient: cs.backgroundImage !== 'none',
          overlapsContentPx: maxOverlap,
          // 背景必须铺满内容列，否则两侧会留透明缝
          spansColumn: (() => {
            const p = q('.page');
            if (!p) return null;
            const pb = p.getBoundingClientRect();
            return Math.abs(fb.left - pb.left) <= 1 && Math.abs(fb.right - pb.right) <= 1;
          })(),
        };
      })(),
    };
  })()
`);

// 底栏不透明性：这是真实踩过的坑，值得每次都看一眼
if (checks.foot) {
  const f = checks.foot;
  const opaque = !f.bg.includes('rgba') || f.bg.endsWith(', 1)');
  if (!opaque || f.hasGradient) {
    console.log(`  ✗ 底部保存栏背景不透明（bg=${f.bg} gradient=${f.hasGradient}）`);
    process.exitCode = 1;
  }
  if (f.overlapsContentPx > 0 && !opaque) {
    console.log(`  ✗ 底栏与内容重叠 ${f.overlapsContentPx}px 却是透明的（会漏底）`);
    process.exitCode = 1;
  }
  if (f.spansColumn === false) {
    console.log('  ✗ 底栏背景未铺满内容列（两侧会留透明缝）');
    process.exitCode = 1;
  }
}

console.log('  结构检查:', JSON.stringify(checks, null, 2).replace(/\n/g, '\n  '));

await opts.screenshot('options-full', { clip: null });
// 首屏
await opts.screenshot('options-top', { clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });

opts.close();
await bsend('Target.closeTarget', { targetId: opts.targetId });

/* ================================================================== *
 * 2. 侧边栏（注入样例笔记，展示时间轴导轨）
 * ================================================================== */

console.log('\n[2] 侧边栏（含时间轴导轨）');
const side = await openPage(`chrome-extension://${extensionId}/sidepanel.html`);
await applyEmulation(side.send);
await sleep(1800);

// 注入一段样例笔记，驱动导轨渲染
const SAMPLE = `## 📌 核心摘要

视频讨论如何用 AI 实现高效学习：把传统教学的多对多关系改成双向一对一，由 AI 作为聚合多来源的单一界面，内置验证与事实检查以建立信任。

## 🧭 章节笔记

### [0:01] 目标与结构

- 目标：找到用 AI 把学习效率优化到极致的做法
- 视频结构：先讲方法逻辑与系统设计，再做现场演示

### [1:42] 多来源学习的认知成本与信任成本

- 学生要适应很多教学风格、符号体系、可信度水平和界面
- 更深层代价是信任：面对不熟悉来源，大脑会本能观望

### [3:15] 一对一、聚合来源与工程化信任

- 反对意见：只有一个老师会只剩单一视角
- 回应：把来源和界面混为一谈；一位老师不减少来源数量，而是聚合所有来源

### [6:53] 现场演示：Obsidian 与 Claude 协作

- 演示用 Obsidian + Claude 3 Opus 学习微分形式
- 强调认知努力应集中在材料本身，而非后勤

## 🎯 关键 Take-away

- 最优教学路径：减少已掌握内容、避开暂时不能理解内容
- AI 当老师时，信任不是慢慢建立，而是工程化内置
`;

const injected = await side.evaluate(`
  (async () => {
    const md = ${JSON.stringify(SAMPLE)};

    // 侧边栏是 Vue 应用，直接改内部状态不可行。
    // 这里复用与组件一致的结构与 scoped 属性，验证导轨的布局契约。
    //
    // scoped 属性必须放对位置：编译产物形如
    //     .note[data-v-xxx] h3.rail      ← 属性在 .note 上，子元素靠 :deep() 命中
    //     .bar[data-v-yyy]               ← 每个组件有各自不同的 hash
    // 因此先从 CSS 里解析出「类名 → hash」映射，再逐个应用。
    // 属性放错 → 样式不命中 → 截图无效（这一步是设计验收的前提）。
    const scopeMap = (() => {
      const map = {};
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const r of rules) {
          const sel = r.selectorText || '';
          const re = /\\.([a-zA-Z][\\w-]*)\\[(data-v-[a-z0-9]+)\\]/g;
          let m;
          while ((m = re.exec(sel))) {
            const [, cls, hash] = m;
            // 同一个类可能出现在多个组件里，保留第一个即可
            if (!map[cls]) map[cls] = hash;
          }
        }
      }
      return map;
    })();

    const applyScopes = () => {
      for (const [cls, hash] of Object.entries(scopeMap)) {
        document.querySelectorAll('.' + cls).forEach(el => el.setAttribute(hash, ''));
      }
    };

    // 用与 lib/markdown.ts 相同的规则手工生成导轨 HTML，
    // 以便在没有模型/网络的情况下也能验证视觉。
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const fmt = (sec) => {
      const m = Math.floor(sec/60), s2 = sec%60;
      return m + ':' + String(s2).padStart(2,'0');
    };
    const sections = [...md.matchAll(/^### \\[(\\d+):(\\d\\d)\\] (.+)$/gm)]
      .map((m, i) => ({ id: 'sec-'+i, sec: +m[1]*60 + +m[2], raw: m[3] }));

    let n = 0;
    const body = md.replace(/^### \\[(\\d+):(\\d\\d)\\] (.+)$/gm, (_, mm, ss, title) => {
      const i = n++;
      const t = mm + ':' + ss;
      const sec = +mm*60 + +ss;
      return '<h3 class="rail" id="sec-'+i+'">'
        + '<button type="button" class="rail__node" data-seek="'+sec+'" aria-label="跳转到 '+t+'"></button>'
        + '<button type="button" class="rail__time tnum" data-seek="'+sec+'">'+t+'</button> '
        + esc(title) + '</h3>';
    })
    .replace(/^## (.+)$/gm, '<h2>'+'$1'.replace('$1','$1')+'</h2>')
    .replace(/^## (.+)$/gm, (_, t) => '<h2>'+esc(t)+'</h2>')
    .replace(/^- (.+)$/gm, (_, t) => '<li>'+esc(t)+'</li>')
    .replace(/(<li>.*<\\/li>\\n?)+/g, (m) => '<ul>'+m+'</ul>')
    .replace(/\\n\\n/g, '</p><p>');

    document.body.innerHTML =
      '<div class="panel" style="min-height:100vh">'
      + '<header class="bar"><div class="bar__brand">'
      + '<img class="bar__mark" src="'+chrome.runtime.getURL('/icons/icon32.png')+'">'
      + '<span class="bar__name">BiliLens</span></div>'
      + '<button class="bar__gear">⚙</button></header>'
      + '<section class="vh">'
      + '<div class="vh__main">'
      + '<h1 class="vh__title">[中配] 我如何使用AI进行高效学习</h1>'
      + '<p class="vh__meta"><span class="vh__up">豚工智能</span><span class="vh__dot">·</span>'
      + '<span class="tnum">37 分 58 秒</span><span class="vh__dot">·</span><span class="tnum">1.8万 播放</span></p>'
      + '<p class="vh__mat"><span class="chip chip--on">官方总结</span>'
      + '<span class="chip chip--on">字幕 352</span></p>'
      + '</div></section>'
      + '<div class="tb">'
      + '<button class="tb__item tb__item--on">目录</button>'
      + '<button class="tb__item">聊天</button>'
      + '</div>'
      + '<div class="actbar"><button class="btn btn--primary actbar__go">重新生成</button></div>'
      + '<div class="body"><article class="note">'
      + '<div class="note__inner" style="display:contents">'+body+'</div>'
      + '</article></div>'
      + '<footer class="acts"><button class="btn btn--primary">存入 Obsidian</button>'
      + '<button class="btn">复制</button></footer>'
      + '</div>';

    // 按「类名 → hash」映射，把 scoped 属性放到正确的元素上
    applyScopes();

    // 点亮第 3 个章节，展示"当前阅读位置"
    const heads = [...document.querySelectorAll('h3.rail')];
    if (heads[2]) heads[2].classList.add('is-active');

    return {
      sections: sections.length,
      scopeKeys: Object.keys(scopeMap).length,
      noteHash: scopeMap['note'] || null,
      heads: heads.length,
    };
  })()
`);

console.log('  注入结果:', JSON.stringify(injected));

// 断言导轨结构与样式
const railCheck = await side.evaluate(`
  (() => {
    const nodes = [...document.querySelectorAll('.rail__node')];
    const times = [...document.querySelectorAll('.rail__time')];
    const active = document.querySelector('h3.rail.is-active .rail__node');
    const note = document.querySelector('.note');

    const line = note ? getComputedStyle(note, '::before') : null;

    return {
      nodes: nodes.length,
      times: times.length,
      hasActive: !!active,
      activeBg: active ? getComputedStyle(active).backgroundColor : null,
      nodeSize: nodes[0] ? getComputedStyle(nodes[0]).width : null,
      nodeBorder: nodes[0] ? getComputedStyle(nodes[0]).borderColor : null,
      timeFont: times[0] ? getComputedStyle(times[0]).fontFamily : null,
      timeVariant: times[0] ? getComputedStyle(times[0]).fontVariantNumeric : null,
      railLineBg: line ? line.backgroundImage.slice(0, 40) : null,
      notePaddingLeft: note ? getComputedStyle(note).paddingLeft : null,
    };
  })()
`);

console.log('  导轨检查:', JSON.stringify(railCheck, null, 2).replace(/\n/g, '\n  '));

/*
 * 字号档位：必须验证「令牌真的传到了侧边栏」。
 *
 * 这一步容易悄悄失效——比如某个组件的 font-size 漏改、
 * 或者 --fs 没被 <html> 上的 data-font 命中。那种情况下
 * 设置页看起来一切正常，用户点了「最大」却毫无反应。
 * 因此这里实测：改档位前量一次，改完再量一次，必须变大。
 */
const fontCheck = await side.evaluate(`
  (() => {
    const read = () => {
      const p = document.querySelector('.note p');
      const t = document.querySelector('.rail__time');
      return {
        body: parseFloat(getComputedStyle(document.body).fontSize),
        para: p ? parseFloat(getComputedStyle(p).fontSize) : null,
        time: t ? parseFloat(getComputedStyle(t).fontSize) : null,
      };
    };
    const before = read();
    document.documentElement.dataset.font = 'huge';
    // 强制触发重排，确保 Chromium headless 刷新所有后代元素的计算字号
    const tEl = document.querySelector('.rail__time');
    if (tEl && tEl.parentNode) {
      const next = tEl.nextSibling;
      const parent = tEl.parentNode;
      parent.removeChild(tEl);
      parent.insertBefore(tEl, next);
    }
    const after = read();
    return { before, after };
  })()
`);

console.log('  字号档位:', JSON.stringify(fontCheck));
{
  const { before, after } = fontCheck;
  const grew = (a, b) => typeof a === 'number' && typeof b === 'number' && b > a;
  if (!grew(before.body, after.body) || !grew(before.para, after.para) || !grew(before.time, after.time)) {
    console.log('  ✗ 切到最大档后字号没有变大 —— --fs 没生效（检查 font-size 是否写成 calc(… * var(--fs))）');
    process.exitCode = 1;
  } else {
    console.log(
      `  ✓ 最大档生效：正文 ${before.para}→${after.para}px，时间戳 ${before.time}→${after.time}px`,
    );
  }
}

// 侧边栏尺寸：Chrome 侧边栏通常 ~360-400px 宽
await side.send('Emulation.setDeviceMetricsOverride', {
  width: 400,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(400);

/*
 * 最大档必须**在真实侧边栏宽度下**检查是否横向溢出。
 * 字号放大最容易出问题的不是「字变小」，而是长标题、
 * 时间戳胶囊、按钮文字被挤出容器。窗口宽的时候看不出来。
 */
const overflowCheck = await side.evaluate(`
  (() => {
    document.documentElement.dataset.font = 'huge';
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .map((el) => el.className || el.tagName);
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      overflowCount: wide.length,
      sample: wide.slice(0, 5),
    };
  })()
`);

console.log('  最大档溢出检查:', JSON.stringify(overflowCheck));
if (overflowCheck.scrollWidth > overflowCheck.clientWidth + 1 || overflowCheck.overflowCount > 0) {
  console.log('  ✗ 最大档下出现横向溢出，字号调大后布局被撑破');
  process.exitCode = 1;
}

await side.screenshot('sidepanel-font-huge');
await side.evaluate(`document.documentElement.dataset.font = 'normal'`);

await sleep(300);
await side.screenshot('sidepanel-rail');

side.close();
await bsend('Target.closeTarget', { targetId: side.targetId });

/* ---------------- 收尾 ---------------- */

bws.close();
child.kill();
await sleep(1600);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('\n截图完成 →', SHOTS);
