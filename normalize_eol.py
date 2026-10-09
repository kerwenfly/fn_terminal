# -*- coding: utf-8 -*-
"""打包前把项目里所有文本文件统一为 LF 行尾。

背景（踩过的坑）
    Windows 上编辑器/工具会把文件写成 CRLF。这些脚本要在 Linux（飞牛）上
    以 /bin/sh 或 /bin/bash 执行，行尾的 \\r 会被当成命令的一部分，报
       `$'\\r': command not found`
    或者直接在 `elif`、`fi` 处语法错误。CGI 脚本尤其致命——表现为
    「点击应用无反应」或「一直卡在建立会话」，且日志里看不出明显线索。

用法
    python3 normalize_eol.py [项目根目录]
"""

import os
import sys

# 需要规范化的文本文件（按扩展名 / 精确文件名匹配）
TEXT_EXT = {".cgi", ".inc", ".sh", ".js", ".css", ".html", ".htm",
            ".json", ".txt", ".py", ".md"}
TEXT_NAMES = {"main", "manifest",
              "install_init", "install_callback",
              "upgrade_init", "upgrade_callback",
              "uninstall_init", "uninstall_callback",
              "config_init", "config_callback",
              "privilege", "resource", "config"}

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".workbuddy"}


def is_text(name):
    base = os.path.basename(name)
    _, ext = os.path.splitext(base)
    return ext.lower() in TEXT_EXT or base in TEXT_NAMES


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(
        os.path.abspath(__file__))
    fixed, scanned = 0, 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if not is_text(fn):
                continue
            p = os.path.join(dirpath, fn)
            scanned += 1
            with open(p, "rb") as f:
                data = f.read()
            new = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            if new != data:
                with open(p, "wb") as f:
                    f.write(new)
                print("  LF 化:", os.path.relpath(p, root))
                fixed += 1

    print("扫描 %d 个文本文件，修正 %d 个" % (scanned, fixed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
