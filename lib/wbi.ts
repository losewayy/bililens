/**
 * lib/wbi.ts —— B站 WBI 签名（TypeScript 实现）
 *
 * WBI 是 B站自 2023-03 起在部分 Web 接口上启用的签名鉴权机制：
 *   1. GET /x/web-interface/nav → data.wbi_img.{img_url,sub_url}
 *   2. 取两个 URL 的文件名（去扩展名），拼接 raw = imgKey + subKey
 *   3. 按固定 64 位置换表重排 raw，取前 32 位 = mixinKey
 *   4. 参数按 key 升序 → urlencode → 拼 mixinKey → MD5 = w_rid
 *
 * 正确性已通过测试验证（tests/wbi.test.ts）：
 *   · MD5 与 RFC 1321 标准测试向量一致
 *   · 可逐字节复现 B站官方文档给出的示例 w_rid
 *
 * 说明：WebCrypto 不提供 MD5，故此处自带实现，不引入第三方依赖。
 */

/** 官方混淆表，元素为 raw 字符串中的位置索引 */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
] as const;

/* ================================================================== *
 * MD5（RFC 1321）
 * ================================================================== */

const MD5_S: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** 常量表 K[i] = floor(|sin(i+1)| * 2^32)，用有符号 32 位存放 */
const MD5_K: Int32Array = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }
  return k;
})();

/** 计算字节数组的 MD5，返回 32 位小写十六进制字符串 */
export function md5Bytes(bytes: Uint8Array): string {
  const origLenBits = bytes.length * 8;

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，末尾补 8 字节小端长度
  const totalLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, origLenBits >>> 0, true);
  dv.setUint32(totalLen - 4, Math.floor(origLenBits / 4294967296) >>> 0, true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const M = new Int32Array(16);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let j = 0; j < 64; j++) {
      let F: number;
      let g: number;

      if (j < 16) {
        F = (B & C) | (~B & D);
        g = j;
      } else if (j < 32) {
        F = (D & B) | (~D & C);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        F = B ^ C ^ D;
        g = (3 * j + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * j) % 16;
      }

      F = (F + A + (MD5_K[j] as number) + (M[g] as number)) | 0;
      A = D;
      D = C;
      C = B;
      const sh = MD5_S[j] as number;
      B = (B + ((F << sh) | (F >>> (32 - sh)))) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);

  let hex = '';
  for (let n = 0; n < 16; n++) hex += (out[n] as number).toString(16).padStart(2, '0');
  return hex;
}

/** 计算字符串（UTF-8）的 MD5 */
export function md5(str: string): string {
  return md5Bytes(new TextEncoder().encode(str));
}

/* ================================================================== *
 * WBI
 * ================================================================== */

/** 由 imgKey + subKey 推导 mixinKey */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    out += raw[idx] ?? '';
  }
  return out.slice(0, 32);
}

/** 从 wbi_img 的 URL 中取出文件名（不含扩展名） */
export function keyFromUrl(url: string): string {
  const seg = url.split('/').pop() ?? '';
  return seg.split('.')[0] ?? '';
}

export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/** 参与签名的参数值类型 */
export type WbiParams = Record<string, string | number | undefined | null>;

/**
 * 对参数签名，返回可直接拼接到 URL 的 query string。
 *
 * @param params  业务参数（不含 wts / w_rid）
 * @param keys    imgKey 与 subKey
 * @param wts     指定时间戳；缺省取当前秒级时间戳。测试时传入固定值可复现结果。
 */
export function encWbi(params: WbiParams, keys: WbiKeys, wts?: number): string {
  const mixinKey = getMixinKey(keys.imgKey, keys.subKey);

  const withTs: Record<string, string> = { wts: String(wts ?? Math.floor(Date.now() / 1000)) };

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // 官方要求过滤 !'()* 这几个字符
    withTs[k] = String(v).replace(/[!'()*]/g, '');
  }

  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(withTs[k] as string)}`)
    .join('&');

  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}
