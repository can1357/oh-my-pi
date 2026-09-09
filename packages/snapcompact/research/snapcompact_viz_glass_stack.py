# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render a perspective glass-stack view of snapcompact activation deltas."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = HERE / "results" / "agent-viz-glass-stack"

INK = (238, 248, 255)
MUTED = (133, 158, 174)
CYAN = (82, 226, 255)
GOLD = (255, 206, 93)
RED = (255, 78, 93)
PANEL = (9, 16, 26)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def glass_heat(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    stops = [
        (0.00, (11, 24, 48)),
        (0.24, (20, 67, 105)),
        (0.50, (47, 183, 214)),
        (0.72, (255, 91, 116)),
        (0.88, (255, 178, 87)),
        (1.00, (255, 252, 197)),
    ]
    for (ta, ca), (tb, cb) in zip(stops, stops[1:]):
        if t <= tb:
            return mix(ca, cb, (t - ta) / (tb - ta))
    return stops[-1][1]


def plane_corners(
    layer: int,
) -> tuple[
    tuple[float, float], tuple[float, float], tuple[float, float], tuple[float, float]
]:
    x = 225 + layer * 25.0
    y = 920 - layer * 34.0
    width = 930.0
    dx, dy = 190.0, -78.0
    return (x, y), (x + width, y), (x + width + dx, y + dy), (x + dx, y + dy)


def bilerp(
    corners: tuple[
        tuple[float, float],
        tuple[float, float],
        tuple[float, float],
        tuple[float, float],
    ],
    u: float,
    v: float,
) -> tuple[float, float]:
    fl, fr, br, bl = corners
    ax = fl[0] + (fr[0] - fl[0]) * u
    ay = fl[1] + (fr[1] - fl[1]) * u
    bx = bl[0] + (br[0] - bl[0]) * u
    by = bl[1] + (br[1] - bl[1]) * u
    return ax + (bx - ax) * v, ay + (by - ay) * v


def poly(points: Iterable[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(round(x), round(y)) for x, y in points]


def select_scars(
    ratio_norm: np.ndarray,
    answer_binned: np.ndarray,
    random_binned: np.ndarray,
    count: int = 7,
) -> list[int]:
    advantage = np.maximum(answer_binned - random_binned, 0.0)
    if float(advantage.max(initial=0.0)) > 0:
        advantage = advantage / float(np.quantile(advantage, 0.985))
    score = (
        ratio_norm.mean(axis=0) * 0.68 + np.clip(advantage, 0, 1).mean(axis=0) * 0.32
    )
    order = np.argsort(score)[::-1]
    chosen: list[int] = []
    for idx in order:
        i = int(idx)
        if all(abs(i - old) >= 11 for old in chosen):
            chosen.append(i)
            if len(chosen) == count:
                break
    return sorted(chosen)


def draw_background(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    width, height = canvas.size
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line((0, y, width, y), fill=mix((2, 6, 13), (10, 18, 32), t))
    grid = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(-240, width + 240, 48):
        gd.line((x, height, x + 620, 0), fill=(65, 145, 190, 16), width=1)
    for y in range(92, height, 46):
        gd.line((0, y, width, y - 138), fill=(65, 145, 190, 12), width=1)
    gd.ellipse((-220, -240, 850, 560), fill=(42, 188, 255, 34))
    gd.ellipse((1120, 420, 2040, 1380), fill=(255, 65, 112, 35))
    canvas.alpha_composite(grid.filter(ImageFilter.GaussianBlur(0.4)))


def draw_plane(canvas: Image.Image, values: np.ndarray, layer: int) -> None:
    corners = plane_corners(layer)
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    cols = values.shape[0]

    # Blue glass substrate.
    draw.polygon(poly(corners), fill=(28, 85, 122, 24), outline=(108, 222, 255, 54))

    for c, raw in enumerate(values):
        u0 = c / cols
        u1 = (c + 1) / cols
        shade = float(np.clip(raw, 0, 1))
        rgb = glass_heat(shade)
        alpha = round(26 + 96 * math.pow(shade, 0.82))
        draw.polygon(
            poly(
                (
                    bilerp(corners, u0, 0.03),
                    bilerp(corners, u1, 0.03),
                    bilerp(corners, u1, 0.97),
                    bilerp(corners, u0, 0.97),
                )
            ),
            fill=(*rgb, alpha),
        )

    for u in np.linspace(0, 1, 13):
        draw.line(
            poly((bilerp(corners, float(u), 0), bilerp(corners, float(u), 1))),
            fill=(190, 242, 255, 28),
            width=1,
        )
    for v in np.linspace(0, 1, 5):
        draw.line(
            poly((bilerp(corners, 0, float(v)), bilerp(corners, 1, float(v)))),
            fill=(190, 242, 255, 24),
            width=1,
        )
    draw.line(
        poly((corners[0], corners[1], corners[2], corners[3], corners[0])),
        fill=(174, 241, 255, 70),
        width=2,
    )
    if layer in (0, 6, 12, 18):
        x, y = corners[0]
        draw.text(
            (round(x - 64), round(y - 10)),
            f"L{layer:02d}",
            fill=(178, 226, 239, 150),
            font=font(16, True),
        )
    canvas.alpha_composite(overlay)


def draw_scars(
    canvas: Image.Image, scar_bins: list[int], ratio_norm: np.ndarray
) -> None:
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    cols = ratio_norm.shape[1]
    scar_colors = [
        (255, 238, 164),
        (255, 102, 132),
        (87, 236, 255),
        (255, 190, 80),
        (205, 111, 255),
        (255, 255, 255),
        (72, 255, 190),
    ]
    for n, c in enumerate(scar_bins):
        u = (c + 0.5) / cols
        pts = [
            bilerp(plane_corners(layer), u, 0.46)
            for layer in range(ratio_norm.shape[0])
        ]
        color = scar_colors[n % len(scar_colors)]
        gd.line(poly(pts), fill=(*color, 120), width=12)
        for layer, pt in enumerate(pts):
            r = 5 + 12 * float(ratio_norm[layer, c])
            x, y = pt
            gd.ellipse((x - r, y - r, x + r, y + r), fill=(*color, 90))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(13)))

    draw = ImageDraw.Draw(canvas, "RGBA")
    for n, c in enumerate(scar_bins):
        u = (c + 0.5) / cols
        pts = [
            bilerp(plane_corners(layer), u, 0.46)
            for layer in range(ratio_norm.shape[0])
        ]
        color = scar_colors[n % len(scar_colors)]
        draw.line(poly(pts), fill=(*color, 235), width=3)
        top = pts[-1]
        draw.text(
            (round(top[0] + 10), round(top[1] - 14)),
            f"bin {c}",
            fill=(*color, 220),
            font=font(13, True),
        )
        for layer, pt in enumerate(pts):
            r = 2.0 + 4.5 * float(ratio_norm[layer, c])
            x, y = pt
            draw.ellipse(
                (x - r, y - r, x + r, y + r),
                fill=(255, 255, 230, 225),
                outline=(*color, 255),
                width=1,
            )


def draw_labels(
    canvas: Image.Image, summary: dict, scar_bins: list[int], ratio_binned: np.ndarray
) -> None:
    draw = ImageDraw.Draw(canvas, "RGBA")
    q = summary["question"]["q"]
    answer = summary["question"]["answer_text"]
    draw.text((70, 54), "SNAPCOMPACT GLASS STACK", fill=GOLD, font=font(22, True))
    draw.text(
        (70, 88),
        "Answer-mask scars through decoder depth",
        fill=INK,
        font=font(54, True),
    )
    draw.text(
        (73, 154),
        f"Question: {q}   ·   gold answer: {answer}",
        fill=MUTED,
        font=font(22),
    )

    x0, y0, x1, y1 = 70, 960, 770, 1110
    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=24,
        fill=(7, 13, 22, 205),
        outline=(115, 217, 255, 72),
        width=1,
    )
    ratio = summary["answer_over_random_delta"]
    draw.text((x0 + 26, y0 + 22), f"{ratio:.2f}×", fill=GOLD, font=font(48, True))
    draw.text(
        (x0 + 170, y0 + 31),
        "mean answer-mask / random-mask delta",
        fill=INK,
        font=font(22, True),
    )
    draw.text(
        (x0 + 28, y0 + 86),
        f"{summary['layers']} semi-transparent decoder planes · {summary['image_tokens']} image tokens binned to {ratio_binned.shape[1]} columns",
        fill=MUTED,
        font=font(18),
    )

    lx0, ly0 = 1240, 930
    draw.rounded_rectangle(
        (lx0, ly0, lx0 + 475, ly0 + 182),
        radius=24,
        fill=(7, 13, 22, 210),
        outline=(115, 217, 255, 70),
        width=1,
    )
    draw.text((lx0 + 24, ly0 + 22), "encoding", fill=INK, font=font(25, True))
    draw.text(
        (lx0 + 24, ly0 + 61),
        "plane color = answer/random ratio",
        fill=MUTED,
        font=font(18),
    )
    draw.text(
        (lx0 + 24, ly0 + 92),
        "vertical scar = high-ratio token bin",
        fill=MUTED,
        font=font(18),
    )
    draw.text(
        (lx0 + 24, ly0 + 124),
        "selected bins: " + ", ".join(map(str, scar_bins)),
        fill=(203, 231, 240),
        font=font(17),
    )

    # Color ramp.
    for i in range(220):
        draw.rectangle(
            (lx0 + 230 + i, ly0 + 30, lx0 + 231 + i, ly0 + 49),
            fill=(*glass_heat(i / 219), 255),
        )
    draw.text((lx0 + 230, ly0 + 54), "low", fill=MUTED, font=font(13))
    draw.text((lx0 + 417, ly0 + 54), "high", fill=MUTED, font=font(13))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with (DATA_DIR / "summary.json").open("r", encoding="utf-8") as f:
        summary = json.load(f)
    heat = np.load(DATA_DIR / "heatmaps.npz")
    ratio_norm = heat["ratio_norm"].astype(np.float32, copy=False)
    ratio_binned = heat["ratio_binned"].astype(np.float32, copy=False)
    answer_binned = heat["answer_binned"].astype(np.float32, copy=False)
    random_binned = heat["random_binned"].astype(np.float32, copy=False)
    scar_bins = select_scars(ratio_norm, answer_binned, random_binned)

    canvas = Image.new("RGBA", (1800, 1200), (0, 0, 0, 255))
    draw_background(canvas)

    # Paint upper layers first, lower layers last, so the stack reads as transparent sheets in perspective.
    for layer in range(ratio_norm.shape[0] - 1, -1, -1):
        draw_plane(canvas, ratio_norm[layer], layer)
    draw_scars(canvas, scar_bins, ratio_norm)
    draw_labels(canvas, summary, scar_bins, ratio_binned)

    ImageDraw.Draw(canvas).rounded_rectangle(
        (42, 36, 1760, 1142), radius=38, outline=(128, 225, 255, 44), width=2
    )
    out_path = OUT_DIR / "glass-stack.png"
    canvas.convert("RGB").save(out_path, quality=95)

    np.savez_compressed(
        OUT_DIR / "glass-stack-source-data.npz",
        ratio_binned=ratio_binned,
        ratio_norm=ratio_norm,
        answer_minus_random_binned=answer_binned - random_binned,
        scar_bins=np.array(scar_bins, dtype=np.int16),
    )
    with (OUT_DIR / "glass-stack-source-summary.json").open("w", encoding="utf-8") as f:
        json.dump(
            {
                "source_heatmaps": str(DATA_DIR / "heatmaps.npz"),
                "source_summary": str(DATA_DIR / "summary.json"),
                "output": str(out_path),
                "scar_bins": scar_bins,
                "answer_over_random_delta": summary["answer_over_random_delta"],
                "layers": summary["layers"],
                "image_tokens": summary["image_tokens"],
            },
            f,
            indent=2,
        )
    print(out_path)


if __name__ == "__main__":
    main()
