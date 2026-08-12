@echo off
REM NimbusSSH 启动脚本
REM 自动清理冲突环境变量并启动应用
REM 兼容 远程桌面 / WSL / 容器 等无 GPU 沙箱环境

setlocal
cd /d "%~dp0"

REM 清理可能干扰 Electron 的环境变量
set NODE_OPTIONS=
set ELECTRON_RUN_AS_NODE=

REM 启动 Electron (兼容模式: 禁用 GPU + 沙箱)
"./node_modules/electron/dist/electron.exe" . --disable-gpu --no-sandbox

endlocal