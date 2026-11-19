#!/usr/bin/env python3
"""Hero / OG social card: "Two carriers, one thought."

A single poster composition for the snapcompact blog post: a fragment of the
real text carrier (BPE tokens `spect`+`acular`) on the left, the real bitmap
patch pixels of the same word on the right, both flowing into one glowing
shared core annotated with the real layer-19 convergence stats.

Outputs:
  results/agent-r2-hero/hero-1200x630.png
  results/agent-r2-hero/hero-2400x1260.png

All numbers are read from:
  results/qwen-carrier-convergence-n12/summary.json
  results/qwen-token-entry-q3/token_entry.json
  results/qwen-logit-lens-q3/images/image-carrier.png
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "results" / "agent-r2-hero"

# Layout is specified in 2400x1260 coordinates; the master canvas renders at
# MS x that for antialiasing, then is downsampled to both deliverables.
BASE_W, BASE_H = 2400, 1260
MS = 2
W, H = BASE_W * MS, BASE_H * MS

# Palette (brief).
BG = (5, 7, 10)
PANEL = (12, 17, 23)
INK = (241, 239, 224)
MUTED = (143, 154, 160)
AMBER = (255, 196, 68)
CYAN = (75, 220, 255)
DIVIDER = (26, 34, 44)

CORE_WORD = '"spectacular"'


def u(v: float) -> int:
    return int(round(v * MS))


def font_at(path: str, size: float, index: int = 0) -> ImageFont.FreeTypeFont | None:
    p = Path(path)
    if not p.exists():
        return None
    try:
        return ImageFont.truetype(str(p), u(size), index=index)
    except OSError:
        return None


def display_font(size: float) -> ImageFont.FreeTypeFont:
    """Heavy display face for the title and big stats."""
    for path, index in [
        ("/System/Library/Fonts/Avenir Next.ttc", 8),  # Heavy
        ("/System/Library/Fonts/Supplemental/Arial Black.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
    ]:
        f = font_at(path, size, index)
        if f is not None:
            return f
    return ImageFont.load_default()


def label_font(size: float) -> ImageFont.FreeTypeFont:
    for path, index in [
        ("/System/Library/Fonts/Avenir Next.ttc", 2),  # Demi Bold
        ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
    ]:
        f = font_at(path, size, index)
        if f is not None:
            return f
    return ImageFont.load_default()


def body_font(size: float) -> ImageFont.FreeTypeFont:
    for path, index in [
        ("/System/Library/Fonts/Avenir Next.ttc", 5),  # Medium
        ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
    ]:
        f = font_at(path, size, index)
        if f is not None:
            return f
    return ImageFont.load_default()


def mono_font(size: float) -> ImageFont.FreeTypeFont:
    for path in [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        f = font_at(path, size)
        if f is not None:
            return f
    return ImageFont.load_default()


def tracked(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font,
    fill,
    tracking: float = 0.0,
) -> int:
    """Draw text with letterspacing; returns end x."""
    x, y = xy
    t = u(tracking)
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + t
    return int(x)


def tracked_width(
    draw: ImageDraw.ImageDraw, text: str, font, tracking: float = 0.0
) -> float:
    t = u(tracking)
    return sum(draw.textlength(ch, font=font) + t for ch in text) - (t if text else 0)


def bezier(p0, p1, p2, n=64):
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def load_data():
    conv = json.loads(
        (ROOT / "results" / "qwen-carrier-convergence-n12" / "summary.json").read_text()
    )
    entry = json.loads(
        (ROOT / "results" / "qwen-token-entry-q3" / "token_entry.json").read_text()
    )
    carrier = Image.open(
        ROOT / "results" / "qwen-logit-lens-q3" / "images" / "image-carrier.png"
    ).convert("RGB")
    if carrier.size != (1568, 1568):
        carrier = carrier.resize((1568, 1568), Image.LANCZOS)

    best = conv["best"]
    layer = conv["best_layer"]
    n_q = conv["n_questions"]
    stats = {
        "layer": layer,
        "n_layers": conv["layers"],
        "matched": best["matched_cosine"],
        "rsa": best["rsa_pearson"],
        "retrieved": int(round(best["match_rank_accuracy"] * n_q)),
        "n": n_q,
    }
    assert stats["layer"] == 19 and abs(stats["matched"] - 0.66) < 0.01
    assert (
        abs(stats["rsa"] - 0.85) < 0.01
        and stats["retrieved"] == 12
        and stats["n"] == 12
    )

    toks = {t["i"]: t for t in entry["tokens"]}
    answer = [t for t in entry["tokens"] if t["answer"]]
    assert [t["str"] for t in answer] == ["spect", "acular"]
    assert [t["id"] for t in answer] == [67082, 23006]
    ctx_before = "…" + "".join(
        toks[i]["str"] for i in range(23, 32)
    )  # " make the 50th Super Bowl \""
    ctx_after = (
        "".join(toks[i]["str"] for i in range(34, 39)) + "…"
    )  # "\" and that it would"

    grid = entry["image_grid"]  # 56
    word_idx = entry["image_answer_token_indices"][:4]  # [310, 311, 312, 313]
    assert word_idx == [310, 311, 312, 313]
    assert word_idx[0] // grid == 5 and word_idx[0] % grid == 30

    counts = {
        "chars": entry["chunk_chars"],
        "text_tokens": entry["chunk_text_tokens"],
        "image_tokens": entry["image_tokens"],
        "grid": grid,
        "patch_px": entry["token_pixel_size"],  # 28
        "embed_dim": entry["embed_dim"],
        "visual_dim": entry["visual_out_dim"],
    }
    heads = {
        "text": entry["text_entry"][0],  # id 67082 "spect": 10-dim head + norm
        "image": entry["image_entry"][0],  # patch 310: 10-dim head + norm
    }
    assert heads["text"]["id"] == 67082 and heads["image"]["token_index"] == 310
    return stats, answer, (ctx_before, ctx_after), word_idx, counts, heads, carrier


# ---------------------------------------------------------------------------
# Composition geometry (2400x1260 space)
# ---------------------------------------------------------------------------
CORE = (1200, 660)
PANEL_TOP, PANEL_BOT = 332, 938
LP = (92, PANEL_TOP, 782, PANEL_BOT)  # left panel
RP = (1618, PANEL_TOP, 2308, PANEL_BOT)  # right panel


def additive_base() -> np.ndarray:
    """Background + ambient glow + orb fields + streamlines, all additive."""
    img = np.zeros((H, W, 3), dtype=np.float32)
    img[:] = BG

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = u(CORE[0]), u(CORE[1])
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)

    # Ambient: amber wash on the left, cyan on the right, strongest near core.
    side = np.clip((xx - cx) / u(900), -1.0, 1.0)
    amber = np.array(AMBER, np.float32) / 255.0
    cyan = np.array(CYAN, np.float32) / 255.0
    mix = (1 - side[..., None]) / 2 * amber + (1 + side[..., None]) / 2 * cyan
    img += 26.0 * mix * np.exp(-((d / u(760)) ** 2))[..., None]

    # Orb halo and warm nucleus (kept below blowout so the word stays legible).
    img += 92.0 * mix * np.exp(-((d / u(250)) ** 2))[..., None]
    warm = np.array((255, 240, 205), np.float32) / 255.0
    img += 96.0 * warm * np.exp(-((d / u(118)) ** 2))[..., None]

    # Subtle vignette.
    ex = ((xx / W) - 0.5) ** 2 + ((yy / H) - 0.5) ** 2
    img *= (1.0 - 0.55 * ex)[..., None]

    # Streamlines: each carrier feeds the core.
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    sharp = Image.new("RGB", (W, H), (0, 0, 0))
    sd = ImageDraw.Draw(sharp)
    rng = np.random.default_rng(19)

    def streams(x0: float, x_sign: float, color):
        n = 9
        for k in range(n):
            f = k / (n - 1)
            y0 = (
                PANEL_TOP
                + 120
                + f * (PANEL_BOT - PANEL_TOP - 240)
                + rng.uniform(-14, 14)
            )
            ang = (f - 0.5) * 1.45 + rng.uniform(-0.07, 0.07)
            r = 168
            x2 = CORE[0] - x_sign * r * math.cos(ang)
            y2 = CORE[1] + r * math.sin(ang)
            mid_x = (x0 + x2) / 2 + x_sign * 36
            mid_y = y0 + (CORE[1] - y0) * 0.62
            pts = bezier((x0, y0), (mid_x, mid_y), (x2, y2), 72)
            spts = [(u(px), u(py)) for px, py in pts]
            fade = 1.0 - abs(f - 0.5) * 0.9
            gd.line(spts, fill=tuple(int(c * 0.62 * fade) for c in color), width=u(7))
            sd.line(spts, fill=tuple(int(c * 0.5 * fade) for c in color), width=u(1.6))
            # Energy particles along the stream.
            for t in (0.3, 0.55, 0.8):
                i = int(t * len(pts))
                px, py = u(pts[i][0]), u(pts[i][1])
                rr = u(3.2)
                gd.ellipse(
                    [px - rr, py - rr, px + rr, py + rr],
                    fill=tuple(int(c * fade) for c in color),
                )

    streams(LP[2], 1.0, AMBER)
    streams(RP[0], -1.0, CYAN)

    img += np.asarray(glow.filter(ImageFilter.GaussianBlur(u(11))), np.float32) * 0.9
    img += np.asarray(sharp.filter(ImageFilter.GaussianBlur(u(0.7))), np.float32)

    # Soft glow behind the core word (the sharp pass is drawn later, on top).
    f = display_font(78)
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    ld = ImageDraw.Draw(layer)
    tw = ld.textlength(CORE_WORD, font=f)
    ld.text(
        (u(CORE[0]) - tw / 2, u(CORE[1] - 54)), CORE_WORD, font=f, fill=(255, 232, 170)
    )
    img += np.asarray(layer.filter(ImageFilter.GaussianBlur(u(9))), np.float32) * 0.8
    return img


def head_bars(
    ov: ImageDraw.ImageDraw, x: float, y_mid: float, values, color, label: str
):
    """Tiny bar strip of a real 10-dim vector head, centered on its axis."""
    vmax = max(abs(v) for v in values)
    bw, gap, amp = 24, 11, 26
    total = len(values) * (bw + gap) - gap
    ov.line([u(x), u(y_mid), u(x + total), u(y_mid)], fill=(*MUTED, 80), width=u(1))
    for i, v in enumerate(values):
        bx = x + i * (bw + gap)
        h = (v / vmax) * amp
        y0, y1 = sorted((y_mid, y_mid - h))
        a = 120 + int(135 * abs(v) / vmax)
        ov.rectangle([u(bx), u(y0), u(bx + bw), u(y1)], fill=(*color, a))
    f = mono_font(17)
    tracked(ov, (u(x), u(y_mid - amp - 36)), label, f, (*MUTED, 255), tracking=0.5)


def draw_left_panel(ov: ImageDraw.ImageDraw, answer, ctx, counts, heads):
    x0, y0, x1, _ = LP
    pad = 44
    ctx_before, ctx_after = ctx

    tracked(
        ov, (u(x0 + pad), u(y0 + 34)), "TEXT CARRIER", label_font(30), AMBER, tracking=5
    )
    sub = f"{counts['text_tokens']:,} BPE TOKENS"
    f_sub = label_font(21)
    tracked(
        ov,
        (int(u(x1 - pad) - tracked_width(ov, sub, f_sub, 2)), u(y0 + 42)),
        sub,
        f_sub,
        MUTED,
        tracking=2,
    )
    ov.line(
        [u(x0 + pad), u(y0 + 88), u(x1 - pad), u(y0 + 88)],
        fill=(*DIVIDER, 255),
        width=u(1.2),
    )

    f_ctx = mono_font(23)
    ov.text((u(x0 + pad), u(y0 + 116)), ctx_before, font=f_ctx, fill=(110, 118, 126))

    # The two answer-token pills.
    f_tok = mono_font(58)
    f_id = mono_font(20)
    px = x0 + pad
    py = y0 + 184
    for t in answer:
        s = t["str"]
        wpx = ov.textlength(s, font=f_tok) / MS
        ov.rounded_rectangle(
            [u(px), u(py), u(px + wpx + 40), u(py + 96)],
            radius=u(14),
            fill=(38, 29, 10, 235),
            outline=(*AMBER, 165),
            width=u(1.6),
        )
        ov.text((u(px + 20), u(py + 14)), s, font=f_tok, fill=(255, 224, 150))
        ov.text(
            (u(px + 20), u(py + 110)), f"id {t['id']}", font=f_id, fill=(196, 156, 72)
        )
        px += wpx + 40 + 22

    ov.text((u(x0 + pad), u(y0 + 330)), ctx_after, font=f_ctx, fill=(110, 118, 126))

    th = heads["text"]
    head_bars(
        ov,
        x0 + pad,
        y0 + 452,
        th["vector_head"],
        AMBER,
        f"embedding row {th['id']} · dims 0-9 of {counts['embed_dim']:,} · norm {th['norm']:.2f}",
    )

    fy = y0 + 500
    f_fact = body_font(23)
    ov.text(
        (u(x0 + pad), u(fy)),
        f"{counts['chars']:,} characters of one SQuAD passage,",
        font=f_fact,
        fill=MUTED,
    )
    ov.text(
        (u(x0 + pad), u(fy + 36)),
        f"tokenized into {counts['text_tokens']:,} ids, each a {counts['embed_dim']:,}-dim row",
        font=f_fact,
        fill=MUTED,
    )


def draw_right_panel(
    base_img: Image.Image,
    ov: ImageDraw.ImageDraw,
    carrier: Image.Image,
    word_idx,
    counts,
    heads,
):
    x0, y0, x1, _ = RP
    pad = 44

    tracked(
        ov, (u(x0 + pad), u(y0 + 34)), "IMAGE CARRIER", label_font(30), CYAN, tracking=5
    )
    sub = f"{counts['image_tokens']:,} PATCHES"
    f_sub = label_font(21)
    tracked(
        ov,
        (int(u(x1 - pad) - tracked_width(ov, sub, f_sub, 2)), u(y0 + 42)),
        sub,
        f_sub,
        MUTED,
        tracking=2,
    )
    ov.line(
        [u(x0 + pad), u(y0 + 88), u(x1 - pad), u(y0 + 88)],
        fill=(*DIVIDER, 255),
        width=u(1.2),
    )

    # Crop: patch rows 4..8, cols 27..38 of the 56x56 grid (28px cells).
    pp = counts["patch_px"]
    c0, c1, r0, r1 = 27, 38, 4, 8
    crop = carrier.crop((c0 * pp, r0 * pp, c1 * pp, r1 * pp))  # 308 x 112

    scale = 2.0  # 28px cell -> 56px on the 2400 canvas
    disp_w, disp_h = int(crop.width * scale), int(crop.height * scale)
    big = crop.resize((u(disp_w), u(disp_h)), Image.NEAREST)
    big = Image.eval(big, lambda v: int(v * 0.84))  # dim so the highlight pops
    bx, by = x0 + pad, y0 + 122
    base_img.paste(big, (u(bx), u(by)))

    cell = pp * scale  # 56 in 2400-space
    grid_color = (CYAN[0], CYAN[1], CYAN[2], 46)
    for c in range(c1 - c0 + 1):
        ov.line(
            [u(bx + c * cell), u(by), u(bx + c * cell), u(by + disp_h)],
            fill=grid_color,
            width=u(1),
        )
    for r in range(r1 - r0 + 1):
        ov.line(
            [u(bx), u(by + r * cell), u(bx + disp_w), u(by + r * cell)],
            fill=grid_color,
            width=u(1),
        )

    # Highlight the four answer patches (grid row 5, cols 30..33) as one run.
    grid = counts["grid"]
    gr, gc = word_idx[0] // grid, word_idx[0] % grid
    hx, hy = bx + (gc - c0) * cell, by + (gr - r0) * cell
    hw = len(word_idx) * cell
    ov.rectangle(
        [u(hx), u(hy), u(hx + hw), u(hy + cell)], outline=(*CYAN, 240), width=u(2.4)
    )
    for k in range(1, len(word_idx)):
        ov.line(
            [u(hx + k * cell), u(hy), u(hx + k * cell), u(hy + cell)],
            fill=(*CYAN, 130),
            width=u(1.2),
        )

    ov.text(
        (u(bx), u(by + disp_h + 18)),
        f"patches {word_idx[0]}-{word_idx[-1]} · grid row 5, cols 30-33 of {grid}×{grid}",
        font=body_font(23),
        fill=MUTED,
    )

    ih = heads["image"]
    head_bars(
        ov,
        bx,
        y0 + 460,
        ih["vector_head"],
        CYAN,
        f"patch {ih['token_index']} vector · dims 0-9 of {counts['visual_dim']:,} · norm {ih['norm']:.1f}",
    )

    fy = y0 + 500
    f_fact = body_font(23)
    ov.text(
        (u(bx), u(fy)),
        "the same passage, rendered to a 1568 × 1568 px bitmap,",
        font=f_fact,
        fill=MUTED,
    )
    ov.text(
        (u(bx), u(fy + 36)),
        f"seen as {counts['image_tokens']:,} patches of {counts['patch_px']} px, each a {counts['visual_dim']:,}-dim vector",
        font=f_fact,
        fill=MUTED,
    )


def draw_title(ov: ImageDraw.ImageDraw):
    kicker = "INSIDE QWEN2.5-VL · ONE FACT, TWO ENCODINGS"
    f_k = label_font(24)
    kw = tracked_width(ov, kicker, f_k, 7)
    tracked(ov, (int((W - kw) / 2), u(64)), kicker, f_k, MUTED, tracking=7)

    f_t = display_font(96)
    a, b = "TWO CARRIERS, ", "ONE THOUGHT."
    wa, wb = ov.textlength(a, font=f_t), ov.textlength(b, font=f_t)
    x = (W - wa - wb) / 2
    y = u(122)
    ov.text((x, y), a, font=f_t, fill=INK)
    ov.text((x + wa, y), b, font=f_t, fill=AMBER)


def draw_core(ov: ImageDraw.ImageDraw, stats):
    f = display_font(78)
    tw = ov.textlength(CORE_WORD, font=f)
    ov.text(
        (u(CORE[0]) - tw / 2, u(CORE[1] - 54)),
        CORE_WORD,
        font=f,
        fill=(255, 248, 226),
        stroke_width=u(1.4),
        stroke_fill=(64, 44, 12, 160),
    )
    cap = f"BY LAYER {stats['layer']} OF {stats['n_layers'] - 1}, ONE SHARED STATE"
    f_c = label_font(23)
    cw = tracked_width(ov, cap, f_c, 4)
    tracked(
        ov,
        (int(u(CORE[0]) - cw / 2), u(CORE[1] + 96)),
        cap,
        f_c,
        (228, 222, 196),
        tracking=4,
    )


def draw_stats_strip(ov: ImageDraw.ImageDraw, stats):
    y_div = 992
    ov.line([u(92), u(y_div), u(2308), u(y_div)], fill=(*DIVIDER, 255), width=u(1.4))

    groups = [
        (f"{stats['matched']:.2f}", "MATCHED COSINE · TEXT VS IMAGE", AMBER),
        (f"{stats['rsa']:.2f}", "RSA · SAME RELATIONAL GEOMETRY", INK),
        (f"{stats['retrieved']}/{stats['n']}", "CROSS-CARRIER RETRIEVAL", CYAN),
    ]
    centers = [500, 1200, 1900]
    f_num = display_font(66)
    f_cap = label_font(21)
    for (num, cap, color), cx in zip(groups, centers):
        nw = ov.textlength(num, font=f_num)
        ov.text((u(cx) - nw / 2, u(1024)), num, font=f_num, fill=color)
        cw = tracked_width(ov, cap, f_cap, 3)
        tracked(ov, (int(u(cx) - cw / 2), u(1136)), cap, f_cap, MUTED, tracking=3)
    for dx in (850, 1550):
        ov.line([u(dx), u(1040), u(dx), u(1170)], fill=(*DIVIDER, 255), width=u(1.2))

    foot = f"measured at layer {stats['layer']} · {stats['n']} SQuAD questions · carrier-convergence"
    f_f = body_font(19)
    fw = ov.textlength(foot, font=f_f)
    ov.text(((W - fw) / 2, u(1206)), foot, font=f_f, fill=(92, 101, 108))


def rounded_panel(overlay: ImageDraw.ImageDraw, box, accent, alpha_fill=216):
    x0, y0, x1, y1 = (u(v) for v in box)
    r = u(22)
    overlay.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=(*PANEL, alpha_fill))
    overlay.rounded_rectangle(
        [x0, y0, x1, y1], radius=r, outline=(*accent, 70), width=u(1.4)
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stats, answer, ctx, word_idx, counts, heads, carrier = load_data()

    base = Image.fromarray(np.clip(additive_base(), 0, 255).astype(np.uint8), "RGB")

    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ov = ImageDraw.Draw(overlay)
    rounded_panel(ov, LP, AMBER)
    rounded_panel(ov, RP, CYAN)
    base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")

    # Panel contents drawn on a fresh overlay so the bitmap paste sits beneath grids.
    overlay2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ov2 = ImageDraw.Draw(overlay2)
    draw_title(ov2)
    draw_left_panel(ov2, answer, ctx, counts, heads)
    draw_right_panel(base, ov2, carrier, word_idx, counts, heads)
    draw_core(ov2, stats)
    draw_stats_strip(ov2, stats)
    final = Image.alpha_composite(base.convert("RGBA"), overlay2).convert("RGB")

    retina = final.resize((2400, 1260), Image.LANCZOS)
    og = final.resize((1200, 630), Image.LANCZOS)
    retina.save(OUT_DIR / "hero-2400x1260.png")
    og.save(OUT_DIR / "hero-1200x630.png")
    print(f"wrote {OUT_DIR / 'hero-2400x1260.png'} {retina.size}")
    print(f"wrote {OUT_DIR / 'hero-1200x630.png'} {og.size}")


if __name__ == "__main__":
    main()
