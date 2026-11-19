# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp03_numhard: harden digit glyphs in optical-compaction renders.

Extractive QA on rendered pages dies on 0/O, 1/l, rn/m confusions, and SQuAD
answers skew heavily toward numbers/dates. This experiment re-renders the
img-6x10 baseline with a hardening mask over digits (plus number/date
punctuation directly adjacent to a digit: "1,000", "3.5%", "1914-18"):

  numbold  double-strike: every masked glyph pixel painted at x and x+1
           (6x10 digit ink spans cols 0-4 of the 6px cell, so x+1 stays
           in-cell -- no bleed into the neighbor)
  numred   masked glyphs painted pure dark red, overriding sent/bw color

Conditions: img-6x10-sent-numbold, img-6x10-sent-numred, img-6x10-bw-numred.
Methodology matches the baseline grid (seed 42, qpc 30, size 1568,
max_tokens 32768, effort None) so question sets are identical and the
numeric-gold subset can be compared apples-to-apples against the baseline
records in results/optimal-gpt55 / results/optimal-gemini.

Usage: uv run exp03_numhard.py [--report]
"""

import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import _DARK, _row_palette, _sentence_indices, capacity, ensure_font, parse_bdf  # noqa: E402
from final import MODELS, aggregate, cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp03"
SLUG = "numhard"
FONT = FONTS["6x10"]
CONDITIONS = ("img-6x10-sent-numbold", "img-6x10-sent-numred", "img-6x10-bw-numred")
RUN_MODELS = ("gpt-5.5", "google/gemini-3.5-flash")
BASELINE_COND = "img-6x10-sent"
BASELINE_RECORDS = {
    "gpt-5.5": RESULTS / "optimal-gpt55" / "records.jsonl",
    "google/gemini-3.5-flash": RESULTS / "optimal-gemini" / "records.jsonl",
}
RED = (220, 0, 0)
_WHITE = (255, 255, 255)
_NUM_PUNCT = set(".,:/%-\u2013$")


def number_mask(text: str) -> list[bool]:
    """True for digits and number/date punctuation directly adjacent to a digit."""
    mask = [False] * len(text)
    for i, ch in enumerate(text):
        if ch.isdigit():
            mask[i] = True
        elif ch in _NUM_PUNCT:
            if (i > 0 and text[i - 1].isdigit()) or (
                i + 1 < len(text) and text[i + 1].isdigit()
            ):
                mask[i] = True
    return mask


def render_hard(
    text: str, cfg, cache: Path, size: int, variant: str, hard: str
) -> Image.Image:
    """Copy of bdf.render() restricted to white-bg variants (sent/bw), with a
    digit-hardening pass: `numbold` double-strikes masked glyphs, `numred`
    recolors them pure red."""
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, cache))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, cap = capacity(cfg, size)
    text = text[:cap]
    sent_idx = _sentence_indices(text) if variant == "sent" else None
    num_mask = number_mask(text)
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for row in range(rows):
        bg, fg_default = _row_palette(variant, row)
        y0 = row * cfg.pitch
        for y in range(y0, min(y0 + cfg.pitch, size)):
            for x in range(size):
                px[x, y] = bg
        for col in range(cols):
            i = row * cols + col
            if i >= len(text):
                break
            glyph = glyphs.get(ord(text[i]))
            if glyph is None:
                continue
            fg = _DARK[sent_idx[i] % 6] if sent_idx is not None else fg_default
            hardened = num_mask[i]
            if hardened and hard == "numred":
                fg = RED
            bold = hardened and hard == "numbold"
            w, h, xoff, yoff = glyph["bbx"]
            top = y0 + ascent - h - yoff
            shift = 0x80 if w <= 8 else 0x8000
            for r, bits in enumerate(glyph["rows"]):
                y = top + r
                if not 0 <= y < size:
                    continue
                for b in range(w):
                    if bits & (shift >> b):
                        x = col * cfg.adv + xoff + b
                        if 0 <= x < size:
                            px[x, y] = fg
                            if bold and x + 1 < size:
                                px[x + 1, y] = fg
    return img


def parse_cond(cond: str) -> tuple[str, str]:
    """img-6x10-<base>-<hard> -> (base, hard)."""
    parts = cond.split("-")
    return parts[2], parts[3]


def chunk_png(chunk_text: str, size: int, base: str, hard: str) -> Path:
    png = CACHE / f"{EXP}-img-6x10-{base}-{hard}-{sha8(chunk_text, str(size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        render_hard(chunk_text, FONT, CACHE, size, base, hard).save(tmp)
        tmp.replace(png)  # atomic; cache dir is shared across agents
    return png


def run_chunk(model: str, cond: str, start: int, end: int, ctx: dict) -> list[dict]:
    args, flow = ctx["args"], ctx["flow"]
    questions = squad.sample_chunk_questions(
        ctx["paras"], ctx["offsets"], start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    chunk_text = flow[start:end]
    base, hard = parse_cond(cond)
    png = chunk_png(chunk_text, args.size, base, hard)
    cols, rows, _ = capacity(FONT, args.size)
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [
                {"text": load_prompt("qa-image.md").format(cols=cols, rows=rows)},
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        model,
        f"{EXP}-qa",
        {"messages": messages, "effort": args.effort},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    ctx["keys"],
                    model,
                    messages,
                    max_tokens=args.max_tokens,
                    effort=args.effort,
                ),
            )
        ),
        args.fresh,
    )
    answers = squad.parse_numbered(qa["text"], len(questions))
    records = []
    for q, a in zip(questions, answers):
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
            }
        )
    records[0]["usage"] = [{"phase": "qa", **qa["usage"]}]
    return records


# --- analysis ---


def is_numeric_gold(golds: list[str]) -> bool:
    return any(any(c.isdigit() for c in g) for g in golds)


def f1_stats(records: list[dict]) -> dict:
    n = len(records)
    if n == 0:
        return {"n": 0, "em": 0.0, "f1": 0.0, "f1_se": 0.0}
    f1s = [r["f1"] for r in records]
    mean = sum(f1s) / n
    se = (sum((x - mean) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    return {"n": n, "em": sum(r["em"] for r in records) / n, "f1": mean, "f1_se": se}


def load_baseline(model: str, lengths: list[int]) -> list[dict]:
    out = []
    with BASELINE_RECORDS[model].open() as fh:
        for line in fh:
            r = json.loads(line)
            if r["cond"] == BASELINE_COND and r["length"] in lengths:
                out.append(r)
    return out


def numeric_subset_cells(
    records: list[dict], models: list[str], lengths: list[int], conditions: list[str]
) -> list[dict]:
    """Per (model, length): baseline vs each condition, restricted to numeric-gold
    questions present in BOTH runs (matched by question text)."""
    cells = []
    for model in models:
        base = load_baseline(model, lengths)
        for length in lengths:
            base_num = {
                r["q"]: r
                for r in base
                if r["length"] == length and is_numeric_gold(r["golds"])
            }
            for cond in conditions:
                mine = [
                    r
                    for r in records
                    if r["model"] == model
                    and r["length"] == length
                    and r["cond"] == cond
                    and is_numeric_gold(r["golds"])
                    and r["q"] in base_num
                ]
                if not mine:
                    continue
                base_match = [base_num[r["q"]] for r in mine]
                cells.append(
                    {
                        "model": model,
                        "length": length,
                        "condition": cond,
                        **f1_stats(mine),
                        "baseline_f1": f1_stats(base_match)["f1"],
                        "baseline_se": f1_stats(base_match)["f1_se"],
                    }
                )
    return cells


def save_sample(
    records_ctx_flow: str, size: int, base: str, hard: str, out_dir: Path
) -> Path:
    """Crop a digit-dense region from the first chunk's PNG, 4x nearest upscale."""
    cols, rows, cap = capacity(FONT, size)
    text = records_ctx_flow[:cap]
    mask = number_mask(text)
    # densest 60-char window
    best_i, best_n = 0, -1
    win = 60
    run = sum(mask[:win])
    for i in range(len(text) - win):
        if run > best_n:
            best_n, best_i = run, i
        run += mask[i + win] - mask[i]
    row, col = best_i // cols, best_i % cols
    png = chunk_png(records_ctx_flow[:cap], size, base, hard)
    img = Image.open(png)
    x0 = max(0, min(col, cols - win) * FONT.adv)
    y0 = max(0, (row - 1) * FONT.pitch)
    crop = img.crop(
        (x0, y0, min(x0 + win * FONT.adv, size), min(y0 + 4 * FONT.pitch, size))
    )
    crop = crop.resize((crop.width * 4, crop.height * 4), Image.NEAREST)
    out = out_dir / f"sample-{base}-{hard}.png"
    crop.save(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(RUN_MODELS))
    ap.add_argument("--lengths", default="50,150")
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / f"{EXP}-{SLUG}"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {}
    if not args.report:
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    budget = capacity(FONT, args.size)[2]
    tasks = []
    flows: dict[int, str] = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        flows[length] = flow
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
    print(
        f"{EXP}: {len(models)} models x {len(lengths)} lengths x {len(conditions)} conditions = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_chunk, m, c, s, e, ctx) for m, c, s, e, ctx in tasks]
        for k, fut in enumerate(futures):
            records.extend(fut.result())
            print(f"  {k + 1}/{len(tasks)} tasks", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    # overall cells (same shape as final.py matrix)
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
                if sub:
                    cells.append(
                        {
                            "model": model,
                            "length": length,
                            "condition": cond,
                            **aggregate(sub, *MODELS[model]),
                        }
                    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    num_cells = numeric_subset_cells(records, models, lengths, conditions)

    # baseline numeric subset stats (per model/length, from the SAME matched questions)
    base_overall = {}
    for model in models:
        base = load_baseline(model, lengths)
        for length in lengths:
            sub = [r for r in base if r["length"] == length]
            base_overall[(model, length)] = f1_stats(sub)

    (out_dir / "summary.json").write_text(
        json.dumps(
            {
                "args": vars(args),
                "cells": cells,
                "numeric_subset": num_cells,
                "baseline_overall": {
                    f"{m}|{l}": v for (m, l), v in base_overall.items()
                },
            },
            indent=1,
        )
    )

    samples = []
    for cond in conditions:
        base, hard = parse_cond(cond)
        samples.append(
            str(save_sample(flows[lengths[0]], args.size, base, hard, out_dir))
        )

    print("\n== overall ==")
    print(
        f"{'model':<24}{'len':>5}{'condition':<28}{'n':>4}{'EM':>7}{'F1':>7}{'se':>7}{'cost$':>8}{'base F1':>9}{'d':>7}"
    )
    for c in cells:
        b = base_overall[(c["model"], c["length"])]
        print(
            f"{c['model']:<24}{c['length']:>5}{c['condition']:<28}{c['n']:>4}{c['em']:>7.3f}{c['f1']:>7.3f}"
            f"{c['f1_se']:>7.3f}{c['cost_usd']:>8.3f}{b['f1']:>9.3f}{c['f1'] - b['f1']:>+7.3f}"
        )
    print("\n== numeric-gold subset (matched questions vs img-6x10-sent baseline) ==")
    print(
        f"{'model':<24}{'len':>5}{'condition':<28}{'n':>4}{'F1':>7}{'se':>7}{'base F1':>9}{'base se':>8}{'d':>7}"
    )
    for c in num_cells:
        print(
            f"{c['model']:<24}{c['length']:>5}{c['condition']:<28}{c['n']:>4}{c['f1']:>7.3f}{c['f1_se']:>7.3f}"
            f"{c['baseline_f1']:>9.3f}{c['baseline_se']:>8.3f}{c['f1'] - c['baseline_f1']:>+7.3f}"
        )
    print(f"\nresults -> {out_dir}/  samples: {', '.join(samples)}")


if __name__ == "__main__":
    main()
