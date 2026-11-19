# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy", "pillow"]
# ///
"""Render an Activation Atlas-style 2D geography from snapcompact activations."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap, Normalize
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
DEFAULT_OUT_DIR = HERE / "results" / "agent-viz-atlas"

BG = (4, 7, 12)
PANEL = (10, 15, 23)
INK = (241, 239, 224)
MUTED = (139, 151, 160)
CYAN = (70, 216, 255)
RED = (255, 75, 61)
AMBER = (255, 198, 68)
GREEN = (135, 255, 139)
PURPLE = (183, 108, 255)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Avenir Next Condensed.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def quantile_norm(x: np.ndarray, lo_q: float = 0.02, hi_q: float = 0.985) -> np.ndarray:
    lo = float(np.quantile(x, lo_q))
    hi = float(np.quantile(x, hi_q))
    if hi <= lo:
        return np.zeros_like(x, dtype=np.float32)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def pca2(features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x = features.astype(np.float64, copy=True)
    x -= x.mean(axis=0, keepdims=True)
    scale = x.std(axis=0, keepdims=True)
    scale[scale < 1e-9] = 1.0
    x /= scale
    _u, s, vt = np.linalg.svd(x, full_matrices=False)
    coords = x @ vt[:2].T
    explained = (s[:2] ** 2) / np.maximum(np.sum(s**2), 1e-12)
    return coords.astype(np.float32), explained.astype(np.float32)


def normalize_coords(coords: np.ndarray) -> np.ndarray:
    out = coords.copy()
    for axis in range(2):
        lo = float(np.quantile(out[:, axis], 0.01))
        hi = float(np.quantile(out[:, axis], 0.99))
        if hi <= lo:
            out[:, axis] = 0.5
        else:
            out[:, axis] = np.clip((out[:, axis] - lo) / (hi - lo), 0, 1)
    out[:, 1] = 1.0 - out[:, 1]
    return out


def kmeans(
    points: np.ndarray, k: int = 5, iters: int = 32
) -> tuple[np.ndarray, np.ndarray]:
    # Deterministic farthest-point seeding avoids random output drift.
    centers = [points[np.argmax(points[:, 0] + points[:, 1])]]
    for _ in range(1, k):
        dist = np.min(
            np.sum((points[:, None, :] - np.asarray(centers)[None, :, :]) ** 2, axis=2),
            axis=1,
        )
        centers.append(points[int(np.argmax(dist))])
    c = np.asarray(centers, dtype=np.float32)
    labels = np.zeros(points.shape[0], dtype=np.int32)
    for _ in range(iters):
        d = np.sum((points[:, None, :] - c[None, :, :]) ** 2, axis=2)
        new_labels = np.argmin(d, axis=1).astype(np.int32)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for i in range(k):
            mask = labels == i
            if np.any(mask):
                c[i] = points[mask].mean(axis=0)
    return labels, c


def crop_answer_strip(
    img: Image.Image, start: int, end: int, cols: int, adv: int = 8, pitch: int = 13
) -> Image.Image:
    row0 = max(0, start // cols - 4)
    row1 = min(img.height // pitch, end // cols + 5)
    col0 = max(0, start % cols - 32)
    col1 = min(cols, end % cols + 34)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 2)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 2)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=4, outline=RED, width=3)
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
    canvas.paste(
        resized,
        (x0 + (x1 - x0 - resized.width) // 2, y0 + (y1 - y0 - resized.height) // 2),
    )


def render_atlas_panel(
    points: np.ndarray,
    labels: np.ndarray,
    centers: np.ndarray,
    ratio_strength: np.ndarray,
    answer_strength: np.ndarray,
    peak_layers: np.ndarray,
    explained: np.ndarray,
    summary: dict,
    out_dir: Path,
) -> Image.Image:
    cmap = LinearSegmentedColormap.from_list(
        "scar", ["#182132", "#245d7a", "#48d8ff", "#ffd04e", "#ff493d"]
    )
    fig = plt.figure(figsize=(15.8, 10.6), dpi=170)
    fig.patch.set_facecolor("#04070c")
    ax = fig.add_axes((0.045, 0.06, 0.91, 0.88), facecolor="#07101a")

    x = points[:, 0]
    y = points[:, 1]
    hb = ax.hexbin(
        x,
        y,
        C=ratio_strength,
        gridsize=46,
        reduce_C_function=np.mean,
        cmap=cmap,
        mincnt=1,
        linewidths=0,
        alpha=0.64,
    )
    hb.set_clim(0.0, 1.0)

    cluster_colors = ["#46d8ff", "#ff4b3d", "#ffc644", "#87ff8b", "#b76cff"]
    for i, color in enumerate(cluster_colors):
        mask = labels == i
        if np.count_nonzero(mask) < 4:
            continue
        ax.scatter(
            x[mask],
            y[mask],
            s=28 + answer_strength[mask] * 150,
            c=color,
            alpha=0.24,
            linewidths=0,
        )
        ax.scatter(
            x[mask],
            y[mask],
            s=10 + answer_strength[mask] * 52,
            c=ratio_strength[mask],
            cmap=cmap,
            norm=Normalize(0, 1),
            alpha=0.93,
            edgecolors=color,
            linewidths=0.45,
        )

    hot = np.argsort(ratio_strength + answer_strength * 0.55)[-9:]
    ax.scatter(
        x[hot],
        y[hot],
        s=210,
        facecolors="none",
        edgecolors="#fff0a8",
        linewidths=1.5,
        alpha=0.95,
    )
    for rank, idx in enumerate(hot[-5:][::-1], 1):
        ax.text(
            x[idx] + 0.012,
            y[idx] + 0.010,
            f"T{idx} · L{int(peak_layers[idx])}",
            color="#fff3b0",
            fontsize=8,
            weight="bold",
            path_effects=[pe.withStroke(linewidth=2.5, foreground="#05070a")],
        )

    names = [
        "answer ridge",
        "control basin",
        "early glyph shore",
        "late-context upland",
        "ratio reef",
    ]
    cluster_scores = []
    for i in range(len(centers)):
        mask = labels == i
        cluster_scores.append(
            (float(ratio_strength[mask].mean()) if np.any(mask) else 0.0, i)
        )
    order = {
        old: new
        for new, (_score, old) in enumerate(sorted(cluster_scores, reverse=True))
    }
    for i, c in enumerate(centers):
        mask = labels == i
        if np.count_nonzero(mask) < 5:
            continue
        label = names[order[i] % len(names)]
        ax.text(
            c[0],
            c[1],
            label.upper(),
            color=cluster_colors[i],
            fontsize=11,
            weight="bold",
            ha="center",
            va="center",
            alpha=0.96,
            path_effects=[pe.withStroke(linewidth=4, foreground="#05070a")],
        )

    ax.text(
        0.015,
        0.982,
        "Activation Atlas projection",
        transform=ax.transAxes,
        color="#f1efe0",
        fontsize=24,
        weight="bold",
        va="top",
    )
    ax.text(
        0.017,
        0.942,
        "Each island is one image token; geography = PCA of 19-layer answer-vs-random activation delta vectors.",
        transform=ax.transAxes,
        color="#8b97a0",
        fontsize=11,
        va="top",
    )
    ax.text(
        0.017,
        0.905,
        f"Question: {summary['question']['q']}  ·  gold answer: {summary['question']['answer_text']}  ·  answer/random mean Δ {summary['answer_over_random_delta']:.2f}×",
        transform=ax.transAxes,
        color="#ffc644",
        fontsize=10,
        weight="bold",
        va="top",
    )
    ax.text(
        0.99,
        0.02,
        f"PCA variance: PC1 {explained[0] * 100:.1f}% · PC2 {explained[1] * 100:.1f}%    color: answer/random scar    size: answer-mask Δ    labels: peak layer depth",
        transform=ax.transAxes,
        color="#8b97a0",
        fontsize=9,
        ha="right",
        va="bottom",
    )

    cax = fig.add_axes((0.83, 0.865, 0.12, 0.014))
    cb = fig.colorbar(hb, cax=cax, orientation="horizontal")
    cb.outline.set_visible(False)
    cb.set_ticks([0, 1])
    cb.set_ticklabels(["random-like", "answer scar"])
    cb.ax.tick_params(colors="#cfd6d0", labelsize=8, length=0)
    cax.set_facecolor("#07101a")

    for spine in ax.spines.values():
        spine.set_color("#223140")
        spine.set_linewidth(1.0)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_xlim(-0.04, 1.04)
    ax.set_ylim(-0.04, 1.04)
    ax.grid(color="#2d4255", alpha=0.14, linewidth=0.7)

    tmp = out_dir / ".atlas-panel.png"
    fig.savefig(tmp, facecolor=fig.get_facecolor(), transparent=False)
    plt.close(fig)
    img = Image.open(tmp).convert("RGB")
    tmp.unlink(missing_ok=True)
    return img


def draw_shell(panel: Image.Image, summary: dict, data_dir: Path, out: Path) -> None:
    w, h = 2400, 1500
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 18):
        draw.line((0, y, w, y), fill=(6, 10 + y % 11, 16 + y % 9))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-360, -240, 1000, 760), fill=(70, 216, 255, 32))
    gd.ellipse((1270, 210, 2740, 1610), fill=(255, 75, 61, 32))
    gd.ellipse((690, 920, 1740, 1780), fill=(255, 198, 68, 18))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(90))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((74, 48), "SNAPCOMPACT WHITEBOX", fill=AMBER, font=font(24, True))
    draw.text(
        (74, 88),
        "Activation Atlas of the missing answer",
        fill=INK,
        font=font(72, True),
    )
    draw.text(
        (78, 178),
        "A PCA geography of image-token residual scars: where blanking the gold answer ‘2003’ moves the model differently than a random blank.",
        fill=MUTED,
        font=font(27),
    )

    draw.rounded_rectangle(
        (74, 252, 590, 1390), radius=32, fill=PANEL, outline=(32, 45, 58), width=1
    )
    q = summary["question"]
    cols = summary["geometry"]["cols"]
    original = Image.open(data_dir / "images" / "original.png").convert("RGB")
    answer_mask = Image.open(data_dir / "images" / "answer-mask.png").convert("RGB")
    random_mask = Image.open(data_dir / "images" / "random-mask.png").convert("RGB")
    strips = [
        ("ORIGINAL", original, CYAN),
        ("ANSWER MASK", answer_mask, RED),
        ("RANDOM MASK", random_mask, GREEN),
    ]
    y = 314
    for title, img, color in strips:
        draw.text((110, y), title, fill=color, font=font(18, True))
        draw.rounded_rectangle(
            (110, y + 28, 554, y + 166),
            radius=16,
            fill=(242, 241, 229),
            outline=color,
            width=3,
        )
        paste_fit(
            canvas,
            crop_answer_strip(img, q["answer_start"], q["answer_end"], cols),
            (124, y + 42, 540, y + 152),
        )
        y += 226

    draw.rounded_rectangle(
        (110, 1002, 554, 1300),
        radius=24,
        fill=(7, 11, 18),
        outline=(35, 51, 66),
        width=1,
    )
    metrics = [
        ("answer", q["answer_text"], AMBER, 48),
        ("layers", str(summary["layers"]), CYAN, 38),
        ("image tokens", str(summary["image_tokens"]), GREEN, 38),
        ("answer/random Δ", f"{summary['answer_over_random_delta']:.2f}×", RED, 38),
    ]
    yy = 1038
    for label, value, color, size in metrics:
        draw.text((142, yy), label, fill=MUTED, font=font(16, True))
        draw.text((142, yy + 26), value, fill=color, font=font(size, True))
        yy += 68
    draw.text(
        (110, 1336),
        "Actual heatmaps.npz + summary.json; no schematic points.",
        fill=MUTED,
        font=font(18),
    )

    draw.rounded_rectangle(
        (622, 252, 2326, 1390), radius=32, fill=PANEL, outline=(32, 45, 58), width=1
    )
    panel = panel.resize((1640, 1098), Image.Resampling.LANCZOS)
    canvas.paste(panel, (654, 272))

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, quality=95)


def write_source_data(
    out_dir: Path,
    points: np.ndarray,
    labels: np.ndarray,
    ratio_strength: np.ndarray,
    answer_strength: np.ndarray,
    peak_layers: np.ndarray,
    explained: np.ndarray,
) -> None:
    np.savez_compressed(
        out_dir / "atlas_source.npz",
        points=points,
        cluster=labels,
        ratio_strength=ratio_strength,
        answer_strength=answer_strength,
        peak_layer=peak_layers,
        pca_explained=explained,
    )
    with (out_dir / "atlas_points.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "token",
                "atlas_x",
                "atlas_y",
                "cluster",
                "ratio_strength",
                "answer_strength",
                "peak_layer",
            ]
        )
        for i in range(points.shape[0]):
            writer.writerow(
                [
                    i,
                    f"{points[i, 0]:.6f}",
                    f"{points[i, 1]:.6f}",
                    int(labels[i]),
                    f"{ratio_strength[i]:.6f}",
                    f"{answer_strength[i]:.6f}",
                    int(peak_layers[i]),
                ]
            )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = json.loads((data_dir / "summary.json").read_text())
    heatmaps = np.load(data_dir / "heatmaps.npz")
    answer = heatmaps["answer_delta"].astype(np.float32)
    random = heatmaps["random_delta"].astype(np.float32)
    ratio = heatmaps["ratio"].astype(np.float32)

    contrast = np.log1p(answer) - np.log1p(random)
    features = np.concatenate(
        [contrast.T, np.log1p(ratio).T, np.log1p(answer).T], axis=1
    )
    raw_coords, explained = pca2(features)
    points = normalize_coords(raw_coords)
    labels, centers = kmeans(points, k=5)

    ratio_strength = quantile_norm(np.log1p(ratio).mean(axis=0), 0.02, 0.99)
    answer_strength = quantile_norm(np.log1p(answer).mean(axis=0), 0.02, 0.99)
    peak_layers = np.argmax(ratio, axis=0).astype(np.int32)

    write_source_data(
        out_dir, points, labels, ratio_strength, answer_strength, peak_layers, explained
    )
    panel = render_atlas_panel(
        points,
        labels,
        centers,
        ratio_strength,
        answer_strength,
        peak_layers,
        explained,
        summary,
        out_dir,
    )
    out = out_dir / "atlas.png"
    draw_shell(panel, summary, data_dir, out)
    print(out)


if __name__ == "__main__":
    main()
