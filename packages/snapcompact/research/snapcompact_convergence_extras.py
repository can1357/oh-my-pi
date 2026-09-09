# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Extra convergence graphics: PCA funnel snapshots and an animated diagonal GIF."""

from __future__ import annotations

import argparse
import json
import math
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
    "amber": (255, 196, 68),
    "cyan": (75, 220, 255),
    "orange": (255, 112, 72),
    "grid": (38, 49, 58),
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


def question_hue(i: int, n: int) -> tuple[int, int, int]:
    """Distinct, bright hue per question."""
    h = i / n
    r = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.00))
    g = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.33))
    b = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.67))
    return (round(70 + 185 * r), round(70 + 185 * g), round(70 + 185 * b))


def center(arr: np.ndarray) -> np.ndarray:
    return arr - arr.mean(axis=0, keepdims=True)


def diverging_color(t: float) -> tuple[int, int, int]:
    t = max(-1.0, min(1.0, t))
    if t < 0:
        u = -t
        return (round(8 + 12 * u), round(20 + 90 * u), round(34 + 190 * u))
    return (round(8 + 247 * t), round(20 + 130 * t), round(34 + 20 * t))


def background(w: int, h: int) -> Image.Image:
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 880, 680), fill=(75, 220, 255, 25))
    gd.ellipse((w - 1000, h - 760, w + 240, h + 220), fill=(255, 112, 72, 25))
    return Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(84))
    ).convert("RGB")


def render_funnel(
    out_path: Path,
    text_arr: np.ndarray,
    image_arr: np.ndarray,
    layers_meta: list[dict[str, Any]],
    best_layer: int,
    records: list[dict[str, Any]],
) -> None:
    n_q, n_layers, _ = text_arr.shape
    snapshots = [1, max(2, best_layer // 2), best_layer]
    # Shared PCA frame from the peak layer keeps the panels comparable.
    ref = np.concatenate(
        [center(text_arr[:, best_layer, :]), center(image_arr[:, best_layer, :])],
        axis=0,
    )
    _, _, vt = np.linalg.svd(ref, full_matrices=False)
    basis = vt[:2].T  # [D, 2]

    w, h = 2200, 1240
    canvas = background(w, h)
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (64, 42),
        "QWEN CARRIER CONVERGENCE — TRAJECTORY VIEW",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "Watch the two carriers fuse",
        fill=PALETTE["ink"],
        font=ui_font(64, True),
    )
    draw.text(
        (66, 164),
        "Each color is one question; ● came in as text, ◆ came in as pixels. Same 2D projection at every depth. The tie-lines shrink as carriers converge.",
        fill=PALETTE["muted"],
        font=ui_font(23),
    )

    panel_w = 660
    titles = ["early (layer {})", "middle (layer {})", "peak (layer {})"]
    for pi, (layer, title) in enumerate(zip(snapshots, titles)):
        x0 = 64 + pi * (panel_w + 44)
        box = (x0, 232, x0 + panel_w, 952)
        draw.rounded_rectangle(
            box, radius=24, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
        )
        draw.text(
            (x0 + 26, 252),
            title.format(layer),
            fill=PALETTE["ink"],
            font=ui_font(27, True),
        )
        t_proj = center(text_arr[:, layer, :]) @ basis
        i_proj = center(image_arr[:, layer, :]) @ basis
        both = np.concatenate([t_proj, i_proj], axis=0)
        lim = float(np.abs(both).max()) * 1.15 or 1.0
        gx0, gy0, gx1, gy1 = x0 + 36, 306, x0 + panel_w - 36, 912

        def to_px(p: np.ndarray) -> tuple[int, int]:
            return (
                round(gx0 + (p[0] + lim) / (2 * lim) * (gx1 - gx0)),
                round(gy0 + (1 - (p[1] + lim) / (2 * lim)) * (gy1 - gy0)),
            )

        draw.line(
            (gx0, (gy0 + gy1) // 2, gx1, (gy0 + gy1) // 2),
            fill=PALETTE["grid"],
            width=1,
        )
        draw.line(
            ((gx0 + gx1) // 2, gy0, (gx0 + gx1) // 2, gy1),
            fill=PALETTE["grid"],
            width=1,
        )
        pair_dist = 0.0
        for qi in range(n_q):
            color = question_hue(qi, n_q)
            tp = to_px(t_proj[qi])
            ip = to_px(i_proj[qi])
            draw.line((tp, ip), fill=(*color, 0)[:3], width=3)
            r = 11
            draw.ellipse(
                (tp[0] - r, tp[1] - r, tp[0] + r, tp[1] + r),
                fill=color,
                outline=(8, 10, 12),
                width=2,
            )
            d = ImageDraw.Draw(canvas)
            d.polygon(
                [
                    (ip[0], ip[1] - r - 2),
                    (ip[0] + r + 2, ip[1]),
                    (ip[0], ip[1] + r + 2),
                    (ip[0] - r - 2, ip[1]),
                ],
                fill=color,
                outline=(8, 10, 12),
            )
            pair_dist += float(np.linalg.norm(t_proj[qi] - i_proj[qi]))
        pair_dist /= n_q
        norm_dist = pair_dist / (2 * lim)
        meta = layers_meta[layer]
        draw.text(
            (x0 + 26, 916),
            f"mean pair gap: {norm_dist * 100:.0f}% of frame  ·  matched cos {meta['matched_cosine']:.2f}",
            fill=PALETTE["muted"],
            font=ui_font(17),
        )

    # Pair-distance by layer strip.
    strip = (64, 996, 2136, 1190)
    draw.rounded_rectangle(
        strip, radius=24, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (96, 1014),
        "matched-pair separation by layer (lower = carriers agree)",
        fill=PALETTE["ink"],
        font=ui_font(22, True),
    )
    gx0, gy0, gx1, gy1 = 110, 1062, 2100, 1162
    gaps = []
    for layer in range(n_layers):
        t_proj = center(text_arr[:, layer, :])
        i_proj = center(image_arr[:, layer, :])
        t_n = t_proj / np.maximum(np.linalg.norm(t_proj, axis=1, keepdims=True), 1e-6)
        i_n = i_proj / np.maximum(np.linalg.norm(i_proj, axis=1, keepdims=True), 1e-6)
        gaps.append(1.0 - float((t_n * i_n).sum(axis=1).mean()))
    hi = max(gaps)
    bw = (gx1 - gx0) / n_layers
    for layer, gap in enumerate(gaps):
        xa = gx0 + layer * bw + 3
        xb = gx0 + (layer + 1) * bw - 3
        bh = (gy1 - gy0) * gap / hi
        color = PALETTE["orange"] if layer == best_layer else (62, 86, 102)
        draw.rounded_rectangle(
            (round(xa), round(gy1 - bh), round(xb), gy1), radius=5, fill=color
        )
    draw.text((gx0, gy1 + 6), "layer 0", fill=PALETTE["muted"], font=ui_font(13))
    draw.text(
        (gx1 - 70, gy1 + 6),
        f"layer {n_layers - 1}",
        fill=PALETTE["muted"],
        font=ui_font(13),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def render_gif(
    out_path: Path, cross_sim: np.ndarray, layers_meta: list[dict[str, Any]]
) -> None:
    n_layers, n_q, _ = cross_sim.shape
    cell = 46
    pad = 36
    header = 132
    w = n_q * cell + pad * 2
    h = n_q * cell + header + pad + 64
    frames: list[Image.Image] = []
    for layer in range(n_layers):
        frame = Image.new("RGB", (w, h), PALETTE["bg"])
        draw = ImageDraw.Draw(frame)
        for y in range(0, h, 14):
            draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
        draw.text(
            (pad, 22),
            "cross-carrier matching",
            fill=PALETTE["ink"],
            font=ui_font(30, True),
        )
        draw.text(
            (pad, 62),
            "text question i × image question j",
            fill=PALETTE["muted"],
            font=ui_font(17),
        )
        meta = layers_meta[layer]
        draw.text(
            (pad, 92),
            f"layer {layer:02d}   matched {meta['matched_cosine']:+.2f}   others {meta['mismatched_cosine']:+.2f}",
            fill=PALETTE["amber"],
            font=ui_font(19, True),
        )
        for r in range(n_q):
            for c in range(n_q):
                xa = pad + c * cell
                ya = header + r * cell
                draw.rounded_rectangle(
                    (xa, ya, xa + cell - 4, ya + cell - 4),
                    radius=7,
                    fill=diverging_color(float(cross_sim[layer, r, c])),
                )
        # progress bar
        bar_y = header + n_q * cell + 18
        draw.rounded_rectangle(
            (pad, bar_y, w - pad, bar_y + 10), radius=5, fill=(30, 40, 48)
        )
        draw.rounded_rectangle(
            (pad, bar_y, pad + (w - 2 * pad) * (layer + 1) // n_layers, bar_y + 10),
            radius=5,
            fill=PALETTE["cyan"],
        )
        frames.append(frame)
    durations = [240] * n_layers
    durations[-1] = 2200
    out_path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        out_path, save_all=True, append_images=frames[1:], duration=durations, loop=0
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-carrier-convergence-n12")
    )
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "carrier_convergence.npz")
    text_arr = data["text_states"]
    image_arr = data["image_states"]
    cross_sim = data["cross_sim"]
    layers_meta = summary["per_layer"]
    best_layer = summary["best_layer"]

    funnel_path = result_dir / "convergence-funnel.png"
    gif_path = result_dir / "diagonal-emerges.gif"
    render_funnel(
        funnel_path, text_arr, image_arr, layers_meta, best_layer, summary["records"]
    )
    render_gif(gif_path, cross_sim, layers_meta)
    print(funnel_path)
    print(gif_path)


if __name__ == "__main__":
    main()
