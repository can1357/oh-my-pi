# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Render a blog-ready snapcompact white-box visualization from pilot outputs."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent

PALETTE = {
    "bg": (8, 11, 14),
    "panel": (18, 24, 30),
    "panel2": (13, 18, 24),
    "grid": (47, 61, 72),
    "text": (234, 238, 229),
    "muted": (139, 151, 156),
    "accent": (255, 104, 72),
    "accent2": (67, 210, 255),
    "green": (158, 255, 121),
    "amber": (255, 197, 74),
    "red": (255, 70, 70),
}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def rounded(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    fill: tuple[int, int, int],
    outline=None,
    radius=24,
    width=1,
) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def draw_label(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    color: tuple[int, int, int],
    size: int = 24,
    bold: bool = False,
) -> None:
    draw.text(xy, text, fill=color, font=font(size, bold=bold))


def chart(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    series: list[tuple[str, list[float], tuple[int, int, int]]],
    y_min: float,
    y_max: float,
    title: str,
    subtitle: str,
) -> None:
    x0, y0, x1, y1 = box
    rounded(draw, box, PALETTE["panel"], outline=(35, 47, 56), radius=22)
    draw_label(draw, (x0 + 28, y0 + 22), title, PALETTE["text"], 28, True)
    draw_label(draw, (x0 + 28, y0 + 57), subtitle, PALETTE["muted"], 17)
    gx0, gy0, gx1, gy1 = x0 + 58, y0 + 98, x1 - 30, y1 - 58
    for i in range(5):
        y = gy0 + round((gy1 - gy0) * i / 4)
        draw.line((gx0, y, gx1, y), fill=PALETTE["grid"], width=1)
        value = y_max - (y_max - y_min) * i / 4
        draw.text(
            (x0 + 18, y - 9), f"{value:.2f}", fill=PALETTE["muted"], font=font(13)
        )
    n = len(series[0][1])
    for label, values, color in series:
        pts = []
        for i, value in enumerate(values):
            x = gx0 + (gx1 - gx0) * i / max(1, n - 1)
            y = gy1 - (gy1 - gy0) * (value - y_min) / (y_max - y_min)
            pts.append((round(x), round(y)))
        draw.line(pts, fill=color, width=4, joint="curve")
        for p in pts[:: max(1, n // 6)]:
            draw.ellipse((p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4), fill=color)
    lx = gx0
    ly = y1 - 36
    for label, _values, color in series:
        draw.rounded_rectangle((lx, ly, lx + 20, ly + 10), radius=5, fill=color)
        draw.text((lx + 28, ly - 5), label, fill=PALETTE["muted"], font=font(15))
        lx += 210


def crop_with_box(
    img: Image.Image,
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    pad_cells: int = 24,
) -> Image.Image:
    row0 = max(0, start // cols - 4)
    row1 = min(img.height // pitch, end // cols + 5)
    col0 = max(0, start % cols - pad_cells)
    col1 = min(cols, end % cols + pad_cells)
    if row1 <= row0:
        row1 = min(img.height // pitch, row0 + 8)
    if col1 <= col0:
        col1 = min(cols, col0 + 48)
    x0, y0, x1, y1 = col0 * adv, row0 * pitch, col1 * adv, row1 * pitch
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    draw = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    draw.rounded_rectangle(
        (bx0, by0, bx1, by1), radius=3, outline=PALETTE["red"], width=3
    )
    return crop


def paste_fit(
    canvas: Image.Image, img: Image.Image, box: tuple[int, int, int, int]
) -> None:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.Resampling.NEAREST,
    )
    px = x0 + (x1 - x0 - resized.width) // 2
    py = y0 + (y1 - y0 - resized.height) // 2
    canvas.paste(resized, (px, py))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--activation", default=str(HERE / "results" / "activation-paddleocr-8x13-n16")
    )
    ap.add_argument(
        "--occlusion", default=str(HERE / "results" / "snapcompact-occlusion-qwen-8x13")
    )
    ap.add_argument(
        "--out", default=str(HERE / "results" / "snapcompact-blog-whitebox.png")
    )
    args = ap.parse_args()

    act_dir = Path(args.activation)
    occ_dir = Path(args.occlusion)
    summary = json.loads((act_dir / "summary.json").read_text())
    occ = json.loads((occ_dir / "summary.json").read_text())
    records = [
        json.loads(line)
        for line in (act_dir / "records.jsonl").read_text().splitlines()
        if line
    ]
    layers = summary["layers"]

    w, h = 1800, 1040
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    # Background texture.
    for y in range(0, h, 18):
        color = (10 + y % 17, 13 + y % 13, 17 + y % 11)
        draw.line((0, y, w, y), fill=color)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-160, -220, 760, 520), fill=(255, 104, 72, 34))
    gd.ellipse((1100, 130, 2100, 1160), fill=(67, 210, 255, 28))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(70))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw_label(
        draw, (56, 38), "SNAPCOMPACT UNDER THE MICROSCOPE", PALETTE["amber"], 21, True
    )
    draw_label(
        draw,
        (56, 78),
        "Dense text-images leave a white-box trace",
        PALETTE["text"],
        54,
        True,
    )
    draw_label(
        draw,
        (58, 145),
        "Text and image prompts converge late; blanking the gold answer region perturbs hidden states far more than an equal random blank.",
        PALETTE["muted"],
        24,
    )

    # Big stat cards.
    stats = [
        (
            "Qwen black-box F1",
            f"{occ['variants']['original']['f1']:.2f}",
            "original image",
        ),
        (
            "gold-mask drop",
            f"−{occ['drops']['answer_mask']:.2f}",
            "answer region blanked",
        ),
        (
            "random-mask drop",
            f"−{occ['drops']['random_mask']:.2f}",
            "same-size random blank",
        ),
    ]
    sx = 56
    card_w = 258
    for title, value, caption in stats:
        rounded(
            draw,
            (sx, 205, sx + card_w, 330),
            PALETTE["panel2"],
            outline=(36, 48, 56),
            radius=22,
        )
        draw_label(draw, (sx + 20, 226), title, PALETTE["muted"], 16)
        draw_label(draw, (sx + 20, 252), value, PALETTE["text"], 42, True)
        draw_label(draw, (sx + 20, 300), caption, PALETTE["muted"], 14)
        sx += card_w + 22

    chart(
        draw,
        (56, 368, 872, 668),
        [
            (
                "text ↔ image CKA",
                [x["cka_text_image"] for x in layers],
                PALETTE["accent2"],
            ),
            (
                "answer-mask CKA",
                [x["cka_image_answer_mask"] for x in layers],
                PALETTE["accent"],
            ),
            (
                "random-mask CKA",
                [x["cka_image_random_mask"] for x in layers],
                PALETTE["green"],
            ),
        ],
        0.2,
        1.0,
        "Layer geometry",
        "PaddleOCR-VL hidden-state similarity across 19 decoder layers",
    )
    chart(
        draw,
        (56, 698, 872, 990),
        [
            (
                "answer / random perturbation",
                [x["answer_over_random_delta"] for x in layers],
                PALETTE["amber"],
            ),
        ],
        1.0,
        1.6,
        "Causal-ish scar",
        "Mean hidden-state shift: gold answer mask divided by random mask",
    )

    # Visual crop panel.
    panel = (920, 205, 1744, 990)
    rounded(draw, panel, PALETTE["panel"], outline=(35, 47, 56), radius=26)
    draw_label(
        draw, (950, 232), "What the mask test looks like", PALETTE["text"], 34, True
    )
    draw_label(
        draw,
        (950, 274),
        "Same question, same bitmap. Only the gold answer cells are erased.",
        PALETTE["muted"],
        19,
    )

    base = Image.open(act_dir / "activation-images" / "base.png").convert("RGB")
    # Use a later question if possible because it gives a better-looking crop.
    rec = records[min(7, len(records) - 1)]
    ans = Image.open(
        act_dir / "activation-images" / f"q{rec['question_index']}-answer-mask.png"
    ).convert("RGB")
    rnd = Image.open(
        act_dir / "activation-images" / f"q{rec['question_index']}-random-mask.png"
    ).convert("RGB")
    cols = summary["geometry"]["cols"]
    adv = 8
    pitch = 13
    crops = [
        (
            "original",
            crop_with_box(
                base, rec["answer_start"], rec["answer_end"], cols, adv, pitch
            ),
            PALETTE["accent2"],
        ),
        (
            "answer masked",
            crop_with_box(
                ans, rec["answer_start"], rec["answer_end"], cols, adv, pitch
            ),
            PALETTE["accent"],
        ),
        (
            "random masked",
            crop_with_box(
                rnd, rec["random_start"], rec["random_end"], cols, adv, pitch
            ),
            PALETTE["green"],
        ),
    ]
    y = 334
    for label, img, color in crops:
        draw_label(draw, (950, y - 31), label.upper(), color, 17, True)
        rounded(
            draw,
            (950, y, 1714, y + 150),
            (244, 242, 230),
            outline=color,
            radius=14,
            width=3,
        )
        paste_fit(canvas, img, (966, y + 16, 1698, y + 134))
        y += 198

    q = rec["q"]
    if len(q) > 92:
        q = q[:89] + "…"
    draw_label(draw, (950, 916), "sample question", PALETTE["muted"], 17, True)
    draw_label(draw, (950, 940), q, PALETTE["text"], 20)
    draw_label(
        draw,
        (950, 966),
        f"gold answer: {rec['answer_text']}",
        PALETTE["amber"],
        18,
        True,
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
