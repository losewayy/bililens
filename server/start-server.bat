@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BiliLens Local ASR Service (18765)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
pause
