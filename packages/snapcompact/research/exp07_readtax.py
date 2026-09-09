# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp07 read tax: kill reasoning/output-token inflation on image conditions.

Image-condition cost is dominated by reasoning tokens — models transcribe the
whole bitmap in CoT before answering. Carrier is the baseline winner
(img-6x10-sent, 1568px) unchanged; only the QA protocol varies:

  baseline           - exact baseline protocol, re-measured for a latency
                       reference (baseline matrices have no wall-clock data)
  effort-low         - qa-image.md, effort="low"
  effort-minimal     - qa-image.md, effort="minimal" (gpt-5.5 only, if accepted)
  no-transcribe      - prompts/exp07-qa-image.md: explicit "do not transcribe,
                       locate the region per question, read only that region"
  locate-then-answer - two turns: (1) effort=low, output only a row-band guess
                       per question; (2) same conversation + "read only those
                       bands, answer".  Combined cost/latency tracked.

Wall-clock latency is measured around every llm_complete and stored inside the
response cache entry, so resumes keep real timings.
"""

import argparse
import csv
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from final import cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODELS = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
LENGTHS = (50, 150)
CONDITIONS = (
    "baseline",
    "effort-low",
    "effort-minimal",
    "no-transcribe",
    "locate-then-answer",
    "locate-low",
    "locate-none",
)
FONT, VARIANT = "6x10", "sent"


def ensure_png(chunk_text: str, size: int) -> Path:
    """Reuse the baseline cache PNG when present (identical render), else write exp07-prefixed."""
    h = sha8(chunk_text, str(size))
    base = CACHE / f"img-{FONT}-{VARIANT}-{h}.png"
    if base.exists() and base.stat().st_size > 0:
        return base
    png = CACHE / f"exp07-img-{FONT}-{VARIANT}-{h}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        render(chunk_text, FONTS[FONT], CACHE, size, VARIANT).save(tmp)
        tmp.replace(png)
    return png


def timed_call(
    keys: dict, model: str, messages: list[dict], max_tokens: int, effort: str | None
) -> dict:
    t0 = time.monotonic()
    text, usage, stop = llm_complete(
        keys, model, messages, max_tokens=max_tokens, effort=effort
    )
    return {
        "text": text,
        "usage": usage,
        "stop": stop,
        "latency_s": round(time.monotonic() - t0, 2),
    }


def probe_min_effort(keys: dict) -> str | None:
    """Lowest reasoning effort gpt-5.5 accepts: try "minimal", fall back to "none"."""
    for effort in ("minimal", "none"):
        try:
            llm_complete(
                keys,
                "gpt-5.5",
                [
                    {
                        "role": "user",
                        "content": [{"text": "Reply with the single word OK."}],
                    }
                ],
                max_tokens=64,
                effort=effort,
            )
            return effort
        except SystemExit as err:
            print(f"effort={effort} rejected by gpt-5.5: {str(err)[:160]}")
    return None


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
    png = ensure_png(chunk_text, args.size)
    cols, rows, _ = capacity(FONTS[FONT], args.size)
    usage_rows: list[tuple[str, dict]] = []

    def qa_messages(prompt_file: str) -> list[dict]:
        return [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt(prompt_file).format(cols=cols, rows=rows)},
                    {"image_path": png},
                    {"text": q_block},
                ],
            }
        ]

    if cond.startswith("locate"):
        turn2_effort = {
            "locate-then-answer": None,
            "locate-low": "low",
            "locate-none": "none",
        }[cond]
        locate_msgs = qa_messages("exp07-locate.md")
        locate = cached(
            model,
            "exp07-locate",
            {"messages": locate_msgs, "effort": "low"},
            lambda: timed_call(keys, model, locate_msgs, args.max_tokens, "low"),
            args.fresh,
        )
        usage_rows.append(
            ("locate", {**locate["usage"], "latency_s": locate.get("latency_s", 0)})
        )
        answer_msgs = locate_msgs + [
            {"role": "assistant", "content": [{"text": locate["text"]}]},
            {
                "role": "user",
                "content": [{"text": load_prompt("exp07-answer-bands.md")}],
            },
        ]
        qa = cached(
            model,
            "exp07-qa",
            {"cond": cond, "messages": answer_msgs, "effort": turn2_effort},
            lambda: timed_call(keys, model, answer_msgs, args.max_tokens, turn2_effort),
            args.fresh,
        )
    else:
        prompt_file = "exp07-qa-image.md" if cond == "no-transcribe" else "qa-image.md"
        effort = cond.removeprefix("effort-") if cond.startswith("effort-") else None
        messages = qa_messages(prompt_file)
        qa = cached(
            model,
            "exp07-qa",
            {"cond": cond, "messages": messages, "effort": effort},
            lambda: timed_call(keys, model, messages, args.max_tokens, effort),
            args.fresh,
        )
    usage_rows.append(("qa", {**qa["usage"], "latency_s": qa.get("latency_s", 0)}))

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
    records[0]["usage"] = [{"phase": p, **u} for p, u in usage_rows]
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
    # Per-chunk latency = sum over phases (locate + qa for the two-turn protocol).
    chunk_lat = [
        sum(u.get("latency_s", 0) for u in r["usage"]) for r in records if "usage" in r
    ]
    return {
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        **{f"tok_{k}": v for k, v in tok.items()},
        "latency_p50_s": round(statistics.median(chunk_lat), 1) if chunk_lat else 0.0,
        "latency_max_s": round(max(chunk_lat), 1) if chunk_lat else 0.0,
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--lengths", default=",".join(map(str, LENGTHS)))
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--out", default="exp07-readtax")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }
    min_effort = (
        probe_min_effort(keys)
        if "effort-minimal" in conditions and "gpt-5.5" in models
        else None
    )
    print(f"lowest gpt-5.5 effort: {min_effort or 'unavailable -> condition skipped'}")
    if "effort-minimal" in conditions:
        conditions = [
            f"effort-{min_effort}" if c == "effort-minimal" and min_effort else c
            for c in conditions
        ]
        conditions = [c for c in conditions if c != "effort-minimal"]

    budget = capacity(FONTS[FONT], args.size)[2]
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
                if (
                    cond in (f"effort-{min_effort}", "locate-none")
                    and model != "gpt-5.5"
                ):
                    continue
                if cond == "locate-none" and min_effort != "none":
                    continue
                for start in range(0, len(flow), budget):
                    tasks.append(
                        (model, cond, start, min(start + budget, len(flow)), ctx)
                    )
    print(f"grid: {len(tasks)} chunk tasks")

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell_chunk, m, c, s, e, ctx) for m, c, s, e, ctx in tasks
        ]
        for i, fut in enumerate(futures, 1):
            records.extend(fut.result())
            print(f"  {i}/{len(tasks)} tasks", flush=True)

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
                cells.append(
                    {
                        "model": model,
                        "length": length,
                        "condition": cond,
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

    for c in cells:
        print(
            f"{c['model']:>24} L{c['length']:<4}{c['condition']:<20}"
            f"F1 {c['f1']:.3f}±{c['f1_se']:.3f}  reas {c['tok_reasoning']:>6}  out {c['tok_out']:>6}"
            f"  p50 {c['latency_p50_s']:>6.1f}s  ${c['cost_usd']:.4f}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
