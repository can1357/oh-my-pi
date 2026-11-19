# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render the carrier-convergence geometry figure: same content, same nothings."""

from __future__ import annotations

import argparse
import json
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
    "cyan": (75, 220, 255),
    "orange": (255, 112, 72),
    "green": (148, 255, 117),
    "amber": (255, 196, 68),
    "red": (255, 76, 62),
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


def mono_font(size: int) -> ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def diverging_color(t: float) -> tuple[int, int, int]:
    """-1..1 → blue-black-orange diverging scale."""
    t = max(-1.0, min(1.0, t))
    if t < 0:
        u = -t
        return (round(8 + 12 * u), round(20 + 90 * u), round(34 + 190 * u))
    u = t
    return (round(8 + 247 * u), round(20 + 130 * u), round(34 + 20 * u))


def draw_matrix(
    draw: ImageDraw.ImageDraw,
    mat: np.ndarray,
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str,
    color: tuple[int, int, int],
    highlight_diag: bool = False,
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=20, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
    )
    draw.text((x0 + 20, y0 + 16), title, fill=color, font=ui_font(24, True))
    draw.text((x0 + 20, y0 + 48), subtitle, fill=PALETTE["muted"], font=ui_font(15))
    n = mat.shape[0]
    gx0, gy0 = x0 + 34, y0 + 84
    side = min(x1 - 34 - gx0, y1 - 30 - gy0)
    cell = side / n
    for r in range(n):
        for c in range(n):
            xa = round(gx0 + c * cell)
            xb = round(gx0 + (c + 1) * cell) - 2
            ya = round(gy0 + r * cell)
            yb = round(gy0 + (r + 1) * cell) - 2
            draw.rounded_rectangle(
                (xa, ya, xb, yb), radius=4, fill=diverging_color(float(mat[r, c]))
            )
    if highlight_diag:
        for r in range(n):
            xa = round(gx0 + r * cell)
            ya = round(gy0 + r * cell)
            draw.rounded_rectangle(
                (xa - 1, ya - 1, round(xa + cell) - 1, round(ya + cell) - 1),
                radius=5,
                outline=PALETTE["amber"],
                width=2,
            )
    draw.text(
        (gx0, round(gy0 + side) + 6),
        "questions →",
        fill=PALETTE["muted"],
        font=ui_font(13),
    )


def draw_curves(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    layers: list[dict[str, Any]],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=20, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
    )
    draw.text(
        (x0 + 22, y0 + 16),
        "convergence by depth",
        fill=PALETTE["ink"],
        font=ui_font(24, True),
    )
    draw.text(
        (x0 + 22, y0 + 48),
        "carrier-centered cosine: same question across carriers vs different questions",
        fill=PALETTE["muted"],
        font=ui_font(15),
    )
    gx0, gy0, gx1, gy1 = x0 + 52, y0 + 92, x1 - 26, y1 - 56
    lo, hi = -0.15, 1.0
    for i in range(5):
        y = gy0 + (gy1 - gy0) * i / 4
        draw.line((gx0, y, gx1, y), fill=PALETTE["grid"], width=1)
        value = hi - (hi - lo) * i / 4
        draw.text(
            (x0 + 12, y - 8), f"{value:.1f}", fill=PALETTE["muted"], font=ui_font(12)
        )
    series = [
        ("matched_cosine", PALETTE["amber"], 6),
        ("mismatched_cosine", PALETTE["muted"], 4),
        ("rsa_pearson", PALETTE["cyan"], 4),
    ]
    n = len(layers)
    for key, color, width in series:
        pts = []
        for i, row in enumerate(layers):
            value = float(row[key])
            if value != value:  # NaN guard (layer-0 RSA is undefined)
                continue
            value = max(lo, min(hi, value))
            x = gx0 + (gx1 - gx0) * i / max(1, n - 1)
            y = gy1 - (gy1 - gy0) * (value - lo) / (hi - lo)
            pts.append((round(x), round(y)))
        if len(pts) < 2:
            continue
        draw.line(pts, fill=color, width=width, joint="curve")
    draw.text((gx0, gy1 + 14), "layer 0", fill=PALETTE["muted"], font=ui_font(13))
    draw.text(
        (gx1 - 64, gy1 + 14), f"layer {n - 1}", fill=PALETTE["muted"], font=ui_font(13)
    )
    legend = [
        ("same question, text↔image", PALETTE["amber"]),
        ("different questions", PALETTE["muted"]),
        ("RSA geometry corr", PALETTE["cyan"]),
    ]
    lx = gx0
    for label, color in legend:
        draw.rounded_rectangle((lx, y0 + 70, lx + 18, y0 + 78), radius=4, fill=color)
        draw.text((lx + 24, y0 + 62), label, fill=PALETTE["muted"], font=ui_font(13))
        lx += 232


def draw_answers(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    records: list[dict[str, Any]],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=20, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
    )
    draw.text(
        (x0 + 22, y0 + 16),
        "behavioral check: both carriers answer alike",
        fill=PALETTE["ink"],
        font=ui_font(24, True),
    )
    draw.text(
        (x0 + 240, y0 + 56),
        "text carrier",
        fill=PALETTE["cyan"],
        font=ui_font(15, True),
    )
    draw.text(
        (x0 + 470, y0 + 56),
        "image carrier",
        fill=PALETTE["orange"],
        font=ui_font(15, True),
    )
    y = y0 + 84
    row_h = (y1 - y0 - 96) // len(records)
    fnt = mono_font(15)
    for r in records:
        gold = r["gold"][:22]
        draw.text((x0 + 22, y), gold, fill=PALETTE["muted"], font=fnt)
        draw.text((x0 + 240, y), r["text_answer"][:22], fill=PALETTE["ink"], font=fnt)
        draw.text((x0 + 470, y), r["image_answer"][:22], fill=PALETTE["ink"], font=fnt)
        mark = "=" if r["agree"] else "≠"
        draw.text(
            (x1 - 44, y),
            mark,
            fill=PALETTE["green"] if r["agree"] else PALETTE["red"],
            font=ui_font(17, True),
        )
        y += row_h


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-carrier-convergence-n12")
    )
    ap.add_argument(
        "--out",
        default=str(
            HERE
            / "results"
            / "qwen-carrier-convergence-n12"
            / "carrier-convergence.png"
        ),
    )
    args = ap.parse_args()

    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "carrier_convergence.npz")
    layers = summary["per_layer"]
    best_layer = summary["best_layer"]
    text_sim = data["text_sim"][best_layer]
    image_sim = data["image_sim"][best_layer]
    cross_sim = data["cross_sim"][best_layer]
    records = summary["records"]

    w, h = 2200, 1320
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 900, 700), fill=(75, 220, 255, 26))
    gd.ellipse((1300, 180, 2480, 1380), fill=(255, 112, 72, 24))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    best = summary["best"]
    draw.text(
        (64, 42),
        "QWEN CARRIER CONVERGENCE",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "Two carriers, one thought",
        fill=PALETTE["ink"],
        font=ui_font(66, True),
    )
    draw.text(
        (66, 166),
        "Hidden state at the answer position, carrier means removed. Same question through text or bitmap lands in the same place; different questions do not.",
        fill=PALETTE["muted"],
        font=ui_font(23),
    )

    stats = [
        ("matched pairs", f"{best['matched_cosine']:.2f}", "same Q, text ↔ image"),
        ("mismatched pairs", f"{best['mismatched_cosine']:.2f}", "different questions"),
        ("RSA geometry corr", f"{best['rsa_pearson']:.2f}", f"layer {best['layer']}"),
        (
            "pair retrieval",
            f"{best['match_rank_accuracy'] * 100:.0f}%",
            "nearest cross-carrier match",
        ),
        (
            "answer agreement",
            f"{summary['answer_agreement'] * 100:.0f}%",
            "text vs image generations",
        ),
    ]
    sx = 64
    for title, value, caption in stats:
        draw.rounded_rectangle(
            (sx, 222, sx + 396, 332),
            radius=20,
            fill=PALETTE["panel"],
            outline=(35, 49, 59),
            width=1,
        )
        draw.text((sx + 22, 240), title, fill=PALETTE["muted"], font=ui_font(16))
        draw.text((sx + 22, 264), value, fill=PALETTE["ink"], font=ui_font(40, True))
        draw.text((sx + 226, 290), caption, fill=PALETTE["muted"], font=ui_font(13))
        sx += 420

    n = text_sim.shape[0]
    draw_matrix(
        draw,
        text_sim,
        (64, 376, 600, 952),
        "text-carrier geometry",
        f"{n}×{n} question similarity, layer {best_layer}",
        PALETTE["cyan"],
    )
    draw_matrix(
        draw,
        image_sim,
        (628, 376, 1164, 952),
        "image-carrier geometry",
        "same questions through the bitmap — same shape",
        PALETTE["orange"],
    )
    draw_matrix(
        draw,
        cross_sim,
        (1192, 376, 1728, 952),
        "cross-carrier matching",
        "text question i × image question j — bright diagonal",
        PALETTE["green"],
        highlight_diag=True,
    )

    draw_curves(draw, (64, 996, 1164, 1264), layers)
    draw_answers(draw, (1192, 996, 2136, 1264), records)

    # Color scale.
    for i in range(240):
        t = 1 - i / 239 * 2
        draw.rectangle((1816, 420 + i * 2, 1836, 422 + i * 2), fill=diverging_color(t))
    draw.text((1848, 412), "+1 similar", fill=PALETTE["muted"], font=ui_font(14))
    draw.text((1848, 884), "−1 opposite", fill=PALETTE["muted"], font=ui_font(14))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
