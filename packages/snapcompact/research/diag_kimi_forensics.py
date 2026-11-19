# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Forensics: dump cached raw kimi mono-prod responses + per-request usage.

Recomputes the exact cache keys mono_prod.py used (chars=400k, n=25, qpb=5,
seed=42) and prints raw text per batch. Read-only; no API calls.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from mono_prod import SHAPES, SIZE  # noqa: E402
from run import CACHE, load_prompt, sha8  # noqa: E402

QA_CACHE = CACHE / "qa"
MODEL = "moonshotai/kimi-k2.6"


def build_messages(
    shape_name: str,
    chars: int = 400_000,
    questions: int = 25,
    qpb: int = 5,
    seed: int = 42,
):
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, chars)
    qs = squad.sample_chunk_questions(paras, offsets, 0, len(flow), questions, seed)
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
    for b in range(0, len(qs), qpb):
        batch = qs[b : b + qpb]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        messages = [{"role": "user", "content": [*ctx_blocks, {"text": q_block}]}]
        batches.append((batch, messages))
    return pngs, batches


def main() -> None:
    for shape_name in ("8on16-bw", "doc-8on16-sent-dim"):
        pngs, batches = build_messages(shape_name)
        print(f"\n=== {shape_name}: {len(pngs)} frames ===")
        for bi, (batch, messages) in enumerate(batches):
            key = sha8(
                MODEL,
                "qa-mono-prod",
                json.dumps(
                    {"messages": messages, "effort": None}, sort_keys=True, default=str
                ),
            )
            path = QA_CACHE / f"{key}.json"
            if not path.exists():
                print(f"--- batch {bi}: cache MISS ({key})")
                continue
            hit = json.loads(path.read_text())
            u = hit.get("usage", {})
            print(f"--- batch {bi} key={key} stop={hit.get('stop')} usage={u}")
            print(hit.get("text", "")[:2000])


if __name__ == "__main__":
    main()
