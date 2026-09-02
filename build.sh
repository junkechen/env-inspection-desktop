#!/usr/bin/env bash
set -e
echo "============================================"
echo " GZ环保巡查管理系统 桌面客户端 一键打包"
echo "============================================"
echo

echo "[1/3] 检查 Node"
node -v

echo "[2/3] 安装依赖（首次会下载 Electron，较慢）"
if [ ! -d node_modules ]; then
  npm install
else
  echo "依赖已存在，跳过安装"
fi

echo "[3/3] 打包 EXE（输出到 dist/）"
npm run dist

echo
echo "打包完成！EXE 位于 dist/GZ环保巡查管理系统.exe"
