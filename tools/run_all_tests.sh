#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 一次跑齐三套回归：shell 模式前端、登录模式前端、真 Linux 后端。
#
# 各脚本本身就会在失败时返回非 0，这里只负责汇总关键行与退出码。
#
# 用法： bash tools/run_all_tests.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."

rc=0
for t in run_replay_test.sh run_login_test.sh run_backend_test.sh; do
  echo
  echo "############ $t ############"
  out="$(bash "tools/$t" 2>&1)"
  if [ $? -eq 0 ]; then
    printf '%s\n' "$out" | grep -E '^(==|===== .*通过|全部通过)' || echo "(无摘要行)"
  else
    rc=1
    printf '%s\n' "$out" | grep -E '^(FAIL|==|===== .*通过|存在失败项)' || echo "(无输出)"
  fi
done

echo
if [ "$rc" -eq 0 ]; then echo "==== 三套回归全部通过 ===="; else echo "==== 有失败项，见上 ===="; fi
exit "$rc"
