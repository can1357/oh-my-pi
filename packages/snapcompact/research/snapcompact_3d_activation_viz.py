# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy", "pillow"]
# ///
"""Render a 3D blog visualization of snapcompact hidden-state deltas."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import cm
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent

BG = (5, 7, 10)
PANEL = (13, 18, 23)
INK = (241, 239, 224)
MUTED = (139, 151, 156)
CYAN = (80, 220, 255)
RED = (255, 83, 62)
GREEN = (145, 255, 112)
AMBER = (255, 194, 65)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def norm_quantile(arr: np.ndarray, q: float = 0.985) -> np.ndarray:
    scale = float(np.quantile(arr, q))
    if scale <= 0:
        scale = 1.0
    return np.clip(arr / scale, 0, 1)


def downsample(arr: np.ndarray, cols: int) -> np.ndarray:
    if arr.shape[1] <= cols:
        return arr
    edges = np.linspace(0, arr.shape[1], cols + 1).round().astype(int)
    out = np.zeros((arr.shape[0], cols), dtype=np.float32)
    for i in range(cols):
        lo = edges[i]
        hi = max(lo + 1, edges[i + 1])
        out[:, i] = arr[:, lo:hi].mean(axis=1)
    return out


def style_3d(ax, title: str, subtitle: str, color: str) -> None:
    ax.set_facecolor((0.02, 0.025, 0.035, 1))
    ax.xaxis.pane.set_facecolor((0.02, 0.025, 0.035, 0.0))
    ax.yaxis.pane.set_facecolor((0.02, 0.025, 0.035, 0.0))
    ax.zaxis.pane.set_facecolor((0.02, 0.025, 0.035, 0.0))
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis._axinfo["grid"]["color"] = (0.28, 0.34, 0.38, 0.20)
        axis._axinfo["tick"]["color"] = (0.80, 0.84, 0.84, 0.55)
    ax.tick_params(colors="#8b979c", labelsize=8, pad=0)
    ax.set_xlabel("image-token bins", color="#8b979c", labelpad=6)
    ax.set_ylabel("decoder layer", color="#8b979c", labelpad=6)
    ax.set_zlabel("Δ hidden", color="#8b979c", labelpad=5)
    ax.set_title(title, color=color, fontsize=16, fontweight="bold", loc="left", pad=10)
    ax.text2D(0.0, 0.94, subtitle, transform=ax.transAxes, color="#8b979c", fontsize=9)
    ax.view_init(elev=31, azim=-58)
    ax.set_box_aspect((2.7, 0.85, 0.55))


def draw_surface(
    ax,
    arr: np.ndarray,
    cmap_name: str,
    title: str,
    subtitle: str,
    color: str,
    zmax: float = 1.0,
) -> None:
    y = np.arange(arr.shape[0])
    x = np.arange(arr.shape[1])
    X, Y = np.meshgrid(x, y)
    Z = arr * zmax
    cmap = cm.get_cmap(cmap_name)
    ax.plot_surface(
        X,
        Y,
        Z,
        rstride=1,
        cstride=1,
        facecolors=cmap(arr),
        linewidth=0,
        antialiased=True,
        shade=False,
        alpha=0.98,
    )
    # A dark floor with projected contour lines makes the shape read as 3D.
    ax.contour(
        X, Y, Z, zdir="z", offset=-0.05, levels=9, cmap=cmap, linewidths=0.8, alpha=0.72
    )
    ax.set_zlim(-0.05, zmax)
    ax.set_ylim(arr.shape[0] - 1, 0)
    style_3d(ax, title, subtitle, color)


def crop_with_box(
    img: Image.Image,
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    pad_cells: int = 34,
) -> Image.Image:
    row0 = max(0, start // cols - 5)
    row1 = min(img.height // pitch, end // cols + 6)
    col0 = max(0, start % cols - pad_cells)
    col1 = min(cols, end % cols + pad_cells)
    if col1 <= col0:
        col1 = min(cols, col0 + 72)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=3, outline=RED, width=3)
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


def render_matplotlib_panel(
    answer: np.ndarray, random: np.ndarray, ratio: np.ndarray
) -> Image.Image:
    fig = plt.figure(figsize=(16.6, 9.0), dpi=170)
    fig.patch.set_facecolor("#05070a")
    gs = fig.add_gridspec(
        2, 2, left=0.02, right=0.99, top=0.96, bottom=0.04, wspace=0.03, hspace=0.08
    )
    ax1 = fig.add_subplot(gs[0, 0], projection="3d")
    ax2 = fig.add_subplot(gs[0, 1], projection="3d")
    ax3 = fig.add_subplot(gs[1, :], projection="3d")
    draw_surface(
        ax1, answer, "magma", "Gold answer mask", "true answer cells erased", "#ff533e"
    )
    draw_surface(
        ax2,
        random,
        "viridis",
        "Random control mask",
        "same-sized blank elsewhere",
        "#91ff70",
    )
    draw_surface(
        ax3,
        ratio,
        "inferno",
        "Answer / random ratio",
        "where the missing answer leaves a larger residual-stream scar",
        "#ffc241",
        zmax=1.08,
    )
    tmp = HERE / "results" / ".snapcompact-3d-panel.png"
    fig.savefig(tmp, facecolor=fig.get_facecolor(), transparent=False)
    plt.close(fig)
    img = Image.open(tmp).convert("RGB")
    tmp.unlink(missing_ok=True)
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "tensor-heatmap-paddleocr-q7")
    )
    ap.add_argument(
        "--out", default=str(HERE / "results" / "snapcompact-3d-activation-terrain.png")
    )
    ap.add_argument("--bins", type=int, default=128)
    args = ap.parse_args()

    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "heatmaps.npz")
    answer = norm_quantile(downsample(data["answer_binned"], args.bins))
    random = norm_quantile(downsample(data["random_binned"], args.bins))
    ratio = norm_quantile(downsample(data["ratio_binned"], args.bins), 0.97)

    panel = render_matplotlib_panel(answer, random, ratio)
    w, h = 2200, 1320
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(8, 10 + y % 10, 14 + y % 12))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -160, 950, 600), fill=(255, 83, 62, 34))
    gd.ellipse((1100, 220, 2500, 1500), fill=(80, 220, 255, 28))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(82))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text((64, 42), "SNAPCOMPACT WHITEBOX", fill=AMBER, font=font(24, True))
    draw.text(
        (64, 82),
        "Activation terrain from a missing answer",
        fill=INK,
        font=font(68, True),
    )
    draw.text(
        (66, 168),
        "Actual decoder hidden states: layer × image-token bin × ||original − masked||. A blog-friendly 3D tensor slice, not a schematic.",
        fill=MUTED,
        font=font(26),
    )

    # Left evidence strip.
    draw.rounded_rectangle(
        (64, 238, 600, 1234), radius=30, fill=PANEL, outline=(31, 42, 50), width=1
    )
    q = summary["question"]
    draw.text((96, 270), "visual intervention", fill=INK, font=font(32, True))
    draw.text((96, 310), "answer cells are blanked", fill=MUTED, font=font(18))
    base = Image.open(result_dir / "images" / "original.png").convert("RGB")
    masked = Image.open(result_dir / "images" / "answer-mask.png").convert("RGB")
    cols = summary["geometry"]["cols"]
    crop = crop_with_box(base, q["answer_start"], q["answer_end"], cols, 8, 13)
    masked_crop = crop_with_box(masked, q["answer_start"], q["answer_end"], cols, 8, 13)
    draw.text((96, 366), "ORIGINAL", fill=CYAN, font=font(17, True))
    draw.rounded_rectangle(
        (96, 394, 568, 560), radius=14, fill=(244, 242, 230), outline=CYAN, width=3
    )
    paste_fit(canvas, crop, (112, 410, 552, 544))
    draw.text((96, 618), "ANSWER ERASED", fill=RED, font=font(17, True))
    draw.rounded_rectangle(
        (96, 646, 568, 812), radius=14, fill=(244, 242, 230), outline=RED, width=3
    )
    paste_fit(canvas, masked_crop, (112, 662, 552, 796))
    question = q["q"]
    if len(question) > 54:
        question = question[:51] + "…"
    draw.text((96, 890), "question", fill=MUTED, font=font(16, True))
    draw.text((96, 920), question, fill=INK, font=font(22))
    draw.text((96, 990), "gold answer", fill=MUTED, font=font(16, True))
    draw.text((96, 1024), str(q["answer_text"]), fill=AMBER, font=font(42, True))
    draw.text((96, 1110), f"{summary['layers']} layers", fill=MUTED, font=font(20))
    draw.text(
        (96, 1142), f"{summary['image_tokens']} image tokens", fill=MUTED, font=font(20)
    )
    draw.text(
        (96, 1174),
        f"answer/random Δ = {summary['answer_over_random_delta']:.2f}×",
        fill=INK,
        font=font(22, True),
    )

    # Main 3D panel.
    draw.rounded_rectangle(
        (632, 238, 2134, 1234), radius=30, fill=PANEL, outline=(31, 42, 50), width=1
    )
    panel = panel.resize((1450, 786), Image.Resampling.LANCZOS)
    canvas.paste(panel, (660, 330))
    draw.text(
        (672, 268), "3D residual-stream delta terrain", fill=INK, font=font(36, True)
    )
    draw.text(
        (672, 311),
        "Gold-mask spikes rise where the model’s image-token activations react to losing the answer glyphs.",
        fill=MUTED,
        font=font(20),
    )

    # Color scale.
    cmap = cm.get_cmap("magma")
    for i in range(260):
        rgb = tuple(int(v * 255) for v in cmap(i / 259)[:3])
        draw.rectangle((1810 + i, 274, 1811 + i, 292), fill=rgb)
    draw.text((1810, 246), "low Δ", fill=MUTED, font=font(14))
    draw.text((2018, 246), "high Δ", fill=MUTED, font=font(14))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
