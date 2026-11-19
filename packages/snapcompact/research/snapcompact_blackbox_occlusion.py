# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Black-box snapcompact occlusion probe against an OpenAI-compatible VLM endpoint.

For sampled SQuAD questions, render the carrier as a dense bitmap, then compare
QA on the original image, an image with the gold answer cells masked, and an
image with an equal-sized random mask. A real visual-retrieval mechanism should
show a larger F1 drop for answer masks than random masks.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from run import CACHE, FONTS, load_prompt, sha8  # noqa: E402


def sample_answer_questions(
    paras: list[dict], offsets: list[int], start: int, end: int, n: int, seed: int
) -> list[dict]:
    """Sample questions like squad.sample_chunk_questions, preserving answer offsets."""
    rng = random.Random(seed * 1_000_003 + start)
    eligible = [
        i
        for i in range(len(offsets))
        if offsets[i] >= start
        and offsets[i] + len(paras[i]["ctx"]) <= end
        and paras[i].get("qas")
    ]
    if not eligible:
        return []
    n = min(n, len(eligible))
    step = len(eligible) / n
    picked: list[dict] = []
    for k in range(n):
        pi = eligible[int(k * step)]
        qa = rng.choice(paras[pi]["qas"])
        answers = qa.get("answers") or []
        if not answers:
            continue
        answer = answers[0]
        picked.append(
            {
                "q": " ".join(qa["question"].split()),
                "golds": sorted({a["text"] for a in answers}),
                "answer_text": answer["text"],
                "answer_start": offsets[pi] - start + int(answer["answer_start"]),
                "answer_end": offsets[pi]
                - start
                + int(answer["answer_start"])
                + len(answer["text"]),
                "pos_rel": (offsets[pi] - start) / (end - start),
            }
        )
    return picked


def mask_cells(
    img: Image.Image,
    start: int,
    end: int,
    cols: int,
    adv: int,
    pitch: int,
    fill: tuple[int, int, int],
) -> Image.Image:
    out = img.copy()
    draw = ImageDraw.Draw(out)
    start = max(0, start)
    end = max(start + 1, end)
    first_row = start // cols
    last_row = (end - 1) // cols
    for row in range(first_row, last_row + 1):
        c0 = start % cols if row == first_row else 0
        c1 = (end - 1) % cols if row == last_row else cols - 1
        x0 = max(0, c0 * adv - adv)
        y0 = max(0, row * pitch - 1)
        x1 = min(out.width, (c1 + 2) * adv)
        y1 = min(out.height, (row + 1) * pitch + 1)
        draw.rectangle((x0, y0, x1, y1), fill=fill)
    return out


def random_span(
    rng: random.Random, text_len: int, span_len: int, avoid_start: int, avoid_end: int
) -> tuple[int, int]:
    if text_len <= span_len:
        return 0, text_len
    for _ in range(100):
        start = rng.randrange(0, text_len - span_len)
        end = start + span_len
        if end < avoid_start - span_len or start > avoid_end + span_len:
            return start, end
    start = 0 if avoid_start > text_len // 2 else max(0, text_len - span_len)
    return start, min(text_len, start + span_len)


def post_chat(
    endpoint: str,
    model: str,
    image_path: Path,
    prompt: str,
    max_tokens: int,
    cache_dir: Path,
    fresh: bool,
) -> tuple[str, dict]:
    payload_key = sha8(model, prompt, hashlib.sha1(image_path.read_bytes()).hexdigest())
    cache_path = cache_dir / f"{payload_key}.json"
    if cache_path.exists() and not fresh:
        cached = json.loads(cache_path.read_text())
        return cached["text"], cached.get("usage", {})

    image_b64 = base64.b64encode(image_path.read_bytes()).decode()
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        raise RuntimeError(err.read().decode()) from err
    choice = (out.get("choices") or [{}])[0]
    text = ((choice.get("message") or {}).get("content") or "").strip()
    usage = out.get("usage") or {}
    cache_path.write_text(json.dumps({"text": text, "usage": usage}, indent=1))
    return text, usage


def aggregate(records: list[dict]) -> dict:
    by_variant: dict[str, list[dict]] = {}
    for record in records:
        by_variant.setdefault(record["variant"], []).append(record)
    out: dict[str, Any] = {"n": len(records) // 3, "variants": {}}
    for name, rows in sorted(by_variant.items()):
        out["variants"][name] = {
            "n": len(rows),
            "em": sum(r["em"] for r in rows) / max(1, len(rows)),
            "f1": sum(r["f1"] for r in rows) / max(1, len(rows)),
            "abstained": sum(1 for r in rows if "unreadable" in r["answer"].lower()),
            "prompt_tokens": sum(
                (r.get("usage") or {}).get("prompt_tokens", 0) for r in rows
            ),
            "completion_tokens": sum(
                (r.get("usage") or {}).get("completion_tokens", 0) for r in rows
            ),
        }
    base = out["variants"].get("original", {}).get("f1", 0.0)
    out["drops"] = {
        name: base - row["f1"]
        for name, row in out["variants"].items()
        if name != "original"
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--endpoint", default="http://spark.internal:8000/v1/chat/completions"
    )
    ap.add_argument("--model", default="Qwen2.5-VL-7B-Instruct-NVFP4")
    ap.add_argument("--font", default="5x8", choices=sorted(FONTS))
    ap.add_argument("--variant", default="bw")
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--limit-paras", type=int, default=50)
    ap.add_argument("--qpc", type=int, default=12)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-tokens", type=int, default=48)
    ap.add_argument("--out", default="snapcompact-occlusion")
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()

    out_dir = HERE / "results" / args.out
    img_dir = out_dir / "images"
    cache_dir = out_dir / "api-cache"
    img_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)

    cfg = FONTS[args.font]
    cols, rows, budget = capacity(cfg, args.size)
    paras = squad.load_paragraphs(CACHE)[: args.limit_paras]
    flow, offsets = squad.build_flow(paras)
    prompt_base = load_prompt("qa-image.md").format(cols=cols, rows=rows)
    mask_fill = (
        (255, 255, 255) if args.variant not in ("dark", "dark-sent") else (0, 0, 0)
    )

    tasks = []
    for start in range(0, len(flow), budget):
        end = min(start + budget, len(flow))
        chunk = flow[start:end]
        questions = sample_answer_questions(
            paras, offsets, start, end, args.qpc, args.seed
        )
        if questions:
            tasks.append((start, end, chunk, questions))

    records: list[dict] = []
    for chunk_index, (start, end, chunk, questions) in enumerate(tasks):
        base_img = render(chunk, cfg, CACHE, args.size, args.variant)
        base_path = img_dir / f"chunk-{start}-{args.font}-{args.variant}.png"
        if not base_path.exists():
            base_img.save(base_path)
        for qi, q in enumerate(questions):
            span_len = max(1, q["answer_end"] - q["answer_start"])
            rng = random.Random(args.seed * 17 + start + qi)
            rand_start, rand_end = random_span(
                rng, len(chunk), span_len, q["answer_start"], q["answer_end"]
            )
            answer_path = img_dir / f"chunk-{start}-q{qi}-answer-mask.png"
            random_path = img_dir / f"chunk-{start}-q{qi}-random-mask.png"
            if not answer_path.exists():
                mask_cells(
                    base_img,
                    q["answer_start"],
                    q["answer_end"],
                    cols,
                    cfg.adv,
                    cfg.pitch,
                    mask_fill,
                ).save(answer_path)
            if not random_path.exists():
                mask_cells(
                    base_img, rand_start, rand_end, cols, cfg.adv, cfg.pitch, mask_fill
                ).save(random_path)

            prompt = (
                f"{prompt_base}\n\nQuestion: {q['q']}\n"
                "Answer with only the shortest extractive answer copied from the image. "
                "If the answer is unreadable, reply exactly UNREADABLE."
            )
            for variant_name, path in (
                ("original", base_path),
                ("answer_mask", answer_path),
                ("random_mask", random_path),
            ):
                answer, usage = post_chat(
                    args.endpoint,
                    args.model,
                    path,
                    prompt,
                    args.max_tokens,
                    cache_dir,
                    args.fresh,
                )
                records.append(
                    {
                        "chunk": start,
                        "chunk_index": chunk_index,
                        "question_index": qi,
                        "variant": variant_name,
                        "q": q["q"],
                        "answer": answer,
                        "golds": q["golds"],
                        "answer_text": q["answer_text"],
                        "answer_start": q["answer_start"],
                        "answer_end": q["answer_end"],
                        "random_start": rand_start,
                        "random_end": rand_end,
                        "pos_rel": q["pos_rel"],
                        "em": squad.exact_match(answer, q["golds"]),
                        "f1": squad.f1(answer, q["golds"]),
                        "usage": usage,
                    }
                )
                print(
                    f"{len(records):04d} {variant_name:<11} f1={records[-1]['f1']:.3f} answer={answer[:80]!r}",
                    flush=True,
                )

    summary = {
        "args": vars(args),
        "geometry": {"cols": cols, "rows": rows, "capacity": budget},
        **aggregate(records),
    }
    with (out_dir / "records.jsonl").open("w") as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    print(f"results -> {out_dir}")


if __name__ == "__main__":
    main()
