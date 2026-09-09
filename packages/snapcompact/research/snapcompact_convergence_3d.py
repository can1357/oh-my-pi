# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy", "pillow"]
# ///
"""3D convergence strands: text and image trajectories fusing through depth."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
BG = (5, 7, 10)
PANEL = (12, 17, 23)
INK = (241, 239, 224)
MUTED = (143, 154, 160)
AMBER = (255, 196, 68)
CYAN = (75, 220, 255)
ORANGE = (255, 112, 72)


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


def question_hue(i: int, n: int) -> tuple[float, float, float]:
    h = i / n
    r = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.00))
    g = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.33))
    b = 0.5 + 0.5 * math.cos(2 * math.pi * (h + 0.67))
    return (0.28 + 0.72 * r, 0.28 + 0.72 * g, 0.28 + 0.72 * b)


def center(arr: np.ndarray) -> np.ndarray:
    return arr - arr.mean(axis=0, keepdims=True)


def smooth_path(path: np.ndarray, passes: int = 2) -> np.ndarray:
    out = path.copy()
    for _ in range(passes):
        mid = (out[:-2] + out[1:-1] * 2 + out[2:]) / 4
        out[1:-1] = mid
    return out


def render_strands(
    text_arr: np.ndarray, image_arr: np.ndarray, best_layer: int
) -> Image.Image:
    n_q, n_layers, _ = text_arr.shape
    ref = np.concatenate(
        [center(text_arr[:, best_layer, :]), center(image_arr[:, best_layer, :])],
        axis=0,
    )
    _, _, vt = np.linalg.svd(ref, full_matrices=False)
    basis = vt[:2].T

    # Per-layer projections, per-layer scale normalization so depth shows shape,
    # not raw norm growth across layers.
    t_proj = np.zeros((n_q, n_layers, 2), dtype=np.float64)
    i_proj = np.zeros((n_q, n_layers, 2), dtype=np.float64)
    for layer in range(n_layers):
        t = center(text_arr[:, layer, :]) @ basis
        i = center(image_arr[:, layer, :]) @ basis
        scale = max(1e-6, float(np.abs(np.concatenate([t, i], axis=0)).max()))
        t_proj[:, layer] = t / scale
        i_proj[:, layer] = i / scale

    fig = plt.figure(figsize=(15.2, 9.4), dpi=170)
    fig.patch.set_facecolor("#05070a")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor((0.02, 0.025, 0.035, 1))
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor((0.02, 0.025, 0.035, 0.0))
        axis._axinfo["grid"]["color"] = (0.32, 0.42, 0.48, 0.16)
    ax.tick_params(colors="#8f9aa0", labelsize=8)

    layers_axis = np.arange(n_layers)
    for qi in range(n_q):
        color = question_hue(qi, n_q)
        tp = smooth_path(
            np.column_stack([layers_axis, t_proj[qi, :, 0], t_proj[qi, :, 1]])
        )
        ip = smooth_path(
            np.column_stack([layers_axis, i_proj[qi, :, 0], i_proj[qi, :, 1]])
        )
        ax.plot(tp[:, 0], tp[:, 1], tp[:, 2], color=color, linewidth=2.6, alpha=0.95)
        ax.plot(
            ip[:, 0],
            ip[:, 1],
            ip[:, 2],
            color=color,
            linewidth=2.6,
            alpha=0.55,
            linestyle=(0, (4, 2)),
        )
        # tie-lines every few layers showing the closing gap
        for layer in range(1, n_layers, 4):
            ax.plot(
                [layer, layer],
                [t_proj[qi, layer, 0], i_proj[qi, layer, 0]],
                [t_proj[qi, layer, 1], i_proj[qi, layer, 1]],
                color=color,
                linewidth=0.9,
                alpha=0.38,
            )
        ax.scatter(
            [0],
            [t_proj[qi, 0, 0]],
            [t_proj[qi, 0, 1]],
            color=color,
            s=26,
            marker="o",
            depthshade=False,
        )
        ax.scatter(
            [0],
            [i_proj[qi, 0, 0]],
            [i_proj[qi, 0, 1]],
            color=color,
            s=30,
            marker="D",
            depthshade=False,
        )
        ax.scatter(
            [best_layer],
            [t_proj[qi, best_layer, 0]],
            [t_proj[qi, best_layer, 1]],
            color=color,
            s=46,
            marker="o",
            edgecolors="white",
            linewidths=0.6,
            depthshade=False,
        )

    # Peak-layer plane.
    yy, zz = np.meshgrid(np.linspace(-1.05, 1.05, 2), np.linspace(-1.05, 1.05, 2))
    ax.plot_surface(
        np.full_like(yy, best_layer), yy, zz, color=(1.0, 0.77, 0.27, 0.10), shade=False
    )

    ax.set_xlim(0, n_layers - 1)
    ax.set_ylim(-1.1, 1.1)
    ax.set_zlim(-1.1, 1.1)
    ax.set_xlabel("decoder layer →", color="#8f9aa0", labelpad=12)
    ax.set_ylabel("content PC1", color="#8f9aa0", labelpad=10)
    ax.set_zlabel("content PC2", color="#8f9aa0", labelpad=8)
    ax.view_init(elev=18, azim=-66)
    ax.set_box_aspect((2.9, 1.0, 0.9))
    tmp = HERE / "results" / ".convergence-3d-panel.png"
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.savefig(
        tmp,
        facecolor=fig.get_facecolor(),
        transparent=False,
        bbox_inches="tight",
        pad_inches=0.05,
    )
    plt.close(fig)
    img = Image.open(tmp).convert("RGB")
    tmp.unlink(missing_ok=True)
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-carrier-convergence-n12")
    )
    ap.add_argument(
        "--out",
        default=str(
            HERE
            / "results"
            / "qwen-carrier-convergence-n12"
            / "convergence-strands-3d.png"
        ),
    )
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "carrier_convergence.npz")
    best_layer = summary["best_layer"]
    best = summary["best"]
    panel = render_strands(data["text_states"], data["image_states"], best_layer)

    w, h = 2200, 1300
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -220, 900, 700), fill=(75, 220, 255, 27))
    gd.ellipse((1240, 160, 2460, 1360), fill=(255, 112, 72, 25))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(84))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 42),
        "QWEN CARRIER CONVERGENCE — 3D STRANDS",
        fill=AMBER,
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "Twelve thoughts, two doors, one room",
        fill=INK,
        font=ui_font(64, True),
    )
    draw.text(
        (66, 164),
        "Each color is one question travelling through the decoder. Solid strand entered as text; dashed strand entered as pixels. Strand pairs braid together by depth.",
        fill=MUTED,
        font=ui_font(23),
    )

    draw.rounded_rectangle(
        (64, 234, 2136, 1146), radius=30, fill=PANEL, outline=(35, 49, 59), width=1
    )
    panel = panel.resize((1980, 832), Image.Resampling.LANCZOS)
    canvas.paste(panel, (104, 286))
    draw.text(
        (96, 252),
        f"PCA frame fixed at peak layer {best_layer}; per-layer scale normalized",
        fill=MUTED,
        font=ui_font(17),
    )

    stats = [
        ("matched cosine", f"{best['matched_cosine']:.2f}"),
        ("mismatched", f"{best['mismatched_cosine']:.2f}"),
        ("RSA geometry", f"{best['rsa_pearson']:.2f}"),
        ("pair retrieval", f"{best['match_rank_accuracy'] * 100:.0f}%"),
    ]
    sx = 64
    for title, value in stats:
        draw.rounded_rectangle(
            (sx, 1170, sx + 320, 1262),
            radius=18,
            fill=PANEL,
            outline=(35, 49, 59),
            width=1,
        )
        draw.text((sx + 22, 1184), title, fill=MUTED, font=ui_font(16))
        draw.text((sx + 22, 1208), value, fill=INK, font=ui_font(34, True))
        sx += 344
    draw.text(
        (sx + 20, 1196),
        "solid = text carrier   dashed = image carrier   thin rungs = pair gap",
        fill=MUTED,
        font=ui_font(18),
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
