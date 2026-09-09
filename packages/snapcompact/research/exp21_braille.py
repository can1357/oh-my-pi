# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp21: render text as Grade-1 (uncontracted) 6-dot braille -> gemini-3.5-flash.

Each character becomes a 2x3 dot matrix drawn directly (no font file):
lowercase letters, digits as number-sign + a-j (one sign per digit run),
a punctuation subset; everything else -> blank cell. Text is lowercased
(SQuAD scoring is case-insensitive; real braille capital signs would
waste cells).

Conditions (gemini only, 1568px, bw):
  img-braille-5x7    1px dots, cell 5x7  -> 313x224 = 70,112 cells/page
  img-braille-7x10   2px dots, cell 7x10 -> 224x156 = 34,944 cells/page

Usage:
  uv run exp21_braille.py --render-only
  uv run exp21_braille.py                  # lengths 50,150
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp21"
OUT_DIR = RESULTS / f"{EXP}-braille"
MODELS = {  # model -> (price_in, price_out, key_name, key_env)
    "google/gemini-3.5-flash": (0.6, 4.0, "openrouter", "OPENROUTER_API_KEY"),
    "gpt-5.5": (2.0, 16.0, "openai", "OPENAI_API_KEY"),
}
MODEL = "google/gemini-3.5-flash"
PRICE_IN, PRICE_OUT = 0.6, 4.0
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)

# dots numbered 1-6: 1=top-left 2=mid-left 3=bottom-left 4=top-right 5=mid-right 6=bottom-right
# bitmask: bit0=dot1 .. bit5=dot6 (matches Unicode U+2800 offsets)
_L = {
    "a": 0x01,
    "b": 0x03,
    "c": 0x09,
    "d": 0x19,
    "e": 0x11,
    "f": 0x0B,
    "g": 0x1B,
    "h": 0x13,
    "i": 0x0A,
    "j": 0x1A,
    "k": 0x05,
    "l": 0x07,
    "m": 0x0D,
    "n": 0x1D,
    "o": 0x15,
    "p": 0x0F,
    "q": 0x1F,
    "r": 0x17,
    "s": 0x0E,
    "t": 0x1E,
    "u": 0x25,
    "v": 0x27,
    "w": 0x3A,
    "x": 0x2D,
    "y": 0x3D,
    "z": 0x35,
}
_PUNCT = {
    ".": 0x32,
    ",": 0x02,
    "'": 0x04,
    "-": 0x24,
    ":": 0x12,
    ";": 0x06,
    "?": 0x26,
    "!": 0x16,
    " ": 0x00,
}
_NUMSIGN = 0x3C  # dots 3456
_DIGIT = {d: _L["abcdefghij"[i]] for i, d in enumerate("1234567890")}

# cell name -> (dot_px, adv, pitch); dot gap is 1px in both configs
CELLS = {
    "5x7": (1, 5, 7),
    "7x10": (2, 7, 10),
}


def braille_cells(text: str) -> tuple[list[int], list[int]]:
    """(cell bitmasks, original char index per cell). Lowercases; digit runs share one number sign."""
    cells, origin = [], []
    in_num = False
    for i, ch in enumerate(text):
        c = ch.lower()
        if c in _DIGIT:
            if not in_num:
                cells.append(_NUMSIGN)
                origin.append(i)
                in_num = True
            cells.append(_DIGIT[c])
            origin.append(i)
            continue
        in_num = False
        cells.append(_L.get(c, _PUNCT.get(c, 0x00)))
        origin.append(i)
    return cells, origin


def render_braille(cells: list[int], cell_name: str, size: int) -> Image.Image:
    dpx, adv, pitch = CELLS[cell_name]
    cols, rows = size // adv, size // pitch
    step = dpx + 1  # dot pitch inside the cell
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for idx, mask in enumerate(cells[: cols * rows]):
        if not mask:
            continue
        row, col = divmod(idx, cols)
        x0, y0 = col * adv, row * pitch
        for bit in range(6):
            if not mask & (1 << bit):
                continue
            dc, dr = divmod(bit, 3)  # dots 1-3 left column, 4-6 right column
            dx, dy = x0 + dc * step, y0 + dr * step
            for yy in range(dy, dy + dpx):
                for xx in range(dx, dx + dpx):
                    if xx < size and yy < size:
                        px[xx, yy] = _BLACK
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
    ap.add_argument("--cells", default="5x7,7x10")
    ap.add_argument("--lengths", default="50,150")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--effort", default=None)
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    MODEL = args.model
    PRICE_IN, PRICE_OUT, key_name, key_env = MODELS[MODEL]
    keys = {} if args.render_only else {key_name: load_env_key(key_env, args.env)}
    all_paras = squad.load_paragraphs(CACHE)
    prompt_tpl = load_prompt("exp21-qa-braille.md")

    tasks = []
    for cell_name in args.cells.split(","):
        dpx, adv, pitch = CELLS[cell_name]
        cols, rows = args.size // adv, args.size // pitch
        cap = cols * rows
        cond = f"img-braille-{cell_name}" + (
            f"+eff-{args.effort}" if args.effort else ""
        )
        for length in (int(x) for x in args.lengths.split(",")):
            paras = all_paras[:length]
            flow, offsets = squad.build_flow(paras)
            cells, origin = braille_cells(flow)
            pages = []
            i = 0
            while i < len(cells):
                j = min(i + cap, len(cells))
                pages.append((i, j))
                i = j
            print(
                f"{cond} len {length}: {len(pages)} pages, {cap} cells/page "
                f"({cols}x{rows}), {len(cells)} cells for {len(flow)} chars",
                flush=True,
            )
            ctx = {"args": args, "keys": keys}
            for ci, cj in pages:
                start = origin[ci]
                end = origin[cj - 1] + 1
                questions = squad.sample_chunk_questions(
                    paras, offsets, start, end, args.qpc, args.seed
                )
                if not questions:
                    continue
                png = (
                    CACHE
                    / f"{EXP}-{cell_name}-{sha8(flow[start:end], cell_name, str(args.size))}.png"
                )
                if not png.exists() or png.stat().st_size == 0:
                    atomic_save(render_braille(cells[ci:cj], cell_name, args.size), png)
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
