# BiliLens 本地 ASR 极速语音识别服务启动脚本
param (
    [int]$Port = 18765,
    [string]$HostIP = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "BiliLens Local ASR Service (18765)"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $ScriptDir

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  BiliLens 本地 ASR 极速语音识别服务 (Fun-ASR-Nano-GGUF)" -ForegroundColor Cyan
Write-Host "  服务端点: http://$HostIP`:$Port" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan

# 1. 检查 Python 运行环境
$PythonExe = "python"
$VenvPython = Join-Path $ScriptDir "venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
    $PythonExe = $VenvPython
} elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
    $PythonExe = "python"
} elseif (Get-Command "py" -ErrorAction SilentlyContinue) {
    $PythonExe = "py"
} elseif (Get-Command "python3" -ErrorAction SilentlyContinue) {
    $PythonExe = "python3"
} else {
    Write-Host "错误: 系统中未检测到 Python 环境，请先安装 Python 3.10+ 并加入系统 PATH。" -ForegroundColor Red
    Read-Host "按回车键退出..."
    exit 1
}

# 2. 检查模型文件是否存在
$ModelDir = Join-Path $ScriptDir "models\Fun-ASR-Nano-GGUF"
$TokensFile = Join-Path $ModelDir "tokens.txt"

if (-not (Test-Path $TokensFile)) {
    Write-Host "`n[提示] 检测到本地尚未下载 Fun-ASR-Nano 模型权重。" -ForegroundColor Yellow
    Write-Host "正在尝试运行 download_models.py 自动高速下载并解压..." -ForegroundColor Cyan
    & $PythonExe download_models.py
}

$env:PORT = $Port.ToString()
$env:HOST = $HostIP

Write-Host "`n正在启动本地 ASR FastAPI 服务..." -ForegroundColor Green
& $PythonExe server.py
