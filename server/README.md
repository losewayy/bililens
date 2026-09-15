# BiliLens 本地 ASR 极速语音识别服务 (Fun-ASR-Nano)

为 B 站（Bilibili）无字幕 / 生肉视频提供亚秒级（RTF ~0.025）精确时间戳逐字稿转录的本地专属推理服务。配合 **BiliLens 浏览器扩展**，实现无字幕视频一键 AI 总结与对话。

---

## 特性亮点

- **通义实验室最新 Fun-ASR-Nano 架构**：0.8B 参数极速模型，结合 ONNX 编码器与 llama.cpp GGUF 解码器。
- **自带标点与时间戳**：单模型直接生成具备精准词级/句级时间戳的结构化字幕，无需外挂额外对齐模型。
- **超低显存开销**：显存仅需约 **1GB** 即可全速运行（RTX 3060 / 4060 / 50 系列主流显卡均可畅享亚秒级转写）。
- **完全自包含**：所有 Python 推理代码开箱即用，零第三方专有框架死锁。
- **流式实时进度**：通过 NDJSON 流实时向浏览器插件推送百分比进度、段数与动态预计剩余耗时（ETA）。
- **默认独立端口**：监听 **`18765`** 端口，绝不冲突。

---

## 快速上手

### 1. 安装依赖

推荐 Python 3.10 ~ 3.12：
```bash
# 创建虚拟环境
python -m venv venv
venv\Scripts\activate   # Windows

# 安装核心依赖
pip install -r requirements.txt
```

### 2. 获取模型权重 (约 942MB)

模型包含 4 个核心文件：
- `Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx` (~443MB)
- `Fun-ASR-Nano-Decoder.q5_k.gguf` (~424MB)
- `Fun-ASR-Nano-CTC.fp16.onnx` (~75MB)
- `tokens.txt` (~1MB)

存放路径：`server/models/Fun-ASR-Nano-GGUF/`

> **特别说明**：此模型并非阿里魔搭社区原生的 PyTorch 格式，而是由开源作者 [@HaujetZhao](https://github.com/HaujetZhao) 经过深度异构拆解与量化的 ONNX fp16 (Encoder/CTC) + GGUF q5_k (Decoder) 专属版本，请勿直接从官方魔搭搜索下载原生权重。

#### 方式 A：自动化高速下载（推荐）
直接运行随仓附带的下载脚本，将自动从发布源与加速节点拉取完整模型包并解压：
```bash
python download_models.py
```

#### 方式 B：GitHub Releases 手动下载
前往 [GitHub Releases](https://github.com/losewayy/bililens/releases) 附件直接下载 `Fun-ASR-Nano-GGUF.zip` (~795MB)，解压至 `server/models/Fun-ASR-Nano-GGUF/` 目录下即可。

---

### 3. 一键启动服务

**Windows**:
双击 `start-server.bat`，或在终端执行：
```powershell
.\start-server.ps1
```

启动成功后，服务将在 `http://127.0.0.1:18765` 在线守候，此时在 B 站打开任意生肉视频，BiliLens 插件将自动识别并调度本地 GPU 进行极速转写！

---

## 接口说明

- **健康探测**: `GET /health`
- **转录接口**: `POST /api/transcribe`
  - 参数: `{ "bvid": "BV1xx411c7mD", "stream": true }`
  - 返回: NDJSON 流式进度事件与最终结构化字幕列表 `[{ from, to, content }]`。

---

## 鸣谢与致谢

- **[CapsWriter-Offline](https://github.com/HaujetZhao/CapsWriter-Offline)**（[@HaujetZhao](https://github.com/HaujetZhao)）：非常出色的离线语音识别工具，本项目本地 ASR 的推理流水线与模型适配深受其启发。
- **[FunASR](https://github.com/modelscope/FunASR)**：阿里巴巴通义实验室开源的 Fun-ASR-Nano 架构与基础模型。
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)**：提供底层的 GGUF 解码支持。
