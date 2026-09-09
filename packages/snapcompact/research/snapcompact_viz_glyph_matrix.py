# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render a glyph-to-activation matrix for the snapcompact answer scar.

The figure keeps the original OCR bitmap visible, then projects the 27x27 image-token
activation field from heatmaps.npz back onto that bitmap. The answer glyphs are
outlined in text-cell coordinates; high-scar image tokens are outlined in model-token
coordinates; side bars show how the same region changes across decoder layers.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE / "results" / "tensor-heatmap-paddleocr-q7"
DEFAULT_OUT = HERE / "results" / "agent-viz-glyph-matrix"

PALETTE = {
    "bg": (3, 6, 12),
    "panel": (10, 15, 22),
    "panel2": (13, 21, 30),
    "ink": (244, 245, 232),
    "muted": (139, 154, 166),
    "grid": (37, 53, 66),
    "cyan": (86, 224, 255),
    "red": (255, 78, 69),
    "amber": (255, 202, 82),
    "green": (135, 255, 159),
    "violet": (173, 116, 255),
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    stops = [
        (0.00, (8, 10, 26)),
        (0.22, (33, 25, 81)),
        (0.46, (117, 41, 117)),
        (0.68, (224, 67, 79)),
        (0.86, (255, 165, 73)),
        (1.00, (255, 243, 174)),
    ]
    for (ta, ca), (tb, cb) in zip(stops, stops[1:]):
        if t <= tb:
            return mix(ca, cb, (t - ta) / (tb - ta))
    return stops[-1][1]


def quantile_norm(values: np.ndarray, q: float = 0.98) -> np.ndarray:
    scale = float(np.quantile(values, q)) if values.size else 1.0
    if scale <= 0 or not math.isfinite(scale):
        scale = 1.0
    return np.clip(values / scale, 0.0, 1.0)


def rounded_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str | None = None,
    subtitle: str | None = None,
) -> None:
    draw.rounded_rectangle(
        box, radius=24, fill=PALETTE["panel"], outline=(34, 48, 61), width=1
    )
    if title:
        draw.text(
            (box[0] + 24, box[1] + 18), title, fill=PALETTE["ink"], font=font(28, True)
        )
    if subtitle:
        draw.text(
            (box[0] + 24, box[1] + 54), subtitle, fill=PALETTE["muted"], font=font(16)
        )


def token_boxes(side: int, grid: int) -> list[tuple[int, int, int, int]]:
    boxes = []
    for idx in range(grid * grid):
        r, c = divmod(idx, grid)
        x0 = round(c * side / grid)
        y0 = round(r * side / grid)
        x1 = round((c + 1) * side / grid)
        y1 = round((r + 1) * side / grid)
        boxes.append((x0, y0, x1, y1))
    return boxes


def intersect_area(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> float:
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def answer_bbox(
    start: int, end: int, cols: int, adv: int, pitch: int
) -> tuple[int, int, int, int]:
    row0, col0 = divmod(start, cols)
    row1, col1 = divmod(max(start, end - 1), cols)
    x0 = max(0, col0 * adv)
    y0 = max(0, row0 * pitch)
    x1 = (col1 + 1) * adv
    y1 = (row1 + 1) * pitch
    return x0, y0, x1, y1


def draw_text_wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    width: int,
    fill: tuple[int, int, int],
    size: int,
    bold: bool = False,
    line_gap: int = 4,
) -> int:
    words = text.split()
    lines: list[str] = []
    current = ""
    f = font(size, bold)
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if draw.textbbox((0, 0), candidate, font=f)[2] <= width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    x, y = xy
    for line in lines:
        draw.text((x, y), line, fill=fill, font=f)
        y += size + line_gap
    return y


def paste_shadowed(canvas: Image.Image, img: Image.Image, xy: tuple[int, int]) -> None:
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    alpha = Image.new("L", img.size, 180)
    shadow.putalpha(alpha)
    canvas.alpha_composite(
        shadow.filter(ImageFilter.GaussianBlur(12)), (xy[0] + 8, xy[1] + 10)
    )
    canvas.alpha_composite(img, xy)


def draw_activation_overlay(
    original: Image.Image,
    answer_mask: Image.Image,
    token_score: np.ndarray,
    top_tokens: Iterable[int],
    answer_tokens: Iterable[int],
    bbox: tuple[int, int, int, int],
) -> Image.Image:
    side = original.width
    grid = int(round(math.sqrt(token_score.size)))
    if grid * grid != token_score.size:
        raise ValueError(f"expected square image token grid, got {token_score.size}")
    base = original.convert("RGBA")
    tint = Image.new("RGBA", base.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(tint)
    boxes = token_boxes(side, grid)
    for idx, box in enumerate(boxes):
        t = float(token_score[idx])
        if t <= 0:
            continue
        r, g, b = heat_color(t)
        alpha = round(25 + 142 * t)
        td.rectangle(box, fill=(r, g, b, alpha))
    composite = Image.alpha_composite(base, tint)
    draw = ImageDraw.Draw(composite)

    for idx in top_tokens:
        box = boxes[int(idx)]
        draw.rounded_rectangle(
            box, radius=3, outline=PALETTE["amber"] + (235,), width=3
        )
    for idx in answer_tokens:
        box = boxes[int(idx)]
        draw.rounded_rectangle(box, radius=4, outline=PALETTE["cyan"] + (245,), width=4)

    glow = Image.new("RGBA", composite.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for w, a in ((16, 46), (9, 80), (4, 235)):
        gd.rounded_rectangle(
            (bbox[0] - 8, bbox[1] - 7, bbox[2] + 8, bbox[3] + 8),
            radius=8,
            outline=PALETTE["red"] + (a,),
            width=w,
        )
    composite = Image.alpha_composite(
        composite, glow.filter(ImageFilter.GaussianBlur(4))
    )
    draw = ImageDraw.Draw(composite)
    draw.rounded_rectangle(
        (bbox[0] - 8, bbox[1] - 7, bbox[2] + 8, bbox[3] + 8),
        radius=8,
        outline=PALETTE["red"] + (255,),
        width=3,
    )

    mask_delta = Image.blend(
        original.convert("RGB"), answer_mask.convert("RGB"), 0.42
    ).convert("RGBA")
    crop = mask_delta.crop(
        (
            max(0, bbox[0] - 76),
            max(0, bbox[1] - 42),
            min(side, bbox[2] + 154),
            min(side, bbox[3] + 48),
        )
    )
    crop = crop.resize((crop.width * 3, crop.height * 3), Image.Resampling.NEAREST)
    crop_draw = ImageDraw.Draw(crop)
    scale = 3
    cx0 = (bbox[0] - max(0, bbox[0] - 76)) * scale
    cy0 = (bbox[1] - max(0, bbox[1] - 42)) * scale
    cx1 = (bbox[2] - max(0, bbox[0] - 76)) * scale
    cy1 = (bbox[3] - max(0, bbox[1] - 42)) * scale
    crop_draw.rounded_rectangle(
        (cx0 - 4, cy0 - 4, cx1 + 4, cy1 + 4),
        radius=8,
        outline=PALETTE["red"] + (255,),
        width=5,
    )
    composite.alpha_composite(crop, (side - crop.width - 20, 20))
    draw = ImageDraw.Draw(composite)
    draw.text(
        (side - crop.width - 16, 20 + crop.height + 8),
        "answer glyph crop: original → masked",
        fill=PALETTE["ink"] + (235,),
        font=font(18, True),
    )
    return composite


def draw_layer_bars(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    answer_layer: np.ndarray,
    random_layer: np.ndarray,
    answer_region_layer: np.ndarray,
    ratio_layer: np.ndarray,
) -> None:
    rounded_panel(
        draw,
        box,
        "layer-by-layer scar",
        "red = answer mask, green = equal random mask, cyan = answer glyph tokens",
    )
    x0, y0, x1, y1 = box
    chart = (x0 + 74, y0 + 103, x1 - 34, y1 - 72)
    rows = answer_layer.size
    row_h = (chart[3] - chart[1]) / rows
    scale = float(
        np.quantile(
            np.concatenate([answer_layer, random_layer, answer_region_layer]), 0.96
        )
    )
    scale = max(scale, 1e-6)
    for i in range(rows):
        y = chart[1] + i * row_h
        draw.text(
            (x0 + 28, round(y + row_h * 0.18)),
            f"L{i:02d}",
            fill=PALETTE["muted"],
            font=font(12),
        )
        max_w = chart[2] - chart[0]
        aw = round(max_w * min(1.0, float(answer_layer[i]) / scale))
        rw = round(max_w * min(1.0, float(random_layer[i]) / scale))
        gw = round(max_w * min(1.0, float(answer_region_layer[i]) / scale))
        yy = round(y)
        draw.rounded_rectangle(
            (chart[0], yy + 2, chart[0] + aw, yy + 8), radius=3, fill=PALETTE["red"]
        )
        draw.rounded_rectangle(
            (chart[0], yy + 11, chart[0] + rw, yy + 17), radius=3, fill=PALETTE["green"]
        )
        draw.rounded_rectangle(
            (chart[0], yy + 20, chart[0] + gw, yy + 27), radius=3, fill=PALETTE["cyan"]
        )
        ratio = float(ratio_layer[i])
        draw.text(
            (chart[2] - 58, yy + 8),
            f"{ratio:4.1f}×",
            fill=PALETTE["amber"],
            font=font(13, True),
        )
    draw.text(
        (chart[0], y1 - 45),
        "Mean delta per decoder layer. Ratio labels compare answer-mask vs random-mask deltas.",
        fill=PALETTE["muted"],
        font=font(14),
    )


def draw_scar_strip(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    ratio_norm: np.ndarray,
    answer_tokens: list[int],
    top_tokens: list[int],
) -> None:
    rounded_panel(
        draw,
        box,
        "token scar matrix",
        "decoder layers × image tokens; vertical lines locate answer glyphs and top scar bins",
    )
    x0, y0, x1, y1 = box
    hx0, hy0, hx1, hy1 = x0 + 58, y0 + 90, x1 - 28, y1 - 54
    rows, cols = ratio_norm.shape
    cw = (hx1 - hx0) / cols
    ch = (hy1 - hy0) / rows
    for r in range(rows):
        ya = round(hy0 + r * ch)
        yb = round(hy0 + (r + 1) * ch)
        for c in range(cols):
            xa = round(hx0 + c * cw)
            xb = round(hx0 + (c + 1) * cw)
            draw.rectangle((xa, ya, xb, yb), fill=heat_color(float(ratio_norm[r, c])))
    for tok in answer_tokens:
        x = round(hx0 + (tok + 0.5) * (hx1 - hx0) / 729)
        draw.line((x, hy0 - 8, x, hy1 + 8), fill=PALETTE["cyan"], width=2)
    for tok in top_tokens[:12]:
        x = round(hx0 + (tok + 0.5) * (hx1 - hx0) / 729)
        draw.line((x, hy0, x, hy1), fill=PALETTE["amber"], width=1)
    for r in range(0, rows, 4):
        y = round(hy0 + (r + 0.5) * ch)
        draw.text((x0 + 22, y - 7), str(r), fill=PALETTE["muted"], font=font(12))
    draw.text(
        (hx0, y1 - 32), "image-token sequence →", fill=PALETTE["muted"], font=font(13)
    )


def draw_top_token_table(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    top_tokens: list[int],
    ratio_mean: np.ndarray,
    answer_mean: np.ndarray,
    grid: int,
) -> None:
    rounded_panel(draw, box, "highest-scar token bins", "actual heatmaps.npz token IDs")
    x0, y0, _, y1 = box
    y = y0 + 90
    row_gap = 26
    max_rows = max(1, min(8, (y1 - y - 18) // row_gap))
    bar_scale = max(1e-6, float(np.quantile(answer_mean, 0.98)))
    for rank, tok in enumerate(top_tokens[:max_rows], start=1):
        r, c = divmod(tok, grid)
        draw.text(
            (x0 + 28, y), f"{rank:02d}", fill=PALETTE["amber"], font=font(13, True)
        )
        draw.text(
            (x0 + 68, y), f"token {tok:03d}", fill=PALETTE["ink"], font=font(14, True)
        )
        draw.text(
            (x0 + 164, y),
            f"grid r{r:02d} c{c:02d}",
            fill=PALETTE["muted"],
            font=font(13),
        )
        draw.text(
            (x0 + 292, y),
            f"ratio {ratio_mean[tok]:.2f}×",
            fill=PALETTE["cyan"],
            font=font(13, True),
        )
        bar_w = round(112 * min(1.0, float(answer_mean[tok]) / bar_scale))
        draw.rounded_rectangle(
            (x0 + 408, y + 4, x0 + 408 + bar_w, y + 14), radius=4, fill=PALETTE["red"]
        )
        y += row_gap


def render(source: Path, out_dir: Path) -> None:
    summary = json.loads((source / "summary.json").read_text())
    data = np.load(source / "heatmaps.npz")
    original = Image.open(source / "images" / "original.png").convert("RGB")
    answer_mask = Image.open(source / "images" / "answer-mask.png").convert("RGB")

    answer_delta = data["answer_delta"].astype(np.float32)
    random_delta = data["random_delta"].astype(np.float32)
    ratio = data["ratio"].astype(np.float32)
    ratio_binned = data["ratio_binned"].astype(np.float32)
    ratio_norm_binned = data["ratio_norm"].astype(np.float32)

    q = summary["question"]
    geom = summary["geometry"]
    cols = int(geom["cols"])
    rows = int(geom["rows"])
    adv = original.width // cols
    pitch = max(1, original.height // rows)
    bbox = answer_bbox(int(q["answer_start"]), int(q["answer_end"]), cols, adv, pitch)

    token_count = answer_delta.shape[1]
    grid = int(round(math.sqrt(token_count)))
    boxes = token_boxes(original.width, grid)
    answer_area = (bbox[0], bbox[1], bbox[2], bbox[3])
    answer_tokens = [
        i for i, b in enumerate(boxes) if intersect_area(answer_area, b) > 0
    ]
    if not answer_tokens:
        center_x = (bbox[0] + bbox[2]) / 2
        center_y = (bbox[1] + bbox[3]) / 2
        answer_tokens = [
            min(
                token_count - 1,
                max(
                    0,
                    int(center_y / original.height * grid) * grid
                    + int(center_x / original.width * grid),
                ),
            )
        ]

    ratio_mean = ratio.mean(axis=0)
    answer_mean = answer_delta.mean(axis=0)
    token_score = quantile_norm(ratio_mean, 0.985)
    answer_set = set(answer_tokens)
    top_tokens = [
        int(i) for i in np.argsort(ratio_mean)[::-1] if int(i) not in answer_set
    ][:24]
    answer_region_layer = answer_delta[:, answer_tokens].mean(axis=1)
    answer_layer = answer_delta.mean(axis=1)
    random_layer = random_delta.mean(axis=1)
    ratio_layer = answer_layer / np.maximum(random_layer, 1e-6)

    out_dir.mkdir(parents=True, exist_ok=True)
    overlay = draw_activation_overlay(
        original, answer_mask, token_score, top_tokens[:18], answer_tokens, bbox
    )
    overlay = overlay.resize((760, 760), Image.Resampling.LANCZOS)

    W, H = 1900, 1260
    canvas = Image.new("RGBA", (W, H), PALETTE["bg"] + (255,))
    draw = ImageDraw.Draw(canvas)
    for y in range(0, H, 16):
        draw.line((0, y, W, y), fill=(6, 11 + y % 17, 18 + y % 11, 255))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-220, 120, 900, 1040), fill=PALETTE["red"] + (28,))
    gd.ellipse((820, -260, 2100, 820), fill=PALETTE["cyan"] + (26,))
    gd.ellipse((980, 650, 2050, 1510), fill=PALETTE["violet"] + (20,))
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(78)))
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 42), "SNAPCOMPACT GLYPH MATRIX", fill=PALETTE["amber"], font=font(22, True)
    )
    draw.text(
        (64, 78),
        "The answer glyphs leave a hidden activation scar",
        fill=PALETTE["ink"],
        font=font(56, True),
    )
    subtitle = "Original dense text bitmap, overlaid with answer/random activation ratios from 19 decoder layers × 729 image tokens."
    draw.text((68, 145), subtitle, fill=PALETTE["muted"], font=font(22))

    rounded_panel(
        draw,
        (52, 205, 862, 1066),
        "visible glyphs ↔ hidden tokens",
        "red box = actual answer cells; cyan = intersecting image tokens; amber = top scar bins",
    )
    paste_shadowed(canvas, overlay, (78, 282))
    draw.text(
        (82, 1085), f"Question: {q['q']}", fill=PALETTE["ink"], font=font(21, True)
    )
    draw.text(
        (82, 1120),
        f"Gold answer: {q['answer_text']}  ·  cells {q['answer_start']}–{q['answer_end'] - 1}",
        fill=PALETTE["amber"],
        font=font(24, True),
    )
    draw.text(
        (82, 1160),
        f"Answer/random mean delta: {summary['answer_over_random_delta']:.2f}×",
        fill=PALETTE["cyan"],
        font=font(22, True),
    )

    draw_layer_bars(
        draw,
        (900, 205, 1838, 628),
        answer_layer,
        random_layer,
        answer_region_layer,
        ratio_layer,
    )
    draw_scar_strip(
        draw, (900, 662, 1838, 930), ratio_norm_binned, answer_tokens, top_tokens
    )
    draw_top_token_table(
        draw, (900, 964, 1838, 1196), top_tokens, ratio_mean, answer_mean, grid
    )

    for i in range(240):
        draw.rectangle((1568 + i, 156, 1569 + i, 174), fill=heat_color(i / 239))
    draw.text((1568, 132), "activation ratio", fill=PALETTE["muted"], font=font(13))
    draw.text((1568, 179), "low", fill=PALETTE["muted"], font=font(12))
    draw.text((1776, 179), "high", fill=PALETTE["muted"], font=font(12))

    png = out_dir / "glyph-matrix.png"
    canvas.convert("RGB").save(png, quality=96)

    source_data = {
        "source": str(source),
        "question": q,
        "geometry": {
            "text_cols": cols,
            "text_rows": rows,
            "glyph_adv": adv,
            "glyph_pitch": pitch,
            "image_token_grid": [grid, grid],
        },
        "answer_bbox_pixels": list(map(int, bbox)),
        "answer_image_tokens": [int(x) for x in answer_tokens],
        "top_scar_tokens": [
            {
                "token": int(tok),
                "row": int(tok // grid),
                "col": int(tok % grid),
                "mean_ratio": float(ratio_mean[tok]),
                "mean_answer_delta": float(answer_mean[tok]),
            }
            for tok in top_tokens[:24]
        ],
        "mean_answer_delta": float(answer_delta.mean()),
        "mean_random_delta": float(random_delta.mean()),
        "answer_over_random_delta": float(summary["answer_over_random_delta"]),
        "max_ratio_binned": float(ratio_binned.max()),
    }
    (out_dir / "glyph-matrix-data.json").write_text(json.dumps(source_data, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    render(args.source, args.out_dir)
    print(args.out_dir / "glyph-matrix.png")


if __name__ == "__main__":
    main()
