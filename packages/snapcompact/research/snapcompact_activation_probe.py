# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers", "sentencepiece", "protobuf", "einops"]
# ///
"""White-box snapcompact activation pilot for a local Hugging Face VLM.

Runs a tiny dense-bitmap/text paired corpus through a local VLM and compares
hidden states across carriers. The default targets the PaddleOCR-VL snapshot
available on spark.internal because the served Qwen2.5-VL NVFP4 checkpoint is a
vLLM/modelopt artifact that Transformers cannot load directly.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from run import CACHE, FONTS, load_prompt  # noqa: E402
from snapcompact_blackbox_occlusion import (
    mask_cells,
    random_span,
    sample_answer_questions,
)  # noqa: E402

DEFAULT_MODEL_DIR = (
    "/home/can/.cache/huggingface/hub/models--PaddlePaddle--PaddleOCR-VL/"
    "snapshots/2b77538ef936207f60c16b45082841068987d08c"
)


def centered_gram(x: np.ndarray) -> np.ndarray:
    gram = x @ x.T
    row_mean = gram.mean(axis=1, keepdims=True)
    col_mean = gram.mean(axis=0, keepdims=True)
    return gram - row_mean - col_mean + gram.mean()


def linear_cka(x: np.ndarray, y: np.ndarray) -> float:
    if x.shape[0] < 2 or y.shape[0] < 2:
        return float("nan")
    x = x - x.mean(axis=0, keepdims=True)
    y = y - y.mean(axis=0, keepdims=True)
    k = centered_gram(x)
    l = centered_gram(y)
    denom = math.sqrt(float((k * k).sum()) * float((l * l).sum()))
    if denom == 0:
        return float("nan")
    return float((k * l).sum() / denom)


def paired_cosine(x: np.ndarray, y: np.ndarray) -> float:
    dot = (x * y).sum(axis=1)
    denom = np.linalg.norm(x, axis=1) * np.linalg.norm(y, axis=1)
    valid = denom > 0
    if not valid.any():
        return float("nan")
    return float((dot[valid] / denom[valid]).mean())


def make_prompt(q: str, cols: int, rows: int) -> str:
    return (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {q}\nAnswer with only the shortest extractive answer."
    )


def to_device(batch: dict[str, Any], device: Any) -> dict[str, Any]:
    return {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}


def hidden_features(
    model: Any, processor: Any, *, image: Image.Image | None, text: str, device: Any
) -> list[np.ndarray]:
    import torch

    if image is None:
        messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
        templated = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        batch = processor(text=templated, return_tensors="pt")
    else:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": text},
                ],
            }
        ]
        templated = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        batch = processor(images=image, text=templated, return_tensors="pt")
    batch = to_device(batch, device)
    with torch.no_grad():
        out = model(
            **batch, output_hidden_states=True, output_attentions=False, use_cache=False
        )
    feats: list[np.ndarray] = []
    for h in out.hidden_states:
        # Mean-pool the prompt sequence. This avoids brittle alignment between
        # image-token and text-token positions while preserving layer geometry.
        pooled = h.float().mean(dim=1).detach().cpu().numpy()[0]
        feats.append(pooled.astype(np.float32, copy=False))
    return feats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--font", default="5x8", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--limit-paras", type=int, default=20)
    ap.add_argument("--qpc", type=int, default=8)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="snapcompact-activation")
    args = ap.parse_args()

    import torch
    from transformers import AutoModel, AutoProcessor

    out_dir = HERE / "results" / args.out
    img_dir = out_dir / "activation-images"
    img_dir.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)

    cfg = FONTS[args.font]
    cols, rows, budget = capacity(cfg, args.size)
    paras = squad.load_paragraphs(CACHE)[: args.limit_paras]
    flow, offsets = squad.build_flow(paras)
    start, end = 0, min(len(flow), budget)
    chunk = flow[start:end]
    questions = sample_answer_questions(paras, offsets, start, end, args.qpc, args.seed)
    if not questions:
        raise SystemExit("no sampled questions fit in the activation chunk")

    base_img = render(chunk, cfg, CACHE, args.size, args.variant)
    base_path = img_dir / "base.png"
    base_img.save(base_path)
    fill = (255, 255, 255) if args.variant not in ("dark", "dark-sent") else (0, 0, 0)

    print(f"loading {args.model_dir}", flush=True)
    processor = AutoProcessor.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True, use_fast=False
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    model = (
        AutoModel.from_pretrained(
            args.model_dir, local_files_only=True, trust_remote_code=True, dtype=dtype
        )
        .to(device)
        .eval()
    )

    feature_sets: dict[str, list[list[np.ndarray]]] = {
        "text": [],
        "image": [],
        "answer_mask": [],
        "random_mask": [],
    }
    records: list[dict[str, Any]] = []
    for qi, q in enumerate(questions):
        span_len = max(1, q["answer_end"] - q["answer_start"])
        rng = random.Random(args.seed * 31 + qi)
        rand_start, rand_end = random_span(
            rng, len(chunk), span_len, q["answer_start"], q["answer_end"]
        )
        answer_img = mask_cells(
            base_img, q["answer_start"], q["answer_end"], cols, cfg.adv, cfg.pitch, fill
        )
        random_img = mask_cells(
            base_img, rand_start, rand_end, cols, cfg.adv, cfg.pitch, fill
        )
        answer_path = img_dir / f"q{qi}-answer-mask.png"
        random_path = img_dir / f"q{qi}-random-mask.png"
        answer_img.save(answer_path)
        random_img.save(random_path)

        img_prompt = make_prompt(q["q"], cols, rows)
        text_prompt = (
            "Below is reference material. Answer the question using only it.\n\n"
            f"<reference>{chunk}</reference>\n\nQuestion: {q['q']}\n"
            "Answer with only the shortest extractive answer."
        )
        feature_sets["text"].append(
            hidden_features(
                model, processor, image=None, text=text_prompt, device=device
            )
        )
        feature_sets["image"].append(
            hidden_features(
                model, processor, image=base_img, text=img_prompt, device=device
            )
        )
        feature_sets["answer_mask"].append(
            hidden_features(
                model, processor, image=answer_img, text=img_prompt, device=device
            )
        )
        feature_sets["random_mask"].append(
            hidden_features(
                model, processor, image=random_img, text=img_prompt, device=device
            )
        )
        records.append(
            {
                "question_index": qi,
                "q": q["q"],
                "golds": q["golds"],
                "answer_text": q["answer_text"],
                "answer_start": q["answer_start"],
                "answer_end": q["answer_end"],
                "random_start": rand_start,
                "random_end": rand_end,
            }
        )
        print(f"captured {qi + 1}/{len(questions)}", flush=True)

    layer_count = len(feature_sets["image"][0])
    layers = []
    for layer in range(layer_count):
        arrays = {
            name: np.stack([sample[layer] for sample in samples], axis=0)
            for name, samples in feature_sets.items()
        }
        img = arrays["image"]
        ans = arrays["answer_mask"]
        rnd = arrays["random_mask"]
        answer_delta = np.linalg.norm(img - ans, axis=1)
        random_delta = np.linalg.norm(img - rnd, axis=1)
        layers.append(
            {
                "layer": layer,
                "cka_text_image": linear_cka(arrays["text"], img),
                "cka_image_answer_mask": linear_cka(img, ans),
                "cka_image_random_mask": linear_cka(img, rnd),
                "cos_text_image": paired_cosine(arrays["text"], img),
                "cos_image_answer_mask": paired_cosine(img, ans),
                "cos_image_random_mask": paired_cosine(img, rnd),
                "answer_delta_norm": float(answer_delta.mean()),
                "random_delta_norm": float(random_delta.mean()),
                "answer_over_random_delta": float(
                    answer_delta.mean() / random_delta.mean()
                )
                if random_delta.mean()
                else float("inf"),
            }
        )

    summary = {
        "args": vars(args),
        "model_dir": args.model_dir,
        "device": str(device),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        "n": len(records),
        "layers": layers,
    }
    with (out_dir / "records.jsonl").open("w") as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
