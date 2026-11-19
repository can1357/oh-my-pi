# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp10: per-model optical-profile calibration sweep for gpt-5.5 and gemini-3.5-flash.

Sibling models each preferred a different (font, variant) density point
(fable: 6x12-dim, opus: 8x13-bw, kimi: 8x13-sent-dim, glm: 8x13-dark-sent), but
gpt-5.5 / gemini-3.5-flash were only ever measured at 6x10-sent (+ 5x8-bw /
6x9-sent-dim). This script runs the calibration sweep an "optical profile"
catalog entry would ship with:

  phase A (screen, length 150): sibling-winner combos + a variant probe at 8x13
          + 6x12-{dim,sent}
  phase B (ladder, length 150): density ladder {8x13..5x8} at each model's best
          variant from phase A
  phase C (cross, length 150):  each model evaluated on the *other* model's
          optimal cell (profile transferability)
  phase D (confirm): each model's top cell at lengths 50 and 250

Methodology matches the optimal-* baselines exactly (seed 42, qpc 30, size
1568, max_tokens 32768, effort None) so identical cells hit the shared
.cache/qa/ response cache for free.  Cache policy: reads try the canonical
"qa" tag first (free reuse of optimal-run payloads), new responses are written
under the exp10-namespaced tag.

Usage:  uv run exp10_profiles.py            # full self-driving sweep
        uv run exp10_profiles.py --report   # re-aggregate from cache only
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp10"
OUT_DIR = RESULTS / f"{EXP}-profiles"
MODELS = {  # ($/M in, $/M out); cached reads bill 0.1x input
    "gpt-5.5": (2.0, 16.0),
    "google/gemini-3.5-flash": (0.6, 4.0),
}
BASELINE = {  # img-6x10-sent from results/optimal-{gpt55,gemini}/matrix.csv
    ("gpt-5.5", 50): (0.850, 0.051, 0.068),
    ("gpt-5.5", 150): (0.822, 0.029, 0.245),
    ("gpt-5.5", 250): (0.822, 0.026, 0.380),
    ("google/gemini-3.5-flash", 50): (0.984, 0.012, 0.018),
    ("google/gemini-3.5-flash", 150): (0.805, 0.035, 0.097),
    ("google/gemini-3.5-flash", 250): (0.755, 0.033, 0.147),
}

# Phase A screening cells (length 150). Sibling winners + variant probe at
# 8x13 + the 6x12 bridge. img-6x10-sent is the baseline -- not re-run.
SCREEN = (
    "img-6x12-dim",  # fable's winner
    "img-8x13-bw",  # opus's winner
    "img-8x13-sent-dim",  # kimi's winner
    "img-8x13-dark-sent",  # glm's winner
    "img-8x13-sent",
    "img-8x13-dim",
    "img-6x12-sent",
)
LADDER_FONTS = ("8x13", "7x13", "6x12", "6x10", "6x9", "5x8")


def parse_img_condition(name: str) -> tuple[str, str]:
    _, font, variant = name.split("-", 2)
    return font, variant


def cached(model: str, payload: object, fn, fresh: bool) -> dict:
    """Like final.cached(), but dual-key: read canonical "qa" tag first (free
    reuse of the optimal-run cache), then our exp10 tag; write under exp10."""
    blob = json.dumps(payload, sort_keys=True, default=str)
    canon = QA_CACHE / f"{sha8(model, 'qa', blob)}.json"
    mine = QA_CACHE / f"{sha8(model, f'{EXP}-qa', blob)}.json"
    if not fresh:
        for path in (canon, mine):
            if path.exists():
                hit = json.loads(path.read_text())
                if hit.get("stop") != "max_tokens":
                    return hit
    out = fn()
    if out.get("stop") == "max_tokens":
        print(f"  WARN truncated, not cached: {model} {sha8(model, f'{EXP}-qa', blob)}")
    else:
        tmp = mine.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(out))
        tmp.replace(mine)
    return out


def render_png(chunk_text: str, font: str, variant: str, size: int) -> Path:
    """Canonical final.py naming so QA payloads (which embed the path) match
    the shared cache; render is deterministic, tmp-then-replace is atomic."""
    png = CACHE / f"img-{font}-{variant}-{sha8(chunk_text, str(size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(f".{os.getpid()}.tmp.png")
        render(chunk_text, FONTS[font], CACHE, size, variant).save(tmp)
        tmp.replace(png)
    return png


def run_cell_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    """One (model, condition, chunk): render carrier image, QA, score.
    Copied from final.run_cell_chunk, image conditions only."""
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
    font, variant = parse_img_condition(cond)
    png = render_png(chunk_text, font, variant, args.size)
    cols, rows, _ = capacity(FONTS[font], args.size)
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
        {"messages": messages, "extra": None, "effort": None},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys, model, messages, max_tokens=args.max_tokens, effort=None
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
    }


class Runner:
    def __init__(self, args, keys):
        self.args = args
        self.keys = keys
        self.records: list[dict] = []
        self.done: set[tuple[str, int, str]] = set()
        self.ctxs: dict[int, dict] = {}
        self.all_paras = squad.load_paragraphs(CACHE)

    def ctx(self, length: int) -> dict:
        if length not in self.ctxs:
            paras = self.all_paras[:length]
            flow, offsets = squad.build_flow(paras)
            self.ctxs[length] = {
                "args": self.args,
                "flow": flow,
                "paras": paras,
                "offsets": offsets,
                "keys": self.keys,
                "length": length,
            }
        return self.ctxs[length]

    def run(self, cells: list[tuple[str, int, str]], label: str) -> None:
        cells = [c for c in cells if c not in self.done]
        self.done.update(cells)
        tasks = []
        for model, length, cond in cells:
            ctx = self.ctx(length)
            flow = ctx["flow"]
            budget = capacity(FONTS[parse_img_condition(cond)[0]], self.args.size)[2]
            for start in range(0, len(flow), budget):
                tasks.append((model, cond, start, min(start + budget, len(flow)), ctx))
        if not tasks:
            return
        print(f"[{label}] {len(cells)} cells -> {len(tasks)} chunk tasks")
        with ThreadPoolExecutor(self.args.workers) as pool:
            futures = [pool.submit(run_cell_chunk, *t) for t in tasks]
            for fut in futures:
                self.records.extend(fut.result())

    def cell(self, model: str, length: int, cond: str) -> dict | None:
        sub = [
            r
            for r in self.records
            if r["model"] == model and r["length"] == length and r["cond"] == cond
        ]
        return (
            {
                "model": model,
                "length": length,
                "condition": cond,
                **aggregate(sub, *MODELS[model]),
            }
            if sub
            else None
        )

    def cells_for(self, model: str, length: int) -> list[dict]:
        conds = sorted(
            {
                r["cond"]
                for r in self.records
                if r["model"] == model and r["length"] == length
            }
        )
        return [c for cond in conds if (c := self.cell(model, length, cond))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }
    runner = Runner(args, keys)
    models = list(MODELS)

    # -- phase A: screen at length 150 --------------------------------------
    runner.run([(m, 150, c) for m in models for c in SCREEN], "A screen")

    # -- phase B: density ladder at each model's best variant ---------------
    ladder = [
        (m, 150, "img-6x10-sent") for m in models
    ]  # baseline; free via shared cache
    best_variant = {}
    for m in models:
        top = max(runner.cells_for(m, 150), key=lambda c: c["f1"])
        v = parse_img_condition(top["condition"])[1]
        best_variant[m] = v
        ladder += [(m, 150, f"img-{f}-{v}") for f in LADDER_FONTS]
    runner.run(ladder, "B ladder")

    # -- phase C: cross-profile transfer (each model on the other's optimum) -
    top150 = {m: max(runner.cells_for(m, 150), key=lambda c: c["f1"]) for m in models}
    cross = [
        (other, 150, top150[m]["condition"])
        for m in models
        for other in models
        if other != m
    ]
    runner.run(cross, "C cross")
    top150 = {m: max(runner.cells_for(m, 150), key=lambda c: c["f1"]) for m in models}

    # -- phase D: confirm top cell at lengths 50 and 250 ---------------------
    runner.run(
        [(m, ln, top150[m]["condition"]) for m in models for ln in (50, 250)],
        "D confirm",
    )

    # -- outputs --------------------------------------------------------------
    with (OUT_DIR / "records.jsonl").open("w") as fh:
        for r in runner.records:
            fh.write(json.dumps(r) + "\n")
    cells = []
    for m in models:
        for ln in (50, 150, 250):
            cells.extend(runner.cells_for(m, ln))
    cells.sort(key=lambda c: (c["model"], c["length"], -c["f1"]))
    import csv

    with (OUT_DIR / "matrix.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        w.writeheader()
        w.writerows(cells)

    profiles = {}
    for m in models:
        top = top150[m]
        font, variant = parse_img_condition(top["condition"])
        cols, rows, chars = capacity(FONTS[font], args.size)
        confirm = {ln: runner.cell(m, ln, top["condition"]) for ln in (50, 250)}
        other = next(o for o in models if o != m)
        transfer = runner.cell(other, 150, top["condition"])
        profiles[m] = {
            "model": m,
            "optical_profile": {
                "font": font,
                "variant": variant,
                "px": args.size,
                "cols": cols,
                "rows": rows,
                "chars_per_page": chars,
                "prompt": "qa-image.md",
            },
            "expected": {
                "f1_at_150": round(top["f1"], 4),
                "f1_se_at_150": round(top["f1_se"], 4),
                "cost_usd_at_150": top["cost_usd"],
                "confirm": {
                    str(ln): {
                        "f1": round(c["f1"], 4),
                        "se": round(c["f1_se"], 4),
                        "cost_usd": c["cost_usd"],
                    }
                    for ln, c in confirm.items()
                    if c
                },
            },
            "baseline_img_6x10_sent_f1_at_150": BASELINE[(m, 150)][0],
            "transfer_f1_on_other_model_at_150": round(transfer["f1"], 4)
            if transfer
            else None,
        }
    (OUT_DIR / "profiles.json").write_text(json.dumps(profiles, indent=1))
    (OUT_DIR / "summary.json").write_text(
        json.dumps(
            {"args": vars(args), "best_variant": best_variant, "cells": cells}, indent=1
        )
    )

    # -- console report -------------------------------------------------------
    spend = 0.0
    for m in models:
        print(f"\n== {m} (length 150 screening, sorted by F1) ==")
        base_f1, base_se, base_cost = BASELINE[(m, 150)]
        print(
            f"{'condition':<22}{'n':>5}{'EM':>7}{'F1':>7}{'se':>7}{'abst':>6}{'cost$':>8}{'dF1':>8}"
        )
        for c in sorted(runner.cells_for(m, 150), key=lambda c: -c["f1"]):
            spend += c["cost_usd"]
            print(
                f"{c['condition']:<22}{c['n']:>5}{c['em']:>7.3f}{c['f1']:>7.3f}{c['f1_se']:>7.3f}"
                f"{c['abstained']:>6}{c['cost_usd']:>8.3f}{c['f1'] - base_f1:>+8.3f}"
            )
        print(
            f"{'img-6x10-sent [base]':<22}{'':>5}{'':>7}{base_f1:>7.3f}{base_se:>7.3f}{'':>6}{base_cost:>8.3f}{0:>+8.3f}"
        )
        for ln in (50, 250):
            c = runner.cell(m, ln, top150[m]["condition"])
            if c:
                spend += c["cost_usd"]
                b = BASELINE[(m, ln)]
                print(
                    f"confirm@{ln}: {c['condition']} F1={c['f1']:.3f}+-{c['f1_se']:.3f} cost=${c['cost_usd']:.3f}"
                    f"  (baseline {b[0]:.3f}+-{b[1]:.3f} ${b[2]:.3f})"
                )
    print(f"\ntotal cell cost (incl. cache-free cells): ${spend:.2f}")
    print(f"-> {OUT_DIR}/records.jsonl, matrix.csv, summary.json, profiles.json")


if __name__ == "__main__":
    main()
