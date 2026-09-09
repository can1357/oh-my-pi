# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp20: swap the per-model round-2 winner font for unscii-8 (8x8u).

For each model, re-run its best-known config with FontCfg("8x8u","unscii-8",8,8)
in place of the winning font, everything else unchanged (layout, variant,
1568px, seed 42, qpc 30). 8x8u @1568: grid 196x196 = 38,416 chars/page
(~2x doc-8on16's effective capacity); doc 2x96 cols x 196 rows.

  model                     config swapped from        exp20 condition
  gpt-5.5                   doc-8on16-bw            -> img-doc-8x8u-bw
  google/gemini-3.5-flash   doc-8on16-sent-dim      -> img-doc-8x8u-sent-dim
  moonshotai/kimi-k2.6      doc8on16-sent-dim       -> img-doc-8x8u-sent-dim
  z-ai/glm-4.6v             doc-8on16-sent          -> img-doc-8x8u-sent
  claude-fable-5            grid 6x12-dim           -> img-8x8u-dim
  claude-opus-4-8           grid 8x13-bw            -> img-8x8u-bw

Usage:
  uv run exp20_8x8u.py --model gpt-5.5 --render-only   # sample PNG, no API
  uv run exp20_8x8u.py --model gpt-5.5                 # lengths 50,150,250
"""

import argparse
import os
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import _DARK, _DIMMED, FontCfg, _stopword_mask, capacity, load_font, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp20"
OUT_DIR = RESULTS / f"{EXP}-8x8u"
FONT = FontCfg("8x8u", "unscii-8", 8, 8)
GUTTER = 3
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_INK = (24, 24, 24)

# model -> (cond, layout, variant, price_in, price_out, key_name)
CONFIGS = {
    "gpt-5.5": ("img-doc-8x8u-bw", "doc", "bw", 2.0, 16.0, "openai"),
    "google/gemini-3.5-flash": (
        "img-doc-8x8u-sent-dim",
        "doc",
        "sent-dim",
        0.6,
        4.0,
        "openrouter",
    ),
    "moonshotai/kimi-k2.6": (
        "img-doc-8x8u-sent-dim",
        "doc",
        "sent-dim",
        0.68,
        3.41,
        "openrouter",
    ),
    "z-ai/glm-4.6v": ("img-doc-8x8u-sent", "doc", "sent", 0.30, 0.90, "openrouter"),
    "claude-fable-5": ("img-8x8u-dim", "grid", "dim", 10.0, 50.0, "anthropic"),
    "claude-opus-4-8": ("img-8x8u-bw", "grid", "bw", 15.0, 75.0, "anthropic"),
}
KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def slug(model: str) -> str:
    return model.split("/")[-1]


def cached(model: str, payload: object, fn, fresh: bool) -> dict:
    key = sha8(model, f"{EXP}-qa", json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if not fresh and path.exists():
        return json.loads(path.read_text())
    out = fn()
    if out.get("stop") != "max_tokens":
        tmp = path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(out))
        tmp.replace(path)
    else:
        print(f"WARN truncated response, not cached ({model})", flush=True)
    return out


# --- document layout (exp14's renderer, generalized for hex fonts + dim variants) ---


def wrap(text: str, width: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        while len(word) > width:
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:width])
            word = word[width:]
        if not cur:
            cur = word
        elif len(cur) + 1 + len(word) <= width:
            cur += " " + word
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def layout_page(paras: list[dict], col_w: int) -> list[dict]:
    lines: list[dict] = []
    prev_title = None
    for p in paras:
        if p["title"] != prev_title:
            if lines:
                lines.append({"kind": "blank", "text": ""})
            for hl in wrap(p["title"].replace("_", " ").upper(), col_w):
                lines.append({"kind": "heading", "text": hl})
            prev_title = p["title"]
        elif lines:
            lines.append({"kind": "blank", "text": ""})
        for bl in wrap(p["ctx"], col_w):
            lines.append({"kind": "body", "text": bl})
    return lines


def pack_pages(paras: list[dict], col_w: int, max_lines: int) -> list[tuple[int, int]]:
    pages = []
    i = 0
    while i < len(paras):
        j = i + 1
        while j < len(paras) and len(layout_page(paras[i : j + 1], col_w)) <= max_lines:
            j += 1
        pages.append((i, j))
        i = j
    return pages


def _char_styles(lines: list[dict], variant: str) -> list[list[tuple[int, int, int]]]:
    """Per-line per-char body glyph color for sent / dim composition."""
    joined = "\n".join(ln["text"] for ln in lines)
    sent_idx = None
    if "sent" in variant:
        sent_idx, idx = [], 0
        for i, ch in enumerate(joined):
            sent_idx.append(idx)
            if ch in ".!?" and i + 1 < len(joined) and joined[i + 1] in " \n":
                idx += 1
    dim = _stopword_mask(joined) if "dim" in variant else None
    colors, pos = [], 0
    for ln in lines:
        row = []
        for k in range(len(ln["text"])):
            i = pos + k
            if dim is not None and dim[i]:
                row.append(_DIMMED)
            elif sent_idx is not None:
                row.append(_DARK[sent_idx[i] % 6])
            else:
                row.append(_INK)
        colors.append(row)
        pos += len(ln["text"]) + 1
    return colors


def render_doc(lines: list[dict], size: int, variant: str, cache: Path) -> Image.Image:
    glyphs, font_ascent = load_font(FONT, cache)
    ascent = FONT.ascent if FONT.ascent is not None else font_ascent
    cols, rows, _ = capacity(FONT, size)
    col_w = (cols - GUTTER) // 2
    styles = _char_styles(lines, variant)
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for li, ln in enumerate(lines):
        column, row = divmod(li, rows)
        if column > 1:
            break
        x_origin = column * (col_w + GUTTER) * FONT.adv
        y0 = row * FONT.pitch
        for ci, ch in enumerate(ln["text"]):
            glyph = glyphs.get(ord(ch))
            if glyph is None:
                continue
            fg = _BLACK if ln["kind"] == "heading" else styles[li][ci]
            w, h, xoff, yoff = glyph["bbx"]
            top = y0 + ascent - h - yoff
            shift = 0x80 if w <= 8 else 0x8000
            strikes = (0, 1) if ln["kind"] == "heading" else (0,)
            for dx in strikes:
                for r, bits in enumerate(glyph["rows"]):
                    y = top + r
                    if not 0 <= y < size:
                        continue
                    for b in range(w):
                        if bits & (shift >> b):
                            x = x_origin + ci * FONT.adv + xoff + b + dx
                            if 0 <= x < size:
                                px[x, y] = fg
    return img


# --- runner -------------------------------------------------------------------


def atomic_save(img: Image.Image, png: Path) -> None:
    tmp = png.with_suffix(
        f".{os.getpid()}.tmp.png"
    )  # pid-unique: parallel models share sent-dim PNGs
    img.save(tmp)
    tmp.replace(png)


def parse_answers(text: str, n: int) -> list[str]:
    """parse_numbered + exp19's positional fallback (glm drops numbering)."""
    nums = squad.parse_numbered(text, n)
    if sum(bool(a) for a in nums) >= max(1, n // 2):
        return nums
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if lines and lines[0].endswith(":"):
        lines = lines[1:]
    if 0 < len(lines) <= n:
        return lines + [""] * (n - len(lines))
    return nums


def qa_unit(
    model: str,
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
    qa = cached(
        model,
        {"messages": messages, "effort": None},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(keys, model, messages, max_tokens=args.max_tokens),
            )
        ),
        args.fresh,
    )
    answers = parse_answers(qa["text"], len(questions))
    records = []
    for q, a in zip(questions, answers):
        records.append(
            {
                "model": model,
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


def aggregate(records: list[dict], price_in: float, price_out: float) -> list[dict]:
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
        cost = (tin + 0.1 * creads) * price_in / 1e6 + tout * price_out / 1e6
        out.append(
            {
                "model": recs[0]["model"],
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=sorted(CONFIGS))
    ap.add_argument("--lengths", default="50,150,250")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    cond, layout, variant, price_in, price_out, key_name = CONFIGS[args.model]
    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cols, rows, grid_cap = capacity(FONT, args.size)
    col_w = (cols - GUTTER) // 2
    max_lines = 2 * rows
    print(
        f"{args.model}: {cond} ({layout}/{variant}); 8x8u grid {cols}x{rows}={grid_cap}, "
        f"doc 2x{col_w}+g{GUTTER}, {max_lines} slots",
        flush=True,
    )

    keys = (
        {}
        if args.render_only
        else {key_name: load_env_key(KEY_ENV[key_name], args.env)}
    )
    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    cap_stats = {}
    for length in (int(x) for x in args.lengths.split(",")):
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        ctx = {"args": args, "keys": keys}
        if layout == "doc":
            pages = pack_pages(paras, col_w, max_lines)
            page_chars = [
                offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i] for i, j in pages
            ]
            cap_stats[length] = {
                "pages": len(pages),
                "mean_chars_page": round(sum(page_chars) / len(pages)),
            }
            prompt = load_prompt("exp04-qa-image.md").format(col_w=col_w, rows=rows)
            for i, j in pages:
                start = offsets[i]
                end = offsets[j - 1] + len(paras[j - 1]["ctx"])
                questions = squad.sample_chunk_questions(
                    paras, offsets, start, end, args.qpc, args.seed
                )
                if not questions:
                    continue
                lines = layout_page(paras[i:j], col_w)
                key = sha8(
                    cond,
                    json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]),
                    str(args.size),
                )
                png = CACHE / f"{EXP}-doc-{variant}-{key}.png"
                if not png.exists() or png.stat().st_size == 0:
                    atomic_save(render_doc(lines, args.size, variant, CACHE), png)
                tasks.append(
                    (args.model, cond, prompt, png, questions, length, start, ctx)
                )
        else:
            cap_stats[length] = {
                "pages": -(-len(flow) // grid_cap),
                "mean_chars_page": grid_cap,
            }
            prompt = load_prompt("qa-image.md").format(cols=cols, rows=rows)
            for start in range(0, len(flow), grid_cap):
                end = min(start + grid_cap, len(flow))
                questions = squad.sample_chunk_questions(
                    paras, offsets, start, end, args.qpc, args.seed
                )
                if not questions:
                    continue
                png = (
                    CACHE
                    / f"{EXP}-grid-{variant}-{sha8(flow[start:end], str(args.size))}.png"
                )
                if not png.exists() or png.stat().st_size == 0:
                    atomic_save(
                        render(flow[start:end], FONT, CACHE, args.size, variant), png
                    )
                tasks.append(
                    (args.model, cond, prompt, png, questions, length, start, ctx)
                )
        print(
            f"  len {length}: {cap_stats[length]['pages']} pages, "
            f"mean {cap_stats[length]['mean_chars_page']} chars/page, corpus {len(flow)}",
            flush=True,
        )

    if args.render_only:
        print(f"sample: {tasks[0][3]}" if tasks else "no tasks")
        return

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(qa_unit, *t) for t in tasks]
        for done, fut in enumerate(futures, 1):
            records.extend(fut.result())
            print(f"  {done}/{len(futures)}", flush=True)

    s = slug(args.model)
    with (OUT_DIR / f"records-{s}.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    cells = aggregate(records, price_in, price_out)
    hdr = "model,length,condition,n,em,f1,f1_se,abstained,tok_in,tok_out,tok_cache_r,tok_reasoning,cost_usd"
    with (OUT_DIR / f"matrix-{s}.csv").open("w") as fh:
        fh.write(hdr + "\n")
        for c in cells:
            fh.write(",".join(str(c[k]) for k in hdr.split(",")) + "\n")
    (OUT_DIR / f"summary-{s}.json").write_text(
        json.dumps(
            {"args": vars(args), "capacity": cap_stats, "cells": cells}, indent=1
        )
    )
    for c in cells:
        print(
            f"len {c['length']:<4} {c['condition']:<24} n={c['n']:<4} EM {c['em']:.3f}  "
            f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}  "
            f"out={c['tok_out']} rsn={c['tok_reasoning']}",
            flush=True,
        )
    print(f"-> {OUT_DIR}/records-{s}.jsonl", flush=True)


if __name__ == "__main__":
    main()
