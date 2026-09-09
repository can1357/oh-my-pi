# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp05: margin row-number ruler ("anchors") on img-6x10-sent.

Hypothesis: a hex-editor-style row ruler makes the image addressable, so the
model can localize answers instead of transcribing the whole bitmap — cutting
the reasoning/output "read tax" and possibly improving F1.

Conditions (both chunked by the ruler content capacity, 39936 chars, so the
two conditions share identical question sets):
  img-6x10-sent-ruler   5-col blue row ruler + anti-transcription prompt
                        asking for `answer | row≈N`
  img-6x10-sent-noruler baseline render (261 cols) + anti-transcription
                        prompt only (separates ruler effect from prompt effect)

Diagnostic: claimed row vs true row of the gold answer (char offset // cols).

Usage: uv run exp05_anchors.py [--report] [--lengths 50,150] [--models ...]
"""

import argparse
import csv
import json
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import (
    _BLACK,
    _DARK,
    _WHITE,
    FontCfg,
    _row_palette,
    _sentence_indices,
    ensure_font,
    parse_bdf,
    render,
)  # noqa: E402
from final import MODELS, cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

FONT = FONTS["6x10"]
SIZE = 1568
MARGIN_COLS = 5  # 4 digit cells + 1 gap cell
RULER_STEP = 5
RULER_FG = (90, 120, 215)  # medium blue: legible, never competes with content
COND_RULER = "img-6x10-sent-ruler"
COND_CTL = "img-6x10-sent-noruler"

# ctx.md baseline (img-6x10-sent, seed 42, qpc 30): (f1, se, cost)
BASELINE = {
    ("gpt-5.5", 50): (0.850, 0.051, 0.068),
    ("gpt-5.5", 150): (0.822, 0.029, 0.245),
    ("google/gemini-3.5-flash", 50): (0.984, 0.012, 0.018),
    ("google/gemini-3.5-flash", 150): (0.805, 0.035, 0.097),
}


def ruler_capacity(cfg: FontCfg, size: int = SIZE) -> tuple[int, int, int]:
    """(content_cols, rows, chars) once MARGIN_COLS are reserved for the ruler."""
    cols, rows = size // cfg.adv - MARGIN_COLS, size // cfg.pitch
    return cols, rows, cols * rows


def render_ruler(
    text: str, cfg: FontCfg, cache: Path, size: int = SIZE, variant: str = "sent"
) -> Image.Image:
    """bdf.render() with a left row-number ruler every RULER_STEP rows.

    Content glyphs are shifted right by MARGIN_COLS cells; row indices are
    drawn 0-based, right-aligned in the first MARGIN_COLS-1 cells, in RULER_FG.
    """
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, cache))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, cap = ruler_capacity(cfg, size)
    text = text[:cap]
    sent_idx = (
        _sentence_indices(text)
        if variant in ("sent", "dark-sent", "sent-dim")
        else None
    )
    sent_palette = _DARK
    img = Image.new(
        "RGB", (size, size), _BLACK if variant in ("dark", "dark-sent") else _WHITE
    )
    px = img.load()

    def draw_glyph(ch: str, cell_col: int, y0: int, fg: tuple[int, int, int]) -> None:
        glyph = glyphs.get(ord(ch))
        if glyph is None:
            return
        w, h, xoff, yoff = glyph["bbx"]
        top = y0 + ascent - h - yoff
        shift = 0x80 if w <= 8 else 0x8000
        for r, bits in enumerate(glyph["rows"]):
            y = top + r
            if not 0 <= y < size:
                continue
            for b in range(w):
                if bits & (shift >> b):
                    x = cell_col * cfg.adv + xoff + b
                    if 0 <= x < size:
                        px[x, y] = fg

    for row in range(rows):
        bg, fg = _row_palette(variant, row)
        y0 = row * cfg.pitch
        for y in range(y0, min(y0 + cfg.pitch, size)):
            for x in range(size):
                px[x, y] = bg
        if row % RULER_STEP == 0:
            label = str(row)
            for j, ch in enumerate(label):
                draw_glyph(ch, MARGIN_COLS - 1 - len(label) + j, y0, RULER_FG)
        for col in range(cols):
            i = row * cols + col
            if i >= len(text):
                break
            if sent_idx is not None:
                fg = sent_palette[sent_idx[i] % 6]
            draw_glyph(text[i], MARGIN_COLS + col, y0, fg)
    return img


_ROW_CLAIM = re.compile(r"\|\s*rows?\s*[≈~=:]*\s*(\d+)", re.IGNORECASE)


def parse_answers_rows(text: str, n: int) -> tuple[list[str], list[int | None]]:
    """Numbered answers, with optional `| row≈N` suffixes stripped into rows."""
    answers, rows = [""] * n, [None] * n
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)[.):]\s*(.*\S)?\s*$", line)
        if not (m and m.group(2)):
            continue
        idx = int(m.group(1)) - 1
        if not (0 <= idx < n) or answers[idx]:
            continue
        body = m.group(2).strip()
        rm = _ROW_CLAIM.search(body)
        if rm:
            rows[idx] = int(rm.group(1))
            body = body[: rm.start()].strip()
        answers[idx] = body
    return answers, rows


def gold_row(chunk_text: str, q: dict, chunk_len: int, content_cols: int) -> int | None:
    """True row of the gold answer in the rendered grid (0-based)."""
    approx = max(0, int(q["pos_rel"] * chunk_len) - 10)
    for g in q["golds"]:
        i = chunk_text.find(g, approx)
        if i < 0:
            i = chunk_text.find(g)
        if i < 0:
            i = chunk_text.lower().find(g.lower())
        if i >= 0:
            return i // content_cols
    return None


def _ensure_png(png: Path, make) -> None:
    """Render-once with atomic publish; unique tmp avoids cross-thread races."""
    if png.exists() and png.stat().st_size > 0:
        return
    tmp = png.with_suffix(f".{uuid.uuid4().hex}.tmp.png")
    make().save(tmp)
    tmp.replace(png)


def run_cell_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    args, flow, paras, offsets, keys = (
        ctx["args"],
        ctx["flow"],
        ctx["paras"],
        ctx["offsets"],
        ctx["keys"],
    )
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    chunk_text = flow[start:end]
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))

    if cond == COND_RULER:
        cols, rows, _ = ruler_capacity(FONT, args.size)
        png = CACHE / f"exp05-ruler-{sha8(chunk_text, str(args.size))}.png"
        _ensure_png(
            png, lambda: render_ruler(chunk_text, FONT, CACHE, args.size, "sent")
        )
        last_label = (rows - 1) // RULER_STEP * RULER_STEP
        prompt = load_prompt("exp05-qa-image.md").format(
            cols=cols, rows=rows, last_label=last_label
        )
    else:  # control: baseline render, anti-transcription prompt only
        cols, rows = args.size // FONT.adv, args.size // FONT.pitch
        png = CACHE / f"exp05-ctl-{sha8(chunk_text, str(args.size))}.png"
        _ensure_png(png, lambda: render(chunk_text, FONT, CACHE, args.size, "sent"))
        prompt = load_prompt("exp05-qa-image-ctl.md").format(cols=cols, rows=rows)

    messages = [
        {
            "role": "user",
            "content": [{"text": prompt}, {"image_path": png}, {"text": q_block}],
        }
    ]
    qa = cached(
        model,
        f"exp05-qa-{cond}",
        {"messages": messages, "effort": args.effort},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    model,
                    messages,
                    max_tokens=args.max_tokens,
                    effort=args.effort,
                ),
            )
        ),
        args.fresh,
    )
    answers, claimed_rows = parse_answers_rows(qa["text"], len(questions))
    records = []
    for q, a, crow in zip(questions, answers, claimed_rows):
        trow = (
            gold_row(chunk_text, q, end - start, cols) if cond == COND_RULER else None
        )
        records.append(
            {
                "model": model,
                "length": ctx["length"],
                "cond": cond,
                "chunk": start,
                "pos_rel": q["pos_rel"],
                "q": q["q"],
                "answer": a,
                "golds": q["golds"],
                "em": squad.exact_match(a, q["golds"]),
                "f1": squad.f1(a, q["golds"]),
                "abstained": "unreadable" in a.lower(),
                "claimed_row": crow,
                "true_row": trow,
            }
        )
    records[0]["usage"] = [{"phase": "qa", **qa["usage"]}]
    return records


def aggregate(records: list[dict], price_in: float, price_out: float) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records]
    mean_f1 = sum(f1s) / n
    se = (sum((x - mean_f1) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    us = [u for r in records if "usage" in r for u in r["usage"]]
    tok = {
        k: sum(u.get(k, 0) for u in us)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost_in = (
        (tok["in"] + 1.25 * tok["cache_w"] + 0.1 * tok["cache_r"]) / 1e6 * price_in
    )
    cost_out = tok["out"] / 1e6 * price_out
    loc = [
        (r["claimed_row"], r["true_row"])
        for r in records
        if r["claimed_row"] is not None and r["true_row"] is not None
    ]
    row_stats = {}
    if loc:
        errs = [abs(c - t) for c, t in loc]
        row_stats = {
            "row_n": len(loc),
            "row_claimed_frac": round(
                sum(r["claimed_row"] is not None for r in records) / n, 3
            ),
            "row_mae": round(sum(errs) / len(errs), 2),
            "row_within2": round(sum(e <= 2 for e in errs) / len(errs), 3),
            "row_within5": round(sum(e <= 5 for e in errs) / len(errs), 3),
        }
    return {
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        **{f"tok_{k}": v for k, v in tok.items()},
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
        **row_stats,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="gpt-5.5,google/gemini-3.5-flash")
    ap.add_argument("--lengths", default="50,150")
    ap.add_argument("--conditions", default=f"{COND_RULER},{COND_CTL}")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=SIZE)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp05-anchors"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {}
    if not args.report:
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    budget = ruler_capacity(FONT, args.size)[2]  # both conds: identical question sets
    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        ctx = {
            "args": args,
            "flow": flow,
            "paras": paras,
            "offsets": offsets,
            "keys": keys,
            "length": length,
        }
        for model in models:
            for cond in conditions:
                for start in range(0, len(flow), budget):
                    tasks.append(
                        (model, cond, start, min(start + budget, len(flow)), ctx)
                    )
    print(f"grid: {len(tasks)} chunk tasks, chunk budget {budget} chars")

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell_chunk, m, c, s, e, ctx) for m, c, s, e, ctx in tasks
        ]
        for i, fut in enumerate(futures):
            records.extend(fut.result())
            print(f"  {i + 1}/{len(tasks)} tasks", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for model in models:
        for length in lengths:
            for cond in conditions:
                sub = [
                    r
                    for r in records
                    if r["model"] == model
                    and r["length"] == length
                    and r["cond"] == cond
                ]
                if not sub:
                    continue
                cell = {
                    "model": model,
                    "length": length,
                    "condition": cond,
                    **aggregate(sub, *MODELS[model]),
                }
                base = BASELINE.get((model, length))
                if base:
                    cell["base_f1"] = base[0]
                    cell["d_f1"] = round(cell["f1"] - base[0], 3)
                    cell["base_cost"] = base[2]
                    cell["d_cost"] = round(cell["cost_usd"] - base[2], 4)
                cells.append(cell)
    (out_dir / "summary.json").write_text(
        json.dumps({"args": vars(args), "cells": cells}, indent=1)
    )
    fieldnames = sorted(
        {k for c in cells for k in c},
        key=lambda k: (k not in ("model", "length", "condition"), k),
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(cells)

    for c in cells:
        print(
            f"{c['model']:>26} L{c['length']:<4}{c['condition']:<24} n={c['n']:<4} em={c['em']:.3f} f1={c['f1']:.3f}±{c['f1_se']:.3f}"
            f" cost=${c['cost_usd']:.3f} out={c['tok_out']} reas={c['tok_reasoning']}"
            + (
                f" rowMAE={c['row_mae']} w5={c['row_within5']}"
                if "row_mae" in c
                else ""
            )
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
