#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 在 WSL 里跑后端回归。
#
# 为什么要绕这一圈：真实 Linux 内核 + PTY 才测得出这些行为，而工程路径
# 含中文，直接挂进 WSL 容易在参数传递上出岔子 —— 所以先把二进制和脚本
# 复制到 ASCII 路径（C:\temp_bt），再从 WSL 那边调。
#
# 用法： bash tools/run_backend_test.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAGE="/c/temp_bt"           # Git Bash 视角
WSLDIR="/mnt/host/c/temp_bt" # WSL 视角

ARCH="${ARCH:-amd64}"
BIN="app/bin/terminal-pty-linux-$ARCH"

[ -f "$BIN" ] || { echo "找不到 $BIN，先跑 build.py"; exit 2; }

rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$BIN" "$STAGE/"
cp tools/backend_regression.sh "$STAGE/"

echo "=== 后端回归（WSL: docker-desktop, $ARCH）==="
MSYS_NO_PATHCONV=1 wsl.exe -d docker-desktop -u root -e bash -c \
  "cd $WSLDIR && BIN=$WSLDIR/terminal-pty-linux-$ARCH bash backend_regression.sh"
RC=$?
echo "=== 退出码 $RC ==="
exit $RC
