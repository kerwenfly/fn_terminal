#!/bin/bash
#
# 终端 CGI —— 所有终端操作的唯一入口
#
#   浏览器侧                        动作
#   /cgi/ThirdParty/terminal/terminal.cgi/create        新建 PTY 会话
#   /cgi/ThirdParty/terminal/terminal.cgi/exec          执行命令 / 送按键
#   /cgi/ThirdParty/terminal/terminal.cgi/read          只拉取新增输出（轮询）
#   /cgi/ThirdParty/terminal/terminal.cgi/resize        调整窗口尺寸
#   /cgi/ThirdParty/terminal/terminal.cgi/keepalive     页面心跳（证明页面还开着）
#   /cgi/ThirdParty/terminal/terminal.cgi/shutdown      页面关闭 -> 销毁其全部会话
#   /cgi/ThirdParty/terminal/terminal.cgi/close         关闭并销毁单个会话
#   /cgi/ThirdParty/terminal/terminal.cgi/info          会话状态（cwd / 退出码 / 存活）
#
# 「会话跟随页面」的约定：
#   前端为每个标签页生成一个 owner（sessionStorage，标签页内共享、关闭即失效）。
#   页面每几秒发一次 keepalive 续租；页面关闭时发 shutdown 立刻回收。
#   若页面异常消失（崩溃/断网），shutdown 发不出去，则由 sess_gc 按心跳超时兜底，
#   因此**任何请求进来都先跑一次 sess_gc**。
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
# ---------------------------------------------------------------------------
json_str() {
    # $1 = json, $2 = key
    local json="$1" key="$2" out
    out="$(printf '%s' "${json}" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")"
    printf '%s' "${out}"
}

json_num() {
    local json="$1" key="$2" out
    out="$(printf '%s' "${json}" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p")"
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
# 每次请求都顺手做一次 GC：
#   把「进程已死」的残留目录，以及「心跳过期（页面已关）」的孤儿会话清掉。
#   shutdown 是正常关闭的快路径；这里是不正常关闭（崩溃/断网/强杀浏览器）的兜底。
# 例外：keepalive 也要跑（它本身就是给 GC 送新心跳的机会）。
# ---------------------------------------------------------------------------
sess_gc >/dev/null 2>&1

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
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","data":"%s"}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" "${_OUT_B64}"
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
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","data":"%s"}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" "${_OUT_B64}"
        ;;

    # ---------------- 轮询新增输出 ----------------
    read)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        # 轮询本身就是「页面还在」的最强证据，直接续租
        sess_beat "${SID}"
        if ! sess_read "${SID}" "${OFFSET}"; then
            json_head
            printf '{"ok":false,"error":"会话不存在","alive":false}\n'
            exit 0
        fi
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","data":"%s"}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")" "${_OUT_B64}"
        ;;

    # ---------------- 状态 ----------------
    info)
        [ -n "${SID}" ] || fail "缺少 sid"
        valid_sid "${SID}" || fail "sid 非法"
        sess_read "${SID}" "${OFFSET}"
        json_head
        printf '{"ok":true,"sid":"%s","offset":%s,"alive":%s,"cwd":"%s","rc":"%s","user":"%s","data":""}\n' \
            "$(jstr "${SID}")" "${_OUT_OFFSET}" "${_OUT_ALIVE}" \
            "$(jstr "${_OUT_CWD}")" "$(jstr "${_OUT_RC}")" "$(jstr "${_OUT_USER}")"
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

    # ---------------- 全部关闭（应用停用 / 手工清理） ----------------
    shutdown_all)
        for d in "${SESS_ROOT}"/*; do
            [ -d "${d}" ] || continue
            sess_close "$(basename "${d}")"
        done
        json_head
        printf '{"ok":true}\n'
        ;;

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
