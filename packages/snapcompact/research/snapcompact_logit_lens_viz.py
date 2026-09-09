# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render the logit-lens grid: pixel patches morphing into BPE tokens by layer."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

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


def heat_fill(p: float, hit: bool) -> tuple[int, int, int]:
    """Cell background: brightness by confidence, hue by answer-match."""
    t = min(1.0, max(0.0, math.log10(max(p, 1e-6)) / 3 + 1))  # p=1 -> 1, p=1e-3 -> 0
    if hit:
        return (round(30 + 130 * t), round(48 + 130 * t), round(18 + 40 * t))
    return (round(14 + 26 * t), round(19 + 30 * t), round(26 + 36 * t))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-logit-lens-q3")
    )
    ap.add_argument(
        "--out",
        default=str(HERE / "results" / "qwen-logit-lens-q3" / "logit-lens-grid.png"),
    )
    ap.add_argument("--layer-step", type=int, default=1)
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    dump = json.loads((result_dir / "logit_lens.json").read_text())
    carrier = Image.open(result_dir / "images" / "image-carrier.png").convert("RGB")

    q = dump["question"]
    answer = q["answer_text"]
    answer_ids = set(dump["answer_token_ids"])
    grid = dump["image_grid"]
    px = dump["token_pixel_size"]
    rw = grid * px
    resized = carrier.resize((rw, rw), Image.Resampling.LANCZOS)

    track_indices = dump["answer_indices"] + dump["control_indices"]
    by_token: dict[int, list[dict[str, Any]]] = {}
    for e in dump["lens"]:
        by_token.setdefault(e["token_index"], []).append(e)
    for entries in by_token.values():
        entries.sort(key=lambda e: e["layer"])
    n_layers = dump["layers"]
    layer_rows = list(range(0, n_layers, args.layer_step))

    cell_w, cell_h = 150, 34
    header_h = 210
    left_w = 120
    n_cols = len(track_indices)
    grid_w = left_w + n_cols * cell_w
    margin = 64
    title_h = 200
    w = max(1900, grid_w + margin * 2)
    h = title_h + header_h + len(layer_rows) * cell_h + 160
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 900, 700), fill=(75, 220, 255, 26))
    gd.ellipse((w - 1000, h - 800, w + 240, h + 200), fill=(255, 112, 72, 24))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (margin, 42),
        "QWEN LOGIT LENS — PIXELS BECOMING WORDS",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (margin, 84),
        "Watch each patch decode into vocabulary",
        fill=PALETTE["ink"],
        font=ui_font(58, True),
    )
    draw.text(
        (margin + 2, 156),
        f"Each column is one 28×28px visual token; each row is a decoder layer projected through the LM head. Green cells decode to a BPE piece of “{answer}”.",
        fill=PALETTE["muted"],
        font=ui_font(22),
    )

    gx0 = margin + left_w
    gy0 = title_h + header_h
    # Column headers: actual patch pixels.
    patch_size = 108
    for ci, idx in enumerate(track_indices):
        r, c = idx // grid, idx % grid
        cell = resized.crop((c * px, r * px, (c + 1) * px, (r + 1) * px)).resize(
            (patch_size, patch_size), Image.Resampling.NEAREST
        )
        cx = gx0 + ci * cell_w + (cell_w - patch_size) // 2
        is_control = idx in dump["control_indices"]
        color = PALETTE["muted"] if is_control else PALETTE["orange"]
        draw.rounded_rectangle(
            (cx - 4, title_h + 26, cx + patch_size + 4, title_h + 34 + patch_size),
            radius=8,
            fill=(244, 242, 230),
            outline=color,
            width=3,
        )
        canvas.paste(cell, (cx, title_h + 30))
        label = "control" if is_control else f"tok[{idx}]"
        tw = draw.textlength(label, font=mono_font(13))
        draw.text(
            (cx + (patch_size - tw) / 2, title_h + 42 + patch_size),
            label,
            fill=color,
            font=mono_font(13),
        )
    draw.text(
        (margin, title_h + 30 + patch_size // 2 - 10),
        "input\npixels",
        fill=PALETTE["muted"],
        font=ui_font(15, True),
    )

    # Grid rows.
    fnt = mono_font(14)
    for ri, layer in enumerate(layer_rows):
        y = gy0 + ri * cell_h
        draw.text(
            (margin + 24, y + 8),
            f"L{layer:02d}",
            fill=PALETTE["muted"],
            font=mono_font(13),
        )
        for ci, idx in enumerate(track_indices):
            e = by_token[idx][layer]
            top = e["top"][0]
            hit = top["id"] in answer_ids
            p_ans = max(e["answer_token_p"])
            x = gx0 + ci * cell_w
            fill = heat_fill(top["p"] if not hit else max(top["p"], p_ans), hit)
            draw.rounded_rectangle(
                (x + 2, y + 2, x + cell_w - 6, y + cell_h - 4),
                radius=6,
                fill=fill,
                outline=(32, 44, 53),
                width=1,
            )
            label = top["str"].replace("\n", "⏎").strip() or "·"
            if len(label) > 12:
                label = label[:11] + "…"
            color = (
                (220, 255, 190)
                if hit
                else PALETTE["ink"]
                if top["p"] > 0.05
                else PALETTE["muted"]
            )
            draw.text((x + 10, y + 8), label, fill=color, font=fnt)
            if hit:
                draw.text(
                    (x + cell_w - 52, y + 9),
                    f"{p_ans:.2f}",
                    fill=PALETTE["green"],
                    font=mono_font(11),
                )

    # Footer.
    fy = gy0 + len(layer_rows) * cell_h + 22
    draw.rounded_rectangle(
        (margin, fy, w - margin, fy + 88),
        radius=18,
        fill=PALETTE["panel2"],
        outline=(34, 48, 58),
        width=1,
    )
    draw.text(
        (margin + 28, fy + 16),
        f"question: {q['q'][:88]}",
        fill=PALETTE["ink"],
        font=ui_font(19),
    )
    draw.text(
        (margin + 28, fy + 50),
        f"gold answer “{answer}” = BPE {dump['answer_token_strs']} · logit lens = hidden state → final norm → LM head · {dump['image_tokens']:,} visual tokens total, showing the {len(dump['answer_indices'])} covering the answer + {len(dump['control_indices'])} blank-region controls",
        fill=PALETTE["muted"],
        font=ui_font(16),
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
