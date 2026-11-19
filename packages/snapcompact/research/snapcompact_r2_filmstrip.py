#!/usr/bin/env python3
"""Twin reels: a filmstrip poster of text-carrier vs image-carrier similarity geometry.

Renders ~7 layers of the carrier-centered 12x12 cosine matrices (`text_sim`,
`image_sim` from carrier_convergence.npz) as paired frames on two parallel
film reels, with the REAL per-layer RSA Pearson from summary.json as a match
meter under each frame, plus the cross-carrier matched cosine as a secondary
tick. Closes with a callout frame for the best layer (RSA 0.85 @ L19).

Output: results/agent-r2-filmstrip/filmstrip.png (2200 px wide).
"""

import json
import os

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import FancyBboxPatch, Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "results", "qwen-carrier-convergence-n12")
OUT_DIR = os.path.join(HERE, "results", "agent-r2-filmstrip")

# ---------------------------------------------------------------- palette
BG = "#05070a"
PANEL = "#0c1117"
FILM = "#0a0e14"
INK = "#f1efe0"
MUTED = "#8f9aa0"
AMBER = "#ffc444"
CYAN = "#4bdcff"
ORANGE = "#ff7048"
GREEN = "#94ff75"
EDGE = "#1d2630"

DIVERGING = LinearSegmentedColormap.from_list(
    "carrier_div",
    [
        (0.0, CYAN),
        (0.30, "#16384a"),
        (0.50, "#0b1016"),
        (0.72, "#5c2c18"),
        (0.90, ORANGE),
        (1.0, AMBER),
    ],
)

LAYERS = [1, 5, 9, 13, 17, 19, 28]

# ---------------------------------------------------------------- data
npz = np.load(os.path.join(DATA_DIR, "carrier_convergence.npz"))
text_sim = npz["text_sim"]  # [29, 12, 12]
image_sim = npz["image_sim"]  # [29, 12, 12]
assert text_sim.shape == image_sim.shape == (29, 12, 12)

with open(os.path.join(DATA_DIR, "summary.json")) as fh:
    summary = json.load(fh)
per_layer = {row["layer"]: row for row in summary["per_layer"]}
best = summary["best"]  # layer 19: rsa 0.85, matched 0.66, mismatched -0.06

# ---------------------------------------------------------------- layout (pixel space)
W, H = 2200, 1000
fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
fig.patch.set_facecolor(BG)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W)
ax.set_ylim(H, 0)  # y grows downward
ax.axis("off")
ax.set_facecolor(BG)

X0, X1 = 150, 2136
N_COLS = len(LAYERS) + 1  # 7 layer frames + closing callout
CW = (X1 - X0) / N_COLS
FS = 186  # matrix tile size

TEXT_BAND_Y, BAND_H = 192, 262
IMAGE_BAND_Y = TEXT_BAND_Y + BAND_H + 26
METER_Y = IMAGE_BAND_Y + BAND_H + 36
METER_H = 64
FOOT_Y = METER_Y + METER_H + 52


def col_cx(i: int) -> float:
    return X0 + (i + 0.5) * CW


def sprockets(y: float, x_start: float, x_end: float) -> None:
    x = x_start + 14
    while x + 20 < x_end:
        ax.add_patch(
            FancyBboxPatch(
                (x, y),
                20,
                13,
                boxstyle="round,pad=0,rounding_size=4",
                facecolor=BG,
                edgecolor="#27313d",
                linewidth=1.0,
                zorder=6,
            )
        )
        x += 49


def film_band(y0: float, x_end: float) -> None:
    ax.add_patch(
        Rectangle(
            (X0 - 26, y0),
            x_end - X0 + 26,
            BAND_H,
            facecolor=FILM,
            edgecolor=EDGE,
            linewidth=1.2,
            zorder=2,
        )
    )
    sprockets(y0 + 11, X0 - 26, x_end)
    sprockets(y0 + BAND_H - 24, X0 - 26, x_end)


BAND_X_END = X0 + (N_COLS - 1) * CW - 14  # bands stop before the callout column
film_band(TEXT_BAND_Y, BAND_X_END)
film_band(IMAGE_BAND_Y, BAND_X_END)

# reel labels on the left edge
for y0, label, color in (
    (TEXT_BAND_Y, "TEXT REEL", CYAN),
    (IMAGE_BAND_Y, "IMAGE REEL", ORANGE),
):
    ax.text(
        X0 - 56,
        y0 + BAND_H / 2,
        label,
        color=color,
        fontsize=13,
        fontweight="bold",
        rotation=90,
        ha="center",
        va="center",
        zorder=8,
    )
    ax.text(
        X0 - 84,
        y0 + BAND_H / 2,
        "12 \u00d7 12 carrier cosine",
        color=MUTED,
        fontsize=8,
        rotation=90,
        ha="center",
        va="center",
        zorder=8,
    )

# ---------------------------------------------------------------- frames
VLIM = 0.75  # diagonal (cos=1) clips to amber, off-diagonal structure fills the range


def draw_matrix(mat: np.ndarray, cx: float, band_y: float) -> None:
    x0m, y0m = cx - FS / 2, band_y + 36
    ax.imshow(
        mat,
        cmap=DIVERGING,
        vmin=-VLIM,
        vmax=VLIM,
        extent=(x0m, x0m + FS, y0m + FS, y0m),
        origin="upper",
        interpolation="nearest",
        zorder=4,
    )
    ax.add_patch(
        Rectangle(
            (x0m, y0m), FS, FS, fill=False, edgecolor=EDGE, linewidth=1.1, zorder=5
        )
    )


for i, layer in enumerate(LAYERS):
    cx = col_cx(i)
    draw_matrix(text_sim[layer], cx, TEXT_BAND_Y)
    draw_matrix(image_sim[layer], cx, IMAGE_BAND_Y)

    # frame numbering, film style
    ax.text(
        cx,
        TEXT_BAND_Y - 12,
        f"FRAME {i + 1:02d}",
        color=MUTED,
        fontsize=8.5,
        ha="center",
        va="bottom",
        zorder=8,
    )
    for band_y in (TEXT_BAND_Y, IMAGE_BAND_Y):
        ax.text(
            cx,
            band_y + 36 + FS + 14,
            f"LAYER {layer}",
            color=INK,
            fontsize=10,
            fontweight="bold",
            ha="center",
            va="center",
            zorder=8,
        )

    # dotted connector between the paired frames
    ax.plot(
        [cx, cx],
        [TEXT_BAND_Y + BAND_H + 3, IMAGE_BAND_Y - 3],
        color="#3a4754",
        linewidth=1.2,
        linestyle=(0, (1, 3)),
        zorder=3,
    )

# ---------------------------------------------------------------- match meters
ax.text(
    X0 - 26,
    METER_Y - 14,
    "GEOMETRY MATCH",
    color=INK,
    fontsize=10,
    fontweight="bold",
    ha="left",
    va="bottom",
    zorder=8,
)
ax.text(
    X0 + 152,
    METER_Y - 14,
    "amber bar \u2014 RSA: Pearson r of the two reels' off-diagonal structure"
    "      cyan tick \u2014 matched cross-carrier cosine",
    color=MUTED,
    fontsize=8.5,
    ha="left",
    va="bottom",
    zorder=8,
)

BAR_W = FS
for i, layer in enumerate(LAYERS):
    row = per_layer[layer]
    rsa = row["rsa_pearson"]
    matched = row["matched_cosine"]
    cx = col_cx(i)
    bx = cx - BAR_W / 2

    ax.add_patch(
        Rectangle(
            (bx, METER_Y),
            BAR_W,
            12,
            facecolor=PANEL,
            edgecolor=EDGE,
            linewidth=0.8,
            zorder=4,
        )
    )
    ax.add_patch(
        Rectangle(
            (bx, METER_Y), BAR_W * rsa, 12, facecolor=AMBER, edgecolor="none", zorder=5
        )
    )
    ax.plot(
        [bx + BAR_W * matched] * 2,
        [METER_Y - 4, METER_Y + 16],
        color=CYAN,
        linewidth=2.0,
        zorder=6,
    )

    ax.text(
        cx,
        METER_Y + 32,
        f"RSA {rsa:.2f}",
        color=AMBER,
        fontsize=10.5,
        fontweight="bold",
        ha="center",
        va="center",
        zorder=8,
    )
    ax.text(
        cx,
        METER_Y + 50,
        f"matched cos {matched:.2f}",
        color=CYAN,
        fontsize=8.5,
        ha="center",
        va="center",
        zorder=8,
    )

# ---------------------------------------------------------------- closing callout frame
cb_x = X0 + (N_COLS - 1) * CW + 2
cb_w = X1 - cb_x
cb_y0, cb_y1 = TEXT_BAND_Y, METER_Y + METER_H
ax.add_patch(
    FancyBboxPatch(
        (cb_x, cb_y0),
        cb_w,
        cb_y1 - cb_y0,
        boxstyle="round,pad=0,rounding_size=10",
        facecolor=PANEL,
        edgecolor=AMBER,
        linewidth=1.6,
        zorder=4,
    )
)
ccx = cb_x + cb_w / 2
ax.text(
    ccx,
    cb_y0 + 46,
    "THE SPLICE",
    color=MUTED,
    fontsize=10,
    ha="center",
    va="center",
    zorder=8,
)
ax.text(
    ccx,
    cb_y0 + 122,
    f"RSA {best['rsa_pearson']:.2f}",
    color=AMBER,
    fontsize=33,
    fontweight="bold",
    ha="center",
    va="center",
    zorder=8,
)
ax.text(
    ccx,
    cb_y0 + 168,
    f"@ LAYER {best['layer']}",
    color=INK,
    fontsize=14,
    fontweight="bold",
    ha="center",
    va="center",
    zorder=8,
)

ax.plot(
    [cb_x + 28, cb_x + cb_w - 28],
    [cb_y0 + 206] * 2,
    color=EDGE,
    linewidth=1.0,
    zorder=5,
)

facts = [
    (f"matched cosine  {best['matched_cosine']:.2f}", CYAN),
    (f"mismatched  {best['mismatched_cosine']:.2f}", MUTED),
    (f"retrieval  {int(round(best['match_rank_accuracy'] * 12))}/12", GREEN),
]
for j, (line, color) in enumerate(facts):
    ax.text(
        ccx,
        cb_y0 + 244 + j * 34,
        line,
        color=color,
        fontsize=11.5,
        fontweight="bold",
        ha="center",
        va="center",
        zorder=8,
    )

ax.text(
    ccx,
    cb_y0 + 380,
    "Read it as text or look at\nthe picture \u2014 by layer 19\nthe model files both under\nthe same geometry.",
    color=INK,
    fontsize=10.5,
    ha="center",
    va="center",
    linespacing=1.6,
    zorder=8,
)

# the actual L19 splice: the twin pair, miniaturized
MINI = 78
for mat, mx, tag, tcol in (
    (text_sim[best["layer"]], ccx - MINI - 9, "text", CYAN),
    (image_sim[best["layer"]], ccx + 9, "image", ORANGE),
):
    ax.imshow(
        mat,
        cmap=DIVERGING,
        vmin=-VLIM,
        vmax=VLIM,
        extent=(mx, mx + MINI, cb_y0 + 444 + MINI, cb_y0 + 444),
        origin="upper",
        interpolation="nearest",
        zorder=6,
    )
    ax.add_patch(
        Rectangle(
            (mx, cb_y0 + 444),
            MINI,
            MINI,
            fill=False,
            edgecolor=EDGE,
            linewidth=1.0,
            zorder=7,
        )
    )
    ax.text(
        mx + MINI / 2,
        cb_y0 + 444 + MINI + 14,
        tag,
        color=tcol,
        fontsize=9,
        ha="center",
        va="center",
        zorder=8,
    )
ax.text(
    ccx,
    cb_y1 - 36,
    "two carriers,\none geometry",
    color=AMBER,
    fontsize=11,
    fontweight="bold",
    fontstyle="italic",
    ha="center",
    va="center",
    zorder=8,
)

# ---------------------------------------------------------------- title & footer
ax.text(
    X0 - 26,
    64,
    "TWIN REELS",
    color=INK,
    fontsize=34,
    fontweight="bold",
    ha="left",
    va="center",
    zorder=8,
)
ax.text(
    X0 + 318,
    64,
    "\u2014 the same 12 facts, shot twice",
    color=AMBER,
    fontsize=16,
    ha="left",
    va="center",
    zorder=8,
)
ax.text(
    X0 - 26,
    118,
    "Twelve question\u2013answer pairs enter Qwen2.5-VL-7B twice: once as text, once rendered into pixels. "
    "Each frame is the 12\u00d712 cosine similarity between carrier states at one layer \u2014 "
    "the two reels print the same relational structure from the very first frames.",
    color=MUTED,
    fontsize=11.5,
    ha="left",
    va="center",
    zorder=8,
)

ax.text(
    X0 - 26,
    FOOT_Y,
    "data: results/qwen-carrier-convergence-n12 (carrier_convergence.npz \u00b7 summary.json)   \u00b7   "
    "carrier-centered cosine of hidden states, d = 3584, 29 layers   \u00b7   "
    "RSA = Pearson r over the 66 off-diagonal pairs   \u00b7   "
    "diverging scale \u2212%.2f \u2026 +%.2f (cyan \u2192 dark \u2192 orange)"
    % (VLIM, VLIM),
    color=MUTED,
    fontsize=9,
    ha="left",
    va="center",
    zorder=8,
)

# ---------------------------------------------------------------- save
os.makedirs(OUT_DIR, exist_ok=True)
out_path = os.path.join(OUT_DIR, "filmstrip.png")
fig.savefig(out_path, dpi=100, facecolor=BG)
print("wrote", out_path)
