# -*- coding: utf-8 -*-
"""从 terminal.png 生成飞牛应用所需的多尺寸图标。

产物：
  app/ui/images/icon_64.png     应用列表小图标
  app/ui/images/icon_256.png    应用列表大图标 / 详情页
  app/www/images/icon_64.png    前端内嵌用
  app/www/images/icon_256.png   前端内嵌用
  ICON.PNG                      fpk 元数据图标（64）
  ICON_256.PNG                  fpk 元数据图标（256）

同时补一层微微的暗色底，保证在飞牛浅色主题下图标边缘不发虚。
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
# 源图标位于工作区根目录（terminal.png）
SRC = os.path.join(os.path.dirname(ROOT), "terminal.png")

SIZES = (64, 256)


def main():
    src = Image.open(SRC).convert("RGBA")
    # 裁掉四周可能存在的空白边，让图标在列表里更饱满
    bbox = src.getbbox()
    if bbox:
        src = src.crop(bbox)
    w, h = src.size
    side = max(w, h)

    # 居中放到正方形画布上
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(src, ((side - w) // 2, (side - h) // 2), src)

    out_dir_ui = os.path.join(ROOT, "app", "ui", "images")
    out_dir_www = os.path.join(ROOT, "app", "www", "images")
    os.makedirs(out_dir_ui, exist_ok=True)
    os.makedirs(out_dir_www, exist_ok=True)

    for s in SIZES:
        img = square.resize((s, s), Image.LANCZOS)
        for d in (out_dir_ui, out_dir_www):
            img.save(os.path.join(d, "icon_%d.png" % s), "PNG", optimize=True)
        # fpk 顶层元数据图标
        name = "ICON.PNG" if s == 64 else "ICON_256.PNG"
        img.save(os.path.join(ROOT, name), "PNG", optimize=True)
        print("generated %s (%dx%d)" % (name, s, s))


if __name__ == "__main__":
    main()

