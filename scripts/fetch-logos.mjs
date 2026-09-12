/**
 * scripts/fetch-logos.mjs —— 抓取设置页需要用到的服务商官方 logo
 *
 * 为什么必须用真实 logo：
 *   设置页里逐个列出了 8 家服务商的名字。按设计规范，
 *   只要界面里出现能被认出的产品/品牌名，它的官方标识就是必需资产——
 *   否则等于把这些品牌都"通用化"成一段灰字，用户无法快速扫读。
 *
 * 来源优先级：
 *   1. simpleicons.org —— 矢量品牌标识（单色，可随主题着色）
 *   2. Google favicon 服务 —— 网站图标（兜底，含各家官网）
 *
 * 产物一律内嵌为 base64 供页面直接使用，避免扩展运行时发外部请求
 * （扩展的 CSP 与隐私边界都不允许随意外联）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '..', 'design', 'logos');
mkdirSync(OUT, { recursive: true });

/** 服务商 → 资产来源。simpleicon 优先，favicon 兜底。 */
const PROVIDERS = [
  { id: 'siliconflow', label: '硅基流动', simpleicon: null, domain: 'siliconflow.cn' },
  { id: 'deepseek', label: 'DeepSeek', simpleicon: 'deepseek', domain: 'deepseek.com' },
  { id: 'moonshot', label: 'Moonshot', simpleicon: null, domain: 'moonshot.cn' },
  { id: 'zhipu', label: '智谱 GLM', simpleicon: null, domain: 'zhipuai.cn' },
  { id: 'openrouter', label: 'OpenRouter', simpleicon: 'openrouter', domain: 'openrouter.ai' },
  { id: 'openai', label: 'OpenAI', simpleicon: null, domain: 'openai.com' },
  { id: 'ollama', label: 'Ollama', simpleicon: 'ollama', domain: 'ollama.com' },
  { id: 'bilibili', label: 'bilibili', simpleicon: 'bilibili', domain: 'bilibili.com' },
];

const results = [];

for (const p of PROVIDERS) {
  let buf = null;
  let source = '';

  // 1. 尝试 simpleicons（SVG，单色，最适合做 UI 图标）
  if (p.simpleicon) {
    try {
      const r = await fetch(`https://cdn.simpleicons.org/${p.simpleicon}`);
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<svg')) {
          buf = Buffer.from(text, 'utf8');
          source = `simpleicons:${p.simpleicon}`;
        }
      }
    } catch {
      /* 落到 favicon */
    }
  }

  // 2. 兜底 Google favicon（PNG）
  if (!buf) {
    for (const dom of [p.domain, `www.${p.domain}`]) {
      try {
        const r = await fetch(
          `https://www.google.com/s2/favicons?domain=${dom}&sz=128`,
        );
        if (r.ok) {
          const ab = await r.arrayBuffer();
          // Google 未收录时返回默认地球图标（16x16 的极小文件），据此判弃
          if (ab.byteLength > 500) {
            buf = Buffer.from(ab);
            source = `favicon:${dom}`;
            break;
          }
        }
      } catch {
        /* 继续 */
      }
    }
  }

  if (buf) {
    const ext = source.startsWith('simpleicons') ? 'svg' : 'png';
    const file = join(OUT, `${p.id}.${ext}`);
    writeFileSync(file, buf);
    results.push({ ...p, file: `${p.id}.${ext}`, source, bytes: buf.length });
    console.log(`  \u2713 ${p.id.padEnd(12)} ${source.padEnd(26)} ${buf.length} bytes`);
  } else {
    results.push({ ...p, file: null, source: null, bytes: 0 });
    console.log(`  \u2717 ${p.id.padEnd(12)} 未取到`);
  }
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(results, null, 2), 'utf8');

const got = results.filter((r) => r.file).length;
console.log(`\n${got}/${PROVIDERS.length} 个 logo 已取得，输出到 ${OUT}`);
