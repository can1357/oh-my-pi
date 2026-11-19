# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render how the same word enters Qwen as BPE tokens vs 28px visual patches."""

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


def vector_text(head: list[float]) -> str:
    return "[" + ", ".join(f"{v:+.2f}" for v in head[:6]) + ", …]"


def draw_vector_bar(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    head: list[float],
    color: tuple[int, int, int],
    width: int = 330,
) -> None:
    x, y = xy
    n = len(head)
    bw = width // n
    hi = max(0.001, max(abs(v) for v in head))
    mid = y + 22
    for i, v in enumerate(head):
        bh = round(20 * abs(v) / hi)
        xa = x + i * bw
        if v >= 0:
            draw.rounded_rectangle(
                (xa, mid - bh, xa + bw - 4, mid), radius=3, fill=color
            )
        else:
            draw.rounded_rectangle(
                (xa, mid, xa + bw - 4, mid + bh),
                radius=3,
                fill=tuple(c // 2 for c in color),
            )
    draw.line((x, mid, x + width, mid), fill=PALETTE["grid"], width=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-token-entry-q3")
    )
    ap.add_argument(
        "--out",
        default=str(HERE / "results" / "qwen-token-entry-q3" / "token-entry.png"),
    )
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    dump = json.loads((result_dir / "token_entry.json").read_text())
    carrier = Image.open(result_dir / "images" / "image-carrier.png").convert("RGB")

    w, h = 2200, 1400
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 940, 760), fill=(75, 220, 255, 27))
    gd.ellipse((1240, 540, 2460, 1480), fill=(255, 112, 72, 25))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    q = dump["question"]
    answer = q["answer_text"]
    draw.text(
        (64, 42),
        "QWEN TOKEN ENTRY — SAME WORD, TWO ENCODINGS",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        f"How “{answer}” gets into the model",
        fill=PALETTE["ink"],
        font=ui_font(64, True),
    )
    draw.text(
        (66, 164),
        "Real values, no schematic: actual BPE ids and embedding rows on the text path; actual 28×28 pixel patches and visual-tower output vectors on the image path.",
        fill=PALETTE["muted"],
        font=ui_font(23),
    )

    # ---- TEXT LANE ----
    lane = (64, 238, 2136, 700)
    draw.rounded_rectangle(
        lane, radius=28, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (96, 262),
        "text carrier — BPE tokens",
        fill=PALETTE["cyan"],
        font=ui_font(30, True),
    )
    draw.text(
        (96, 302),
        f"snippet around the answer · {dump['chunk_chars']:,} chars → {dump['chunk_text_tokens']:,} text tokens for the whole chunk",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    # Token ribbon: show tokens around the answer.
    tokens = dump["tokens"]
    answer_positions = [t["i"] for t in tokens if t["answer"]]
    mid_token = answer_positions[0] if answer_positions else len(tokens) // 2
    window = [t for t in tokens if mid_token - 7 <= t["i"] <= mid_token + 7]
    fnt = mono_font(19)
    fnt_id = mono_font(12)
    x = 96
    y = 356
    for t in window:
        label = t["str"].replace("\n", "⏎")
        if not label.strip():
            label = "␣" * max(1, len(label))
        tw = max(int(draw.textlength(label, font=fnt)) + 22, 54)
        if x + tw > 2100:
            x = 96
            y += 96
        color = PALETTE["amber"] if t["answer"] else (30, 41, 50)
        text_color = (8, 10, 12) if t["answer"] else PALETTE["ink"]
        draw.rounded_rectangle(
            (x, y, x + tw, y + 44), radius=9, fill=color, outline=(52, 68, 80), width=1
        )
        draw.text((x + 11, y + 9), label, fill=text_color, font=fnt)
        draw.text((x + 4, y + 50), f"id {t['id']}", fill=PALETTE["muted"], font=fnt_id)
        x += tw + 8

    draw.text(
        (96, 500),
        "what actually enters the decoder (embedding row, first 6 of "
        f"{dump['embed_dim']} dims):",
        fill=PALETTE["muted"],
        font=ui_font(18, True),
    )
    ex = 96
    for entry in dump["text_entry"][:3]:
        box = (ex, 536, ex + 470, 668)
        draw.rounded_rectangle(
            box, radius=16, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
        )
        draw.text(
            (ex + 18, 548),
            f"“{entry['str']}”  id {entry['id']}",
            fill=PALETTE["cyan"],
            font=ui_font(20, True),
        )
        draw.text(
            (ex + 18, 578),
            vector_text(entry["vector_head"]),
            fill=PALETTE["ink"],
            font=mono_font(15),
        )
        draw_vector_bar(
            draw, (ex + 18, 606), entry["vector_head"], PALETTE["cyan"], width=430
        )
        draw.text(
            (ex + 360, 548),
            f"‖x‖={entry['norm']:.2f}",
            fill=PALETTE["muted"],
            font=ui_font(14),
        )
        ex += 494

    # ---- IMAGE LANE ----
    lane = (64, 736, 2136, 1336)
    draw.rounded_rectangle(
        lane, radius=28, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (96, 760),
        "image carrier — visual patch tokens",
        fill=PALETTE["orange"],
        font=ui_font(30, True),
    )
    px = dump["token_pixel_size"]
    draw.text(
        (96, 800),
        f"same word as pixels · bitmap resized to {dump['processor_resized'][0]}×{dump['processor_resized'][1]} → {dump['patch_size']}px patches, {dump['merge_size']}×{dump['merge_size']} merged → {dump['image_tokens']:,} tokens of {px}×{px}px",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    # Zoomed answer region with the real patch grid.
    grid = dump["image_grid"]
    rw, rh = dump["processor_resized"]
    resized = carrier.resize((rw, rh), Image.Resampling.LANCZOS)
    indices = dump["image_answer_token_indices"]
    rows = sorted({i // grid for i in indices})
    cols_ = sorted({i % grid for i in indices})
    pad = 3
    cx0 = max(0, (min(cols_) - pad) * px)
    cx1 = min(rw, (max(cols_) + 1 + pad) * px)
    cy0 = max(0, (min(rows) - pad) * px)
    cy1 = min(rh, (max(rows) + 1 + pad) * px)
    crop = resized.crop((cx0, cy0, cx1, cy1))
    scale = min(940 / crop.width, 225 / crop.height)
    crop_big = crop.resize(
        (round(crop.width * scale), round(crop.height * scale)),
        Image.Resampling.NEAREST,
    )
    ox, oy = 96, 852
    draw.rounded_rectangle(
        (ox - 6, oy - 6, ox + crop_big.width + 6, oy + crop_big.height + 6),
        radius=10,
        fill=(244, 242, 230),
    )
    canvas.paste(crop_big, (ox, oy))
    cd = ImageDraw.Draw(canvas)
    for gx in range(cx0 // px, cx1 // px + 1):
        lx = ox + (gx * px - cx0) * scale
        cd.line((lx, oy, lx, oy + crop_big.height), fill=(150, 158, 162, 80), width=1)
    for gy in range(cy0 // px, cy1 // px + 1):
        ly = oy + (gy * px - cy0) * scale
        cd.line((ox, ly, ox + crop_big.width, ly), fill=(150, 158, 162, 80), width=1)
    for idx in indices:
        r, c = idx // grid, idx % grid
        xa = ox + (c * px - cx0) * scale
        ya = oy + (r * px - cy0) * scale
        cd.rectangle(
            (xa, ya, xa + px * scale, ya + px * scale),
            outline=PALETTE["orange"],
            width=4,
        )
    draw.text(
        (ox, oy + crop_big.height + 14),
        f"orange cells = the {len(indices)} visual tokens covering “{answer}” (token grid {grid}×{grid})",
        fill=PALETTE["muted"],
        font=ui_font(17),
    )

    # Magnified single patches.
    sx = ox + crop_big.width + 60
    draw.text(
        (sx, 852 - 26),
        "individual visual tokens (real input pixels):",
        fill=PALETTE["muted"],
        font=ui_font(18, True),
    )
    for k, idx in enumerate(indices[:5]):
        r, c = idx // grid, idx % grid
        cell = resized.crop((c * px, r * px, (c + 1) * px, (r + 1) * px)).resize(
            (132, 132), Image.Resampling.NEAREST
        )
        bx = sx + k * 160
        draw.rounded_rectangle(
            (bx - 4, 852 - 4, bx + 136, 852 + 136),
            radius=8,
            fill=(244, 242, 230),
            outline=PALETTE["orange"],
            width=3,
        )
        canvas.paste(cell, (bx, 852))
        draw.text((bx, 996), f"tok[{idx}]", fill=PALETTE["muted"], font=mono_font(13))
    draw.text(
        (sx, 1030),
        f"pre-tower normalized pixels of first patch: {vector_text(dump['pixel_head_first_answer_patch'])}",
        fill=PALETTE["muted"],
        font=mono_font(14),
    )

    draw.text(
        (96, 1106),
        f"what actually enters the decoder (visual-tower output, first 6 of {dump['visual_out_dim']} dims):",
        fill=PALETTE["muted"],
        font=ui_font(18, True),
    )
    ex = 96
    for entry in dump["image_entry"][:4]:
        box = (ex, 1142, ex + 470, 1274)
        draw.rounded_rectangle(
            box, radius=16, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
        )
        r, c = entry["grid_rc"]
        draw.text(
            (ex + 18, 1154),
            f"visual tok[{entry['token_index']}]  (row {r}, col {c})",
            fill=PALETTE["orange"],
            font=ui_font(20, True),
        )
        draw.text(
            (ex + 18, 1184),
            vector_text(entry["vector_head"]),
            fill=PALETTE["ink"],
            font=mono_font(15),
        )
        draw_vector_bar(
            draw, (ex + 18, 1212), entry["vector_head"], PALETTE["orange"], width=430
        )
        draw.text(
            (ex + 360, 1154),
            f"‖x‖={entry['norm']:.2f}",
            fill=PALETTE["muted"],
            font=ui_font(14),
        )
        ex += 494

    # Comparison strip.
    text_tok_for_word = len(dump["text_entry"])
    draw.rounded_rectangle(
        (1100, 536, 2104, 668),
        radius=16,
        fill=PALETTE["panel2"],
        outline=(34, 48, 58),
        width=1,
    )
    draw.text(
        (1128, 556),
        f"“{answer}” = {text_tok_for_word} text token(s) · {len(indices)} visual tokens",
        fill=PALETTE["ink"],
        font=ui_font(22, True),
    )
    draw.text(
        (1128, 592),
        f"both end up as {dump['embed_dim']}-dim rows in the same decoder",
        fill=PALETTE["ink"],
        font=ui_font(19),
    )
    draw.text(
        (1128, 626),
        "text path: lookup table row.  image path: ViT forward over 4 raw patches → merger MLP.",
        fill=PALETTE["muted"],
        font=ui_font(16),
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
