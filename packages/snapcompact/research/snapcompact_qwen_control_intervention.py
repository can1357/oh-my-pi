# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers", "qwen-vl-utils"]
# ///
"""Qwen snapcompact controls: alternate prompt plus activation intervention."""

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
from snapcompact_blackbox_occlusion import sample_answer_questions  # noqa: E402
from snapcompact_text_image_compare import (  # noqa: E402
    cosine,
    image_answer_token_indices,
    normalize_heat,
    run_image,
    run_text,
    to_device,
)

PALETTE = {
    "bg": (5, 7, 10),
    "panel": (12, 17, 23),
    "panel2": (8, 12, 17),
    "ink": (241, 239, 224),
    "muted": (143, 154, 160),
    "cyan": (75, 220, 255),
    "orange": (255, 112, 72),
    "green": (148, 255, 117),
    "amber": (255, 196, 68),
    "purple": (188, 112, 255),
    "red": (255, 76, 62),
}


def ui_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def mono_font(size: int) -> ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    stops = [
        (0.00, (4, 7, 20)),
        (0.22, (24, 28, 88)),
        (0.45, (49, 120, 190)),
        (0.65, (54, 226, 195)),
        (0.82, (188, 255, 120)),
        (1.00, (255, 236, 128)),
    ]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            u = (t - a) / (b - a)
            return tuple(round(ca[i] + (cb[i] - ca[i]) * u) for i in range(3))
    return stops[-1][1]


def make_text_prompt(chunk: str, q: dict[str, Any]) -> str:
    return (
        "Below is reference material. Answer the question using only it.\n\n"
        f"<reference>{chunk}</reference>\n\nQuestion: {q['q']}\n"
        "Answer with only the shortest extractive answer."
    )


def make_image_prompt(cols: int, rows: int, q: dict[str, Any]) -> str:
    return (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {q['q']}\nAnswer with only the shortest extractive answer."
    )


def carrier_map(
    model: Any,
    processor: Any,
    img: Image.Image,
    chunk: str,
    q: dict[str, Any],
    cols: int,
    rows: int,
    device: Any,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    text_layers, text_pos, _ = run_text(
        model,
        processor,
        make_text_prompt(chunk, q),
        chunk,
        q["answer_start"],
        q["answer_end"],
        device,
    )
    image_layers, image_positions, image_meta, _ = run_image(
        model, processor, img, make_image_prompt(cols, rows, q), device
    )
    image_count = len(image_positions)
    answer_indices = image_answer_token_indices(
        q["answer_start"],
        q["answer_end"],
        cols,
        8,
        13,
        img.width,
        img.height,
        image_count,
    )
    sims = []
    answer_cos = []
    for text_h, image_h in zip(text_layers, image_layers):
        text_ans = text_h[text_pos["answer_start"] : text_pos["answer_end"]].mean(
            axis=0
        )
        image_tokens = image_h[image_positions]
        image_ans = image_tokens[answer_indices] if answer_indices else image_tokens
        sims.append(
            cosine(
                np.repeat(text_ans[None, :], image_tokens.shape[0], axis=0),
                image_tokens,
            ).astype(np.float32, copy=False)
        )
        answer_cos.append(
            float(cosine(text_ans[None, :], image_ans.mean(axis=0, keepdims=True))[0])
        )
    raw = np.stack(sims, axis=0)
    excess = raw - np.median(raw, axis=1, keepdims=True)
    norm, lo, hi = normalize_heat(excess)
    meta = {
        "image_tokens": image_count,
        "image_grid": round(math.sqrt(image_count)),
        "image_meta": image_meta,
        "answer_indices": answer_indices,
        "answer_cosine": answer_cos,
        "peak_layer": int(np.argmax(answer_cos)),
        "peak_cosine": float(max(answer_cos)),
        "final_cosine": float(answer_cos[-1]),
        "heat_lo": lo,
        "heat_hi": hi,
    }
    return raw, norm, meta


def generate_with_intervention(
    model: Any,
    processor: Any,
    img: Image.Image,
    prompt: str,
    device: Any,
    layer: int,
    answer_indices: list[int],
    mode: str,
    seed: int,
) -> str:
    import torch

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
    image_positions = [
        i
        for i, token_id in enumerate(batch["input_ids"][0].tolist())
        if token_id == image_token_id
    ]
    rng = random.Random(seed)
    random_indices = (
        sorted(
            rng.sample(
                [
                    i
                    for i in range(len(image_positions))
                    if i not in set(answer_indices)
                ],
                len(answer_indices),
            )
        )
        if answer_indices
        else []
    )
    target_indices = (
        answer_indices
        if mode == "answer_mean_patch"
        else random_indices
        if mode == "random_mean_patch"
        else list(range(len(image_positions)))
        if mode == "all_image_zero"
        else []
    )
    target_positions = [image_positions[i] for i in target_indices]
    batch = to_device(batch, device)

    handle = None
    if target_positions:

        def hook(_module: Any, inputs: tuple[Any, ...]) -> tuple[Any, ...]:
            hidden = inputs[0]
            if hidden.ndim == 3 and hidden.shape[1] > max(target_positions):
                patched = hidden.clone()
                if mode == "all_image_zero":
                    patched[:, target_positions, :] = 0
                else:
                    source_positions = [
                        p for p in image_positions if p not in target_positions
                    ]
                    mean_vec = hidden[:, source_positions, :].mean(dim=1, keepdim=True)
                    patched[:, target_positions, :] = mean_vec
                return (patched, *inputs[1:])
            return inputs

        handle = model.model.language_model.layers[layer].register_forward_pre_hook(
            hook
        )
    try:
        with torch.no_grad():
            generated = model.generate(**batch, max_new_tokens=24, do_sample=False)
    finally:
        if handle is not None:
            handle.remove()
    new_tokens = generated[:, batch["input_ids"].shape[1] :]
    return processor.batch_decode(new_tokens, skip_special_tokens=True)[0].strip()


def crop_answer(
    img: Image.Image, q: dict[str, Any], cols: int, adv: int = 8, pitch: int = 13
) -> Image.Image:
    start = q["answer_start"]
    end = q["answer_end"]
    row0 = max(0, start // cols - 5)
    row1 = min(img.height // pitch, end // cols + 6)
    col0 = max(0, start % cols - 42)
    col1 = min(cols, end % cols + 42)
    crop = img.crop((col0 * adv, row0 * pitch, col1 * adv, row1 * pitch)).convert("RGB")
    d = ImageDraw.Draw(crop)
    bx0 = max(0, (start % cols - col0) * adv - adv)
    bx1 = min(crop.width - 1, ((end - 1) % cols - col0 + 2) * adv)
    by0 = max(0, (start // cols - row0) * pitch - 1)
    by1 = min(crop.height - 1, ((end - 1) // cols - row0 + 1) * pitch + 1)
    d.rounded_rectangle(
        (bx0, by0, bx1, by1), radius=3, outline=PALETTE["orange"], width=3
    )
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


def draw_grid(
    draw: ImageDraw.ImageDraw,
    grid_values: np.ndarray,
    answer_indices: list[int],
    box: tuple[int, int, int, int],
    title: str,
    subtitle: str,
    color: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=22, fill=PALETTE["panel2"], outline=(34, 48, 58), width=1
    )
    draw.text((x0 + 20, y0 + 18), title, fill=color, font=ui_font(25, True))
    draw.text((x0 + 20, y0 + 50), subtitle, fill=PALETTE["muted"], font=ui_font(15))
    gx0, gy0, gx1, gy1 = x0 + 30, y0 + 84, x1 - 30, y1 - 28
    rows, cols = grid_values.shape
    cw = (gx1 - gx0) / cols
    ch = (gy1 - gy0) / rows
    for r in range(rows):
        for c in range(cols):
            xa = round(gx0 + c * cw)
            xb = round(gx0 + (c + 1) * cw)
            ya = round(gy0 + r * ch)
            yb = round(gy0 + (r + 1) * ch)
            draw.rectangle((xa, ya, xb, yb), fill=heat_color(float(grid_values[r, c])))
    for idx in answer_indices:
        r, c = divmod(idx, cols)
        xa = round(gx0 + c * cw)
        xb = round(gx0 + (c + 1) * cw)
        ya = round(gy0 + r * ch)
        yb = round(gy0 + (r + 1) * ch)
        draw.rectangle(
            (xa - 2, ya - 2, xb + 2, yb + 2), outline=PALETTE["orange"], width=2
        )


def render_figure(
    out_path: Path,
    img: Image.Image,
    primary: dict[str, Any],
    distractor: dict[str, Any],
    primary_norm: np.ndarray,
    distractor_norm: np.ndarray,
    primary_meta: dict[str, Any],
    distractor_meta: dict[str, Any],
    generations: dict[str, str],
    cols: int,
) -> None:
    w, h = 2200, 1320
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-260, -240, 900, 760), fill=(75, 220, 255, 28))
    gd.ellipse((1240, 120, 2480, 1380), fill=(255, 112, 72, 27))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(86))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (64, 42),
        "QWEN SNAPCOMPACT CONTROL + INTERVENTION",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (64, 84),
        "Ask a different thing; patch the hidden answer",
        fill=PALETTE["ink"],
        font=ui_font(62, True),
    )
    draw.text(
        (66, 166),
        "Same bitmap, two questions. Then patch answer-region image-token activations at the peak layer and watch generation change.",
        fill=PALETTE["muted"],
        font=ui_font(24),
    )

    draw.rounded_rectangle(
        (64, 238, 616, 1234),
        radius=30,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (96, 270), "same image carrier", fill=PALETTE["ink"], font=ui_font(32, True)
    )
    draw.text(
        (96, 312),
        "Qwen2.5-VL-7B, 1568px bitmap",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    for label, q, y, color in [
        ("PRIMARY", primary, 374, PALETTE["orange"]),
        ("DISTRACTOR", distractor, 658, PALETTE["cyan"]),
    ]:
        draw.text((96, y), label, fill=color, font=ui_font(17, True))
        crop = crop_answer(img, q, cols)
        draw.rounded_rectangle(
            (96, y + 34, 584, y + 194),
            radius=14,
            fill=(244, 242, 230),
            outline=color,
            width=3,
        )
        paste_fit(canvas, crop, (112, y + 48, 568, y + 180))
        draw.text((96, y + 216), q["q"][:58], fill=PALETTE["ink"], font=ui_font(18))
        draw.text(
            (96, y + 244),
            f"gold: {q['answer_text']}",
            fill=PALETTE["amber"],
            font=ui_font(22, True),
        )
    draw.text(
        (96, 1012),
        f"primary peak: L{primary_meta['peak_layer']} cosine {primary_meta['peak_cosine']:.3f}",
        fill=PALETTE["orange"],
        font=ui_font(20, True),
    )
    draw.text(
        (96, 1044),
        f"distractor peak: L{distractor_meta['peak_layer']} cosine {distractor_meta['peak_cosine']:.3f}",
        fill=PALETTE["cyan"],
        font=ui_font(20, True),
    )
    draw.text(
        (96, 1102),
        f"image tokens: {primary_meta['image_tokens']} ({primary_meta['image_grid']}×{primary_meta['image_grid']})",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    grid = primary_meta["image_grid"]
    draw_grid(
        draw,
        primary_norm[primary_meta["peak_layer"]].reshape(grid, grid),
        primary_meta["answer_indices"],
        (666, 238, 1386, 706),
        "primary question map",
        f"{primary['answer_text']} @ layer {primary_meta['peak_layer']} — orange box marks true answer",
        PALETTE["orange"],
    )
    draw_grid(
        draw,
        distractor_norm[distractor_meta["peak_layer"]].reshape(grid, grid),
        distractor_meta["answer_indices"],
        (1420, 238, 2140, 706),
        "distractor question map",
        f"{distractor['answer_text']} @ layer {distractor_meta['peak_layer']} — map should move",
        PALETTE["cyan"],
    )

    draw.rounded_rectangle(
        (666, 746, 2140, 1234),
        radius=30,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (704, 780), "activation patch test", fill=PALETTE["ink"], font=ui_font(34, True)
    )
    draw.text(
        (704, 822),
        "Before decoder layer 0, replace selected image-token residuals. Local answer patches test specificity; all-image zero is the sanity check.",
        fill=PALETTE["muted"],
        font=ui_font(20),
    )
    rows = [
        ("normal", generations["normal"], PALETTE["green"]),
        ("patch random region", generations["random_mean_patch"], PALETTE["cyan"]),
        ("patch answer region", generations["answer_mean_patch"], PALETTE["red"]),
        ("zero all image tokens", generations["all_image_zero"], PALETTE["purple"]),
    ]
    y = 878
    for label, text, color in rows:
        draw.rounded_rectangle(
            (704, y, 2078, y + 74),
            radius=18,
            fill=PALETTE["panel2"],
            outline=(34, 48, 58),
            width=1,
        )
        draw.text((730, y + 16), label.upper(), fill=color, font=ui_font(17, True))
        draw.text(
            (1002, y + 15), text[:115], fill=PALETTE["ink"], font=ui_font(23, True)
        )
        y += 86

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="Qwen/Qwen2.5-VL-7B-Instruct")
    ap.add_argument("--font", default="8x13", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--limit-paras", type=int, default=80)
    ap.add_argument("--qpc", type=int, default=24)
    ap.add_argument("--question-index", type=int, default=12)
    ap.add_argument("--distractor-index", type=int, default=3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="qwen-control-intervention")
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
        paras, offsets, 0, len(chunk), args.qpc, args.seed
    )
    if len(questions) < 2:
        raise SystemExit("not enough questions fit in chunk")
    primary = questions[min(args.question_index, len(questions) - 1)]
    distractor = questions[min(args.distractor_index, len(questions) - 1)]
    if distractor is primary:
        distractor = questions[0 if args.question_index != 0 else 1]
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

    primary_raw, primary_norm, primary_meta = carrier_map(
        model, processor, img, chunk, primary, cols, rows, device
    )
    distractor_raw, distractor_norm, distractor_meta = carrier_map(
        model, processor, img, chunk, distractor, cols, rows, device
    )

    peak_layer = primary_meta["peak_layer"]
    prompt = make_image_prompt(cols, rows, primary)
    patch_layer = 0
    generations = {
        "normal": generate_with_intervention(
            model,
            processor,
            img,
            prompt,
            device,
            patch_layer,
            primary_meta["answer_indices"],
            "none",
            args.seed,
        ),
        "random_mean_patch": generate_with_intervention(
            model,
            processor,
            img,
            prompt,
            device,
            patch_layer,
            primary_meta["answer_indices"],
            "random_mean_patch",
            args.seed,
        ),
        "answer_mean_patch": generate_with_intervention(
            model,
            processor,
            img,
            prompt,
            device,
            patch_layer,
            primary_meta["answer_indices"],
            "answer_mean_patch",
            args.seed,
        ),
        "all_image_zero": generate_with_intervention(
            model,
            processor,
            img,
            prompt,
            device,
            patch_layer,
            primary_meta["answer_indices"],
            "all_image_zero",
            args.seed,
        ),
    }

    summary = {
        "args": vars(args),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        "primary": primary,
        "distractor": distractor,
        "primary_meta": primary_meta,
        "distractor_meta": distractor_meta,
        "intervention_layer": patch_layer,
        "generations": generations,
    }
    np.savez_compressed(
        out_dir / "control_intervention.npz",
        primary_raw=primary_raw,
        primary_norm=primary_norm,
        distractor_raw=distractor_raw,
        distractor_norm=distractor_norm,
    )
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    render_figure(
        out_dir / "control-intervention.png",
        img,
        primary,
        distractor,
        primary_norm,
        distractor_norm,
        primary_meta,
        distractor_meta,
        generations,
        cols,
    )
    print(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
