# -*- coding: utf-8 -*-
"""
BiliLens 本地 ASR 引擎自包含日志与控制台输出模块
"""

import logging
import sys

logger = logging.getLogger("bililens.asr")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", "%H:%M:%S"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

console = logger


def setup_logging():
    return logger
