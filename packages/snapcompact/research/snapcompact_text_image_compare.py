# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy", "torch", "transformers", "sentencepiece", "protobuf", "einops", "matplotlib"]
# ///
"""Compare raw-text vs snapcompact-image activations for the same input.

The experiment feeds the same SQuAD chunk/question through a local VLM twice:
1. as ordinary raw text in a <reference> block
2. as a snapcompact bitmap plus the same question

It then compares the text-carrier answer vector against every image-token vector
by decoder layer, producing a blog visual of cross-modal alignment.
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
from snapcompact_blackbox_occlusion import sample_answer_questions  # noqa: E402

DEFAULT_MODEL_DIR = (
    "/home/can/.cache/huggingface/hub/models--PaddlePaddle--PaddleOCR-VL/"
    "snapshots/2b77538ef936207f60c16b45082841068987d08c"
)

PALETTE = {
    "bg": (5, 7, 10),
    "panel": (13, 18, 24),
    "panel2": (9, 13, 18),
    "ink": (241, 239, 224),
    "muted": (143, 154, 160),
    "cyan": (75, 220, 255),
    "orange": (255, 112, 72),
    "green": (148, 255, 117),
    "amber": (255, 196, 68),
    "purple": (180, 96, 255),
    "grid": (38, 49, 58),
}


def ui_font(
    size: int, bold: bool = False
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def mono_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def heat_color(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    stops = [
        (0.00, (4, 7, 20)),
        (0.18, (22, 24, 80)),
        (0.38, (62, 68, 168)),
        (0.58, (38, 183, 208)),
        (0.78, (160, 250, 145)),
        (1.00, (255, 245, 166)),
    ]
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            u = (t - a) / (b - a)
            return tuple(round(ca[i] + (cb[i] - ca[i]) * u) for i in range(3))
    return stops[-1][1]


def cosine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a_norm = np.linalg.norm(a, axis=-1, keepdims=True)
    b_norm = np.linalg.norm(b, axis=-1, keepdims=True)
    return (a * b).sum(axis=-1) / np.maximum((a_norm * b_norm).squeeze(-1), 1e-6)


def normalize_heat(
    arr: np.ndarray, lo: float | None = None, hi: float | None = None
) -> tuple[np.ndarray, float, float]:
    if lo is None:
        lo = float(np.quantile(arr, 0.03))
    if hi is None:
        hi = float(np.quantile(arr, 0.98))
    if hi <= lo:
        hi = lo + 1e-6
    return np.clip((arr - lo) / (hi - lo), 0, 1), lo, hi


def apply_template(processor: Any, content: list[dict[str, Any]]) -> str:
    return processor.apply_chat_template(
        [{"role": "user", "content": content}],
        tokenize=False,
        add_generation_prompt=True,
    )


def text_spans(
    processor: Any, templated: str, chunk: str, answer_start: int, answer_end: int
) -> dict[str, int]:
    tokenizer = processor.tokenizer
    chunk_at = templated.index(chunk)
    prefix = templated[:chunk_at]

    def n_tokens(s: str) -> int:
        return len(tokenizer(s, add_special_tokens=False)["input_ids"])

    ref_start = n_tokens(prefix)
    ref_end = n_tokens(prefix + chunk)
    answer_tok_start = n_tokens(prefix + chunk[:answer_start])
    answer_tok_end = max(answer_tok_start + 1, n_tokens(prefix + chunk[:answer_end]))
    return {
        "ref_start": ref_start,
        "ref_end": ref_end,
        "answer_start": answer_tok_start,
        "answer_end": answer_tok_end,
    }


def to_device(batch: dict[str, Any], device: Any) -> dict[str, Any]:
    return {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}


def run_text(
    model: Any,
    processor: Any,
    text_prompt: str,
    chunk: str,
    answer_start: int,
    answer_end: int,
    device: Any,
) -> tuple[list[np.ndarray], dict[str, int], str]:
    import torch

    templated = apply_template(processor, [{"type": "text", "text": text_prompt}])
    spans = text_spans(processor, templated, chunk, answer_start, answer_end)
    batch = processor(text=templated, return_tensors="pt")
    batch = to_device(batch, device)
    with torch.no_grad():
        out = model(
            **batch, output_hidden_states=True, output_attentions=False, use_cache=False
        )
    layers = [
        h[0].float().detach().cpu().numpy().astype(np.float32, copy=False)
        for h in out.hidden_states
    ]
    return layers, spans, templated


def run_image(
    model: Any, processor: Any, img: Image.Image, img_prompt: str, device: Any
) -> tuple[list[np.ndarray], list[int], dict[str, Any], str]:
    import torch

    templated = apply_template(
        processor,
        [{"type": "image", "image": img}, {"type": "text", "text": img_prompt}],
    )
    batch = processor(images=img, text=templated, return_tensors="pt")
    image_token_id = processor.tokenizer.convert_tokens_to_ids(processor.image_token)
    image_positions = [
        i
        for i, token_id in enumerate(batch["input_ids"][0].tolist())
        if token_id == image_token_id
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
    layers = [
        h[0].float().detach().cpu().numpy().astype(np.float32, copy=False)
        for h in out.hidden_states
    ]
    return layers, image_positions, meta, templated


def image_answer_token_indices(
    answer_start: int,
    answer_end: int,
    text_cols: int,
    adv: int,
    pitch: int,
    image_w: int,
    image_h: int,
    image_token_count: int,
) -> list[int]:
    grid = round(math.sqrt(image_token_count))
    if grid * grid != image_token_count:
        return []
    row0 = max(0, answer_start // text_cols)
    row1 = max(row0, (answer_end - 1) // text_cols)
    col0 = max(0, answer_start % text_cols)
    col1 = max(col0, (answer_end - 1) % text_cols)
    x0 = max(0, col0 * adv - adv)
    x1 = min(image_w, (col1 + 2) * adv)
    y0 = max(0, row0 * pitch - 1)
    y1 = min(image_h, (row1 + 1) * pitch + 1)
    gx0 = max(0, min(grid - 1, int(x0 / image_w * grid)))
    gx1 = max(0, min(grid - 1, int(math.ceil(x1 / image_w * grid))))
    gy0 = max(0, min(grid - 1, int(y0 / image_h * grid)))
    gy1 = max(0, min(grid - 1, int(math.ceil(y1 / image_h * grid))))
    out: list[int] = []
    for gy in range(gy0, gy1 + 1):
        for gx in range(gx0, gx1 + 1):
            out.append(gy * grid + gx)
    return sorted(set(out))


def crop_answer(
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


def draw_wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    width_chars: int,
    line_height: int,
    fill: tuple[int, int, int],
    fnt: ImageFont.ImageFont,
) -> int:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        cand = word if not current else current + " " + word
        if len(cand) <= width_chars:
            current = cand
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    x, y = xy
    for line in lines:
        draw.text((x, y), line, fill=fill, font=fnt)
        y += line_height
    return y


def render_heat_grid(
    draw: ImageDraw.ImageDraw,
    grid: np.ndarray,
    box: tuple[int, int, int, int],
    title: str,
    layer: int,
    answer_indices: list[int],
    color: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(
        box, radius=18, fill=PALETTE["panel2"], outline=(35, 49, 59), width=1
    )
    draw.text((x0 + 18, y0 + 14), title, fill=color, font=ui_font(22, True))
    draw.text(
        (x0 + 18, y0 + 43),
        f"decoder layer {layer}",
        fill=PALETTE["muted"],
        font=ui_font(15),
    )
    gx0, gy0, gx1, gy1 = x0 + 26, y0 + 76, x1 - 26, y1 - 24
    rows, cols = grid.shape
    cw = (gx1 - gx0) / cols
    ch = (gy1 - gy0) / rows
    for r in range(rows):
        for c in range(cols):
            xa = round(gx0 + c * cw)
            xb = round(gx0 + (c + 1) * cw)
            ya = round(gy0 + r * ch)
            yb = round(gy0 + (r + 1) * ch)
            draw.rectangle((xa, ya, xb, yb), fill=heat_color(float(grid[r, c])))
    for idx in answer_indices:
        r, c = divmod(idx, cols)
        xa = round(gx0 + c * cw)
        xb = round(gx0 + (c + 1) * cw)
        ya = round(gy0 + r * ch)
        yb = round(gy0 + (r + 1) * ch)
        draw.rectangle(
            (xa - 2, ya - 2, xb + 2, yb + 2), outline=PALETTE["orange"], width=2
        )


def render_visual(
    out_path: Path,
    summary: dict[str, Any],
    arrays: dict[str, np.ndarray],
    original_img: Image.Image,
    chunk: str,
) -> None:
    w, h = 2100, 1260
    canvas = Image.new("RGB", (w, h), PALETTE["bg"])
    draw = ImageDraw.Draw(canvas)
    for y in range(0, h, 16):
        draw.line((0, y, w, y), fill=(7, 10 + y % 9, 15 + y % 11))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-240, -220, 860, 660), fill=(75, 220, 255, 28))
    gd.ellipse((1160, 80, 2420, 1320), fill=(255, 112, 72, 26))
    canvas = Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(80))
    ).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    q = summary["question"]
    draw.text(
        (62, 42),
        "SNAPCOMPACT CARRIER COMPARISON",
        fill=PALETTE["amber"],
        font=ui_font(24, True),
    )
    draw.text(
        (62, 82),
        "Same input, two internal languages",
        fill=PALETTE["ink"],
        font=ui_font(68, True),
    )
    draw.text(
        (64, 166),
        "Raw text tokens vs bitmap image tokens. Bright fields show where the text-carrier answer vector resonates with the image-carrier hidden state.",
        fill=PALETTE["muted"],
        font=ui_font(25),
    )

    # Carrier cards.
    draw.rounded_rectangle(
        (62, 236, 620, 760),
        radius=28,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (94, 270), "raw text carrier", fill=PALETTE["cyan"], font=ui_font(30, True)
    )
    start = max(0, q["answer_start"] - 230)
    end = min(len(chunk), q["answer_end"] + 230)
    snippet = chunk[start:end].replace("\n", " ")
    rel_a = q["answer_start"] - start
    rel_b = q["answer_end"] - start
    before = snippet[:rel_a]
    answer = snippet[rel_a:rel_b]
    after = snippet[rel_b:]
    tx, ty = 94, 328
    ty = draw_wrapped(
        draw, (tx, ty), before[-260:], 52, 22, PALETTE["ink"], mono_font(15)
    )
    draw.rounded_rectangle(
        (tx, ty + 2, tx + 16 * max(3, len(answer)), ty + 27),
        radius=5,
        fill=(255, 196, 68),
    )
    draw.text((tx + 4, ty + 5), answer, fill=(8, 10, 10), font=mono_font(16))
    ty += 36
    draw_wrapped(draw, (tx, ty), after[:260], 52, 22, PALETTE["ink"], mono_font(15))
    draw.text(
        (94, 694),
        f"answer tokens: {summary['text_answer_tokens']}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    draw.text(
        (94, 724),
        f"reference tokens: {summary['text_reference_tokens']}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    draw.rounded_rectangle(
        (62, 792, 620, 1192),
        radius=28,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (94, 826), "image carrier", fill=PALETTE["orange"], font=ui_font(30, True)
    )
    crop = crop_answer(
        original_img,
        q["answer_start"],
        q["answer_end"],
        summary["geometry"]["cols"],
        8,
        13,
    )
    scale = min(478 / crop.width, 218 / crop.height)
    crop_r = crop.resize(
        (round(crop.width * scale), round(crop.height * scale)),
        Image.Resampling.NEAREST,
    )
    draw.rounded_rectangle(
        (94, 888, 588, 1134),
        radius=16,
        fill=(244, 242, 230),
        outline=PALETTE["orange"],
        width=3,
    )
    canvas.paste(
        crop_r, (94 + (494 - crop_r.width) // 2, 888 + (246 - crop_r.height) // 2)
    )
    draw.text(
        (94, 1150),
        f"image tokens: {summary['image_tokens']} ({summary['image_grid']}×{summary['image_grid']})",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )

    # Layer grids.
    sim = arrays["text_answer_to_image_excess_norm"]
    grid = summary["image_grid"]
    answer_indices = summary["image_answer_token_indices"]
    layers = summary["selected_layers"]
    boxes = [(672, 236, 1088, 626), (1118, 236, 1534, 626), (1564, 236, 1980, 626)]
    names = ["input layer", "middle layer", "peak alignment"]
    colors = [PALETTE["cyan"], PALETTE["purple"], PALETTE["green"]]
    for layer, box, name, color in zip(layers, boxes, names, colors):
        render_heat_grid(
            draw,
            sim[layer].reshape(grid, grid),
            box,
            name,
            layer,
            answer_indices,
            color,
        )

    # Cosine bridge panel.
    draw.rounded_rectangle(
        (672, 672, 1980, 1192),
        radius=28,
        fill=PALETTE["panel"],
        outline=(35, 49, 59),
        width=1,
    )
    draw.text(
        (704, 704),
        "cross-carrier convergence bridge",
        fill=PALETTE["ink"],
        font=ui_font(34, True),
    )
    draw.text(
        (704, 744),
        "Cosine similarity between pooled raw-text answer states and pooled bitmap answer-region states by layer",
        fill=PALETTE["muted"],
        font=ui_font(19),
    )
    x0, y0, x1, y1 = 730, 820, 1908, 1096
    for i in range(5):
        y = y0 + round((y1 - y0) * i / 4)
        draw.line((x0, y, x1, y), fill=PALETTE["grid"], width=1)
    local = arrays["answer_region_cosine"]
    global_mean = arrays["global_mean_cosine"]
    lo = float(min(local.min(), global_mean.min()))
    hi = float(max(local.max(), global_mean.max()))
    if hi <= lo:
        hi = lo + 1e-6

    def pts(vals: np.ndarray) -> list[tuple[int, int]]:
        out = []
        for i, v in enumerate(vals):
            x = x0 + round((x1 - x0) * i / max(1, len(vals) - 1))
            y = y1 - round((y1 - y0) * (float(v) - lo) / (hi - lo))
            out.append((x, y))
        return out

    p_local = pts(local)
    p_global = pts(global_mean)
    draw.line(p_global, fill=PALETTE["muted"], width=4)
    draw.line(p_local, fill=PALETTE["amber"], width=6)
    for x, y in p_local:
        draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=PALETTE["amber"])
    draw.text((x0, y1 + 22), "layer 0", fill=PALETTE["muted"], font=ui_font(16))
    draw.text(
        (x1 - 70, y1 + 22),
        f"layer {len(local) - 1}",
        fill=PALETTE["muted"],
        font=ui_font(16),
    )
    peak_layer = int(np.argmax(local))
    draw.rounded_rectangle(
        (1502, 790, 1938, 900),
        radius=18,
        fill=(9, 13, 18),
        outline=(38, 51, 60),
        width=1,
    )
    draw.text(
        (1526, 812),
        f"answer cosine peaks: {local[peak_layer]:.3f} @L{peak_layer}",
        fill=PALETTE["amber"],
        font=ui_font(21, True),
    )
    draw.text(
        (1526, 842),
        f"final answer cosine: {local[-1]:.3f}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    draw.text(
        (1526, 868),
        f"final global carrier cosine: {global_mean[-1]:.3f}",
        fill=PALETTE["muted"],
        font=ui_font(18),
    )
    draw.rounded_rectangle(
        (704, 1120, 1238, 1168),
        radius=13,
        fill=(9, 13, 18),
        outline=(38, 51, 60),
        width=1,
    )
    draw.rectangle((724, 1138, 768, 1148), fill=PALETTE["amber"])
    draw.text(
        (784, 1129),
        "answer region: text vector ↔ image region",
        fill=PALETTE["muted"],
        font=ui_font(17),
    )
    draw.rectangle((1260, 1138, 1304, 1148), fill=PALETTE["muted"])
    draw.text(
        (1320, 1129), "global carrier means", fill=PALETTE["muted"], font=ui_font(17)
    )

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
    ap.add_argument("--out", default="text-image-compare-paddleocr-q7")
    args = ap.parse_args()

    import torch
    from transformers import AutoConfig, AutoModel, AutoProcessor

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
    img = render(chunk, cfg, CACHE, args.size, args.variant)
    img.save(img_dir / "image-carrier.png")

    print(f"loading {args.model_dir}", flush=True)
    config = AutoConfig.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True
    )
    processor = AutoProcessor.from_pretrained(
        args.model_dir, local_files_only=True, trust_remote_code=True, use_fast=False
    )
    target_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if target_device.type == "cuda" else torch.float32
    if getattr(config, "model_type", "") == "qwen2_5_vl":
        from transformers import Qwen2_5_VLForConditionalGeneration

        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            args.model_dir,
            local_files_only=True,
            trust_remote_code=True,
            dtype=dtype,
            device_map="auto" if target_device.type == "cuda" else None,
        ).eval()
        device = next(model.parameters()).device
    else:
        model = (
            AutoModel.from_pretrained(
                args.model_dir,
                local_files_only=True,
                trust_remote_code=True,
                dtype=dtype,
            )
            .to(target_device)
            .eval()
        )
        device = target_device

    text_prompt = (
        "Below is reference material. Answer the question using only it.\n\n"
        f"<reference>{chunk}</reference>\n\nQuestion: {q['q']}\n"
        "Answer with only the shortest extractive answer."
    )
    img_prompt = (
        load_prompt("qa-image.md").format(cols=cols, rows=rows)
        + f"\n\nQuestion: {q['q']}\nAnswer with only the shortest extractive answer."
    )

    text_layers, text_pos, text_template = run_text(
        model, processor, text_prompt, chunk, q["answer_start"], q["answer_end"], device
    )
    image_layers, image_positions, image_meta, image_template = run_image(
        model, processor, img, img_prompt, device
    )
    image_token_count = len(image_positions)
    image_grid = round(math.sqrt(image_token_count))
    answer_image_indices = image_answer_token_indices(
        q["answer_start"],
        q["answer_end"],
        cols,
        cfg.adv,
        cfg.pitch,
        img.width,
        img.height,
        image_token_count,
    )

    answer_cos = []
    global_cos = []
    text_answer_to_image = []
    for text_h, image_h in zip(text_layers, image_layers):
        text_ref = text_h[text_pos["ref_start"] : text_pos["ref_end"]]
        text_ans = text_h[text_pos["answer_start"] : text_pos["answer_end"]]
        image_tokens = image_h[image_positions]
        image_ans = (
            image_tokens[answer_image_indices] if answer_image_indices else image_tokens
        )
        text_ans_mean = text_ans.mean(axis=0)
        image_ans_mean = image_ans.mean(axis=0)
        text_ref_mean = text_ref.mean(axis=0)
        image_mean = image_tokens.mean(axis=0)
        answer_cos.append(
            float(cosine(text_ans_mean[None, :], image_ans_mean[None, :])[0])
        )
        global_cos.append(float(cosine(text_ref_mean[None, :], image_mean[None, :])[0]))
        sims = cosine(
            np.repeat(text_ans_mean[None, :], image_tokens.shape[0], axis=0),
            image_tokens,
        )
        text_answer_to_image.append(sims.astype(np.float32, copy=False))

    text_answer_to_image_arr = np.stack(text_answer_to_image, axis=0)
    layer_baseline = np.median(text_answer_to_image_arr, axis=1, keepdims=True)
    text_answer_to_image_excess = text_answer_to_image_arr - layer_baseline
    normed, heat_lo, heat_hi = normalize_heat(text_answer_to_image_excess)
    answer_cos_arr = np.array(answer_cos, dtype=np.float32)
    global_cos_arr = np.array(global_cos, dtype=np.float32)
    selected_layers = [0, len(text_layers) // 2, int(answer_cos_arr.argmax())]

    summary = {
        "args": vars(args),
        "device": str(device),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        "question": {
            "q": q["q"],
            "golds": q["golds"],
            "answer_text": q["answer_text"],
            "answer_start": q["answer_start"],
            "answer_end": q["answer_end"],
        },
        "layers": len(text_layers),
        "image_tokens": image_token_count,
        "image_grid": image_grid,
        "image_answer_token_indices": answer_image_indices,
        "image_meta": image_meta,
        "text_positions": text_pos,
        "text_reference_tokens": text_pos["ref_end"] - text_pos["ref_start"],
        "text_answer_tokens": text_pos["answer_end"] - text_pos["answer_start"],
        "selected_layers": selected_layers,
        "answer_region_cosine_final": float(answer_cos_arr[-1]),
        "global_mean_cosine_final": float(global_cos_arr[-1]),
        "answer_region_cosine_max": float(answer_cos_arr.max()),
        "answer_region_cosine_argmax": int(answer_cos_arr.argmax()),
        "heat_normalization": {"lo_p03": heat_lo, "hi_p98": heat_hi},
        "text_template_prefix": text_template[:240],
        "image_template_prefix": image_template[:240],
    }
    arrays = {
        "text_answer_to_image_cosine": text_answer_to_image_arr,
        "text_answer_to_image_excess": text_answer_to_image_excess,
        "text_answer_to_image_excess_norm": normed,
        "answer_region_cosine": answer_cos_arr,
        "global_mean_cosine": global_cos_arr,
    }
    np.savez_compressed(out_dir / "text_image_compare.npz", **arrays)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    render_visual(out_dir / "text-vs-image.png", summary, arrays, img, chunk)
    print(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
