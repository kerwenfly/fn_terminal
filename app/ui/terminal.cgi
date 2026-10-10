#!/bin/bash
#
# 终端 CGI —— 所有终端操作的唯一入口
#
#   浏览器侧                        动作
#   /cgi/ThirdParty/terminal/terminal.cgi/create        新建 PTY 会话
#   /cgi/ThirdParty/terminal/terminal.cgi/exec          执行命令 / 送按键
#   /cgi/ThirdParty/terminal/terminal.cgi/read          拉取新增输出（支持长轮询 wait）
#   /cgi/ThirdParty/terminal/terminal.cgi/resize        调整窗口尺寸
#   /cgi/ThirdParty/terminal/terminal.cgi/echo          开关 tty 回显（本地回显配套）
#   /cgi/ThirdParty/terminal/terminal.cgi/keepalive     页面心跳（证明页面还开着）
#   /cgi/ThirdParty/terminal/terminal.cgi/shutdown      页面关闭 -> 销毁其全部会话
#   /cgi/ThirdParty/terminal/terminal.cgi/close         关闭并销毁单个会话
#   /cgi/ThirdParty/terminal/terminal.cgi/info          会话状态（cwd / 退出码 / 存活）
#
# 两条贯穿全链路的性能约定（与「输入手感」直接相关）：
#
#   1) read 支持**长轮询**（请求体带 wait 毫秒）。
#      后端挂住直到有新输出或超时，前端拿到响应立刻再发下一轮 ——
#      于是「总有一次 read 在途」，回显一产生就被带走。
#      旧实现是固定 400ms 轮询，最坏要白等 400ms 才轮到下一次。
#
#   2) exec 是每次按键都要走的路径，必须保持**极轻**：
#      只写 FIFO，不回读、不跑 GC、不拼状态字段。
#      （实测去掉这些后单次 exec 从 143ms 降到 55ms，见 session.inc 的说明。）
#
# 「会话跟随页面」的约定：
#   前端为每个标签页生成一个 owner（sessionStorage，标签页内共享、关闭即失效）。
#   页面每几秒发一次 keepalive 续租；页面关闭时发 shutdown 立刻回收。
#   若页面异常消失（崩溃/断网），shutdown 发不出去，则由 sess_gc 按心跳超时兜底，
#   因此除 exec 之外的每个请求进来都会先跑一次 sess_gc。
#
# 请求体为 JSON；响应统一 application/json。
# 终端输出以 base64 承载（原始 PTY 流含 ANSI 转义与二进制），前端还原成文本。
#

APP_NAME="terminal"
APP_DIR="/var/apps/${APP_NAME}/target"
VAR_DIR="/var/apps/${APP_NAME}/var"

# 优先使用飞牛注入的环境变量，避免路径硬编码
[ -n "${TRIM_APPDEST}" ] && APP_DIR="${TRIM_APPDEST}"
[ -n "${TRIM_PKGVAR}" ] && VAR_DIR="${TRIM_PKGVAR}"

export TRIM_APPDEST="${APP_DIR}"
export TRIM_PKGVAR="${VAR_DIR}"

mkdir -p "${VAR_DIR}/sessions" 2>/dev/null

. "${APP_DIR}/ui/session.inc"

# ---------------------------------------------------------------------------
# 读取请求体
# ---------------------------------------------------------------------------
BODY=""
if [ "${REQUEST_METHOD}" = "POST" ]; then
    BODY="$(cat 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# 极简 JSON 取值（避免依赖 jq / python，fnOS 上不一定有）
#   仅满足本接口的固定字段，够用且无外部依赖。
#
#   取**第一个**匹配（旧的 sed 贪心写法匹配的是最后一个）：
#   前端 payload 固定把 data（按键流 base64）放在其它字段之后，若 data
#   的内容里恰好出现 "sid":"x" 这类文本，贪心匹配会把 sid 解析成假值。
#   真实字段都在 data 之前出现，首匹配命中的必然是真实字段。
# ---------------------------------------------------------------------------
json_str() {
    # $1 = json, $2 = key
    local json="$1" key="$2" out
    out="$(printf '%s' "${json}" | awk -v k="\"${key}\"" '{
        i = index($0, k)
        if (i > 0) {
            rest = substr($0, i + length(k))
            sub(/^[[:space:]]*:[[:space:]]*"/, "", rest)
            n = index(rest, "\"")
            if (n > 1) { print substr(rest, 1, n - 1); exit }
        }
    }')"
    printf '%s' "${out}"
}

json_num() {
    local json="$1" key="$2" out
    out="$(printf '%s' "${json}" | awk -v k="\"${key}\"" '{
        i = index($0, k)
        if (i > 0) {
            rest = substr($0, i + length(k))
            sub(/^[[:space:]]*:[[:space:]]*/, "", rest)
            if (match(rest, /^[0-9]+/)) { print substr(rest, RSTART, RLENGTH); exit }
        }
    }')"
    [ -z "${out}" ] && out=0
    printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# 解析 action：fnOS 把 /xxx.cgi/<action> 放进 PATH_INFO，REQUEST_URI 兜底
# ---------------------------------------------------------------------------
ACTION=""
if [ -n "${PATH_INFO}" ]; then
    ACTION="${PATH_INFO##*terminal.cgi/}"
    ACTION="${ACTION%%\?*}"
    ACTION="${ACTION%%/*}"
fi
if [ -z "${ACTION}" ] && [ -n "${REQUEST_URI}" ]; then
    ACTION="${REQUEST_URI##*terminal.cgi/}"
    ACTION="${ACTION%%\?*}"
    ACTION="${ACTION%%/*}"
fi

# ---------------------------------------------------------------------------
# 响应助手
# ---------------------------------------------------------------------------
json_head() {
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache, no-store, must-revalidate"
    echo ""
}

jstr() {
    # 转义 JSON 字符串：反斜杠、引号、控制字符
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="$(printf '%s' "${s}" | tr -d '\000-\010\013\014\016-\037')"
    printf '%s' "${s}"
}

fail() {
    json_head
    echo "{\"ok\":false,\"error\":\"$(jstr "$1")\"}"
    exit 0
}

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
SID="$(json_str "${BODY}" "sid")"
OFFSET="$(json_num "${BODY}" "offset")"

# 长轮询等待时长（毫秒）。
#   前端传 2500 左右，后端会挂住最多这么久，一有新输出立刻返回。
#   0 = 立刻返回（老的纯轮询行为），缺省即 0，保证向后兼容。
WAIT="$(json_num "${BODY}" "wait")"

# 页面（标签页）标识。前端每个标签页生成一个，用于「关页面即回收会话」。
# 只允许 [A-Za-z0-9_-]，防止被当成路径片段使用。
OWNER="$(json_str "${BODY}" "owner")"
case "${OWNER}" in
    *[!A-Za-z0-9_-]*) OWNER="" ;;
esac

# 命令体：base64 传入，避免前端 JSON 转义地狱（换行/引号/反斜杠）。
#
# 重要：这里**保持 base64 原样**，不做解码。
#   原因有二：
#     1) 一旦 base64 -d 再放进 shell 变量，NUL 字节会丢失、尾部换行会被
#        $() 吃掉，Ctrl 组合键等二进制输入会被破坏；
#     2) 会与 session.inc 里的解码叠加，变成「双重解码」→ 输入变乱码。
#   因此约定：data 在整条链路上始终是 base64，只在最后写入 FIFO 时解码一次。
DATA_B64="$(json_str "${BODY}" "data")"

# ---------------------------------------------------------------------------
# 顺手做一次 GC：
#   把「进程已死」的残留目录，以及「心跳过期（页面已关）」的孤儿会话清掉。
#   shutdown 是正常关闭的快路径；这里是不正常关闭（崩溃/断网/强杀浏览器）的兜底。
#
# 唯一的例外是 exec —— 它是「每敲一个键都要走」的路径，GC 在这里纯属浪费
# （实测约 19ms，占单次按键后端开销的 1/7 左右）。
# 不影响回收能力：read 是长轮询，页面开着时**总有一个在途**（约 1.5 秒一轮），
# 另外 create / keepalive / shutdown 等也都照跑，孤儿依然会被收掉。
# ---------------------------------------------------------------------------
if [ "${ACTION}" != "exec" ]; then
    sess_gc >/dev/null 2>&1
fi

# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------
case "${ACTION}" in

    # ---------------- 新建会话 ----------------
    create)
        if [ "${PTY_IMPL}" != "go" ]; then
            # 带上现场信息，方便一眼看出是「文件不存在」还是「没执行位」
            _BIN_HINT="${TRIM_APPDEST:-/var/apps/terminal/target}/bin"
            fail "终端组件不可用（${_BIN_HINT}，架构 $(uname -m)）。请卸载后重新安装应用"
        fi
        sess_gc >/dev/null 2>&1
        SID="s$(date +%s%N 2>/dev/null || date +%s)$$"
        SID="$(printf '%s' "${SID}" | tr -dc 'A-Za-z0-9_-')"

        # 模式：login = 走 /bin/login（用户自己输账号密码）；其它 = 直接进 shell
        MODE="$(json_str "${BODY}" "mode")"
        case "${MODE}" in
            login) ;;
            *) MODE="shell" ;;
        esac

        # shell 模式下的运行身份：空 = 当前进程身份；否则为用户名
        LOGIN="$(json_str "${BODY}" "login")"
        # 只允许合法用户名（字母数字下划线点横线），防止命令注入
        case "${LOGIN}" in
            *[!A-Za-z0-9_.-]*) LOGIN="" ;;
        esac

        # 初始窗口尺寸（前端 fit 之后会再发一次 resize）
        COLS="$(json_num "${BODY}" "cols")"
        ROWS="$(json_num "${BODY}" "rows")"
        [ "${COLS}" -lt 20 ] && COLS=80
        [ "${ROWS}" -lt 5 ] && ROWS=24

        if sess_create "${SID}" "${MODE}" "${LOGIN}" "${COLS}" "${ROWS}" "${OWNER}"; then
            sess_read "${SID}" 0
            json_head
            printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","mode":"%s","login":"%s","data":"%s"}\n' \
                "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
                "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" \
                "$(jstr "${MODE}")" "$(jstr "${LOGIN}")" "${_OUT_B64}"
        else
            # 把组件自己的报错带出去（例如 login 的 "must be suid"），
            # 不要笼统说「无法启动终端组件」——那样根本查不出原因。
            _ERR="$(head -c 300 "${SESS_ROOT}/${SID}/out.log" 2>/dev/null | tr -d '\r\n')"
            _HOLD="$(head -c 300 "${SESS_ROOT}/${SID}/hold.log" 2>/dev/null | tr -d '\r\n')"
            _DETAIL="${_ERR}${_HOLD}"
            [ -z "${_DETAIL}" ] && _DETAIL="终端组件无输出"

            # login 模式最常见的失败：/bin/login 需要 setuid-root，
            # 而应用以非 root 运行时无法通过认证。给出可操作的提示。
            case "${_DETAIL}" in
                *suid*|*setuid*)
                    _HINT="账号登录需要应用以 root 身份运行（当前身份 $(id -un)）。请在应用中心重装本应用"
                    ;;
                *)
                    _HINT="当前身份 $(id -un)"
                    ;;
            esac
            rm -rf "${SESS_ROOT}/${SID}" 2>/dev/null
            fail "无法启动终端会话（${_HINT}）：${_DETAIL}"
        fi
        ;;

    # ---------------- 执行/送按键 ----------------
    exec)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        [ -n "${DATA_B64}" ] || fail "缺少 data"
        sess_beat "${SID}"   # 有交互 -> 刷新心跳，等同「页面还在」
        if ! sess_alive "${SID}"; then
            json_head
            printf '{"ok":false,"error":"会话已结束","alive":false}\n'
            exit 0
        fi
        # 传入 base64（sess_exec 内部解码一次后写入 PTY）
        if ! sess_exec "${SID}" "${OFFSET}" "${DATA_B64}"; then
            json_head
            printf '{"ok":false,"error":"写入失败","alive":false}\n'
            exit 0
        fi
        # 只回执「写入成功」。刻意不返回 data / cwd / rc / user：
        #   · data 前端本来就一律丢弃（输出只走 read 这一条单通道）；
        #   · cwd / rc / user 会由紧随其后的长轮询 read 带回状态栏，
        #     这边省掉一整轮读盘 —— 这是按键手感的关键路径。
        json_head
        printf '{"ok":true,"alive":true}\n'
        ;;

    # ---------------- 调整窗口尺寸 ----------------
    # 独立动作，不与按键流混在 data 里 —— 避免「明文协议 / base64 协议」混淆
    resize)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        COLS="$(json_num "${BODY}" "cols")"
        ROWS="$(json_num "${BODY}" "rows")"
        sess_beat "${SID}"
        sess_resize "${SID}" "${COLS}" "${ROWS}" 2>/dev/null
        sess_read "${SID}" "${OFFSET}"
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","truncated":%s,"data":"%s"}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" \
            "${_OUT_TRUNCATED:-0}" "${_OUT_B64}"
        ;;

    # ---------------- 开关 tty 回显 ----------------
    #
    #   前端的本地行编辑器要求 shell 不要也回显一遍，否则同一串字符会画两次。
    #   包装进程在会话创建时已经清掉 ECHO 位，但 login / su 这类登录程序会按
    #   自己的默认值重置 termios，所以前端在识别到新提示符后会再压一次。
    #   走控制 FIFO 由包装进程 tcsetattr —— 不在会话里执行 stty，屏幕和历史都干净。
    echo)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        ON="$(json_num "${BODY}" "on")"
        case "${ON}" in 0|1) ;; *) ON=0 ;; esac
        sess_beat "${SID}"
        sess_set_echo "${SID}" "${ON}" 2>/dev/null
        json_head
        printf '{"ok":true}\n'
        ;;

    # ---------------- 轮询新增输出 ----------------
    #
    #   带 wait 时是**长轮询**：后端最多挂住 wait 毫秒，一有新输出立刻返回。
    #   前端每次拿到响应就立刻发下一轮，于是「总有一次 read 在途」——
    #   回显产生的那一刻就被带走，不必等下一个定时器。这是「输入回显慢」的解药。
    read)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        # 轮询本身就是「页面还在」的最强证据，直接续租
        sess_beat "${SID}"
        if ! sess_read_wait "${SID}" "${OFFSET}" "${WAIT}"; then
            json_head
            printf '{"ok":false,"error":"会话不存在","alive":false}\n'
            exit 0
        fi
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","truncated":%s,"data":"%s"}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" \
            "${_OUT_TRUNCATED:-0}" "${_OUT_B64}"
        ;;

    # ---------------- 状态 ----------------
    info)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        sess_read "${SID}" "${OFFSET}"
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","truncated":%s,"data":""}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" \
            "${_OUT_TRUNCATED:-0}"
        ;;

    # ---------------- 页面心跳（续租） ----------------
    #
    #   前端每 KEEPALIVE_TTL 秒调用一次，把当前页面名下所有会话的心跳刷新。
    #   网页一关心跳就停，ORPHAN_SECS 秒后 sess_gc 会把进程收掉 ——
    #   这就是「程序关闭后关闭进程」的兜底保障。
    #
    #   即便前端异常（例如标签页被冻结、定时器被节流），只要页面还在，
    #   常规的 read 轮询也会刷新同一个会话的心跳；keepalive 主要覆盖
    #   「多个会话里非当前标签页的那些」。
    keepalive)
        if [ -n "${OWNER}" ]; then
            # 按 owner 给名下所有会话续租
            for d in "${SESS_ROOT}"/*; do
                [ -d "${d}" ] || continue
                [ "$(cat "${d}/owner" 2>/dev/null)" = "${OWNER}" ] || continue
                sess_beat_file "${d}"
            done
        elif [ -n "${SID}" ]; then
            valid_sid "${SID}" && sess_beat "${SID}"
        fi
        json_head
        printf '{"ok":true}\n'
        ;;

    # ---------------- 页面关闭（销毁该页面的全部会话） ----------------
    #
    #   由前端在 pagehide / beforeunload 里用 sendBeacon 发出 ——
    #   sendBeacon 在页面卸载后仍会完成发送，是关页面回收进程最可靠的通道。
    shutdown)
        _n=0
        if [ -n "${OWNER}" ]; then
            # 统计再回收，便于排障时确认真的关掉了
            for d in "${SESS_ROOT}"/*; do
                [ -d "${d}" ] || continue
                [ "$(cat "${d}/owner" 2>/dev/null)" = "${OWNER}" ] || continue
                _n=$((_n + 1))
            done
            sess_kill_by_owner "${OWNER}"
        elif [ -n "${SID}" ]; then
            valid_sid "${SID}" || fail "sid 非法"
            sess_close "${SID}"
            _n=1
        fi
        json_head
        printf '{"ok":true,"closed":%s}\n' "${_n}"
        ;;

    # 「全部关闭」没有 HTTP 入口 —— 应用停用走 cmd/main stop（本地 CLI），
    # 不给远程一个能清掉所有人会话的接口。

    # ---------------- 关闭会话 ----------------
    close)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        sess_close "${SID}"
        json_head
        printf '{"ok":true}\n'
        ;;

    # ---------------- 环境自检（排障用） ----------------
    env)
        _live=0
        for d in "${SESS_ROOT}"/*; do
            [ -d "${d}" ] || continue
            sess_alive "$(basename "${d}")" && _live=$((_live + 1))
        done
        json_head
        printf '{"ok":true,"app_dir":"%s","var_dir":"%s","shell":"%s","pty":"%s","pty_bin":"%s","pty_exec":%s,"base64":%s,"sessions":%s,"live":%s,"keepalive":%s,"orphan":%s,"arch":"%s"}\n' \
            "$(jstr "${APP_DIR}")" "$(jstr "${VAR_DIR}")" "$(jstr "${SHELL_BIN}")" \
            "$(jstr "${PTY_IMPL}")" "$(jstr "${PTY_BIN}")" \
            "$( [ -n "${PTY_BIN}" ] && [ -x "${PTY_BIN}" ] && echo true || echo false )" \
            "$( [ -x "$(command -v base64 2>/dev/null)" ] && echo true || echo false )" \
            "$( [ -d "${VAR_DIR}/sessions" ] && echo true || echo false )" \
            "${_live}" "${KEEPALIVE_TTL}" "${ORPHAN_SECS}" \
            "$(jstr "$(uname -m 2>/dev/null)")"
        ;;

    *)
        fail "未知操作: ${ACTION}"
        ;;
esac

exit 0
