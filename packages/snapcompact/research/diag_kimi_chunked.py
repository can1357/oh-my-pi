# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""OpenRouter-compatible fix: same mono-prod corpus/questions, but each request
carries <=8 frames (under OpenRouter's silent truncation threshold), with the
questions routed to the chunk that contains their answer.

Chunks of the 21-frame 8on16-bw stack: [0:8], [6:14], [13:21] (overlap guards
against word-wrap boundary drift).

  uv run --with pillow python diag_kimi_chunked.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from final import MODELS, cached  # noqa: E402
from mono_prod import SHAPES, SIZE  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODEL = "moonshotai/kimi-k2.6"
SHAPE_NAME = "8on16-bw"
CHUNKS = [(0, 8), (6, 14), (13, 21)]


def main() -> None:
    keys = {
        "openrouter": load_env_key("OPENROUTER_API_KEY"),
        "anthropic": "",
        "openai": "",
    }
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, 400_000)
    questions = squad.sample_chunk_questions(paras, offsets, 0, len(flow), 25, 42)
    shape = SHAPES[SHAPE_NAME]
    frame_dir = (
        CACHE
        / f"prod-frames-{SHAPE_NAME}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
    )
    pngs = sorted(frame_dir.glob("page-*.png"))
    assert len(pngs) == 21, len(pngs)
    cols = SIZE // shape["cellWidth"]
    rows = SIZE // shape["cellHeight"]

    # Assign each question to the chunk whose frame span contains its answer
    # position with at least one frame of margin (prefer the chunk where the
    # question is most interior).
    n_frames = len(pngs)

    def best_chunk(pos_rel: float) -> int:
        f = pos_rel * n_frames
        scores = [min(f - lo, hi - f) for lo, hi in CHUNKS]
        return max(range(len(CHUNKS)), key=lambda i: scores[i])

    per_chunk: dict[int, list[dict]] = {i: [] for i in range(len(CHUNKS))}
    for q in questions:
        per_chunk[best_chunk(q["pos_rel"])].append(q)

    answers_by_q: dict[str, str] = {}
    usages, stops = [], []
    for ci, (lo, hi) in enumerate(CHUNKS):
        qs = per_chunk[ci]
        if not qs:
            continue
        chunk_pngs = pngs[lo:hi]
        preamble = load_prompt("qa-image-multi.md").format(
            k=len(chunk_pngs), cols=cols, rows=rows
        )
        ctx = [
            {"text": preamble},
            *({"image_path": p} for p in chunk_pngs),
            {"text": "End of images.", "cache": True},
        ]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(qs))
        messages = [{"role": "user", "content": [*ctx, {"text": q_block}]}]
        qa = cached(
            MODEL,
            "qa-mono-prod-chunk8",
            {"messages": messages, "effort": None},
            lambda m=messages: dict(
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(keys, MODEL, m, max_tokens=32768, effort=None),
                )
            ),
            False,
        )
        for q, a in zip(qs, squad.parse_numbered(qa["text"], len(qs))):
            answers_by_q[q["q"]] = a
        usages.append(qa["usage"])
        stops.append(qa["stop"])
        print(
            f"chunk {ci} frames[{lo}:{hi}] nq={len(qs)} in={qa['usage']['in']} stop={qa['stop']}"
        )

    rows_out = [
        {
            "model": MODEL,
            "cond": "diag-chunk8-8on16-bw",
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
    price_in, price_out = MODELS[MODEL]
    cost = u["in"] / 1e6 * price_in + u["out"] / 1e6 * price_out
    quart = []
    for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
        sel = [r["f1"] for r in rows_out if lo <= r["pos_rel"] < hi]
        quart.append(sum(sel) / len(sel) if sel else float("nan"))
    summary = {
        "cond": "diag-chunk8-8on16-bw",
        "n": len(rows_out),
        "imgs": 21,
        "em": sum(r["em"] for r in rows_out) / len(rows_out),
        "f1": sum(r["f1"] for r in rows_out) / len(rows_out),
        "abst": sum(r["abstained"] for r in rows_out),
        "tok_in": u["in"],
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
    out_dir = RESULTS / "diag-kimi-chunk8-8on16-bw"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows_out))
    (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    print(
        f"diag-chunk8 f1={summary['f1']:.3f} em={summary['em']:.3f} abst={summary['abst']} ${summary['cost']:.2f}"
    )
    print(
        "F1 by quartile: " + "  ".join(f"q{i + 1}={v:.3f}" for i, v in enumerate(quart))
    )


if __name__ == "__main__":
    main()
