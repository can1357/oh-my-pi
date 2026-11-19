# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers"]
# ///
"""Logit-lens dump: what vocabulary word does each visual token become, per layer?

For the visual tokens covering the answer word in a snapcompact bitmap, decode
every layer's hidden state through the final norm + lm_head and record the
top-k vocabulary tokens. If the bitmap is truly read into text space, the
patches' hidden states should decode to the answer's BPE tokens mid-stack.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from run import CACHE, FONTS, load_prompt  # noqa: E402
from snapcompact_blackbox_occlusion import sample_answer_questions  # noqa: E402
from snapcompact_text_image_compare import image_answer_token_indices  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="Qwen/Qwen2.5-VL-7B-Instruct")
    ap.add_argument("--font", default="8x13", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--limit-paras", type=int, default=80)
    ap.add_argument("--question-index", type=int, default=3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--topk", type=int, default=5)
    ap.add_argument("--control-tokens", type=int, default=2)
    ap.add_argument("--out", default="qwen-logit-lens")
    args = ap.parse_args()

    import torch
    from transformers import (
        AutoProcessor,
        AutoTokenizer,
        Qwen2_5_VLForConditionalGeneration,
    )

    out_dir = HERE / "results" / args.out
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)

    cfg = FONTS[args.font]
    cols, rows, budget = capacity(cfg, args.size)
    paras = squad.load_paragraphs(CACHE)[: args.limit_paras]
    flow, offsets = squad.build_flow(paras)
    chunk = flow[: min(len(flow), budget)]
    questions = sample_answer_questions(paras, offsets, 0, len(chunk), 24, args.seed)
    q = questions[min(args.question_index, len(questions) - 1)]
    img = render(chunk, cfg, CACHE, args.size, args.variant)
    img.save(img_dir / "image-carrier.png")

    print(f"loading {args.model_dir}", flush=True)
    processor = AutoProcessor.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True, use_fast=False
    )
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True
    )
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        args.model_dir,
        local_files_only=True,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map="auto",
    ).eval()
    device = next(model.parameters()).device

    prompt = (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {q['q']}\nAnswer with only the shortest extractive answer."
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": img},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    templated = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    batch = processor(images=img, text=templated, return_tensors="pt")
    image_token_id = processor.tokenizer.convert_tokens_to_ids(processor.image_token)
    ids = batch["input_ids"][0].tolist()
    image_positions = [
        i for i, token_id in enumerate(ids) if token_id == image_token_id
    ]
    n_tokens = len(image_positions)
    grid = int(round(n_tokens**0.5))
    answer_indices = image_answer_token_indices(
        q["answer_start"],
        q["answer_end"],
        cols,
        cfg.adv,
        cfg.pitch,
        img.width,
        img.height,
        n_tokens,
    )

    # Controls: blank-region tokens far from any text row boundary effects.
    control_indices = []
    if answer_indices:
        row_far = (answer_indices[0] // grid + grid // 2) % grid
        for k in range(args.control_tokens):
            control_indices.append(row_far * grid + (answer_indices[0] % grid + k))
    track = [("answer", idx) for idx in answer_indices] + [
        ("control", idx) for idx in control_indices
    ]
    track_positions = [image_positions[idx] for _kind, idx in track]

    batch = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}
    with torch.no_grad():
        out = model(**batch, output_hidden_states=True, use_cache=False)

    norm = model.model.language_model.norm
    lm_head = model.lm_head
    answer_token_ids = tokenizer(q["answer_text"], add_special_tokens=False)[
        "input_ids"
    ]
    answer_token_strs = [tokenizer.decode([t]) for t in answer_token_ids]

    lens: list[dict[str, Any]] = []
    with torch.no_grad():
        for layer, hidden in enumerate(out.hidden_states):
            states = hidden[0, track_positions, :]
            logits = lm_head(norm(states)).float()
            probs = torch.softmax(logits, dim=-1)
            topv, topi = probs.topk(args.topk, dim=-1)
            for ti, (kind, idx) in enumerate(track):
                entry = {
                    "layer": layer,
                    "kind": kind,
                    "token_index": int(idx),
                    "grid_rc": [int(idx // grid), int(idx % grid)],
                    "top": [
                        {
                            "str": tokenizer.decode([int(topi[ti, k])]),
                            "id": int(topi[ti, k]),
                            "p": round(float(topv[ti, k]), 5),
                        }
                        for k in range(args.topk)
                    ],
                    "answer_token_p": [
                        round(float(probs[ti, t]), 6) for t in answer_token_ids
                    ],
                }
                lens.append(entry)
            print(f"layer {layer} done", flush=True)

    dump = {
        "args": vars(args),
        "question": {
            "q": q["q"],
            "answer_text": q["answer_text"],
            "answer_start": q["answer_start"],
            "answer_end": q["answer_end"],
        },
        "geometry": {
            "cols": cols,
            "rows": rows,
            "image_w": img.width,
            "image_h": img.height,
        },
        "image_tokens": n_tokens,
        "image_grid": grid,
        "token_pixel_size": 28,
        "answer_token_ids": answer_token_ids,
        "answer_token_strs": answer_token_strs,
        "answer_indices": [int(i) for i in answer_indices],
        "control_indices": [int(i) for i in control_indices],
        "layers": len(out.hidden_states),
        "lens": lens,
    }
    (out_dir / "logit_lens.json").write_text(json.dumps(dump, indent=1))
    # Quick console summary: best layer per answer token.
    for kind, idx in track:
        best = max(
            (e for e in lens if e["token_index"] == idx),
            key=lambda e: max(e["answer_token_p"]),
        )
        print(
            kind,
            idx,
            "best layer",
            best["layer"],
            "p",
            max(best["answer_token_p"]),
            "top1",
            best["top"][0]["str"],
        )
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
