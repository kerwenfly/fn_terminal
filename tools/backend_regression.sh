#!/bin/bash
# ---------------------------------------------------------------------------
# 后端回归：验证「会话建立即关回显 + ctl.pipe 的 echo/尺寸 + 交棒通道 + 回收」。
#
# 必须在真实 Linux 上跑（要 mkfifo / 真 PTY）。Windows 侧用
#     bash tools/run_backend_test.sh
# 调起 WSL 执行本脚本。
#
# 为什么要断言「关回显」：整个本地行编辑器的架构就架在这条上 ——
# 只有服务端彻底不画输入行，前端才能独占显示而不重复。
# 为什么要断言「bind -x 报告」：关回显之后 Tab / ↑ 自己一个字节都不吐，
# 补全结果与历史行只能靠 bash 报回来，这是交棒通道唯一的可行性依据。
#
# 三个踩过的坑，改这个脚本时留意：
#   · 判定 echo 标志千万别用 `grep -- "-echo"` —— `-echonl` / `-echoprt`
#     都含这个子串，无论开关都会命中（曾据此误判「已关闭」，白查半天）。
#   · 取文本时**不能**先 `cat -v` —— 它把 CR 变成两个字符 "^M"，
#     后面再 `tr -d '\r'` 就删不掉了，`grep -x` 于是永远匹配不上。
#   · 各段之间务必把当前行清掉，否则 Tab 补出来的 `cd /tmp/` 会和下一段
#     的命令粘成一条，产出 `cd: too many arguments` 这种假失败。
# ---------------------------------------------------------------------------
BIN="${BIN:-/mnt/host/c/temp_bt/terminal-pty-linux-amd64}"
ROOT="${ROOT:-/tmp/bt}"

pass=0; fail=0
ok() {                                  # ok <名字> <0=通过> <说明...>
  if [ "$2" = 0 ]; then pass=$((pass+1)); echo "PASS  $1"
  else fail=$((fail+1)); echo "FAIL  $1"; shift 2; echo "        $*"; fi
}

rm -rf "$ROOT"; mkdir -p "$ROOT"

start() {                               # start <名字>
  D="$ROOT/$1"; mkdir -p "$D"
  mkfifo "$D/in.pipe" "$D/ctl.pipe" 2>/dev/null
  : > "$D/out.log"; : > "$D/history"
  PTY_COLS=80 PTY_ROWS=24 HISTFILE="$D/history" \
    setsid "$BIN" "$D" shell "" /bin/bash --norc --noprofile -i \
    >"$D/hold.log" 2>&1 &
  PID=$!
  SESSDIR="$D"
  disown 2>/dev/null || true     # 免得后面 kill 时刷一堆 "Killed" 作业通知
  local i=0
  while [ "$i" -lt 30 ]; do [ -s "$D/out.log" ] && break; sleep 0.1; i=$((i+1)); done
  sleep 0.4
}

send()   { printf '%s' "$1" > "$SESSDIR/in.pipe"; }
sendln() { printf '%s' "$1" > "$SESSDIR/in.pipe"; sleep 0.05; printf '\r' > "$SESSDIR/in.pipe"; }
typed()  { local s="$1" i; for ((i=0;i<${#s};i++)); do send "${s:$i:1}"; sleep 0.05; done; }
ctl()    { printf '%s\n' "$1" > "$SESSDIR/ctl.pipe"; sleep 0.5; }
clear_out() { : > "$SESSDIR/out.log"; }
size()   { stat -c %s "$SESSDIR/out.log"; }
out()    { cat -v "$SESSDIR/out.log"; }          # 转义可见，给人看
out_text() { tr -d '\r' < "$SESSDIR/out.log"; }  # 纯文本，给 grep 用

# 清掉当前输入行（Ctrl-U + 空回车），让下一段从干净的一行开始
reset_line() { send $'\x15'; sleep 0.1; send $'\r'; sleep 0.6; }

# echo 标志：把 stty -a 的字段拆成单词后精确匹配
echo_flag() {
  clear_out
  sendln 'stty -a | tr " ;" "\n\n" | grep -x -e echo -e -echo | head -1'
  sleep 0.7
  out_text | grep -x -e echo -e -echo | tail -1
}

# 这个会话还剩几个进程（按 cmdline 里的会话目录精确匹配；
# 不要用 pgrep -f，那会命中所有历史测试目录的残留进程）
alive_count() {
  local n=0 p
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    if tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "$SESSDIR"; then n=$((n+1)); fi
  done
  echo "$n"
}

kill_session() {
  kill -TERM -"$1" 2>/dev/null; sleep 0.5
  kill -KILL -"$1" 2>/dev/null; sleep 0.3
}

echo "===== 后端回归（$BIN）====="
echo

# --------------------------------------------------------------------------
# 1. 会话刚建好就是关回显的
# --------------------------------------------------------------------------
echo "--- 1. 建会话即关回显 ---"
start a
echo "        tty 里的 echo 标志 = $(echo_flag)   （应为 -echo）"
clear_out
send 'l'; sleep 0.3
send 's'; sleep 0.4
N=$(size)
ok "1a 关回显：打 ls 服务端零字节" "$([ "$N" = 0 ] && echo 0 || echo 1)" \
   "实际 $N 字节: $(od -c "$SESSDIR/out.log" | head -2 | tr '\n' ' ')"
reset_line

# 区分键：readline 的回显是 "\b\e[K"，内核回显是 "^?"（或 BS-SPC-BS）
clear_out
send 'a'; sleep 0.15; send 'b'; sleep 0.15; send $'\x7f'; sleep 0.4
R=$(out)
ok "1b 退格也没有 readline 风格的 [K 重绘" \
   "$(echo "$R" | grep -qF '[K' && echo 1 || echo 0)" "$R"
reset_line

# --------------------------------------------------------------------------
# 2. echo 开关：对「readline 行」和「非 readline 读取」效果完全不同
#
#    实测（bash 5.2）：
#      · readline 行（普通提示符）：readline 自己把 ECHO 清掉并锁存
#        (_rl_echoing_p)，ctl `echo 1` 改不动它 —— 打字**仍然零字节**。
#        这一条正是整个交棒架构（bind -x + OSC 报告）的存在理由：
#        「临时把回显打开一下」这条路是死的。
#      · 非 readline 读取（read -p / heredoc）：回显完全由内核 ECHO 位决定，
#        ctl `echo 1` 能恢复回显，`echo 0` 能让它闭嘴。
#        这是留给内核回显类程序的口子（前端目前只用 on:0，on:1 供排障）。
# --------------------------------------------------------------------------
echo "--- 2. echo 开关对两类输入的不同效果 ---"

# 2a：readline 行救不回来
ctl 'echo 1'
FLAG=$(echo_flag)
reset_line
clear_out
send 'l'; sleep 0.3
send 's'; sleep 0.4
N=$(size)
ok "2a readline 行：ctl echo 1 之后打字仍然静默" "$([ "$N" = 0 ] && echo 0 || echo 1)" \
   "实际 $N 字节（stty 里的标志=$FLAG）"
reset_line

# 2b：非 readline 读取 —— 先确认关着的时候一个字节都不回
ctl 'echo 0'
sendln "read -p 'Name: ' n; echo DONE"
sleep 0.8
clear_out
send 'b'; sleep 0.25; send 'o'; sleep 0.25; send 'b'; sleep 0.4
N=$(size)
ok "2b read -p 等待中：回显关闭 => 零字节（前端必须本地兜底）" \
   "$([ "$N" = 0 ] && echo 0 || echo 1)" "实际 $N 字节"

# 2c：read 还在等待，这一刻用 ctl 打开 —— 内核回显应该立刻生效
ctl 'echo 1'
clear_out
send 'x'; sleep 0.25; send 'y'; sleep 0.4
N=$(size)
ok "2c read -p 等待中：ctl echo 1 => 内核回显恢复" \
   "$([ "$N" -gt 0 ] && echo 0 || echo 1)" "实际 $N 字节"
send $'\r'; sleep 0.8            # 结束这次 read
ctl 'echo 0'
reset_line

# --------------------------------------------------------------------------
# 3. 关回显下 Tab 补全能通过 bind -x 报回来（交棒通道的立命之本）
# --------------------------------------------------------------------------
echo "--- 3. 关回显下 Tab / 历史 仍能通过 bind -x 报回来 ---"
sendln 'bind -x '"'"'"\C-x\C-r": printf "\033]777;%s;%s\007" "$READLINE_LINE" "$READLINE_POINT"'"'"';history -d $((HISTCMD-1)) 2>/dev/null'
sleep 1.0
reset_line
# 先制造一条历史，供后面 ↑ 用
typed 'echo hi'; send $'\r'; sleep 0.8
reset_line

clear_out
typed 'cd /tm'
send $'\t'; sleep 0.05
send $'\x18\x12'; sleep 1.0        # 交棒：Tab + 报告键
RAW=$(out)
ok "3a Tab 补全后的行被报回来了" \
   "$(echo "$RAW" | grep -qF ']777;cd /tmp/;8' && echo 0 || echo 1)" "$RAW"

reset_line
clear_out
send $'\x1b[A'; sleep 0.05
send $'\x18\x12'; sleep 1.0
RAW=$(out)
ok "3b ↑ 取到的历史行被报回来了" \
   "$(echo "$RAW" | grep -qF ']777;echo hi;7' && echo 0 || echo 1)" "$RAW"
reset_line

# --------------------------------------------------------------------------
# 4. 尺寸指令仍然有效
# --------------------------------------------------------------------------
echo "--- 4. ctl.pipe 的尺寸指令 ---"
ctl '120 40'
clear_out
sendln 'stty -a | tr ";" "\n" | grep -E "rows|columns" | tr -d " " | tr "\n" "|"'
sleep 0.8
SZ=$(out_text | grep -o 'rows[0-9]*|columns[0-9]*' | tail -1)
ok "4a 尺寸改成 120x40" "$([ "$SZ" = 'rows40|columns120' ] && echo 0 || echo 1)" "抓到 '$SZ'"
reset_line

ctl '80 24'
kill_session "$PID"

# --------------------------------------------------------------------------
# 5. 三段式回收：TERM -> KILL，进程组里一个都不能剩
# --------------------------------------------------------------------------
echo "--- 5. 进程回收 ---"
start b
BEFORE=$(alive_count)
ok "5a 会话起来时进程存在" "$([ "$BEFORE" -gt 0 ] && echo 0 || echo 1)" "count=$BEFORE"

# 包装进程里 signal.Ignore 了 SIGHUP/SIGINT/SIGQUIT/SIGTERM，
# 只发 TERM 是杀不掉的，所以必须补 KILL
kill -TERM -"$PID" 2>/dev/null
sleep 0.6
AFTER_TERM=$(alive_count)
echo "        （只发 TERM 之后仍存活 $AFTER_TERM 个 —— 预期 >0，这正是要补 KILL 的原因）"

kill -KILL -"$PID" 2>/dev/null
sleep 0.5
AFTER=$(alive_count)
ok "5b KILL 之后进程组清空" "$([ "$AFTER" = 0 ] && echo 0 || echo 1)" "count=$AFTER"

echo
echo "===== 后端回归: $pass 通过 / $fail 失败 ====="
[ "$fail" = 0 ] || exit 1
