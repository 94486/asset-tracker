# -*- coding: utf-8 -*-
"""
生成程序图标 asset.ico：蓝底圆角 + 白色柱状图，与托盘图标、favicon 保持一致。
运行: python make_icon.py
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "asset.ico")


def draw(size):
    """按比例绘制，保证小尺寸下依然清晰"""
    scale = 4  # 超采样后缩小，边缘更平滑
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(91, 140, 255, 255))

    # 三根柱子：底部基线统一，高度递增
    base = int(s * 0.72)
    bar_w = int(s * 0.13)
    gap = int(s * 0.055)
    total = bar_w * 3 + gap * 2
    left = (s - total) // 2
    heights = [0.22, 0.36, 0.50]
    for i, h in enumerate(heights):
        x0 = left + i * (bar_w + gap)
        y0 = base - int(s * h)
        d.rounded_rectangle([x0, y0, x0 + bar_w, base], radius=max(1, bar_w // 3),
                            fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    # PIL 的 ICO 编码器会从单张母图按 sizes 逐个重采样，因此只需给出 256 母图
    draw(256).save(OUT, format="ICO", sizes=[(n, n) for n in sizes])
    with Image.open(OUT) as im:
        got = sorted(im.info.get("sizes", []))
    print(f"已生成 {OUT}  内嵌尺寸: {got}  大小: {os.path.getsize(OUT)} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())