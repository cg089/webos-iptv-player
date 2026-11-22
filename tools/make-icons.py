#!/usr/bin/env python3
"""Erzeugt app/icon.png (80x80) und app/largeIcon.png (130x130). Braucht Pillow."""
from PIL import Image, ImageDraw
import os

def make(size, path):
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 5, fill=(24, 34, 52, 255))
    # Fernseher
    m = s // 7
    d.rounded_rectangle((m, m + s // 12, s - m, s - m * 2), radius=s // 14, outline=(91, 146, 255, 255), width=max(4, s // 22))
    # Play-Dreieck
    cx, cy = s // 2, (m + s // 12 + s - m * 2) // 2
    r = s // 7
    d.polygon([(cx - r // 2, cy - r), (cx - r // 2, cy + r), (cx + r, cy)], fill=(255, 255, 255, 255))
    # Standfuss
    d.rounded_rectangle((s // 2 - s // 6, s - m * 2 + s // 40, s // 2 + s // 6, s - m * 2 + s // 14), radius=s // 40, fill=(91, 146, 255, 255))
    img.resize((size, size), Image.LANCZOS).save(path)

base = os.path.join(os.path.dirname(__file__), "..", "app")
make(80, os.path.join(base, "icon.png"))
make(130, os.path.join(base, "largeIcon.png"))
