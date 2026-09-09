# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp04: document-style (in-distribution) layout vs row-major grid.

Hypothesis: VLMs are pretrained on documents, not 261-col row-major char
grids. A two-column newspaper page (word-wrap, paragraph breaks, headings)
costs capacity (gutter, blank lines, ragged right) but may read better per
token. Conditions: img-6x10-doc (near-black, document-plain) and
img-6x10-doc-sent (sentence-hue glyphs). Same 6x10 font/page size as the
img-6x10-sent baseline; chunking is paragraph-aligned page packing.
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import _DARK, capacity, parse_bdf, ensure_font  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402
from final import cached  # noqa: E402

MODELS = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
LENGTHS = (50, 150)
CONDITIONS = ("img-6x10-doc", "img-6x10-doc-sent")
FONT = FONTS["6x10"]
GUTTER = 3  # char cells between columns
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_INK = (24, 24, 24)  # near-black body text, like a printed page


# --- document layout -------------------------------------------------------


def wrap(text: str, width: int) -> list[str]:
    """Greedy word-wrap, no mid-word breaks (hard split only for width+ words)."""
    lines: list[str] = []
    cur = ""
    for word in text.split():
        while len(word) > width:  # pathological; never hit on SQuAD prose
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

    Article title changes become headings (heading is repeated at the top of
    a page even when the article continues from the previous page, since each
    page is read in isolation). Paragraphs are separated by one blank line.
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


# --- renderer (glyph loop copied from bdf.render, two-column layout) -------


def _sentence_colors(lines: list[dict]) -> list[list[tuple[int, int, int]]]:
    """Per-line per-char glyph color cycling hue per sentence across the page."""
    joined = "\n".join(ln["text"] for ln in lines)
    idx, out_idx = 0, []
    for i, ch in enumerate(joined):
        out_idx.append(idx)
        if ch in ".!?" and i + 1 < len(joined) and joined[i + 1] in " \n":
            idx += 1
    colors, pos = [], 0
    for ln in lines:
        n = len(ln["text"])
        colors.append([_DARK[out_idx[pos + k] % 6] for k in range(n)])
        pos += n + 1  # the joining newline
    return colors


def render_doc(lines: list[dict], size: int, variant: str, cache: Path) -> Image.Image:
    """Two-column page: left column rows top-to-bottom, then right column."""
    glyphs, font_ascent = parse_bdf(ensure_font(FONT, cache))
    ascent = FONT.ascent if FONT.ascent is not None else font_ascent
    cols, rows, _ = capacity(FONT, size)
    col_w = (cols - GUTTER) // 2
    sent_colors = _sentence_colors(lines) if variant == "doc-sent" else None
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for li, ln in enumerate(lines):
        column, row = divmod(li, rows)
        if column > 1:
            break  # overflow guard; pack_pages should prevent this
        x_origin = column * (col_w + GUTTER) * FONT.adv
        y0 = row * FONT.pitch
        for ci, ch in enumerate(ln["text"]):
            glyph = glyphs.get(ord(ch))
            if glyph is None:
                continue
            if ln["kind"] == "heading":
                fg = _BLACK
            elif sent_colors is not None:
                fg = sent_colors[li][ci]
            else:
                fg = _INK
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


# --- runner -----------------------------------------------------------------


def run_page(model: str, cond: str, page: tuple[int, int], ctx: dict) -> list[dict]:
    args, paras, offsets, keys = ctx["args"], ctx["paras"], ctx["offsets"], ctx["keys"]
    i, j = page
    start = offsets[i]
    end = offsets[j - 1] + len(paras[j - 1]["ctx"])
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    variant = cond.removeprefix("img-6x10-")
    lines = ctx["lines"][page]
    page_key = sha8(
        cond, json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]), str(args.size)
    )
    png = CACHE / f"exp04-{variant}-{page_key}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        render_doc(lines, args.size, variant, CACHE).save(tmp)
        tmp.replace(png)
    cols, rows, _ = capacity(FONT, args.size)
    col_w = (cols - GUTTER) // 2
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "text": load_prompt("exp04-qa-image.md").format(
                        col_w=col_w, rows=rows
                    )
                },
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        model,
        "exp04-qa",
        {"messages": messages, "effort": args.effort},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(
                    keys,
                    model,
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
                "model": model,
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


def aggregate(records: list[dict], price_in: float, price_out: float) -> dict:
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
        (tok["in"] + 1.25 * tok["cache_w"] + 0.1 * tok["cache_r"]) / 1e6 * price_in
    )
    cost_out = tok["out"] / 1e6 * price_out
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
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--lengths", default=",".join(map(str, LENGTHS)))
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
        help="render pages + capacity stats, no API",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp04-layout"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {}
    if not args.render_only:
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    cols, rows, grid_cap = capacity(FONT, args.size)
    col_w = (cols - GUTTER) // 2
    max_lines = 2 * rows

    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    capacity_stats = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        pages = pack_pages(paras, col_w, max_lines)
        page_lines = {pg: layout_page(paras[pg[0] : pg[1]], col_w) for pg in pages}
        page_chars = [
            offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i] for i, j in pages
        ]
        capacity_stats[length] = {
            "pages": len(pages),
            "chars_per_page": page_chars,
            "mean_chars_page": round(sum(page_chars) / len(pages)),
            "grid_chars_page": grid_cap,
            "corpus_chars": len(flow),
            "grid_pages": -(-len(flow) // grid_cap),
        }
        ctx = {
            "args": args,
            "paras": paras,
            "offsets": offsets,
            "keys": keys,
            "length": length,
            "lines": page_lines,
        }
        for model in models:
            for cond in conditions:
                for pg in pages:
                    tasks.append((model, cond, pg, ctx))

    print(
        f"layout: {cols} cols -> 2 x {col_w} + gutter {GUTTER}; {max_lines} line slots/page"
    )
    for length, st in capacity_stats.items():
        print(
            f"  len {length}: {st['pages']} doc pages (mean {st['mean_chars_page']} chars/page; "
            f"grid {st['grid_chars_page']} chars/page -> {st['grid_pages']} pages)"
        )
    if args.render_only:
        for length in lengths:
            paras = all_paras[:length]
            pages = pack_pages(paras, col_w, max_lines)
            for cond in conditions:
                variant = cond.removeprefix("img-6x10-")
                i, j = pages[0]
                lines = layout_page(paras[i:j], col_w)
                key = sha8(
                    cond,
                    json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]),
                    str(args.size),
                )
                png = CACHE / f"exp04-{variant}-{key}.png"
                tmp = png.with_suffix(".tmp.png")
                render_doc(lines, args.size, variant, CACHE).save(tmp)
                tmp.replace(png)
                print(f"  sample: {png}")
        return

    print(f"grid: {len(tasks)} page tasks")
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_page, m, c, pg, ctx) for m, c, pg, ctx in tasks]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} pages", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for model in models:
        for length in lengths:
            for cond in conditions:
                sub = [
                    r
                    for r in records
                    if r["model"] == model
                    and r["length"] == length
                    and r["cond"] == cond
                ]
                if not sub:
                    continue
                cells.append(
                    {
                        "model": model,
                        "length": length,
                        "condition": cond,
                        **aggregate(sub, *MODELS[model]),
                    }
                )
    (out_dir / "summary.json").write_text(
        json.dumps(
            {"args": vars(args), "capacity": capacity_stats, "cells": cells}, indent=1
        )
    )
    import csv

    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    for c in cells:
        print(
            f"{c['model']:<26} len {c['length']:<4} {c['condition']:<20} "
            f"n={c['n']:<4} EM {c['em']:.3f}  F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
