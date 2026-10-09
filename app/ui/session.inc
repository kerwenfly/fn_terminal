#!/bin/bash
#
# 终端会话管理库（被 terminal.cgi 调用）
#
# 设计要点
#   fnOS 的 CGI 是「一次性进程」，每次请求都是一个新进程，进程内变量无法跨请求保存。
#   终端却要求「一次会话、多次请求」共享同一个 shell（保留 cd / env / 历史 / 补全）。
#
#   因此这里用一个自带的 Go 静态二进制 terminal-pty 建立**持久的 PTY 主从对**：
#     - 它把 shell / login 挂在一个伪终端上，PTY 的全部输出**追加**写进 out.log；
#     - 命令输入通过 FIFO（in.pipe）喂给同一个进程；
#     - 前端每次请求只做「记下当前 out.log 字节偏移 -> 写入按键 -> 返回新增输出」。
#
#   这样既拿到了真实的 TTY（颜色、补全、readline 都正常），
#   又不需要 xterm.js 的 WebSocket，纯 CGI + 轮询即可。
#
#   为什么用 Go 而不是 python3 / script：
#     - 静态编译，零运行时依赖，不受目标机 python 版本 / 是否存在影响；
#     - 目标平台是 linux arm64，交叉编译产物直接可用，不必假设系统装了 script；
#     - 显式双向搬运，不依赖任何命令的隐式行为，最可靠。
#
# 会话目录结构（$VARDIR/sessions/<sid>/）
#   pid         包装进程 PID（terminal-pty），用于会话存活判定
#   in.pipe     FIFO，向 shell 写入命令 / 按键
#   out.log     PTY 累积输出（只增不改）
#   bashrc      会话专用 shell 启动文件
#   cwd         shell 每轮结束回写的当前目录（供状态栏展示）
#   rc          shell 每轮结束回写的上一条命令退出码
#   hold.log    包装进程自身的 stderr（排障用）
#

# ---------------------------------------------------------------------------
# 目录与常量
# ---------------------------------------------------------------------------
SESS_ROOT="${TRIM_PKGVAR:-/var/apps/terminal/var}/sessions"
SHELL_BIN="/bin/bash"

# 单会话输出上限（字节），超出后保留尾部，避免日志无限增长
LOG_MAX_BYTES=5242880

# ---------------------------------------------------------------------------
# 会话生命周期：**跟随页面**，而不是跟随应用进程
#
#   产品要求：只有终端网页打开时才跑 shell，网页一关就把进程收掉。
#   实现方式是「租约 + 心跳」：
#
#     - 前端每 KEEPALIVE_TTL 秒发一次 keepalive，把 <dir>/beat 的 mtime 刷新；
#     - 网页关闭时（pagehide / beforeunload）发一次 shutdown，立即销毁会话，
#       这是「正常关闭」的快路径，几乎无延迟；
#     - 浏览器被杀 / 拔网线 / 崩溃时 shutdown 发不出去，于是靠 GC 兜底：
#       任何请求进来都顺手跑一次 sess_gc，把「心跳超过 ORPHAN_SECS 秒」
#       的会话当成孤儿清掉。
#
#   两个数值的取舍：
#     KEEPALIVE_TTL 要远小于 ORPHAN_SECS，否则网络抖一下就会误杀会话。
#     这里取 5 秒心跳 / 30 秒容忍，等于最多允许 5 次心跳丢失。
# ---------------------------------------------------------------------------
KEEPALIVE_TTL=5
ORPHAN_SECS=30

# 守护进程开关（应用停用时用）
DISABLE_FLAG="${TRIM_PKGVAR:-/var/apps/terminal/var}/.sessions_disabled"

# 建立 PTY 的方式：优先使用随包携带的 Go 静态二进制。
# 缺失时给出明确提示（不再依赖 python3 / script 这类不保证存在的组件）。
PTY_BIN_NAME="terminal-pty"
PTY_BIN=""

# ---------------------------------------------------------------------------
# 修复执行位（关键）
#
#   fnpack 打包时会把 app/ 下所有文件模式写成 0666，**执行位全部丢失**：
#     - bin/terminal-pty-linux-<arch>  不可执行 → 无法拉会话
#     - ui/*.cgi                       不可执行 → 整个 CGI 都跑不起来
#
#   install_callback / cmd/main 里的 chmod 只在安装与启动那一刻执行一次，
#   一旦被跳过（升级覆盖、应用目录被重建、手工拷贝）就永久失效。
#   因此这里在**每次请求**加载时做一次自愈，代价极小（chmod 是幂等的），
#   但能保证组件永远可用。
# ---------------------------------------------------------------------------
ensure_exec_bits() {
    local base="${TRIM_APPDEST:-/var/apps/terminal/target}"
    local f

    # PTY 组件：只要存在就补执行位（不判断 [ -x ]，否则本身就是不满足才进来的）
    for f in "${base}/bin/${PTY_BIN_NAME}" "${base}/bin/${PTY_BIN_NAME}"-linux-*; do
        [ -f "${f}" ] || continue
        [ -x "${f}" ] && continue
        chmod +x "${f}" 2>/dev/null
    done

    # CGI 自身与同目录脚本（index.cgi 已在执行中，这里主要给 terminal.cgi）
    for f in "${base}/ui/"*.cgi; do
        [ -f "${f}" ] || continue
        [ -x "${f}" ] && continue
        chmod +x "${f}" 2>/dev/null
    done
}

# 按目标架构选择二进制；文件按 <name>-linux-<arch> 存放
#
# 选取顺序很讲究：**优先按 uname -m 精确匹配**，而不是「先看有没有 terminal-pty」。
#   否则多种架构二进制并存时，可能误用一个不能运行的版本
#   （例如在 arm64 上挑到 amd64，报 Exec format error）。
resolve_pty_bin() {
    local base="${TRIM_APPDEST:-/var/apps/terminal/target}/bin"
    local arch cand=""

    arch="$(uname -m 2>/dev/null)"
    case "${arch}" in
        aarch64|arm64)       cand="${base}/${PTY_BIN_NAME}-linux-arm64" ;;
        armv7l|armv7|armhf)  cand="${base}/${PTY_BIN_NAME}-linux-arm" ;;
        x86_64|amd64)        cand="${base}/${PTY_BIN_NAME}-linux-amd64" ;;
    esac

    # 精确匹配失败时，退回到安装时落好的通用名
    if [ ! -f "${cand}" ]; then
        cand="${base}/${PTY_BIN_NAME}"
    fi

    if [ -f "${cand}" ]; then
        PTY_BIN="${cand}"
        return 0
    fi

    # 兜底：PATH 里找（开发调试用）
    if command -v "${PTY_BIN_NAME}" >/dev/null 2>&1; then
        PTY_BIN="$(command -v "${PTY_BIN_NAME}")"
        return 0
    fi
    return 1
}

# 先补执行位，再解析；两步顺序不能反
ensure_exec_bits

if resolve_pty_bin; then
    PTY_IMPL="go"
else
    PTY_IMPL="none"
fi

sess_dir() { echo "${SESS_ROOT}/$1"; }

# ---------------------------------------------------------------------------
# 校验会话 id，防止路径穿越（sid 只允许 [A-Za-z0-9_-]）
# ---------------------------------------------------------------------------
valid_sid() {
    case "$1" in
        ''|*[!A-Za-z0-9_-]*) return 1 ;;
        *) return 0 ;;
    esac
}

sess_alive() {
    local sid="$1" dir pid
    dir="$(sess_dir "$sid")"
    [ -f "${dir}/pid" ] || return 1
    pid="$(tr -d '[:space:]' < "${dir}/pid" 2>/dev/null)"
    [ -n "${pid}" ] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    return 0
}

# ---------------------------------------------------------------------------
# 创建会话
#
# 由随包的 Go 静态二进制 terminal-pty 建立 PTY：
#   terminal-pty <sess_dir> shell <login> [shell] [args...]
#   terminal-pty <sess_dir> login  [/bin/login] [args...]
#
# 参数：
#   $1 sid
#   $2 mode   shell = 直接进 shell；login = 运行 /bin/login（用户自输账号密码）
#            空 = shell
#   $3 login  shell 模式下的运行身份，空 = 当前进程身份；其它 = su -l 到该用户
#            对 mode=login 该参数被忽略
#   $4 cols   $5 rows   $6 owner（页面/tab 标识，用于「跟页面同生共死」）
# ---------------------------------------------------------------------------
sess_create() {
    local sid="$1" mode="$2" login="$3"
    local dir
    dir="$(sess_dir "$sid")"

    [ "${PTY_IMPL}" = "go" ] || return 1
    [ -n "${PTY_BIN}" ] || return 1

    mode="${mode:-shell}"
    case "${mode}" in
        shell|login) ;;
        *) mode="shell" ;;
    esac
    [ -z "${login}" ] && login=""

    mkdir -p "${dir}" 2>/dev/null || return 1
    chmod 700 "${dir}" 2>/dev/null

    # 每个会话独享的 bash 启动文件（仅 shell 模式用到）
    cat > "${dir}/bashrc" <<'BASHRC'
# 终端应用会话启动文件
export TERM=xterm-256color
export COLORTERM=truecolor
export LANG=${LANG:-en_US.UTF-8}

# 提示符：若为 root 用红色 #，否则绿色 $
if [ "$(id -u)" = "0" ]; then
    export PS1='\[\e[38;5;203m\]\u@\h\[\e[0m\]:\[\e[38;5;75m\]\w\[\e[0m\]# '
else
    export PS1='\[\e[38;5;114m\]\u@\h\[\e[0m\]:\[\e[38;5;75m\]\w\[\e[0m\]\$ '
fi

# 每渲染一次提示符，把 cwd / 退出码 / 当前身份回写到会话目录
# 注意：必须先抓住 $? —— 函数体内任何命令都会重置它
__sess_sync() {
    local __rc=$?
    printf '%s' "$PWD" > "$__SESS_DIR/cwd" 2>/dev/null
    printf '%s' "$__rc" > "$__SESS_DIR/rc" 2>/dev/null
    printf '%s' "$(id -un 2>/dev/null)" > "$__SESS_DIR/user" 2>/dev/null
}
PROMPT_COMMAND='__sess_sync'
BASHRC

    mkfifo "${dir}/in.pipe" 2>/dev/null
    : > "${dir}/out.log"
    : > "${dir}/cwd"
    : > "${dir}/rc"
    : > "${dir}/user"
    : > "${dir}/hold.log"

    printf '%s' "${mode}"  > "${dir}/mode"
    printf '%s' "${login}" > "${dir}/login"

    # 页面归属 + 心跳时间戳。owner 由前端生成（sessionStorage），
    # 同一个标签页里的所有会话共享一个 owner，关闭该标签页即可整体回收。
    printf '%s' "${6:-}" > "${dir}/owner"
    printf '%s' "$(date +%s 2>/dev/null || echo 0)" > "${dir}/created"

    # 新建会话即视为「页面在场」，立刻打一次心跳，避免刚建好就被 GC 误收
    sess_beat_file "${dir}"

    # ------------------------------------------------------------------
    # 拉起包装进程
    #
    # FIFO 细节：
    #   - 写端 open(O_WRONLY) 会阻塞到「有读端」为止；
    #   - terminal-pty 内部用 O_RDONLY|O_NONBLOCK 打开读端，立即返回。
    #   - 若在启动包装进程之前就 open 写端，本 CGI 会挂死。
    #   因此这里**不预先打开写端**，直接后台起包装进程；
    #   前端第一次写按键时再以 O_WRONLY 打开写端，此时读端必然已就绪。
    # ------------------------------------------------------------------
    local cols="${4:-80}" rows="${5:-24}"

    if [ "${mode}" = "login" ]; then
        PTY_COLS="${cols}" PTY_ROWS="${rows}" \
            setsid "${PTY_BIN}" "${dir}" login /bin/login \
            >> "${dir}/hold.log" 2>&1 &
    else
        PTY_COLS="${cols}" PTY_ROWS="${rows}" \
            setsid "${PTY_BIN}" "${dir}" shell "${login}" \
            "${SHELL_BIN}" --noprofile --rcfile "${dir}/bashrc" -i \
            >> "${dir}/hold.log" 2>&1 &
    fi
    printf '%s' "$!" > "${dir}/pid"

    # 等 pid 落盘
    local i=0
    while [ $i -lt 30 ]; do
        [ -s "${dir}/pid" ] && break
        sleep 0.1
        i=$((i + 1))
    done

    # 等待首批输出（提示符 / login: / 错误信息）
    # login 模式会比 shell 模式慢（要等 PAM 初始化），给到 8 秒
    i=0
    while [ $i -lt 80 ]; do
        [ -s "${dir}/out.log" ] && break
        # 包装进程已经退出且没有任何输出 —— 直接失败，不必空等
        sess_alive "${sid}" || {
            sleep 0.2
            [ -s "${dir}/out.log" ] && break
            return 1
        }
        sleep 0.1
        i=$((i + 1))
    done

    sleep 0.25

    # 关键判定：组件进程活着**并且**确实产出了内容才算成功。
    #
    #   login 模式有一个典型陷阱：/bin/login 需要 setuid-root，
    #   应用以非 root 运行时它会立刻打一行 "must be suid to work properly"
    #   然后退出。此时 out.log 非空但进程已死 —— 只看 out.log 会误判为成功，
    #   前端拿到一个死会话，表现为「一直停在 login:」或闪退。
    #   所以这里必须同时校验「有输出」+「进程存活」。
    [ -s "${dir}/out.log" ] || return 1
    sess_alive "$sid" || return 1
    return 0
}

# ---------------------------------------------------------------------------
# 调整 PTY 窗口尺寸
#   包装进程持有 master，理论上可以直接 ioctl(TIOCSWINSZ)；但为了与「会话内
#   实际终端」保持绝对一致，这里统一改用「在会话内部执行 stty」：
#   命令跑在真实 pts 上，写进 FIFO 即可生效，同时触发 shell 重绘提示符。
# ---------------------------------------------------------------------------
sess_resize() {
    local sid="$1" cols="$2" rows="$3"
    local dir
    dir="$(sess_dir "$sid")"
    sess_alive "$sid" || return 1

    # 参数校验，只接受合理的正整数
    case "${cols}" in ''|*[!0-9]*) return 1 ;; esac
    case "${rows}" in ''|*[!0-9]*) return 1 ;; esac
    [ "${cols}" -lt 20 ] && cols=20
    [ "${cols}" -gt 500 ] && cols=500
    [ "${rows}" -lt 5 ] && rows=5
    [ "${rows}" -gt 200 ] && rows=200

    printf '%s' "${cols}" > "${dir}/cols"
    printf '%s' "${rows}" > "${dir}/rows"

    # 在会话内改尺寸（stty 作用于当前 pts）。
    # login 模式下还没登录时没有 shell，stty 会失败 —— 无害，登录后自然生效。
    # 用 timeout 保护，避免读端异常时挂住 CGI。
    #
    # 注意 printf 的用法：格式串里的 %s 必须紧跟对应的参数，
    # 且 sh -c 的 $0 是占位符、$1/$2/$3 才是真正参数。
    timeout 3 sh -c \
        'printf "stty cols %s rows %s 2>/dev/null\r" "$1" "$2" > "$3"' \
        _ "${cols}" "${rows}" "${dir}/in.pipe" 2>/dev/null
    return 0
}

# ---------------------------------------------------------------------------
# 执行命令 / 送按键
#
# 参数：
#   $1 sid
#   $2 offset   当前前端已读到的字节偏移
#   $3 data_b64 按键流的 base64 编码（不是明文！）
#
# 为什么整条链路都用 base64：
#   shell 变量无法保存 NUL 字节，且 $() 会吃掉尾部换行；
#   若中途 decode 成明文再传递，Ctrl 组合键 / 二进制输入会被破坏。
#   因此约定「data 一路保持 base64，只在写入 FIFO 的那一刻解码一次」。
#
# 注意：窗口尺寸调整是独立的 resize 动作，不经过这里。
# ---------------------------------------------------------------------------
sess_exec() {
    local sid="$1" offset="$2" data_b64="$3"
    local dir
    dir="$(sess_dir "$sid")"
    sess_alive "$sid" || return 1

    # 原样透传按键流：base64 -d 一次写入 FIFO。
    #   1) 绝不自动补回车 —— xterm.js 逐键回调，补 \n 会「敲一个字就执行」；
    #   2) FIFO 写端 open 会阻塞到读端出现，用 timeout 兜底防止 CGI 挂死。
    if ! timeout 3 sh -c \
        'printf "%s" "$1" | base64 -d > "$2"' _ "${data_b64}" "${dir}/in.pipe" 2>/dev/null; then
        :   # 超时 / 写入失败：忽略本次输入，前端下一轮会通过 read 补齐
    fi

    # 给 shell 一点时间产出（前端会轮询补齐剩余输出）
    sleep 0.3

    sess_read "${sid}" "${offset}"
}

# ---------------------------------------------------------------------------
# 读取 offset 之后的新增输出（base64，避免二进制/换行在 JSON 里出问题）
# ---------------------------------------------------------------------------
sess_read() {
    local sid="$1" offset="$2"
    local dir size
    dir="$(sess_dir "$sid")"
    [ -d "${dir}" ] || return 1

    size=0
    [ -f "${dir}/out.log" ] && size="$(wc -c < "${dir}/out.log" 2>/dev/null | tr -d ' ')"
    [ -z "${size}" ] && size=0

    # offset 非法或超过文件长度（日志被截断过），从头重读
    case "${offset}" in
        ''|*[!0-9]*) offset=0 ;;
    esac
    [ "${offset}" -gt "${size}" ] && offset=0

    # 日志超过上限时做一次尾部保留，并同步校正 offset
    if [ "${size}" -gt "${LOG_MAX_BYTES}" ]; then
        local keep=$((LOG_MAX_BYTES / 2))
        tail -c "${keep}" "${dir}/out.log" > "${dir}/out.tmp" 2>/dev/null \
            && mv "${dir}/out.tmp" "${dir}/out.log"
        offset=0
        size="${keep}"
    fi

    local chunk_bytes=$((size - offset))
    # 单次最多回传 256KB，前端按新 offset 继续拉
    if [ "${chunk_bytes}" -gt 262144 ]; then
        chunk_bytes=262144
    fi

    local b64="" new_offset="${size}"
    if [ "${chunk_bytes}" -gt 0 ]; then
        b64="$(tail -c +$((offset + 1)) "${dir}/out.log" 2>/dev/null | head -c "${chunk_bytes}" | base64 | tr -d '\n')"
        new_offset=$((offset + chunk_bytes))
    fi

    local cwd rc alive user
    cwd="$(cat "${dir}/cwd" 2>/dev/null)"
    rc="$(cat "${dir}/rc" 2>/dev/null)"
    user="$(cat "${dir}/user" 2>/dev/null)"
    if sess_alive "${sid}"; then alive="true"; else alive="false"; fi

    _OUT_OFFSET="${new_offset}"
    _OUT_B64="${b64}"
    _OUT_CWD="${cwd}"
    _OUT_RC="${rc}"
    _OUT_USER="${user}"
    _OUT_ALIVE="${alive}"
}

sess_close() {
    local sid="$1" dir pid
    dir="$(sess_dir "$sid")"
    [ -d "${dir}" ] || return 0

    if [ -f "${dir}/pid" ]; then
        pid="$(tr -d '[:space:]' < "${dir}/pid" 2>/dev/null)"
        case "${pid}" in
            ''|*[!0-9]*) pid="" ;;
        esac
        if [ -n "${pid}" ]; then
            # ------------------------------------------------------------------
            # 杀整个会话进程组，连同 shell 及其子进程。
            #
            # 实测结论（务必保留这套三段式）：terminal-pty 为了不被终端的
            # 挂断信号带走，会**忽略 SIGHUP / SIGTERM**，所以只发 TERM 是
            # 杀不掉的（进程会一直挂在 S 状态）。必须补一发 SIGKILL。
            #   - 先 TERM：给进程一个「主动收尾」的机会（它自己会清理 PTY）；
            #   - 等 0.5s：TERM 对普通子进程（bash / login）通常立刻生效；
            #   - 再 KILL：对忽略 TERM 的包装进程兜底，这是最关键的收尾；
            #   - 最后再确认一次，仍在就补第二发 KILL（对付极端慢的调度）。
            # 负号是「进程组」，保证 bash 里再 fork 出来的子进程一起走。
            # ------------------------------------------------------------------
            kill -TERM -"${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null
            sleep 0.5
            kill -KILL -"${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null

            # 收尾确认：极少数情况下 0.5s 内还没调度到，再补一发
            if kill -0 "${pid}" 2>/dev/null; then
                sleep 0.3
                kill -KILL -"${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null
            fi
        fi
    fi
    rm -rf "${dir}" 2>/dev/null
    return 0
}

# ---------------------------------------------------------------------------
# 心跳 / 存活期管理
#
#   beat 文件的内容不重要，**mtime** 才是心跳时间戳。
#   用 touch 刷新而不是写文件内容，是因为 mtime 更新是原子的、不产生 IO 抖动。
# ---------------------------------------------------------------------------
sess_beat_file() {
    # $1 = 会话目录
    touch "$1/beat" 2>/dev/null
}

sess_beat() {
    # $1 = sid
    local dir
    dir="$(sess_dir "$1")"
    [ -d "${dir}" ] || return 1
    sess_beat_file "${dir}"
    return 0
}

# ---------------------------------------------------------------------------
# 按 owner 回收：关闭某个页面（标签页）时，把它名下的会话全部销毁
#
#   前端在 pagehide 里带上 owner 调 shutdown，这里按 owner 批量清。
#   owner 为空时退化为「只清理本次调用方自己的会话」——
#   即由调用方传 sid 走 sess_close。
# ---------------------------------------------------------------------------
sess_kill_by_owner() {
    local owner="$1" d o
    [ -n "${owner}" ] || return 0
    [ -d "${SESS_ROOT}" ] || return 0
    for d in "${SESS_ROOT}"/*; do
        [ -d "${d}" ] || continue
        o="$(cat "${d}/owner" 2>/dev/null)"
        [ "${o}" = "${owner}" ] || continue
        sess_close "$(basename "${d}")"
    done
    return 0
}

# ---------------------------------------------------------------------------
# 垃圾回收（孤儿会话）
#
#   两类要被清掉：
#     1) 进程已死 —— 目录只剩残留文件，直接删。
#     2) 进程还活着，但**心跳过期** —— 说明网页已经关掉/崩溃/断网，
#        没人再认领这个 shell 了。这正是「程序关闭后关闭进程」的兜底路径：
#        前端正常关闭时会走 shutdown 立即回收；异常关闭时靠这里在
#        ORPHAN_SECS 秒内把进程收掉，不会留下野 shell。
#
#   同时顺带清理超过 12 小时无输出的正常会话（真正的空闲回收）。
# ---------------------------------------------------------------------------
sess_gc() {
    local d sid now mtime age
    [ -d "${SESS_ROOT}" ] || return 0
    now="$(date +%s 2>/dev/null || echo 0)"

    for d in "${SESS_ROOT}"/*; do
        [ -d "$d" ] || continue
        sid="$(basename "$d")"

        if ! sess_alive "${sid}"; then
            # 进程已死，直接清掉目录
            rm -rf "$d" 2>/dev/null
            continue
        fi

        # 心跳过期判定：优先看 beat，其次退回到 out.log 的 mtime
        mtime=0
        if [ -f "${d}/beat" ]; then
            mtime="$(stat -c %Y "${d}/beat" 2>/dev/null \
                || stat -f %m "${d}/beat" 2>/dev/null || echo 0)"
        fi
        if [ -z "${mtime}" ] || [ "${mtime}" = "0" ]; then
            if [ -f "${d}/out.log" ]; then
                mtime="$(stat -c %Y "${d}/out.log" 2>/dev/null \
                    || stat -f %m "${d}/out.log" 2>/dev/null || echo 0)"
            fi
        fi
        [ -z "${mtime}" ] && mtime=0

        if [ "${mtime}" -gt 0 ]; then
            age=$((now - mtime))

            # 心跳过期 -> 页面已不在，回收（这是「跟页面同生共死」的兜底）
            if [ "${age}" -gt "${ORPHAN_SECS}" ]; then
                sess_close "${sid}"
                continue
            fi

            # 兜底的空闲回收：12 小时没有任何输出
            if [ "${age}" -gt 43200 ]; then
                sess_close "${sid}"
                continue
            fi
        fi
    done
    return 0
}
