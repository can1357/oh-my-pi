#!/usr/bin/env python3
"""Crystallization: a pixel patch becomes a vocabulary token.

Animated logit-lens GIF for Qwen2.5-VL-7B. Steps through layers L0..L28 for
visual token #310 of the image carrier (the 28x28 patch covering the rendered
word "spectacular"), showing the REAL top-5 decoded vocab tokens per layer and
the probability of the answer BPE 'acular', which stays ~0 until L24 then
climbs 0.14 -> 0.39 at L28. A control patch (token #1878) is shown alongside
and stays noise. All numbers are read from logit_lens.json; nothing is
fabricated.

Output: results/agent-r2-crystal/crystal.gif (+ crystal_final.png)
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = Path(__file__).resolve().parent
DATA = BASE / "results/qwen-logit-lens-q3/logit_lens.json"
CARRIER = BASE / "results/qwen-logit-lens-q3/images/image-carrier.png"
OUT_DIR = BASE / "results/agent-r2-crystal"

# ---------------------------------------------------------------- palette
BG = (5, 7, 10)
PANEL = (12, 17, 23)
PANEL_EDGE = (28, 36, 46)
INK = (241, 239, 224)
MUTED = (143, 154, 160)
DIM = (80, 90, 98)
AMBER = (255, 196, 68)
CYAN = (75, 220, 255)
GREEN = (148, 255, 117)

W, H = 1200, 720
TOKEN_IDX = 310
ANSWER_BPE = "acular"
ANSWER_SLOT = 1  # answer_token_p[1] == p('acular')

# ---------------------------------------------------------------- fonts
MENLO = "/System/Library/Fonts/Menlo.ttc"
UNI = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size, index=index)
    except OSError:
        return ImageFont.truetype(MENLO, size)


F_TITLE = font(MENLO, 30, index=1)
F_SUB = font(MENLO, 15)
F_LABEL = font(MENLO, 13)
F_LABEL_B = font(MENLO, 13, index=1)
F_TINY = font(MENLO, 11)
F_LAYER = font(MENLO, 64, index=1)
F_STAGE = font(MENLO, 16, index=1)
F_NUM = font(MENLO, 14)
F_TOK = font(UNI, 18)
F_TOK_B = font(MENLO, 18, index=1)
F_TOK_S = font(UNI, 14)
F_BADGE = font(MENLO, 17, index=1)


def load() -> tuple[dict, list[dict], list[dict]]:
    data = json.loads(DATA.read_text())
    assert data["layers"] == 29 and data["image_grid"] == 56
    assert data["answer_token_strs"][ANSWER_SLOT] == ANSWER_BPE

    def by_layer(idx: int) -> list[dict]:
        return sorted(
            (e for e in data["lens"] if e["token_index"] == idx),
            key=lambda e: e["layer"],
        )

    target = by_layer(TOKEN_IDX)
    control = by_layer(data["control_indices"][0])
    assert len(target) == 29 and len(control) == 29
    return data, target, control


def crop_cell(carrier: Image.Image, idx: int) -> Image.Image:
    r, c = idx // 56, idx % 56
    return carrier.crop((c * 28, r * 28, (c + 1) * 28, (r + 1) * 28))


def sanitize(s: str) -> str:
    out = "".join(ch if ch.isprintable() else "\ufffd" for ch in s)
    return out.replace(" ", "\u2423", 1) if s.startswith(" ") else out


def text_w(f: ImageFont.FreeTypeFont, s: str) -> float:
    return f.getlength(s)


STAGES = [
    (0, "static"),
    (8, "gibberish"),
    (16, "morphemes"),
    (23, "warming up"),
    (24, "lock-on"),
    (28, "crystallized"),
]


def stage_for(layer: int) -> str:
    name = STAGES[0][1]
    for lo, label in STAGES:
        if layer >= lo:
            name = label
    return name


def render_frame(
    layer: int,
    data: dict,
    target: list[dict],
    control: list[dict],
    patch: Image.Image,
    ctrl_patch: Image.Image,
    strip: Image.Image,
    strip_cell: int,
) -> Image.Image:
    e = target[layer]
    ce = control[layer]
    p_ans = e["answer_token_p"][ANSWER_SLOT]
    p_ctrl = ce["answer_token_p"][ANSWER_SLOT]
    locked = layer >= 24
    final = layer == 28
    heat = min(1.0, p_ans / 0.40)  # glow scales with the real probability

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ---------------------------------------------------------- header
    d.text((40, 22), "CRYSTALLIZATION", font=F_TITLE, fill=INK)
    tw = text_w(F_TITLE, "CRYSTALLIZATION")
    d.text(
        (40 + tw + 18, 36),
        "\u2014 28\u00d728 pixels become the token '" + ANSWER_BPE + "'",
        font=F_SUB,
        fill=MUTED,
    )
    d.text(
        (40, 60),
        "logit lens on Qwen2.5-VL-7B \u00b7 image carrier 1568px \u00b7 visual token "
        f"#{TOKEN_IDX} (grid {e['grid_rc'][0]},{e['grid_rc'][1]}) \u00b7 "
        "answer \u201cspectacular\u201d = [spect][acular]",
        font=F_SUB,
        fill=MUTED,
    )
    if final:  # celebratory badge in the free top-right corner
        badge = f"'{ANSWER_BPE}' \u00b7 p={p_ans:.2f} \u00b7 CRYSTALLIZED"
        bw = text_w(F_BADGE, badge)
        bx = W - bw - 76
        d.rounded_rectangle(
            (bx, 22, bx + bw + 36, 56),
            radius=17,
            fill=(38, 30, 10),
            outline=AMBER,
            width=2,
        )
        d.text((bx + 18, 29), badge, font=F_BADGE, fill=AMBER)

    # ---------------------------------------------------------- context strip
    sx, sy = (W - strip.width) // 2, 96
    img.paste(strip, (sx, sy))
    d.rectangle(
        (sx, sy, sx + strip.width - 1, sy + strip.height - 1), outline=PANEL_EDGE
    )
    col = AMBER if locked else CYAN
    d.rectangle(
        (sx + strip_cell, sy, sx + strip_cell + strip.height, sy + strip.height - 1),
        outline=col,
        width=3,
    )
    cap = "carrier row 5 \u00b7 the model never sees glyphs \u2014 only these pixels"
    d.text(
        ((W - text_w(F_TINY, cap)) / 2, sy + strip.height + 6),
        cap,
        font=F_TINY,
        fill=DIM,
    )

    # ---------------------------------------------------------- main row
    top_y = 232
    # patch panel ------------------------------------------------------
    px, py, ps = 40, top_y, 280
    img.paste(patch.resize((ps, ps), Image.NEAREST), (px, py))
    d.rectangle((px - 1, py - 1, px + ps, py + ps), outline=col, width=2)
    d.text((px, py + ps + 10), f"visual token #{TOKEN_IDX}", font=F_LABEL_B, fill=INK)
    d.text(
        (px, py + ps + 28),
        '28\u00d728 px \u00b7 reads: \u2018"sp\u2019 / \u2018and\u2019',
        font=F_TINY,
        fill=MUTED,
    )

    # layer counter ----------------------------------------------------
    cx = 392
    d.text((cx, top_y - 2), "LAYER", font=F_LABEL, fill=MUTED)
    num = f"{layer:02d}"
    d.text((cx, top_y + 16), num, font=F_LAYER, fill=AMBER if locked else INK)
    d.text((cx + text_w(F_LAYER, num) + 8, top_y + 58), "/28", font=F_STAGE, fill=DIM)
    stage = stage_for(layer)
    d.text(
        (cx, top_y + 98),
        stage.upper(),
        font=F_STAGE,
        fill=GREEN if final else (AMBER if locked else MUTED),
    )
    ry = top_y + 134  # mini rail of 29 ticks
    for i in range(29):
        tx = cx + i * 5
        d.rectangle(
            (tx, ry, tx + 3, ry + 10), fill=AMBER if i <= layer else (40, 48, 58)
        )
    d.text(
        (cx, ry + 18),
        f"p('{ANSWER_BPE}') = {p_ans:.4f}",
        font=F_NUM,
        fill=AMBER if p_ans > 0.01 else DIM,
    )

    # top-5 panel ------------------------------------------------------
    tx0, ty0, tx1, ty1 = 580, top_y - 12, 1160, top_y + 318
    d.rounded_rectangle((tx0, ty0, tx1, ty1), radius=8, fill=PANEL, outline=PANEL_EDGE)
    d.text(
        (tx0 + 18, ty0 + 12),
        "TOP-5 DECODED VOCAB TOKENS \u00b7 what this patch \u201cmeans\u201d so far",
        font=F_LABEL,
        fill=MUTED,
    )
    bar_x = tx0 + 230
    bar_max = tx1 - bar_x - 86
    scale = 0.45  # fixed probability scale across all frames
    for i, t in enumerate(e["top"]):
        yy = ty0 + 48 + i * 54
        is_ans = t["id"] in data["answer_token_ids"]
        tok_s = sanitize(t["str"])
        if len(tok_s) > 16:
            tok_s = tok_s[:15] + "\u2026"
        d.text(
            (tx0 + 18, yy),
            f"'{tok_s}'",
            font=F_TOK_B if is_ans else F_TOK,
            fill=AMBER if is_ans else INK,
        )
        bw = max(2, int(min(t["p"] / scale, 1.0) * bar_max))
        d.rectangle(
            (bar_x, yy + 4, bar_x + bw, yy + 18), fill=AMBER if is_ans else (58, 70, 84)
        )
        if is_ans and heat > 0.3:
            d.rectangle((bar_x, yy + 4, bar_x + bw, yy + 18), outline=INK)
        d.text(
            (bar_x + bw + 10, yy + 3),
            f"{t['p']:.3f}",
            font=F_NUM,
            fill=AMBER if is_ans else MUTED,
        )
        d.text((tx0 + 18, yy + 24), f"id {t['id']}", font=F_TINY, fill=DIM)

    # ---------------------------------------------------------- bottom row
    by0, by1 = 596, 708
    # confidence meter for 'acular'
    mx0, mx1 = 40, 730
    d.rounded_rectangle((mx0, by0, mx1, by1), radius=8, fill=PANEL, outline=PANEL_EDGE)
    d.text(
        (mx0 + 16, by0 + 8),
        f"CONFIDENCE \u00b7 p('{ANSWER_BPE}') across layers",
        font=F_LABEL,
        fill=MUTED,
    )
    leg_x = mx1 - 130
    d.rectangle((leg_x, by0 + 12, leg_x + 14, by0 + 15), fill=AMBER)
    d.text((leg_x + 20, by0 + 6), "answer", font=F_TINY, fill=AMBER)
    d.rectangle((leg_x + 74, by0 + 12, leg_x + 88, by0 + 15), fill=(60, 70, 80))
    d.text((leg_x + 94, by0 + 6), "ctrl", font=F_TINY, fill=(96, 108, 118))
    ch_x0, ch_x1 = mx0 + 52, mx1 - 64
    ch_y0, ch_y1 = by0 + 32, by1 - 22
    p_max = 0.45
    d.line((ch_x0, ch_y1, ch_x1, ch_y1), fill=PANEL_EDGE)
    for gv in (0.2, 0.4):
        gy = ch_y1 - gv / p_max * (ch_y1 - ch_y0)
        d.line((ch_x0, gy, ch_x1, gy), fill=(22, 28, 36))
        d.text((mx0 + 16, gy - 6), f"{gv:.1f}", font=F_TINY, fill=DIM)

    def xs(l: int) -> float:
        return ch_x0 + l / 28 * (ch_x1 - ch_x0)

    def ys(p: float) -> float:
        return ch_y1 - min(p, p_max) / p_max * (ch_y1 - ch_y0)

    pts = [
        (xs(l), ys(target[l]["answer_token_p"][ANSWER_SLOT])) for l in range(layer + 1)
    ]
    cpts = [
        (xs(l), ys(control[l]["answer_token_p"][ANSWER_SLOT])) for l in range(layer + 1)
    ]
    if len(cpts) > 1:
        d.line(cpts, fill=(60, 70, 80), width=2)
    if len(pts) > 1:
        poly = pts + [(pts[-1][0], ch_y1), (pts[0][0], ch_y1)]
        d.polygon(poly, fill=(76, 56, 16) if locked else (46, 36, 14))
        d.line(pts, fill=AMBER, width=3)
    hx, hy = pts[-1]
    d.ellipse((hx - 5, hy - 5, hx + 5, hy + 5), fill=AMBER if p_ans > 0.01 else MUTED)
    head = f"{p_ans:.2f}" if p_ans >= 0.005 else f"{p_ans:.4f}"
    d.text(
        (min(hx + 8, ch_x1 - 8), hy - 18),
        head,
        font=F_NUM,
        fill=AMBER if p_ans > 0.01 else MUTED,
    )
    for ml in (24, 28):
        if layer >= ml:
            mlx = xs(ml)
            d.line(
                (mlx, ch_y1, mlx, ys(target[ml]["answer_token_p"][ANSWER_SLOT])),
                fill=(90, 72, 30),
            )
            d.text((mlx - 10, ch_y1 + 6), f"L{ml}", font=F_TINY, fill=AMBER)
    d.text((ch_x0, ch_y1 + 6), "L0", font=F_TINY, fill=DIM)

    # control panel ----------------------------------------------------
    kx0, kx1 = 760, 1160
    d.rounded_rectangle((kx0, by0, kx1, by1), radius=8, fill=PANEL, outline=PANEL_EDGE)
    d.text(
        (kx0 + 16, by0 + 8),
        "CONTROL \u00b7 token #" + str(ce["token_index"]),
        font=F_LABEL,
        fill=MUTED,
    )
    cps = 60
    img.paste(ctrl_patch.resize((cps, cps), Image.NEAREST), (kx0 + 16, by0 + 30))
    d.rectangle(
        (kx0 + 15, by0 + 29, kx0 + 16 + cps, by0 + 30 + cps), outline=PANEL_EDGE
    )
    ct = ce["top"][0]
    ct_s = sanitize(ct["str"])
    if len(ct_s) > 12:
        ct_s = ct_s[:11] + "\u2026"
    lx = kx0 + 16 + cps + 14
    d.text((lx, by0 + 30), "top-1: ", font=F_NUM, fill=INK)
    tx = lx + text_w(F_NUM, "top-1: ")
    d.text((tx, by0 + 30), f"'{ct_s}'", font=F_TOK_S, fill=INK)
    d.text(
        (tx + text_w(F_TOK_S, f"'{ct_s}'") + 10, by0 + 30),
        f"{ct['p']:.3f}",
        font=F_NUM,
        fill=INK,
    )
    d.text((lx, by0 + 52), f"p('{ANSWER_BPE}') = {p_ctrl:.5f}", font=F_NUM, fill=MUTED)
    d.text(
        (lx, by0 + 74),
        "still noise \u2713" if p_ctrl < 0.01 else "?!",
        font=F_LABEL_B,
        fill=GREEN,
    )
    d.text((kx0 + 224, by0 + 8), "never converges to the answer", font=F_TINY, fill=DIM)

    # ---------------------------------------------------------- glow
    if locked and heat > 0:
        glow = Image.new("RGB", (W, H), (0, 0, 0))
        gd = ImageDraw.Draw(glow)
        a = int(70 + 110 * heat)
        gd.rectangle(
            (px - 6, py - 6, px + ps + 5, py + ps + 5),
            outline=(a, int(a * 0.77), int(a * 0.27)),
            width=10,
        )
        if final:
            gd.rectangle(
                (px - 14, py - 14, px + ps + 13, py + ps + 13),
                outline=(a, int(a * 0.77), int(a * 0.27)),
                width=8,
            )
        glow = glow.filter(ImageFilter.GaussianBlur(12 if final else 8))
        img = Image.composite(
            Image.new("RGB", (W, H), AMBER),
            img,
            glow.convert("L").point(lambda v: min(v, 140)),
        )
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data, target, control = load()
    carrier = Image.open(CARRIER).convert("RGB")
    if carrier.size != (1568, 1568):
        carrier = carrier.resize((1568, 1568), Image.LANCZOS)
    patch = crop_cell(carrier, TOKEN_IDX)
    ctrl_patch = crop_cell(carrier, data["control_indices"][0])
    # context strip: row 5, cols 26..39 (14 cells), scaled x3 -> 1176x84
    c0, c1 = 26, 40
    raw = carrier.crop((c0 * 28, 5 * 28, c1 * 28, 6 * 28))
    strip = raw.resize((raw.width * 3, raw.height * 3), Image.NEAREST)
    strip_cell = (TOKEN_IDX % 56 - c0) * 84

    frames, durations = [], []
    for layer in range(29):
        fr = render_frame(
            layer, data, target, control, patch, ctrl_patch, strip, strip_cell
        )
        frames.append(
            fr.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
        )
        if layer < 23:
            durations.append(220)
        elif layer < 28:
            durations.append(520)
        else:
            durations.append(2500)  # celebratory hold on the final frame

    gif = OUT_DIR / "crystal.gif"
    frames[0].save(
        gif,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False,
    )
    final_png = OUT_DIR / "crystal_final.png"
    render_frame(28, data, target, control, patch, ctrl_patch, strip, strip_cell).save(
        final_png
    )
    print(f"wrote {gif} ({gif.stat().st_size / 1024:.0f} KB, {len(frames)} frames)")
    print(f"wrote {final_png}")


if __name__ == "__main__":
    main()
