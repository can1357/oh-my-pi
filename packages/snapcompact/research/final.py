# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""snapcompact final: the blog-post dataset. One command, full grid, CSV out.

Grid: lengths x models x techniques, SQuAD v1.1 dev QA recall (official EM/F1).

  lengths     50 / 150 / 250 passages (~30k / ~102k / ~170k chars)
  models      claude-fable-5, claude-opus-4-8 (Anthropic Messages API)
              gpt-5.5 (OpenAI Responses API)
  techniques  text                      plain-text chunks (ceiling)
              handoff                   agent handoff document, QA on the doc
              compact                   Anthropic: agent compaction-summary prompt
                                        OpenAI: remote /responses/compact window
              img-{6x10,5x8}-{sent,bw}  one 1568x1568 PNG per chunk

Outputs in results/final/: records.jsonl (per question), matrix.csv (per cell),
summary.json. Responses are cached by payload hash: interrupted or re-scoped
runs only bill new cells. `--report` reprints from cache without API calls.

Usage: uv run final.py [--models ...] [--lengths 50,150,250] [--conditions ...]
Keys:  ANTHROPIC_API_KEY + OPENAI_API_KEY from ~/.env.
"""

import argparse
import csv
import json
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from providers import is_openai, llm_complete, load_env_key, openai_compact  # noqa: E402
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

# (family display, $/M input, $/M output). Cached reads bill at 0.1x input,
# Anthropic cache writes at 1.25x. Edit prices here; `--report` recomputes.
MODELS = {
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-4-8": (15.0, 75.0),
    "gpt-5.5": (2.0, 16.0),
    "gpt-5.4-nano": (0.2, 1.25),
    "gpt-5.4-mini": (0.75, 4.5),
    "google/gemini-3.5-flash": (0.6, 4.0),
    "moonshotai/kimi-k2.6": (0.68, 3.41),
    "moonshotai/kimi-k3": (3.00, 15.00),
    "z-ai/glm-4.6v": (0.30, 0.90),
}
LENGTHS = (50, 150, 250)
CONDITIONS = (
    "text",
    "handoff",
    "compact",
    "img-6x10-sent",
    "img-6x10-bw",
    "img-5x8-sent",
    "img-5x8-bw",
)
ACK = "Noted. I have read the passages and will keep them in mind."


def cached(model: str, tag: str, payload: object, fn, fresh: bool) -> dict:
    """Disk-cache `fn() -> dict` keyed by (model, tag, payload). Truncated/empty outputs are not cached."""
    key = sha8(model, tag, json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if path.exists() and not fresh:
        hit = json.loads(path.read_text())
        if hit.get("stop") != "max_tokens" and ("text" not in hit or hit["text"]):
            return hit
    out = fn()
    if out.get("stop") == "max_tokens" or out.get("text") == "":
        print(f"  WARN truncated/empty, not cached: {model} {tag} {key}")
    else:
        path.write_text(json.dumps(out))
    return out


def parse_img_condition(name: str) -> tuple[str, str, int] | None:
    if not name.startswith("img-"):
        return None
    _, font, variant = name.split("-", 2)
    columns = 1
    m = re.match(r"(.+)-(\d+)col$", variant)
    if m:
        variant, columns = m.group(1), int(m.group(2))
    return font, variant, columns


def chunk_budget(cond: str, size: int) -> int:
    img = parse_img_condition(cond)
    return capacity(FONTS[img[0]], size, img[2])[2] if img else TEXT_CHUNK


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


def run_cell_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    """One (model, condition, chunk) unit: build carrier, QA, score."""
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
    img = parse_img_condition(cond)
    extra_items: list[dict] | None = None

    if img:
        font, variant, columns = img
        tag = f"{font}-{variant}" if columns == 1 else f"{font}-{variant}-{columns}col"
        # "dimv2" salts pure-dim renders: pre-fix PNGs (sticky-fg bug, glyphs after a
        # row's first stopword all dimmed) and the QA cache entries keyed on their paths.
        salt = ("dimv2",) if variant == "dim" else ()
        png = CACHE / f"img-{tag}-{sha8(chunk_text, str(args.size), *salt)}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp.png")
            render(
                chunk_text, FONTS[font], CACHE, args.size, variant, columns=columns
            ).save(tmp)
            tmp.replace(png)
        cols, rows, _ = capacity(FONTS[font], args.size, columns)
        preamble = (
            load_prompt("qa-image-cols.md").format(
                cols=cols, rows=rows, columns=columns
            )
            if columns > 1
            else load_prompt("qa-image.md").format(cols=cols, rows=rows)
        )
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": preamble},
                    {"image_path": png},
                    {"text": q_block},
                ],
            }
        ]
    elif cond == "compact" and is_openai(model):
        comp = cached(
            model,
            "remote-compact",
            {"chunk": chunk_text},
            lambda: dict(
                zip(
                    ("items", "usage"),
                    openai_compact(keys["openai"], model, session_frame(chunk_text)),
                )
            ),
            args.fresh,
        )
        usage_rows.append(("compact", comp["usage"]))
        extra_items = comp["items"]
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "text": load_prompt("qa-remote-compact.md").format(
                            questions=q_block
                        )
                    }
                ],
            }
        ]
    elif cond in ("compact", "handoff"):
        prompt_file = {
            "compact": "compaction-summary.md",
            "handoff": "handoff-document.md",
        }[cond]
        gen = cached(
            model,
            f"summary-{cond}",
            {"chunk": chunk_text},
            lambda: dict(
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(
                        keys,
                        model,
                        session_frame(chunk_text)
                        + [
                            {
                                "role": "user",
                                "content": [{"text": agent_prompt(prompt_file)}],
                            }
                        ],
                        system=agent_prompt("summarization-system.md"),
                        max_tokens=args.max_tokens,
                    ),
                )
            ),
            args.fresh,
        )
        usage_rows.append(("summarize", gen["usage"]))
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt("qa-text.md").format(context=gen["text"])},
                    {"text": q_block},
                ],
            }
        ]
    else:  # text
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt("qa-text.md").format(context=chunk_text)},
                    {"text": q_block},
                ],
            }
        ]

    qa = cached(
        model,
        "qa",
        {"messages": messages, "extra": extra_items, "effort": args.effort},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    model,
                    messages,
                    max_tokens=args.max_tokens,
                    effort=args.effort,
                    extra_input_items=extra_items,
                ),
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
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument(
        "--effort", default=None, help="reasoning effort; None = provider default"
    )
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--report", action="store_true", help="reprint from cache only")
    ap.add_argument("--env", default="~/.env")
    ap.add_argument(
        "--out", default="final", help="results subdirectory (isolate concurrent runs)"
    )
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    for m in models:
        if m not in MODELS:
            raise SystemExit(f"unknown model {m}; add it to MODELS with prices")

    keys = {}
    if not args.report:
        keys["anthropic"] = load_env_key("ANTHROPIC_API_KEY", args.env)
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

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
                budget = chunk_budget(cond, args.size)
                for start in range(0, len(flow), budget):
                    tasks.append(
                        (model, cond, start, min(start + budget, len(flow)), ctx)
                    )
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x {len(conditions)} conditions = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell_chunk, m, c, s, e, ctx) for m, c, s, e, ctx in tasks
        ]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(tasks)} tasks", flush=True)

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

    for length in lengths:
        print(f"\n== {length} passages ==  (F1 / $carry-in / $decode-out)")
        hdr = f"{'condition':<15}" + "".join(f"{m:>22}" for m in models)
        print(hdr + "\n" + "-" * len(hdr))
        for cond in conditions:
            row = f"{cond:<15}"
            for model in models:
                cell = next(
                    (
                        c
                        for c in cells
                        if c["model"] == model
                        and c["length"] == length
                        and c["condition"] == cond
                    ),
                    None,
                )
                row += (
                    f"{cell['f1']:>10.3f} {cell['cost_in_usd']:>5.2f} {cell['cost_out_usd']:>5.2f}"
                    if cell
                    else f"{'-':>22}"
                )
            print(row)
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
