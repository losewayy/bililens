#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BiliLens 本地 ASR 极速语音识别服务 (Fun-ASR-Nano-GGUF)

提供亚秒级（RTF ~0.025）带精确时间戳的逐字稿转录服务。
接口规范：
- GET  /health          健康探测与硬件自适应检测
- POST /api/transcribe  提交转写任务（支持 bvid / audioUrl / 本地文件路径）
"""

import os
import sys
import time
import shutil
import tempfile
import urllib.request
import subprocess
from pathlib import Path
from typing import Optional, List

import queue
import threading
import json
import asyncio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import uvicorn

ROOT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(ROOT_DIR))

from core import transcribe_segments, load_engine

app = FastAPI(
    title="BiliLens Local ASR Service",
    description="High-performance local ASR server powered by Fun-ASR-Nano-GGUF",
    version="1.0.0",
)

# 允许跨域（Chrome MV3 扩展调用必须）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE_DIR = ROOT_DIR / ".cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


class TranscribeRequest(BaseModel):
    bvid: Optional[str] = None
    audioUrl: Optional[str] = None
    path: Optional[str] = None
    language: Optional[str] = "Chinese"
    stream: Optional[bool] = True


def _download_stream(url: str, dest: Path) -> None:
    """下载音频直链至目标路径"""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com/",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def _download_via_ytdlp(bvid: str, dest_without_ext: Path) -> Path:
    """通过 yt-dlp 抓取 B 站最高质量音频轨"""
    url = f"https://www.bilibili.com/video/{bvid}"
    out_tmpl = str(dest_without_ext.parent / f"{dest_without_ext.stem}.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "m4a",
        "--output", out_tmpl,
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        cmd[0] = "yt-dlp"
        cmd.pop(1)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    for cand in dest_without_ext.parent.glob(f"{dest_without_ext.stem}.*"):
        if cand.suffix.lower() in [".m4a", ".aac", ".mp3", ".wav", ".webm", ".ogg"]:
            return cand

    raise FileNotFoundError(f"yt-dlp 下载音频完成但未找到目标文件 ({out_tmpl})")


_cached_device_info: Optional[str] = None


def get_device_info() -> str:
    """动态获取当前 GPU / 硬件加速设备信息"""
    global _cached_device_info
    if _cached_device_info is not None:
        return _cached_device_info
    try:
        import torch
        if torch.cuda.is_available():
            _cached_device_info = f"{torch.cuda.get_device_name(0)} 硬件加速"
            return _cached_device_info
    except Exception:
        pass
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=1,
        )
        if res.returncode == 0 and res.stdout.strip():
            _cached_device_info = f"{res.stdout.strip().splitlines()[0].strip()} 硬件加速"
            return _cached_device_info
    except Exception:
        pass
    _cached_device_info = "本地硬件加速"
    return _cached_device_info


@app.on_event("startup")
async def startup_event():
    """服务启动时预热 GPU 引擎，避免首次请求等待 shader 编译"""
    try:
        print("[Server] 正在预热本地 ASR 推理引擎...", file=sys.stderr)
        load_engine()
        print("[Server] 本地 ASR 推理引擎就绪！", file=sys.stderr)
    except Exception as e:
        print(f"[Server] 引擎预热跳过 (将在首次转写时加载): {e}", file=sys.stderr)


@app.get("/health")
async def health_check():
    """健康探测接口"""
    dev = get_device_info()
    return {
        "status": f"服务正常在线 ({dev})",
        "model": "Fun-ASR-Nano-GGUF (通义开源最新 0.8B 架构)",
        "engine": "Fun-ASR (ONNX CUDA + CTC + llama.cpp)",
        "device": dev,
        "port": 18765,
    }


@app.post("/api/transcribe")
async def transcribe(req: TranscribeRequest):
    """
    音频转写接口。
    输入可为本地文件路径、音频直链 URL、或 B 站 BV 号。
    输出 SubtitleSegment[] 格式结构以及纯文本 raw_text。
    """
    t0 = time.time()
    temp_file: Optional[Path] = None
    target_audio_path: Optional[str] = None

    try:
        # 分支 1：传入本地路径
        if req.path and os.path.exists(req.path):
            target_audio_path = req.path

        # 分支 2：传入直接音频 URL
        elif req.audioUrl:
            temp_file = CACHE_DIR / f"stream_{int(time.time()*1000)}.m4a"
            print(f"[Server] 正在从 audioUrl 下载音频: {req.audioUrl[:60]}...", file=sys.stderr)
            _download_stream(req.audioUrl, temp_file)
            target_audio_path = str(temp_file)

        # 分支 3：传入 B 站 BV 号
        elif req.bvid:
            temp_file = CACHE_DIR / f"bili_{req.bvid}_{int(time.time()*1000)}.m4a"
            print(f"[Server] 正在通过 yt-dlp 抓取 {req.bvid} 音频...", file=sys.stderr)
            actual_path = _download_via_ytdlp(req.bvid, temp_file)
            temp_file = actual_path
            target_audio_path = str(actual_path)

        else:
            return JSONResponse(
                status_code=400,
                content={"code": 400, "message": "缺少音频来源参数 (path, audioUrl 或 bvid 至少需提供一项)"},
            )

        print(f"[Server] 开始转录音频: {target_audio_path} (stream={req.stream})", file=sys.stderr)

        # 分支 A：流式传输实时进度 (NDJSON)
        if req.stream:
            def event_stream():
                q = queue.Queue()

                def worker():
                    try:
                        dev_str = get_device_info()

                        def on_progress(*args, **kwargs):
                            if len(args) == 1 and isinstance(args[0], dict):
                                d = dict(args[0])
                                if "device" not in d:
                                    d["device"] = dev_str
                                q.put(d)
                            elif len(args) >= 1 and isinstance(args[0], str):
                                q.put({"type": "status", "message": args[0], "device": dev_str})

                        res_tuple = transcribe_segments(
                            target_audio_path,
                            language=req.language or "Chinese",
                            on_progress=on_progress,
                        )
                        if len(res_tuple) == 5:
                            segments, lang, duration, rtf, raw_text = res_tuple
                        else:
                            segments, lang, duration, rtf = res_tuple
                            raw_text = " ".join(s["content"] for s in segments)

                        q.put({
                            "type": "done",
                            "code": 0,
                            "segments": segments,
                            "raw_text": raw_text,
                            "duration": duration,
                            "rtf": rtf,
                            "language": lang,
                            "count": len(segments),
                            "server_time_sec": round(time.time() - t0, 3),
                        })
                    except Exception as err:
                        import traceback
                        traceback.print_exc()
                        q.put({"type": "error", "code": 500, "message": str(err)})
                    finally:
                        if temp_file and temp_file.exists():
                            try:
                                temp_file.unlink()
                            except Exception:
                                pass
                        q.put(None)

                threading.Thread(target=worker, daemon=True).start()

                while True:
                    item = q.get()
                    if item is None:
                        break
                    yield json.dumps(item, ensure_ascii=False) + "\n"

            return StreamingResponse(
                event_stream(),
                media_type="application/x-ndjson",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        # 分支 B：传统单次同步返回
        segments, lang, duration, rtf, raw_text = transcribe_segments(
            target_audio_path,
            language=req.language or "Chinese",
        )

        return JSONResponse(content={
            "code": 0,
            "message": "success",
            "segments": segments,
            "raw_text": raw_text,
            "duration": duration,
            "rtf": rtf,
            "language": lang,
            "count": len(segments),
            "server_time_sec": round(time.time() - t0, 3),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"code": 500, "message": f"转录服务异常: {str(e)}"},
        )
    finally:
        if not req.stream and temp_file and temp_file.exists():
            try:
                temp_file.unlink()
            except Exception:
                pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "18765"))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"============================================================")
    print(f"  BiliLens 本地 ASR 极速语音识别服务")
    print(f"  架构: Fun-ASR-Nano-GGUF (0.8B 自带标点与时间戳)")
    print(f"  监听地址: http://{host}:{port}")
    print(f"============================================================")
    uvicorn.run(app, host=host, port=port, log_level="info")
