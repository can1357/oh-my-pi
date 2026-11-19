# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers", "sentencepiece", "protobuf", "einops"]
# ///
"""Capture and render token/layer hidden-state heatmaps for snapcompact masks.

This is the blog-visual version of the white-box probe: it compares the same
prompt with the original bitmap, a gold-answer-region mask, and an equal random
mask. For every decoder layer and every image placeholder token, it plots
||hidden(original) - hidden(masked)||.
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
from PIL import Image, ImageDraw, ImageFilter, ImageFont

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

PALETTE = {
    "bg": (5, 7, 10),
    "panel": (13, 18, 23),
    "ink": (239, 239, 224),
    "muted": (132, 147, 154),
    "cyan": (77, 218, 255),
    "red": (255, 83, 62),
    "green": (145, 255, 112),
    "amber": (255, 194, 65),
    "grid": (34, 45, 53),
}


def ui_font(
    size: int, bold: bool = False
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    stops = [
        (0.00, (6, 8, 18)),
        (0.20, (28, 20, 70)),
        (0.43, (118, 29, 97)),
        (0.67, (222, 72, 69)),
        (0.85, (255, 164, 75)),
        (1.00, (255, 243, 164)),
    ]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            u = (t - a) / (b - a)
            return tuple(round(ca[i] + (cb[i] - ca[i]) * u) for i in range(3))
    return stops[-1][1]


def downsample_cols(arr: np.ndarray, bins: int) -> np.ndarray:
    if arr.shape[1] <= bins:
        return arr
    edges = np.linspace(0, arr.shape[1], bins + 1).round().astype(int)
    out = np.zeros((arr.shape[0], bins), dtype=np.float32)
    for i in range(bins):
        lo, hi = edges[i], max(edges[i] + 1, edges[i + 1])
        out[:, i] = arr[:, lo:hi].mean(axis=1)
    return out


def normalize(arr: np.ndarray, scale: float | None = None) -> tuple[np.ndarray, float]:
    if scale is None:
        scale = float(np.quantile(arr, 0.98)) if arr.size else 1.0
    if scale <= 0:
        scale = 1.0
    return np.clip(arr / scale, 0, 1), scale


def draw_heatmap(
    draw: ImageDraw.ImageDraw,
    arr: np.ndarray,
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str,
    color: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=22, fill=PALETTE["panel"], outline=(31, 42, 50), width=1
    )
    draw.text((x0 + 24, y0 + 18), title, fill=color, font=ui_font(26, True))
    draw.text((x0 + 24, y0 + 50), subtitle, fill=PALETTE["muted"], font=ui_font(15))
    hx0, hy0, hx1, hy1 = x0 + 58, y0 + 84, x1 - 28, y1 - 44
    rows, cols = arr.shape
    cw = (hx1 - hx0) / cols
    ch = (hy1 - hy0) / rows
    for r in range(rows):
        y_a = round(hy0 + r * ch)
        y_b = round(hy0 + (r + 1) * ch)
        for c in range(cols):
            x_a = round(hx0 + c * cw)
            x_b = round(hx0 + (c + 1) * cw)
            draw.rectangle((x_a, y_a, x_b, y_b), fill=heat_color(float(arr[r, c])))
    for r in range(0, rows, 4):
        y = round(hy0 + (r + 0.5) * ch)
        draw.text((x0 + 18, y - 8), str(r), fill=PALETTE["muted"], font=ui_font(12))
    draw.text((x0 + 16, hy0 - 4), "layer", fill=PALETTE["muted"], font=ui_font(12))
    draw.text(
        (hx0, y1 - 31),
        "image token sequence →",
        fill=PALETTE["muted"],
        font=ui_font(13),
    )


def crop_with_box(
    img: Image.Image,
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    pad_cells: int = 34,
) -> Image.Image:
    row0 = max(0, start // cols - 5)
    row1 = min(img.height // pitch, end // cols + 6)
    col0 = max(0, start % cols - pad_cells)
    col1 = min(cols, end % cols + pad_cells)
    if col1 <= col0:
        col1 = min(cols, col0 + 72)
    x0, y0, x1, y1 = col0 * adv, row0 * pitch, col1 * adv, row1 * pitch
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=3, outline=PALETTE["red"], width=3)
    return crop


def paste_fit(
    canvas: Image.Image, img: Image.Image, box: tuple[int, int, int, int]
) -> None:
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.Resampling.NEAREST,
    )
    canvas.paste(
        resized,
        (x0 + (x1 - x0 - resized.width) // 2, y0 + (y1 - y0 - resized.height) // 2),
    )


def make_prompt(q: str, cols: int, rows: int) -> str:
    return (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {q}\nAnswer with only the shortest extractive answer."
    )


def to_device(batch: dict[str, Any], device: Any) -> dict[str, Any]:
    return {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}


def hidden_token_matrix(
    model: Any, processor: Any, image: Image.Image, prompt_text: str, device: Any
) -> tuple[list[np.ndarray], list[int], dict[str, Any]]:
    import torch

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt_text},
            ],
        }
    ]
    templated = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    batch = processor(images=image, text=templated, return_tensors="pt")
    image_token_id = processor.tokenizer.convert_tokens_to_ids(processor.image_token)
    ids = batch["input_ids"][0].tolist()
    image_positions = [
        i for i, token_id in enumerate(ids) if token_id == image_token_id
    ]
    meta = {
        k: (v.tolist() if hasattr(v, "tolist") else v)
        for k, v in batch.items()
        if k in ("image_grid_thw",)
    }
    batch = to_device(batch, device)
    with torch.no_grad():
        out = model(
            **batch, output_hidden_states=True, output_attentions=False, use_cache=False
        )
    matrices: list[np.ndarray] = []
    for hidden in out.hidden_states:
        token_hidden = hidden[0, image_positions, :].float().detach().cpu().numpy()
        matrices.append(token_hidden.astype(np.float32, copy=False))
    return matrices, image_positions, meta


def render_tensor_card(
    out_path: Path,
    answer_heat: np.ndarray,
    random_heat: np.ndarray,
    ratio_heat: np.ndarray,
    base_img: Image.Image,
    answer_img: Image.Image,
    record: dict[str, Any],
    cols: int,
    adv: int,
    pitch: int,
    summary: dict[str, Any],
) -> None:
    w, h = 1900, 1180
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 14):
        draw.line((0, y, w, y), fill=(8, 11 + (y % 9), 15 + (y % 13)))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -180, 850, 640), fill=(255, 83, 62, 30))
    gd.ellipse((1080, 110, 2240, 1320), fill=(77, 218, 255, 30))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(80))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (58, 38), "SNAPCOMPACT WHITEBOX", fill=PALETTE["amber"], font=ui_font(22, True)
    )
    draw.text(
        (58, 76),
        "The hidden-state scar of a missing answer",
        fill=PALETTE["ink"],
        font=ui_font(58, True),
    )
    draw.text(
        (60, 148),
        "Each pixel below is a decoder layer × image-token bin. Bright = larger ||hidden(original) − hidden(masked)||.",
        fill=PALETTE["muted"],
        font=ui_font(24),
    )

    # Left evidence panel.
    draw.rounded_rectangle(
        (58, 205, 700, 1098),
        radius=28,
        fill=PALETTE["panel"],
        outline=(31, 42, 50),
        width=1,
    )
    draw.text(
        (90, 236),
        "the visual intervention",
        fill=PALETTE["ink"],
        font=ui_font(30, True),
    )
    draw.text(
        (90, 274),
        "same prompt, same bitmap; only answer cells blanked",
        fill=PALETTE["muted"],
        font=ui_font(17),
    )
    crop = crop_with_box(
        base_img, record["answer_start"], record["answer_end"], cols, adv, pitch
    )
    masked_crop = crop_with_box(
        answer_img, record["answer_start"], record["answer_end"], cols, adv, pitch
    )
    draw.text((90, 326), "ORIGINAL", fill=PALETTE["cyan"], font=ui_font(16, True))
    draw.rounded_rectangle(
        (90, 352, 668, 528),
        radius=14,
        fill=(244, 242, 230),
        outline=PALETTE["cyan"],
        width=3,
    )
    paste_fit(canvas, crop, (108, 368, 650, 512))
    draw.text((90, 568), "ANSWER ERASED", fill=PALETTE["red"], font=ui_font(16, True))
    draw.rounded_rectangle(
        (90, 594, 668, 770),
        radius=14,
        fill=(244, 242, 230),
        outline=PALETTE["red"],
        width=3,
    )
    paste_fit(canvas, masked_crop, (108, 610, 650, 754))
    question = record["q"]
    if len(question) > 72:
        question = question[:69] + "…"
    draw.text((90, 828), "question", fill=PALETTE["muted"], font=ui_font(16, True))
    draw.text((90, 856), question, fill=PALETTE["ink"], font=ui_font(21))
    draw.text((90, 914), "gold answer", fill=PALETTE["muted"], font=ui_font(16, True))
    draw.text(
        (90, 942),
        str(record["answer_text"]),
        fill=PALETTE["amber"],
        font=ui_font(32, True),
    )
    draw.text(
        (90, 1014),
        f"{summary['layers']} hidden layers × {summary['image_tokens']} image tokens",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    draw_heatmap(
        draw,
        answer_heat,
        (742, 205, 1818, 488),
        "gold answer mask",
        "activation delta when the true answer is blanked",
        PALETTE["red"],
    )
    draw_heatmap(
        draw,
        random_heat,
        (742, 520, 1818, 803),
        "random equal-size mask",
        "control: blank the same number of glyph cells elsewhere",
        PALETTE["green"],
    )
    draw_heatmap(
        draw,
        ratio_heat,
        (742, 835, 1818, 1098),
        "answer / random ratio",
        "bright bands mark layers/tokens more sensitive to the answer region",
        PALETTE["amber"],
    )

    # Color scale.
    for i in range(220):
        draw.rectangle((1588 + i, 158, 1589 + i, 174), fill=heat_color(i / 219))
    draw.text((1588, 133), "low", fill=PALETTE["muted"], font=ui_font(13))
    draw.text((1758, 133), "high", fill=PALETTE["muted"], font=ui_font(13))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--font", default="8x13", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=768)
    ap.add_argument("--limit-paras", type=int, default=40)
    ap.add_argument("--qpc", type=int, default=16)
    ap.add_argument("--question-index", type=int, default=7)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--bins", type=int, default=180)
    ap.add_argument("--out", default="tensor-heatmap-paddleocr")
    args = ap.parse_args()

    import torch
    from transformers import AutoModel, AutoProcessor

    out_dir = HERE / "results" / args.out
    img_dir = out_dir / "images"
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
        raise SystemExit("no sampled questions fit in chunk")
    q = questions[min(args.question_index, len(questions) - 1)]

    base_img = render(chunk, cfg, CACHE, args.size, args.variant)
    fill = (255, 255, 255) if args.variant not in ("dark", "dark-sent") else (0, 0, 0)
    span_len = max(1, q["answer_end"] - q["answer_start"])
    rng = random.Random(args.seed * 101 + args.question_index)
    rand_start, rand_end = random_span(
        rng, len(chunk), span_len, q["answer_start"], q["answer_end"]
    )
    answer_img = mask_cells(
        base_img, q["answer_start"], q["answer_end"], cols, cfg.adv, cfg.pitch, fill
    )
    random_img = mask_cells(
        base_img, rand_start, rand_end, cols, cfg.adv, cfg.pitch, fill
    )
    base_img.save(img_dir / "original.png")
    answer_img.save(img_dir / "answer-mask.png")
    random_img.save(img_dir / "random-mask.png")

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

    prompt = make_prompt(q["q"], cols, rows)
    original, positions, meta = hidden_token_matrix(
        model, processor, base_img, prompt, device
    )
    answer, answer_positions, _ = hidden_token_matrix(
        model, processor, answer_img, prompt, device
    )
    random_mask, random_positions, _ = hidden_token_matrix(
        model, processor, random_img, prompt, device
    )
    if positions != answer_positions or positions != random_positions:
        raise SystemExit("image token positions changed across variants")

    answer_delta = np.stack(
        [np.linalg.norm(a - b, axis=1) for a, b in zip(original, answer)], axis=0
    )
    random_delta = np.stack(
        [np.linalg.norm(a - b, axis=1) for a, b in zip(original, random_mask)], axis=0
    )
    ratio = answer_delta / np.maximum(random_delta, 1e-6)

    answer_binned = downsample_cols(answer_delta, args.bins)
    random_binned = downsample_cols(random_delta, args.bins)
    ratio_binned = downsample_cols(ratio, args.bins)
    common_scale = float(
        np.quantile(
            np.concatenate([answer_binned.ravel(), random_binned.ravel()]), 0.98
        )
    )
    answer_norm, _ = normalize(answer_binned, common_scale)
    random_norm, _ = normalize(random_binned, common_scale)
    ratio_norm, ratio_scale = normalize(
        ratio_binned, float(np.quantile(ratio_binned, 0.98))
    )

    record = {
        "q": q["q"],
        "golds": q["golds"],
        "answer_text": q["answer_text"],
        "answer_start": q["answer_start"],
        "answer_end": q["answer_end"],
        "random_start": rand_start,
        "random_end": rand_end,
    }
    summary = {
        "args": vars(args),
        "device": str(device),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        "question": record,
        "image_tokens": len(positions),
        "layers": len(original),
        "image_token_positions": {"first": positions[0], "last": positions[-1]},
        "processor_meta": meta,
        "answer_delta_mean": float(answer_delta.mean()),
        "random_delta_mean": float(random_delta.mean()),
        "answer_over_random_delta": float(
            answer_delta.mean() / max(random_delta.mean(), 1e-6)
        ),
        "common_delta_scale_p98": common_scale,
        "ratio_scale_p98": ratio_scale,
        "max_ratio_layer": int(np.argmax(ratio.mean(axis=1))),
        "mean_ratio_by_layer": [float(x) for x in ratio.mean(axis=1)],
    }

    np.savez_compressed(
        out_dir / "heatmaps.npz",
        answer_delta=answer_delta,
        random_delta=random_delta,
        ratio=ratio,
        answer_binned=answer_binned,
        random_binned=random_binned,
        ratio_binned=ratio_binned,
        answer_norm=answer_norm,
        random_norm=random_norm,
        ratio_norm=ratio_norm,
    )
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    render_tensor_card(
        out_dir / "tensor-heatmap.png",
        answer_norm,
        random_norm,
        ratio_norm,
        base_img,
        answer_img,
        record,
        cols,
        cfg.adv,
        cfg.pitch,
        summary,
    )
    print(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
