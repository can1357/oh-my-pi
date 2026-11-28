# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Mono probe over PRODUCTION-rendered snapcompact frames.

Same protocol as mono.py (one request carries the whole 800k-char SQuAD flow,
questions sampled across the span, seed 42), but the frames come from the
shipping TypeScript/Rust pipeline via render_pages.ts instead of the research
PIL renderer. Validates a candidate production shape end-to-end.

  uv run mono_prod.py --shape doc-8on16-bw
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from final import MODELS, cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, RESULTS, load_prompt, sha8  # noqa: E402

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--shape", default="auto", help="production variant name; auto uses the model default"
    )
    ap.add_argument(
        "--shape-json", help="raw production Shape JSON (alternative to --shape)"
    )
    ap.add_argument("--name", help="condition label; required with --shape-json")
    ap.add_argument(
        "--price-in",
        type=float,
        help="$/M input tokens; overrides the final.MODELS table",
    )
    ap.add_argument(
        "--price-out",
        type=float,
        help="$/M output tokens; overrides the final.MODELS table",
    )
    ap.add_argument("--model", default="gpt-5.5")
    ap.add_argument("--chars", type=int, default=800_000)
    ap.add_argument("--questions", type=int, default=50)
    ap.add_argument("--qpb", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()

    keys = {
        "anthropic": load_env_key("ANTHROPIC_API_KEY", args.env),
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, args.chars)
    questions = squad.sample_chunk_questions(
        paras, offsets, 0, len(flow), args.questions, args.seed
    )
    table = MODELS.get(args.model)
    price_in = (
        args.price_in if args.price_in is not None else (table or (None, None))[0]
    )
    price_out = (
        args.price_out if args.price_out is not None else (table or (None, None))[1]
    )
    if price_in is None or price_out is None:
        ap.error(f"model {args.model} not in final.MODELS; pass --price-in/--price-out")

    if args.shape_json:
        if not args.name:
            ap.error("--name is required with --shape-json")
        shape, label = json.loads(args.shape_json), args.name
    else:
        label = args.shape
        shape = json.loads(subprocess.check_output(
            ["bun", str(HERE / "render_pages.ts"), "--resolve-shape", args.model, args.shape],
            text=True,
        ))
    cond = f"prod-{label}"
    size = shape["frameSize"]

    # Production frames (keyed by flow + shape so corpus changes re-render).
    frame_dir = (
        CACHE / f"prod-system-frames-{label}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
    )
    if not frame_dir.exists() or not any(frame_dir.iterdir()):
        flow_file = CACHE / f"prod-flow-{sha8(flow)}.txt"
        flow_file.write_text(flow)
        subprocess.run(
            [
                "bun",
                str(HERE / "render_pages.ts"),
                str(flow_file),
                json.dumps(shape),
                str(frame_dir),
            ],
            check=True,
        )
    pngs = sorted(frame_dir.glob("page-*.png"))
    repeat = shape.get("lineRepeat", 1)
    cols = (
        (size // shape["cellWidth"] - 3) // 2
        if shape.get("columns") == 2
        else size // shape["cellWidth"]
    )
    rows = size // shape["cellHeight"] // repeat
    preamble = load_prompt("qa-image-multi.md").format(
        k=len(pngs), cols=cols, rows=rows
    )
    if shape.get("columns") == 2:
        preamble += (
            "\nNote: each image lays text out as two word-wrapped newspaper columns separated by a gutter; "
            "read the left column top to bottom, then the right column."
        )
    if repeat > 1:
        preamble += (
            f"\nNote: every text line is rendered {repeat} times consecutively - first on the plain "
            "background, then repeated on a pale highlight band. The copies show identical characters; "
            "cross-check between them when a glyph is hard to read, and do not treat copies as separate text."
        )
    ctx_blocks = [
        {"text": preamble},
        *({"image_path": p} for p in pngs),
        {"text": "End of images.", "cache": True},
    ]

    out_dir = RESULTS / f"mono-prod-{args.model.replace('/', '-')}-{label}"
    out_dir.mkdir(parents=True, exist_ok=True)
    answers, usages, stops = [], [], []
    for b in range(0, len(questions), args.qpb):
        batch = questions[b : b + args.qpb]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        messages = [{"role": "user", "content": [*ctx_blocks, {"text": q_block}]}]
        qa = cached(
            args.model,
            "qa-mono-prod",
            {"messages": messages, "effort": args.effort},
            lambda m=messages: dict(
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(
                        keys,
                        args.model,
                        m,
                        max_tokens=args.max_tokens,
                        effort=args.effort,
                    ),
                )
            ),
            args.fresh,
        )
        answers.extend(squad.parse_numbered(qa["text"], len(batch)))
        usages.append(qa["usage"])
        stops.append(qa["stop"])
    rows_out = [
        {
            "model": args.model,
            "cond": cond,
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
    u = {
        k: sum(x[k] for x in usages)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost = (u["in"] + 1.25 * u["cache_w"] + 0.1 * u["cache_r"]) / 1e6 * price_in + u[
        "out"
    ] / 1e6 * price_out
    quart = []
    for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
        qs = [r["f1"] for r in rows_out if lo <= r["pos_rel"] < hi]
        quart.append(sum(qs) / len(qs) if qs else float("nan"))
    summary = {
        "cond": cond,
        "n": len(rows_out),
        "imgs": len(pngs),
        "em": sum(r["em"] for r in rows_out) / len(rows_out),
        "f1": sum(r["f1"] for r in rows_out) / len(rows_out),
        "abst": sum(r["abstained"] for r in rows_out),
        "tok_in": u["in"],
        "tok_cached": u["cache_r"],
        "tok_out": u["out"],
        "reas": u["reasoning"],
        "cost": cost,
        "stop": next(
            (s for s in stops if s == "max_tokens"), stops[-1] if stops else ""
        ),
        "q1": quart[0],
        "q2": quart[1],
        "q3": quart[2],
        "q4": quart[3],
    }
    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows_out))
    (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    print(
        f"{cond:<22} imgs={summary['imgs']:>2} f1={summary['f1']:.3f} em={summary['em']:.3f} "
        f"abst={summary['abst']} ${summary['cost']:.2f} stop={summary['stop']}"
    )
    print(
        "F1 by quartile: " + "  ".join(f"q{i + 1}={v:.3f}" for i, v in enumerate(quart))
    )


if __name__ == "__main__":
    main()
