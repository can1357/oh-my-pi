# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow"]
# ///
"""Render a circuit-graph visualization from snapcompact activation deltas."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
DEFAULT_RESULT_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
DEFAULT_OUT_DIR = HERE / "results" / "agent-viz-circuit"

BG = (4, 6, 10)
PANEL = (13, 17, 24)
PANEL_2 = (8, 12, 18)
INK = (242, 239, 225)
MUTED = (132, 146, 153)
BLUE = (83, 218, 255)
GOLD = (255, 199, 74)
ORANGE = (255, 122, 54)
RED = (255, 72, 82)
GREEN = (127, 245, 148)


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
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def mix(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    t = clamp01(t)
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def quantile_norm(values: np.ndarray, q: float = 0.97) -> np.ndarray:
    scale = float(np.quantile(values, q))
    if not math.isfinite(scale) or scale <= 0:
        scale = 1.0
    return np.clip(values / scale, 0, 1)


def rounded_panel(
    draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int = 34
) -> None:
    draw.rounded_rectangle(
        box, radius=radius, fill=PANEL, outline=(31, 41, 51), width=1
    )


def multiline(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    *,
    fill: tuple[int, int, int],
    fnt: ImageFont.ImageFont,
    max_width: int,
    line_gap: int = 8,
) -> int:
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
    x, y = xy
    step = fnt.size + line_gap if hasattr(fnt, "size") else 20
    for line in lines:
        draw.text((x, y), line, fill=fill, font=fnt)
        y += step
    return y


def crop_answer_region(
    img: Image.Image, summary: dict, pad_cells: int = 42
) -> Image.Image:
    q = summary["question"]
    cols = int(summary["geometry"]["cols"])
    rows = int(summary["geometry"]["rows"])
    adv = max(1, img.width // cols)
    pitch = max(1, img.height // rows)
    start = int(q["answer_start"])
    end = int(q["answer_end"])
    row0 = max(0, start // cols - 5)
    row1 = min(rows, (end - 1) // cols + 7)
    col0 = max(0, start % cols - pad_cells)
    col1 = min(cols, (end - 1) % cols + pad_cells)
    if col1 <= col0 + 8:
        col1 = min(cols, col0 + 90)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 2)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 2)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=4, outline=RED, width=4)
    return crop


def paste_fit(
    canvas: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    resample: int = Image.Resampling.LANCZOS,
) -> None:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    resized = img.resize(size, resample)
    canvas.paste(
        resized, (x0 + (x1 - x0 - size[0]) // 2, y0 + (y1 - y0 - size[1]) // 2)
    )


def draw_bezier(
    draw: ImageDraw.ImageDraw,
    points: tuple[
        tuple[float, float],
        tuple[float, float],
        tuple[float, float],
        tuple[float, float],
    ],
    *,
    fill: tuple[int, int, int, int],
    width: int,
) -> None:
    p0, p1, p2, p3 = points
    coords: list[tuple[float, float]] = []
    for i in range(46):
        t = i / 45
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        coords.append((x, y))
    draw.line(coords, fill=fill, width=width, joint="curve")


def token_groups(grid_side: int = 27, tiles: int = 3) -> list[dict[str, int | str]]:
    groups: list[dict[str, int | str]] = []
    names = [
        "upper-left",
        "upper",
        "upper-right",
        "left",
        "center",
        "right",
        "lower-left",
        "lower",
        "lower-right",
    ]
    idx = 0
    for gy in range(tiles):
        y0 = round(gy * grid_side / tiles)
        y1 = round((gy + 1) * grid_side / tiles)
        for gx in range(tiles):
            x0 = round(gx * grid_side / tiles)
            x1 = round((gx + 1) * grid_side / tiles)
            groups.append({"name": names[idx], "x0": x0, "x1": x1, "y0": y0, "y1": y1})
            idx += 1
    return groups


def group_indices(group: dict[str, int | str], grid_side: int = 27) -> np.ndarray:
    ids: list[int] = []
    for y in range(int(group["y0"]), int(group["y1"])):
        for x in range(int(group["x0"]), int(group["x1"])):
            ids.append(y * grid_side + x)
    return np.asarray(ids, dtype=np.int64)


def build_metrics(
    answer: np.ndarray, random: np.ndarray, ratio: np.ndarray
) -> tuple[list[dict], list[dict], np.ndarray, np.ndarray]:
    layers, tokens = answer.shape
    grid_side = int(round(math.sqrt(tokens)))
    if grid_side * grid_side != tokens:
        raise ValueError(f"expected square image-token grid, got {tokens} tokens")

    groups = token_groups(grid_side)
    layer_score = np.maximum(answer - random, 0.0) * np.log1p(np.maximum(ratio, 0.0))
    layer_norm = quantile_norm(layer_score, 0.975)

    group_rows: list[dict] = []
    for i, group in enumerate(groups):
        ids = group_indices(group, grid_side)
        a = answer[:, ids]
        r = random[:, ids]
        rr = ratio[:, ids]
        raw = layer_score[:, ids]
        group_rows.append(
            {
                "id": i,
                "name": group["name"],
                "x0": group["x0"],
                "x1": group["x1"],
                "y0": group["y0"],
                "y1": group["y1"],
                "answer_delta_mean": float(a.mean()),
                "random_delta_mean": float(r.mean()),
                "ratio_mean": float(rr.mean()),
                "answer_minus_random_mean": float((a - r).mean()),
                "edge_score": float(raw.mean()),
                "layer_scores": [float(raw[j].mean()) for j in range(layers)],
                "layer_ratios": [float(rr[j].mean()) for j in range(layers)],
            }
        )

    layer_rows: list[dict] = []
    for layer in range(layers):
        layer_rows.append(
            {
                "layer": layer,
                "answer_delta_mean": float(answer[layer].mean()),
                "random_delta_mean": float(random[layer].mean()),
                "ratio_mean": float(ratio[layer].mean()),
                "answer_minus_random_mean": float(
                    (answer[layer] - random[layer]).mean()
                ),
                "edge_score": float(layer_score[layer].mean()),
            }
        )
    return group_rows, layer_rows, layer_score, layer_norm


def draw_token_grid(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    token_strength: np.ndarray,
    group_rows: list[dict],
) -> list[tuple[int, int]]:
    x0, y0, x1, y1 = box
    grid = token_strength.reshape(27, 27)
    norm = quantile_norm(grid, 0.985)
    cell = min((x1 - x0) // 27, (y1 - y0) // 27)
    gx = x0 + ((x1 - x0) - 27 * cell) // 2
    gy = y0 + ((y1 - y0) - 27 * cell) // 2
    for y in range(27):
        for x in range(27):
            v = float(norm[y, x])
            color = mix((13, 24, 34), ORANGE, v)
            if v > 0.72:
                color = mix(color, GOLD, (v - 0.72) / 0.28)
            draw.rectangle(
                (
                    gx + x * cell,
                    gy + y * cell,
                    gx + (x + 1) * cell - 1,
                    gy + (y + 1) * cell - 1,
                ),
                fill=color,
            )
    draw.rectangle(
        (gx - 1, gy - 1, gx + 27 * cell, gy + 27 * cell), outline=(70, 88, 101), width=2
    )

    centers: list[tuple[int, int]] = []
    scores = np.asarray([g["edge_score"] for g in group_rows], dtype=np.float32)
    score_norm = quantile_norm(scores, 0.92)
    for g, s in zip(group_rows, score_norm):
        cx = gx + round((int(g["x0"]) + int(g["x1"])) * 0.5 * cell)
        cy = gy + round((int(g["y0"]) + int(g["y1"])) * 0.5 * cell)
        centers.append((cx, cy))
        rad = round(8 + 19 * float(s))
        draw.ellipse(
            (cx - rad, cy - rad, cx + rad, cy + rad),
            outline=mix(BLUE, GOLD, float(s)),
            width=3,
        )
    return centers


def draw_layer_bands(
    draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], layer_rows: list[dict]
) -> list[tuple[int, int]]:
    x0, y0, x1, y1 = box
    scores = np.asarray([r["edge_score"] for r in layer_rows], dtype=np.float32)
    ratios = np.asarray([r["ratio_mean"] for r in layer_rows], dtype=np.float32)
    score_norm = quantile_norm(scores, 0.96)
    ratio_norm = quantile_norm(ratios, 0.96)
    centers: list[tuple[int, int]] = []
    gap = 7
    h = ((y1 - y0) - gap * (len(layer_rows) - 1)) / len(layer_rows)
    for i, (row, s, rr) in enumerate(zip(layer_rows, score_norm, ratio_norm)):
        yy0 = round(y0 + i * (h + gap))
        yy1 = round(yy0 + h)
        inset = round(26 * (1 - float(s)))
        color = mix((17, 27, 38), GOLD, float(rr) * 0.80)
        outline = mix((54, 71, 83), RED, float(s))
        draw.rounded_rectangle(
            (x0 + inset, yy0, x1 - inset, yy1),
            radius=8,
            fill=color,
            outline=outline,
            width=2,
        )
        draw.text(
            (x0 - 74, yy0 + max(0, (yy1 - yy0 - 18) // 2)),
            f"L{int(row['layer']):02d}",
            fill=mix(MUTED, INK, float(s)),
            font=font(16, True),
        )
        centers.append(((x0 + x1) // 2, (yy0 + yy1) // 2))
    return centers


def render(
    summary: dict,
    answer: np.ndarray,
    random: np.ndarray,
    ratio: np.ndarray,
    result_dir: Path,
    out_dir: Path,
) -> dict:
    group_rows, layer_rows, layer_score, layer_norm = build_metrics(
        answer, random, ratio
    )
    w, h = 2400, 1350
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 18):
        shade = 8 + (y // 18) % 4
        draw.line((0, y, w, y), fill=(shade, shade + 2, shade + 7))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-380, -260, 980, 640), fill=(255, 72, 82, 36))
    gd.ellipse((780, 70, 2320, 1420), fill=(83, 218, 255, 22))
    gd.ellipse((1440, -120, 2760, 860), fill=(255, 199, 74, 26))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(90))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((70, 44), "SNAPCOMPACT CIRCUIT TRACE", fill=GOLD, font=font(25, True))
    draw.text(
        (70, 82),
        "The answer glyphs light a decoder circuit",
        fill=INK,
        font=font(66, True),
    )
    multiline(
        draw,
        (72, 166),
        "Edges are computed from actual hidden-state deltas: max(answer − random, 0) × log(1 + answer/random ratio), averaged by image-token region and decoder layer.",
        fill=MUTED,
        fnt=font(24),
        max_width=1470,
        line_gap=7,
    )

    rounded_panel(draw, (62, 258, 520, 1238))
    rounded_panel(draw, (568, 258, 1002, 1238))
    rounded_panel(draw, (1126, 258, 1632, 1238))
    rounded_panel(draw, (1816, 258, 2338, 1238))

    q = summary["question"]
    base = Image.open(result_dir / "images" / "original.png").convert("RGB")
    masked = Image.open(result_dir / "images" / "answer-mask.png").convert("RGB")
    crop = crop_answer_region(base, summary)
    masked_crop = crop_answer_region(masked, summary)

    draw.text((94, 294), "1. bitmap intervention", fill=INK, font=font(30, True))
    draw.text((94, 334), "question targets one visible year", fill=MUTED, font=font(18))
    draw.rounded_rectangle(
        (94, 386, 488, 560), radius=16, fill=(240, 238, 224), outline=BLUE, width=3
    )
    paste_fit(canvas, crop, (108, 400, 474, 546), resample=Image.Resampling.NEAREST)
    draw.text((94, 574), "original answer region", fill=BLUE, font=font(18, True))
    draw.rounded_rectangle(
        (94, 654, 488, 828), radius=16, fill=(240, 238, 224), outline=RED, width=3
    )
    paste_fit(
        canvas, masked_crop, (108, 668, 474, 814), resample=Image.Resampling.NEAREST
    )
    draw.text((94, 842), "blanked answer mask", fill=RED, font=font(18, True))
    draw.text((94, 930), "question", fill=MUTED, font=font(15, True))
    multiline(
        draw, (94, 956), str(q["q"]), fill=INK, fnt=font(23), max_width=370, line_gap=8
    )
    draw.text((94, 1070), "gold answer", fill=MUTED, font=font(15, True))
    draw.text((94, 1098), str(q["answer_text"]), fill=GOLD, font=font(52, True))
    draw.text(
        (94, 1172),
        f"global Δ ratio {summary['answer_over_random_delta']:.2f}×",
        fill=INK,
        font=font(22, True),
    )

    draw.text((600, 294), "2. image-token regions", fill=INK, font=font(30, True))
    draw.text(
        (600, 334),
        "27×27 token lattice, colored by circuit score",
        fill=MUTED,
        font=font(18),
    )
    token_strength = layer_score.mean(axis=0)
    token_centers = draw_token_grid(
        draw, (616, 392, 954, 730), token_strength, group_rows
    )
    top_groups = sorted(group_rows, key=lambda g: g["edge_score"], reverse=True)[:4]
    draw.text((600, 794), "strongest token groups", fill=MUTED, font=font(16, True))
    y = 826
    group_score_norm = quantile_norm(
        np.asarray([g["edge_score"] for g in group_rows], dtype=np.float32), 0.92
    )
    for g in top_groups:
        s = float(group_score_norm[int(g["id"])])
        draw.rounded_rectangle(
            (600, y, 970, y + 62),
            radius=14,
            fill=PANEL_2,
            outline=mix((44, 58, 68), GOLD, s),
            width=2,
        )
        draw.text((620, y + 12), str(g["name"]), fill=INK, font=font(20, True))
        draw.text(
            (820, y + 12),
            f"{g['ratio_mean']:.2f}×",
            fill=mix(BLUE, GOLD, s),
            font=font(21, True),
        )
        draw.text(
            (620, y + 38),
            f"Δ {g['answer_delta_mean']:.2f} vs {g['random_delta_mean']:.2f}",
            fill=MUTED,
            font=font(14),
        )
        y += 78

    draw.text((1158, 294), "3. decoder layer bands", fill=INK, font=font(30, True))
    draw.text(
        (1158, 334),
        "band width/color follows per-layer answer specificity",
        fill=MUTED,
        font=font(18),
    )
    layer_centers = draw_layer_bands(draw, (1246, 394, 1566, 1122), layer_rows)

    draw.text((1848, 294), "4. output answer", fill=INK, font=font(30, True))
    draw.text(
        (1848, 334), "residual stream converges on text", fill=MUTED, font=font(18)
    )
    draw.rounded_rectangle(
        (1880, 462, 2274, 730),
        radius=34,
        fill=(10, 13, 18),
        outline=(73, 82, 92),
        width=2,
    )
    draw.text((1918, 500), "PaddleOCR-VL", fill=MUTED, font=font(20, True))
    draw.text((1918, 558), "answers", fill=INK, font=font(32, True))
    draw.text((1918, 606), str(q["answer_text"]), fill=GOLD, font=font(82, True))
    draw.rounded_rectangle(
        (1880, 820, 2274, 1034), radius=28, fill=PANEL_2, outline=(47, 62, 73), width=2
    )
    draw.text(
        (1918, 858),
        f"{summary['layers']} decoder layers",
        fill=INK,
        font=font(26, True),
    )
    draw.text(
        (1918, 900),
        f"{summary['image_tokens']} image tokens",
        fill=MUTED,
        font=font(21),
    )
    draw.text(
        (1918, 938), "edge thickness = grouped delta score", fill=MUTED, font=font(21)
    )
    draw.text(
        (1918, 976), "edge color = answer/random ratio", fill=MUTED, font=font(21)
    )

    # Edges live in a transparent layer so glow can sit behind node labels.
    edges = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edges)
    all_group_layer = np.asarray(
        [g["layer_scores"] for g in group_rows], dtype=np.float32
    )
    group_layer_norm = quantile_norm(all_group_layer, 0.965)
    group_layer_ratio = np.asarray(
        [g["layer_ratios"] for g in group_rows], dtype=np.float32
    )
    ratio_norm = quantile_norm(group_layer_ratio, 0.955)

    selected_groups = [
        int(g["id"])
        for g in sorted(group_rows, key=lambda g: g["edge_score"], reverse=True)[:7]
    ]
    selected_layers = [0, 1, 2, 3, 4, 5, 7, 9, 12, 15, 18]
    for gi in selected_groups:
        sx, sy = token_centers[gi]
        for li in selected_layers:
            strength = float(group_layer_norm[gi, li])
            if strength < 0.10:
                continue
            ex, ey = layer_centers[li]
            col = mix(BLUE, RED, float(ratio_norm[gi, li]))
            alpha = round(54 + 156 * strength)
            width = max(1, round(1 + 9 * strength))
            draw_bezier(
                ed,
                ((sx + 18, sy), (1046, sy), (1110, ey), (ex - 162, ey)),
                fill=(*col, alpha),
                width=width,
            )

    layer_edge_norm = quantile_norm(
        np.asarray([r["edge_score"] for r in layer_rows], dtype=np.float32), 0.96
    )
    layer_ratio_norm = quantile_norm(
        np.asarray([r["ratio_mean"] for r in layer_rows], dtype=np.float32), 0.96
    )
    out_anchor = (1880, 596)
    for li in selected_layers:
        sx, sy = layer_centers[li]
        strength = float(layer_edge_norm[li])
        col = mix(GOLD, RED, float(layer_ratio_norm[li]))
        width = max(2, round(2 + 11 * strength))
        alpha = round(76 + 160 * strength)
        draw_bezier(
            ed,
            (
                (sx + 162, sy),
                (1668, sy),
                (1748, out_anchor[1] + (sy - 760) * 0.18),
                out_anchor,
            ),
            fill=(*col, alpha),
            width=width,
        )

    edges = edges.filter(ImageFilter.GaussianBlur(0.18))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), edges).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    # Connector arrows and legend drawn after glowing edges.
    draw.line((520, 748, 568, 748), fill=(70, 84, 96), width=3)
    draw.polygon([(568, 748), (550, 738), (550, 758)], fill=(70, 84, 96))
    draw.line((1002, 748, 1126, 748), fill=(70, 84, 96), width=3)
    draw.polygon([(1126, 748), (1108, 738), (1108, 758)], fill=(70, 84, 96))
    draw.line((1632, 748, 1816, 748), fill=(70, 84, 96), width=3)
    draw.polygon([(1816, 748), (1798, 738), (1798, 758)], fill=(70, 84, 96))

    legend_x, legend_y = 590, 1168
    draw.text((legend_x, legend_y), "edge encoding", fill=INK, font=font(18, True))
    for i, (lab, val, col) in enumerate(
        [("weak", 0.20, BLUE), ("medium", 0.55, GOLD), ("answer-specific", 0.95, RED)]
    ):
        yy = legend_y + 38 + i * 32
        draw.line(
            (legend_x, yy, legend_x + 122, yy), fill=col, width=round(2 + 9 * val)
        )
        draw.text(
            (legend_x + 146, yy - 12), lab, fill=MUTED if i < 2 else INK, font=font(16)
        )

    draw.text(
        (1158, 1164),
        "Data: heatmaps.npz answer_delta, random_delta, ratio. No schematic edges: every width/color is grouped from observed tensors.",
        fill=MUTED,
        font=font(17),
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    out_png = out_dir / "circuit.png"
    canvas.save(out_png, optimize=True)

    source = {
        "question": q,
        "layers": summary["layers"],
        "image_tokens": summary["image_tokens"],
        "global_answer_over_random_delta": summary["answer_over_random_delta"],
        "edge_formula": "max(answer_delta - random_delta, 0) * log1p(ratio)",
        "token_groups": group_rows,
        "layers_metrics": layer_rows,
        "selected_token_groups": selected_groups,
        "selected_layers": selected_layers,
    }
    (out_dir / "circuit-source-data.json").write_text(json.dumps(source, indent=2))
    return {"png": str(out_png), "source": str(out_dir / "circuit-source-data.json")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result-dir", default=str(DEFAULT_RESULT_DIR))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    args = ap.parse_args()

    result_dir = Path(args.result_dir)
    out_dir = Path(args.out_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "heatmaps.npz")
    paths = render(
        summary,
        data["answer_delta"],
        data["random_delta"],
        data["ratio"],
        result_dir,
        out_dir,
    )
    print(paths["png"])


if __name__ == "__main__":
    main()
