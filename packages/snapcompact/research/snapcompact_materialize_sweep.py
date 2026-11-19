# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers"]
# ///
"""Can rendering choices make visual tokens decode to vocabulary EARLIER?

Sweeps rendering conditions (baseline, line-repeat-in-color, patch-aligned
glyph grids) over the same content/question and measures, per condition, the
layer at which the answer word materializes in logit-lens vocabulary space.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import FontCfg, capacity, render  # noqa: E402
from run import CACHE, FONTS, load_prompt  # noqa: E402
from snapcompact_blackbox_occlusion import sample_answer_questions  # noqa: E402

TOKEN_PX = 28  # Qwen2.5-VL merged visual token size at native resolution


@dataclass(frozen=True)
class Condition:
    name: str
    cfg: FontCfg
    variant: str
    repeat: int  # each text line rendered this many times consecutively
    note: str


CONDITIONS = [
    Condition(
        "base-8x13",
        FONTS["8x13"],
        "bw",
        1,
        "baseline: glyphs straddle token cells on both axes",
    ),
    Condition(
        "repeat2-color",
        FONTS["8x13"],
        "color",
        2,
        "every line twice, consecutive rows in different hues",
    ),
    Condition(
        "align-7x14",
        FontCfg("7x14a", "7x13", 7, 14),
        "bw",
        1,
        "4 chars x 2 rows per token, no straddling",
    ),
    Condition(
        "align-14x28",
        FontCfg("14x28a", "7x13", 14, 28, native=(7, 14)),
        "bw",
        1,
        "2 chars x 1 row per token",
    ),
    Condition(
        "align-28x28",
        FontCfg("28x28a", "8x13", 28, 28, native=(8, 13)),
        "bw",
        1,
        "1 char per token",
    ),
    Condition(
        "repeat2-align-14x28",
        FontCfg("14x28a", "7x13", 14, 28, native=(7, 14)),
        "color",
        2,
        "aligned + repeated lines in hues",
    ),
]


def build_layout(chunk: str, cols: int, rows: int, repeat: int) -> tuple[str, int]:
    """Row-major render string with each line repeated `repeat` times.

    Returns (render_text, usable_chars) where usable_chars is how much of
    `chunk` actually fits.
    """
    if repeat == 1:
        usable = min(len(chunk), cols * rows)
        return chunk[:usable], usable
    lines = rows // repeat
    usable = min(len(chunk), cols * lines)
    out: list[str] = []
    for li in range(lines):
        line = chunk[li * cols : (li + 1) * cols].ljust(cols)
        out.append(line * repeat)
    return "".join(out), usable


def answer_token_indices(
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    repeat: int,
    image_size: int,
    grid: int,
) -> list[int]:
    """Visual-token indices covering chars [start, end) under the layout."""
    indices: set[int] = set()
    for i in range(start, end):
        row = i // cols
        col = i % cols
        for copy in range(repeat):
            render_row = row * repeat + copy
            x0 = col * adv
            x1 = min(image_size - 1, (col + 1) * adv - 1)
            y0 = render_row * pitch
            y1 = min(image_size - 1, (render_row + 1) * pitch - 1)
            if y0 >= image_size:
                continue
            for x in (x0, x1):
                for y in (y0, y1):
                    indices.add((y // TOKEN_PX) * grid + (x // TOKEN_PX))
    return sorted(indices)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="Qwen/Qwen2.5-VL-7B-Instruct")
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--limit-paras", type=int, default=80)
    ap.add_argument("--question-index", type=int, default=3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--topk", type=int, default=5)
    ap.add_argument("--out", default="qwen-materialize-sweep")
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

    # The question is selected on the baseline layout; every condition renders a
    # prefix of the same flow, so chunk-relative answer offsets are unchanged.
    base_cfg = FONTS["8x13"]
    base_cols, base_rows, base_budget = capacity(base_cfg, args.size)
    paras = squad.load_paragraphs(CACHE)[: args.limit_paras]
    flow, offsets = squad.build_flow(paras)
    base_chunk = flow[: min(len(flow), base_budget)]
    questions = sample_answer_questions(
        paras, offsets, 0, len(base_chunk), 24, args.seed
    )
    q = questions[min(args.question_index, len(questions) - 1)]
    print(
        f"question: {q['q']!r} answer: {q['answer_text']!r} @ {q['answer_start']}",
        flush=True,
    )

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
    image_token_id = processor.tokenizer.convert_tokens_to_ids(processor.image_token)
    answer_token_ids = tokenizer(q["answer_text"], add_special_tokens=False)[
        "input_ids"
    ]
    answer_id_set = set(answer_token_ids)
    answer_token_strs = [tokenizer.decode([t]) for t in answer_token_ids]
    norm = model.model.language_model.norm
    lm_head = model.lm_head

    conditions_out: list[dict[str, Any]] = []
    for cond in CONDITIONS:
        cols, rows, _cap = capacity(cond.cfg, args.size)
        render_text, usable = build_layout(flow[: cols * rows], cols, rows, cond.repeat)
        if q["answer_end"] > usable:
            print(f"SKIP {cond.name}: answer beyond capacity ({usable})", flush=True)
            continue
        img = render(render_text, cond.cfg, CACHE, args.size, cond.variant)
        img.save(img_dir / f"{cond.name}.png")

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
        ids = batch["input_ids"][0].tolist()
        image_positions = [
            i for i, token_id in enumerate(ids) if token_id == image_token_id
        ]
        grid = int(round(len(image_positions) ** 0.5))
        track = answer_token_indices(
            q["answer_start"],
            q["answer_end"],
            cols,
            cond.cfg.adv,
            cond.cfg.pitch,
            cond.repeat,
            args.size,
            grid,
        )
        track_positions = [image_positions[idx] for idx in track]
        batch = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}

        with torch.no_grad():
            fwd = model(**batch, output_hidden_states=True, use_cache=False)
            generated = model.generate(**batch, max_new_tokens=16, do_sample=False)
        answer_gen = processor.batch_decode(
            generated[:, batch["input_ids"].shape[1] :], skip_special_tokens=True
        )[0].strip()

        layers_data: list[dict[str, Any]] = []
        lock_on_layer: int | None = None
        soft_layer: int | None = None
        with torch.no_grad():
            for layer, hidden in enumerate(fwd.hidden_states):
                states = hidden[0, track_positions, :]
                logits = lm_head(norm(states)).float()
                probs = torch.softmax(logits, dim=-1)
                top1 = probs.argmax(dim=-1)
                answer_p = probs[:, answer_token_ids]  # [n_track, n_answer_tokens]
                best_p = float(answer_p.max())
                top1_hit = any(int(t) in answer_id_set for t in top1)
                best_idx = int(answer_p.max(dim=1).values.argmax())
                tv, ti = probs[best_idx].topk(args.topk)
                layers_data.append(
                    {
                        "layer": layer,
                        "best_answer_p": round(best_p, 6),
                        "top1_hit": bool(top1_hit),
                        "best_token_index": track[best_idx],
                        "best_token_top": [
                            {
                                "str": tokenizer.decode([int(ti[k])]),
                                "p": round(float(tv[k]), 5),
                            }
                            for k in range(args.topk)
                        ],
                    }
                )
                if top1_hit and lock_on_layer is None:
                    lock_on_layer = layer
                if best_p > 0.1 and soft_layer is None:
                    soft_layer = layer
        del fwd
        torch.cuda.empty_cache()

        result = {
            "name": cond.name,
            "note": cond.note,
            "variant": cond.variant,
            "repeat": cond.repeat,
            "adv": cond.cfg.adv,
            "pitch": cond.cfg.pitch,
            "cols": cols,
            "rows": rows,
            "usable_chars": usable,
            "chars_per_token": round(cols * rows / (cond.repeat * grid * grid), 2),
            "tracked_tokens": track,
            "generation": answer_gen,
            "generation_correct": q["answer_text"].lower() in answer_gen.lower(),
            "lock_on_layer": lock_on_layer,
            "soft_layer_p10": soft_layer,
            "max_answer_p": max(l["best_answer_p"] for l in layers_data),
            "layers": layers_data,
        }
        conditions_out.append(result)
        print(
            f"{cond.name}: lock_on={lock_on_layer} soft={soft_layer} max_p={result['max_answer_p']:.3f} gen={answer_gen!r}",
            flush=True,
        )

    summary = {
        "args": vars(args),
        "question": {
            "q": q["q"],
            "answer_text": q["answer_text"],
            "answer_start": q["answer_start"],
            "answer_end": q["answer_end"],
        },
        "answer_token_ids": answer_token_ids,
        "answer_token_strs": answer_token_strs,
        "conditions": conditions_out,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
