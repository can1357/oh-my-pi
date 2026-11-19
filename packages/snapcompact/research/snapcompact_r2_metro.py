#!/usr/bin/env python3
"""Snapcompact R2 — "The Convergence Line".

A transit/metro-map diagram of carrier convergence in Qwen2.5-VL-7B.
Two metro lines (cyan = text carrier, orange = image carrier) run through
29 stations (decoder layers L0..L28). The vertical gap between the lines at
each station is driven by real per-layer data:

    gap  ~  1 - matched_cosine   (results/qwen-carrier-convergence-n12/summary.json)

Named stations are grounded in the same summary.json plus
results/qwen-logit-lens-q3/logit_lens.json (visual tok[310] -> 'acular').

Output: results/agent-r2-metro/metro.png (~2200 px wide).
"""

import json
import os

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SUMMARY_PATH = os.path.join(
    HERE, "results", "qwen-carrier-convergence-n12", "summary.json"
)
LENS_PATH = os.path.join(HERE, "results", "qwen-logit-lens-q3", "logit_lens.json")
OUT_DIR = os.path.join(HERE, "results", "agent-r2-metro")
OUT_PNG = os.path.join(OUT_DIR, "metro.png")

# ---------------------------------------------------------------- palette
BG = "#05070a"
PANEL = "#0c1117"
INK = "#f1efe0"
MUTED = "#8f9aa0"
AMBER = "#ffc444"
CYAN = "#4bdcff"
ORANGE = "#ff7048"
GRID = "#0e141b"
MONO = "DejaVu Sans Mono"
SANS = "DejaVu Sans"

MINUS = "\u2212"


def load_data():
    with open(SUMMARY_PATH) as f:
        summary = json.load(f)
    with open(LENS_PATH) as f:
        lens = json.load(f)

    per = summary["per_layer"]
    assert len(per) == summary["layers"] == 29
    assert summary["best_layer"] == 19

    cos = np.array([p["matched_cosine"] for p in per])
    rsa = np.array([p["rsa_pearson"] for p in per])
    acc = np.array([p["match_rank_accuracy"] for p in per])
    mism = np.array([p["mismatched_cosine"] for p in per])

    # logit lens: visual token 310, answer piece 'acular'
    tok310 = {e["layer"]: e for e in lens["lens"] if e["token_index"] == 310}
    assert tok310[24]["top"][0]["str"] == "acular"
    p_acular_24 = tok310[24]["answer_token_p"][1]
    p_acular_28 = tok310[28]["answer_token_p"][1]
    answer = "".join(lens["answer_token_strs"])  # 'spectacular'

    return {
        "summary": summary,
        "cos": cos,
        "rsa": rsa,
        "acc": acc,
        "mism": mism,
        "p24": p_acular_24,
        "p28": p_acular_28,
        "answer": answer,
        "n_q": summary["n_questions"],
        "geometry": summary["geometry"],
        "size_px": summary["args"]["size"],
        "text_em": summary["text_em"],
        "image_em": summary["image_em"],
    }


def catmull_rom(xs, ys, samples=26):
    """Centripetal-ish Catmull-Rom through all points (uniform parameter)."""
    pts = np.column_stack([xs, ys]).astype(float)
    ext = np.vstack([pts[0], pts, pts[-1]])
    out = []
    t = np.linspace(0.0, 1.0, samples, endpoint=False)[:, None]
    for i in range(len(pts) - 1):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        a = 2.0 * p1
        b = p2 - p0
        c = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3
        d = -p0 + 3.0 * p1 - 3.0 * p2 + p3
        out.append(0.5 * (a + b * t + c * t**2 + d * t**3))
    out.append(pts[-1][None])
    return np.vstack(out)


def fmt2(v):
    s = f"{v:.2f}"
    return s.replace("-", MINUS)


def main():
    d = load_data()
    cos = d["cos"]
    n_layers = len(cos)

    # ---- track geometry: gap shrinks as matched cosine rises -------------
    c_min, c_max = float(cos.min()), float(cos.max())  # 0.0 (L0) .. 0.658 (L19)
    GAP_MAX, GAP_MIN = 5.6, 0.78
    t = (cos - c_min) / (c_max - c_min)
    gap = GAP_MAX + (GAP_MIN - GAP_MAX) * t
    xs = np.arange(n_layers, dtype=float)
    y_text = gap / 2.0
    y_img = -gap / 2.0

    # depot stubs before L0
    xs_t = np.concatenate([[-1.5], xs])
    xs_i = np.concatenate([[-1.5], xs])
    yt = np.concatenate([[y_text[0]], y_text])
    yi = np.concatenate([[y_img[0]], y_img])

    path_t = catmull_rom(xs_t, yt)
    path_i = catmull_rom(xs_i, yi)

    # ---- figure ----------------------------------------------------------
    X0, X1 = -2.6, 32.2
    Y0, Y1 = -7.1, 8.3
    W_IN = 22.0
    H_IN = W_IN * (Y1 - Y0) / (X1 - X0)  # equal data aspect
    fig = plt.figure(figsize=(W_IN, H_IN), dpi=100)
    fig.patch.set_facecolor(BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor(BG)
    ax.set_xlim(X0, X1)
    ax.set_ylim(Y0, Y1)
    ax.set_aspect("equal", adjustable="box")
    ax.axis("off")

    pt_per_unit = (W_IN / (X1 - X0)) * 72.0  # ~45.5 pt per data unit

    # faint vertical guides at every station
    for i in range(n_layers):
        ax.plot([i, i], [-3.55, 3.95], color=GRID, lw=1.0, zorder=1)

    # convergence axis
    ax.plot(
        [-1.5, 28.0],
        [0, 0],
        color=MUTED,
        lw=1.0,
        alpha=0.28,
        linestyle=(0, (1, 3)),
        zorder=1,
    )
    ax.text(
        8.0,
        0.16,
        "convergence axis",
        color=MUTED,
        alpha=0.55,
        fontsize=8.5,
        style="italic",
        family=SANS,
        ha="left",
        zorder=2,
    )

    # ---- metro lines: glow, casing, stroke -------------------------------
    for path, col in ((path_t, CYAN), (path_i, ORANGE)):
        px, py = path[:, 0], path[:, 1]
        ax.plot(px, py, color=col, lw=24, alpha=0.05, solid_capstyle="round", zorder=2)
        ax.plot(px, py, color=col, lw=16, alpha=0.07, solid_capstyle="round", zorder=2)
        ax.plot(
            px,
            py,
            color=BG,
            lw=14,
            solid_capstyle="round",
            solid_joinstyle="round",
            zorder=3,
        )
        ax.plot(
            px,
            py,
            color=col,
            lw=9.5,
            solid_capstyle="round",
            solid_joinstyle="round",
            zorder=4,
        )

    # ---- stations ---------------------------------------------------------
    named = {19, 24, 27, 28}
    for i in range(n_layers):
        for y, col in ((y_text[i], CYAN), (y_img[i], ORANGE)):
            if i in named:
                continue
            ax.scatter(
                [i], [y], s=115, facecolor=BG, edgecolor=col, linewidths=2.1, zorder=6
            )

    # L19 interchange capsule (the two lines meet in one station)
    cap_lw_outer = 0.56 * pt_per_unit
    ax.plot(
        [19, 19],
        [y_img[19], y_text[19]],
        color=INK,
        lw=cap_lw_outer,
        solid_capstyle="round",
        zorder=5,
    )
    ax.plot(
        [19, 19],
        [y_img[19], y_text[19]],
        color=PANEL,
        lw=cap_lw_outer - 7.5,
        solid_capstyle="round",
        zorder=5,
    )
    ax.scatter(
        [19, 19],
        [y_text[19], y_img[19]],
        s=92,
        c=[CYAN, ORANGE],
        edgecolor=BG,
        linewidths=1.2,
        zorder=6,
    )

    # L24 interchange ring on the image line (pixels decode to vocabulary)
    ax.scatter(
        [24],
        [y_img[24]],
        s=300,
        facecolor=PANEL,
        edgecolor=INK,
        linewidths=2.8,
        zorder=6,
    )
    ax.scatter([24], [y_img[24]], s=58, facecolor=ORANGE, edgecolor="none", zorder=6)
    ax.scatter(
        [24],
        [y_text[24]],
        s=115,
        facecolor=BG,
        edgecolor=CYAN,
        linewidths=2.1,
        zorder=6,
    )

    # L27 white-ring stations on both lines (terminal approach)
    for y, col in ((y_text[27], CYAN), (y_img[27], ORANGE)):
        ax.scatter(
            [27], [y], s=170, facecolor=PANEL, edgecolor=INK, linewidths=2.3, zorder=6
        )
        ax.scatter([27], [y], s=34, facecolor=col, edgecolor="none", zorder=6)

    # L28 terminus: double ring over both tracks
    ax.add_patch(
        Circle((28, 0), 1.02, facecolor=PANEL, edgecolor=INK, lw=3.2, zorder=5)
    )
    ax.add_patch(
        Circle(
            (28, 0), 0.66, facecolor="none", edgecolor=INK, lw=1.3, alpha=0.85, zorder=5
        )
    )
    ax.scatter(
        [27.78, 28.22],
        [0, 0],
        s=120,
        c=[CYAN, ORANGE],
        edgecolor=BG,
        linewidths=1.4,
        zorder=6,
    )
    ax.text(
        28,
        -0.42,
        "TERMINUS",
        color=MUTED,
        fontsize=6.8,
        family=MONO,
        ha="center",
        va="center",
        zorder=7,
    )

    # ---- carrier labels (depots) ------------------------------------------
    geo = d["geometry"]
    ax.text(
        -1.55,
        y_text[0] + 0.95,
        "TEXT CARRIER",
        color=CYAN,
        fontsize=12.5,
        family=SANS,
        fontweight="bold",
        ha="left",
        zorder=7,
    )
    ax.text(
        -1.55,
        y_text[0] + 0.48,
        f"the page as typed tokens \u00b7 {geo['capacity']:,} chars",
        color=MUTED,
        fontsize=9,
        family=SANS,
        ha="left",
        zorder=7,
    )
    ax.text(
        -1.55,
        y_img[0] - 0.62,
        "IMAGE CARRIER",
        color=ORANGE,
        fontsize=12.5,
        family=SANS,
        fontweight="bold",
        ha="left",
        zorder=7,
    )
    ax.text(
        -1.55,
        y_img[0] - 1.09,
        f"the same page as a {d['size_px']} px bitmap \u00b7 "
        f"{geo['cols']}\u00d7{geo['rows']} cell grid",
        color=MUTED,
        fontsize=9,
        family=SANS,
        ha="left",
        zorder=7,
    )

    # ---- named-station callouts -------------------------------------------
    def leader(x, y_from, y_to, color=MUTED, alpha=0.65):
        ax.plot([x, x], [y_from, y_to], color=color, lw=1.1, alpha=alpha, zorder=6)

    # L1: instant alignment
    leader(1, y_img[1] - 0.18, -2.18)
    ax.text(
        1.7,
        -2.35,
        "L1 \u00b7 INSTANT ALIGNMENT",
        color=INK,
        fontsize=10.5,
        family=SANS,
        fontweight="bold",
        ha="left",
        zorder=7,
    )
    ax.text(
        1.7,
        -2.78,
        f"matched cos {fmt2(cos[1])} \u00b7 RSA {fmt2(d['rsa'][1])}",
        color=MUTED,
        fontsize=8.8,
        family=MONO,
        ha="left",
        zorder=7,
    )
    ax.text(
        1.7,
        -3.14,
        f"retrieval {int(round(d['acc'][1] * 12))}/12 \u2014 12/12 from L2 onward",
        color=MUTED,
        fontsize=8.8,
        family=MONO,
        ha="left",
        zorder=7,
    )

    # L13: first close pass
    leader(13, y_text[13] + 0.18, 1.62)
    ax.text(
        13,
        1.84,
        f"L13 \u00b7 first close pass \u00b7 cos {fmt2(cos[13])}",
        color=MUTED,
        fontsize=8.8,
        family=MONO,
        ha="center",
        zorder=7,
    )

    # L19: geometry locks (star station)
    leader(19, y_text[19] + 0.62, 2.42, color=AMBER, alpha=0.8)
    ax.text(
        19,
        3.42,
        "L19 \u00b7 GEOMETRY LOCKS",
        color=AMBER,
        fontsize=14,
        family=SANS,
        fontweight="bold",
        ha="center",
        zorder=7,
    )
    ax.text(
        19,
        2.96,
        f"matched cos {fmt2(cos[19])} \u00b7 mismatched {fmt2(d['mism'][19])}",
        color=INK,
        fontsize=9.6,
        family=MONO,
        ha="center",
        zorder=7,
    )
    ax.text(
        19,
        2.58,
        f"RSA {fmt2(d['rsa'][19])} \u00b7 retrieval 12/12 \u2014 closest approach",
        color=MUTED,
        fontsize=9.6,
        family=MONO,
        ha="center",
        zorder=7,
    )

    # L23: small drift
    leader(23, y_text[23] + 0.18, 1.30)
    ax.text(
        23,
        1.52,
        f"L23 \u00b7 small drift \u00b7 cos {fmt2(cos[23])}",
        color=MUTED,
        fontsize=8.8,
        family=MONO,
        ha="center",
        zorder=7,
    )

    # L24: pixels decode to vocabulary
    leader(24, y_img[24] - 0.32, -1.92, color=ORANGE, alpha=0.8)
    ax.text(
        24,
        -2.18,
        "L24 \u00b7 PIXELS DECODE TO VOCABULARY",
        color=ORANGE,
        fontsize=12.5,
        family=SANS,
        fontweight="bold",
        ha="center",
        zorder=7,
    )
    ax.text(
        24,
        -2.62,
        f"visual tok[310] top-1 \u2192 'acular' \u00b7 p {d['p24']:.2f}",
        color=INK,
        fontsize=9.4,
        family=MONO,
        ha="center",
        zorder=7,
    )
    ax.text(
        24,
        -3.00,
        f"rising to p {d['p28']:.2f} by L28 \u2014 the answer's second BPE piece",
        color=MUTED,
        fontsize=9.4,
        family=MONO,
        ha="center",
        zorder=7,
    )

    # L27-L28 terminal (block above the terminus circle)
    leader(28, 1.18, 1.86, color=AMBER, alpha=0.8)
    ax.text(
        28,
        3.00,
        "L27\u2013L28 \u00b7 TERMINAL",
        color=INK,
        fontsize=12.5,
        family=SANS,
        fontweight="bold",
        ha="center",
        zorder=7,
    )
    ax.text(
        28,
        2.56,
        f"SAME ANSWER: \u201c{d['answer']}\u201d",
        color=AMBER,
        fontsize=10.5,
        family=SANS,
        fontweight="bold",
        ha="center",
        zorder=7,
    )
    ax.text(
        28,
        2.18,
        f"matched cos {fmt2(cos[27])} \u2192 {fmt2(cos[28])} \u00b7 retrieval 12/12",
        color=MUTED,
        fontsize=8.8,
        family=MONO,
        ha="center",
        zorder=7,
    )

    # ---- station index + matched-cosine gauge rows -------------------------
    hl = {19: AMBER, 24: ORANGE, 27: INK, 28: INK}
    ax.text(
        -0.55,
        -4.45,
        "layer",
        color=MUTED,
        fontsize=8,
        style="italic",
        family=SANS,
        ha="right",
        va="center",
        zorder=7,
    )
    ax.text(
        -0.55,
        -5.02,
        "matched cos",
        color=MUTED,
        fontsize=8,
        style="italic",
        family=SANS,
        ha="right",
        va="center",
        zorder=7,
    )
    for i in range(n_layers):
        col = hl.get(i, MUTED)
        w = "bold" if i in hl else "normal"
        ax.text(
            i,
            -4.45,
            f"L{i}",
            color=col,
            fontsize=7.6,
            family=MONO,
            ha="center",
            va="center",
            fontweight=w,
            zorder=7,
        )
        val = f"{cos[i]:.2f}".lstrip("0")
        ax.text(
            i,
            -5.02,
            val,
            color=col,
            fontsize=7.6,
            family=MONO,
            ha="center",
            va="center",
            fontweight=w,
            zorder=7,
        )

    # ---- title -------------------------------------------------------------
    ax.text(
        -1.9,
        8.05,
        "THE CONVERGENCE LINE",
        color=INK,
        fontsize=29,
        family=SANS,
        fontweight="bold",
        ha="left",
        va="top",
        zorder=7,
    )
    ax.text(
        -1.9,
        6.92,
        "One Wikipedia page, two carriers: typed tokens (cyan) and a "
        f"{d['size_px']} px screenshot (orange) ride Qwen2.5-VL-7B's 29 decoder layers.",
        color=MUTED,
        fontsize=12,
        family=SANS,
        ha="left",
        va="top",
        zorder=7,
    )
    ax.text(
        -1.9,
        6.42,
        "The closer the tracks, the more the two internal representations agree "
        f"\u2014 track gap \u221d 1 {MINUS} matched cosine, n = {d['n_q']} questions.",
        color=MUTED,
        fontsize=12,
        family=SANS,
        ha="left",
        va="top",
        zorder=7,
    )

    # ---- legend (top right) -------------------------------------------------
    lx = 22.9
    ax.plot(
        [lx, lx + 1.3], [7.95, 7.95], color=CYAN, lw=8, solid_capstyle="round", zorder=7
    )
    ax.text(
        lx + 1.65,
        7.95,
        "TEXT CARRIER",
        color=INK,
        fontsize=10,
        family=SANS,
        fontweight="bold",
        ha="left",
        va="center",
        zorder=7,
    )
    ax.plot(
        [lx, lx + 1.3],
        [7.32, 7.32],
        color=ORANGE,
        lw=8,
        solid_capstyle="round",
        zorder=7,
    )
    ax.text(
        lx + 1.65,
        7.32,
        "IMAGE CARRIER",
        color=INK,
        fontsize=10,
        family=SANS,
        fontweight="bold",
        ha="left",
        va="center",
        zorder=7,
    )
    ax.text(
        lx,
        6.62,
        f"track gap \u221d 1 {MINUS} matched cosine(text, image)",
        color=MUTED,
        fontsize=9,
        family=MONO,
        ha="left",
        va="center",
        zorder=7,
    )
    # wide pair = L0
    ax.plot(
        [lx, lx + 1.0], [6.18, 6.18], color=CYAN, lw=4, solid_capstyle="round", zorder=7
    )
    ax.plot(
        [lx, lx + 1.0],
        [5.74, 5.74],
        color=ORANGE,
        lw=4,
        solid_capstyle="round",
        zorder=7,
    )
    ax.text(
        lx + 1.65,
        5.96,
        f"cos {fmt2(cos[0])} \u2014 far apart (L0)",
        color=MUTED,
        fontsize=9,
        family=MONO,
        ha="left",
        va="center",
        zorder=7,
    )
    # tight pair = L19
    ax.plot(
        [lx, lx + 1.0], [5.28, 5.28], color=CYAN, lw=4, solid_capstyle="round", zorder=7
    )
    ax.plot(
        [lx, lx + 1.0],
        [5.14, 5.14],
        color=ORANGE,
        lw=4,
        solid_capstyle="round",
        zorder=7,
    )
    ax.text(
        lx + 1.65,
        5.21,
        f"cos {fmt2(cos[19])} \u2014 almost touching (L19)",
        color=MUTED,
        fontsize=9,
        family=MONO,
        ha="left",
        va="center",
        zorder=7,
    )

    # ---- footer --------------------------------------------------------------
    ax.text(
        -1.9,
        -6.05,
        "Across the same 12 questions the image carrier matches gold answers as often as the text carrier "
        f"\u2014 image EM {d['image_em'] * 100:.1f}% vs text EM {d['text_em'] * 100:.1f}%.",
        color=MUTED,
        fontsize=9.5,
        family=SANS,
        ha="left",
        zorder=7,
    )
    ax.text(
        -1.9,
        -6.58,
        "Data: results/qwen-carrier-convergence-n12/summary.json (29 layers \u00b7 12 SQuAD questions) "
        "+ results/qwen-logit-lens-q3/logit_lens.json \u00b7 Qwen2.5-VL-7B-Instruct \u00b7 agent r2-metro",
        color=MUTED,
        alpha=0.7,
        fontsize=8.5,
        family=MONO,
        ha="left",
        zorder=7,
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    fig.savefig(OUT_PNG, dpi=100, facecolor=BG)
    plt.close(fig)
    print(f"wrote {OUT_PNG}")


if __name__ == "__main__":
    main()
