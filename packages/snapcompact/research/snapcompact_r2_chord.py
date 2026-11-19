#!/usr/bin/env python3
"""Chord/ribbon diagram of cross-carrier matching in Qwen2.5-VL-7B.

Left arc: 12 questions answered via the TEXT carrier (cyan).
Right arc: the same 12 questions answered via the IMAGE carrier (orange).
Ribbons between every (text_i, image_j) pair are sized by the REAL cosine
similarity of the carrier-centered hidden states at layer 19 (negatives
clipped to 0). Matched pairs (i == j) glow amber and visibly dominate.

Data: results/qwen-carrier-convergence-n12/{carrier_convergence.npz,summary.json}
Output: results/agent-r2-chord/chord.png (~2200 px wide)
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "results", "qwen-carrier-convergence-n12")
OUT_DIR = os.path.join(HERE, "results", "agent-r2-chord")
LAYER = 19  # best layer per summary.json

# ---------------------------------------------------------------- palette
BG = "#05070a"
PANEL = "#0c1117"
INK = "#f1efe0"
MUTED = "#8f9aa0"
AMBER = "#ffc444"
CYAN = "#4bdcff"
ORANGE = "#ff7048"
GREEN = "#94ff75"

# ---------------------------------------------------------------- data
npz = np.load(os.path.join(SRC, "carrier_convergence.npz"))
cross = np.asarray(npz["cross_sim"][LAYER], dtype=np.float64)  # [12,12] text x image
with open(os.path.join(SRC, "summary.json")) as fh:
    summary = json.load(fh)
records = summary["records"]
best = summary["best"]
n = cross.shape[0]
assert len(records) == n == 12

labels = [r["gold"] for r in records]
matched_mean = float(np.trace(cross) / n)
mismatched_mean = float((cross.sum() - np.trace(cross)) / (n * n - n))
# retrieval: for each text row, is the matched image column the argmax?
retrieved = int((cross.argmax(axis=1) == np.arange(n)).sum())

w = np.clip(cross, 0.0, None)  # ribbon weights: clip negatives

# ---------------------------------------------------------------- geometry
# Left arc (text carrier): 110deg -> 250deg, top-left to bottom-left.
# Right arc (image carrier): 70deg -> -70deg, mirrored so matched ribbons
# run roughly horizontally across the circle.
R_IN = 0.955  # inner radius where ribbons attach
R_OUT = 1.000  # outer radius of the node band
SEG_DEG = 8.6  # angular width of each node segment
ts = np.linspace(0.0, 1.0, n)
left_centers = 110.0 + ts * 140.0
right_centers = 70.0 - ts * 140.0


def seg_bounds(center_deg):
    return center_deg - SEG_DEG / 2.0, center_deg + SEG_DEG / 2.0


def pol(theta_deg, r):
    a = np.deg2rad(theta_deg)
    return np.array([r * np.cos(a), r * np.sin(a)])


def allocate(centers, weights_per_node):
    """Split each node's segment into sub-spans proportional to ribbon weight.

    weights_per_node: [n, n] -- weights_per_node[i, j] is the weight of the
    ribbon to opposite-side node j, allocated within node i's segment.
    Sub-spans are ordered by the opposite node index so ribbons fan smoothly.
    Returns spans[i][j] = (a0, a1) in degrees (a0 < a1) or None if weight ~ 0.
    """
    spans = []
    for i in range(n):
        lo, hi = seg_bounds(centers[i])
        tot = weights_per_node[i].sum()
        spans_i = [None] * n
        if tot <= 1e-9:
            spans.append(spans_i)
            continue
        cursor = lo
        for j in range(n):
            frac = weights_per_node[i, j] / tot
            width = frac * (hi - lo)
            if weights_per_node[i, j] > 1e-9:
                spans_i[j] = (cursor, cursor + width)
            cursor += width
        spans.append(spans_i)
    return spans


# Left node i sends ribbons to right nodes j with weight w[i, j];
# right node j receives from left nodes i with weight w[i, j].
left_spans = allocate(left_centers, w)
right_spans = allocate(right_centers, w.T)


def arc_points(a0, a1, r, steps=12):
    th = np.linspace(a0, a1, steps)
    return np.stack([r * np.cos(np.deg2rad(th)), r * np.sin(np.deg2rad(th))], axis=1)


def ribbon_path(la, lb, ra, rb, pull=0.18):
    """Filled ribbon: arc(la->lb) on the left rim, cubic bezier to the right
    rim, arc(ra->rb), bezier back. Control points pulled toward the center."""
    p_lb = pol(lb, R_IN)
    p_ra = pol(ra, R_IN)
    p_rb = pol(rb, R_IN)
    p_la = pol(la, R_IN)
    verts = []
    codes = []
    arc1 = arc_points(la, lb, R_IN)
    verts.extend(arc1)
    codes.extend([MplPath.MOVETO] + [MplPath.LINETO] * (len(arc1) - 1))
    # bezier left-edge-end -> right-edge-start
    verts.extend([p_lb * pull, p_ra * pull, p_ra])
    codes.extend([MplPath.CURVE4] * 3)
    arc2 = arc_points(ra, rb, R_IN)[1:]
    verts.extend(arc2)
    codes.extend([MplPath.LINETO] * len(arc2))
    verts.extend([p_rb * pull, p_la * pull, p_la])
    codes.extend([MplPath.CURVE4] * 3)
    codes.append(MplPath.CLOSEPOLY)
    verts.append(p_la)
    return MplPath(verts, codes)


def center_bezier(a_deg, b_deg, pull=0.18, steps=60):
    p0, p3 = pol(a_deg, R_IN), pol(b_deg, R_IN)
    p1, p2 = p0 * pull, p3 * pull
    t = np.linspace(0, 1, steps)[:, None]
    return (
        (1 - t) ** 3 * p0
        + 3 * (1 - t) ** 2 * t * p1
        + 3 * (1 - t) * t**2 * p2
        + t**3 * p3
    )


# ---------------------------------------------------------------- figure
fig = plt.figure(figsize=(22, 16.5), dpi=100, facecolor=BG)
ax = fig.add_axes([0.02, 0.0, 0.96, 0.94])
ax.set_facecolor(BG)
ax.set_xlim(-1.95, 1.95)
ax.set_ylim(-1.32, 1.30)
ax.set_aspect("equal")
ax.axis("off")

w_max = w.max()

# mismatched ribbons first (thin, dim), then matched (amber, glowing) on top
order = sorted(
    ((i, j) for i in range(n) for j in range(n)), key=lambda ij: (ij[0] == ij[1], w[ij])
)
for i, j in order:
    ls, rs = left_spans[i][j], right_spans[j][i]
    if ls is None or rs is None:
        continue
    val = w[i, j]
    matched = i == j
    # right span traversed in reverse so the ribbon doesn't twist
    path = ribbon_path(ls[0], ls[1], rs[1], rs[0])
    if matched:
        # glow: layered strokes along the centerline under the fill
        mid_l = 0.5 * (ls[0] + ls[1])
        mid_r = 0.5 * (rs[0] + rs[1])
        spine = center_bezier(mid_l, mid_r)
        for lw, al in ((26, 0.045), (14, 0.075), (7, 0.12)):
            ax.plot(
                spine[:, 0],
                spine[:, 1],
                color=AMBER,
                lw=lw,
                alpha=al,
                solid_capstyle="round",
                zorder=4,
            )
        ax.add_patch(
            PathPatch(
                path, facecolor=AMBER, edgecolor=AMBER, lw=0.7, alpha=0.78, zorder=5
            )
        )
    else:
        alpha = 0.10 + 0.45 * (val / w_max)
        ax.add_patch(
            PathPatch(
                path, facecolor=MUTED, edgecolor="none", alpha=alpha * 0.55, zorder=2
            )
        )

# ---------------------------------------------------------------- node bands
for i in range(n):
    for centers, color, side in (
        (left_centers, CYAN, "L"),
        (right_centers, ORANGE, "R"),
    ):
        a0, a1 = seg_bounds(centers[i])
        band = arc_points(a0, a1, R_OUT, 16)
        band_in = arc_points(a1, a0, R_IN, 16)
        poly = np.vstack([band, band_in])
        ax.add_patch(
            plt.Polygon(
                poly,
                closed=True,
                facecolor=color,
                edgecolor="none",
                alpha=0.95,
                zorder=6,
            )
        )

# ---------------------------------------------------------------- labels
for i in range(n):
    txt = labels[i]
    for centers, color, ha in (
        (left_centers, CYAN, "right"),
        (right_centers, ORANGE, "left"),
    ):
        c = centers[i]
        p = pol(c, 1.05)
        ax.text(
            p[0],
            p[1],
            txt,
            color=INK,
            fontsize=15.5,
            ha=ha,
            va="center",
            zorder=8,
            family="DejaVu Sans",
        )
        # small question index tick just inside the label
        ax.text(
            p[0] + (0.018 if ha == "left" else -0.018),
            p[1] - 0.052,
            f"Q{i + 1}",
            color=color,
            fontsize=10.5,
            ha=ha,
            va="center",
            alpha=0.85,
            zorder=8,
        )

# arc side headers
ax.text(
    *pol(180, 1.62),
    "TEXT CARRIER",
    color=CYAN,
    fontsize=21,
    ha="center",
    va="center",
    rotation=90,
    weight="bold",
    alpha=0.95,
)
ax.text(
    *pol(180, 1.69),
    "5,219 prose tokens",
    color=MUTED,
    fontsize=13,
    ha="center",
    va="center",
    rotation=90,
)
ax.text(
    *pol(0, 1.62),
    "IMAGE CARRIER",
    color=ORANGE,
    fontsize=21,
    ha="center",
    va="center",
    rotation=-90,
    weight="bold",
    alpha=0.95,
)
ax.text(
    *pol(0, 1.69),
    "same passage, rendered as pixels",
    color=MUTED,
    fontsize=13,
    ha="center",
    va="center",
    rotation=-90,
)

# ---------------------------------------------------------------- titles
fig.text(
    0.5,
    0.965,
    "ONE MEMORY, TWO CARRIERS",
    color=INK,
    fontsize=34,
    ha="center",
    va="center",
    weight="bold",
    family="DejaVu Sans",
)
fig.text(
    0.5,
    0.932,
    "Cross-carrier cosine of answer states at layer 19 -- every text"
    " question finds its image twin (Qwen2.5-VL-7B)",
    color=MUTED,
    fontsize=16.5,
    ha="center",
    va="center",
)

# ---------------------------------------------------------------- stat plate
plate = fig.add_axes([0.035, 0.05, 0.215, 0.135])
plate.set_facecolor(PANEL)
plate.set_xlim(0, 1)
plate.set_ylim(0, 1)
for s in plate.spines.values():
    s.set_color("#1c242e")
plate.set_xticks([])
plate.set_yticks([])
plate.text(
    0.5,
    0.84,
    f"LAYER {LAYER} -- BEST SEPARATION",
    color=MUTED,
    fontsize=12.5,
    ha="center",
    va="center",
)
stats = (
    (f"{matched_mean:+.2f}", "matched cosine", AMBER),
    (f"{mismatched_mean:+.2f}", "mismatched", MUTED),
    (f"{retrieved}/{n}", "retrieval", GREEN),
)
for k, (val, lab, color) in enumerate(stats):
    x = 0.18 + 0.32 * k
    plate.text(
        x, 0.48, val, color=color, fontsize=24, ha="center", va="center", weight="bold"
    )
    plate.text(x, 0.18, lab, color=MUTED, fontsize=12, ha="center", va="center")

# footnote
fig.text(
    0.5,
    0.012,
    "Ribbon width/opacity = cosine(text_state_i, image_state_j),"
    " negatives clipped; amber = matched pair (i = j)."
    f"  RSA r = {best['rsa_pearson']:.2f}.",
    color=MUTED,
    fontsize=12.5,
    ha="center",
    va="center",
)

os.makedirs(OUT_DIR, exist_ok=True)
out_path = os.path.join(OUT_DIR, "chord.png")
fig.savefig(out_path, dpi=100, facecolor=BG)
print(f"wrote {out_path}")
print(
    f"matched={matched_mean:.4f} mismatched={mismatched_mean:.4f} "
    f"retrieval={retrieved}/{n}"
)
