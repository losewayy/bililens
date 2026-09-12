/**
 * lib/image.ts —— 聊天里粘贴的图片处理
 *
 * 只做两件事：
 *   ① 从剪贴板事件里把图片抠出来
 *   ② 降采样后转成 data URL
 *
 * 【为什么要降采样】
 * 屏幕截图动辄 2~4 MB，原样发过去有两个代价：
 *   · 请求体变大，中转站/本地网关可能直接拒绝
 *   · 视觉 token 按分辨率算，不降采样就是白花钱
 * 最长边 1280 是常见视觉模型的原生输入尺度附近，
 * 再大通常只是被服务端自己缩回去。
 */

import type { ChatImage } from './types';

/** 最长边上限（像素） */
const MAX_EDGE = 1280;
/** JPEG 质量：0.82 在截图这类内容上肉眼看不出损失 */
const QUALITY = 0.82;
/** 单张图的上限，超过就拒绝（避免把整个请求撑爆） */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** 一次最多带几张图——多数视觉模型对张数也有限制 */
export const MAX_IMAGES_PER_TURN = 4;

/**
 * 从剪贴板数据里取出图片文件。
 *
 * 走 items 而不是 files：Chrome 里从网页复制图片时 files 常常是空的，
 * 但 items 里一定有 image/* 这一项。从文件管理器复制才有 files。
 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  if (out.length) return out;
  // 兜底：某些来源只填 files
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'));
}

/** 读成 data URL */
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
}

/** 解码成 ImageBitmap / HTMLImageElement */
async function decode(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这张图片无法解码'));
    img.src = dataURL;
  });
}

/**
 * 把任意图片文件转成「降采样后的 data URL」。
 *
 * 【为什么统一导出 JPEG】
 * PNG 截图（尤其是带大面积纯色的界面截图）压出来常常比 JPEG 大好几倍，
 * 而聊天里贴图不需要透明通道。统一走 JPEG 省 token 也省内存。
 */
export async function fileToChatImage(file: File): Promise<ChatImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩后再粘贴`);
  }

  const raw = await readAsDataURL(file);
  const img = await decode(raw);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // 拿不到 2D 上下文（极罕见）时退回原图，功能不至于不可用
    return { dataURL: raw, width: img.naturalWidth, height: img.naturalHeight };
  }

  // JPEG 不支持透明，先铺白底，否则透明区域会变成黑块
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  return { dataURL: canvas.toDataURL('image/jpeg', QUALITY), width: w, height: h };
}
