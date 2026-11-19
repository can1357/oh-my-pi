# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp09: append-only optical pages vs rewrite-compaction — prompt-cache economics.

Simulates a growing session over K sequential chunks of the SQuAD flow (length 150
-> 3 pages of img-6x10-sent @ 1568). At each step k the context is pages 1..k and a
QA turn samples questions over ALL pages so far (seed 42).

Regimes:
  A append-optical : prefix = fixed frame + k byte-identical PNG pages (rendered
                     once, reused), QA message last. Prefix grows append-only ->
                     provider prompt cache should re-bill old pages at 0.1x.
                     Zero LLM calls on the write path.
  B rewrite-compact: each step re-summarizes the whole history text with
                     agent compaction-summary.md (one fresh LLM call per step =
                     write-path cost), QA over the fresh summary. The summary
                     rewrite invalidates any prompt-cache prefix.

Cache probe: the same multi-image prefix is sent twice back-to-back (disk cache
bypassed via distinct probe-call payloads) and cache_r is read on both calls —
do image input tokens actually get prefix-cache hits on OpenAI Responses and
OpenRouter/Gemini?

Outputs: results/exp09-cacheappend/{records.jsonl, steps.csv, matrix.csv, summary.json}
"""

import argparse
import csv
import hashlib
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from final import ACK, cached, session_frame  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, FONTS, agent_prompt, load_prompt, sha8  # noqa: E402

MODELS = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
FONT = "6x10"
VARIANT = "sent"
LENGTH = 150
MAX_STEPS = 4
PROBE_TAIL = "Reply with exactly the word OK and nothing else."


def call(
    keys: dict,
    model: str,
    messages: list[dict],
    system: str | None = None,
    max_tokens: int = 32768,
) -> dict:
    t0 = time.monotonic()
    text, usage, stop = llm_complete(
        keys, model, messages, system=system, max_tokens=max_tokens
    )
    return {
        "text": text,
        "usage": usage,
        "stop": stop,
        "secs": round(time.monotonic() - t0, 2),
    }


def usd(u: dict, p_in: float, p_out: float) -> float:
    return (u.get("in", 0) + 0.1 * u.get("cache_r", 0)) / 1e6 * p_in + u.get(
        "out", 0
    ) / 1e6 * p_out


def usd_nocache(u: dict, p_in: float, p_out: float) -> float:
    return (u.get("in", 0) + u.get("cache_r", 0)) / 1e6 * p_in + u.get(
        "out", 0
    ) / 1e6 * p_out


def render_pages(flow: str, size: int) -> tuple[list[tuple[int, int, Path]], dict]:
    """Render each page once; byte-identical files reused across steps. Returns pages + determinism info."""
    budget = capacity(FONTS[FONT], size)[2]
    pages = []
    for i, start in enumerate(range(0, len(flow), budget)):
        chunk = flow[start : start + budget]
        png = CACHE / f"exp09-page{i + 1}-{sha8(chunk, str(size), VARIANT)}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(".tmp.png")
            render(chunk, FONTS[FONT], CACHE, size, VARIANT).save(tmp)
            tmp.replace(png)
        pages.append((start, min(start + budget, len(flow)), png))
    # Write-path determinism of regime A: render page 1 twice in-memory, compare bytes.
    chunk1 = flow[:budget]
    digests = []
    for _ in range(2):
        buf = io.BytesIO()
        render(chunk1, FONTS[FONT], CACHE, size, VARIANT).save(buf, format="PNG")
        digests.append(hashlib.sha256(buf.getvalue()).hexdigest())
    det = {"render_sha256": digests, "deterministic": digests[0] == digests[1]}
    return pages, det


def prefix_messages(k: int, pages: list, cols: int, rows: int) -> list[dict]:
    """Append-only prefix: frame + pages 1..k, each ACKed. Byte-stable across steps."""
    msgs = [
        {
            "role": "user",
            "content": [
                {"text": load_prompt("exp09-frame.md").format(cols=cols, rows=rows)},
                {"image_path": pages[0][2]},
            ],
        },
        {"role": "assistant", "content": [{"text": ACK}]},
    ]
    for i in range(1, k):
        msgs.append(
            {
                "role": "user",
                "content": [
                    {"text": load_prompt("exp09-page.md").format(page=i + 1)},
                    {"image_path": pages[i][2]},
                ],
            }
        )
        msgs.append({"role": "assistant", "content": [{"text": ACK}]})
    return msgs


def step_questions(
    paras: list, offsets: list, end: int, qpc: int, seed: int
) -> tuple[list[dict], str]:
    qs = squad.sample_chunk_questions(paras, offsets, 0, end, qpc, seed)
    return qs, "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(qs))


def score_records(
    model: str, regime: str, step: int, questions: list[dict], text: str
) -> list[dict]:
    answers = squad.parse_numbered(text, len(questions))
    return [
        {
            "model": model,
            "length": LENGTH,
            "cond": regime,
            "step": step,
            "pos_rel": q["pos_rel"],
            "q": q["q"],
            "answer": a,
            "golds": q["golds"],
            "em": squad.exact_match(a, q["golds"]),
            "f1": squad.f1(a, q["golds"]),
            "abstained": "unreadable" in a.lower(),
        }
        for q, a in zip(questions, answers)
    ]


def common_prefix_len(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def run_model(model: str, ctx: dict) -> dict:
    args, keys, flow, paras, offsets, pages = (
        ctx["args"],
        ctx["keys"],
        ctx["flow"],
        ctx["paras"],
        ctx["offsets"],
        ctx["pages"],
    )
    p_in, p_out = MODELS[model]
    cols, rows, _ = capacity(FONTS[FONT], args.size)
    K = len(pages)
    records: list[dict] = []
    steps: list[dict] = []

    # --- Regime A: append-optical (sequential; step k's prefix warms step k+1's cache) ---
    cum_a = 0.0
    for k in range(1, K + 1):
        end = pages[k - 1][1]
        questions, q_block = step_questions(paras, offsets, end, args.qpc, args.seed)
        msgs = prefix_messages(k, pages, cols, rows) + [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt("exp09-qa.md").format(questions=q_block)}
                ],
            }
        ]
        qa = cached(
            model,
            "exp09-A-qa",
            {"step": k, "messages": msgs},
            lambda: call(keys, model, msgs, max_tokens=args.max_tokens),
            args.fresh,
        )
        recs = score_records(model, "append-optical", k, questions, qa["text"])
        recs[0]["usage"] = [{"phase": "qa", **qa["usage"]}]
        records += recs
        cost = usd(qa["usage"], p_in, p_out)
        cum_a += cost
        u = qa["usage"]
        steps.append(
            {
                "model": model,
                "regime": "append-optical",
                "step": k,
                "n": len(recs),
                "f1": round(sum(r["f1"] for r in recs) / len(recs), 3),
                "write_in": 0,
                "write_out": 0,
                "write_secs": 0.0,
                "write_cost": 0.0,
                "qa_in": u["in"],
                "qa_cache_r": u["cache_r"],
                "qa_out": u["out"],
                "qa_reasoning": u.get("reasoning", 0),
                "qa_secs": qa["secs"],
                "step_cost": round(cost, 4),
                "step_cost_nocache": round(usd_nocache(u, p_in, p_out), 4),
                "cum_cost": round(cum_a, 4),
            }
        )
        print(
            f"  {model} A step {k}: in={u['in']} cache_r={u['cache_r']} out={u['out']} f1={steps[-1]['f1']}",
            flush=True,
        )

    # --- Cache probe: identical multi-image prefix twice in a row (disk cache bypassed via call index) ---
    probe_msgs = prefix_messages(K, pages, cols, rows) + [
        {"role": "user", "content": [{"text": PROBE_TAIL}]}
    ]
    probe = []
    for i in (1, 2, 3):
        r = cached(
            model,
            "exp09-probe",
            {"call": i, "messages": probe_msgs},
            lambda: call(keys, model, probe_msgs, max_tokens=args.max_tokens),
            args.fresh,
        )
        probe.append({"call": i, **r["usage"], "secs": r["secs"]})
        print(
            f"  {model} probe call {i}: in={r['usage']['in']} cache_r={r['usage']['cache_r']}",
            flush=True,
        )

    # --- Regime B: rewrite-compact (fresh summary each step = write path) ---
    cum_b = 0.0
    summaries: list[str] = []
    for k in range(1, K + 1):
        end = pages[k - 1][1]
        text_k = flow[:end]
        questions, q_block = step_questions(paras, offsets, end, args.qpc, args.seed)
        sm = cached(
            model,
            "exp09-B-sum",
            {"step": k, "chunk": sha8(text_k)},
            lambda: call(
                keys,
                model,
                session_frame(text_k)
                + [
                    {
                        "role": "user",
                        "content": [{"text": agent_prompt("compaction-summary.md")}],
                    }
                ],
                system=agent_prompt("summarization-system.md"),
                max_tokens=args.max_tokens,
            ),
            args.fresh,
        )
        summaries.append(sm["text"])
        qa_msgs = [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt("qa-text.md").format(context=sm["text"])},
                    {"text": q_block},
                ],
            }
        ]
        qa = cached(
            model,
            "exp09-B-qa",
            {"step": k, "summary": sm["text"], "q": q_block},
            lambda: call(keys, model, qa_msgs, max_tokens=args.max_tokens),
            args.fresh,
        )
        recs = score_records(model, "rewrite-compact", k, questions, qa["text"])
        recs[0]["usage"] = [
            {"phase": "summarize", **sm["usage"]},
            {"phase": "qa", **qa["usage"]},
        ]
        records += recs
        w_cost = usd(sm["usage"], p_in, p_out)
        q_cost = usd(qa["usage"], p_in, p_out)
        cum_b += w_cost + q_cost
        su, qu = sm["usage"], qa["usage"]
        steps.append(
            {
                "model": model,
                "regime": "rewrite-compact",
                "step": k,
                "n": len(recs),
                "f1": round(sum(r["f1"] for r in recs) / len(recs), 3),
                "write_in": su["in"] + su["cache_r"],
                "write_out": su["out"],
                "write_secs": sm["secs"],
                "write_cost": round(w_cost, 4),
                "qa_in": qu["in"],
                "qa_cache_r": qu["cache_r"],
                "qa_out": qu["out"],
                "qa_reasoning": qu.get("reasoning", 0),
                "qa_secs": qa["secs"],
                "step_cost": round(w_cost + q_cost, 4),
                "step_cost_nocache": round(
                    usd_nocache(su, p_in, p_out) + usd_nocache(qu, p_in, p_out), 4
                ),
                "cum_cost": round(cum_b, 4),
            }
        )
        print(
            f"  {model} B step {k}: write {su['in']}+{su['cache_r']}c->{su['out']} ({sm['secs']}s) f1={steps[-1]['f1']}",
            flush=True,
        )

    # Write-path determinism of regime B: re-run the step-1 summarize with identical payload (fresh key).
    det = cached(
        model,
        "exp09-B-sum-det",
        {"step": 1, "chunk": sha8(flow[: pages[0][1]])},
        lambda: call(
            keys,
            model,
            session_frame(flow[: pages[0][1]])
            + [
                {
                    "role": "user",
                    "content": [{"text": agent_prompt("compaction-summary.md")}],
                }
            ],
            system=agent_prompt("summarization-system.md"),
            max_tokens=args.max_tokens,
        ),
        args.fresh,
    )
    b_det = {
        "identical": det["text"] == summaries[0],
        "common_prefix_chars": common_prefix_len(det["text"], summaries[0]),
        "len_a": len(summaries[0]),
        "len_b": len(det["text"]),
    }
    # Cross-step summary prefix stability (the thing the prompt cache would need).
    step_stability = [
        {
            "steps": f"{k}->{k + 1}",
            "common_prefix_chars": common_prefix_len(summaries[k - 1], summaries[k]),
            "len_prev": len(summaries[k - 1]),
            "len_next": len(summaries[k]),
        }
        for k in range(1, K)
    ]
    return {
        "records": records,
        "steps": steps,
        "probe": probe,
        "b_determinism": b_det,
        "b_step_stability": step_stability,
    }


def aggregate(records: list[dict], p_in: float, p_out: float) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records]
    mean_f1 = sum(f1s) / n
    se = (sum((x - mean_f1) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    us = [u for r in records if "usage" in r for u in r["usage"]]
    tok = {
        k: sum(u.get(k, 0) for u in us)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost_in = (tok["in"] + 0.1 * tok["cache_r"]) / 1e6 * p_in
    cost_out = tok["out"] / 1e6 * p_out
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
    ap.add_argument("--qpc", type=int, default=10)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp09-cacheappend"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }

    paras = squad.load_paragraphs(CACHE)[:LENGTH]
    flow, offsets = squad.build_flow(paras)
    pages, a_det = render_pages(flow, args.size)
    pages = pages[:MAX_STEPS]
    print(
        f"flow {len(flow)} chars -> {len(pages)} pages (K={len(pages)} steps); render deterministic: {a_det['deterministic']}"
    )

    ctx = {
        "args": args,
        "keys": keys,
        "flow": flow,
        "paras": paras,
        "offsets": offsets,
        "pages": pages,
    }
    with ThreadPoolExecutor(min(2, len(models))) as pool:
        results = dict(zip(models, pool.map(lambda m: run_model(m, ctx), models)))

    records = [r for m in models for r in results[m]["records"]]
    steps = [s for m in models for s in results[m]["steps"]]

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    with (out_dir / "steps.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(steps[0].keys()))
        w.writeheader()
        w.writerows(steps)

    cells = []
    for model in models:
        for cond in ("append-optical", "rewrite-compact"):
            sub = [r for r in records if r["model"] == model and r["cond"] == cond]
            final_step = max(r["step"] for r in sub)
            fin = [r for r in sub if r["step"] == final_step]
            cell = {
                "model": model,
                "length": LENGTH,
                "condition": cond,
                **aggregate(sub, *MODELS[model]),
            }
            cell["final_step_f1"] = round(sum(r["f1"] for r in fin) / len(fin), 3)
            cell["final_step_em"] = round(sum(r["em"] for r in fin) / len(fin), 3)
            cells.append(cell)
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        w.writeheader()
        w.writerows(cells)

    summary = {
        "args": vars(args),
        "pages": [{"start": s, "end": e, "png": p.name} for s, e, p in pages],
        "render_determinism": a_det,
        "cells": cells,
        "steps": steps,
        "probe": {m: results[m]["probe"] for m in models},
        "b_determinism": {m: results[m]["b_determinism"] for m in models},
        "b_step_stability": {m: results[m]["b_step_stability"] for m in models},
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=str))

    print(
        "\n== per-step (qa_in / qa_cache_r / write_cost / step_cost / cum_cost / f1) =="
    )
    for s in steps:
        print(
            f"{s['model']:<26} {s['regime']:<16} k={s['step']}  in={s['qa_in']:>6} cache_r={s['qa_cache_r']:>6} "
            f"write=${s['write_cost']:.4f} step=${s['step_cost']:.4f} cum=${s['cum_cost']:.4f} f1={s['f1']:.3f}"
        )
    print("\n== cache probe (same multi-image prefix twice) ==")
    for m in models:
        for p in results[m]["probe"]:
            print(
                f"{m:<26} call {p['call']}: in={p['in']:>6} cache_r={p['cache_r']:>6} secs={p['secs']}"
            )
    print(f"\ndataset -> {out_dir}/records.jsonl, steps.csv, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
