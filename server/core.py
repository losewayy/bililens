# -*- coding: utf-8 -*-
"""
BiliLens 本地 ASR 核心控制器模块 (Fun-ASR-Nano-GGUF)
"""

import os
import sys
import gc
import time
import subprocess
import tempfile
import warnings
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

import numpy as np

warnings.filterwarnings("ignore")

SERVER_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SERVER_DIR))

from engine import FunASREngine, BaseASREngine, RecognitionResult
from engine.inference.schema import ASREngineConfig
from engine.inference.transcriber import AudioTranscriber

SAMPLE_RATE = 16000
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".aac", ".m4a", ".ogg", ".wma", ".aiff", ".aif"}
VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv", ".webm", ".m4v"}

_engine = None
_transcriber = None


def get_model_dir() -> Path:
    """获取 Fun-ASR-Nano-GGUF 模型目录（自适应定位）"""
    env_dir = os.environ.get("FUNASR_MODEL_DIR")
    if env_dir and Path(env_dir).exists():
        return Path(env_dir)

    # 优先使用当前项目下的 models/Fun-ASR-Nano-GGUF
    local_dir = SERVER_DIR / "models" / "Fun-ASR-Nano-GGUF"
    if local_dir.exists() and (local_dir / "tokens.txt").exists():
        return local_dir

    # 备选当前项目 models 根目录
    alt_local = SERVER_DIR / "models"
    if alt_local.exists() and (alt_local / "tokens.txt").exists():
        return alt_local

    # 本地已有开发环境回退探测
    dev_fallback = Path(r"D:\worktable\CapsWriter-Offline\models\Fun-ASR-Nano\Fun-ASR-Nano-GGUF")
    if dev_fallback.exists():
        return dev_fallback

    return local_dir


def load_engine():
    """加载 Fun-ASR 推理引擎（全局单例）"""
    global _engine, _transcriber
    if _engine is not None:
        return _engine

    model_dir = get_model_dir()
    encoder_path = model_dir / "Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx"
    ctc_path = model_dir / "Fun-ASR-Nano-CTC.fp16.onnx"
    decoder_path = model_dir / "Fun-ASR-Nano-Decoder.q5_k.gguf"
    tokens_path = model_dir / "tokens.txt"

    missing = [p.name for p in [encoder_path, ctc_path, decoder_path, tokens_path] if not p.exists()]
    if missing:
        raise FileNotFoundError(
            f"Fun-ASR-Nano 模型文件缺失: {', '.join(missing)}。\n"
            f"请检查目录: {model_dir}\n"
            f"您可以运行 'python download_models.py' 自动拉取，或从 GitHub Releases 下载解压到 models/ 目录。"
        )

    config = ASREngineConfig(
        encoder_onnx_path=str(encoder_path),
        ctc_onnx_path=str(ctc_path),
        decoder_gguf_path=str(decoder_path),
        tokens_path=str(tokens_path),
        onnx_provider="CUDA",
        llm_use_gpu=True,
        verbose=False,
    )

    print(f"[Fun-ASR] 正在从 {model_dir.name} 初始化推理引擎...", file=sys.stderr)
    t0 = time.time()
    _engine = FunASREngine(config)
    _transcriber = AudioTranscriber(_engine.pipeline)
    print(f"[Fun-ASR] 引擎加载完成 (耗时: {time.time()-t0:.2f}s)", file=sys.stderr)

    # 简要预热触发 Vulkan/CUDA shader 编译
    try:
        dummy_audio = np.zeros(16000 * 3, dtype=np.float32)
        stream = _engine.create_stream()
        stream.accept_waveform(16000, dummy_audio)
        _engine.decode_stream(stream, language="Chinese")
    except Exception:
        pass

    return _engine


def get_transcriber() -> AudioTranscriber:
    global _transcriber
    if _transcriber is None:
        load_engine()
    return _transcriber


def load_audio(path: str) -> np.ndarray:
    """加载音频统一转为 16kHz float32 单声道"""
    path_str = str(path)
    try:
        cmd = [
            "ffmpeg", "-v", "error",
            "-i", path_str,
            "-f", "f32le",
            "-acodec", "pcm_f32le",
            "-ac", "1",
            "-ar", str(SAMPLE_RATE),
            "-"
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        raw, err = proc.communicate(timeout=60)
        if proc.returncode == 0 and len(raw) > 0:
            return np.frombuffer(raw, dtype=np.float32)
    except Exception:
        pass

    import soundfile as sf
    data, sr = sf.read(path_str, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data.flatten()
    if sr != SAMPLE_RATE:
        import math
        gcd = math.gcd(sr, SAMPLE_RATE)
        up = SAMPLE_RATE // gcd
        down = sr // gcd
        if max(up, down) <= 256:
            import scipy.signal
            mono = scipy.signal.resample_poly(mono, up, down).astype(np.float32)
        else:
            num_samples = int(len(mono) * SAMPLE_RATE / sr)
            mono = np.interp(np.linspace(0, len(mono), num_samples, endpoint=False), np.arange(len(mono)), mono).astype(np.float32)
    return mono


def extract_audio_to_wav(video_path: str) -> str:
    """从视频容器抽取 16kHz 单声道 wav"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", video_path,
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-acodec", "pcm_s16le",
        tmp.name
    ]
    res = subprocess.run(cmd, capture_output=True, timeout=120)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg 抽音轨失败: {res.stderr.decode('utf-8', errors='ignore')}")
    return tmp.name


def trim_silence(audio: np.ndarray, sr: int = SAMPLE_RATE, threshold: float = 0.008) -> np.ndarray:
    """首尾静音裁剪"""
    frame_len = int(0.025 * sr)
    hop_len = int(0.010 * sr)
    if len(audio) < frame_len:
        return audio
    num_frames = (len(audio) - frame_len) // hop_len + 1
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(num_frames, frame_len),
        strides=(audio.strides[0] * hop_len, audio.strides[0]),
    )
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    voiced = np.where(rms > threshold)[0]
    if len(voiced) == 0:
        return audio
    start = max(0, voiced[0] * hop_len - int(0.1 * sr))
    end = min(len(audio), (voiced[-1] + 1) * hop_len + int(0.1 * sr))
    return audio[start:end]


def segments_to_subtitles(segments: list) -> List[Dict[str, Any]]:
    """将内部 segments 转为标准 [{from, to, content}]"""
    subs = []
    for s in segments:
        text = getattr(s, "text", None) or (s.get("text") if isinstance(s, dict) else "")
        start = getattr(s, "start", None) if hasattr(s, "start") else (s.get("start") if isinstance(s, dict) else 0.0)
        end = getattr(s, "end", None) if hasattr(s, "end") else (s.get("end") if isinstance(s, dict) else 0.0)
        text = (text or "").strip()
        if text:
            subs.append({
                "from": round(float(start), 3),
                "to": round(float(end), 3),
                "content": text,
            })
    return subs


def transcribe_segments(
    audio_path: str,
    language: Optional[str] = None,
    on_progress=None,
) -> Tuple[List[Dict[str, Any]], str, float, float, str]:
    """
    核心分段转写入口。
    返回 (segments, language, total_duration, rtf, raw_text)
    """
    transcriber = get_transcriber()

    suffix = Path(audio_path).suffix.lower()
    tmp_wav = None
    wav_path = audio_path

    if suffix in VIDEO_EXTS:
        tmp_wav = extract_audio_to_wav(audio_path)
        wav_path = tmp_wav

    total_duration = 0.0
    try:
        import soundfile as sf
        info = sf.info(wav_path)
        total_duration = float(info.duration)
    except Exception:
        pass

    try:
        t0 = time.time()
        res = transcriber.transcribe(
            wav_path,
            language=language or "Chinese",
            verbose=False,
            on_progress=on_progress,
        )
        elapsed = time.time() - t0
        if total_duration <= 0.01:
            total_duration = float(res.timings.total) if hasattr(res, "timings") and res.timings else 1.0
        rtf = round(elapsed / max(total_duration, 0.001), 4)

        full_text = (res.text or "").strip()
        segments = segments_to_subtitles(res.segments)

        # 兜底：若没有 segments，按标点断句
        if not segments and full_text:
            import re
            parts = [p.strip() for p in re.split(r'([。？！\n])', full_text) if p.strip()]
            sents = []
            cur = ""
            for p in parts:
                cur += p
                if p in "。？！\n":
                    if cur.strip():
                        sents.append(cur.strip())
                    cur = ""
            if cur.strip():
                sents.append(cur.strip())
            if not sents:
                sents = [full_text]

            total_chars = max(len("".join(sents)), 1)
            cur_t = 0.0
            for s in sents:
                seg_dur = (len(s) / total_chars) * total_duration
                segments.append({
                    "from": round(cur_t, 3),
                    "to": round(cur_t + seg_dur, 3),
                    "content": s,
                })
                cur_t += seg_dur

        return segments, language or "Chinese", round(total_duration, 2), rtf, full_text

    finally:
        if tmp_wav and os.path.exists(tmp_wav):
            try:
                os.unlink(tmp_wav)
            except Exception:
                pass
