# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render a spatial image-token map for the snapcompact white-box run.

The PaddleOCR-VL processor reports a 1 x 54 x 54 visual patch grid, while the
recorded hidden states contain 729 image tokens. This script folds the token
axis back to 27 x 27 (2 x 2 patch merge) and projects answer-mask delta / ratio
onto the original bitmap so the scar is visible in image space.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = HERE / "results" / "agent-viz-token-grid"
OUT = OUT_DIR / "token-grid.png"

PALETTE = {
    "bg": (4, 6, 10),
    "panel": (12, 17, 24),
    "panel2": (17, 23, 31),
    "ink": (244, 241, 225),
    "muted": (139, 153, 163),
    "grid": (49, 64, 75),
    "cyan": (75, 218, 255),
    "red": (255, 80, 66),
    "amber": (255, 194, 72),
    "green": (148, 255, 126),
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t))


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, float(t)))
    stops = [
        (0.00, (7, 12, 25)),
        (0.18, (28, 24, 91)),
        (0.38, (113, 31, 112)),
        (0.62, (220, 61, 72)),
        (0.82, (255, 152, 67)),
        (1.00, (255, 242, 158)),
    ]
    for (pa, ca), (pb, cb) in zip(stops, stops[1:]):
        if t <= pb:
            return mix(ca, cb, (t - pa) / (pb - pa))
    return stops[-1][1]


def normalize(arr: np.ndarray, q: float = 0.985) -> tuple[np.ndarray, float]:
    scale = float(np.quantile(arr, q)) if arr.size else 1.0
    if not math.isfinite(scale) or scale <= 0:
        scale = 1.0
    return np.clip(arr / scale, 0, 1), scale


def token_side(summary: dict, token_count: int) -> int:
    side = math.isqrt(token_count)
    if side * side == token_count:
        return side
    grid = summary.get("processor_meta", {}).get("image_grid_thw", [[1, 0, 0]])[0]
    _, gh, gw = grid
    merge = math.isqrt(max(1, (gh * gw) // token_count))
    if (
        merge
        and gh % merge == 0
        and gw % merge == 0
        and (gh // merge) * (gw // merge) == token_count
    ):
        return gh // merge
    raise ValueError(f"cannot fold {token_count} image tokens into a square grid")


def fold_tokens(arr: np.ndarray, side: int) -> np.ndarray:
    if arr.ndim == 1:
        return arr.reshape(side, side)
    return arr.reshape(arr.shape[0], side, side)


def heat_overlay(
    base: Image.Image, heat: np.ndarray, alpha_floor: int = 28, alpha_peak: int = 220
) -> Image.Image:
    norm, _ = normalize(heat)
    small = Image.new("RGBA", (heat.shape[1], heat.shape[0]), (0, 0, 0, 0))
    pix = small.load()
    for y in range(heat.shape[0]):
        for x in range(heat.shape[1]):
            t = float(norm[y, x])
            r, g, b = heat_color(t)
            pix[x, y] = (
                r,
                g,
                b,
                round(alpha_floor + (alpha_peak - alpha_floor) * (t**0.85)),
            )
    overlay = small.resize(base.size, Image.Resampling.BICUBIC).filter(
        ImageFilter.GaussianBlur(1.0)
    )
    dim = Image.blend(
        base.convert("RGB"), Image.new("RGB", base.size, (5, 8, 13)), 0.28
    ).convert("RGBA")
    return Image.alpha_composite(dim, overlay).convert("RGB")


def draw_token_grid(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    side: int,
    color: tuple[int, int, int] = (255, 255, 255),
) -> None:
    x0, y0, x1, y1 = box
    for i in range(side + 1):
        x = round(x0 + (x1 - x0) * i / side)
        y = round(y0 + (y1 - y0) * i / side)
        fill = (*color, 36) if hasattr(draw, "mode") else color
        draw.line((x, y0, x, y1), fill=fill, width=1)
        draw.line((x0, y, x1, y), fill=fill, width=1)


def paste_fit(
    canvas: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    resample: int = Image.Resampling.LANCZOS,
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    w = max(1, round(img.width * scale))
    h = max(1, round(img.height * scale))
    resized = img.resize((w, h), resample)
    px = x0 + (x1 - x0 - w) // 2
    py = y0 + (y1 - y0 - h) // 2
    canvas.paste(resized, (px, py))
    return (px, py, px + w, py + h)


def crop_answer(
    img: Image.Image,
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    pad_cells: int = 34,
) -> Image.Image:
    rows = img.height // pitch
    row0 = max(0, start // cols - 5)
    row1 = min(rows, end // cols + 6)
    col0 = max(0, start % cols - pad_cells)
    col1 = min(cols, end % cols + pad_cells)
    if col1 <= col0:
        col1 = min(cols, col0 + 72)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=3, outline=PALETTE["red"], width=3)
    return crop


def answer_bbox(
    start: int, end: int, cols: int, adv: int, pitch: int
) -> tuple[int, int, int, int]:
    return (
        max(0, (start % cols) * adv - adv),
        max(0, (start // cols) * pitch - 2),
        min(cols * adv, ((end - 1) % cols + 2) * adv),
        ((end - 1) // cols + 1) * pitch + 2,
    )


def draw_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str | None = None,
) -> None:
    draw.rounded_rectangle(
        box, radius=26, fill=PALETTE["panel"], outline=(32, 43, 55), width=1
    )
    x0, y0, _, _ = box
    draw.text((x0 + 24, y0 + 20), title, fill=PALETTE["ink"], font=font(28, True))
    if subtitle:
        draw.text((x0 + 24, y0 + 56), subtitle, fill=PALETTE["muted"], font=font(17))


def draw_micro_grid(
    canvas: Image.Image,
    heat: np.ndarray,
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str,
) -> None:
    draw = ImageDraw.Draw(canvas)
    draw_panel(draw, box, title, subtitle)
    x0, y0, x1, y1 = box
    gx0, gy0, gx1, gy1 = x0 + 32, y0 + 96, x1 - 32, y1 - 42
    side = heat.shape[0]
    norm, _ = normalize(heat)
    cw = (gx1 - gx0) / side
    ch = (gy1 - gy0) / side
    for r in range(side):
        for c in range(side):
            xa = round(gx0 + c * cw)
            ya = round(gy0 + r * ch)
            xb = round(gx0 + (c + 1) * cw)
            yb = round(gy0 + (r + 1) * ch)
            draw.rectangle((xa, ya, xb, yb), fill=heat_color(float(norm[r, c])))
    for i in range(0, side + 1, 3):
        x = round(gx0 + (gx1 - gx0) * i / side)
        y = round(gy0 + (gy1 - gy0) * i / side)
        draw.line((x, gy0, x, gy1), fill=(255, 255, 255, 34))
        draw.line((gx0, y, gx1, y), fill=(255, 255, 255, 34))


def label(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    color: tuple[int, int, int],
    size: int = 18,
    bold: bool = True,
) -> None:
    x, y = xy
    pad = 8
    f = font(size, bold)
    box = draw.textbbox((x, y), text, font=f)
    draw.rounded_rectangle(
        (box[0] - pad, box[1] - 4, box[2] + pad, box[3] + 5),
        radius=9,
        fill=(4, 6, 10),
        outline=color,
        width=1,
    )
    draw.text((x, y), text, fill=color, font=f)


def draw_hotspots(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    heat: np.ndarray,
    count: int = 9,
) -> None:
    x0, y0, x1, y1 = box
    side = heat.shape[0]
    flat = heat.ravel()
    # Suppress immediate duplicates by greedily keeping separated cells.
    chosen: list[int] = []
    for idx in np.argsort(flat)[::-1]:
        r, c = divmod(int(idx), side)
        if all(
            abs(r - divmod(j, side)[0]) + abs(c - divmod(j, side)[1]) >= 3
            for j in chosen
        ):
            chosen.append(int(idx))
            if len(chosen) == count:
                break
    for rank, idx in enumerate(chosen, start=1):
        r, c = divmod(idx, side)
        cx = round(x0 + (c + 0.5) * (x1 - x0) / side)
        cy = round(y0 + (r + 0.5) * (y1 - y0) / side)
        rad = 11 if rank <= 3 else 8
        draw.ellipse(
            (cx - rad, cy - rad, cx + rad, cy + rad), outline=PALETTE["amber"], width=3
        )
        if rank <= 5:
            draw.text(
                (cx + 10, cy - 16),
                str(rank),
                fill=PALETTE["amber"],
                font=font(16, True),
            )


def text_block(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    lines: Iterable[str],
    fill: tuple[int, int, int],
    size: int = 20,
    gap: int = 8,
) -> None:
    x, y = xy
    f = font(size)
    for line in lines:
        draw.text((x, y), line, fill=fill, font=f)
        y += size + gap


def render() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = json.loads((SOURCE / "summary.json").read_text())
    arrays = np.load(SOURCE / "heatmaps.npz")
    original = Image.open(SOURCE / "images" / "original.png").convert("RGB")
    masked = Image.open(SOURCE / "images" / "answer-mask.png").convert("RGB")

    answer_delta = arrays["answer_delta"].astype(np.float32, copy=False)
    random_delta = arrays["random_delta"].astype(np.float32, copy=False)
    ratio = arrays["ratio"].astype(np.float32, copy=False)
    side = token_side(summary, answer_delta.shape[1])
    answer_grid = fold_tokens(answer_delta, side)
    random_grid = fold_tokens(random_delta, side)
    ratio_grid = fold_tokens(ratio, side)

    answer_mean = answer_grid.mean(axis=0)
    random_mean = random_grid.mean(axis=0)
    ratio_mean = ratio_grid.mean(axis=0)
    early_ratio = ratio_grid[:4].mean(axis=0)
    mid_delta = answer_grid[6:13].mean(axis=0)
    late_delta = answer_grid[-4:].mean(axis=0)

    np.savez_compressed(
        OUT_DIR / "token_grid_source.npz",
        answer_mean=answer_mean,
        random_mean=random_mean,
        ratio_mean=ratio_mean,
        early_ratio=early_ratio,
        mid_answer_delta=mid_delta,
        late_answer_delta=late_delta,
        image_grid_thw=np.array(
            summary["processor_meta"]["image_grid_thw"][0], dtype=np.int32
        ),
    )
    (OUT_DIR / "token_grid_summary.json").write_text(
        json.dumps(
            {
                "source": str(SOURCE),
                "image_grid_thw": summary["processor_meta"]["image_grid_thw"][0],
                "image_tokens": int(summary["image_tokens"]),
                "rendered_token_grid": [side, side],
                "patch_merge": int(
                    summary["processor_meta"]["image_grid_thw"][0][1] // side
                ),
                "answer_over_random_delta": float(summary["answer_over_random_delta"]),
                "question": summary["question"]["q"],
                "answer_text": summary["question"]["answer_text"],
            },
            indent=2,
        )
    )

    W, H = 2200, 1500
    canvas = Image.new("RGB", (W, H), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, H, 18):
        draw.line((0, y, W, y), fill=(7, 10 + (y % 11), 17 + (y % 13)))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-320, -240, 960, 780), fill=(255, 80, 66, 34))
    gd.ellipse((920, -120, 2350, 1100), fill=(75, 218, 255, 30))
    gd.ellipse((760, 860, 1810, 1760), fill=(255, 194, 72, 18))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(95))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 48), "SNAPCOMPACT TOKEN FIELD", fill=PALETTE["amber"], font=font(24, True)
    )
    draw.text(
        (64, 86),
        "Where the hidden-state scar lands on the bitmap",
        fill=PALETTE["ink"],
        font=font(62, True),
    )
    draw.text(
        (66, 164),
        "PaddleOCR-VL reports a 1×54×54 image patch grid; 729 hidden-state image tokens fold back to 27×27 spatial cells.",
        fill=PALETTE["muted"],
        font=font(24),
    )

    # Main spatial map.
    main_panel = (545, 225, 1455, 1340)
    draw_panel(
        draw,
        main_panel,
        "answer-mask delta projected onto image tokens",
        "mean ||hidden(original) − hidden(answer-mask)|| across 19 layers",
    )
    map_box = (610, 330, 1390, 1110)
    projected = heat_overlay(original, answer_mean)
    pasted = paste_fit(canvas, projected, map_box, Image.Resampling.LANCZOS)
    # Grid + answer box sit over the pasted square.
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    draw_token_grid(od, pasted, side, (255, 255, 255))
    bbox = answer_bbox(
        summary["question"]["answer_start"],
        summary["question"]["answer_end"],
        summary["geometry"]["cols"],
        8,
        13,
    )
    sx = (pasted[2] - pasted[0]) / original.width
    sy = (pasted[3] - pasted[1]) / original.height
    answer_rect = (
        round(pasted[0] + bbox[0] * sx),
        round(pasted[1] + bbox[1] * sy),
        round(pasted[0] + bbox[2] * sx),
        round(pasted[1] + bbox[3] * sy),
    )
    od.rounded_rectangle(answer_rect, radius=8, outline=(*PALETTE["red"], 255), width=5)
    draw_hotspots(od, pasted, answer_mean)
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(canvas)
    label(
        draw,
        (pasted[0] + 18, pasted[1] + 18),
        "27×27 reconstructed image-token grid",
        PALETTE["cyan"],
        19,
    )
    label(
        draw,
        (answer_rect[2] + 14, answer_rect[1] - 5),
        "erased answer text",
        PALETTE["red"],
        18,
    )
    text_block(
        draw,
        (620, 1162),
        [
            f"Q: {summary['question']['q']}",
            f"Gold answer: {summary['question']['answer_text']}    answer-mask mean delta: {summary['answer_delta_mean']:.2f}    random-mask mean delta: {summary['random_delta_mean']:.2f}",
            f"Answer/random delta ratio: {summary['answer_over_random_delta']:.2f}×. Bright cells are token locations most perturbed by hiding the answer span.",
        ],
        PALETTE["muted"],
        20,
        7,
    )

    # Evidence crops.
    left = (64, 225, 505, 1340)
    draw_panel(draw, left, "bitmap intervention", "original crop vs. answer erased")
    crop = crop_answer(
        original,
        summary["question"]["answer_start"],
        summary["question"]["answer_end"],
        summary["geometry"]["cols"],
        8,
        13,
    )
    mcrop = crop_answer(
        masked,
        summary["question"]["answer_start"],
        summary["question"]["answer_end"],
        summary["geometry"]["cols"],
        8,
        13,
    )
    draw.text((96, 332), "ORIGINAL", fill=PALETTE["cyan"], font=font(17, True))
    draw.rounded_rectangle(
        (94, 360, 475, 525),
        radius=16,
        fill=(240, 238, 226),
        outline=PALETTE["cyan"],
        width=3,
    )
    paste_fit(canvas, crop, (108, 374, 461, 511), Image.Resampling.NEAREST)
    draw.text((96, 572), "ANSWER MASK", fill=PALETTE["red"], font=font(17, True))
    draw.rounded_rectangle(
        (94, 600, 475, 765),
        radius=16,
        fill=(240, 238, 226),
        outline=PALETTE["red"],
        width=3,
    )
    paste_fit(canvas, mcrop, (108, 614, 461, 751), Image.Resampling.NEAREST)
    draw.text((96, 822), "source arrays", fill=PALETTE["muted"], font=font(17, True))
    text_block(
        draw,
        (96, 858),
        [
            "heatmaps.npz:",
            "answer_delta[19,729]",
            "random_delta[19,729]",
            "ratio[19,729]",
            "",
            "fold rule:",
            "54×54 patches / 2×2 merge",
            "→ 27×27 visual tokens",
        ],
        PALETTE["ink"],
        21,
        8,
    )
    draw.rounded_rectangle(
        (96, 1110, 472, 1268),
        radius=18,
        fill=PALETTE["panel2"],
        outline=(38, 51, 64),
        width=1,
    )
    draw.text((118, 1132), "scar strength", fill=PALETTE["amber"], font=font(18, True))
    draw.text(
        (118, 1170),
        f"{summary['answer_over_random_delta']:.2f}×",
        fill=PALETTE["ink"],
        font=font(54, True),
    )
    draw.text(
        (120, 1232),
        "answer-mask / random-mask mean delta",
        fill=PALETTE["muted"],
        font=font(17),
    )

    # Right analytical small multiples.
    draw_micro_grid(
        canvas,
        ratio_mean,
        (1495, 225, 2136, 590),
        "ratio field",
        "mean answer_delta / random_delta",
    )
    draw_micro_grid(
        canvas, early_ratio, (1495, 620, 1810, 975), "early layers", "ratio, layers 0–3"
    )
    draw_micro_grid(
        canvas,
        mid_delta,
        (1820, 620, 2136, 975),
        "middle layers",
        "answer delta, layers 6–12",
    )
    draw_micro_grid(
        canvas,
        late_delta,
        (1495, 1005, 1810, 1340),
        "late layers",
        "answer delta, last 4",
    )
    draw_micro_grid(
        canvas,
        random_mean,
        (1820, 1005, 2136, 1340),
        "random control",
        "random-mask delta",
    )

    # Color legend.
    lx0, ly0, lx1, ly1 = 1530, 530, 2100, 552
    for x in range(lx0, lx1):
        draw.line((x, ly0, x, ly1), fill=heat_color((x - lx0) / (lx1 - lx0)))
    draw.text((lx0, ly1 + 10), "low", fill=PALETTE["muted"], font=font(15))
    draw.text((lx1 - 34, ly1 + 10), "high", fill=PALETTE["muted"], font=font(15))

    canvas.save(OUT)


if __name__ == "__main__":
    render()
