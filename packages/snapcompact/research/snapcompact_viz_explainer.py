# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render a single-frame snapcompact white-box explainer composite.

The figure uses the saved tensor heatmaps from the PaddleOCR-VL run. It lays out
four linked stages: the source bitmap, the answer-region mask intervention, the
layer/token hidden-state tensor, and the interpretation stats.
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
DEFAULT_DATA = HERE / "results" / "tensor-heatmap-paddleocr-q7"
DEFAULT_OUT = HERE / "results" / "agent-viz-explainer"

BG = (4, 7, 13)
PANEL = (13, 18, 27)
PANEL_2 = (17, 24, 36)
INK = (244, 243, 231)
MUTED = (137, 153, 166)
DIM = (72, 84, 98)
CYAN = (78, 219, 255)
RED = (255, 82, 65)
AMBER = (255, 197, 78)
GREEN = (129, 255, 136)
VIOLET = (172, 116, 255)
LINE = (37, 50, 64)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = [
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
    for name in names:
        if name and Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


F10 = font(10)
F12 = font(12)
F14 = font(14)
F16 = font(16)
F18 = font(18)
F20 = font(20)
F22 = font(22, True)
F26 = font(26, True)
F30 = font(30, True)
F38 = font(38, True)
F56 = font(56, True)
F72 = font(72, True)


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    return tuple(lerp(a[i], b[i], t) for i in range(3))


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, float(t)))
    stops = [
        (0.00, (5, 8, 20)),
        (0.16, (22, 28, 75)),
        (0.34, (81, 40, 125)),
        (0.56, (208, 54, 101)),
        (0.76, (255, 130, 69)),
        (0.91, (255, 210, 94)),
        (1.00, (255, 252, 200)),
    ]
    for (x0, c0), (x1, c1) in zip(stops, stops[1:]):
        if t <= x1:
            return mix(c0, c1, (t - x0) / (x1 - x0))
    return stops[-1][1]


def blue_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, float(t)))
    return mix((8, 13, 28), CYAN, t**0.75)


def paste_round(
    base: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    radius: int = 24,
) -> None:
    x0, y0, x1, y1 = box
    img = img.convert("RGB")
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.Resampling.LANCZOS,
    )
    px = x0 + (x1 - x0 - resized.width) // 2
    py = y0 + (y1 - y0 - resized.height) // 2
    mask = Image.new("L", resized.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, resized.width - 1, resized.height - 1), radius=radius, fill=255
    )
    base.paste(resized, (px, py), mask)


def draw_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str,
    accent: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=30, fill=PANEL, outline=LINE, width=2)
    draw.rectangle((x0 + 28, y0 + 22, x0 + 84, y0 + 28), fill=accent)
    draw.text((x0 + 28, y0 + 43), title, fill=INK, font=F26)
    draw.text((x0 + 28, y0 + 78), subtitle, fill=MUTED, font=F16)


def draw_arrow(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    color: tuple[int, int, int],
    label: str,
) -> None:
    sx, sy = start
    ex, ey = end
    draw.line((sx, sy, ex - 18, ey), fill=color, width=5)
    draw.polygon([(ex, ey), (ex - 22, ey - 14), (ex - 22, ey + 14)], fill=color)
    if not label:
        return
    tw = round(draw.textlength(label, font=F14))
    draw.rounded_rectangle(
        (sx + 20, sy - 31, sx + 42 + tw, sy - 6),
        radius=12,
        fill=(9, 14, 24),
        outline=mix(color, LINE, 0.35),
    )
    draw.text((sx + 31, sy - 29), label, fill=color, font=F14)


def cell_box(summary: dict) -> tuple[int, int, int, int]:
    q = summary["question"]
    g = summary["geometry"]
    cols = int(g["cols"])
    rows = int(g["rows"])
    start = int(q["answer_start"])
    end = int(q["answer_end"])
    cw = 768 / cols
    ch = 768 / rows
    r0, c0 = divmod(start, cols)
    r1, c1 = divmod(max(start, end - 1), cols)
    return (
        math.floor(c0 * cw),
        math.floor(r0 * ch),
        math.ceil((c1 + 1) * cw),
        math.ceil((r1 + 1) * ch),
    )


def answer_crop(
    img: Image.Image, summary: dict, pad_cells: int = 31
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    g = summary["geometry"]
    cols = int(g["cols"])
    rows = int(g["rows"])
    q = summary["question"]
    start = int(q["answer_start"])
    end = int(q["answer_end"])
    row = start // cols
    col0 = start % cols
    col1 = (end - 1) % cols + 1
    cw = img.width / cols
    ch = img.height / rows
    x0 = max(0, math.floor((col0 - pad_cells) * cw))
    x1 = min(img.width, math.ceil((col1 + pad_cells) * cw))
    y0 = max(0, math.floor((row - 5) * ch))
    y1 = min(img.height, math.ceil((row + 6) * ch))
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    local = (
        round(col0 * cw - x0),
        round(row * ch - y0),
        round(col1 * cw - x0),
        round((row + 1) * ch - y0),
    )
    return crop, local


def draw_crop_card(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    img: Image.Image,
    local_box: tuple[int, int, int, int],
    title: str,
    accent: tuple[int, int, int],
) -> None:
    draw = ImageDraw.Draw(canvas)
    x0, y0, x1, y1 = box
    draw.text((x0, y0 - 28), title, fill=accent, font=F16)
    draw.rounded_rectangle(
        box, radius=18, fill=(236, 234, 219), outline=accent, width=3
    )
    pad = 14
    scale = min((x1 - x0 - 2 * pad) / img.width, (y1 - y0 - 2 * pad) / img.height)
    resized = img.resize(
        (round(img.width * scale), round(img.height * scale)), Image.Resampling.NEAREST
    )
    px = x0 + (x1 - x0 - resized.width) // 2
    py = y0 + (y1 - y0 - resized.height) // 2
    canvas.paste(resized, (px, py))
    bx = tuple(round(v * scale) for v in local_box)
    draw.rounded_rectangle(
        (px + bx[0] - 4, py + bx[1] - 4, px + bx[2] + 4, py + bx[3] + 4),
        radius=6,
        outline=accent,
        width=4,
    )


def draw_heatmap(
    draw: ImageDraw.ImageDraw, arr: np.ndarray, box: tuple[int, int, int, int]
) -> None:
    x0, y0, x1, y1 = box
    rows, cols = arr.shape
    cw = (x1 - x0) / cols
    ch = (y1 - y0) / rows
    for r in range(rows):
        ya = round(y0 + r * ch)
        yb = round(y0 + (r + 1) * ch)
        for c in range(cols):
            xa = round(x0 + c * cw)
            xb = round(x0 + (c + 1) * cw)
            draw.rectangle((xa, ya, xb, yb), fill=heat_color(float(arr[r, c])))
    for r in range(rows + 1):
        y = round(y0 + r * ch)
        draw.line(
            (x0, y, x1, y), fill=(0, 0, 0, 90) if False else (20, 26, 36), width=1
        )
    draw.rectangle(box, outline=(83, 101, 118), width=1)


def draw_tensor_ribbons(
    draw: ImageDraw.ImageDraw,
    answer: np.ndarray,
    random: np.ndarray,
    box: tuple[int, int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    rows, cols = answer.shape
    lane_h = (y1 - y0) / rows
    for r in range(rows):
        ya = y0 + r * lane_h
        yb = y0 + (r + 0.68) * lane_h
        for c in range(cols):
            xa = x0 + c * (x1 - x0) / cols
            xb = x0 + (c + 1) * (x1 - x0) / cols
            a = float(answer[r, c])
            rr = float(random[r, c])
            color = heat_color(a)
            if rr > a * 0.86:
                color = mix(color, (45, 88, 77), min(0.50, rr * 0.45))
            draw.rectangle((round(xa), round(ya), round(xb), round(yb)), fill=color)
        if r % 3 == 0:
            draw.text((x0 - 33, round(ya + 2)), f"L{r}", fill=MUTED, font=F12)
    draw.rectangle(box, outline=(91, 106, 122), width=1)


def draw_token_grid(
    draw: ImageDraw.ImageDraw, ratio: np.ndarray, box: tuple[int, int, int, int]
) -> None:
    x0, y0, x1, y1 = box
    grid = ratio.mean(axis=0).reshape(27, 27)
    q98 = float(np.quantile(grid, 0.98)) or 1.0
    norm = np.clip(grid / q98, 0, 1)
    cell = min((x1 - x0) / 27, (y1 - y0) / 27)
    ox = x0 + ((x1 - x0) - 27 * cell) / 2
    oy = y0 + ((y1 - y0) - 27 * cell) / 2
    for r in range(27):
        for c in range(27):
            xa = round(ox + c * cell)
            ya = round(oy + r * cell)
            xb = round(ox + (c + 1) * cell - 1)
            yb = round(oy + (r + 1) * cell - 1)
            draw.rounded_rectangle(
                (xa, ya, xb, yb), radius=3, fill=blue_color(float(norm[r, c]))
            )
    top = np.unravel_index(np.argsort(grid, axis=None)[-6:], grid.shape)
    for r, c in zip(top[0], top[1]):
        xa = round(ox + c * cell)
        ya = round(oy + r * cell)
        draw.rounded_rectangle(
            (xa - 2, ya - 2, round(xa + cell + 1), round(ya + cell + 1)),
            radius=4,
            outline=AMBER,
            width=2,
        )


def polyline(
    draw: ImageDraw.ImageDraw,
    values: Iterable[float],
    box: tuple[int, int, int, int],
    color: tuple[int, int, int],
    width: int = 4,
) -> None:
    vals = list(values)
    x0, y0, x1, y1 = box
    lo = min(vals)
    hi = max(vals)
    span = hi - lo if hi > lo else 1.0
    points = []
    for i, v in enumerate(vals):
        x = x0 + i * (x1 - x0) / max(1, len(vals) - 1)
        y = y1 - ((v - lo) / span) * (y1 - y0)
        points.append((round(x), round(y)))
    for i in range(1, len(points)):
        draw.line((points[i - 1], points[i]), fill=color, width=width)
    for x, y in points:
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=color)


def metric(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    label: str,
    value: str,
    sub: str,
    accent: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=20, fill=PANEL_2, outline=mix(accent, LINE, 0.35), width=2
    )
    draw.text((x0 + 18, y0 + 16), label, fill=MUTED, font=F14)
    draw.text((x0 + 18, y0 + 41), value, fill=accent, font=F38)
    draw.text((x0 + 18, y1 - 32), sub, fill=INK, font=F14)


def wrap_text(
    draw: ImageDraw.ImageDraw, text: str, max_width: int, fnt: ImageFont.ImageFont
) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = word if not cur else f"{cur} {word}"
        if draw.textlength(trial, font=fnt) <= max_width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def save_source_metrics(
    out_dir: Path, summary: dict, arrays: dict[str, np.ndarray]
) -> None:
    ratio = arrays["ratio"]
    answer = arrays["answer_delta"]
    random = arrays["random_delta"]
    top_cell = np.unravel_index(int(np.argmax(ratio)), ratio.shape)
    metrics = {
        "question": summary["question"]["q"],
        "answer": summary["question"]["answer_text"],
        "layers": int(summary["layers"]),
        "image_tokens": int(summary["image_tokens"]),
        "answer_delta_mean": float(summary["answer_delta_mean"]),
        "random_delta_mean": float(summary["random_delta_mean"]),
        "answer_over_random_delta": float(summary["answer_over_random_delta"]),
        "max_ratio_layer": int(top_cell[0]),
        "max_ratio_token": int(top_cell[1]),
        "max_ratio": float(ratio[top_cell]),
        "mean_answer_by_layer": [float(x) for x in answer.mean(axis=1)],
        "mean_random_by_layer": [float(x) for x in random.mean(axis=1)],
        "mean_ratio_by_layer": [float(x) for x in ratio.mean(axis=1)],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "explainer_metrics.json").write_text(
        json.dumps(metrics, indent=2) + "\n"
    )


def render(data_dir: Path, out_dir: Path) -> Path:
    summary = json.loads((data_dir / "summary.json").read_text())
    npz = np.load(data_dir / "heatmaps.npz")
    arrays = {name: npz[name] for name in npz.files}
    original = Image.open(data_dir / "images" / "original.png").convert("RGB")
    answer_mask = Image.open(data_dir / "images" / "answer-mask.png").convert("RGB")

    w, h = 2400, 1500
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)

    # Subtle technical-paper background and activation glows.
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(6, 10 + (y % 5), 18 + (y % 7)))
    for x in range(0, w, 32):
        draw.line((x, 0, x, h), fill=(5, 8, 15))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-300, -210, 980, 760), fill=(78, 219, 255, 35))
    gd.ellipse((690, 200, 1850, 1370), fill=(255, 82, 65, 32))
    gd.ellipse((1550, -120, 2660, 980), fill=(255, 197, 78, 24))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(90))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((72, 52), "SNAPCOMPACT ACTIVATION EXPLAINER", fill=AMBER, font=F22)
    draw.text((72, 86), "From erased pixels to a hidden-state scar", fill=INK, font=F72)
    q = summary["question"]["q"]
    subtitle = f"Question: {q}   ·   gold answer: {summary['question']['answer_text']}"
    draw.text((75, 172), subtitle, fill=MUTED, font=F22)

    # Stage panels.
    p1 = (72, 240, 585, 1178)
    p2 = (630, 240, 1143, 1178)
    p3 = (1188, 240, 1770, 1178)
    p4 = (1815, 240, 2328, 1178)
    draw_panel(
        draw, p1, "1 · input bitmap", "Rendered context before intervention", CYAN
    )
    draw_panel(
        draw, p2, "2 · mask intervention", "Only the true answer cells are blanked", RED
    )
    draw_panel(
        draw, p3, "3 · hidden-state tensor", "Layer × image-token response", VIOLET
    )
    draw_panel(draw, p4, "4 · interpretation", "Where the answer mattered most", AMBER)
    draw_arrow(draw, (585, 715), (630, 715), CYAN, "")
    draw_arrow(draw, (1143, 715), (1188, 715), RED, "")
    draw_arrow(draw, (1770, 715), (1815, 715), AMBER, "")

    # Input / intervention panels.
    paste_round(canvas, original, (108, 352, 548, 792), 24)
    full_box = cell_box(summary)
    scale = 440 / 768
    ox, oy = 108, 352
    draw.rounded_rectangle(
        (
            ox + round(full_box[0] * scale),
            oy + round(full_box[1] * scale),
            ox + round(full_box[2] * scale),
            oy + round(full_box[3] * scale),
        ),
        radius=5,
        outline=AMBER,
        width=4,
    )
    ocrop, local = answer_crop(original, summary)
    mcrop, mlocal = answer_crop(answer_mask, summary)
    draw_crop_card(
        canvas, (108, 885, 548, 1042), ocrop, local, "magnified answer glyphs", AMBER
    )
    draw.text(
        (108, 1083),
        "The OCR input is a fixed bitmap. The answer span",
        fill=MUTED,
        font=F16,
    )
    draw.text(
        (108, 1108),
        f"occupies character cells {summary['question']['answer_start']}–{summary['question']['answer_end'] - 1}.",
        fill=MUTED,
        font=F16,
    )

    paste_round(canvas, answer_mask, (666, 352, 1106, 792), 24)
    draw.rounded_rectangle(
        (
            666 + round(full_box[0] * scale),
            352 + round(full_box[1] * scale),
            666 + round(full_box[2] * scale),
            352 + round(full_box[3] * scale),
        ),
        radius=5,
        outline=RED,
        width=4,
    )
    draw_crop_card(
        canvas, (666, 885, 1106, 1042), mcrop, mlocal, "same crop after masking", RED
    )
    draw.text(
        (666, 1083),
        "Same prompt, same rendered page. Difference:",
        fill=MUTED,
        font=F16,
    )
    draw.text(
        (666, 1108),
        "the four answer glyphs are removed before inference.",
        fill=MUTED,
        font=F16,
    )

    # Tensor panel.
    draw.text((1226, 332), "answer-mask delta", fill=RED, font=F18)
    draw.text((1600, 332), "random control mixed in green", fill=GREEN, font=F14)
    draw_tensor_ribbons(
        draw, arrays["answer_norm"], arrays["random_norm"], (1240, 372, 1718, 665)
    )
    draw.text((1238, 686), "answer / random ratio", fill=AMBER, font=F18)
    draw.text(
        (1238, 712),
        "bright = answer-region deletion moves hidden states more than an equal random mask",
        fill=MUTED,
        font=F14,
    )
    draw_heatmap(draw, arrays["ratio_norm"], (1240, 748, 1718, 1000))
    max_layer = int(summary["max_ratio_layer"])
    draw.line(
        (
            1240,
            748 + round((max_layer + 0.5) * 252 / 19),
            1718,
            748 + round((max_layer + 0.5) * 252 / 19),
        ),
        fill=AMBER,
        width=3,
    )
    for i in range(240):
        draw.rectangle((1240 + i, 1046, 1241 + i, 1063), fill=heat_color(i / 239))
    draw.text((1240, 1022), "low", fill=MUTED, font=F12)
    draw.text((1446, 1022), "high", fill=MUTED, font=F12)
    draw.text(
        (1240, 1094),
        f"{summary['layers']} decoder layers × {summary['image_tokens']} image tokens",
        fill=INK,
        font=F20,
    )
    draw.text(
        (1240, 1124),
        "Each cell uses the saved heatmaps.npz tensor values.",
        fill=MUTED,
        font=F16,
    )

    # Interpretation panel.
    metric(
        draw,
        (1850, 344, 2075, 478),
        "mean delta ratio",
        f"{summary['answer_over_random_delta']:.2f}×",
        "answer mask vs control",
        AMBER,
    )
    metric(
        draw,
        (2086, 344, 2293, 478),
        "strongest layer",
        f"L{summary['max_ratio_layer']}",
        "mean ratio peak",
        VIOLET,
    )
    metric(
        draw,
        (1850, 500, 2075, 634),
        "answer delta",
        f"{summary['answer_delta_mean']:.2f}",
        "mean ||Δh||",
        RED,
    )
    metric(
        draw,
        (2086, 500, 2293, 634),
        "control delta",
        f"{summary['random_delta_mean']:.2f}",
        "mean ||Δh||",
        GREEN,
    )

    draw.text((1852, 684), "layer sensitivity curve", fill=INK, font=F20)
    curve_box = (1862, 725, 2290, 858)
    draw.rounded_rectangle(
        (1850, 704, 2304, 884), radius=20, fill=PANEL_2, outline=LINE, width=2
    )
    for i in range(5):
        y = curve_box[1] + i * (curve_box[3] - curve_box[1]) / 4
        draw.line((curve_box[0], round(y), curve_box[2], round(y)), fill=(31, 42, 54))
    polyline(draw, summary["mean_ratio_by_layer"], curve_box, AMBER, 4)
    draw.text((1862, 862), "L0", fill=MUTED, font=F12)
    draw.text((2262, 862), f"L{summary['layers'] - 1}", fill=MUTED, font=F12)

    draw.text((1852, 927), "image-token sensitivity field", fill=INK, font=F20)
    draw.rounded_rectangle(
        (1850, 955, 2067, 1150), radius=20, fill=PANEL_2, outline=LINE, width=2
    )
    draw_token_grid(draw, arrays["ratio"], (1868, 970, 2049, 1132))
    explanation = "Answer deletion creates a high-ratio band in early layers; later layers diffuse it into surrounding context."
    for i, line in enumerate(wrap_text(draw, explanation, 195, F14)):
        draw.text((2092, 968 + i * 24), line, fill=INK if i == 0 else MUTED, font=F14)
    draw.text((2092, 1090), "Interpretation:", fill=AMBER, font=F16)
    draw.text(
        (2092, 1118), "the answer glyphs are not just OCR text;", fill=MUTED, font=F14
    )
    draw.text(
        (2092, 1142),
        "they perturb the multimodal residual stream.",
        fill=MUTED,
        font=F14,
    )

    # Footer with provenance.
    footer = (72, 1228, 2328, 1422)
    draw.rounded_rectangle(footer, radius=30, fill=(8, 12, 20), outline=LINE, width=2)
    draw.text((108, 1266), "Reading the composite", fill=INK, font=F30)
    bullets = [
        (CYAN, "Input bitmap", "is the rendered evidence page passed to PaddleOCR-VL."),
        (RED, "Mask intervention", "removes only the gold answer span: 2003."),
        (
            VIOLET,
            "Hidden-state tensor",
            "plots ||hidden(original) − hidden(masked)|| over saved layer/token arrays.",
        ),
        (
            AMBER,
            "Interpretation",
            "compares that scar to an equal-size random mask: 2.52× stronger on average.",
        ),
    ]
    x = 108
    for color, head, text in bullets:
        draw.rounded_rectangle(
            (x, 1320, x + 500, 1384),
            radius=18,
            fill=PANEL_2,
            outline=mix(color, LINE, 0.35),
            width=2,
        )
        draw.ellipse((x + 18, 1343, x + 36, 1361), fill=color)
        draw.text((x + 50, 1330), head, fill=color, font=F16)
        draw.text((x + 50, 1355), text, fill=MUTED, font=F14)
        x += 545

    save_source_metrics(out_dir, summary, arrays)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "explainer.png"
    canvas.save(out_path, optimize=True)
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out = render(args.data_dir, args.out_dir)
    print(out)


if __name__ == "__main__":
    main()
