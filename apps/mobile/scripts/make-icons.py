#!/usr/bin/env python3
"""Draws the app icons from the design's favicon shapes. Needs Pillow.
Usage: make-icons.py <background> <letter> [--plate <colour>] [--dot <colour>]"""
import argparse, json, os
from PIL import Image, ImageDraw

a = argparse.ArgumentParser()
a.add_argument('bg'); a.add_argument('letter'); a.add_argument('--plate'); a.add_argument('--dot')
o = a.parse_args()

def curve(p0, p1, p2, p3, n=48):
    return [tuple((1-t)**3*p0[i] + 3*(1-t)**2*t*p1[i] + 3*(1-t)*t*t*p2[i] + t**3*p3[i] for i in (0, 1))
            for t in (k/n for k in range(1, n+1))]

# The "d" of the favicon on its 32-unit grid.
outer = [(9, 6), (16.5, 6)] + curve((16.5, 6), (22, 6), (25, 9.8), (25, 16)) + curve((25, 16), (25, 22.2), (22, 26), (16.5, 26)) + [(9, 26)]
inner = [(13.5, 10), (13.5, 22), (16.3, 22)] + curve((16.3, 22), (19.2, 22), (20.5, 20), (20.5, 16)) + curve((20.5, 16), (20.5, 12), (19.2, 10), (16.3, 10))

def art(px, round_mask=None):
    ss = 4; s = px * ss; k = s / 32
    # Scale the mark in from the edge a little, so launchers' masks never clip it.
    m = 0.14 * s
    q = (s - 2 * m) / 32
    pt = lambda p: (m + p[0] * q, m + p[1] * q)
    im = Image.new('RGB', (s, s), o.bg)
    d = ImageDraw.Draw(im)
    if o.plate:
        d.rounded_rectangle([m*.7, m*.7, s-m*.7, s-m*.7], radius=s*.16, fill=o.plate)
    mask = Image.new('L', (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.polygon([pt(p) for p in outer], fill=255)
    md.polygon([pt(p) for p in inner], fill=0)
    d.bitmap((0, 0), mask, fill=o.letter)
    if o.dot:
        cx, cy = pt((26, 24)); r = 3 * q
        d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=o.dot)
    return im.resize((px, px), Image.LANCZOS)

ios = 'ios/Dorkar/Images.xcassets/AppIcon.appiconset'
meta = json.load(open(f'{ios}/Contents.json'))
for e in meta['images']:
    base = float(e['size'].split('x')[0]); scale = int(e['scale'][0]); px = int(base * scale)
    name = f"icon-{e['size']}@{e['scale']}.png"
    art(px).save(f'{ios}/{name}'); e['filename'] = name
json.dump(meta, open(f'{ios}/Contents.json', 'w'), indent=2)

for folder, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    res = f'android/app/src/main/res/mipmap-{folder}'
    for name, radius in (('ic_launcher.png', .22), ('ic_launcher_round.png', .5)):
        icon = art(px * 4).convert('RGBA')
        mask = Image.new('L', icon.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, icon.width-1, icon.height-1], radius=int(icon.width*radius), fill=255)
        icon.putalpha(mask)
        icon.resize((px, px), Image.LANCZOS).save(f'{res}/{name}')
