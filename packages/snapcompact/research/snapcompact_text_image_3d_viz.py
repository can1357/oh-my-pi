# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy", "pillow"]
# ///
"""Render a 3D text-vs-image activation comparison from paired carrier data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import cm
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
BG = (5, 7, 10)
PANEL = (12, 17, 23)
INK = (241, 239, 224)
MUTED = (143, 154, 160)
CYAN = (75, 220, 255)
ORANGE = (255, 112, 72)
AMBER = (255, 196, 68)
GREEN = (148, 255, 117)


def font(size: int, bold: bool = False):
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


def mono(size: int):
    for path in [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


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


def normalize(arr: np.ndarray) -> np.ndarray:
    lo = float(np.quantile(arr, 0.03))
    hi = float(np.quantile(arr, 0.985))
    if hi <= lo:
        hi = lo + 1e-6
    return np.clip((arr - lo) / (hi - lo), 0, 1)


def render_surface(z: np.ndarray, answer_bins: list[int]) -> Image.Image:
    fig = plt.figure(figsize=(14.5, 8.2), dpi=180)
    fig.patch.set_facecolor("#05070a")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor((0.02, 0.025, 0.035, 1))
    y = np.arange(z.shape[0])
    x = np.arange(z.shape[1])
    X, Y = np.meshgrid(x, y)
    cmap = plt.colormaps["turbo"]
    ax.plot_surface(
        X,
        Y,
        z,
        facecolors=cmap(z),
        linewidth=0,
        antialiased=True,
        shade=False,
        alpha=0.98,
    )
    ax.contour(
        X,
        Y,
        z,
        zdir="z",
        offset=-0.08,
        levels=12,
        cmap=cmap,
        linewidths=0.9,
        alpha=0.75,
    )
    for b in answer_bins:
        if 0 <= b < z.shape[1]:
            ax.plot(
                [b, b],
                [0, z.shape[0] - 1],
                [1.08, 1.08],
                color="#ff7048",
                linewidth=2.6,
                alpha=0.78,
            )
            ax.plot(
                [b, b],
                [0, z.shape[0] - 1],
                [-0.06, -0.06],
                color="#ff7048",
                linewidth=1.6,
                alpha=0.55,
            )
    ax.view_init(elev=32, azim=-58)
    ax.set_box_aspect((3.2, 0.8, 0.72))
    ax.set_zlim(-0.08, 1.08)
    ax.set_ylim(z.shape[0] - 1, 0)
    ax.set_xlabel("image-token bins", color="#8f9aa0", labelpad=10)
    ax.set_ylabel("decoder layer", color="#8f9aa0", labelpad=10)
    ax.set_zlabel("excess cosine", color="#8f9aa0", labelpad=8)
    ax.tick_params(colors="#8f9aa0", labelsize=8)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor((0.02, 0.025, 0.035, 0.0))
        axis._axinfo["grid"]["color"] = (0.35, 0.45, 0.50, 0.18)
    ax.set_title(
        "text-answer vector ↔ image-token field",
        color="#efeede",
        fontsize=24,
        fontweight="bold",
        loc="left",
        pad=18,
    )
    tmp = HERE / "results" / ".text-image-3d-panel.png"
    fig.savefig(tmp, facecolor=fig.get_facecolor(), transparent=False)
    plt.close(fig)
    img = Image.open(tmp).convert("RGB")
    tmp.unlink(missing_ok=True)
    return img


def crop_answer(
    img: Image.Image, q: dict, cols: int, adv: int = 8, pitch: int = 13
) -> Image.Image:
    start = q["answer_start"]
    end = q["answer_end"]
    row0 = max(0, start // cols - 5)
    row1 = min(img.height // pitch, end // cols + 6)
    col0 = max(0, start % cols - 34)
    col1 = min(cols, end % cols + 34)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=3, outline=ORANGE, width=3)
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir",
        default=str(HERE / "results" / "text-image-compare-paddleocr-q7"),
    )
    ap.add_argument(
        "--out",
        default=str(
            HERE
            / "results"
            / "text-image-compare-paddleocr-q7"
            / "text-vs-image-3d.png"
        ),
    )
    ap.add_argument("--bins", type=int, default=150)
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "text_image_compare.npz")
    raw = (
        data["text_answer_to_image_excess"]
        if "text_answer_to_image_excess" in data
        else data["text_answer_to_image_cosine"]
    )
    z = normalize(downsample(raw, args.bins))
    token_count = summary["image_tokens"]
    answer_bins = sorted(
        {
            round(idx / max(1, token_count - 1) * (args.bins - 1))
            for idx in summary["image_answer_token_indices"]
        }
    )
    panel = render_surface(z, answer_bins)

    w, h = 2200, 1320
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -220, 860, 680), fill=(75, 220, 255, 30))
    gd.ellipse((1160, 80, 2440, 1320), fill=(255, 112, 72, 28))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(84))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    q = summary["question"]
    draw.text((64, 42), "TEXT ↔ IMAGE WHITEBOX", fill=AMBER, font=font(24, True))
    draw.text(
        (64, 84),
        "Same input, different carrier, shared hidden space",
        fill=INK,
        font=font(61, True),
    )
    draw.text(
        (66, 166),
        "For every decoder layer, compare the raw-text answer state against all bitmap image-token states. Peaks = image regions whose hidden state becomes text-like.",
        fill=MUTED,
        font=font(24),
    )

    draw.rounded_rectangle(
        (64, 238, 618, 1234), radius=30, fill=PANEL, outline=(35, 49, 59), width=1
    )
    draw.text((96, 270), "two carriers", fill=INK, font=font(34, True))
    draw.text((96, 312), "same chunk + same question", fill=MUTED, font=font(18))
    draw.text((96, 366), "RAW TEXT", fill=CYAN, font=font(18, True))
    y = 402
    draw.text((96, y), "Question:", fill=MUTED, font=font(17, True))
    y += 30
    for line in [q["q"][i : i + 46] for i in range(0, len(q["q"]), 46)]:
        draw.text((96, y), line, fill=INK, font=font(19))
        y += 26
    y += 24
    draw.text((96, y), "Gold answer token span:", fill=MUTED, font=font(17, True))
    y += 32
    answer_text = str(q["answer_text"])
    draw.rounded_rectangle(
        (96, y, 108 + max(72, len(answer_text) * 24), y + 40), radius=7, fill=AMBER
    )
    draw.text((108, y + 7), answer_text, fill=(5, 7, 10), font=mono(22))
    y += 66
    draw.text((96, y), "The raw-text run receives the same", fill=INK, font=font(18))
    draw.text(
        (96, y + 28), "SQuAD passage as ordinary tokens;", fill=INK, font=font(18)
    )
    draw.text(
        (96, y + 56), "the image run receives the passage", fill=INK, font=font(18)
    )
    draw.text((96, y + 84), "only through the bitmap carrier.", fill=INK, font=font(18))
    draw.text(
        (96, 674),
        f"text reference: {summary['text_reference_tokens']} tokens",
        fill=MUTED,
        font=font(18),
    )
    draw.text(
        (96, 704),
        f"answer span: {summary['text_answer_tokens']} text tokens",
        fill=MUTED,
        font=font(18),
    )

    draw.text((96, 774), "SNAPCOMPACT IMAGE", fill=ORANGE, font=font(18, True))
    img = Image.open(result_dir / "images" / "image-carrier.png").convert("RGB")
    crop = crop_answer(img, q, summary["geometry"]["cols"])
    draw.rounded_rectangle(
        (96, 812, 586, 1052), radius=16, fill=(244, 242, 230), outline=ORANGE, width=3
    )
    paste_fit(canvas, crop, (112, 828, 570, 1036))
    draw.text(
        (96, 1092),
        f"image field: {summary['image_tokens']} tokens ({summary['image_grid']}×{summary['image_grid']})",
        fill=MUTED,
        font=font(18),
    )
    draw.text(
        (96, 1138),
        f"peak alignment: {summary['answer_region_cosine_max']:.3f} @ layer {summary['answer_region_cosine_argmax']}",
        fill=AMBER,
        font=font(22, True),
    )
    draw.text(
        (96, 1172),
        f"final alignment: {summary['answer_region_cosine_final']:.3f}",
        fill=MUTED,
        font=font(19),
    )

    draw.rounded_rectangle(
        (650, 238, 2134, 1234), radius=30, fill=PANEL, outline=(35, 49, 59), width=1
    )
    draw.text(
        (686, 270), "3D cross-carrier resonance terrain", fill=INK, font=font(36, True)
    )
    draw.text(
        (686, 314),
        "z-axis = excess cosine after subtracting each layer's median image-token similarity; orange rails mark the bitmap answer region",
        fill=MUTED,
        font=font(20),
    )
    panel = panel.resize((1408, 794), Image.Resampling.LANCZOS)
    canvas.paste(panel, (692, 378))
    cmap = plt.colormaps["turbo"]
    for i in range(280):
        rgb = tuple(int(v * 255) for v in cmap(i / 279)[:3])
        draw.rectangle((1790 + i, 282, 1791 + i, 300), fill=rgb)
    draw.text((1790, 254), "low excess", fill=MUTED, font=font(14))
    draw.text((1992, 254), "high excess", fill=MUTED, font=font(14))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
