# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers"]
# ///
"""Dump how the same content enters Qwen as text tokens vs visual tokens.

Produces a JSON with real tokenizer output (token strings + ids), the real
embedding rows entering the decoder for the answer-word text tokens, and the
real visual-tower output vectors for the image tokens covering the same word.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from run import CACHE, FONTS  # noqa: E402
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
    ap.add_argument("--context-chars", type=int, default=120)
    ap.add_argument("--embed-dims", type=int, default=10)
    ap.add_argument("--out", default="qwen-token-entry")
    args = ap.parse_args()

    import torch
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

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
    from transformers import AutoTokenizer

    processor = AutoProcessor.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True, use_fast=False
    )
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        args.model_dir,
        local_files_only=True,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map="auto",
    ).eval()
    device = next(model.parameters()).device
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True
    )  # fast tokenizer for offsets

    # --- Text lane: real tokenization of the snippet around the answer.
    snip_start = max(0, q["answer_start"] - args.context_chars)
    snip_end = min(len(chunk), q["answer_end"] + args.context_chars)
    snippet = chunk[snip_start:snip_end]
    enc = tokenizer(snippet, add_special_tokens=False, return_offsets_mapping=True)
    tokens = []
    answer_token_idx: list[int] = []
    rel_a = q["answer_start"] - snip_start
    rel_b = q["answer_end"] - snip_start
    for ti, (tok_id, (o0, o1)) in enumerate(
        zip(enc["input_ids"], enc["offset_mapping"])
    ):
        is_answer = o0 < rel_b and o1 > rel_a
        if is_answer:
            answer_token_idx.append(ti)
        tokens.append(
            {
                "i": ti,
                "id": int(tok_id),
                "str": tokenizer.decode([tok_id]),
                "answer": bool(is_answer),
            }
        )

    # Real embedding rows entering the decoder for the answer tokens.
    embed = model.get_input_embeddings()
    answer_ids = torch.tensor(
        [tokens[i]["id"] for i in answer_token_idx], device=device
    )
    with torch.no_grad():
        answer_embeds = embed(answer_ids).float().cpu().numpy()
    text_entry = [
        {
            "id": tokens[i]["id"],
            "str": tokens[i]["str"],
            "vector_head": [
                round(float(v), 4) for v in answer_embeds[k, : args.embed_dims]
            ],
            "norm": round(float(np.linalg.norm(answer_embeds[k])), 4),
        }
        for k, i in enumerate(answer_token_idx)
    ]
    chunk_token_count = len(tokenizer(chunk, add_special_tokens=False)["input_ids"])

    # --- Image lane: real pixel patches and visual-tower output vectors.
    batch = processor(
        images=img,
        text="<|vision_start|><|image_pad|><|vision_end|>",
        return_tensors="pt",
    )
    pixel_values = batch["pixel_values"]
    grid_thw = batch["image_grid_thw"]
    merge = int(getattr(processor.image_processor, "merge_size", 2))
    patch = int(getattr(processor.image_processor, "patch_size", 14))
    with torch.no_grad():
        visual_out = (
            model.model.visual(
                pixel_values.to(device, dtype=torch.bfloat16),
                grid_thw=grid_thw.to(device),
            )
            .float()
            .cpu()
            .numpy()
        )
    n_tokens = visual_out.shape[0]
    grid = int(round(n_tokens**0.5))
    answer_img_indices = image_answer_token_indices(
        q["answer_start"],
        q["answer_end"],
        cols,
        cfg.adv,
        cfg.pitch,
        img.width,
        img.height,
        n_tokens,
    )
    image_entry = [
        {
            "token_index": int(idx),
            "grid_rc": [int(idx // grid), int(idx % grid)],
            "vector_head": [
                round(float(v), 4) for v in visual_out[idx, : args.embed_dims]
            ],
            "norm": round(float(np.linalg.norm(visual_out[idx])), 4),
        }
        for idx in answer_img_indices
    ]
    # A few real normalized pixel values from the first answer patch (pre-visual-tower input).
    patches_per_token = merge * merge
    first_patch_row = (
        answer_img_indices[0] * patches_per_token if answer_img_indices else 0
    )
    pixel_head = [
        round(float(v), 4)
        for v in pixel_values[
            min(first_patch_row, pixel_values.shape[0] - 1), : args.embed_dims
        ].tolist()
    ]

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
        "snippet": snippet,
        "snippet_rel_answer": [rel_a, rel_b],
        "tokens": tokens,
        "text_entry": text_entry,
        "chunk_chars": len(chunk),
        "chunk_text_tokens": chunk_token_count,
        "image_tokens": n_tokens,
        "image_grid": grid,
        "grid_thw": grid_thw.tolist(),
        "patch_size": patch,
        "merge_size": merge,
        "token_pixel_size": patch * merge,
        "processor_resized": [int(grid_thw[0][2]) * patch, int(grid_thw[0][1]) * patch],
        "pixel_values_shape": list(pixel_values.shape),
        "pixel_head_first_answer_patch": pixel_head,
        "image_answer_token_indices": [int(i) for i in answer_img_indices],
        "image_entry": image_entry,
        "embed_dim": int(answer_embeds.shape[1]),
        "visual_out_dim": int(visual_out.shape[1]),
    }
    (out_dir / "token_entry.json").write_text(json.dumps(dump, indent=1))
    print(
        json.dumps(
            {k: v for k, v in dump.items() if k not in ("tokens", "snippet")}, indent=1
        )
    )
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
