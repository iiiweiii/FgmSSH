@echo off
REM NimbusSSH 打包脚本 - 生成 Windows 便携版 EXE
REM 需要先安装 electron-builder: npm install --save-dev electron-builder

setlocal
cd /d "%~dp0"

if not exist "node_modules\.bin\electron-builder.cmd" (
    echo 正在安装 electron-builder...
    call npm install --save-dev electron-builder --no-audit --no-fund
)

echo 开始打包为 Windows 便携版...
"./node_modules/.bin/electron-builder.cmd" --win portable
echo 打包产物: dist\NimbusSSH *.exe

endlocal