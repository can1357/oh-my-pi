# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Kimi-line chunked benchmark runner over PRODUCTION-rendered frames.

mono_prod protocol (same flow/questions/seed) but every request carries <=8
frames: OpenRouter silently drops images after the first 8, and kimi itself
dilutes >8 genuine frames. Chunk plan = windows of 8 frames, overlap >=1,
evenly spread (reproduces the diag [(0,8),(6,14),(13,21)] plan for 21 frames
so the k2.6 .973 anchor is a cache hit). Questions are routed to the chunk
where their answer position is most interior.

  uv run bench_kimi.py --shape 8on16-bw                        # k2.6 anchor
  uv run bench_kimi.py --model moonshotai/kimi-k3 --shape 8on22-bw

--shape takes a settings variant name from mono_prod.SHAPES (the production
SHAPE_VARIANTS payloads); --shape-json + --name still accept a raw Shape.
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from final import MODELS, cached  # noqa: E402
from mono_prod import SHAPES  # noqa: E402
from providers import _png_b64, _post, load_env_key, llm_complete  # noqa: E402
from run import CACHE, RESULTS, load_prompt, sha8  # noqa: E402

DEFAULT_MODEL = "moonshotai/kimi-k2.6"
FW_MODEL = "accounts/fireworks/models/kimi-k2p6"
FW_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
FW_PRICE = (0.95, 4.00)  # $/M in, out — fireworks.ai/models/fireworks/kimi-k2p6


def fireworks_complete(messages: list[dict], max_tokens: int) -> tuple[str, dict, str]:
    """OpenAI-compatible chat call against Fireworks; normalized like providers usage."""

    def content(blocks: list[dict]) -> list[dict]:
        return [
            {"type": "text", "text": b["text"]}
            if "text" in b
            else {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{_png_b64(b['image_path'])}"
                },
            }
            for b in blocks
        ]

    body = {
        "model": FW_MODEL,
        "messages": [
            {"role": m["role"], "content": content(m["content"])} for m in messages
        ],
        "max_tokens": max_tokens,
    }
    out = _post(
        FW_URL, body, {"authorization": f"Bearer {load_env_key('FIREWORKS_API_KEY')}"}
    )
    choice = (out.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    u = out.get("usage", {})
    usage = {
        "in": u.get("prompt_tokens", 0),
        "out": u.get("completion_tokens", 0),
        "cache_w": 0,
        "cache_r": 0,
        "reasoning": (u.get("completion_tokens_details") or {}).get(
            "reasoning_tokens", 0
        ),
    }
    stop = (
        "max_tokens"
        if choice.get("finish_reason") == "length"
        else (choice.get("finish_reason") or "")
    )
    return text, usage, stop


def plan_chunks(n: int) -> list[tuple[int, int]]:
    """Windows of 8 with overlap >=1, evenly spread. n=21 -> (0,8),(6,14),(13,21)."""
    if n <= 8:
        return [(0, n)]
    k = math.ceil((n - 8) / 7) + 1
    starts = sorted({round(i * (n - 8) / (k - 1)) for i in range(k)})
    return [(s, s + 8) for s in starts]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument(
        "--shape", choices=sorted(SHAPES), help="named shape from mono_prod.SHAPES"
    )
    ap.add_argument(
        "--shape-json", help="raw production Shape JSON (alternative to --shape)"
    )
    ap.add_argument("--name", help="condition label; required with --shape-json")
    ap.add_argument(
        "--route", default="openrouter", choices=["openrouter", "fireworks"]
    )
    ap.add_argument("--chars", type=int, default=400_000)
    ap.add_argument("--questions", type=int, default=25)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument(
        "--frame-tokens",
        type=float,
        default=None,
        help="expected billed tokens per frame (bill sanity)",
    )
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()

    if args.shape_json:
        if not args.name:
            ap.error("--name is required with --shape-json")
        shape, label = json.loads(args.shape_json), args.name
    elif args.shape:
        shape, label = SHAPES[args.shape], args.shape
    else:
        ap.error("pass --shape or --shape-json")
    if args.route == "fireworks" and args.model != DEFAULT_MODEL:
        ap.error("the fireworks route is wired to kimi-k2.6 only")
    if args.route == "openrouter" and args.model not in MODELS:
        ap.error(f"model {args.model} not in final.MODELS; add its prices there")
    keys = {
        "openrouter": load_env_key("OPENROUTER_API_KEY"),
        "anthropic": "",
        "openai": "",
    }
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, args.chars)
    questions = squad.sample_chunk_questions(
        paras, offsets, 0, len(flow), args.questions, args.seed
    )

    # Production frames, same dir-keying convention as mono_prod.py (reuses its renders).
    frame_dir = (
        CACHE / f"prod-frames-{label}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
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
    n_frames = len(pngs)
    size = shape["frameSize"]
    repeat = shape.get("lineRepeat", 1)
    cols = (
        (size // shape["cellWidth"] - 3) // 2
        if shape.get("columns") == 2
        else size // shape["cellWidth"]
    )
    rows = size // shape["cellHeight"] // repeat
    chunks = plan_chunks(n_frames)
    print(f"{label}: {n_frames} frames @{size}px, chunks={chunks}")

    def best_chunk(pos_rel: float) -> int:
        f = pos_rel * n_frames
        scores = [min(f - lo, hi - f) for lo, hi in chunks]
        return max(range(len(chunks)), key=lambda i: scores[i])

    per_chunk: dict[int, list[dict]] = {i: [] for i in range(len(chunks))}
    for q in questions:
        per_chunk[best_chunk(q["pos_rel"])].append(q)

    answers_by_q: dict[str, str] = {}
    usages, stops = [], []
    frames_sent = 0
    for ci, (lo, hi) in enumerate(chunks):
        qs = per_chunk[ci]
        if not qs:
            continue
        chunk_pngs = pngs[lo:hi]
        frames_sent += len(chunk_pngs)
        preamble = load_prompt("qa-image-multi.md").format(
            k=len(chunk_pngs), cols=cols, rows=rows
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
        ctx = [
            {"text": preamble},
            *({"image_path": p} for p in chunk_pngs),
            {"text": "End of images.", "cache": True},
        ]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(qs))
        messages = [{"role": "user", "content": [*ctx, {"text": q_block}]}]
        tag = (
            "qa-mono-prod-chunk8"
            if args.route == "openrouter"
            else "qa-mono-prod-chunk8-fw"
        )
        if args.route == "openrouter":
            fn = lambda m=messages: dict(  # noqa: E731
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(
                        keys, args.model, m, max_tokens=args.max_tokens, effort=None
                    ),
                )
            )
        else:
            fn = lambda m=messages: dict(  # noqa: E731
                zip(("text", "usage", "stop"), fireworks_complete(m, args.max_tokens))
            )
        qa = cached(
            args.model, tag, {"messages": messages, "effort": None}, fn, args.fresh
        )
        for q, a in zip(qs, squad.parse_numbered(qa["text"], len(qs))):
            answers_by_q[q["q"]] = a
        usages.append(qa["usage"])
        stops.append(qa["stop"])
        print(
            f"  chunk {ci} frames[{lo}:{hi}] nq={len(qs)} in={qa['usage']['in']} stop={qa['stop']}"
        )

    rows_out = [
        {
            "model": args.model,
            "cond": f"bench-{label}",
            "pos_rel": q["pos_rel"],
            "q": q["q"],
            "answer": answers_by_q.get(q["q"], ""),
            "golds": q["golds"],
            "em": squad.exact_match(answers_by_q.get(q["q"], ""), q["golds"]),
            "f1": squad.f1(answers_by_q.get(q["q"], ""), q["golds"]),
            "abstained": "unreadable" in answers_by_q.get(q["q"], "").lower(),
        }
        for q in questions
    ]
    u = {
        k: sum(x[k] for x in usages)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    price_in, price_out = (
        MODELS[args.model] if args.route == "openrouter" else FW_PRICE
    )
    cost = u["in"] / 1e6 * price_in + u["out"] / 1e6 * price_out
    quart = []
    for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
        sel = [r["f1"] for r in rows_out if lo <= r["pos_rel"] < hi]
        quart.append(sum(sel) / len(sel) if sel else float("nan"))
    expect_frame = args.frame_tokens or (math.ceil(size / 28) ** 2 + 5)
    bill_ratio = u["in"] / (frames_sent * expect_frame) if frames_sent else float("nan")
    summary = {
        "cond": f"bench-{label}",
        "route": args.route,
        "n": len(rows_out),
        "imgs": n_frames,
        "frames_sent": frames_sent,
        "chunks": chunks,
        "em": sum(r["em"] for r in rows_out) / len(rows_out),
        "f1": sum(r["f1"] for r in rows_out) / len(rows_out),
        "abst": sum(r["abstained"] for r in rows_out),
        "tok_in": u["in"],
        "tok_out": u["out"],
        "reas": u["reasoning"],
        "cost": cost,
        "expect_frame_tokens": expect_frame,
        "bill_ratio": round(bill_ratio, 3),
        "chars_per_dollar": args.chars / cost,
        "chars_per_mtok_in": args.chars / u["in"] * 1e6,
        "stop": next(
            (s for s in stops if s == "max_tokens"), stops[-1] if stops else ""
        ),
        "q1": quart[0],
        "q2": quart[1],
        "q3": quart[2],
        "q4": quart[3],
    }
    out_dir = RESULTS / f"bench-{args.model.split('/')[-1]}-{label}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows_out))
    (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    print(
        f"bench-{label} f1={summary['f1']:.3f} em={summary['em']:.3f} abst={summary['abst']} "
        f"tok_in={u['in']} bill_ratio={summary['bill_ratio']} ${cost:.3f} "
        f"chars/$={summary['chars_per_dollar']:.0f}"
    )
    print(
        "F1 by quartile: " + "  ".join(f"q{i + 1}={v:.3f}" for i, v in enumerate(quart))
    )


if __name__ == "__main__":
    main()
