#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 回放式前端回归：用真实 bash 录下来的字节流跑本地行编辑器。
#
# 为什么不用手写模拟：早期用手写的假 bash 行为做断言，17 项失败里有 16 项
# 其实是我把 bash 想错了（凭空吐出 "atmp/"、ls -la 之类）。改成「录制真实字节
# 再回放」之后，断言才有意义。录制方法见 tools/record_echo/fixture.txt。
#
# 步骤：录制的 fix.json + fixture.txt --(gen_fixture.js)--> fixture.js
#       组装临时目录（app.js + vendor + 测试页 + fixture.js）
#       无头浏览器跑 __test.html，抓 <pre id="RESULT">
#
# 用法： bash tools/run_replay_test.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."          # 切到工程根
ROOT="$(pwd)"
WORK="$ROOT/tools/.replay"

# 被测前端的默认位置；解包验证时用 SRC=/c/temp_verify/app/www 指过去
SRC="${SRC:-app/www}"

NODE="${NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || { echo "找不到 node，可用 NODE=... 指定路径"; exit 2; }

# --- 1. 生成夹具 -------------------------------------------------------------
echo "[1/3] 生成 fixture.js"
"$NODE" tools/gen_fixture.js tools/record_echo/fixture.txt tools/record_echo/fix.json \
        "$ROOT/tools/.fixture.js" || exit 3

# --- 2. 组装临时目录 ---------------------------------------------------------
echo "[2/3] 组装测试目录 $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$SRC/app.js"            "$WORK/"
cp "$SRC/terminal.css"      "$WORK/"
cp -r "$SRC/vendor"         "$WORK/"
cp tools/replay_test/__test.html "$WORK/"
cp "$ROOT/tools/.fixture.js" "$WORK/fixture.js"

# --- 3. 跑无头浏览器 ---------------------------------------------------------
# 走 tools/dump_result.js：先试 Edge 的 --dump-dom；Edge 处于更新中间态
# （Application 目录下并存两个版本）等情况下会静默失败，此时自动回退到
# playwright-core 的 Chromium。详见 dump_result.js 头注释。
# file:// 的路径必须是 Windows 形式（C:/…），Git Bash 的 /c/… 会拼成
# file:////c/…，浏览器直接拒绝加载。
if command -v cygpath >/dev/null 2>&1; then
  URLPATH="$(cygpath -m "$WORK")"
else
  URLPATH="$(printf '%s' "$WORK" | sed 's#^/\([a-zA-Z]\)/#\1:/#')"
fi
RESULT="$("$NODE" tools/dump_result.js "$URLPATH/__test.html")"
if [ -z "$RESULT" ]; then echo "没有拿到测试结果（页面没跑起来？）"; exit 5; fi
printf '%s\n' "$RESULT"

case "$RESULT" in
  *": "[0-9]*" 通过 / 0 失败 =="*) echo "全部通过"; exit 0 ;;
  *) echo "存在失败项，见上"; exit 1 ;;
esac
