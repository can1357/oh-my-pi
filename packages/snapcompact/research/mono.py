"""Monolithic long-context probe: the WHOLE corpus in ONE request.

final.py chunks every condition into ~10k-token QA calls, so it never tests
true in-request long-context retrieval. This runner stuffs an N-char SQuAD
flow (e.g. 800k chars ~ 200k text tokens) into a single request — either as
raw text or as a stack of dense-font images — with questions sampled evenly
across the whole span. Reports overall EM/F1 plus F1 by position quartile
(real lost-in-the-middle, which the chunked harness cannot see).

  uv run --with pillow python mono.py --model gpt-5.5 --chars 800000 \
      --conditions text,img-6x10-sent,img-6x8s-sent,img-8x8u-sent
"""

import argparse
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from final import MODELS, cached, parse_img_condition  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, RESULTS, load_prompt, sha8  # noqa: E402


def build_content(cond: str, flow: str, size: int) -> tuple[list[dict], int]:
    """Context blocks for the whole flow (questions appended per batch); returns (blocks, n_images)."""
    img = parse_img_condition(cond)
    if not img:
        assert cond == "text", f"unsupported mono condition {cond!r}"
        return [
            {"text": load_prompt("qa-text.md").format(context=flow), "cache": True}
        ], 0
    font, variant, columns = img
    cfg = FONTS[font]
    cols, rows, cap = capacity(cfg, size, columns)
    salt = ("dimv2",) if variant == "dim" else ()
    tag = f"{font}-{variant}" if columns == 1 else f"{font}-{variant}-{columns}col"
    pngs = []
    for start in range(0, len(flow), cap):
        chunk = flow[start : start + cap]
        png = CACHE / f"img-{tag}-{sha8(chunk, str(size), *salt)}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp.png")
            render(chunk, cfg, CACHE, size, variant, columns=columns).save(tmp)
            tmp.replace(png)
        pngs.append(png)
    preamble = load_prompt("qa-image-multi.md").format(
        k=len(pngs), cols=cols, rows=rows
    )
    if cfg.repeat > 1:
        preamble += (
            f"\nNote: every text line is rendered {cfg.repeat} times consecutively - first on the plain "
            "background, then repeated on a pale highlight band. The copies show identical characters; "
            "cross-check between them when a glyph is hard to read, and do not treat copies as separate text."
        )
    blocks = [
        {"text": preamble},
        *({"image_path": p} for p in pngs),
        {"text": "End of images.", "cache": True},
    ]
    return blocks, len(pngs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt-5.5")
    ap.add_argument("--chars", type=int, default=800_000)
    ap.add_argument(
        "--conditions", default="text,img-6x10-sent,img-6x8s-sent,img-8x8u-sent"
    )
    ap.add_argument(
        "--questions",
        type=int,
        default=50,
        help="total questions sampled across the flow",
    )
    ap.add_argument(
        "--qpb",
        type=int,
        default=5,
        help="questions per API call (context re-sent, prefix-cached)",
    )
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--out", default="mono")
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
    price_in, price_out = MODELS[args.model]
    print(
        f"flow: {len(flow):,} chars (~{len(flow) // 4 // 1000}k text tokens), "
        f"{len(questions)} questions in batches of {args.qpb}"
    )

    out_dir = RESULTS / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    records, table = [], []
    for cond in [c.strip() for c in args.conditions.split(",") if c.strip()]:
        ctx_blocks, n_imgs = build_content(cond, flow, args.size)
        answers, usages, stops = [], [], []
        for b in range(0, len(questions), args.qpb):
            batch = questions[b : b + args.qpb]
            q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
            messages = [{"role": "user", "content": [*ctx_blocks, {"text": q_block}]}]
            qa = cached(
                args.model,
                "qa-mono",
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
        rows = [
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
        records.extend(
            {**r, "usage": usages} if i == 0 else r for i, r in enumerate(rows)
        )
        u = {
            k: sum(x[k] for x in usages)
            for k in ("in", "out", "cache_w", "cache_r", "reasoning")
        }
        stop = next((s for s in stops if s == "max_tokens"), stops[-1] if stops else "")
        cost = (
            u["in"] + 1.25 * u["cache_w"] + 0.1 * u["cache_r"]
        ) / 1e6 * price_in + u["out"] / 1e6 * price_out
        quart = []
        for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
            qs = [r["f1"] for r in rows if lo <= r["pos_rel"] < hi]
            quart.append(sum(qs) / len(qs) if qs else float("nan"))
        table.append(
            {
                "cond": cond,
                "n": len(rows),
                "imgs": n_imgs,
                "em": sum(r["em"] for r in rows) / len(rows),
                "f1": sum(r["f1"] for r in rows) / len(rows),
                "abst": sum(r["abstained"] for r in rows),
                "tok_in": u["in"],
                "tok_cached": u["cache_r"],
                "tok_out": u["out"],
                "reas": u["reasoning"],
                "cost": cost,
                "stop": stop,
                "q1": quart[0],
                "q2": quart[1],
                "q3": quart[2],
                "q4": quart[3],
            }
        )
        t = table[-1]
        print(
            f"{cond:<18} imgs={t['imgs']:>2} f1={t['f1']:.3f} em={t['em']:.3f} abst={t['abst']:>2} "
            f"in={t['tok_in']:>7} cached={t['tok_cached']:>7} out={t['tok_out']:>6} reas={t['reas']:>6} "
            f"${t['cost']:.2f} stop={t['stop']}"
        )
        print(
            f"{'':<18} F1 by position quartile: "
            + "  ".join(f"q{i + 1}={v:.3f}" for i, v in enumerate(quart))
        )

    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in records))
    (out_dir / "summary.json").write_text(json.dumps(table, indent=1))
    print(f"\ndataset -> {out_dir}/records.jsonl, summary.json")


if __name__ == "__main__":
    main()
