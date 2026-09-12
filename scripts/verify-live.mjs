/**
 * scripts/verify-live.mjs —— 用真实 B站接口端到端验证 WBI 签名
 *
 * 为什么必须做这一步：
 *   单元测试只能证明「签名算法与官方文档示例一致」，
 *   但无法证明「B站服务器现在真的接受这个签名」。
 *   接口随时可能改动（WBI 混淆表、必需参数、风控策略），
 *   因此需要用真实请求验证一次。
 *
 * 用法：
 *   node scripts/verify-live.mjs [BV号] [SESSDATA]
 */

import { encWbi, keyFromUrl, getMixinKey } from '../lib/wbi.ts';

const API = 'https://api.bilibili.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
};

const bvid = process.argv[2] ?? 'BV1f4421f7ex';
const sessdata = process.argv[3] ?? process.env.BILI_SESSDATA ?? '';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, extra = '') {
  pass++;
  console.log(`  \u2713 ${name}${extra ? '  ' + extra : ''}`);
}
function bad(name, extra = '') {
  fail++;
  console.log(`  \u2717 ${name}${extra ? '  ' + extra : ''}`);
}
function skipped(name, why) {
  skip++;
  console.log(`  - ${name}（跳过：${why}）`);
}

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  return { status: r.status, json: await r.json() };
}

console.log('='.repeat(64));
console.log('BiliLens —— 真实接口验证');
console.log(`目标视频: ${bvid}`);
console.log(`登录态:   ${sessdata ? '已提供 SESSDATA' : '未提供（仅验证公开接口与签名）'}`);
console.log('='.repeat(64));

/* ---------------- 1. WBI 密钥 ---------------- */

console.log('\n[1] 获取 WBI 签名密钥');
let imgKey = '';
let subKey = '';

try {
  const { json } = await getJson(`${API}/x/web-interface/nav`);
  const wbi = json?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) throw new Error('nav 未返回 wbi_img');

  imgKey = keyFromUrl(wbi.img_url);
  subKey = keyFromUrl(wbi.sub_url);

  ok('nav 接口可达');
  ok('取出 img_key / sub_key', `${imgKey.slice(0, 8)}… / ${subKey.slice(0, 8)}…`);
  console.log(`      mixinKey = ${getMixinKey(imgKey, subKey)}`);
  console.log(`      登录状态 = ${json?.data?.isLogin ? '已登录' : '未登录'}`);
} catch (e) {
  bad('获取 WBI 密钥', String(e));
  process.exit(1);
}

/* ---------------- 2. 公开接口 ---------------- */

console.log('\n[2] 视频信息（公开接口，无需签名）');
let aid = 0;
let cid = 0;
let upMid = 0;
let title = '';

try {
  const { json } = await getJson(`${API}/x/web-interface/view?bvid=${bvid}`);
  if (json.code !== 0) throw new Error(`${json.code} ${json.message}`);

  aid = json.data.aid;
  cid = json.data.cid;
  upMid = json.data.owner?.mid ?? 0;
  title = json.data.title;

  ok('view 接口返回 code=0');
  ok('解析出 aid / cid / up_mid', `aid=${aid} cid=${cid} upMid=${upMid}`);
  console.log(`      标题 = ${title}`);
  console.log(`      时长 = ${json.data.duration}s  分P数 = ${json.data.pages?.length ?? 1}`);
  if (json.data.pages?.length > 1) {
    console.log(`      分P列表 = ${json.data.pages.map((p) => `P${p.page}:${p.part}`).join(' | ')}`);
  }
} catch (e) {
  bad('获取视频信息', String(e));
  process.exit(1);
}

/* ---------------- 3. WBI 签名接口 ---------------- */

console.log('\n[3] WBI 签名接口（关键验证）');

// 3.1 player/wbi/v2 —— 字幕列表
// 这个接口即使未登录也应返回 code=0（只是字幕列表为空），
// 因此它是验证「签名是否被服务端接受」的最佳探针。
const qs = encWbi({ aid, bvid, cid }, { imgKey, subKey });
console.log(`      签名 query = ${qs.slice(0, 110)}…`);

try {
  const { json } = await getJson(`${API}/x/player/wbi/v2?${qs}`);

  if (json.code === 0) {
    ok('player/wbi/v2 签名被接受（code=0）');
    const subs = json.data?.subtitle?.subtitles ?? [];
    if (subs.length) {
      ok('字幕列表非空', `${subs.length} 条`);
      for (const s of subs) {
        console.log(`        · ${s.lan_doc} (${s.lan})${s.lan === 'ai-zh' ? ' [AI]' : ''}`);
      }
    } else {
      ok('字幕列表为空（未登录或该视频无字幕，属正常）');
    }
  } else if (json.code === -403) {
    bad('签名被拒绝（-403）：WBI 算法可能已变更', json.message);
  } else if (json.code === -101) {
    ok('接口可达，返回 -101 未登录（符合预期）');
  } else {
    bad(`player/wbi/v2 异常 code=${json.code}`, json.message);
  }
} catch (e) {
  bad('player/wbi/v2 请求失败', String(e));
}

// 3.2 conclusion/get —— 官方 AI 总结（需登录）
console.log('\n[4] 官方 AI 总结接口');
if (!sessdata) {
  skipped('conclusion/get', '需要 SESSDATA');

  // 未登录时也应得到 -101，这本身能证明签名有效
  try {
    const q = encWbi({ aid, bvid, cid, up_mid: upMid }, { imgKey, subKey });
    const { json } = await getJson(`${API}/x/web-interface/view/conclusion/get?${q}`);
    if (json.code === -101) {
      ok('签名有效（服务端返回 -101 账号未登录，而非 -403 签名错误）');
    } else if (json.code === -403) {
      bad('签名被拒绝（-403）', 'WBI 算法可能已变更');
    } else {
      console.log(`      code=${json.code} ${json.message}`);
    }
  } catch (e) {
    bad('conclusion/get 请求失败', String(e));
  }
} else {
  console.log('  （已提供 SESSDATA，但本脚本仅验证签名算法，不代理登录态请求）');
  console.log('  请在浏览器中实际加载插件验证登录后的完整链路。');
}

/* ---------------- 汇总 ---------------- */

console.log('\n' + '='.repeat(64));
console.log(`结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
console.log('='.repeat(64));

if (fail > 0) {
  console.log('\n注意：若出现 -403，说明 B站的 WBI 规则可能已变更。');
  console.log('需要核对 lib/wbi.ts 中的 MIXIN_KEY_ENC_TAB 与签名流程。');
  process.exit(1);
}

console.log('\n签名算法在当前时点有效，可以装载插件进行浏览器内验证。');
