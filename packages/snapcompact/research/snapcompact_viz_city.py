# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Render an isometric activation city from snapcompact heatmap tensors."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = HERE / "results" / "agent-viz-city"

BG = (8, 11, 24)
INK = (232, 238, 255)
MUTED = (136, 148, 184)
ANSWER = (255, 94, 117)
ANSWER_HI = (255, 198, 97)
RANDOM = (72, 201, 255)
RANDOM_HI = (127, 246, 213)
ROAD = (21, 28, 52)
GRID = (39, 48, 83)


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
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def clamp255(v: float) -> int:
    return max(0, min(255, int(round(v))))


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(clamp255(x + (y - x) * t) for x, y in zip(a, b))


def shade(c: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(clamp255(x * factor) for x in c)


def iso(
    x: float, y: float, origin: tuple[float, float], tile_w: float, tile_h: float
) -> tuple[float, float]:
    ox, oy = origin
    return ox + (x - y) * tile_w * 0.5, oy + (x + y) * tile_h * 0.5


def diamond(
    cx: float, cy: float, tile_w: float, tile_h: float
) -> list[tuple[float, float]]:
    return [
        (cx, cy - tile_h * 0.5),
        (cx + tile_w * 0.5, cy),
        (cx, cy + tile_h * 0.5),
        (cx - tile_w * 0.5, cy),
    ]


def building_faces(
    cx: float, cy: float, h: float, tile_w: float, tile_h: float
) -> tuple[
    list[tuple[float, float]], list[tuple[float, float]], list[tuple[float, float]]
]:
    top = diamond(cx, cy - h, tile_w, tile_h)
    right = [top[1], (cx + tile_w * 0.5, cy), (cx, cy + tile_h * 0.5), top[2]]
    left = [top[3], top[2], (cx, cy + tile_h * 0.5), (cx - tile_w * 0.5, cy)]
    return top, right, left


def draw_soft_line(
    draw: ImageDraw.ImageDraw,
    pts: Iterable[tuple[float, float]],
    fill: tuple[int, int, int],
    width: int = 1,
) -> None:
    draw.line([(int(x), int(y)) for x, y in pts], fill=fill, width=width)


def draw_district(
    draw: ImageDraw.ImageDraw,
    values: np.ndarray,
    ratios: np.ndarray,
    origin: tuple[float, float],
    base_color: tuple[int, int, int],
    high_color: tuple[int, int, int],
    label: str,
    scale: float,
    ratio_scale: float,
) -> None:
    layers, bins = values.shape
    tile_w = 9.0
    tile_h = 5.0
    max_h = 245.0

    # Foundation grid and layer streets.
    for layer in range(layers):
        left = iso(0, layer, origin, tile_w, tile_h)
        right = iso(bins - 1, layer, origin, tile_w, tile_h)
        draw_soft_line(draw, [left, right], GRID if layer % 3 else (66, 76, 118), 1)
    for token in range(0, bins, 10):
        near = iso(token, 0, origin, tile_w, tile_h)
        far = iso(token, layers - 1, origin, tile_w, tile_h)
        draw_soft_line(draw, [near, far], (31, 39, 70), 1)

    # Draw far blocks first, near blocks last.
    for layer in range(layers - 1, -1, -1):
        for token in range(bins - 1, -1, -1):
            v = float(values[layer, token])
            r = float(ratios[layer, token])
            intensity = min(1.0, np.log1p(v) / np.log1p(scale))
            h = 8.0 + (intensity**1.65) * max_h
            if v <= 0.0:
                h = 3.0
            cx, cy = iso(token, layer, origin, tile_w, tile_h)
            top, right, left = building_faces(cx, cy, h, tile_w * 0.92, tile_h * 0.92)
            ratio_t = min(1.0, np.log1p(max(r, 0.0)) / np.log1p(ratio_scale))
            c = mix(base_color, high_color, max(intensity * 0.55, ratio_t * 0.85))
            draw.polygon(left, fill=shade(c, 0.42))
            draw.polygon(right, fill=shade(c, 0.62))
            draw.polygon(
                top, fill=mix(shade(c, 0.95), (255, 255, 255), intensity * 0.20)
            )
            if ratio_t > 0.80 or intensity > 0.90:
                draw.line(
                    [(int(x), int(y)) for x, y in top + [top[0]]],
                    fill=mix(c, (255, 255, 255), 0.25),
                    width=1,
                )

    # District label plaque.
    x0, y0 = iso(-2, layers + 4, origin, tile_w, tile_h)
    x1, y1 = iso(54, layers + 4, origin, tile_w, tile_h)
    draw.rounded_rectangle(
        (x0 - 26, y0 + 18, x1 + 26, y1 + 64),
        radius=14,
        fill=(13, 18, 37),
        outline=shade(base_color, 0.75),
        width=2,
    )
    draw.text(
        (x0 - 8, y0 + 27),
        label,
        font=font(26, True),
        fill=mix(base_color, high_color, 0.55),
    )


def draw_legend(
    draw: ImageDraw.ImageDraw, summary: dict[str, object], scale: float
) -> None:
    draw.text((88, 70), "Snapcompact Activation City", font=font(54, True), fill=INK)
    draw.text(
        (92, 136),
        "729 image tokens → 180 token-bin city blocks · 19 transformer layers → depth streets · building height = activation spike magnitude",
        font=font(21),
        fill=MUTED,
    )
    question = (
        str(summary.get("question", {}).get("q", ""))
        if isinstance(summary.get("question"), dict)
        else ""
    )
    answer = (
        str(summary.get("question", {}).get("answer_text", ""))
        if isinstance(summary.get("question"), dict)
        else ""
    )
    draw.text(
        (92, 173),
        f"Question: {question}   Gold answer: {answer}",
        font=font(20),
        fill=(180, 190, 220),
    )

    ratio = float(summary.get("answer_over_random_delta", 0.0))
    draw.rounded_rectangle(
        (1738, 72, 2286, 206),
        radius=24,
        fill=(12, 17, 36),
        outline=(50, 60, 99),
        width=2,
    )
    draw.text(
        (1772, 96), "Answer-mask / random-mask mean delta", font=font(18), fill=MUTED
    )
    draw.text((1772, 125), f"{ratio:.2f}×", font=font(52, True), fill=ANSWER_HI)
    draw.text(
        (1906, 149),
        f"common p98 height scale {scale:.1f}",
        font=font(17),
        fill=(176, 186, 218),
    )

    y = 1400
    draw.rounded_rectangle(
        (88, y, 772, y + 96),
        radius=18,
        fill=(12, 17, 36),
        outline=(44, 54, 92),
        width=1,
    )
    draw.text((116, y + 18), "How to read it", font=font(22, True), fill=INK)
    draw.text(
        (116, y + 52),
        "Tall towers mark token/layer bins where masking changed hidden states most.",
        font=font(18),
        fill=MUTED,
    )
    draw.rounded_rectangle(
        (836, y, 1520, y + 96),
        radius=18,
        fill=(12, 17, 36),
        outline=(44, 54, 92),
        width=1,
    )
    draw.text((864, y + 18), "Districts", font=font(22, True), fill=INK)
    draw.text(
        (864, y + 52),
        "Warm city = answer mask around “2003”; cool city = same-size random mask.",
        font=font(18),
        fill=MUTED,
    )
    draw.rounded_rectangle(
        (1584, y, 2268, y + 96),
        radius=18,
        fill=(12, 17, 36),
        outline=(44, 54, 92),
        width=1,
    )
    draw.text((1612, y + 18), "Color halos", font=font(22, True), fill=INK)
    draw.text(
        (1612, y + 52),
        "Bright caps emphasize bins with high answer/random activation ratio.",
        font=font(18),
        fill=MUTED,
    )


def render() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    heatmaps = np.load(DATA_DIR / "heatmaps.npz")
    summary = json.loads((DATA_DIR / "summary.json").read_text())

    answer = np.asarray(heatmaps["answer_binned"], dtype=np.float32)
    random = np.asarray(heatmaps["random_binned"], dtype=np.float32)
    ratio = np.asarray(heatmaps["ratio_binned"], dtype=np.float32)
    if answer.shape != random.shape or answer.shape != ratio.shape:
        raise ValueError(
            f"expected matching binned shapes, got {answer.shape}, {random.shape}, {ratio.shape}"
        )

    scale = float(
        summary.get("common_delta_scale_p98")
        or np.percentile(np.concatenate([answer.ravel(), random.ravel()]), 98)
    )
    ratio_scale = float(summary.get("ratio_scale_p98") or np.percentile(ratio, 98))

    w, h = 2400, 1600
    canvas = Image.new("RGB", (w, h), BG)

    # Atmospheric glow layer.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((90, 250, 1090, 1260), fill=(255, 80, 95, 36))
    gd.ellipse((1220, 250, 2250, 1260), fill=(62, 190, 255, 34))
    gd.rectangle((0, 1240, w, h), fill=(2, 4, 11, 90))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(58))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    # Basemap plates.
    draw.rounded_rectangle(
        (52, 244, 1134, 1330),
        radius=42,
        fill=(9, 14, 30),
        outline=(42, 31, 55),
        width=2,
    )
    draw.rounded_rectangle(
        (1234, 244, 2316, 1330),
        radius=42,
        fill=(8, 15, 31),
        outline=(24, 50, 70),
        width=2,
    )
    for y in range(312, 1300, 70):
        draw.line((70, y, 1116, y), fill=ROAD, width=1)
        draw.line((1252, y, 2298, y), fill=ROAD, width=1)

    draw_district(
        draw,
        answer,
        ratio,
        (252.0, 870.0),
        ANSWER,
        ANSWER_HI,
        "answer-mask district",
        scale,
        ratio_scale,
    )
    draw_district(
        draw,
        random,
        ratio,
        (1434.0, 870.0),
        RANDOM,
        RANDOM_HI,
        "random-mask district",
        scale,
        ratio_scale,
    )
    draw_legend(draw, summary, scale)

    # Fine vignette frame.
    vignette = Image.new("L", (w, h), 0)
    vd = ImageDraw.Draw(vignette)
    vd.rectangle((0, 0, w, h), fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(42))
    frame = Image.new("RGB", (w, h), (0, 0, 0))
    canvas = Image.composite(canvas, frame, vignette)

    np.savez_compressed(
        OUT_DIR / "city_source_data.npz",
        answer_binned=answer,
        random_binned=random,
        ratio_binned=ratio,
        common_delta_scale_p98=np.array(scale, dtype=np.float32),
        ratio_scale_p98=np.array(ratio_scale, dtype=np.float32),
    )
    (OUT_DIR / "city_summary.json").write_text(
        json.dumps(
            {
                "source_heatmaps": str(DATA_DIR / "heatmaps.npz"),
                "source_summary": str(DATA_DIR / "summary.json"),
                "shape": list(answer.shape),
                "height_encoding": "log1p(delta) scaled by common_delta_scale_p98",
                "districts": {"answer": "answer_binned", "random": "random_binned"},
                "ratio_encoding": "bright caps use ratio_binned / ratio_scale_p98",
                "answer_over_random_delta": summary.get("answer_over_random_delta"),
            },
            indent=2,
        )
        + "\n"
    )
    canvas.save(OUT_DIR / "city.png")


if __name__ == "__main__":
    render()
