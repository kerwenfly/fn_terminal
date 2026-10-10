#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 解包验证：把 fpk 里的 app.tgz 拆出来，用它里面那份 app.js 跑两套前端回归。
#
#   为什么还要跑一遍：fnpack 会统一改文件模式、构建脚本会规范化行尾，
#   打包这一步本身有可能破坏前端（历史上出过 CRLF 让 shell 报错）。
#   只用源码树里的 app.js 测，等于没测交付物。
#
# 用法： bash tools/verify_package.sh [fpk 路径]
#   默认取工作区根的 terminal_<manifest.version>_x86.fpk
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' manifest | head -1)"
FPK="${1:-$(dirname "$ROOT")/terminal_${VERSION}_x86.fpk}"
STAGE="${STAGE:-C:/temp_verify}"

[ -f "$FPK" ] || { echo "找不到 fpk：$FPK"; exit 2; }

echo "== 解包 $FPK =="
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$FPK" "$STAGE/pkg.fpk"
( cd "$STAGE" && tar xzf pkg.fpk && mkdir -p app && tar xzf app.tgz -C app ) \
  || { echo "解包失败"; exit 3; }

[ -f "$STAGE/app/www/app.js" ] || { echo "包里没有 app/www/app.js"; exit 3; }
echo "   包内版本: $(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$STAGE/manifest" | head -1)"
echo "   app.js:   $(wc -c < "$STAGE/app/www/app.js") bytes"

# 与源码树里的对照一份（防止打包时用了旧文件）
if ! diff -q "$ROOT/app/www/app.js" "$STAGE/app/www/app.js" >/dev/null 2>&1; then
  echo "   ⚠ 包内 app.js 与源码树不一致（打包用了旧文件？）"
else
  echo "   app.js 与源码树一致"
fi
# CRLF 检查：Windows 下写出 CRLF 会让 Linux 上的 shell 报 $'\r'
if grep -qU $'\r' "$STAGE/app/ui/"*.cgi 2>/dev/null; then
  echo "   ⚠ CGI 脚本里有 CRLF"; else echo "   CGI 行尾均为 LF"; fi

echo
echo "== 用包内前端跑 shell 模式回放 =="
SRC="$STAGE/app/www" bash tools/run_replay_test.sh 2>&1 | grep -E '^(==|全部通过|存在失败项)' || true

echo
echo "== 用包内前端跑登录模式回放 =="
SRC="$STAGE/app/www" bash tools/run_login_test.sh 2>&1 | grep -E '^(==|全部通过|存在失败项)' || true
