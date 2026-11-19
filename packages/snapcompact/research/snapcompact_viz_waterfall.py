#!/usr/bin/env python3
"""Layered snapcompact activation waterfall.

Builds a seismic/ridgeline rendering from the PaddleOCR-VL white-box
activation deltas in results/tensor-heatmap-paddleocr-q7/heatmaps.npz.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import Rectangle


SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "results" / "tensor-heatmap-paddleocr-q7"
OUT_DIR = SCRIPT_DIR / "results" / "agent-viz-waterfall"


def smooth_rows(values: np.ndarray, radius: int = 3) -> np.ndarray:
    """Small separable bin smoother; preserves shape and avoids scipy."""
    if radius <= 0:
        return values.copy()
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(x * x) / (2.0 * (radius / 1.8) ** 2))
    kernel /= kernel.sum()
    padded = np.pad(values, ((0, 0), (radius, radius)), mode="edge")
    out = np.empty_like(values, dtype=np.float32)
    for row in range(values.shape[0]):
        out[row] = np.convolve(padded[row], kernel, mode="valid")
    return out


def robust_unit(values: np.ndarray, high: float) -> np.ndarray:
    scaled = np.log1p(np.maximum(values, 0.0)) / np.log1p(high)
    return np.clip(scaled, 0.0, 1.0).astype(np.float32)


def load_source() -> tuple[dict, dict[str, np.ndarray]]:
    with (DATA_DIR / "summary.json").open("r", encoding="utf-8") as handle:
        summary = json.load(handle)
    with np.load(DATA_DIR / "heatmaps.npz") as npz:
        arrays = {name: npz[name].astype(np.float32) for name in npz.files}
    return summary, arrays


def build_waterfall_data(
    summary: dict, arrays: dict[str, np.ndarray]
) -> dict[str, np.ndarray]:
    answer = smooth_rows(arrays["answer_binned"], radius=3)
    random = smooth_rows(arrays["random_binned"], radius=3)
    ratio = smooth_rows(arrays["ratio_binned"], radius=2)

    # Use one common robust scale so answer/random amplitudes are visually comparable.
    common_high = float(
        summary.get("common_delta_scale_p98")
        or np.percentile(np.r_[answer, random], 98)
    )
    answer_u = robust_unit(answer, common_high)
    random_u = robust_unit(random, common_high)
    contrast = np.tanh((answer_u - random_u) * 2.8).astype(np.float32)
    ratio_u = robust_unit(
        ratio, float(summary.get("ratio_scale_p98") or np.percentile(ratio, 98))
    )

    layers, bins = answer.shape
    x = np.linspace(0.0, 1.0, bins, dtype=np.float32)
    baselines = np.arange(layers, dtype=np.float32)[::-1]
    return {
        "x": x,
        "baselines": baselines,
        "answer": answer,
        "random": random,
        "ratio": ratio,
        "answer_unit": answer_u,
        "random_unit": random_u,
        "contrast": contrast,
        "ratio_unit": ratio_u,
    }


def draw_glow_line(ax, x, y, color, lw=1.4, z=5, alpha=1.0):
    (line,) = ax.plot(
        x, y, color=color, lw=lw, alpha=alpha, zorder=z, solid_joinstyle="round"
    )
    line.set_path_effects(
        [
            pe.Stroke(linewidth=lw + 8.5, foreground=color, alpha=0.055),
            pe.Stroke(linewidth=lw + 4.5, foreground=color, alpha=0.12),
            pe.Normal(),
        ]
    )
    return line


def render(summary: dict, data: dict[str, np.ndarray]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_png = OUT_DIR / "waterfall.png"

    x = data["x"]
    baselines = data["baselines"]
    answer_u = data["answer_unit"]
    random_u = data["random_unit"]
    contrast = data["contrast"]
    ratio_u = data["ratio_unit"]
    layers, bins = answer_u.shape

    fig = plt.figure(figsize=(15.5, 10.5), dpi=210, facecolor="#05070d")
    ax = fig.add_axes([0.055, 0.09, 0.89, 0.80], facecolor="#05070d")

    # Background ratio field: a dim spectrogram behind the ridges.
    cmap = LinearSegmentedColormap.from_list(
        "snap_seismic",
        ["#05070d", "#0b1831", "#133f59", "#2d6f75", "#f3a44c", "#fff0bd"],
    )
    extent = (0.0, 1.0, -0.78, layers - 0.22)
    ax.imshow(
        ratio_u[::-1],
        extent=extent,
        aspect="auto",
        cmap=cmap,
        interpolation="bicubic",
        alpha=0.38,
        zorder=0,
    )

    # Seismic paper grid and scanlines.
    for gx in np.linspace(0, 1, 13):
        ax.axvline(gx, color="#7cc8ff", lw=0.45, alpha=0.10, zorder=1)
    for y in range(layers):
        ax.axhline(y, color="#d4eaff", lw=0.38, alpha=0.085, zorder=1)
    for yy in np.linspace(-0.6, layers - 0.35, 78):
        ax.axhline(yy, color="#ffffff", lw=0.2, alpha=0.018, zorder=1)

    answer_color = "#ffc05a"
    random_color = "#33d7ff"
    gain_color = "#ff4d8d"
    amplitude = 0.72

    for layer_index, base in enumerate(baselines):
        ans = base + answer_u[layer_index] * amplitude
        rnd = base - random_u[layer_index] * amplitude * 0.82
        mid = base + contrast[layer_index] * amplitude * 0.62

        ax.fill_between(x, base, ans, color=answer_color, alpha=0.075, zorder=2)
        ax.fill_between(x, base, rnd, color=random_color, alpha=0.045, zorder=2)
        ax.fill_between(
            x,
            rnd,
            ans,
            where=answer_u[layer_index] >= random_u[layer_index],
            interpolate=True,
            color=gain_color,
            alpha=0.055,
            zorder=2,
        )

        # Double-trace each layer: random-mask lower trace, answer-mask upper trace,
        # plus a magenta differential tremor to make the comparison readable.
        draw_glow_line(ax, x, rnd, random_color, lw=0.9, z=4, alpha=0.74)
        draw_glow_line(ax, x, ans, answer_color, lw=1.16, z=5, alpha=0.92)
        ax.plot(x, mid, color=gain_color, lw=0.48, alpha=0.55, zorder=3)

        if layer_index in {0, 4, 9, 14, layers - 1}:
            ax.text(
                -0.018,
                base,
                f"L{layer_index:02d}",
                ha="right",
                va="center",
                color="#b9dfff",
                fontsize=9,
                family="monospace",
                alpha=0.82,
            )

    # Highlight the strongest answer-vs-random bin per layer with tiny hot pips.
    gain = answer_u - random_u
    strongest = np.argmax(gain, axis=1)
    ax.scatter(
        x[strongest],
        baselines + answer_u[np.arange(layers), strongest] * amplitude + 0.045,
        s=8 + 32 * np.clip(gain[np.arange(layers), strongest], 0, 1),
        c="#fff6cf",
        alpha=0.72,
        edgecolors="none",
        zorder=6,
    )

    # Framing labels.
    answer_mean = float(summary["answer_delta_mean"])
    random_mean = float(summary["random_delta_mean"])
    ratio = float(summary["answer_over_random_delta"])
    question = summary["question"]["q"]
    answer_text = summary["question"]["answer_text"]
    image_tokens = int(summary["image_tokens"])

    ax.text(
        0.0,
        layers + 0.62,
        "SNAPCOMPACT ACTIVATION WATERFALL",
        color="#f7fbff",
        fontsize=22,
        weight="bold",
        family="monospace",
        ha="left",
        va="bottom",
    )
    ax.text(
        0.0,
        layers + 0.20,
        f"PaddleOCR-VL · {layers} decoder layers · {image_tokens} image tokens binned into {bins} traces · answer '{answer_text}' vs random mask",
        color="#9cc7e5",
        fontsize=10.5,
        family="monospace",
        ha="left",
        va="bottom",
    )
    ax.text(
        0.0,
        layers - 0.19,
        f"Q: {question}",
        color="#d8ecff",
        fontsize=9.5,
        family="monospace",
        ha="left",
        va="top",
        alpha=0.84,
    )
    ax.text(
        1.0,
        layers + 0.27,
        f"Δmean {answer_mean:.2f} / {random_mean:.2f}  =  {ratio:.2f}×",
        color="#ffd37a",
        fontsize=13,
        family="monospace",
        weight="bold",
        ha="right",
        va="bottom",
    )

    # Legend built as luminous calibration bars.
    legend_y = -1.35
    ax.plot([0.02, 0.10], [legend_y, legend_y], color=answer_color, lw=2.2)
    ax.text(
        0.112,
        legend_y,
        "answer-mask ridge",
        color="#ffdca0",
        fontsize=9,
        va="center",
        family="monospace",
    )
    ax.plot([0.32, 0.40], [legend_y, legend_y], color=random_color, lw=2.2)
    ax.text(
        0.412,
        legend_y,
        "random-mask ridge",
        color="#9ff0ff",
        fontsize=9,
        va="center",
        family="monospace",
    )
    ax.plot([0.62, 0.70], [legend_y, legend_y], color=gain_color, lw=1.4)
    ax.text(
        0.712,
        legend_y,
        "answer excess tremor",
        color="#ff9bbb",
        fontsize=9,
        va="center",
        family="monospace",
    )

    # Outer phosphor frame.
    ax.add_patch(
        Rectangle(
            (0, -0.78),
            1,
            layers - 0.44,
            fill=False,
            lw=0.9,
            edgecolor="#5fb7ff",
            alpha=0.34,
            zorder=10,
        )
    )
    ax.set_xlim(-0.055, 1.02)
    ax.set_ylim(-1.62, layers + 0.98)
    ax.set_xticks(np.linspace(0, 1, 7))
    ax.set_xticklabels(
        [f"{int(t * image_tokens):03d}" for t in np.linspace(0, 1, 7)],
        color="#8fbede",
        fontsize=8,
        family="monospace",
    )
    ax.set_yticks([])
    ax.set_xlabel(
        "image-token bin →",
        color="#9cc7e5",
        fontsize=10,
        family="monospace",
        labelpad=12,
    )
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis="x", length=0)

    # Save source arrays used by this rendering for reproducibility.
    np.savez_compressed(
        OUT_DIR / "waterfall_source.npz",
        x=x,
        baselines=baselines,
        answer_binned=data["answer"],
        random_binned=data["random"],
        ratio_binned=data["ratio"],
        answer_unit=answer_u,
        random_unit=random_u,
        ratio_unit=ratio_u,
        contrast=contrast,
    )
    with (OUT_DIR / "waterfall_source.json").open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "question": question,
                "answer_text": answer_text,
                "layers": layers,
                "bins": bins,
                "image_tokens": image_tokens,
                "answer_delta_mean": answer_mean,
                "random_delta_mean": random_mean,
                "answer_over_random_delta": ratio,
                "source_npz": str(DATA_DIR / "heatmaps.npz"),
            },
            handle,
            indent=2,
        )

    fig.savefig(
        out_png, facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0.14
    )
    plt.close(fig)
    print(out_png)


def main() -> None:
    summary, arrays = load_source()
    data = build_waterfall_data(summary, arrays)
    render(summary, data)


if __name__ == "__main__":
    main()
