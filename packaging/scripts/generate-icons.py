#!/usr/bin/env python3
"""Generate the app icon set for the CBCT Viewer packaging targets.

Produces the PNG/ICO sizes Tauri expects under packaging/desktop/src-tauri/icons,
plus a single high-resolution source PNG that `npx capacitor-assets generate`
uses for the Android and iOS icon sets.

Run from the repository root:
    python3 packaging/scripts/generate-icons.py
"""

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TAURI_ICONS = os.path.join(ROOT, "packaging", "desktop", "src-tauri", "icons")
MOBILE_ASSETS = os.path.join(ROOT, "packaging", "mobile", "assets")

BG = (12, 26, 38, 255)        # deep slate blue
PANEL = (23, 48, 70, 255)     # viewport panel fill
LINE = (75, 144, 200, 255)    # reticle / accent blue
GLOW = (150, 205, 245, 255)   # bright highlight


def draw_icon(size: int) -> Image.Image:
    """Draw a stylised multiplanar-reconstruction layout: three viewport panes
    with a crosshair reticle, which is what the viewer actually shows."""
    scale = 4  # supersample, then downsample for clean edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    pad = int(s * 0.15)
    gap = int(s * 0.035)
    inner = s - pad * 2
    half = (inner - gap) // 2

    # Top-left, top-right, bottom-left panes = axial / sagittal / coronal.
    panes = [
        (pad, pad, pad + half, pad + half),
        (pad + half + gap, pad, pad + inner, pad + half),
        (pad, pad + half + gap, pad + half, pad + inner),
    ]
    pane_radius = int(s * 0.03)
    for box in panes:
        d.rounded_rectangle(box, radius=pane_radius, fill=PANEL)

    # Crosshair reticle through each pane.
    lw = max(1, int(s * 0.012))
    for x0, y0, x1, y1 in panes:
        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        inset = int((x1 - x0) * 0.16)
        d.line([x0 + inset, cy, x1 - inset, cy], fill=LINE, width=lw)
        d.line([cx, y0 + inset, cx, y1 - inset], fill=LINE, width=lw)

    # Bottom-right pane = the 3D volume, drawn as a glowing sphere-ish blob.
    bx0 = pad + half + gap
    by0 = pad + half + gap
    bx1 = pad + inner
    by1 = pad + inner
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=pane_radius, fill=PANEL)
    cx = (bx0 + bx1) // 2
    cy = (by0 + by1) // 2
    r = int((bx1 - bx0) * 0.30)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GLOW, width=max(1, int(s * 0.014)))
    r2 = int(r * 0.5)
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=LINE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(TAURI_ICONS, exist_ok=True)
    os.makedirs(MOBILE_ASSETS, exist_ok=True)

    # Tauri's required set.
    draw_icon(32).save(os.path.join(TAURI_ICONS, "32x32.png"))
    draw_icon(128).save(os.path.join(TAURI_ICONS, "128x128.png"))
    draw_icon(256).save(os.path.join(TAURI_ICONS, "128x128@2x.png"))
    draw_icon(512).save(os.path.join(TAURI_ICONS, "icon.png"))

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    draw_icon(256).save(
        os.path.join(TAURI_ICONS, "icon.ico"),
        format="ICO",
        sizes=[(n, n) for n in ico_sizes],
    )

    # Source art for capacitor-assets (Android + iOS icon/splash generation).
    draw_icon(1024).save(os.path.join(MOBILE_ASSETS, "icon.png"))

    splash = Image.new("RGBA", (2732, 2732), BG)
    logo = draw_icon(900)
    splash.paste(logo, ((2732 - 900) // 2, (2732 - 900) // 2), logo)
    splash.convert("RGB").save(os.path.join(MOBILE_ASSETS, "splash.png"))

    print("icons written to:")
    print("  " + TAURI_ICONS)
    print("  " + MOBILE_ASSETS)


if __name__ == "__main__":
    main()
