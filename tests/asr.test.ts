/**
 * tests/asr.test.ts —— 本地 ASR 服务客户端单元测试
 *
 * 验证对本地 ASR 接口（如 CapsWriter / Fun-ASR 本地服务）的探测与转录调用：
 * 1. checkAsrHealth 正常在线、HTTP 错误与网络异常分支
 * 2. requestAsrTranscription 参数传递、结果校验、异常字段过滤与错误处理
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAsrHealth, getEndpointPort, requestAsrTranscription } from '@/lib/asr';

describe('getEndpointPort', () => {
  it('正确解析各种格式端点的端口', () => {
    expect(getEndpointPort('http://127.0.0.1:18765/api/transcribe')).toBe('18765');
    expect(getEndpointPort('http://localhost:8765/api/transcribe')).toBe('8765');
    expect(getEndpointPort('http://192.168.1.50:9000')).toBe('9000');
    expect(getEndpointPort('http://example.com/api')).toBe('80');
    expect(getEndpointPort('https://example.com/api')).toBe('443');
    expect(getEndpointPort('invalid-url', '18765')).toBe('18765');
  });
});

describe('checkAsrHealth', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('健康检查正常时返回 ok: true 与服务描述', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'CapsWriter-Offline Ready (GPU: ONNX+GGUF)' }),
    });

    const res = await checkAsrHealth('http://127.0.0.1:18765/api/transcribe');
    expect(res.ok).toBe(true);
    expect(res.message).toBe('CapsWriter-Offline Ready (GPU: ONNX+GGUF)');
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:18765/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('服务返回非 200 响应时返回 ok: false 与状态码', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const res = await checkAsrHealth('http://127.0.0.1:18765/api/transcribe');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('503');
  });

  it('网络无法连接（服务未启动）时捕获异常并返回友好提示', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'));

    const res = await checkAsrHealth('http://127.0.0.1:18765/api/transcribe');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Failed to fetch');
  });
});

describe('requestAsrTranscription', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('成功转录并按规范解析清洗 SubtitleSegment 数组', async () => {
    const progressMsgs: string[] = [];
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        segments: [
          { from: 0.5, to: 2.1, content: '大家好，欢迎来到本期视频。' },
          { from: 2.2, to: 4.8, content: '今天我们来聊一聊本地 ASR。' },
          // 脏数据过滤测试：
          { from: 5.0, to: 6.0, content: '   ' }, // 空白
          { from: 8.0, to: 7.0, content: '时间倒退' }, // to < from
          { from: NaN, to: 10.0, content: '非数' }, // NaN
        ],
        duration: 4.8,
        rtf: 0.04,
      }),
    });

    const segments = await requestAsrTranscription(
      'http://127.0.0.1:18765/api/transcribe',
      { bvid: 'BV1xx411c7mD', cid: 123456 },
      (msg) => progressMsgs.push(msg),
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      from: 0.5,
      to: 2.1,
      content: '大家好，欢迎来到本期视频。',
    });
    expect(segments[1]).toEqual({
      from: 2.2,
      to: 4.8,
      content: '今天我们来聊一聊本地 ASR。',
    });
    expect(progressMsgs.length).toBeGreaterThanOrEqual(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:18765/api/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, application/json',
        },
        body: JSON.stringify({ bvid: 'BV1xx411c7mD', cid: 123456, stream: true }),
      }),
    );
  });

  it('支持流式 NDJSON 返回实时分段进度并驱动百分比回调', async () => {
    const progressList: Array<{ msg: string; pct?: number }> = [];
    const ndjsonChunks = [
      JSON.stringify({ type: 'progress', current: 1, total: 3, percent: 33.3, eta_sec: 20 }) + '\n',
      JSON.stringify({ type: 'progress', current: 2, total: 3, percent: 66.7, eta_sec: 10 }) + '\n',
      JSON.stringify({
        type: 'done',
        code: 0,
        segments: [{ from: 0.0, to: 2.5, content: '流式转录测试成功' }],
      }) + '\n',
    ];

    let chunkIdx = 0;
    const mockStream = {
      getReader: () => ({
        read: async () => {
          if (chunkIdx < ndjsonChunks.length) {
            const encoder = new TextEncoder();
            const value = encoder.encode(ndjsonChunks[chunkIdx++]);
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      }),
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/x-ndjson' : null),
      },
      body: mockStream,
    });

    const segments = await requestAsrTranscription(
      'http://127.0.0.1:18765/api/transcribe',
      { bvid: 'BV1flow123', cid: 999 },
      (msg, pct) => progressList.push({ msg, pct }),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.content).toBe('流式转录测试成功');
    const pctList = progressList.map((p) => p.pct).filter((p) => typeof p === 'number');
    expect(pctList).toContain(33);
    expect(pctList).toContain(67);
    expect(pctList).toContain(100);
  });

  it('服务返回 500 报错时抛出明确异常', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Audio decode error',
    });

    await expect(
      requestAsrTranscription('http://127.0.0.1:18765/api/transcribe', { bvid: 'BV1xx411c7mD' }),
    ).rejects.toThrow('本地 ASR 服务请求失败 (500): Audio decode error');
  });

  it('服务业务 code 非 0 时抛出业务错误消息', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        code: 1002,
        message: '未获取到可用的视频音轨流',
      }),
    });

    await expect(
      requestAsrTranscription('http://127.0.0.1:18765/api/transcribe', { bvid: 'BV1xx411c7mD' }),
    ).rejects.toThrow('未获取到可用的视频音轨流');
  });

  it('连接被拒时抛出友好错误并包含动态端口信息', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'));

    await expect(
      requestAsrTranscription('http://127.0.0.1:9876/api/transcribe', { bvid: 'BV1xx411c7mD' }),
    ).rejects.toThrow('确保 9876 端口正常在线');
  });
});
