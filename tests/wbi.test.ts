/**
 * tests/wbi.test.ts —— WBI 签名与 MD5 的正确性验证
 *
 * 这是全项目最需要测试的模块：
 * 签名算错 → B站接口全部返回 -403，且错误信息不会告诉你原因。
 */

import { describe, expect, it } from 'vitest';
import { encWbi, getMixinKey, keyFromUrl, md5, md5Bytes } from '@/lib/wbi';

describe('MD5', () => {
  // RFC 1321 附录 A.5 的标准测试向量
  const vectors: ReadonlyArray<[string, string]> = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ];

  it.each(vectors)('md5(%j) 应符合标准测试向量', (input, expected) => {
    expect(md5(input)).toBe(expected);
  });

  it('应正确处理跨 64 字节块的边界长度', () => {
    // 55 / 56 / 57 / 63 / 64 / 65 是填充逻辑最容易出错的长度
    const lens = [55, 56, 57, 63, 64, 65, 119, 120, 128];
    for (const n of lens) {
      const s = 'a'.repeat(n);
      // 与 Node crypto 对照
      const ref = createHashRef(s);
      expect(md5(s), `长度 ${n}`).toBe(ref);
    }
  });

  it('应正确编码多字节 UTF-8（中文）', () => {
    const s = '哔哩哔哩 BiliLens 视频笔记';
    expect(md5(s)).toBe(createHashRef(s));
  });

  it('空字节数组与空字符串结果一致', () => {
    expect(md5Bytes(new Uint8Array(0))).toBe(md5(''));
  });
});

describe('WBI 组件', () => {
  it('keyFromUrl 应从 URL 中取出不含扩展名的文件名', () => {
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')).toBe(
      '4932caff0ff746eab6f01bf08b70ac45',
    );
  });

  it('getMixinKey 应按混淆表重排并截取 32 位', () => {
    const mixin = getMixinKey(
      '7cd084941338484aae1ad9425b84077c',
      '4932caff0ff746eab6f01bf08b70ac45',
    );
    expect(mixin).toBe('ea1db124af3c7062474693fa704f4ff8');
    expect(mixin).toHaveLength(32);
  });
});

describe('encWbi', () => {
  const keys = {
    imgKey: '7cd084941338484aae1ad9425b84077c',
    subKey: '4932caff0ff746eab6f01bf08b70ac45',
  };

  it('应逐字节复现 B站官方文档给出的示例签名', () => {
    // 来自 bilibili-API-collect/docs/video/summary.md 的官方示例：
    // bvid=BV1L94y1H7CV cid=1335073288 up_mid=297242063 wts=1701546363
    // 期望 w_rid=1073871926b3ccd99bd790f0162af634
    const qs = encWbi(
      { bvid: 'BV1L94y1H7CV', cid: 1335073288, up_mid: 297242063 },
      keys,
      1701546363,
    );
    expect(qs).toContain('w_rid=1073871926b3ccd99bd790f0162af634');
  });

  it('参数顺序不应影响签名结果', () => {
    expect(encWbi({ a: 1, b: 2 }, keys, 1700000000)).toBe(
      encWbi({ b: 2, a: 1 }, keys, 1700000000),
    );
  });

  it('应过滤 !\'()* 这些特殊字符', () => {
    expect(encWbi({ q: "a!b'c(d)e*f" }, keys, 1700000000)).toBe(
      encWbi({ q: 'abcdef' }, keys, 1700000000),
    );
  });

  it('应忽略值为 undefined / null 的参数', () => {
    expect(encWbi({ a: 1, b: undefined, c: null }, keys, 1700000000)).toBe(
      encWbi({ a: 1 }, keys, 1700000000),
    );
  });

  it('应包含 wts 与 w_rid 且 w_rid 为 32 位十六进制', () => {
    const qs = encWbi({ cid: 1 }, keys, 1700000000);
    expect(qs).toContain('wts=1700000000');
    const rid = qs.split('w_rid=')[1] ?? '';
    expect(rid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('中文参数值应按 UTF-8 编码后再签名', () => {
    // 与参照实现对照，确保 encodeURIComponent 后的字节表示一致
    const qs = encWbi({ keyword: '中文测试' }, keys, 1700000000);
    expect(qs).toContain(`keyword=${encodeURIComponent('中文测试')}`);
  });
});

/* ---------------- 参照实现 ---------------- */

function createHashRef(s: string): string {
  // 用项目内的 md5 做交叉验证没有意义，这里用 Node 内置 crypto
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('md5').update(s, 'utf8').digest('hex');
}
