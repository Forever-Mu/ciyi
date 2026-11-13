# -*- coding: utf-8 -*-
"""make_icons.py —— 生成应用图标（纯 Pillow，不依赖字体文件）"""
import os
import sys

from PIL import Image, ImageDraw

C1 = (79, 70, 229)      # #4F46E5 主色
C2 = (124, 58, 237)     # #7C3AED
DENSITIES = [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216),
             ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]


def gradient(size):
    small = 64
    g = Image.new("RGB", (small, small))
    px = g.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / float((small - 1) * 2)
            px[x, y] = (int(C1[0] + (C2[0] - C1[0]) * t),
                        int(C1[1] + (C2[1] - C1[1]) * t),
                        int(C1[2] + (C2[2] - C1[2]) * t))
    return g.resize((size, size), Image.BILINEAR)


def draw_mark(d, size, scale, color=(255, 255, 255, 255)):
    """画一个「翻开的书 + A」的抽象标记"""
    w = size * scale
    ox = (size - w) / 2
    oy = (size - w) / 2
    lw = max(2, int(w * 0.075))

    def P(fx, fy):
        return (ox + fx * w, oy + fy * w)

    # 书本两页
    d.line([P(0.5, 0.18), P(0.14, 0.26)], fill=color, width=lw)
    d.line([P(0.14, 0.26), P(0.14, 0.78)], fill=color, width=lw)
    d.line([P(0.14, 0.78), P(0.5, 0.86)], fill=color, width=lw)
    d.line([P(0.5, 0.18), P(0.86, 0.26)], fill=color, width=lw)
    d.line([P(0.86, 0.26), P(0.86, 0.78)], fill=color, width=lw)
    d.line([P(0.86, 0.78), P(0.5, 0.86)], fill=color, width=lw)
    # 中缝
    d.line([P(0.5, 0.18), P(0.5, 0.86)], fill=color, width=max(2, int(lw * 0.6)))
    # 书页上的 A
    d.line([P(0.32, 0.66), P(0.5, 0.36)], fill=color, width=max(2, int(lw * 0.8)))
    d.line([P(0.5, 0.36), P(0.68, 0.66)], fill=color, width=max(2, int(lw * 0.8)))
    d.line([P(0.39, 0.56), P(0.61, 0.56)], fill=color, width=max(2, int(lw * 0.7)))


def rounded_mask(size, ratio=0.23, ss=4):
    big = size * ss
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, big - 1, big - 1],
                                        radius=int(big * ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def make_launcher(size):
    img = gradient(size).convert("RGBA")
    draw_mark(ImageDraw.Draw(img), size, 0.62)
    img.putalpha(rounded_mask(size))
    return img


def make_foreground(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(img), size, 0.44)
    return img


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    res = os.path.join(os.path.dirname(here), "app", "res")
    for name, ls, fs in DENSITIES:
        folder = os.path.join(res, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        make_launcher(ls).save(os.path.join(folder, "ic_launcher.png"), "PNG")
        make_foreground(fs).save(os.path.join(folder, "ic_launcher_foreground.png"), "PNG")
        print("  mipmap-%-8s %3dpx / fg %3dpx" % (name, ls, fs))
    print("  图标生成完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
