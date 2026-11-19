# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy"]
# ///
"""Render a radial sonar view of snapcompact answer/random activation echoes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.colors as mcolors
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Wedge

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = HERE / "results" / "agent-viz-radial"

BG = "#02060a"
GRID = "#2cf5d044"
CYAN = "#38f4ff"
GREEN = "#81ffb4"
AMBER = "#ffc247"
RED = "#ff4d42"
INK = "#f3f1dd"
MUTED = "#8da0a8"


def robust_norm(values: np.ndarray, q: float = 0.975) -> np.ndarray:
    scale = float(np.quantile(values, q))
    if not np.isfinite(scale) or scale <= 0:
        scale = float(np.max(values)) or 1.0
    return np.clip(values / scale, 0.0, 1.0)


def polar_edges(cols: int, layers: int) -> tuple[np.ndarray, np.ndarray]:
    theta = np.linspace(0.0, 2.0 * np.pi, cols + 1)
    radius = np.arange(layers + 1, dtype=np.float32) + 1.0
    return theta, radius


def radar_cmap() -> mcolors.LinearSegmentedColormap:
    colors = [
        (0.00, "#02060a"),
        (0.10, "#03241f"),
        (0.32, "#08705e"),
        (0.55, "#16f0be"),
        (0.76, "#fff06a"),
        (1.00, "#fff8e0"),
    ]
    return mcolors.LinearSegmentedColormap.from_list("snapcompact_radar", colors)


def top_echoes(
    ratio: np.ndarray, answer: np.ndarray, random: np.ndarray, limit: int = 18
) -> list[dict[str, float | int]]:
    flat = np.argpartition(ratio.ravel(), -limit)[-limit:]
    flat = flat[np.argsort(ratio.ravel()[flat])[::-1]]
    rows: list[dict[str, float | int]] = []
    for idx in flat:
        layer, bin_idx = np.unravel_index(int(idx), ratio.shape)
        rows.append(
            {
                "rank": len(rows) + 1,
                "layer": int(layer),
                "bin": int(bin_idx),
                "angle_degrees": round(
                    float((bin_idx + 0.5) * 360.0 / ratio.shape[1]), 2
                ),
                "answer_delta": round(float(answer[layer, bin_idx]), 4),
                "random_delta": round(float(random[layer, bin_idx]), 4),
                "answer_random_ratio": round(float(ratio[layer, bin_idx]), 4),
            }
        )
    return rows


def add_glow_spikes(ax: plt.Axes, ratio: np.ndarray, norm_ratio: np.ndarray) -> None:
    layers, bins = ratio.shape
    theta_centers = (np.arange(bins) + 0.5) * 2.0 * np.pi / bins
    threshold = float(np.quantile(norm_ratio, 0.91))
    for layer in range(layers):
        active = np.flatnonzero(norm_ratio[layer] >= threshold)
        if active.size == 0:
            active = np.argpartition(norm_ratio[layer], -3)[-3:]
        for idx in active:
            v = float(norm_ratio[layer, idx])
            base_r = layer + 1.18
            tip_r = base_r + 0.12 + 0.58 * v
            theta = float(theta_centers[idx])
            color = AMBER if v > 0.78 else CYAN
            ax.plot(
                [theta, theta],
                [base_r, tip_r],
                color=color,
                linewidth=0.7 + 1.8 * v,
                alpha=0.30 + 0.55 * v,
            )
            ax.scatter(
                [theta],
                [tip_r],
                s=5 + 28 * v,
                color=color,
                alpha=0.26 + 0.55 * v,
                linewidths=0,
            )


def draw_radial(
    summary: dict, answer: np.ndarray, random: np.ndarray, ratio: np.ndarray
) -> plt.Figure:
    layers, bins = ratio.shape
    norm_ratio = robust_norm(ratio, 0.972)
    theta_edges, radius_edges = polar_edges(bins, layers)
    theta_grid, radius_grid = np.meshgrid(theta_edges, radius_edges)

    fig = plt.figure(figsize=(16, 10), dpi=180, facecolor=BG)
    ax = fig.add_axes([0.04, 0.04, 0.68, 0.90], projection="polar", facecolor=BG)
    ax.set_theta_zero_location("N")
    ax.set_theta_direction(-1)
    ax.set_ylim(0, layers + 2.05)
    ax.set_xticks(np.deg2rad(np.arange(0, 360, 30)))
    ax.set_xticklabels([f"{d}°" for d in range(0, 360, 30)], color=MUTED, fontsize=8)
    ax.set_yticks(np.arange(1, layers + 1) + 0.5)
    ax.set_yticklabels([str(i) for i in range(layers)], color="#8da0a888", fontsize=7)
    ax.grid(color=GRID, linewidth=0.6, alpha=0.55)
    ax.spines["polar"].set_color("#38f4ff66")
    ax.spines["polar"].set_linewidth(1.2)

    ax.pcolormesh(
        theta_grid,
        radius_grid,
        norm_ratio,
        cmap=radar_cmap(),
        shading="flat",
        alpha=0.96,
    )

    # Soft trace underneath the hottest angular bearings, like phosphor persistence.
    bearing_strength = norm_ratio.mean(axis=0) + norm_ratio.max(axis=0) * 0.42
    sweep_bin = int(np.argmax(bearing_strength))
    sweep_angle = float((sweep_bin + 0.5) * 360.0 / bins)
    sweep_theta = np.deg2rad(sweep_angle)
    for width, alpha in ((38, 0.055), (22, 0.075), (8, 0.14)):
        half_width = np.deg2rad(width / 2)
        theta = np.linspace(sweep_theta - half_width, sweep_theta + half_width, 80)
        ax.fill_between(
            theta, 0.0, layers + 1.75, color=GREEN, alpha=alpha, linewidth=0
        )

    add_glow_spikes(ax, ratio, norm_ratio)

    for r in range(1, layers + 2):
        ax.plot(
            np.linspace(0, 2 * np.pi, 360),
            np.full(360, r),
            color="#6fffe522",
            linewidth=0.55,
        )
    for deg in range(0, 360, 15):
        th = np.deg2rad(deg)
        ax.plot([th, th], [1, layers + 1.4], color="#6fffe516", linewidth=0.45)

    ax.text(
        0.5,
        0.5,
        "ECHO\nCORE",
        color="#dff",
        fontsize=13,
        fontweight="bold",
        ha="center",
        va="center",
        transform=ax.transAxes,
    )
    ax.text(
        np.deg2rad(sweep_angle),
        layers + 1.35,
        "strongest bearing",
        color=GREEN,
        fontsize=8,
        ha="center",
        va="center",
    )

    side = fig.add_axes([0.70, 0.06, 0.27, 0.86], facecolor=BG)
    side.axis("off")
    side.set_xlim(0, 1)
    side.set_ylim(0, 1)
    q = summary["question"]
    ratio_mean = float(summary["answer_over_random_delta"])
    max_layer = int(summary.get("max_ratio_layer", int(np.argmax(ratio.mean(axis=1)))))
    top = top_echoes(ratio, answer, random, 7)
    max_echo = top[0]

    title_fx = [pe.withStroke(linewidth=4, foreground="#0b1918")]
    side.text(
        0.00,
        0.98,
        "SNAPCOMPACT RADAR",
        color=GREEN,
        fontsize=12,
        fontweight="bold",
        va="top",
    )
    side.text(
        0.00,
        0.925,
        "Where the missing\nanswer echoes",
        color=INK,
        fontsize=27,
        fontweight="bold",
        va="top",
        linespacing=0.92,
        path_effects=title_fx,
    )
    side.text(
        0.00,
        0.765,
        "Concentric rings are decoder layers. Angles are image-token bins. Bright spikes are answer-mask residuals divided by the random-mask control.",
        color=MUTED,
        fontsize=9.5,
        va="top",
        wrap=True,
    )

    metrics = [
        ("gold answer", str(q["answer_text"]), AMBER),
        ("question", q["q"], INK),
        ("image tokens", f"{summary['image_tokens']:,}", CYAN),
        ("layers", f"{summary['layers']}", CYAN),
        ("mean answer/random Δ", f"{ratio_mean:.2f}×", AMBER),
        ("max-ratio layer", f"L{max_layer}", GREEN),
        (
            "loudest echo",
            f"L{max_echo['layer']} · bin {max_echo['bin']} · {max_echo['answer_random_ratio']:.1f}×",
            RED,
        ),
    ]
    y = 0.655
    for label, value, color in metrics:
        side.text(
            0.00,
            y,
            label.upper(),
            color=MUTED,
            fontsize=7.2,
            fontweight="bold",
            va="top",
        )
        value_size = 12.6 if len(value) < 34 else 8.7
        side.text(
            0.00,
            y - 0.026,
            value,
            color=color,
            fontsize=value_size,
            fontweight="bold" if label != "question" else "normal",
            va="top",
            wrap=True,
        )
        y -= 0.075 if label != "question" else 0.105

    side.text(
        0.00,
        y - 0.006,
        "TOP ECHOES",
        color=GREEN,
        fontsize=7.6,
        fontweight="bold",
        va="top",
    )
    y -= 0.040
    for row in top[:4]:
        intensity = min(
            1.0,
            float(row["answer_random_ratio"]) / float(max_echo["answer_random_ratio"]),
        )
        side.plot(
            [0.00, 0.36 * intensity],
            [y - 0.004, y - 0.004],
            color=AMBER,
            linewidth=3.2,
            alpha=0.35 + 0.55 * intensity,
            solid_capstyle="round",
        )
        side.text(
            0.40,
            y - 0.014,
            f"L{row['layer']:02d}  bin {row['bin']:03d}  {row['answer_random_ratio']:>5.1f}×",
            color=INK,
            fontsize=7.4,
            va="bottom",
            family="monospace",
        )
        y -= 0.032

    # Tiny color scale and data provenance line.
    grad_ax = fig.add_axes([0.708, 0.048, 0.19, 0.014], facecolor=BG)
    grad_ax.imshow(np.linspace(0, 1, 512)[None, :], cmap=radar_cmap(), aspect="auto")
    grad_ax.set_axis_off()
    side.text(0.00, 0.006, "low ratio", color=MUTED, fontsize=7, va="bottom")
    side.text(0.59, 0.006, "high answer echo", color=MUTED, fontsize=7, va="bottom")
    fig.text(
        0.045,
        0.018,
        "Actual heatmaps.npz arrays: ratio_binned, answer_binned, random_binned",
        color="#8da0a888",
        fontsize=8,
    )
    return fig


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(DATA_DIR))
    parser.add_argument("--out-dir", default=str(OUT_DIR))
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = json.loads((data_dir / "summary.json").read_text())
    heatmaps = np.load(data_dir / "heatmaps.npz")
    answer = np.asarray(heatmaps["answer_binned"], dtype=np.float32)
    random = np.asarray(heatmaps["random_binned"], dtype=np.float32)
    ratio = np.asarray(heatmaps["ratio_binned"], dtype=np.float32)

    fig = draw_radial(summary, answer, random, ratio)
    out_png = out_dir / "radial.png"
    fig.savefig(out_png, facecolor=BG)
    plt.close(fig)

    echoes = top_echoes(ratio, answer, random, 24)
    (out_dir / "radial_top_echoes.json").write_text(
        json.dumps(
            {"source": str(data_dir / "heatmaps.npz"), "top_echoes": echoes}, indent=2
        )
        + "\n"
    )
    np.savez_compressed(
        out_dir / "radial_source.npz",
        answer_binned=answer,
        random_binned=random,
        ratio_binned=ratio,
        ratio_norm=robust_norm(ratio, 0.972),
    )
    print(out_png)


if __name__ == "__main__":
    main()
