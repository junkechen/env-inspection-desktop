@echo off
chcp 65001 >nul
title GZ环保巡查管理系统 - 桌面客户端打包
echo ============================================
echo  GZ环保巡查管理系统 桌面客户端 一键打包
echo ============================================
echo.

REM 1. 检查 Node
node -v >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18+
  pause
  exit /b 1
)
echo [1/3] Node 环境 OK: 
node -v

REM 2. 安装依赖（首次会下载 Electron/Chromium，约几分钟）
if not exist node_modules (
  echo [2/3] 安装依赖中（首次较慢）...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
) else (
  echo [2/3] 依赖已存在，跳过安装
)

REM 3. 打包 EXE
echo [3/3] 开始打包 EXE（输出到 dist\）...
call npm run dist
if errorlevel 1 (
  echo [错误] 打包失败
  pause
  exit /b 1
)

echo.
echo ============================================
echo  打包完成！EXE 位于 dist\GZ环保巡查管理系统.exe
echo  双击即可在 Windows 10/11 上运行（需联网）
echo ============================================
pause
