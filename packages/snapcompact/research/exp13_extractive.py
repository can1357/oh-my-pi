# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp13: extractive compaction baseline ("copy the load-bearing sentences verbatim").

Fixes the strawman in the text-summary family: the existing `compact`/`handoff`
baselines ask for a *narrative* summary, which is hostile to extractive QA
(gemini abstains UNREADABLE on it, F1=0). Here the compaction prompt instead
asks for verbatim spans up to a character budget sized to match the optical
carrier (~2000 tokens ~= 8000 chars per 40716-char chunk; img-6x10 page costs
~1664 input tok on gemini / ~3396 on gpt-5.5).

Pipeline per chunk (mirrors final.py's `compact` branch):
  session_frame(chunk) + exp13-extract.md  -> cached extraction (tag exp13-extract)
  qa-text.md(context=extraction) + questions -> cached QA (tag exp13-qa)
Extraction usage is counted in the cell cost, like the summarize phase.

Extra column vs final.py: gold_survival = fraction of questions whose gold
answer literally survives in the extraction (normalized string containment) —
the recall ceiling of the method, separable from QA ability.

Run from the snapcompact dir:  uv run exp13_extractive.py
"""

import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from squad import _normalize  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, TEXT_CHUNK, load_prompt, sha8  # noqa: E402

MODELS = {
    "gpt-5.5": (2.0, 16.0),
    "google/gemini-3.5-flash": (0.6, 4.0),
}
COND = "extract"
ACK = "Noted. I have read the passages and will keep them in mind."


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


def session_frame(chunk_text: str) -> list[dict]:
    return [
        {
            "role": "user",
            "content": [
                {"text": load_prompt("session-frame.md").format(context=chunk_text)}
            ],
        },
        {"role": "assistant", "content": [{"text": ACK}]},
    ]


def gold_survives(golds: list[str], extraction_norm: str) -> bool:
    return any(_normalize(g) in extraction_norm for g in golds)


def run_cell_chunk(model: str, start: int, end: int, ctx: dict) -> list[dict]:
    """One (model, chunk) unit: extract verbatim spans, QA over the extraction, score."""
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
    usage_rows: list[tuple[str, dict]] = []

    extract_prompt = load_prompt("exp13-extract.md").format(budget=args.budget)
    gen = cached(
        model,
        "exp13-extract",
        {"chunk": chunk_text, "budget": args.budget, "effort": args.extract_effort},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    model,
                    session_frame(chunk_text)
                    + [{"role": "user", "content": [{"text": extract_prompt}]}],
                    max_tokens=args.extract_max_tokens,
                    effort=args.extract_effort,
                ),
            )
        ),
        args.fresh,
    )
    usage_rows.append(("extract", gen["usage"]))
    extraction = gen["text"]
    extraction_norm = _normalize(extraction)

    messages = [
        {
            "role": "user",
            "content": [
                {"text": load_prompt("qa-text.md").format(context=extraction)},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        model,
        "exp13-qa",
        {"messages": messages},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(keys, model, messages, max_tokens=args.max_tokens),
            )
        ),
        args.fresh,
    )
    usage_rows.append(("qa", qa["usage"]))
    answers = squad.parse_numbered(qa["text"], len(questions))
    records = []
    for q, a in zip(questions, answers):
        records.append(
            {
                "model": model,
                "length": ctx["length"],
                "cond": COND,
                "chunk": start,
                "pos_rel": q["pos_rel"],
                "q": q["q"],
                "answer": a,
                "golds": q["golds"],
                "em": squad.exact_match(a, q["golds"]),
                "f1": squad.f1(a, q["golds"]),
                "abstained": "unreadable" in a.lower(),
                "gold_survived": gold_survives(q["golds"], extraction_norm),
            }
        )
    records[0]["usage"] = [{"phase": p, **u} for p, u in usage_rows]
    records[0]["extraction_chars"] = len(extraction)
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
        "gold_survival": sum(r["gold_survived"] for r in records) / n,
        "extraction_chars": sum(r.get("extraction_chars", 0) for r in records),
        **{f"tok_{k}": v for k, v in tok.items()},
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--lengths", default="50,150,250")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--budget", type=int, default=8000, help="max extraction chars per chunk"
    )
    ap.add_argument("--max-tokens", type=int, default=32768, help="QA max tokens")
    ap.add_argument(
        "--extract-max-tokens",
        type=int,
        default=16384,
        help="extraction max tokens (budget+slack)",
    )
    ap.add_argument(
        "--extract-effort",
        default="low",
        help="reasoning effort for the extraction call only; verbatim copying needs no deliberation "
        "(default-effort gemini burns ~16k reasoning tokens verifying quotes and truncates)",
    )
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--out", default="exp13-extractive")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    for m in models:
        if m not in MODELS:
            raise SystemExit(f"unknown model {m}")

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
            for start in range(0, len(flow), TEXT_CHUNK):
                tasks.append((model, start, min(start + TEXT_CHUNK, len(flow)), ctx))
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x 1 condition = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_cell_chunk, m, s, e, ctx) for m, s, e, ctx in tasks]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} tasks", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for model in models:
        for length in lengths:
            sub = [r for r in records if r["model"] == model and r["length"] == length]
            if not sub:
                continue
            cells.append(
                {
                    "model": model,
                    "length": length,
                    "condition": COND,
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
            f"{c['model']:>24} len={c['length']:<4} f1={c['f1']:.3f}±{c['f1_se']:.3f} em={c['em']:.3f} "
            f"survival={c['gold_survival']:.3f} abst={c['abstained']}/{c['n']} cost=${c['cost_usd']:.4f}"
        )
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
