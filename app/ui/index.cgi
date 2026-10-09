#!/bin/bash
#
# 静态文件服务 CGI —— 把请求路径映射到 target/www 目录
#   浏览器侧: /cgi/ThirdParty/terminal/index.cgi/<path>
#   实际文件: /var/apps/terminal/target/www/<path>
#
# 说明：飞牛打开应用入口时的请求形如
#   /cgi/ThirdParty/terminal/index.cgi/
# 此时 REQUEST_URI 可能带或不带尾部的 `/`，也可能只给 PATH_INFO，
# 三种情况都要落到 www/index.html。
#

APP_NAME="terminal"

# 应用目录优先取环境变量，避免路径硬编码
APP_DIR="/var/apps/${APP_NAME}/target"
if [ -n "${TRIM_APPDEST}" ]; then
    APP_DIR="${TRIM_APPDEST}"
fi
BASE_PATH="${APP_DIR}/www"

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

echo "Content-Type: $mime"
echo "Cache-Control: no-cache"
echo ""
cat "${TARGET_FILE}"
