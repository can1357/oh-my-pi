# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers"]
# ///
"""Do text and image carriers converge to the same internal state?

For N questions over the same chunk, capture the last-prompt-token hidden state
(the model's "about to answer" summary) per decoder layer, once with the chunk
as raw text and once as a snapcompact bitmap. Carrier-specific means are
subtracted per layer so prompt boilerplate and modality signatures cancel out.

Evidence of convergence:
1. matched pairs (same question, different carrier) >> mismatched pairs
2. the question-by-question similarity geometry (RSA) is shared across carriers
3. both carriers generate the same answers
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from run import CACHE, FONTS, load_prompt  # noqa: E402
from snapcompact_blackbox_occlusion import sample_answer_questions  # noqa: E402


def make_text_prompt(chunk: str, question: str) -> str:
    return (
        "Below is reference material. Answer the question using only it.\n\n"
        f"<reference>{chunk}</reference>\n\nQuestion: {question}\n"
        "Answer with only the shortest extractive answer."
    )


def make_image_prompt(cols: int, rows: int, question: str) -> str:
    return (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {question}\nAnswer with only the shortest extractive answer."
    )


def capture_last_token(
    model: Any, processor: Any, device: Any, text: str, image: Image.Image | None
) -> tuple[np.ndarray, str]:
    """Return per-layer hidden state at the final prompt position plus a short generation."""
    import torch

    content: list[dict[str, Any]] = []
    if image is not None:
        content.append({"type": "image", "image": image})
    content.append({"type": "text", "text": text})
    templated = processor.apply_chat_template(
        [{"role": "user", "content": content}],
        tokenize=False,
        add_generation_prompt=True,
    )
    if image is not None:
        batch = processor(images=image, text=templated, return_tensors="pt")
    else:
        batch = processor(text=templated, return_tensors="pt")
    batch = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}
    with torch.no_grad():
        out = model(**batch, output_hidden_states=True, use_cache=False)
        generated = model.generate(**batch, max_new_tokens=16, do_sample=False)
    states = np.stack(
        [h[0, -1, :].float().detach().cpu().numpy() for h in out.hidden_states], axis=0
    )
    answer = processor.batch_decode(
        generated[:, batch["input_ids"].shape[1] :], skip_special_tokens=True
    )[0].strip()
    return states.astype(np.float32, copy=False), answer


def cosine_rows(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a_n = a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-6)
    b_n = b / np.maximum(np.linalg.norm(b, axis=-1, keepdims=True), 1e-6)
    return a_n @ b_n.T


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="Qwen/Qwen2.5-VL-7B-Instruct")
    ap.add_argument("--font", default="8x13", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--limit-paras", type=int, default=80)
    ap.add_argument("--questions", type=int, default=12)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="qwen-carrier-convergence")
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
    questions = sample_answer_questions(
        paras, offsets, 0, len(chunk), args.questions * 2, args.seed
    )
    # Deduplicate gold answers so the RSA geometry has distinct content per row.
    seen: set[str] = set()
    picked: list[dict[str, Any]] = []
    for q in questions:
        key = q["answer_text"].lower()
        if key not in seen:
            seen.add(key)
            picked.append(q)
        if len(picked) >= args.questions:
            break
    if len(picked) < 4:
        raise SystemExit("not enough distinct questions in chunk")
    img = render(chunk, cfg, CACHE, args.size, args.variant)
    img.save(img_dir / "image-carrier.png")

    print(f"loading {args.model_dir}", flush=True)
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

    text_states: list[np.ndarray] = []
    image_states: list[np.ndarray] = []
    records: list[dict[str, Any]] = []
    for qi, q in enumerate(picked):
        t_states, t_answer = capture_last_token(
            model, processor, device, make_text_prompt(chunk, q["q"]), None
        )
        i_states, i_answer = capture_last_token(
            model, processor, device, make_image_prompt(cols, rows, q["q"]), img
        )
        text_states.append(t_states)
        image_states.append(i_states)
        records.append(
            {
                "question_index": qi,
                "q": q["q"],
                "gold": q["answer_text"],
                "golds": q["golds"],
                "text_answer": t_answer,
                "image_answer": i_answer,
                "text_em": squad.exact_match(t_answer, q["golds"]),
                "image_em": squad.exact_match(i_answer, q["golds"]),
                "agree": squad.f1(t_answer, [i_answer]) >= 0.99,
            }
        )
        print(
            f"{qi + 1}/{len(picked)} text={t_answer!r} image={i_answer!r} gold={q['answer_text']!r}",
            flush=True,
        )

    text_arr = np.stack(text_states, axis=0)  # [Q, L, D]
    image_arr = np.stack(image_states, axis=0)
    n_q, n_layers, _dim = text_arr.shape

    layers: list[dict[str, Any]] = []
    text_sim_by_layer = np.zeros((n_layers, n_q, n_q), dtype=np.float32)
    image_sim_by_layer = np.zeros((n_layers, n_q, n_q), dtype=np.float32)
    cross_sim_by_layer = np.zeros((n_layers, n_q, n_q), dtype=np.float32)
    off_diag = ~np.eye(n_q, dtype=bool)
    for layer in range(n_layers):
        text_l = text_arr[:, layer, :]
        image_l = image_arr[:, layer, :]
        # Carrier-centering removes modality/prompt signature; what remains is
        # per-question content variation within each carrier.
        text_c = text_l - text_l.mean(axis=0, keepdims=True)
        image_c = image_l - image_l.mean(axis=0, keepdims=True)
        cross = cosine_rows(text_c, image_c)
        text_sim = cosine_rows(text_c, text_c)
        image_sim = cosine_rows(image_c, image_c)
        matched = float(np.diag(cross).mean())
        mismatched = float(cross[off_diag].mean())
        rsa = float(np.corrcoef(text_sim[off_diag], image_sim[off_diag])[0, 1])
        layers.append(
            {
                "layer": layer,
                "matched_cosine": matched,
                "mismatched_cosine": mismatched,
                "separation": matched - mismatched,
                "rsa_pearson": rsa,
                "match_rank_accuracy": float(
                    (np.argmax(cross, axis=1) == np.arange(n_q)).mean()
                ),
            }
        )
        text_sim_by_layer[layer] = text_sim
        image_sim_by_layer[layer] = image_sim
        cross_sim_by_layer[layer] = cross

    best_layer = int(np.argmax([l["separation"] for l in layers]))
    summary = {
        "args": vars(args),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        "n_questions": n_q,
        "layers": len(layers),
        "per_layer": layers,
        "best_layer": best_layer,
        "best": layers[best_layer],
        "final": layers[-1],
        "answer_agreement": float(np.mean([r["agree"] for r in records])),
        "text_em": float(np.mean([r["text_em"] for r in records])),
        "image_em": float(np.mean([r["image_em"] for r in records])),
        "records": records,
    }
    np.savez_compressed(
        out_dir / "carrier_convergence.npz",
        text_states=text_arr,
        image_states=image_arr,
        text_sim=text_sim_by_layer,
        image_sim=image_sim_by_layer,
        cross_sim=cross_sim_by_layer,
    )
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(
        json.dumps(
            {k: v for k, v in summary.items() if k not in ("per_layer", "records")},
            indent=1,
        )
    )
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
