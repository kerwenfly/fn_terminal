#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 登录模式前端回归：用真实 bash（**保留 ECHO**）录下来的字节流跑本地行编辑器。
#
# 与 run_replay_test.sh 的区别：
#   1. 录制时用 !keep 保留内核回显 —— 这正是登录模式的现场（/bin/login 会把
#      termios 重置成它自己的默认值，ECHO 被重新打开）。shell 模式的夹具是
#      关掉回显录的，拿它测不出登录模式的问题。
#   2. 夹具里包含 login 阶段的合成文本（login: / Password: / motd）与真实
#      bash 字节的拼接，见 tools/gen_login_fixture.js。
#
# 用法： bash tools/run_login_test.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."          # 切到工程根
ROOT="$(pwd)"
WORK="$ROOT/tools/.replay-login"

# 被测前端的默认位置；解包验证时用 SRC=/c/temp_verify/app/www 指过去
SRC="${SRC:-app/www}"

NODE="${NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || { echo "找不到 node，可用 NODE=... 指定路径"; exit 2; }

# --- 1. 生成夹具 -------------------------------------------------------------
echo "[1/3] 生成 fixture_login.js"
"$NODE" tools/gen_login_fixture.js build || exit 3

# --- 2. 组装临时目录 ---------------------------------------------------------
echo "[2/3] 组装测试目录 $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$SRC/app.js"            "$WORK/"
cp "$SRC/terminal.css"      "$WORK/"
cp -r "$SRC/vendor"         "$WORK/"
cp tools/replay_test/__test_login.html "$WORK/"
cp tools/replay_test/fixture_login.js  "$WORK/fixture_login.js"

# --- 3. 跑无头浏览器 ---------------------------------------------------------
# 走 tools/dump_result.js：先试 Edge 的 --dump-dom；Edge 处于更新中间态
# 等情况下会静默失败，此时自动回退到 playwright-core 的 Chromium。
# file:// 的路径必须是 Windows 形式（C:/…），Git Bash 的 /c/… 会拼成
# file:////c/…，浏览器直接拒绝加载。
if command -v cygpath >/dev/null 2>&1; then
  URLPATH="$(cygpath -m "$WORK")"
else
  URLPATH="$(printf '%s' "$WORK" | sed 's#^/\([a-zA-Z]\)/#\1:/#')"
fi
RESULT="$("$NODE" tools/dump_result.js "$URLPATH/__test_login.html")"
if [ -z "$RESULT" ]; then echo "没有拿到测试结果（页面没跑起来？）"; exit 5; fi
printf '%s\n' "$RESULT"

case "$RESULT" in
  *": "[0-9]*" 通过 / 0 失败 =="*) echo "全部通过"; exit 0 ;;
  *) echo "存在失败项，见上"; exit 1 ;;
esac
