# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Forensics: dump raw cached QA responses + per-call usage for the glm mono-prod runs.

Rebuilds the exact request payloads mono_prod.py issued (same flow, shape, seed)
and looks them up in .cache/qa/ by payload hash. No API calls.

  uv run diag_glm_forensics.py --shape 8on16-bw [--model z-ai/glm-4.6v] [--chars 400000]
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from mono_prod import SHAPES, SIZE  # noqa: E402
from run import CACHE, QA_CACHE, load_prompt, sha8  # noqa: E402


def build_batches(shape_name: str, chars: int, n_questions: int, qpb: int, seed: int):
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, chars)
    questions = squad.sample_chunk_questions(
        paras, offsets, 0, len(flow), n_questions, seed
    )
    shape = SHAPES[shape_name]
    frame_dir = (
        CACHE
        / f"prod-frames-{shape_name}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
    )
    pngs = sorted(frame_dir.glob("page-*.png"))
    repeat = shape.get("lineRepeat", 1)
    cols = (
        (SIZE // shape["cellWidth"] - 3) // 2
        if shape.get("columns") == 2
        else SIZE // shape["cellWidth"]
    )
    rows = SIZE // shape["cellHeight"] // repeat
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
    batches = []
    for b in range(0, len(questions), qpb):
        batch = questions[b : b + qpb]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        messages = [{"role": "user", "content": [*ctx_blocks, {"text": q_block}]}]
        batches.append((batch, messages))
    return pngs, batches


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", required=True, choices=sorted(SHAPES))
    ap.add_argument("--model", default="z-ai/glm-4.6v")
    ap.add_argument("--chars", type=int, default=400_000)
    ap.add_argument("--questions", type=int, default=25)
    ap.add_argument("--qpb", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--effort", default=None)
    args = ap.parse_args()

    pngs, batches = build_batches(
        args.shape, args.chars, args.questions, args.qpb, args.seed
    )
    print(f"frames={len(pngs)} batches={len(batches)}")
    for i, (batch, messages) in enumerate(batches):
        payload = {"messages": messages, "effort": args.effort}
        key = sha8(
            args.model, "qa-mono-prod", json.dumps(payload, sort_keys=True, default=str)
        )
        path = QA_CACHE / f"{key}.json"
        print(f"\n=== batch {i + 1} key={key} cached={path.exists()} ===")
        for j, q in enumerate(batch):
            print(f"  Q{j + 1}: {q['q']}  golds={q['golds']}")
        if not path.exists():
            continue
        hit = json.loads(path.read_text())
        print(f"  usage={hit.get('usage')} stop={hit.get('stop')}")
        print("  --- raw text ---")
        print("\n".join("  | " + ln for ln in hit.get("text", "").splitlines()))


if __name__ == "__main__":
    main()
