# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp22: 6pt antialiased vector type vs 1-bit bitmap fonts.

Every prior condition used hand-hinted 1-bit bitmap fonts. Here the corpus is
rasterized with a real monospace TTF (Monaco, fallback DejaVu Sans Mono) at
tiny em sizes WITH greyscale antialiasing — the hypothesis being that AA
preserves sub-pixel shape information a VLM can exploit below the bitmap-font
legibility floor.

Conditions (bw, grid layout, 1568px):
  img-ttf6-bw   em 6px (6pt @ 72dpi)
  img-ttf8-bw   em 8px (6pt @ 96dpi)
Cell metrics are measured from the font (advance x line height).

Usage:
  uv run exp22_ttf6pt.py --render-only
  uv run exp22_ttf6pt.py --model gpt-5.5
  uv run exp22_ttf6pt.py --model google/gemini-3.5-flash
"""

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp22"
OUT_DIR = RESULTS / f"{EXP}-ttf6pt"
MODELS = {  # model -> (price_in, price_out, key_name, key_env)
    "google/gemini-3.5-flash": (0.6, 4.0, "openrouter", "OPENROUTER_API_KEY"),
    "gpt-5.5": (2.0, 16.0, "openai", "OPENAI_API_KEY"),
}
MODEL = "google/gemini-3.5-flash"
PRICE_IN, PRICE_OUT = 0.6, 4.0
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
TTF_CANDIDATES = [
    "/System/Library/Fonts/Monaco.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]
EM_SIZES = (6, 8)


def mono_font(em: int) -> ImageFont.FreeTypeFont:
    for path in TTF_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, em)
    raise FileNotFoundError("no monospace TTF found")


def metrics(em: int) -> tuple[float, int, int, int]:
    """(advance, pitch, cols, rows) at 1568px for the em size."""
    f = mono_font(em)
    adv = f.getlength("0")
    ascent, descent = f.getmetrics()
    pitch = ascent + descent  # tight leading; AA keeps rows separable
    cols = int(1568 // adv)
    rows = 1568 // pitch
    return adv, pitch, cols, rows


def render_ttf(text: str, em: int, size: int) -> Image.Image:
    f = mono_font(em)
    adv, pitch, cols, rows = metrics(em)
    img = Image.new("RGB", (size, size), _WHITE)
    draw = ImageDraw.Draw(img)
    for r in range(rows):
        line = text[r * cols : (r + 1) * cols]
        if not line:
            break
        draw.text((0, r * pitch), line, font=f, fill=_BLACK)
    return img


def atomic_save(img: Image.Image, png: Path) -> None:
    tmp = png.with_suffix(f".{os.getpid()}.tmp.png")
    img.save(tmp)
    tmp.replace(png)


def cached(payload: object, fn, fresh: bool) -> dict:
    key = sha8(MODEL, f"{EXP}-qa", json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if not fresh and path.exists():
        return json.loads(path.read_text())
    out = fn()
    if out.get("stop") != "max_tokens":
        tmp = path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(out))
        tmp.replace(path)
    else:
        print("WARN truncated response, not cached", flush=True)
    return out


def qa_unit(
    cond: str,
    prompt: str,
    png: Path,
    questions: list[dict],
    length: int,
    start: int,
    ctx: dict,
) -> list[dict]:
    args, keys = ctx["args"], ctx["keys"]
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [{"text": prompt}, {"image_path": png}, {"text": q_block}],
        }
    ]
    payload = {"messages": messages}
    if args.effort:
        payload["effort"] = args.effort
    qa = cached(
        payload,
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    MODEL,
                    messages,
                    max_tokens=args.max_tokens,
                    effort=args.effort,
                ),
            )
        ),
        args.fresh,
    )
    answers = squad.parse_numbered(qa["text"], len(questions))
    records = []
    for q, a in zip(questions, answers):
        records.append(
            {
                "model": MODEL,
                "length": length,
                "cond": cond,
                "chunk": start,
                "pos_rel": q["pos_rel"],
                "q": q["q"],
                "answer": a,
                "golds": q["golds"],
                "em": squad.exact_match(a, q["golds"]),
                "f1": squad.f1(a, q["golds"]),
                "abstained": "unreadable" in a.lower(),
            }
        )
    records[0]["usage"] = [{"phase": "qa", **qa["usage"]}]
    return records


def aggregate(records: list[dict]) -> list[dict]:
    cells = {}
    for r in records:
        cells.setdefault((r["length"], r["cond"]), []).append(r)
    out = []
    for (length, cond), recs in sorted(cells.items()):
        n = len(recs)
        f1s = [r["f1"] for r in recs]
        mean = sum(f1s) / n
        var = sum((x - mean) ** 2 for x in f1s) / (n - 1) if n > 1 else 0.0
        usage = [u for r in recs for u in r.get("usage", [])]
        tin = sum(u["in"] for u in usage)
        tout = sum(u["out"] for u in usage)
        creads = sum(u.get("cache_r", 0) for u in usage)
        rsn = sum(u.get("reasoning", 0) for u in usage)
        cost = (tin + 0.1 * creads) * PRICE_IN / 1e6 + tout * PRICE_OUT / 1e6
        out.append(
            {
                "model": MODEL,
                "length": length,
                "condition": cond,
                "n": n,
                "em": round(sum(r["em"] for r in recs) / n, 4),
                "f1": round(mean, 4),
                "f1_se": round((var / n) ** 0.5, 4),
                "abstained": sum(r["abstained"] for r in recs),
                "tok_in": tin,
                "tok_out": tout,
                "tok_cache_r": creads,
                "tok_reasoning": rsn,
                "cost_usd": round(cost, 4),
            }
        )
    return out


def main() -> None:
    global MODEL, PRICE_IN, PRICE_OUT
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--model", default="google/gemini-3.5-flash", choices=sorted(MODELS)
    )
    ap.add_argument("--ems", default="6,8")
    ap.add_argument("--lengths", default="50,150")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    MODEL = args.model
    PRICE_IN, PRICE_OUT, key_name, key_env = MODELS[MODEL]
    keys = {} if args.render_only else {key_name: load_env_key(key_env, args.env)}
    all_paras = squad.load_paragraphs(CACHE)
    prompt_tpl = load_prompt("qa-image.md")

    tasks = []
    for em in (int(x) for x in args.ems.split(",")):
        adv, pitch, cols, rows = metrics(em)
        cap = cols * rows
        cond = f"img-ttf{em}-bw" + (f"+eff-{args.effort}" if args.effort else "")
        print(
            f"{cond}: adv {adv:.2f}px pitch {pitch}px -> {cols}x{rows} = {cap} chars/page",
            flush=True,
        )
        for length in (int(x) for x in args.lengths.split(",")):
            paras = all_paras[:length]
            flow, offsets = squad.build_flow(paras)
            n_pages = math.ceil(len(flow) / cap)
            print(f"  len {length}: {n_pages} pages, corpus {len(flow)}", flush=True)
            ctx = {"args": args, "keys": keys}
            for start in range(0, len(flow), cap):
                end = min(start + cap, len(flow))
                questions = squad.sample_chunk_questions(
                    paras, offsets, start, end, args.qpc, args.seed
                )
                if not questions:
                    continue
                png = (
                    CACHE
                    / f"{EXP}-ttf{em}-{sha8(flow[start:end], str(em), str(args.size))}.png"
                )
                if not png.exists() or png.stat().st_size == 0:
                    atomic_save(render_ttf(flow[start:end], em, args.size), png)
                prompt = prompt_tpl.format(cols=cols, rows=rows)
                tasks.append((cond, prompt, png, questions, length, start, ctx))

    if args.render_only:
        for t in tasks[:2]:
            print(f"sample: {t[2]}")
        return

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(qa_unit, *t) for t in tasks]
        for done, fut in enumerate(futures, 1):
            records.extend(fut.result())
            print(f"  {done}/{len(futures)}", flush=True)

    slug = MODEL.split("/")[-1] + (f"-eff{args.effort}" if args.effort else "")
    with (OUT_DIR / f"records-{slug}.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    cells_out = aggregate(records)
    hdr = "model,length,condition,n,em,f1,f1_se,abstained,tok_in,tok_out,tok_cache_r,tok_reasoning,cost_usd"
    with (OUT_DIR / f"matrix-{slug}.csv").open("w") as fh:
        fh.write(hdr + "\n")
        for c in cells_out:
            fh.write(",".join(str(c[k]) for k in hdr.split(",")) + "\n")
    (OUT_DIR / f"summary-{slug}.json").write_text(
        json.dumps({"args": vars(args), "cells": cells_out}, indent=1)
    )
    for c in cells_out:
        print(
            f"len {c['length']:<4} {c['condition']:<20} n={c['n']:<4} EM {c['em']:.3f}  "
            f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}  "
            f"out={c['tok_out']} rsn={c['tok_reasoning']}",
            flush=True,
        )
    print(f"-> {OUT_DIR}/matrix-{slug}.csv", flush=True)


if __name__ == "__main__":
    main()
