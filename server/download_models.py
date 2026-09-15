#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fun-ASR-Nano-GGUF 模型自动化高速下载脚本
从 ModelScope（魔搭社区）或镜像源高速下载 4 个核心权重文件（总计约 942MB）至 server/models/Fun-ASR-Nano-GGUF/ 目录。
"""

import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).parent.resolve()
MODEL_DIR = ROOT_DIR / "models" / "Fun-ASR-Nano-GGUF"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

FILES = [
    {
        "name": "tokens.txt",
        "size_mb": 0.95,
        "urls": [
            "https://www.modelscope.cn/api/v1/models/Haujet/CapsWriter-Offline-Models/repo?Revision=master&FilePath=Fun-ASR-Nano%2FFun-ASR-Nano-GGUF%2Ftokens.txt",
            "https://huggingface.co/Haujet/CapsWriter-Offline-Models/resolve/main/Fun-ASR-Nano/Fun-ASR-Nano-GGUF/tokens.txt",
        ],
    },
    {
        "name": "Fun-ASR-Nano-CTC.fp16.onnx",
        "size_mb": 75.0,
        "urls": [
            "https://www.modelscope.cn/api/v1/models/Haujet/CapsWriter-Offline-Models/repo?Revision=master&FilePath=Fun-ASR-Nano%2FFun-ASR-Nano-GGUF%2FFun-ASR-Nano-CTC.fp16.onnx",
            "https://huggingface.co/Haujet/CapsWriter-Offline-Models/resolve/main/Fun-ASR-Nano/Fun-ASR-Nano-GGUF/Fun-ASR-Nano-CTC.fp16.onnx",
        ],
    },
    {
        "name": "Fun-ASR-Nano-Decoder.q5_k.gguf",
        "size_mb": 424.0,
        "urls": [
            "https://www.modelscope.cn/api/v1/models/Haujet/CapsWriter-Offline-Models/repo?Revision=master&FilePath=Fun-ASR-Nano%2FFun-ASR-Nano-GGUF%2FFun-ASR-Nano-Decoder.q5_k.gguf",
            "https://huggingface.co/Haujet/CapsWriter-Offline-Models/resolve/main/Fun-ASR-Nano/Fun-ASR-Nano-GGUF/Fun-ASR-Nano-Decoder.q5_k.gguf",
        ],
    },
    {
        "name": "Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
        "size_mb": 443.0,
        "urls": [
            "https://www.modelscope.cn/api/v1/models/Haujet/CapsWriter-Offline-Models/repo?Revision=master&FilePath=Fun-ASR-Nano%2FFun-ASR-Nano-GGUF%2FFun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
            "https://huggingface.co/Haujet/CapsWriter-Offline-Models/resolve/main/Fun-ASR-Nano/Fun-ASR-Nano-GGUF/Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
        ],
    },
]


def download_file(name: str, urls: list, size_mb: float, target_path: Path):
    if target_path.exists() and target_path.stat().st_size > 1024 * 100:
        print(f"✓ [{name}] 已存在，跳过下载 ({target_path.stat().st_size / 1024 / 1024:.1f} MB)")
        return True

    print(f"⬇️ 开始下载 {name} (~{size_mb} MB)...")
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(target_path, "wb") as out:
                total = int(resp.headers.get("content-length", 0))
                downloaded = 0
                t0 = time.time()
                while True:
                    chunk = resp.read(1024 * 512)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = downloaded / total * 100
                        speed = (downloaded / 1024 / 1024) / max(time.time() - t0, 0.1)
                        print(f"\r  进度: {pct:.1f}% ({downloaded / 1024 / 1024:.1f}MB / {total / 1024 / 1024:.1f}MB) 速度: {speed:.2f} MB/s", end="", flush=True)
                print(f"\n✓ [{name}] 下载完成！")
                return True
        except Exception as e:
            print(f"\n从 {url[:40]}... 下载失败: {e}，尝试备选源...")
            if target_path.exists():
                try:
                    target_path.unlink()
                except Exception:
                    pass

    return False


def main():
    print("============================================================")
    print("  BiliLens Fun-ASR-Nano-GGUF 模型高速下载工具")
    print(f"  目标目录: {MODEL_DIR}")
    print("============================================================")

    success_all = True
    for item in FILES:
        target = MODEL_DIR / item["name"]
        ok = download_file(item["name"], item["urls"], item["size_mb"], target)
        if not ok:
            success_all = False
            print(f"❌ [{item['name']}] 下载失败！")

    if success_all:
        print("\n🎉 所有模型权重已全部就绪！您现在可以直接运行 start-server.ps1 启动服务。")
    else:
        print("\n⚠️ 部分模型下载失败。您也可以通过 GitHub Releases 附件或网盘手动下载解压至 models/ 目录。")


if __name__ == "__main__":
    main()
