# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp11 memhier: memory hierarchy instead of either/or compression.

Split the passage flow by age into thirds (StreamingLLM/H2O intuition, client-side):
  L3 (oldest)  -> narrative compaction summary (agent compaction-summary prompt)
  L2 (middle)  -> optical pages (img-6x10-sent, standard bdf render)
  L1 (newest)  -> verbatim text
One QA context = [L3 summary] + [L2 images] + [L1 text] + questions, framed by
prompts/exp11-qa-hier.md. `hier-appendix` additionally attaches the L3 text as a
dense 5x8-sent optical appendix (summary for gist + image for exact lookup).

Question sets are identical to the uniform text baseline (same seed/qpc/40716-char
chunk grid), so cells are directly comparable. Each record carries a *global*
pos_rel and its tier, enabling the pos_rel-tercile breakdown.
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
from bdf import capacity, render  # noqa: E402
from final import MODELS, aggregate, cached, session_frame  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import (
    CACHE,
    FONTS,
    QA_CACHE,
    RESULTS,
    TEXT_CHUNK,
    agent_prompt,
    load_prompt,
    sha8,
)  # noqa: E402

L2_FONT, L2_VAR = "6x10", "sent"
APX_FONT, APX_VAR = "5x8", "sent"
CONDITIONS = ("hier", "hier-appendix")
APPENDIX_NOTE = (
    ", plus {n_apx} dense bitmap appendix image(s) of the SAME oldest text "
    "(monospace pixel font, {acols} characters per row, {arows} rows; use the appendix "
    "for exact lookups the summary lacks)"
)


def tier_bounds(offsets: list[int], flow_len: int) -> tuple[int, int]:
    """Passage-start offsets nearest to 1/3 and 2/3 of the flow (no passage straddles a tier)."""
    b1 = min(offsets, key=lambda o: abs(o - flow_len / 3))
    b2 = min(offsets, key=lambda o: abs(o - 2 * flow_len / 3))
    return b1, b2


def render_pages(text: str, font: str, var: str, size: int) -> list[Path]:
    cap = capacity(FONTS[font], size)[2]
    pages = []
    for s in range(0, len(text), cap):
        seg = text[s : s + cap]
        png = CACHE / f"exp11-img-{font}-{var}-{sha8(seg, str(size))}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(".tmp.png")
            render(seg, FONTS[font], CACHE, size, var).save(tmp)
            tmp.replace(png)
        pages.append(png)
    return pages


def gen_summary(
    model: str, keys: dict, l3_text: str, max_tokens: int, fresh: bool
) -> dict:
    return cached(
        model,
        "exp11-summary",
        {"chunk": l3_text},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    model,
                    session_frame(l3_text)
                    + [
                        {
                            "role": "user",
                            "content": [
                                {"text": agent_prompt("compaction-summary.md")}
                            ],
                        }
                    ],
                    system=agent_prompt("summarization-system.md"),
                    max_tokens=max_tokens,
                ),
            )
        ),
        fresh,
    )


def context_blocks(
    cond: str,
    summary: str,
    l2_pages: list[Path],
    apx_pages: list[Path],
    l1_text: str,
    size: int,
) -> list[dict]:
    cols, rows, _ = capacity(FONTS[L2_FONT], size)
    apx_note = ""
    if cond == "hier-appendix":
        acols, arows, _ = capacity(FONTS[APX_FONT], size)
        apx_note = APPENDIX_NOTE.format(n_apx=len(apx_pages), acols=acols, arows=arows)
    frame = load_prompt("exp11-qa-hier.md").format(
        appendix_note=apx_note, n_pages=len(l2_pages), cols=cols, rows=rows
    )
    blocks: list[dict] = [
        {"text": frame},
        {"text": f"TIER 3 — SUMMARY OF OLDEST THIRD:\n\n{summary}"},
    ]
    if cond == "hier-appendix":
        for i, p in enumerate(apx_pages):
            blocks.append(
                {
                    "text": f"TIER 3 appendix image {i + 1}/{len(apx_pages)} (same oldest text as dense bitmap):"
                }
            )
            blocks.append({"image_path": p})
    for i, p in enumerate(l2_pages):
        blocks.append(
            {"text": f"TIER 2 page {i + 1}/{len(l2_pages)} (middle third as bitmap):"}
        )
        blocks.append({"image_path": p})
    blocks.append(
        {
            "text": f"TIER 1 — VERBATIM NEWEST THIRD:\n\n<reference>\n{l1_text}\n</reference>"
        }
    )
    return blocks


def run_chunk(model: str, cond: str, start: int, end: int, cell: dict) -> list[dict]:
    """One QA call: shared hierarchical context + this chunk's question batch."""
    args, keys, flow = cell["args"], cell["keys"], cell["flow"]
    questions = squad.sample_chunk_questions(
        cell["paras"], cell["offsets"], start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": cell["blocks"][cond] + [{"text": f"QUESTIONS:\n{q_block}"}],
        }
    ]
    qa = cached(
        model,
        "exp11-qa",
        {
            "cond": cond,
            "length": cell["length"],
            "messages": messages,
            "effort": args.effort,
        },
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
    b1, b2 = cell["bounds"]
    records = []
    for q, a in zip(questions, answers):
        pos_abs = start + q["pos_rel"] * (end - start)
        tier = "L1" if pos_abs >= b2 else ("L2" if pos_abs >= b1 else "L3")
        records.append(
            {
                "model": model,
                "length": cell["length"],
                "cond": cond,
                "chunk": start,
                "pos_rel": round(pos_abs / len(flow), 4),
                "tier": tier,
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


def tier_stats(records: list[dict]) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records]
    mean = sum(f1s) / n
    se = (sum((x - mean) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    return {
        "n": n,
        "em": round(sum(r["em"] for r in records) / n, 4),
        "f1": round(mean, 4),
        "f1_se": round(se, 4),
        "abstained": sum(r["abstained"] for r in records),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="gpt-5.5,google/gemini-3.5-flash")
    ap.add_argument("--lengths", default="150,250")
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--out", default="exp11-memhier")
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

    all_paras = squad.load_paragraphs(CACHE)
    cells: dict[tuple[str, int], dict] = {}
    summary_usage: dict[tuple[str, int], dict] = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        b1, b2 = tier_bounds(offsets, len(flow))
        l3, l2, l1 = flow[:b1], flow[b1:b2], flow[b2:]
        l2_pages = render_pages(l2, L2_FONT, L2_VAR, args.size)
        apx_pages = (
            render_pages(l3, APX_FONT, APX_VAR, args.size)
            if "hier-appendix" in conditions
            else []
        )
        print(
            f"length {length}: flow={len(flow)} chars, tiers L3={len(l3)} L2={len(l2)} L1={len(l1)}, "
            f"l2_pages={len(l2_pages)} apx_pages={len(apx_pages)}"
        )
        for model in models:
            summ = gen_summary(model, keys, l3, args.max_tokens, args.fresh)
            if summ.get("stop") == "max_tokens":
                raise SystemExit(
                    f"summary truncated for {model} length {length}; raise --max-tokens"
                )
            summary_usage[(model, length)] = summ["usage"]
            print(f"  summary[{model}]: {len(summ['text'])} chars")
            cells[(model, length)] = {
                "args": args,
                "keys": keys,
                "flow": flow,
                "paras": paras,
                "offsets": offsets,
                "length": length,
                "bounds": (b1, b2),
                "blocks": {
                    cond: context_blocks(
                        cond, summ["text"], l2_pages, apx_pages, l1, args.size
                    )
                    for cond in conditions
                },
            }

    tasks = []
    for (model, length), cell in cells.items():
        for cond in conditions:
            for start in range(0, len(cell["flow"]), TEXT_CHUNK):
                tasks.append(
                    (
                        model,
                        cond,
                        start,
                        min(start + TEXT_CHUNK, len(cell["flow"])),
                        cell,
                    )
                )
    print(f"grid: {len(tasks)} QA tasks")

    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_chunk, *t) for t in tasks]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} tasks", flush=True)

    # Charge the (cached, shared) summarization once per cell — each condition is a
    # standalone strategy that would need its own summary.
    charged: set[tuple[str, int, str]] = set()
    for r in records:
        key = (r["model"], r["length"], r["cond"])
        if key not in charged and "usage" in r:
            r["usage"].append(
                {"phase": "summarize", **summary_usage[(r["model"], r["length"])]}
            )
            charged.add(key)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cell_rows, tier_rows = [], []
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
                cell_rows.append(
                    {
                        "model": model,
                        "length": length,
                        "condition": cond,
                        **aggregate(sub, *MODELS[model]),
                    }
                )
                for tier in ("L3", "L2", "L1"):
                    tsub = [r for r in sub if r["tier"] == tier]
                    if tsub:
                        tier_rows.append(
                            {
                                "model": model,
                                "length": length,
                                "condition": cond,
                                "tier": tier,
                                **tier_stats(tsub),
                            }
                        )

    (out_dir / "summary.json").write_text(
        json.dumps(
            {"args": vars(args), "cells": cell_rows, "tiers": tier_rows}, indent=1
        )
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cell_rows[0].keys()))
        w.writeheader()
        w.writerows(cell_rows)
    with (out_dir / "terciles.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(tier_rows[0].keys()))
        w.writeheader()
        w.writerows(tier_rows)

    print("\n== cells ==")
    for c in cell_rows:
        print(
            f"{c['model']:<24} {c['length']:>4} {c['condition']:<14} n={c['n']:<4} EM={c['em']:.3f} "
            f"F1={c['f1']:.3f} ±{c['f1_se']:.3f}  abst={c['abstained']:<3} ${c['cost_usd']:.3f}"
        )
    print("\n== pos_rel terciles (tier = where the answer lives) ==")
    for t in tier_rows:
        print(
            f"{t['model']:<24} {t['length']:>4} {t['condition']:<14} {t['tier']} n={t['n']:<3} "
            f"EM={t['em']:.3f} F1={t['f1']:.3f} ±{t['f1_se']:.3f} abst={t['abstained']}"
        )
    print(
        f"\nresults -> {out_dir}/records.jsonl, matrix.csv, terciles.csv, summary.json"
    )


if __name__ == "__main__":
    main()
