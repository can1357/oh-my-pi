# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp18: best optical profile for moonshotai/kimi-k2.6.

Round-1 levers (patch-aligned pitch 16, two-column doc layout, per-model
variant) were validated on gpt-5.5/gemini only. Kimi's round-0 winner is
img-8x13-sent-dim (beats text at 150) but it pays the worst read tax in the
fleet (~95% of image-cell cost is output tokens; 120k+ out at length 250).

Screen at length 150, anchored on sent-dim:
  img-8on16-sent-dim      grid, 8x13 glyphs on an 8x16 cell (alignment only)
  img-doc8on16-sent-dim   two-column doc layout at 8on16 (alignment + layout)
  img-doc8x13-sent-dim    two-column doc layout at pitch 13 (layout only)
Confirm the winner at 50 and 250.

Usage: uv run exp18_bestkimi.py                       # screening (length 150)
       uv run exp18_bestkimi.py --lengths 50,250 --conditions img-...   # confirm
       uv run exp18_bestkimi.py --render-only          # sample pages, no API
       uv run exp18_bestkimi.py --report --lengths 50,150,250  # re-aggregate from cache
"""

import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import (
    _DARK,
    _DIMMED,
    FontCfg,
    _stopword_mask,
    capacity,
    ensure_font,
    parse_bdf,
    render,
)  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODEL = "moonshotai/kimi-k2.6"
PRICE_IN, PRICE_OUT = 0.68, 3.41
FONTS = {
    "8on16": FontCfg("8on16", "8x13", 8, 16),  # patch-aligned: 8x13 glyphs, 16 px pitch
    "8x13": FontCfg("8x13", "8x13", 8, 13),  # kimi's round-0 winner pitch
}
# cond -> (kind, font key, variant). All anchored on sent-dim (kimi's winner).
CONDITIONS = {
    "img-8on16-sent-dim": ("grid", "8on16", "sent-dim"),
    "img-doc8on16-sent-dim": ("doc", "8on16", "sent-dim"),
    "img-doc8x13-sent-dim": ("doc", "8x13", "sent-dim"),
}
GUTTER = 3  # char cells between doc columns
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)


def cached(model: str, tag: str, payload: object, fn, fresh: bool) -> dict:
    """Disk-cache `fn() -> dict` keyed by (model, tag, payload). Truncations are not cached."""
    key = sha8(model, tag, json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if path.exists() and not fresh:
        hit = json.loads(path.read_text())
        if hit.get("stop") != "max_tokens":
            return hit
    out = fn()
    if out.get("stop") == "max_tokens":
        print(f"  WARN truncated, not cached: {model} {tag} {key}")
    else:
        path.write_text(json.dumps(out))
    return out


# --- document layout (ported from exp04, parameterized for font/pitch) -----


def wrap(text: str, width: int) -> list[str]:
    """Greedy word-wrap, no mid-word breaks (hard split only for width+ words)."""
    lines: list[str] = []
    cur = ""
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
    """Typeset paragraphs into lines: [{kind: heading|body|blank, text}].

    Title changes become uppercase double-strike headings; the heading is
    repeated at the top of a page when an article continues, since each page
    is read in isolation. One blank line between paragraphs.
    """
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
    """Greedy paragraph-aligned packing: [(i, j)] para ranges, one per page."""
    pages = []
    i = 0
    while i < len(paras):
        j = i + 1
        while j < len(paras) and len(layout_page(paras[i : j + 1], col_w)) <= max_lines:
            j += 1
        pages.append((i, j))
        i = j
    return pages


def _sentence_indices_doc(lines: list[dict]) -> list[list[int]]:
    """Per-line per-char sentence index, cycling across the page (newline counts as boundary space)."""
    joined = "\n".join(ln["text"] for ln in lines)
    idx, run = 0, []
    for i, ch in enumerate(joined):
        run.append(idx)
        if ch in ".!?" and i + 1 < len(joined) and joined[i + 1] in " \n":
            idx += 1
    out, pos = [], 0
    for ln in lines:
        n = len(ln["text"])
        out.append(run[pos : pos + n])
        pos += n + 1  # the joining newline
    return out


def render_doc(lines: list[dict], cfg: FontCfg, size: int, cache: Path) -> Image.Image:
    """Two-column sent-dim page: left column top-to-bottom, then right.

    Body glyph color = sentence hue, overridden to light gray for stopwords
    (same composition as bdf.render's sent-dim). Headings: black double-strike.
    """
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, cache))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, _ = capacity(cfg, size)
    col_w = (cols - GUTTER) // 2
    sent_idx = _sentence_indices_doc(lines)
    dim_masks = [_stopword_mask(ln["text"]) for ln in lines]
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for li, ln in enumerate(lines):
        column, row = divmod(li, rows)
        if column > 1:
            break  # overflow guard; pack_pages should prevent this
        x_origin = column * (col_w + GUTTER) * cfg.adv
        y0 = row * cfg.pitch
        for ci, ch in enumerate(ln["text"]):
            glyph = glyphs.get(ord(ch))
            if glyph is None:
                continue
            if ln["kind"] == "heading":
                fg = _BLACK
            elif dim_masks[li][ci]:
                fg = _DIMMED
            else:
                fg = _DARK[sent_idx[li][ci] % 6]
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
                            x = x_origin + ci * cfg.adv + xoff + b + dx
                            if 0 <= x < size:
                                px[x, y] = fg
    return img


# --- runner -----------------------------------------------------------------


def doc_png(
    cond: str, paras: list[dict], lines: list[dict], cfg: FontCfg, size: int
) -> Path:
    key = sha8(cond, json.dumps([(p["title"], p["ctx"]) for p in paras]), str(size))
    png = CACHE / f"exp18-{cond}-{key}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        render_doc(lines, cfg, size, CACHE).save(tmp)
        tmp.replace(png)
    return png


def run_unit(cond: str, unit: dict, ctx: dict) -> list[dict]:
    """One (condition, page/chunk) unit: render carrier, QA, score."""
    args, paras, offsets, keys = ctx["args"], ctx["paras"], ctx["offsets"], ctx["keys"]
    start, end = unit["start"], unit["end"]
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    kind, font, variant = CONDITIONS[cond]
    cfg = FONTS[font]
    cols, rows, _ = capacity(cfg, args.size)
    if kind == "grid":
        chunk_text = ctx["flow"][start:end]
        png = CACHE / f"exp18-{cond}-{sha8(chunk_text, str(args.size))}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(".tmp.png")
            render(chunk_text, cfg, CACHE, args.size, variant).save(tmp)
            tmp.replace(png)
        prompt = load_prompt("qa-image.md").format(cols=cols, rows=rows)
    else:
        i, j = unit["page"]
        png = doc_png(cond, paras[i:j], unit["lines"], cfg, args.size)
        col_w = (cols - GUTTER) // 2
        prompt = load_prompt("exp04-qa-image.md").format(col_w=col_w, rows=rows)
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [{"text": prompt}, {"image_path": png}, {"text": q_block}],
        }
    ]
    qa = cached(
        MODEL,
        "exp18-qa",
        {"messages": messages, "size": args.size, "effort": args.effort},
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
                "length": ctx["length"],
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


def aggregate(records: list[dict]) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records]
    mean_f1 = sum(f1s) / n
    se = (sum((x - mean_f1) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    us = [u for r in records if "usage" in r for u in r["usage"]]
    tok = {
        k: sum(u.get(k, 0) for u in us)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost_in = (
        (tok["in"] + 1.25 * tok["cache_w"] + 0.1 * tok["cache_r"]) / 1e6 * PRICE_IN
    )
    cost_out = tok["out"] / 1e6 * PRICE_OUT
    return {
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        **{f"tok_{k}": v for k, v in tok.items()},
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lengths", default="150")
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument(
        "--render-only",
        action="store_true",
        help="render first page per cond + capacity stats, no API",
    )
    ap.add_argument(
        "--report",
        action="store_true",
        help="re-aggregate (all units should hit cache)",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp18-bestkimi"
    out_dir.mkdir(parents=True, exist_ok=True)

    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    for c in conditions:
        if c not in CONDITIONS:
            sys.exit(f"unknown condition: {c}")

    keys = {}
    if not args.render_only:
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    tasks: list[tuple[str, dict, dict]] = []
    capacity_stats: dict = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        ctx = {
            "args": args,
            "flow": flow,
            "paras": paras,
            "offsets": offsets,
            "keys": keys,
            "length": length,
        }
        capacity_stats[length] = {"corpus_chars": len(flow), "conds": {}}
        for cond in conditions:
            kind, font, _ = CONDITIONS[cond]
            cfg = FONTS[font]
            cols, rows, grid_cap = capacity(cfg, args.size)
            if kind == "grid":
                units = [
                    {"start": s, "end": min(s + grid_cap, len(flow))}
                    for s in range(0, len(flow), grid_cap)
                ]
                chars = [u["end"] - u["start"] for u in units]
            else:
                col_w = (cols - GUTTER) // 2
                pages = pack_pages(paras, col_w, 2 * rows)
                units = []
                for i, j in pages:
                    units.append(
                        {
                            "start": offsets[i],
                            "end": offsets[j - 1] + len(paras[j - 1]["ctx"]),
                            "page": (i, j),
                            "lines": layout_page(paras[i:j], col_w),
                        }
                    )
                chars = [u["end"] - u["start"] for u in units]
            capacity_stats[length]["conds"][cond] = {
                "pages": len(units),
                "mean_chars_page": round(sum(chars) / len(units)),
                "grid_chars_page": grid_cap,
            }
            for u in units:
                tasks.append((cond, u, ctx))

    for length, st in capacity_stats.items():
        print(f"len {length}: corpus {st['corpus_chars']} chars")
        for cond, cs in st["conds"].items():
            print(
                f"  {cond:<24} {cs['pages']} pages, mean {cs['mean_chars_page']} chars/page (grid cap {cs['grid_chars_page']})"
            )

    if args.render_only:
        for cond, u, ctx in tasks:
            if u["start"] != 0:
                continue
            kind, font, variant = CONDITIONS[cond]
            cfg = FONTS[font]
            if kind == "grid":
                chunk_text = ctx["flow"][u["start"] : u["end"]]
                png = CACHE / f"exp18-{cond}-{sha8(chunk_text, str(args.size))}.png"
                tmp = png.with_suffix(".tmp.png")
                render(chunk_text, cfg, CACHE, args.size, variant).save(tmp)
                tmp.replace(png)
            else:
                i, j = u["page"]
                png = doc_png(cond, ctx["paras"][i:j], u["lines"], cfg, args.size)
            print(f"  sample: {png}")
        return

    print(f"grid: {len(tasks)} unit tasks on {MODEL}")
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_unit, c, u, ctx) for c, u, ctx in tasks]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} units", flush=True)

    # Merge with any prior records (confirm runs extend the screening set).
    rec_path = out_dir / "records.jsonl"
    old: list[dict] = []
    if rec_path.exists():
        ran = {(r["length"], r["cond"]) for r in records}
        for line in rec_path.read_text().splitlines():
            r = json.loads(line)
            if (r["length"], r["cond"]) not in ran:
                old.append(r)
    records = old + records
    tmp = rec_path.with_suffix(".tmp.jsonl")
    with tmp.open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    tmp.replace(rec_path)

    cells = []
    for length in sorted({r["length"] for r in records}):
        for cond in CONDITIONS:
            sub = [r for r in records if r["length"] == length and r["cond"] == cond]
            if not sub:
                continue
            cells.append(
                {"model": MODEL, "length": length, "condition": cond, **aggregate(sub)}
            )
    (out_dir / "summary.json").write_text(
        json.dumps(
            {"args": vars(args), "capacity": capacity_stats, "cells": cells}, indent=1
        )
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    for c in cells:
        print(
            f"len {c['length']:<4} {c['condition']:<24} n={c['n']:<4} EM {c['em']:.3f}  "
            f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  out {c['tok_out']:>7} (reas {c['tok_reasoning']})  ${c['cost_usd']:.4f}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
