#!/usr/bin/env python3
"""Build the SingersVoice brand kit from the SVOld logo render.

Input : assets/Logo/SVLogo.jpg  (800x450 render, flat lavender background)
Output: apps/web/public/brand/
          sv-mark.png            transparent cut-out of the singers + base (for the top-left logo)
          sv-mark@2x.png         same, 2x
          sv-wordmark.svg        "SingersVoice" wordmark used next to the mark
          icon-192.png / icon-512.png            standard PWA icons
          icon-maskable-192.png / -512.png       maskable (safe-zone padded)
          apple-touch-icon.png   180x180
          favicon-32.png, favicon-16.png
          og-image.png           1200x630 social preview
          poster.jpg             welcome hero poster (from SV.mp4 first frame if given)

Usage:
  python3 tools/brand/make_brand.py <SVLogo.jpg> <outdir> [<SV.mp4 poster frame png>]

The .blend in assets/Logo is the source of truth for the 3D logo; see
tools/brand/export_logo_blender.py for rendering new PNG/MP4 variants with Blender.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BRAND = (90, 21, 131)      # #5A1583 (SVOld theme colour)
BRAND_DEEP = (42, 8, 69)   # #2A0845
BRAND_GLOW = (201, 167, 225)  # lavender from the render background


def key_out_background(img: Image.Image) -> Image.Image:
    """Chroma-key the flat lavender backdrop to transparency with a soft edge."""
    img = img.convert("RGB")
    px = img.load()
    w, h = img.size
    # Sample the backdrop colour from the corners.
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    alpha = Image.new("L", img.size, 255)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            d = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
            # 0..24 -> transparent, 24..72 -> soft ramp, >72 -> opaque
            if d <= 24:
                ap[x, y] = 0
            elif d < 72:
                ap[x, y] = int((d - 24) * 255 / 48)
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    out = img.convert("RGBA")
    out.putalpha(alpha)
    # Tight crop to content.
    bbox = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
    return out.crop(bbox) if bbox else out


def fit(img: Image.Image, box: int, pad: float) -> Image.Image:
    inner = int(box * (1 - 2 * pad))
    scale = min(inner / img.width, inner / img.height)
    return img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)


def radial_background(size: int) -> Image.Image:
    bg = Image.new("RGB", (size, size), BRAND_DEEP)
    glow = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(glow)
    for i in range(40, 0, -1):
        r = int(size * 0.62 * i / 40)
        cx, cy = size // 2, int(size * 0.42)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=int(255 * (1 - i / 40) ** 1.6))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.06))
    tint = Image.new("RGB", (size, size), BRAND)
    bg = Image.composite(tint, bg, glow)
    return bg


def make_icon(mark: Image.Image, size: int, pad: float, rounded: bool) -> Image.Image:
    bg = radial_background(size).convert("RGBA")
    m = fit(mark, size, pad)
    bg.alpha_composite(m, ((size - m.width) // 2, int((size - m.height) * 0.55)))
    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(bg, (0, 0), mask)
        return out
    return bg


def wordmark_svg() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 120" role="img" aria-label="SingersVoice">'
        '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#F4E9FF"/>'
        '<stop offset="1" stop-color="#C9A7E1"/></linearGradient></defs>'
        '<text x="0" y="92" font-family="ui-rounded, \'SF Pro Rounded\', system-ui, -apple-system, Segoe UI, Roboto, sans-serif" '
        'font-size="96" font-weight="800" letter-spacing="-2" fill="url(#g)">Singers<tspan fill="#FFB454">Voice</tspan></text>'
        '</svg>'
    )


def og_image(mark: Image.Image) -> Image.Image:
    W, H = 1200, 630
    bg = Image.new("RGB", (W, H), BRAND_DEEP)
    glow = radial_background(630).resize((630, 630))
    bg.paste(glow.crop((0, 0, 630, 630)).resize((W, H)), (0, 0))
    bg = bg.convert("RGBA")
    m = fit(mark, 560, 0.04)
    bg.alpha_composite(m, (40, (H - m.height) // 2))
    d = ImageDraw.Draw(bg)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 86)
        small = ImageFont.truetype("DejaVuSans.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
        small = font
    d.text((620, 220), "Singers", font=font, fill=(244, 233, 255))
    d.text((620, 310), "Voice", font=font, fill=(255, 180, 84))
    d.text((620, 420), "Lyrics-first karaoke.\nSing together. Keep it in your Drive.", font=small, fill=(220, 205, 235))
    return bg


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    poster = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    out.mkdir(parents=True, exist_ok=True)

    mark = key_out_background(Image.open(src))
    mark.save(out / "sv-mark@2x.png", optimize=True)
    mark.resize((mark.width // 2, mark.height // 2), Image.LANCZOS).save(out / "sv-mark.png", optimize=True)
    (out / "sv-wordmark.svg").write_text(wordmark_svg(), encoding="utf-8")

    for size in (192, 512):
        make_icon(mark, size, 0.06, rounded=False).save(out / f"icon-{size}.png", optimize=True)
        make_icon(mark, size, 0.18, rounded=False).save(out / f"icon-maskable-{size}.png", optimize=True)
    make_icon(mark, 180, 0.08, rounded=False).save(out / "apple-touch-icon.png", optimize=True)
    make_icon(mark, 64, 0.06, rounded=True).resize((32, 32), Image.LANCZOS).save(out / "favicon-32.png", optimize=True)
    make_icon(mark, 64, 0.06, rounded=True).resize((16, 16), Image.LANCZOS).save(out / "favicon-16.png", optimize=True)
    og_image(mark).convert("RGB").save(out / "og-image.png", optimize=True)

    if poster and poster.exists():
        Image.open(poster).convert("RGB").resize((960, 540), Image.LANCZOS).save(out / "poster.jpg", quality=82, optimize=True)
    print("brand kit written to", out)


if __name__ == "__main__":
    main()
