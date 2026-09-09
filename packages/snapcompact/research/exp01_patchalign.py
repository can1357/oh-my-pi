# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp01: ViT patch-alignment hypothesis.

Vision encoders patch at fixed pixel grids (14/16 px, often 2x2-merged; Gemini
tiles at 768 px = 48*16). Current fonts (pitch 10/12/13) straddle patch
boundaries so glyph rows smear across visual tokens. Test patch-aligned cell
grids against same-glyph-budget misaligned controls:

  aligned:   img-7x14-sent (native X.Org 7x14),
             img-8x16-sent (native Spleen 8x16; X.Org misc-misc has no 8x16),
             img-8on16-sent (8x13 glyphs on an 8x16 cell: identical glyphs to
                             the control, ONLY the pitch changes),
             img-6on7x14-sent (6x12 glyphs on a 7x14 cell)
  controls:  img-7x13-sent, img-8x13-sent (same glyph width, pitch 13)

Render-size probe: 1568 (baseline size) vs 1536 = 2*768 (exact Gemini tile
multiple; integer 2x downsample keeps 16 px pitch on an 8 px grid; also 3*512
for OpenAI tile schemes) for the 16 px-pitch fonts.

Usage: uv run exp01_patchalign.py            # full grid
       uv run exp01_patchalign.py --report   # re-aggregate from cache
"""

import argparse
import csv
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import FontCfg, capacity, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODELS = {
    "gpt-5.5": (2.0, 16.0),
    "google/gemini-3.5-flash": (0.6, 4.0),
}
FONTS = {
    "7x14": FontCfg("7x14", "7x14", 7, 14),  # aligned: pitch = 14 px patch
    "8x16": FontCfg(
        "8x16", "spleen-8x16", 8, 16
    ),  # aligned: native 16 px font (Spleen)
    "8on16": FontCfg("8on16", "8x13", 8, 16),  # aligned: 8x13 glyphs, pitch 16 cell
    "6on7x14": FontCfg("6on7x14", "6x12", 7, 14),  # aligned: 6x12 glyphs, 7x14 cell
    "7x13": FontCfg(
        "7x13", "7x13", 7, 13
    ),  # control for 7x14 (same glyph budget, pitch 13)
    "8x13": FontCfg("8x13", "8x13", 8, 13),  # control for 8x16/8on16
}
SPLEEN_URL = "https://raw.githubusercontent.com/fcambus/spleen/master/spleen-8x16.bdf"
# (condition, render size) cells. 1536 only for 16 px-pitch fonts (14 does not
# divide 768 or 1536).
GRID = (
    ("img-7x14-sent", 1568),
    ("img-7x13-sent", 1568),
    ("img-8x16-sent", 1568),
    ("img-8on16-sent", 1568),
    ("img-8x13-sent", 1568),
    ("img-6on7x14-sent", 1568),
    ("img-8x16-sent", 1536),
    ("img-8on16-sent", 1536),
)
LENGTHS = (50, 150)


def cached(model: str, tag: str, payload: object, fn, fresh: bool) -> dict:
    """Disk-cache `fn() -> dict` keyed by (model, tag, payload). Truncations are not cached."""
    key = sha8(model, tag, json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if path.exists() and not fresh:
        hit = json.loads(path.read_text())
        if hit.get("stop") != "max_tokens":
            return hit
    out = fn()
    if out.get("stop") == "max_tokens":
        print(f"  WARN truncated, not cached: {model} {tag} {key}")
    else:
        path.write_text(json.dumps(out))
    return out


def parse_img_condition(name: str) -> tuple[str, str]:
    _, font, variant = name.split("-", 2)
    return font, variant


def ensure_spleen() -> None:
    """bdf.ensure_font only knows X.Org/tom-thumb URLs; stage Spleen 8x16 ourselves."""
    path = CACHE / "spleen-8x16.bdf"
    if path.exists() and path.stat().st_size > 0:
        return
    tmp = path.with_suffix(".tmp.bdf")
    urllib.request.urlretrieve(SPLEEN_URL, tmp)
    tmp.replace(path)


def run_cell_chunk(
    model: str, cond: str, size: int, start: int, end: int, ctx: dict
) -> list[dict]:
    """One (model, condition, size, chunk) unit: render carrier, QA, score."""
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
    png = CACHE / f"exp01-{font}-{variant}-{sha8(chunk_text, str(size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        render(chunk_text, FONTS[font], CACHE, size, variant).save(tmp)
        tmp.replace(png)
    cols, rows, _ = capacity(FONTS[font], size)
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
        "exp01-qa",
        {"messages": messages, "size": size, "effort": args.effort},
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
    answers = squad.parse_numbered(qa["text"], len(questions))
    records = []
    for q, a in zip(questions, answers):
        records.append(
            {
                "model": model,
                "length": ctx["length"],
                "cond": cond,
                "size": size,
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--lengths", default=",".join(map(str, LENGTHS)))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument(
        "--report",
        action="store_true",
        help="reprint from cache only (re-runs cells; all should hit cache)",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    ensure_spleen()
    out_dir = RESULTS / "exp01-patchalign"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]

    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }

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
            for cond, size in GRID:
                budget = capacity(FONTS[parse_img_condition(cond)[0]], size)[2]
                for start in range(0, len(flow), budget):
                    tasks.append(
                        (model, cond, size, start, min(start + budget, len(flow)), ctx)
                    )
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x {len(GRID)} cells = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell_chunk, m, c, sz, s, e, ctx)
            for m, c, sz, s, e, ctx in tasks
        ]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            if done % 10 == 0:
                print(f"  {done}/{len(tasks)} tasks", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for model in models:
        for length in lengths:
            for cond, size in GRID:
                sub = [
                    r
                    for r in records
                    if r["model"] == model
                    and r["length"] == length
                    and r["cond"] == cond
                    and r["size"] == size
                ]
                if not sub:
                    continue
                cells.append(
                    {
                        "model": model,
                        "length": length,
                        "condition": f"{cond}@{size}",
                        **aggregate(sub, *MODELS[model]),
                    }
                )
    (out_dir / "summary.json").write_text(
        json.dumps({"args": vars(args), "cells": cells}, indent=1)
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    for length in lengths:
        print(f"\n== {length} passages ==  (F1 +-se / n / $)")
        hdr = f"{'condition':<22}" + "".join(f"{m:>34}" for m in models)
        print(hdr + "\n" + "-" * len(hdr))
        for cond, size in GRID:
            label = f"{cond}@{size}"
            row = f"{label:<22}"
            for model in models:
                cell = next(
                    (
                        c
                        for c in cells
                        if c["model"] == model
                        and c["length"] == length
                        and c["condition"] == label
                    ),
                    None,
                )
                row += (
                    f"{cell['f1']:>10.3f} +-{cell['f1_se']:.3f} {cell['n']:>4} {cell['cost_usd']:>7.3f}"
                    if cell
                    else f"{'-':>34}"
                )
            print(row)
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
