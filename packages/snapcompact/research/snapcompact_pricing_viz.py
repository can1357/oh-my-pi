# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Pricing graphic for the snapcompact post: what a PNG bills vs what it carries."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
P = {
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

# (label, text-token equivalent, note). Billed image tokens are constant per canvas.
CARRY = [
    ("8x13 font · 1568²", 5219, "23,520 chars · measured BPE count", 3279),
    ("6x10 font · 1568²", 10000, "40,716 chars · ~4 chars/token", 3279),
    ("6x10 font · 2576²", 25000, "102,000 chars · one whole corpus", 4950),
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "results" / "snapcompact-pricing.png"))
    args = ap.parse_args()

    w, h = 2200, 1000
    canvas = Image.new("RGB", (w, h), P["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -240, 800, 560), fill=(75, 220, 255, 26))
    gd.ellipse((1400, 400, 2460, 1240), fill=(255, 196, 68, 26))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(88))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((64, 40), "THE BILLING MATH", fill=P["amber"], font=ui_font(24, True))
    draw.text(
        (64, 80),
        "A flat fee per canvas, no matter what's inside",
        fill=P["ink"],
        font=ui_font(56, True),
    )
    draw.text(
        (66, 152),
        "Anthropic bills images at width × height ÷ 750 tokens. Text tokens scale with content; image tokens scale with pixels. Dense fonts exploit the gap.",
        fill=P["muted"],
        font=ui_font(22),
    )

    # Formula card.
    card = (64, 224, 700, 420)
    draw.rounded_rectangle(
        card, radius=22, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text((96, 246), "flat fee per canvas", fill=P["cyan"], font=ui_font(21, True))
    draw.text(
        (96, 286), "1568 × 1568 → 3,279 tokens", fill=P["ink"], font=mono_font(24)
    )
    draw.text(
        (96, 326), "2576 × 2576 → 4,950 tokens", fill=P["ink"], font=mono_font(24)
    )
    draw.text(
        (96, 372),
        "(2576 is silently downscaled 0.75x — still the best $/char)",
        fill=P["muted"],
        font=ui_font(15),
    )

    # Cache card.
    card = (64, 452, 700, 660)
    draw.rounded_rectangle(
        card, radius=22, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text((96, 474), "with prompt caching", fill=P["green"], font=ui_font(21, True))
    draw.text(
        (96, 514),
        "marginal re-ask ≈ 333 tokens/turn",
        fill=P["ink"],
        font=mono_font(22),
    )
    draw.text(
        (96, 554),
        "measured: 753 in · 3,330 cache-write",
        fill=P["muted"],
        font=mono_font(17),
    )
    draw.text(
        (96, 584),
        "16,650 cache-read over six calls",
        fill=P["muted"],
        font=mono_font(17),
    )
    draw.text(
        (96, 620), "$0.18 cached vs $0.33 uncached", fill=P["amber"], font=mono_font(18)
    )

    # Fine-print card.
    card = (64, 692, 700, 920)
    draw.rounded_rectangle(
        card, radius=22, fill=P["panel"], outline=(255, 112, 72), width=1
    )
    draw.text((96, 714), "the decode tax", fill=P["orange"], font=ui_font(21, True))
    draw.text(
        (96, 754),
        "Models reason their way through dense",
        fill=P["muted"],
        font=ui_font(18),
    )
    draw.text(
        (96, 782),
        "pixels: 5–10x more thinking tokens than",
        fill=P["muted"],
        font=ui_font(18),
    )
    draw.text(
        (96, 810),
        "text. Input savings are real; total cost",
        fill=P["muted"],
        font=ui_font(18),
    )
    draw.text(
        (96, 838),
        "depends on output pricing. Cache + re-ask",
        fill=P["muted"],
        font=ui_font(18),
    )
    draw.text(
        (96, 866), "is where it always wins.", fill=P["ink"], font=ui_font(18, True)
    )

    # Carry bars.
    panel = (760, 224, 2136, 920)
    draw.rounded_rectangle(
        panel, radius=26, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (796, 250),
        "text-token equivalent carried vs image tokens billed",
        fill=P["ink"],
        font=ui_font(26, True),
    )
    draw.text(
        (796, 290),
        "same content, two meters — the orange bar is what you'd pay as text; the cyan bar is what the PNG bills",
        fill=P["muted"],
        font=ui_font(17),
    )
    bx0, bx1 = 1100, 1860
    max_tokens = 25000
    y = 360
    for label, text_tokens, note, billed in CARRY:
        draw.text((796, y + 6), label, fill=P["ink"], font=mono_font(17))
        draw.text((796, y + 32), note, fill=P["muted"], font=ui_font(13))
        tw = round((bx1 - bx0) * text_tokens / max_tokens)
        bw = round((bx1 - bx0) * billed / max_tokens)
        draw.rounded_rectangle((bx0, y, bx0 + tw, y + 26), radius=9, fill=P["orange"])
        draw.text(
            (bx0 + tw + 12, y + 2),
            f"{text_tokens:,} as text",
            fill=P["orange"],
            font=mono_font(15),
        )
        draw.rounded_rectangle(
            (bx0, y + 34, bx0 + bw, y + 60), radius=9, fill=P["cyan"]
        )
        ratio = text_tokens / billed
        draw.text(
            (bx0 + bw + 12, y + 36),
            f"{billed:,} billed · {ratio:.1f}x",
            fill=P["cyan"],
            font=mono_font(15),
        )
        y += 130
    # Cached marginal bar.
    draw.text(
        (796, y + 6), "any font · cached re-ask", fill=P["ink"], font=mono_font(17)
    )
    draw.text(
        (796, y + 32), "image as cached prefix block", fill=P["muted"], font=ui_font(13)
    )
    bw = max(6, round((bx1 - bx0) * 333 / max_tokens))
    draw.rounded_rectangle((bx0, y + 14, bx0 + bw, y + 40), radius=9, fill=P["green"])
    draw.text(
        (bx0 + bw + 12, y + 16),
        "≈ 333 tokens/turn · 30x",
        fill=P["green"],
        font=mono_font(15),
    )
    y += 110
    draw.line((796, y, 2100, y), fill=P["grid"], width=1)
    draw.text(
        (796, y + 16),
        "10,000 tokens of text, carried by 3,279 image tokens, amortizing to ~333 — that's the whole pitch.",
        fill=P["amber"],
        font=ui_font(19, True),
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
