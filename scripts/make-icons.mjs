/**
 * scripts/make-icons.mjs —— 生成扩展图标（纯 Node，无第三方依赖）
 *
 * 设计：B站粉底 + 白色播放三角 + 一个"取景/字幕"横条，
 * 呼应 BiliLens（Lens = 镜头/取景器）的意象。
 * 用自写 PNG 编码器（zlib 内置于 Node），避免引入 canvas 等重依赖。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'icons');

/* ---------------- PNG 编码 ---------------- */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());

  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组 → PNG Buffer */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制 ---------------- */

const PINK = [251, 114, 153];
const WHITE = [255, 255, 255];

/** 超采样抗锯齿：每个像素取 3x3 样本，计算覆盖率 */
const SS = 3;

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  // 圆角半径约为边长的 22%（接近系统图标的 squircle 观感）
  const R = size * 0.22;
  const pad = size * 0.06;

  // 播放三角的三个顶点（略偏左，视觉重心更稳）
  const tri = [
    { x: size * 0.40, y: size * 0.34 },
    { x: size * 0.40, y: size * 0.66 },
    { x: size * 0.68, y: size * 0.50 },
  ];

  // 底部两条"字幕"横条
  const bars = [
    { x0: 0.26, x1: 0.74, y: 0.775, h: 0.055 },
    { x0: 0.26, x1: 0.58, y: 0.862, h: 0.055 },
  ];

  const inRoundedRect = (x, y) => {
    const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    // 四角做圆角判定
    const cx = Math.min(Math.max(x, x0 + R), x1 - R);
    const cy = Math.min(Math.max(y, y0 + R), y1 - R);
    const dx = x - cx, dy = y - cy;
    if (dx === 0 || dy === 0) return true;
    return dx * dx + dy * dy <= R * R;
  };

  const inTriangle = (x, y) => {
    const [a, b, c] = tri;
    const sign = (p1, p2, p3) =>
      (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign({ x, y }, a, b);
    const d2 = sign({ x, y }, b, c);
    const d3 = sign({ x, y }, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  const inBar = (x, y) =>
    bars.some(
      (b) =>
        x >= size * b.x0 &&
        x <= size * b.x1 &&
        y >= size * b.y &&
        y <= size * (b.y + b.h),
    );

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;

      // 3x3 超采样
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          if (inRoundedRect(x, y)) {
            bgHits++;
            if (inTriangle(x, y) || inBar(x, y)) fgHits++;
          }
        }
      }

      const total = SS * SS;
      const bgA = bgHits / total;
      const fgA = fgHits / total;

      const i = (py * size + px) * 4;

      if (bgA === 0) {
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
        continue;
      }

      // 在粉色底上混合白色前景
      const wRatio = bgA > 0 ? fgA / bgA : 0;
      const mix = (c) => Math.round(PINK[c] * (1 - wRatio) + WHITE[c] * wRatio);

      rgba[i] = mix(0);
      rgba[i + 1] = mix(1);
      rgba[i + 2] = mix(2);
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ---------------- 输出 ---------------- */

mkdirSync(OUT, { recursive: true });

const sizes = [16, 32, 48, 128];
for (const s of sizes) {
  const buf = drawIcon(s);
  const file = join(OUT, `icon${s}.png`);
  writeFileSync(file, buf);
  console.log(`  ✓ icon${s}.png  (${buf.length} bytes)`);
}

// 额外生成一个 512 的，用于商店/README
const big = drawIcon(512);
writeFileSync(join(OUT, 'icon512.png'), big);
console.log(`  ✓ icon512.png (${big.length} bytes)`);

console.log(`\n图标已输出到 ${OUT}`);
