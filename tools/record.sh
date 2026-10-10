#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 在真 Linux（WSL docker-desktop）上用 rec.go 录制一份「真实 bash 字节流」夹具。
#
#   为什么非要真机：回显是否打开、readline 怎么重画、Tab 怎么补全都由真实
#   bash + 真实 termios 决定，手写模拟必然失真（历史教训：17 项失败里 16 项
#   是我把 bash 想错了）。
#
#   录完怎么用： gen_fixture.js / gen_login_fixture.js 把 JSON 转成前端夹具。
#
# 用法： bash tools/record.sh <spec.txt> <out.json>
#   例： bash tools/record.sh tools/record_echo/fixture.txt tools/record_echo/fix.json
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SPEC="$1"; OUT="$2"

[ -f "$SPEC" ] || { echo "找不到规格文件：$SPEC"; exit 2; }

# 暂存目录必须是纯 ASCII：Windows 路径带中文时，WSL 挂载点与 go 都会出问题。
STAGE="${STAGE:-C:/temp_rec}"
mkdir -p "$STAGE"
cp tools/record_echo/rec.go "$STAGE/rec.go"
cp "$SPEC"                  "$STAGE/spec.txt"
rm -f "$OUT"

# 在本机交叉编译成 linux 静态二进制（WSL 那个发行版里没有 go 工具链）
echo "[1/2] 交叉编译 rec_linux"
( cd "$STAGE" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o rec_linux ./rec.go ) \
  || { echo "编译失败"; exit 3; }

# Git Bash 会把 /c/... 之类的路径自动转换，传给 wsl 前必须关掉
echo "[2/2] 在真 Linux 上录制"
MSYS_NO_PATHCONV=1 wsl.exe -d docker-desktop -u root -e sh -c '
  set -e
  cd /mnt/host/c/temp_rec
  chmod +x rec_linux
  ./rec_linux spec.txt > out.json
  echo "录制完成"
' || { echo "录制失败"; exit 4; }

cp "$STAGE/out.json" "$OUT"
echo "已写入 $OUT"
