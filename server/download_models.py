#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fun-ASR-Nano-GGUF 模型自动化下载与解压工具
下载经过 @HaujetZhao 深度重构量化的 ONNX + GGUF 专属推理权重（约 795MB zip 包，解压后约 942MB）。
支持自动解压与多源高速下载（包含 GitHub Releases 与国内加速节点）。
"""

import os
import sys
import time
import zipfile
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).parent.resolve()
MODEL_DIR = ROOT_DIR / "models" / "Fun-ASR-Nano-GGUF"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# 必须就绪的 4 个核心文件
REQUIRED_FILES = [
    "Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
    "Fun-ASR-Nano-CTC.fp16.onnx",
    "Fun-ASR-Nano-Decoder.q5_k.gguf",
    "tokens.txt",
]

# 优先从 Release 附件直接下载经过验证的完整压缩包
ZIP_URLS = [
    # 官方发布源 1 (BiliLens 自身 Release)
    "https://github.com/losewayy/bililens/releases/download/v1.0.0/Fun-ASR-Nano-GGUF.zip",
    # 国内加速镜像 1
    "https://ghproxy.net/https://github.com/losewayy/bililens/releases/download/v1.0.0/Fun-ASR-Nano-GGUF.zip",
    # 官方发布源 2 (原作者 HaujetZhao Release)
    "https://github.com/HaujetZhao/CapsWriter-Offline/releases/download/models/Fun-ASR-Nano-GGUF.zip",
    # 国内加速镜像 2
    "https://ghproxy.net/https://github.com/HaujetZhao/CapsWriter-Offline/releases/download/models/Fun-ASR-Nano-GGUF.zip",
]


def check_models_ready() -> bool:
    """检查模型是否全部就绪且非空"""
    for fname in REQUIRED_FILES:
        fpath = MODEL_DIR / fname
        if not fpath.exists() or fpath.stat().st_size < 1024 * 10:
            return False
    return True


def download_zip(urls: list, target_zip: Path) -> bool:
    """从多镜像源尝试拉取 zip 压缩包并展示动态进度条"""
    for idx, url in enumerate(urls, 1):
        print(f"\n[尝试源 {idx}/{len(urls)}] 连接: {url}")
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "*/*",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp, open(target_zip, "wb") as out:
                total = int(resp.headers.get("content-length", 0))
                downloaded = 0
                t0 = time.time()
                last_print = 0
                while True:
                    chunk = resp.read(1024 * 1024)  # 1MB 块
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    now = time.time()
                    if now - last_print > 0.5 or (total > 0 and downloaded == total):
                        last_print = now
                        elapsed = max(now - t0, 0.1)
                        speed = (downloaded / 1024 / 1024) / elapsed
                        if total > 0:
                            pct = downloaded / total * 100
                            eta = (total - downloaded) / (downloaded / elapsed) if downloaded > 0 else 0
                            print(
                                f"\r  ⬇️ 进度: {pct:5.1f}% ({downloaded/1024/1024:6.1f}MB/{total/1024/1024:6.1f}MB) "
                                f"速度: {speed:5.1f}MB/s 预计剩余: {int(eta)}s",
                                end="",
                                flush=True,
                            )
                        else:
                            print(f"\r  ⬇️ 已下载: {downloaded/1024/1024:6.1f}MB 速度: {speed:5.1f}MB/s", end="", flush=True)

                if downloaded > 1024 * 1024 * 100:  # 大于 100MB 视为有效包
                    print(f"\n✓ 压缩包下载成功 (总计 {downloaded/1024/1024:.1f} MB)！")
                    return True
                else:
                    print("\n⚠️ 下载的文件体积异常，尝试备选镜像...")
        except Exception as e:
            print(f"\n❌ 连接失败: {e}，正在切换下一镜像...")
            if target_zip.exists():
                try:
                    target_zip.unlink()
                except Exception:
                    pass

    return False


def main():
    print("=" * 60)
    print("  BiliLens Fun-ASR-Nano 本地推理模型自动化获取工具")
    print(f"  目标目录: {MODEL_DIR}")
    print("=" * 60)

    if check_models_ready():
        print("✓ 检测到所有模型文件已完整就绪，无需重复下载！")
        for f in REQUIRED_FILES:
            size = (MODEL_DIR / f).stat().st_size / 1024 / 1024
            print(f"  - {f} ({size:.1f} MB)")
        print("\n您现在可以直接运行 start-server.ps1 启动服务。")
        return

    temp_zip = ROOT_DIR / "Fun-ASR-Nano-temp.zip"
    try:
        ok = download_zip(ZIP_URLS, temp_zip)
        if not ok:
            print("\n" + "=" * 60)
            print("❌ 自动化下载未能成功连接到节点。")
            print("您也可以手动通过浏览器前往 GitHub Releases 下载并解压：")
            print("  https://github.com/losewayy/bililens/releases")
            print(f"解压后将 4 个文件放入目录：{MODEL_DIR}")
            print("=" * 60)
            sys.exit(1)

        print("\n📦 正在解压模型至目标目录...")
        with zipfile.ZipFile(temp_zip, "r") as zf:
            zf.extractall(MODEL_DIR)
        print("✓ 模型解压完成！")

    finally:
        if temp_zip.exists():
            try:
                temp_zip.unlink()
            except Exception:
                pass

    if check_models_ready():
        print("\n🎉 Fun-ASR-Nano-GGUF 模型权重已全部就绪！")
        for f in REQUIRED_FILES:
            size = (MODEL_DIR / f).stat().st_size / 1024 / 1024
            print(f"  - {f} ({size:.1f} MB)")
        print("\n您现在可以直接运行 start-server.ps1 启动服务。")
    else:
        print("\n⚠️ 解压后发现部分模型文件不完整，请检查目标目录。")


if __name__ == "__main__":
    main()
