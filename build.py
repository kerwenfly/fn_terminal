# -*- coding: utf-8 -*-
"""一键构建终端应用的 fpk 包（支持按架构打包）。

流程：
  1) 用 Go 交叉编译 PTY 组件（纯静态，无运行时依赖）
  2) 从 terminal.png 重新生成图标（可选）
  3) 规范化所有文本文件的行尾为 LF（避免 Linux 上 $'\\r' 报错）
  4) 用 fnpack 打包成 fpk；同时把 manifest 的 platform 切到目标架构

为什么用 Go 而不是 python3 / script：
  - 静态编译产物零依赖，不受目标机是否装了 python/script 影响；
  - 交叉编译直接产出可用二进制，不必依赖目标机工具链；
  - 显式双向搬运 PTY 数据，不依赖任何命令的隐式行为，最可靠。

架构与 manifest.platform 的对应（飞牛官方约定）：
    amd64  -> 平台 x86      -> 产物 terminal_1.2.4_x86.fpk
    arm64  -> 平台 arm      -> 产物 terminal_1.2.4_arm.fpk
    arm    -> 平台 arm      -> 产物 terminal_1.2.4_arm.fpk
  ⚠️ platform 是**单值**字段，一个 fpk 只能声明一种架构。
     因此双架构必须分别打包成两个 fpk，不能写成 all
     （写 all 会同时装到 x86 与 ARM，但包内只有一种二进制，另一端必然跑不起来）。

用法：
  python3 build.py                 # 默认 arm64（保持原行为）
  python3 build.py --arch amd64    # 构建 linux x64 包
  python3 build.py --arch arm64,amd64   # 两个架构依次构建
  python3 build.py --arch amd64 --no-icon   # 跳过图标生成
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
BINDIR = os.path.join(ROOT, "app", "bin")
FNPACK = os.path.join(os.path.dirname(ROOT), "fnpack.exe")
MANIFEST = os.path.join(ROOT, "manifest")

# GOARCH -> (二进制文件名后缀, manifest 的 platform 值, 产物文件名用的架构标签)
ARCH_INFO = {
    "amd64": ("amd64", "x86", "x86"),
    "arm64": ("arm64", "arm", "arm64"),
    "arm":   ("arm",   "arm", "arm"),
}

# 默认构建 arm64（与历史行为一致）
DEFAULT_ARCH = "arm64"


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise SystemExit("命令失败: %s" % " ".join(str(c) for c in cmd))


def read_manifest():
    with open(MANIFEST, "r", encoding="utf-8") as f:
        return f.read()


def manifest_get(text, key):
    m = re.search(r"^%s\s*=\s*(.+?)\s*$" % re.escape(key), text, re.M)
    return m.group(1) if m else None


def manifest_set(text, key, value):
    """把 manifest 里某个键的值替换掉（键不存在则追加）。"""
    pattern = re.compile(r"^(%s\s*=\s*).*?$" % re.escape(key), re.M)
    if pattern.search(text):
        return pattern.sub(lambda m: m.group(1) + value, text, count=1)
    # 不存在则插到 appname 之后
    return re.sub(r"^(appname\s*=\s*.*?)$",
                  lambda m: m.group(1) + "\n%s = %s" % (key, value),
                  text, count=1, flags=re.M)


def build_go(arch):
    """只编译目标架构的那一份二进制（省时间，也避免误打包其它架构）。"""
    os.makedirs(BINDIR, exist_ok=True)
    suffix = ARCH_INFO[arch][0]
    out_name = "terminal-pty-linux-%s" % suffix
    out_path = os.path.join(BINDIR, out_name)

    env = dict(os.environ)
    env["CGO_ENABLED"] = "0"
    env["GOOS"] = "linux"
    env["GOARCH"] = arch

    run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", out_path, "."],
        cwd=SRC, env=env)
    print("    -> %s (%d bytes)" % (out_name, os.path.getsize(out_path)))
    return out_path


def prune_other_arch_binaries(keep_name):
    """把非目标架构的二进制从 app/bin 移走，保证包内只留一种架构。

    为什么要移走而不是删掉：多架构二进制同时留在包里会让包体积白白翻倍，
    且与 manifest 声明的单一 platform 语义不符。这里移到旁路目录，构建完再还原。
    """
    stash = os.path.join(ROOT, ".arch-stash")
    os.makedirs(stash, exist_ok=True)
    moved = []
    for f in sorted(os.listdir(BINDIR)):
        if not f.startswith("terminal-pty"):
            continue
        if f == keep_name:
            continue
        src = os.path.join(BINDIR, f)
        if os.path.isfile(src):
            shutil.move(src, os.path.join(stash, f))
            moved.append(f)
    return moved


def restore_stashed():
    """还原被移走的二进制，保持工作区整洁。"""
    stash = os.path.join(ROOT, ".arch-stash")
    if not os.path.isdir(stash):
        return
    for f in sorted(os.listdir(stash)):
        src = os.path.join(stash, f)
        dst = os.path.join(BINDIR, f)
        if os.path.isfile(src) and not os.path.exists(dst):
            shutil.move(src, dst)
    try:
        os.rmdir(stash)
    except OSError:
        pass


def build_icons():
    run([sys.executable, os.path.join(ROOT, "make_icons.py")])


def normalize():
    run([sys.executable, os.path.join(ROOT, "normalize_eol.py"), ROOT])


def pack(arch, version):
    orig = read_manifest()
    platform = ARCH_INFO[arch][1]
    label = ARCH_INFO[arch][2]

    # 临时把 platform 切成目标架构
    tmp = manifest_set(orig, "platform", platform)
    if tmp != orig:
        with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
            f.write(tmp)
        print("    manifest.platform -> %s" % platform)

    try:
        if not os.path.exists(FNPACK):
            print("  警告: 未找到 fnpack.exe，跳过打包")
            return None
        run([FNPACK, "build", "-d", ROOT], cwd=os.path.dirname(ROOT))

        # fnpack 默认产物 terminal.fpk，重命名带架构与版本，便于多包共存
        produced = os.path.join(os.path.dirname(ROOT), "terminal.fpk")
        if not os.path.exists(produced):
            return None
        final_name = "terminal_%s_%s.fpk" % (version, label)
        final_path = os.path.join(os.path.dirname(ROOT), final_name)
        if os.path.exists(final_path):
            os.remove(final_path)
        shutil.move(produced, final_path)
        print("  产物: %s (%d bytes)" % (final_path, os.path.getsize(final_path)))
        return final_path
    finally:
        # 无论如何都要还原 manifest，避免污染源码树
        with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
            f.write(orig)


def parse_archs():
    for i, a in enumerate(sys.argv):
        if a == "--arch":
            if i + 1 >= len(sys.argv):
                raise SystemExit("--arch 需要一个参数，如 amd64 / arm64 / arm")
            return [x.strip() for x in sys.argv[i + 1].split(",") if x.strip()]
        if a.startswith("--arch="):
            return [x.strip() for x in a.split("=", 1)[1].split(",") if x.strip()]
    return [DEFAULT_ARCH]


def main():
    archs = parse_archs()
    for a in archs:
        if a not in ARCH_INFO:
            raise SystemExit("不支持的架构: %s（可选 %s）"
                             % (a, " / ".join(ARCH_INFO)))

    version = manifest_get(read_manifest(), "version") or "0.0.0"
    skip_icon = "--no-icon" in sys.argv

    results = []
    for idx, arch in enumerate(archs, 1):
        suffix = ARCH_INFO[arch][0]
        keep = "terminal-pty-linux-%s" % suffix
        print("=" * 64)
        print("构建 %s  (%d/%d)  platform=%s" % (arch, idx, len(archs), ARCH_INFO[arch][1]))
        print("=" * 64)

        print("[1/4] 编译 Go PTY 组件")
        build_go(arch)

        print("[2/4] %s" % ("跳过图标" if skip_icon else "生成图标"))
        if not skip_icon:
            build_icons()

        print("[3/4] 规范化行尾 (LF)")
        normalize()

        print("[4/4] 打包 fpk")
        moved = prune_other_arch_binaries(keep)
        if moved:
            print("    临时移出非目标架构二进制: %s" % ", ".join(moved))
        try:
            out = pack(arch, version)
        finally:
            restore_stashed()
        if out:
            results.append(out)
        print()

    print("=" * 64)
    print("全部完成，产物：")
    for r in results:
        print("  %s (%d bytes)" % (r, os.path.getsize(r)))
    if not results:
        print("  (未生成 fpk，请检查 fnpack.exe)")


if __name__ == "__main__":
    main()
