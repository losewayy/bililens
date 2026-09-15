/**
 * lib/asr.ts —— 本地 ASR 语音识别服务客户端
 *
 * 当 B 站视频既没有官方 AI 总结又没有 CC 字幕轨时，
 * useReader 会调用此模块向本地部署的 ASR 服务（如 Qwen3-ASR / CapsWriter 引擎）
 * 发送转写请求，并获取标准的 SubtitleSegment 结构。
 */

import type { SubtitleSegment } from './types';

export interface AsrResponse {
  code: number;
  message?: string;
  segments?: Array<{
    from: number;
    to: number;
    content: string;
  }>;
  duration?: number;
  rtf?: number;
}

export type AsrErrorCode =
  | 'ASR_NOT_STARTED'      // 本地服务未启动 / 无法连接端口
  | 'ASR_TIMEOUT'          // 超时
  | 'ASR_SERVER_ERROR'     // 500 等服务端异常
  | 'ASR_BUSINESS_ERROR';  // 业务层返回错误

export class AsrError extends Error {
  constructor(
    message: string,
    readonly code: AsrErrorCode,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}

/** 探测本地 ASR 服务健康状态 */
export async function checkAsrHealth(
  endpoint: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const url = new URL(endpoint);
    const healthUrl = `${url.protocol}//${url.host}/health`;
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      return { ok: true, message: data.status || '服务正常在线' };
    }
    return { ok: false, message: `服务响应异常 (${res.status})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const friendly =
      /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(detail)
        ? 'Failed to fetch (无法连接本地 ASR 服务，请确认已运行 start-server.ps1 启动服务，默认端口 18765)'
        : detail;
    return {
      ok: false,
      message: friendly,
    };
  }
}

/**
 * 向本地 ASR 服务请求转写视频音轨
 */
export async function requestAsrTranscription(
  endpoint: string,
  params: {
    bvid: string;
    cid?: number;
    audioUrl?: string;
  },
  onProgress?: (msg: string, percent?: number) => void,
  timeoutSeconds?: number,
): Promise<SubtitleSegment[]> {
  onProgress?.('正在向本地 ASR 服务提交转录任务…', 0);

  const timeoutMs = (timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds : 300) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startTime = Date.now();
  let hasRealProgress = false;
  const fallbackTimer = setInterval(() => {
    if (hasRealProgress) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed < 3) {
      onProgress?.(`正在拉取并解析音轨数据（${elapsed}s）…`, 5);
    } else {
      const estimatedPct = Math.min(92, Math.max(8, Math.round(92 * (1 - Math.exp(-elapsed / 30)))));
      onProgress?.(
        `正在通过本地 GPU 转录逐字稿 (${estimatedPct}% · 已耗时 ${elapsed}s，本地 GPU 加速)…`,
        estimatedPct,
      );
    }
  }, 800);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify({ ...params, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AsrError(
        `本地 ASR 服务请求失败 (${res.status}): ${text || res.statusText}`,
        'ASR_SERVER_ERROR',
        res.status,
        text,
      );
    }

    const contentType = res.headers?.get?.('content-type') || '';
    let rawSegments: Array<{ from: number; to: number; content: string }> | null = null;

    // 分支 A：服务端以流式 NDJSON 返回实时进度
    if (contentType.includes('ndjson') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === 'progress') {
              hasRealProgress = true;
              const cur = Number(data.current) || 1;
              const tot = Number(data.total) || 1;
              const pct = Math.min(99, Math.max(1, Math.round(data.percent ?? (cur / tot) * 100)));
              const etaSec = Number(data.eta_sec) || 0;
              const etaStr =
                etaSec > 0
                  ? ` · 预计剩余 ${etaSec >= 60 ? `${Math.floor(etaSec / 60)}分${Math.round(etaSec % 60)}秒` : `${Math.round(etaSec)}秒`}`
                  : '';
              const deviceTag = data.device ? ` (${data.device})` : ' (本地 GPU 加速)';
              onProgress?.(
                `正在通过本地 GPU 转录逐字稿: 第 ${cur}/${tot} 段 (${pct}%)${etaStr}${deviceTag}`,
                pct,
              );
            } else if (data.type === 'done') {
              hasRealProgress = true;
              onProgress?.('ASR 转写完成，正在整理结构化字幕…', 100);
              if (data.code === 0 && Array.isArray(data.segments)) {
                rawSegments = data.segments;
              } else {
                throw new AsrError(data.message || '本地 ASR 返回转录失败', 'ASR_BUSINESS_ERROR');
              }
            } else if (data.type === 'error') {
              throw new AsrError(data.message || '本地 ASR 转录服务异常', 'ASR_SERVER_ERROR');
            }
          } catch (jsonErr) {
            if (jsonErr instanceof AsrError) {
              throw jsonErr;
            }
          }
        }
      }
    }

    // 分支 B：非流式 JSON 响应兜底
    if (!rawSegments) {
      const data = (await res.json()) as AsrResponse;
      if (data.code !== 0 || !Array.isArray(data.segments)) {
        throw new AsrError(data.message || '本地 ASR 返回数据格式错误或识别失败', 'ASR_BUSINESS_ERROR');
      }
      rawSegments = data.segments;
    }

    // 严格校验并转换为标准 SubtitleSegment[]
    const segments: SubtitleSegment[] = [];
    for (const item of rawSegments) {
      const content = String(item.content ?? '').trim();
      if (!content) continue;
      const from = Number(item.from);
      const to = Number(item.to);
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
        segments.push({ from, to, content });
      }
    }

    return segments;
  } catch (err) {
    if (err instanceof AsrError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AsrError(
        `转录超时（超过 ${Math.round(timeoutMs / 1000)} 秒），长视频可前往设置增大超时上限`,
        'ASR_TIMEOUT',
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(msg)) {
      throw new AsrError(
        `无法连接本地 ASR 服务（${endpoint}）。本地服务未开启，请先运行本地 ASR 启动脚本（如 start-server.ps1，确保 18765 端口正常在线）后再试。`,
        'ASR_NOT_STARTED',
        undefined,
        msg,
      );
    }
    throw new AsrError(msg, 'ASR_BUSINESS_ERROR', undefined, msg);
  } finally {
    clearTimeout(timer);
    clearInterval(fallbackTimer);
  }
}
