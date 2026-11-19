# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""The lock-on instrument: how we decide WHERE the answer materializes.

Renders the measurement methodology as a depth-gauge diagram: the answer patch
descends the decoder shaft; at every layer a logit-lens probe (final norm + LM
head) reads the vocabulary distribution; lock-on is the first layer whose top-1
token is a BPE piece of the answer. All readouts are real sweep data.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
P = {
    "bg": (5, 7, 10),
    "panel": (12, 17, 23),
    "panel2": (8, 12, 17),
    "ink": (241, 239, 224),
    "muted": (143, 154, 160),
    "faint": (90, 101, 108),
    "cyan": (75, 220, 255),
    "orange": (255, 112, 72),
    "green": (148, 255, 117),
    "amber": (255, 196, 68),
    "purple": (188, 112, 255),
    "grid": (38, 49, 58),
}
COND_COLORS = {
    "base-8x13": (143, 154, 160),
    "repeat2-color": (255, 196, 68),
    "align-7x14": (148, 255, 117),
    "align-14x28": (75, 220, 255),
    "align-28x28": (255, 112, 72),
    "repeat2-align-14x28": (188, 112, 255),
}


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


def mono_font(size: int) -> ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def label_font(label: str, size: int) -> ImageFont.ImageFont:
    """Monaco for ASCII; Arial Unicode for anything it cannot shape (CJK)."""
    if all(ord(ch) < 0x2000 for ch in label):
        return mono_font(size)
    unicode_path = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
    if Path(unicode_path).exists():
        return ImageFont.truetype(unicode_path, size)
    return mono_font(size)


def crosshair(
    draw: ImageDraw.ImageDraw,
    cx: int,
    cy: int,
    r: int,
    color: tuple[int, int, int],
    width: int = 4,
) -> None:
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=width)
    draw.ellipse(
        (cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2), outline=color, width=2
    )
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        draw.line(
            (
                cx + dx * (r - 6),
                cy + dy * (r - 6),
                cx + dx * (r + 14),
                cy + dy * (r + 14),
            ),
            fill=color,
            width=width,
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "qwen-materialize-sweep-q3")
    )
    ap.add_argument("--condition", default="base-8x13")
    ap.add_argument(
        "--out",
        default=str(
            HERE / "results" / "qwen-materialize-sweep-q3" / "lockon-anatomy.png"
        ),
    )
    args = ap.parse_args()
    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    conditions = {c["name"]: c for c in summary["conditions"]}
    cond = conditions[args.condition]
    q = summary["question"]
    answer_strs = summary["answer_token_strs"]
    answer_set = {s.strip() for s in answer_strs}
    layers = cond["layers"]
    n_layers = len(layers)
    lock_on = cond["lock_on_layer"]

    w, h = 2200, 1420
    canvas = Image.new("RGB", (w, h), P["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((520, 620, 1280, 1180), fill=(255, 196, 68, 36))
    gd.ellipse((-260, -240, 760, 560), fill=(75, 220, 255, 26))
    gd.ellipse((1500, -100, 2480, 700), fill=(255, 112, 72, 20))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(90))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 40), "THE LOCK-ON INSTRUMENT", fill=P["amber"], font=ui_font(24, True)
    )
    draw.text(
        (64, 80),
        "How we decide where the answer materializes",
        fill=P["ink"],
        font=ui_font(58, True),
    )
    draw.text(
        (66, 154),
        "At every layer, a logit-lens probe taps the answer patch's residual stream: final RMSNorm → LM head → softmax over 152k vocabulary entries.",
        fill=P["muted"],
        font=ui_font(22),
    )
    draw.text(
        (66, 186),
        "LOCK-ON = the first layer whose #1 vocabulary entry is a BPE piece of the answer. Past this depth the fact is settled — remaining layers are free for reasoning.",
        fill=P["amber"],
        font=ui_font(22, True),
    )

    # ---- Probe pipeline card (top left).
    pipe = (64, 248, 700, 420)
    draw.rounded_rectangle(
        pipe, radius=22, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (92, 268),
        "the probe, applied at every layer ℓ",
        fill=P["ink"],
        font=ui_font(22, True),
    )
    stages = ["h(patch)", "RMSNorm", "LM head", "softmax", "top-1?"]
    sx = 92
    for si, stage in enumerate(stages):
        color = P["amber"] if si == len(stages) - 1 else P["cyan"]
        tw = int(draw.textlength(stage, font=mono_font(16))) + 24
        draw.rounded_rectangle(
            (sx, 318, sx + tw, 356), radius=10, fill=P["panel2"], outline=color, width=2
        )
        draw.text((sx + 12, 327), stage, fill=color, font=mono_font(16))
        if si < len(stages) - 1:
            draw.text((sx + tw + 4, 327), "→", fill=P["faint"], font=ui_font(18))
        sx += tw + 28
    draw.text(
        (92, 376),
        f"vocabulary = 152k entries · answer BPEs = {answer_strs}",
        fill=P["muted"],
        font=mono_font(14),
    )

    # ---- The patch under test (left).
    patch_card = (64, 460, 380, 760)
    draw.rounded_rectangle(
        patch_card, radius=22, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text((92, 480), "specimen", fill=P["orange"], font=ui_font(21, True))
    carrier = Image.open(result_dir / "images" / f"{args.condition}.png").convert("RGB")
    rw = 1568
    grid = 56
    px = 28
    lock_entry = layers[lock_on]
    tok_idx = lock_entry["best_token_index"]
    r0, c0 = tok_idx // grid, tok_idx % grid
    cell = carrier.resize((rw, rw), Image.Resampling.LANCZOS).crop(
        (c0 * px, r0 * px, (c0 + 1) * px, (r0 + 1) * px)
    )
    big = cell.resize((196, 196), Image.Resampling.NEAREST)
    draw.rounded_rectangle(
        (118, 516, 326, 724),
        radius=12,
        fill=(244, 242, 230),
        outline=P["orange"],
        width=4,
    )
    canvas.paste(big, (124, 522))
    draw.text(
        (118, 730),
        f"visual token #{tok_idx} · 28×28 px",
        fill=P["muted"],
        font=mono_font(13),
    )

    # ---- Depth shaft.
    shaft_x = 470
    shaft_top, shaft_bot = 470, 1340
    draw.rounded_rectangle(
        (shaft_x - 7, shaft_top, shaft_x + 7, shaft_bot),
        radius=7,
        fill=(20, 28, 35),
        outline=(40, 54, 64),
        width=1,
    )

    def layer_y(layer: int) -> int:
        return round(shaft_top + (shaft_bot - shaft_top) * layer / (n_layers - 1))

    # p(answer) trajectory along the shaft.
    traj = [
        (shaft_x + 14 + 230 * min(1.0, e["best_answer_p"]), layer_y(e["layer"]))
        for e in layers
    ]
    for i in range(len(traj) - 1):
        draw.line((traj[i], traj[i + 1]), fill=(120, 96, 40), width=3)
    draw.text(
        (shaft_x + 30, shaft_bot + 10),
        "p(answer BPE) →",
        fill=(150, 124, 60),
        font=ui_font(14),
    )

    for layer in range(n_layers):
        y = layer_y(layer)
        major = layer % 4 == 0 or layer == n_layers - 1
        draw.line(
            (shaft_x - (16 if major else 10), y, shaft_x + (16 if major else 10), y),
            fill=P["faint"] if major else (52, 64, 73),
            width=2,
        )
        if major:
            draw.text(
                (shaft_x - 58, y - 9),
                f"L{layer:02d}",
                fill=P["muted"],
                font=mono_font(13),
            )
    # Patch entering the shaft.
    draw.line((326, 620, shaft_x - 18, shaft_top + 6), fill=P["orange"], width=3)
    draw.polygon(
        [
            (shaft_x - 14, shaft_top + 2),
            (shaft_x - 30, shaft_top - 4),
            (shaft_x - 26, shaft_top + 16),
        ],
        fill=P["orange"],
    )

    # ---- Readout cards at sampled depths (real top-5).
    samples = [0, 10, 18, lock_on, n_layers - 1]
    card_x = 790
    card_w = 620
    card_h = 128
    gap = 14
    desired = [layer_y(layer) - card_h // 2 for layer in samples]
    card_ys = [0] * len(samples)
    # Bottom-up pass: clamp the last card into the canvas, then keep every
    # earlier card fully above its successor; final top clamp at 440.
    card_ys[-1] = min(desired[-1], h - card_h - 70)
    for i in range(len(samples) - 2, -1, -1):
        card_ys[i] = min(desired[i], card_ys[i + 1] - card_h - gap)
    shift = max(0, 440 - card_ys[0])
    card_ys = [cy + shift for cy in card_ys]
    for layer, cy in zip(samples, card_ys):
        entry = layers[layer]
        is_lock = layer == lock_on
        accent = (
            P["amber"]
            if is_lock
            else P["cyan"]
            if entry["best_answer_p"] > 0.01
            else P["faint"]
        )
        # Connector.
        ly = layer_y(layer)
        draw.line(
            (shaft_x + 16, ly, card_x - 18, cy + card_h // 2),
            fill=accent,
            width=3 if is_lock else 2,
        )
        draw.ellipse((shaft_x + 12, ly - 5, shaft_x + 22, ly + 5), fill=accent)
        draw.rounded_rectangle(
            (card_x, cy, card_x + card_w, cy + card_h),
            radius=16,
            fill=P["panel2"],
            outline=accent,
            width=3 if is_lock else 1,
        )
        title = f"L{layer:02d} readout" + ("   LOCK-ON" if is_lock else "")
        draw.text((card_x + 20, cy + 10), title, fill=accent, font=ui_font(19, True))
        if is_lock:
            tx = (
                card_x
                + 20
                + draw.textlength(f"L{layer:02d} readout  ", font=ui_font(19, True))
            )
            draw.ellipse((tx - 8, cy + 14, tx + 4, cy + 26), outline=accent, width=3)
        bx = card_x + 20
        by = cy + 44
        for k, t in enumerate(entry["best_token_top"]):
            label = t["str"].strip() or "␣"
            if len(label) > 9:
                label = label[:8] + "…"
            hit = t["str"].strip() in answer_set
            pill_w = 108
            fill = (66, 92, 36) if hit else (16, 22, 28)
            outline = P["green"] if hit else (38, 52, 61)
            draw.rounded_rectangle(
                (bx, by, bx + pill_w, by + 30),
                radius=8,
                fill=fill,
                outline=outline,
                width=2,
            )
            draw.text(
                (bx + 8, by + 6),
                label,
                fill=(220, 255, 190) if hit else P["ink"],
                font=label_font(label, 13),
            )
            bar = round(min(1.0, t["p"] / 0.4) * pill_w)
            draw.rounded_rectangle(
                (bx, by + 36, bx + max(3, bar), by + 42),
                radius=3,
                fill=P["amber"] if hit else (60, 76, 88),
            )
            draw.text(
                (
                    bx,
                    by + 46,
                ),
                f"{t['p']:.3f}",
                fill=P["muted"],
                font=mono_font(10),
            )
            bx += pill_w + 12
        if is_lock:
            crosshair(draw, shaft_x, ly, 26, P["amber"], 4)
            draw.text(
                (shaft_x + 44, ly + 26),
                f"first top-1 hit: “{entry['best_token_top'][0]['str'].strip()}” p={entry['best_token_top'][0]['p']:.2f}",
                fill=P["amber"],
                font=ui_font(16, True),
            )

    # ---- Why it matters (right column).
    why = (1460, 248, 2136, 716)
    draw.rounded_rectangle(
        why, radius=22, fill=P["panel"], outline=(35, 49, 59), width=1
    )
    draw.text(
        (1492, 270), "why lock-on is the metric", fill=P["ink"], font=ui_font(26, True)
    )
    lines = [
        ("It separates decoding from reasoning.", P["ink"]),
        ("Layers before lock-on are spent turning", P["muted"]),
        ("pixels into words; layers after are free to", P["muted"]),
        ("reason about them. Earlier, harder lock-on", P["muted"]),
        ("= more of the network left for thinking.", P["muted"]),
    ]
    ty = 314
    for text, color in lines:
        draw.text((1492, ty), text, fill=color, font=ui_font(19))
        ty += 30
    draw.line((1492, ty + 8, 2104, ty + 8), fill=P["grid"], width=1)
    ty += 26
    draw.text(
        (1492, ty),
        "reasoning budget after lock-on",
        fill=P["muted"],
        font=ui_font(16, True),
    )
    ty += 30
    for name, color in COND_COLORS.items():
        c = conditions.get(name)
        if not c or c["lock_on_layer"] is None:
            continue
        budget = n_layers - 1 - c["lock_on_layer"]
        bw_px = round(budget / (n_layers - 1) * 430)
        draw.text((1492, ty), name, fill=color, font=mono_font(13))
        draw.rounded_rectangle(
            (1492, ty + 20, 1492 + bw_px, ty + 32), radius=6, fill=color
        )
        draw.text(
            (1492 + bw_px + 10, ty + 17),
            f"{budget} layers · p {c['max_answer_p']:.2f}",
            fill=P["muted"],
            font=mono_font(12),
        )
        ty += 44

    # ---- Rule plate (bottom right).
    plate = (1460, 740, 2136, 1000)
    draw.rounded_rectangle(
        plate, radius=22, fill=P["panel"], outline=(255, 196, 68), width=2
    )
    draw.text((1492, 762), "the rule", fill=P["amber"], font=ui_font(24, True))
    rule_lines = [
        "lock_on(patch) = min L such that",
        "  argmax softmax(W * norm(h_L))",
        f"  in {{{answer_strs[0]!r}, {answer_strs[1]!r}}}",
        "",
        f"here: L = {lock_on}, decoded “{layers[lock_on]['best_token_top'][0]['str'].strip()}”",
    ]
    ry = 806
    for line in rule_lines:
        draw.text(
            (1492, ry), line, fill=P["ink"] if line else P["muted"], font=mono_font(17)
        )
        ry += 32
    draw.text(
        (1492, 1014), f"question: {q['q'][:60]}…", fill=P["muted"], font=ui_font(15)
    )
    draw.text(
        (1492, 1040),
        f"answer: “{q['answer_text']}” · condition: {args.condition} · generation: “{cond['generation']}”",
        fill=P["muted"],
        font=ui_font(15),
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(out)


if __name__ == "__main__":
    main()
