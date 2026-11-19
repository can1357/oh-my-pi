# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render the materialization sweep: rendering choices vs logit-lens confidence."""

from __future__ import annotations

import argparse
import json
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
    "grid": (38, 49, 58),
}
SERIES = [
    ("base-8x13", (143, 154, 160)),
    ("repeat2-color", (255, 196, 68)),
    ("align-7x14", (148, 255, 117)),
    ("align-14x28", (75, 220, 255)),
    ("align-28x28", (255, 112, 72)),
    ("repeat2-align-14x28", (188, 112, 255)),
]


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


def crop_answer_region(
    img_path: Path,
    cond: dict[str, Any],
    answer_start: int,
    answer_end: int,
    image_size: int = 1568,
) -> Image.Image:
    img = Image.open(img_path).convert("RGB")
    cols = cond["cols"]
    adv = cond["adv"]
    pitch = cond["pitch"]
    repeat = cond["repeat"]
    row = answer_start // cols
    c0 = answer_start % cols
    c1 = min(cols - 1, (answer_end - 1) % cols)
    y0 = max(0, row * repeat * pitch - pitch)
    y1 = min(image_size, (row * repeat + repeat) * pitch + pitch)
    x0 = max(0, c0 * adv - 10 * adv)
    x1 = min(image_size, (c1 + 1) * adv + 10 * adv)
    crop = img.crop((x0, y0, x1, y1))
    d = ImageDraw.Draw(crop)
    d.rectangle(
        (
            c0 * adv - x0 - 2,
            row * repeat * pitch - y0 - 1,
            (c1 + 1) * adv - x0 + 2,
            (row * repeat + repeat) * pitch - y0 + 1,
        ),
        outline=(255, 112, 72),
        width=3,
    )
    return crop


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-materialize-sweep-q3")
    )
    ap.add_argument(
        "--out",
        default=str(
            HERE / "results" / "qwen-materialize-sweep-q3" / "materialize-sweep.png"
        ),
    )
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    conditions = {c["name"]: c for c in summary["conditions"]}
    q = summary["question"]

    w, h = 2200, 1380
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -200, 900, 700), fill=(75, 220, 255, 25))
    gd.ellipse((1240, 540, 2460, 1480), fill=(255, 112, 72, 24))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 42),
        "QWEN MATERIALIZATION SWEEP — CAN RENDERING MOVE THE LAYER?",
        fill=(255, 196, 68),
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "The depth is the model's; the clarity is yours",
        fill=PALETTE["ink"],
        font=ui_font(58, True),
    )
    draw.text(
        (66, 158),
        "Six renderings of the same passage. Logit-lens p(answer BPE) at the answer patch, by layer.\n"
        "Alignment and repetition barely move WHERE it materializes — they transform HOW HARD.",
        fill=PALETTE["muted"],
        font=ui_font(22),
    )

    # Main curve panel.
    panel = (64, 226, 1380, 900)
    draw.rounded_rectangle(
        panel, radius=26, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (96, 248),
        "p(answer BPE) at the best answer patch, per layer",
        fill=PALETTE["ink"],
        font=ui_font(26, True),
    )
    gx0, gy0, gx1, gy1 = 150, 320, 1330, 800
    n_layers = len(conditions["base-8x13"]["layers"])
    for i in range(6):
        yy = gy0 + (gy1 - gy0) * i / 5
        draw.line((gx0, yy, gx1, yy), fill=PALETTE["grid"], width=1)
        draw.text(
            (96, yy - 9), f"{1.0 - i / 5:.1f}", fill=PALETTE["muted"], font=ui_font(14)
        )
    for name, color in SERIES:
        cond = conditions.get(name)
        if not cond:
            continue
        pts = []
        for e in cond["layers"]:
            x = gx0 + (gx1 - gx0) * e["layer"] / (n_layers - 1)
            y = gy1 - (gy1 - gy0) * min(1.0, e["best_answer_p"])
            pts.append((round(x), round(y)))
        draw.line(pts, fill=color, width=5 if name != "base-8x13" else 4, joint="curve")
        if cond["lock_on_layer"] is not None:
            lx = gx0 + (gx1 - gx0) * cond["lock_on_layer"] / (n_layers - 1)
            draw.ellipse(
                (
                    lx - 7,
                    gy1
                    - (gy1 - gy0)
                    * min(1.0, cond["layers"][cond["lock_on_layer"]]["best_answer_p"])
                    - 7,
                    lx + 7,
                    gy1
                    - (gy1 - gy0)
                    * min(1.0, cond["layers"][cond["lock_on_layer"]]["best_answer_p"])
                    + 7,
                ),
                outline=color,
                width=3,
            )
    draw.text((gx0, gy1 + 16), "layer 0", fill=PALETTE["muted"], font=ui_font(15))
    draw.text(
        (gx1 - 76, gy1 + 16),
        f"layer {n_layers - 1}",
        fill=PALETTE["muted"],
        font=ui_font(15),
    )
    draw.text(
        (gx0 + 320, gy1 + 16),
        "rings mark lock-on (top-1 becomes an answer BPE)",
        fill=PALETTE["muted"],
        font=ui_font(15),
    )
    legend_box = (1420, 226, 2136, 900)
    draw.rounded_rectangle(
        legend_box, radius=26, fill=PALETTE["panel"], outline=(35, 49, 59), width=1
    )
    draw.text((1452, 248), "conditions", fill=PALETTE["ink"], font=ui_font(26, True))
    ly = 304
    for name, color in SERIES:
        cond = conditions.get(name)
        if not cond:
            continue
        draw.rounded_rectangle((1452, ly, 1452 + 26, ly + 10), radius=4, fill=color)
        draw.text((1492, ly - 9), name, fill=PALETTE["ink"], font=ui_font(21, True))
        draw.text(
            (1492, ly + 19), cond["note"], fill=PALETTE["muted"], font=ui_font(14)
        )
        draw.text(
            (1492, ly + 42),
            f"lock-on L{cond['lock_on_layer']} · peak p {cond['max_answer_p']:.2f} · {cond['chars_per_token']} chars/token",
            fill=color,
            font=mono_font(14),
        )
        ly += 96

    # Condition cards with real crops.
    card_y = 938
    card_w = 660
    draw.text(
        (64, card_y - 24),
        "what the model actually saw (answer region outlined)",
        fill=PALETTE["ink"],
        font=ui_font(22, True),
    )
    positions = [
        (64, card_y + 10),
        (64 + card_w + 24, card_y + 10),
        (64 + 2 * (card_w + 24), card_y + 10),
    ]
    featured = ["base-8x13", "align-28x28", "repeat2-align-14x28"]
    for (cx, cy), name in zip(positions, featured):
        cond = conditions.get(name)
        if not cond:
            continue
        color = dict(SERIES)[name]
        draw.rounded_rectangle(
            (cx, cy, cx + card_w, cy + 350),
            radius=20,
            fill=PALETTE["panel2"],
            outline=(34, 48, 58),
            width=1,
        )
        draw.text((cx + 22, cy + 14), name, fill=color, font=ui_font(23, True))
        draw.text(
            (cx + 22, cy + 46), cond["note"], fill=PALETTE["muted"], font=ui_font(15)
        )
        crop = crop_answer_region(
            result_dir / "images" / f"{name}.png",
            cond,
            q["answer_start"],
            q["answer_end"],
        )
        scale = min((card_w - 44) / crop.width, 200 / crop.height)
        crop_r = crop.resize(
            (round(crop.width * scale), round(crop.height * scale)),
            Image.Resampling.NEAREST,
        )
        draw.rounded_rectangle(
            (cx + 20, cy + 76, cx + card_w - 20, cy + 286),
            radius=12,
            fill=(244, 242, 230),
        )
        canvas.paste(
            crop_r,
            (
                cx + 22 + (card_w - 44 - crop_r.width) // 2,
                cy + 78 + (206 - crop_r.height) // 2,
            ),
        )
        draw.text(
            (cx + 22, cy + 300),
            f"lock-on L{cond['lock_on_layer']} · peak p {cond['max_answer_p']:.2f} · {cond['chars_per_token']} chars/token · gen “{cond['generation']}”",
            fill=PALETTE["ink"],
            font=ui_font(16, True),
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
