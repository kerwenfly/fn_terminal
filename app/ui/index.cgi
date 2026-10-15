#!/bin/bash
#
# 应用统一入口 CGI：
#   1) 静态文件服务 —— 把请求路径映射到 target/www 目录
#        浏览器侧: /cgi/ThirdParty/terminal/index.cgi/<path>
#        实际文件: /var/apps/terminal/target/www/<path>
#   2) API 分发 —— 带 ?action=<name> 的请求转发给 terminal.cgi（v1.2.11）
#
# 说明：飞牛打开应用入口时的请求形如
#   /cgi/ThirdParty/terminal/index.cgi/
# 此时 REQUEST_URI 可能带或不带尾部的 `/`，也可能只给 PATH_INFO，
# 三种情况都要落到 www/index.html。
#
# 【为什么 API 也要从这走】新版飞牛网关只允许直接执行 index.cgi，
# 对 terminal.cgi 的请求会返回纯文本错误 "cgi executable must be index.cgi"
# （前端表现为 r.json() 解析失败的 SyntaxError）。因此 API 请求统一打到
# index.cgi?action=xxx，由这里 exec 转发给 terminal.cgi —— exec 原地替换
# 进程，QUERY_STRING / 环境变量原样透传，terminal.cgi 的解析逻辑不用改。
# 旧版飞牛直接访问 terminal.cgi 依然可用（向后兼容，未删除该入口）。
#

APP_NAME="terminal"

# 应用目录优先取环境变量，避免路径硬编码
APP_DIR="/var/apps/${APP_NAME}/target"
if [ -n "${TRIM_APPDEST}" ]; then
    APP_DIR="${TRIM_APPDEST}"
fi
BASE_PATH="${APP_DIR}/www"

# ---------------------------------------------------------------------------
# API 分发：?action=<合法动作名> -> 转发 terminal.cgi
#   放在静态文件解析之前 —— 否则 "index.cgi?action=create" 会被当成
#   「index.cgi 目录下的默认页」落到 www/index.html。
#   动作名只允许 [A-Za-z0-9_]（与 terminal.cgi 侧的校验一致），
#   其它形式的查询串一律不转发、继续走静态文件。
# ---------------------------------------------------------------------------
if [ -n "${QUERY_STRING}" ]; then
    case "${QUERY_STRING}" in
        action=*)
            QS_ACTION="${QUERY_STRING#action=}"
            QS_ACTION="${QS_ACTION%%&*}"
            case "${QS_ACTION}" in
                ''|*[!A-Za-z0-9_]*) ;;   # 非法动作名：不转发
                *) exec "${APP_DIR}/ui/terminal.cgi" ;;
            esac
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# 解析请求路径
#   依次尝试：REQUEST_URI 里 index.cgi 之后的部分 -> PATH_INFO -> 默认 /
# ---------------------------------------------------------------------------
REL_PATH=""

if [ -n "${REQUEST_URI}" ]; then
    URI_NO_QUERY="${REQUEST_URI%%\?*}"
    case "${URI_NO_QUERY}" in
        *index.cgi*)
            REL_PATH="${URI_NO_QUERY#*index.cgi}"
            ;;
    esac
fi

# REQUEST_URI 没给出尾部时退回 PATH_INFO
if [ -z "${REL_PATH}" ] && [ -n "${PATH_INFO}" ]; then
    REL_PATH="${PATH_INFO%%\?*}"
fi

# 规范化为以 / 开头的路径
if [ -z "${REL_PATH}" ]; then
    REL_PATH="/"
fi
case "${REL_PATH}" in
    /*) ;;
    *)  REL_PATH="/${REL_PATH}" ;;
esac

# 目录形式（以 / 结尾或为空）一律映射到 index.html
case "${REL_PATH}" in
    */) REL_PATH="${REL_PATH}index.html" ;;
esac

TARGET_FILE="${BASE_PATH}${REL_PATH}"

# ---------------------------------------------------------------------------
# 安全：拒绝目录穿越
# ---------------------------------------------------------------------------
case "${TARGET_FILE}" in
    *..*)
        echo "Status: 400 Bad Request"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "Bad Request"
        exit 0
        ;;
esac

# 目标若是目录，补 index.html
if [ -d "${TARGET_FILE}" ]; then
    TARGET_FILE="${TARGET_FILE%/}/index.html"
fi

if [ ! -f "${TARGET_FILE}" ]; then
    echo "Status: 404 Not Found"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "404 Not Found"
    exit 0
fi

case "${TARGET_FILE##*.}" in
    html|htm) mime="text/html; charset=utf-8" ;;
    css) mime="text/css; charset=utf-8" ;;
    js) mime="application/javascript; charset=utf-8" ;;
    png) mime="image/png" ;;
    jpg|jpeg) mime="image/jpeg" ;;
    gif) mime="image/gif" ;;
    svg) mime="image/svg+xml" ;;
    ico) mime="image/x-icon" ;;
    woff) mime="font/woff" ;;
    woff2) mime="font/woff2" ;;
    json) mime="application/json; charset=utf-8" ;;
    map) mime="application/json; charset=utf-8" ;;
    *) mime="application/octet-stream" ;;
esac

# ---------------------------------------------------------------------------
# 缓存策略：
#   vendor/（xterm.js 等离线内置库）内容不随版本变化，允许浏览器长缓存，
#   避免每次打开页面都全量重拉上 MB 的脚本；
#   应用自己的页面/脚本/样式随版本更新，保持 no-cache。
# ---------------------------------------------------------------------------
case "${REL_PATH}" in
    /vendor/*) cache_ctl="public, max-age=604800" ;;
    *)         cache_ctl="no-cache" ;;
esac

echo "Content-Type: $mime"
echo "Cache-Control: $cache_ctl"
echo ""
cat "${TARGET_FILE}"
