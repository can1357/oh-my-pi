# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render a cleaner prompt-specific spotlight figure for Qwen snapcompact controls."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
PALETTE = {
    "bg": (5, 7, 10),
    "panel": (12, 17, 23),
    "panel2": (8, 12, 17),
    "ink": (241, 239, 224),
    "muted": (143, 154, 160),
    "orange": (255, 112, 72),
    "cyan": (75, 220, 255),
    "green": (148, 255, 117),
    "amber": (255, 196, 68),
    "red": (255, 76, 62),
    "purple": (188, 112, 255),
}


def ui_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def heat_color(t: float, theme: str) -> tuple[int, int, int, int]:
    t = max(0.0, min(1.0, t))
    if theme == "cyan":
        rgb0, rgb1 = (10, 38, 62), (75, 220, 255)
    else:
        rgb0, rgb1 = (62, 25, 10), (255, 112, 72)
    rgb = tuple(round(rgb0[i] + (rgb1[i] - rgb0[i]) * t) for i in range(3))
    alpha = round(20 + 210 * t)
    return (*rgb, alpha)


def normalize_positive(arr: np.ndarray) -> np.ndarray:
    arr = np.maximum(arr, 0)
    hi = float(np.quantile(arr, 0.985)) if arr.size else 1.0
    if hi <= 0:
        hi = 1.0
    return np.clip(arr / hi, 0, 1)


def smooth_map(grid: np.ndarray, radius: float = 1.45) -> np.ndarray:
    g = normalize_positive(grid)
    img = Image.fromarray(np.uint8(g * 255), mode="L").filter(
        ImageFilter.GaussianBlur(radius=radius)
    )
    return np.asarray(img, dtype=np.float32) / 255.0


def answer_bbox(
    indices: list[int], grid: int, image_w: int, image_h: int
) -> tuple[int, int, int, int]:
    rows = [idx // grid for idx in indices]
    cols = [idx % grid for idx in indices]
    x0 = int(min(cols) / grid * image_w)
    x1 = int((max(cols) + 1) / grid * image_w)
    y0 = int(min(rows) / grid * image_h)
    y1 = int((max(rows) + 1) / grid * image_h)
    return x0, y0, x1, y1


def overlay_heat(
    base: Image.Image, heat: np.ndarray, bbox: tuple[int, int, int, int], theme: str
) -> Image.Image:
    base_rgba = base.convert("RGBA")
    heat_img = Image.new("RGBA", base.size, (0, 0, 0, 0))
    # Upscale smoothed 56x56 field to bitmap size; threshold softens static.
    up = Image.fromarray(np.uint8(heat * 255), mode="L").resize(
        base.size, Image.Resampling.BICUBIC
    )
    vals = np.asarray(up, dtype=np.float32) / 255.0
    threshold = float(np.quantile(vals, 0.72))
    vals = np.clip((vals - threshold) / max(1e-6, 1.0 - threshold), 0, 1)
    px = heat_img.load()
    for y in range(0, heat_img.height, 2):
        for x in range(0, heat_img.width, 2):
            t = float(vals[y, x])
            if t <= 0:
                continue
            color = heat_color(t, theme)
            px[x, y] = color
            if x + 1 < heat_img.width:
                px[x + 1, y] = color
            if y + 1 < heat_img.height:
                px[x, y + 1] = color
            if x + 1 < heat_img.width and y + 1 < heat_img.height:
                px[x + 1, y + 1] = color
    out = Image.alpha_composite(base_rgba, heat_img).convert("RGB")
    draw = ImageDraw.Draw(out)
    color = PALETTE["cyan"] if theme == "cyan" else PALETTE["orange"]
    draw.rounded_rectangle(bbox, radius=4, outline=color, width=6)
    # spotlight ring around answer bbox
    x0, y0, x1, y1 = bbox
    pad = 24
    draw.rounded_rectangle(
        (x0 - pad, y0 - pad, x1 + pad, y1 + pad), radius=16, outline=color, width=3
    )
    return out


def crop_box(
    img: Image.Image, bbox: tuple[int, int, int, int], pad: int = 180
) -> Image.Image:
    x0, y0, x1, y1 = bbox
    return img.crop(
        (
            max(0, x0 - pad),
            max(0, y0 - pad),
            min(img.width, x1 + pad),
            min(img.height, y1 + pad),
        )
    ).convert("RGB")


def paste_fit(
    canvas: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    resample: int = Image.Resampling.LANCZOS,
) -> None:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))), resample
    )
    canvas.paste(
        resized,
        (x0 + (x1 - x0 - resized.width) // 2, y0 + (y1 - y0 - resized.height) // 2),
    )


def region_score(grid_map: np.ndarray, indices: list[int]) -> float:
    if not indices:
        return 0.0
    flat = grid_map.ravel()
    return float(np.mean([flat[i] for i in indices if i < len(flat)]))


def random_region_scores(
    grid_map: np.ndarray, region_size: int, count: int = 600, seed: int = 7
) -> np.ndarray:
    rng = random.Random(seed)
    flat = grid_map.ravel()
    scores = []
    for _ in range(count):
        picks = rng.sample(range(len(flat)), min(region_size, len(flat)))
        scores.append(float(np.mean(flat[picks])))
    return np.array(scores, dtype=np.float32)


def draw_score_card(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str,
    score: float,
    random_scores: np.ndarray,
    color: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=18, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
    )
    draw.text((x0 + 20, y0 + 18), title, fill=color, font=ui_font(22, True))
    percentile = float((random_scores < score).mean() * 100)
    draw.text(
        (x0 + 20, y0 + 50),
        f"answer region beats {percentile:.0f}% of random same-size regions",
        fill=PALETTE["muted"],
        font=ui_font(16),
    )
    gx0, gy0, gx1, gy1 = x0 + 28, y0 + 96, x1 - 28, y1 - 42
    lo = float(min(random_scores.min(), score))
    hi = float(max(random_scores.max(), score))
    if hi <= lo:
        hi = lo + 1e-6
    bins = np.linspace(lo, hi, 30)
    hist, _ = np.histogram(random_scores, bins=bins)
    max_h = max(1, int(hist.max()))
    bw = (gx1 - gx0) / len(hist)
    for i, h in enumerate(hist):
        xa = gx0 + i * bw
        xb = gx0 + (i + 1) * bw - 1
        ya = gy1 - (gy1 - gy0) * int(h) / max_h
        draw.rectangle((round(xa), round(ya), round(xb), gy1), fill=(37, 49, 58))
    sx = gx0 + (gx1 - gx0) * (score - lo) / (hi - lo)
    draw.line((sx, gy0 - 8, sx, gy1 + 10), fill=color, width=5)
    draw.text((round(sx) - 34, gy0 - 36), "answer", fill=color, font=ui_font(15, True))


def draw_generation_rows(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    generations: dict[str, str],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=24, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (x0 + 28, y0 + 24),
        "causal patch check",
        fill=PALETTE["ink"],
        font=ui_font(30, True),
    )
    draw.text(
        (x0 + 28, y0 + 60),
        "Patch before decoder layer 0; only the true answer-region patch changes the answer.",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    rows = [
        ("normal", generations["normal"], PALETTE["green"]),
        ("random region patch", generations["random_mean_patch"], PALETTE["cyan"]),
        ("answer region patch", generations["answer_mean_patch"], PALETTE["red"]),
        (
            "all image tokens zero",
            generations["all_image_zero"] or "∅",
            PALETTE["purple"],
        ),
    ]
    y = y0 + 116
    for label, text, color in rows:
        draw.rounded_rectangle(
            (x0 + 28, y, x1 - 28, y + 62),
            radius=14,
            fill=PALETTE["panel2"],
            outline=(34, 48, 58),
            width=1,
        )
        draw.text((x0 + 48, y + 17), label.upper(), fill=color, font=ui_font(15, True))
        draw.text(
            (x0 + 330, y + 13), text[:70], fill=PALETTE["ink"], font=ui_font(24, True)
        )
        y += 78


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir",
        default=str(HERE / "results" / "qwen-control-intervention-q3-d12-prehook"),
    )
    ap.add_argument(
        "--out",
        default=str(
            HERE
            / "results"
            / "qwen-control-intervention-q3-d12-prehook"
            / "spotlight-control.png"
        ),
    )
    args = ap.parse_args()

    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "control_intervention.npz")
    img = Image.open(result_dir / "images" / "image-carrier.png").convert("RGB")

    primary = summary["primary"]
    distractor = summary["distractor"]
    primary_meta = summary["primary_meta"]
    distractor_meta = summary["distractor_meta"]
    grid = primary_meta["image_grid"]
    primary_layer = primary_meta["peak_layer"]
    distractor_layer = distractor_meta["peak_layer"]
    primary_norm = data["primary_norm"][primary_layer].reshape(grid, grid)
    distractor_norm = data["distractor_norm"][distractor_layer].reshape(grid, grid)

    # Prompt-specific contrast removes shared visual texture: what lights up more
    # for this question than for the other question?
    primary_contrast = smooth_map(primary_norm - distractor_norm)
    distractor_contrast = smooth_map(distractor_norm - primary_norm)
    primary_bbox = answer_bbox(
        primary_meta["answer_indices"], grid, img.width, img.height
    )
    distractor_bbox = answer_bbox(
        distractor_meta["answer_indices"], grid, img.width, img.height
    )
    primary_overlay = overlay_heat(img, primary_contrast, primary_bbox, "orange")
    distractor_overlay = overlay_heat(img, distractor_contrast, distractor_bbox, "cyan")

    primary_score = region_score(primary_contrast, primary_meta["answer_indices"])
    distractor_score = region_score(
        distractor_contrast, distractor_meta["answer_indices"]
    )
    primary_random = random_region_scores(
        primary_contrast, len(primary_meta["answer_indices"]), seed=11
    )
    distractor_random = random_region_scores(
        distractor_contrast, len(distractor_meta["answer_indices"]), seed=13
    )

    w, h = 2200, 1320
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 900, 700), fill=(255, 112, 72, 28))
    gd.ellipse((1160, 120, 2460, 1340), fill=(75, 220, 255, 25))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 42),
        "QWEN SNAPCOMPACT SPOTLIGHT",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "Subtract the other question; the signal stops looking like static",
        fill=PALETTE["ink"],
        font=ui_font(58, True),
    )
    draw.text(
        (66, 160),
        "These are not raw activation carpets. Each overlay is prompt-specific excess: this question’s map minus the other question’s map, smoothed and thresholded.",
        fill=PALETTE["muted"],
        font=ui_font(23),
    )

    # Overlay panels.
    draw.rounded_rectangle(
        (64, 230, 1068, 794),
        radius=28,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (96, 260),
        "primary prompt spotlight",
        fill=PALETTE["orange"],
        font=ui_font(31, True),
    )
    draw.text(
        (96, 298),
        f"{primary['q']} → {primary['answer_text']}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    primary_crop = crop_box(primary_overlay, primary_bbox, pad=300)
    paste_fit(canvas, primary_crop, (96, 342, 694, 760), Image.Resampling.LANCZOS)
    draw.rounded_rectangle(
        (720, 342, 1036, 760),
        radius=18,
        fill=(244, 242, 230),
        outline=PALETTE["orange"],
        width=3,
    )
    paste_fit(
        canvas,
        crop_box(primary_overlay, primary_bbox, pad=90),
        (736, 358, 1020, 744),
        Image.Resampling.LANCZOS,
    )
    draw.text(
        (736, 724),
        "zoom: answer region",
        fill=PALETTE["orange"],
        font=ui_font(15, True),
    )

    draw.rounded_rectangle(
        (1132, 230, 2136, 794),
        radius=28,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (1164, 260),
        "distractor prompt spotlight",
        fill=PALETTE["cyan"],
        font=ui_font(31, True),
    )
    draw.text(
        (1164, 298),
        f"{distractor['q']} → {distractor['answer_text']}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    distractor_crop = crop_box(distractor_overlay, distractor_bbox, pad=300)
    paste_fit(canvas, distractor_crop, (1164, 342, 1762, 760), Image.Resampling.LANCZOS)
    draw.rounded_rectangle(
        (1788, 342, 2104, 760),
        radius=18,
        fill=(244, 242, 230),
        outline=PALETTE["cyan"],
        width=3,
    )
    paste_fit(
        canvas,
        crop_box(distractor_overlay, distractor_bbox, pad=90),
        (1804, 358, 2088, 744),
        Image.Resampling.LANCZOS,
    )
    draw.text(
        (1804, 724), "zoom: answer region", fill=PALETTE["cyan"], font=ui_font(15, True)
    )

    draw_score_card(
        draw,
        (64, 836, 610, 1236),
        "primary answer-region score",
        primary_score,
        primary_random,
        PALETTE["orange"],
    )
    draw_score_card(
        draw,
        (642, 836, 1188, 1236),
        "distractor answer-region score",
        distractor_score,
        distractor_random,
        PALETTE["cyan"],
    )
    draw_generation_rows(draw, (1220, 836, 2136, 1236), summary["generations"])

    # Save metrics alongside figure for the caption.
    metrics = {
        "primary_score": primary_score,
        "primary_percentile": float((primary_random < primary_score).mean() * 100),
        "distractor_score": distractor_score,
        "distractor_percentile": float(
            (distractor_random < distractor_score).mean() * 100
        ),
        "primary_peak_layer": primary_layer,
        "distractor_peak_layer": distractor_layer,
        "generations": summary["generations"],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    (out.parent / "spotlight-metrics.json").write_text(json.dumps(metrics, indent=1))
    print(out)
    print(json.dumps(metrics, indent=1))


if __name__ == "__main__":
    main()
