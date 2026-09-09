# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy"]
# ///
"""Render a volumetric tensor-cube visualization for snapcompact activations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import cm
from matplotlib.colors import LinearSegmentedColormap
from mpl_toolkits.mplot3d.art3d import Line3DCollection

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = HERE / "results" / "agent-viz-volume"

BG = "#05070b"
PANEL = "#0b1017"
GRID = "#33424c"
INK = "#efe9d5"
MUTED = "#87959b"
CYAN = "#44d9ff"
RED = "#ff5d4c"
AMBER = "#ffc84a"
GREEN = "#87ff80"


def robust01(values: np.ndarray, q: float = 0.985) -> np.ndarray:
    """Quantile-normalize positive activation magnitudes without copying when possible."""
    scale = float(np.nanquantile(values, q))
    if not np.isfinite(scale) or scale <= 0.0:
        scale = 1.0
    return np.clip(values / scale, 0.0, 1.0).astype(np.float32, copy=False)


def tinted_cmap(name: str, low: str, high: str) -> LinearSegmentedColormap:
    return LinearSegmentedColormap.from_list(
        name, [(0.0, BG), (0.24, low), (1.0, high)], N=256
    )


def load_volume(data_dir: Path) -> tuple[np.ndarray, dict, list[str]]:
    npz = np.load(data_dir / "heatmaps.npz")
    summary = json.loads((data_dir / "summary.json").read_text())

    answer = robust01(npz["answer_binned"])
    random = robust01(npz["random_binned"])
    ratio = robust01(npz["ratio_binned"])
    volume = np.stack([answer, random, ratio], axis=0)
    labels = ["ANSWER Δ", "RANDOM Δ", "ANSWER/RANDOM"]
    return volume, summary, labels


def cube_edges(
    x0: float, x1: float, y0: float, y1: float, z0: float, z1: float
) -> list[list[tuple[float, float, float]]]:
    p = {
        "000": (x0, y0, z0),
        "100": (x1, y0, z0),
        "010": (x0, y1, z0),
        "110": (x1, y1, z0),
        "001": (x0, y0, z1),
        "101": (x1, y0, z1),
        "011": (x0, y1, z1),
        "111": (x1, y1, z1),
    }
    return [
        [p["000"], p["100"]],
        [p["010"], p["110"]],
        [p["001"], p["101"]],
        [p["011"], p["111"]],
        [p["000"], p["010"]],
        [p["100"], p["110"]],
        [p["001"], p["011"]],
        [p["101"], p["111"]],
        [p["000"], p["001"]],
        [p["100"], p["101"]],
        [p["010"], p["011"]],
        [p["110"], p["111"]],
    ]


def style_3d(ax) -> None:
    ax.set_facecolor(BG)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor((0.02, 0.03, 0.04, 0.0))
        axis._axinfo["grid"]["color"] = (0.35, 0.48, 0.56, 0.12)
        axis._axinfo["tick"]["color"] = (0.75, 0.82, 0.82, 0.55)
    ax.tick_params(colors=MUTED, labelsize=8, pad=0)
    ax.set_xlabel("image-token bins (729 → 180)", color=MUTED, labelpad=9)
    ax.set_ylabel("condition", color=MUTED, labelpad=7)
    ax.set_zlabel("decoder layer", color=MUTED, labelpad=7)
    ax.set_xlim(0, 179)
    ax.set_ylim(-0.38, 2.38)
    ax.set_zlim(0, 18)
    ax.set_yticks([0, 1, 2])
    ax.set_yticklabels(["answer", "random", "ratio"], color=INK)
    ax.set_xticks([0, 45, 90, 135, 179])
    ax.set_zticks([0, 4, 9, 14, 18])
    ax.view_init(elev=23, azim=-61)
    ax.set_box_aspect((3.9, 1.0, 1.15))


def add_volume(ax, volume: np.ndarray) -> None:
    cmaps = [
        tinted_cmap("answer_ct", "#063842", CYAN),
        tinted_cmap("random_ct", "#461813", RED),
        tinted_cmap("ratio_ct", "#3c2b05", AMBER),
    ]
    edge_colors = [CYAN, RED, AMBER]
    layers = np.arange(volume.shape[1])
    bins = np.arange(volume.shape[2])
    x, z = np.meshgrid(bins, layers)

    # Translucent CT slices: condition is depth, layer is vertical, image-token bin is horizontal.
    for cond, cmap in enumerate(cmaps):
        vals = volume[cond]
        rgba = cmap(vals)
        rgba[..., 3] = 0.08 + 0.68 * np.power(vals, 1.55)
        y = np.full_like(x, cond, dtype=np.float32)
        ax.plot_surface(
            x,
            y,
            z,
            facecolors=rgba,
            rstride=1,
            cstride=1,
            linewidth=0,
            antialiased=False,
            shade=False,
        )

        # Bright activation voxels above each condition's 98th percentile.
        threshold = float(np.quantile(vals, 0.982))
        zz, xx = np.where(vals >= threshold)
        yy = np.full(xx.shape, cond, dtype=np.float32)
        strength = vals[zz, xx]
        ax.scatter(
            xx,
            yy,
            zz,
            s=10 + 90 * strength,
            c=edge_colors[cond],
            marker="s",
            alpha=0.58,
            depthshade=False,
            linewidths=0,
        )

    ax.add_collection3d(
        Line3DCollection(
            cube_edges(0, 179, -0.23, 2.23, 0, 18),
            colors=(0.42, 0.72, 0.82, 0.22),
            linewidths=0.9,
        )
    )

    # Crosshair slices through the strongest answer/random separation.
    ratio = volume[2]
    layer_profile = ratio.mean(axis=1)
    bin_profile = ratio.mean(axis=0)
    peak_layer = int(layer_profile.argmax())
    peak_bin = int(bin_profile.argmax())
    ax.plot(
        [peak_bin, peak_bin],
        [-0.28, 2.28],
        [peak_layer, peak_layer],
        color=GREEN,
        alpha=0.9,
        linewidth=1.5,
    )
    ax.plot(
        [0, 179],
        [2.28, 2.28],
        [peak_layer, peak_layer],
        color=GREEN,
        alpha=0.45,
        linewidth=1.1,
    )
    ax.text(
        peak_bin + 3,
        2.35,
        peak_layer + 0.2,
        "hottest ratio slice",
        color=GREEN,
        fontsize=8,
    )


def add_projection_panel(ax, volume: np.ndarray, labels: list[str]) -> None:
    ax.set_facecolor(PANEL)
    cmap = tinted_cmap("small_ct", "#10252f", "#f2d87b")
    strip = np.vstack(
        [
            volume[0],
            np.full((2, volume.shape[2]), np.nan),
            volume[1],
            np.full((2, volume.shape[2]), np.nan),
            volume[2],
        ]
    )
    masked = np.ma.masked_invalid(strip)
    cmap.set_bad(PANEL)
    ax.imshow(masked, aspect="auto", interpolation="nearest", cmap=cmap, vmin=0, vmax=1)
    ax.set_xticks([0, 45, 90, 135, 179])
    ax.set_yticks([9, 30, 51])
    ax.set_yticklabels(labels, color=INK, fontsize=8)
    ax.tick_params(colors=MUTED, labelsize=8, length=0)
    ax.set_title("unwrapped tensor volume", color=INK, fontsize=12, loc="left", pad=8)
    for spine in ax.spines.values():
        spine.set_color("#27323a")


def add_layer_panel(ax, volume: np.ndarray) -> None:
    ax.set_facecolor(PANEL)
    colors = [CYAN, RED, AMBER]
    names = ["answer", "random", "ratio"]
    for cond, color in enumerate(colors):
        profile = volume[cond].mean(axis=1)
        ax.plot(
            np.arange(profile.size),
            profile,
            color=color,
            linewidth=2.0,
            label=names[cond],
        )
        ax.fill_between(np.arange(profile.size), profile, 0, color=color, alpha=0.08)
    ax.set_xlim(0, 18)
    ax.set_ylim(0, 1.0)
    ax.set_xlabel("layer", color=MUTED, fontsize=8)
    ax.set_ylabel("mean normalized intensity", color=MUTED, fontsize=8)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.grid(color=GRID, alpha=0.18, linewidth=0.7)
    ax.legend(frameon=False, labelcolor=INK, fontsize=8, loc="upper right")
    ax.set_title("layer dose curve", color=INK, fontsize=12, loc="left", pad=8)
    for spine in ax.spines.values():
        spine.set_color("#27323a")


def render(
    volume: np.ndarray, summary: dict, labels: list[str], out_path: Path
) -> None:
    fig = plt.figure(figsize=(18, 11), dpi=180, facecolor=BG)
    gs = fig.add_gridspec(
        3,
        5,
        width_ratios=[1.35, 1.35, 1.35, 0.95, 0.95],
        height_ratios=[0.12, 1.0, 0.42],
        wspace=0.22,
        hspace=0.24,
    )

    title_ax = fig.add_subplot(gs[0, :])
    title_ax.axis("off")
    title_ax.text(
        0.0,
        0.70,
        "SNAPCOMPACT ACTIVATION CT",
        color=INK,
        fontsize=27,
        fontweight="bold",
        transform=title_ax.transAxes,
    )
    title_ax.text(
        0.0,
        0.24,
        "volumetric tensor cube: 19 layers × 180 image-token bins × 3 conditions",
        color=MUTED,
        fontsize=11,
        transform=title_ax.transAxes,
    )
    title_ax.text(
        0.985,
        0.58,
        f"PaddleOCR-VL · Q: {summary['question']['q']}",
        color=MUTED,
        fontsize=9,
        ha="right",
        transform=title_ax.transAxes,
    )
    title_ax.text(
        0.985,
        0.24,
        f"gold answer {summary['question']['answer_text']} · answer/random mean Δ {summary['answer_over_random_delta']:.2f}×",
        color=AMBER,
        fontsize=10,
        ha="right",
        transform=title_ax.transAxes,
    )

    ax3d = fig.add_subplot(gs[1:, :3], projection="3d")
    style_3d(ax3d)
    add_volume(ax3d, volume)
    ax3d.set_title(
        "MRI-style scan of hidden-state deltas",
        color=INK,
        fontsize=15,
        loc="left",
        pad=12,
    )

    ax_proj = fig.add_subplot(gs[1, 3:])
    add_projection_panel(ax_proj, volume, labels)

    ax_layer = fig.add_subplot(gs[2, 3:])
    add_layer_panel(ax_layer, volume)

    fig.text(
        0.055,
        0.055,
        "source: heatmaps.npz arrays answer_binned, random_binned, ratio_binned · quantile normalized per condition",
        color="#617078",
        fontsize=8,
    )
    fig.text(
        0.055,
        0.033,
        "cyan=answer evidence · red=random control · gold=answer/random amplification · green=crosshair at peak ratio slice",
        color="#617078",
        fontsize=8,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, facecolor=BG, bbox_inches="tight", pad_inches=0.22)
    plt.close(fig)


def write_source_data(volume: np.ndarray, summary: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out_dir / "volume_source.npz",
        volume=volume,
        answer_norm=volume[0],
        random_norm=volume[1],
        ratio_norm=volume[2],
    )
    payload = {
        "description": "Quantile-normalized tensor cube used by snapcompact_viz_volume.py.",
        "shape": {
            "condition": 3,
            "layers": int(volume.shape[1]),
            "image_token_bins": int(volume.shape[2]),
        },
        "conditions": ["answer_delta", "random_delta", "answer_over_random_ratio"],
        "question": summary["question"],
        "answer_over_random_delta": summary["answer_over_random_delta"],
        "source": str(DATA_DIR / "heatmaps.npz"),
    }
    (out_dir / "volume_source.json").write_text(json.dumps(payload, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--out", type=str, default="volume.png")
    args = parser.parse_args()

    volume, summary, labels = load_volume(args.data_dir)
    write_source_data(volume, summary, args.out_dir)
    render(volume, summary, labels, args.out_dir / args.out)


if __name__ == "__main__":
    main()
