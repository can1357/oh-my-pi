# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp19: best optical profile for z-ai/glm-4.6v (weakest optical reader in the fleet).

glm uniquely needed dark mode (bright hues on black) and its round-0 winner was
img-8x13-dark-sent (.789/.753/.638 vs text .944/.904/.880). Round-1 levers
(patch-aligned pitch 16, two-column doc layout) were only validated on
gpt-5.5/gemini. Screen at length 150:

  img-8on16-dark-sent      8x13 glyphs on an 8x16 cell (patch-aligned), dark
  img-doc-8on16-dark-sent  doc layout + pitch 16 + dark palette (headings in
                           bright white double-strike)
  img-doc-8x13-dark-sent   layout-only control at the baseline pitch 13
  img-doc-8on16-sent       light-mode probe: does doc structure remove the
                           need for dark mode?

then confirm the screening winner at lengths 50 and 250. Methodology matches
the baselines: seed 42, qpc 30, size 1568, max_tokens 32768, effort default.

Usage: uv run exp19_bestglm.py                                  # screen @150
       uv run exp19_bestglm.py --lengths 50,250 --conditions X  # confirm winner
       uv run exp19_bestglm.py --render-only                    # sample PNGs, no API

Repeated invocations merge into results/exp19-bestglm/ (records for the
(model, length, condition) cells being run are replaced; others kept).
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
from bdf import _BRIGHT, _DARK, FontCfg, capacity, ensure_font, parse_bdf, render  # noqa: E402
from final import cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODELS = {"z-ai/glm-4.6v": (0.30, 0.90)}
LENGTHS = (150,)
FONTS = {
    "8on16": FontCfg(
        "8on16", "8x13", 8, 16
    ),  # patch-aligned padded cell (exp01 pattern)
    "8x13": FontCfg("8x13", "8x13", 8, 13),  # baseline pitch
}
# condition -> (kind, font key, palette variant)
CONDITIONS = {
    "img-8on16-dark-sent": ("grid", "8on16", "dark-sent"),
    "img-doc-8on16-dark-sent": ("doc", "8on16", "dark-sent"),
    "img-doc-8x13-dark-sent": ("doc", "8x13", "dark-sent"),
    "img-doc-8on16-sent": ("doc", "8on16", "sent"),
}
GUTTER = 3  # char cells between doc columns
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)


# --- document layout (ported from exp04, parameterized for font/pitch) ------


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

    Article title changes become headings (repeated at the top of a page even
    when an article continues, since each page is read in isolation).
    Paragraphs are separated by one blank line.
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


def _sentence_colors(
    lines: list[dict], palette: list
) -> list[list[tuple[int, int, int]]]:
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
        colors.append([palette[out_idx[pos + k] % 6] for k in range(n)])
        pos += n + 1  # the joining newline
    return colors


def render_doc(
    lines: list[dict], font: FontCfg, size: int, variant: str, cache: Path
) -> Image.Image:
    """Two-column page: left column rows top-to-bottom, then right column.

    variant "dark-sent": black page, body glyphs in bright sentence hues,
    headings bright white double-strike. variant "sent": white page, body in
    dark sentence hues, headings black double-strike. The page background
    covers the full image, so a padded cell (pitch > glyph height) is dark
    edge-to-edge in dark mode.
    """
    glyphs, font_ascent = parse_bdf(ensure_font(font, cache))
    ascent = font.ascent if font.ascent is not None else font_ascent
    cols, rows, _ = capacity(font, size)
    col_w = (cols - GUTTER) // 2
    dark = variant == "dark-sent"
    bg, heading_fg = (_BLACK, _WHITE) if dark else (_WHITE, _BLACK)
    sent_colors = _sentence_colors(lines, _BRIGHT if dark else _DARK)
    img = Image.new("RGB", (size, size), bg)
    px = img.load()
    for li, ln in enumerate(lines):
        column, row = divmod(li, rows)
        if column > 1:
            break  # overflow guard; pack_pages should prevent this
        x_origin = column * (col_w + GUTTER) * font.adv
        y0 = row * font.pitch
        for ci, ch in enumerate(ln["text"]):
            glyph = glyphs.get(ord(ch))
            if glyph is None:
                continue
            fg = heading_fg if ln["kind"] == "heading" else sent_colors[li][ci]
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
                            x = x_origin + ci * font.adv + xoff + b + dx
                            if 0 <= x < size:
                                px[x, y] = fg
    return img


# --- runner ------------------------------------------------------------------


def save_png(png: Path, img_fn) -> None:
    if png.exists() and png.stat().st_size > 0:
        return
    tmp = png.with_suffix(".tmp.png")
    img_fn().save(tmp)
    tmp.replace(png)


def run_grid_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    """One row-major-grid chunk: render via bdf.render, QA, score."""
    args, flow, paras, offsets, keys = (
        ctx["args"],
        ctx["flow"],
        ctx["paras"],
        ctx["offsets"],
        ctx["keys"],
    )
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    _, font_key, variant = CONDITIONS[cond]
    font = FONTS[font_key]
    chunk_text = flow[start:end]
    png = CACHE / f"exp19-{font_key}-{variant}-{sha8(chunk_text, str(args.size))}.png"
    save_png(png, lambda: render(chunk_text, font, CACHE, args.size, variant))
    cols, rows, _ = capacity(font, args.size)
    prompt = load_prompt("qa-image.md").format(cols=cols, rows=rows)
    return qa_and_score(model, cond, prompt, png, questions, start, ctx)


def run_doc_page(model: str, cond: str, page: tuple[int, int], ctx: dict) -> list[dict]:
    """One doc-layout page: typeset, render, QA, score."""
    args, paras, offsets, keys = ctx["args"], ctx["paras"], ctx["offsets"], ctx["keys"]
    i, j = page
    start = offsets[i]
    end = offsets[j - 1] + len(paras[j - 1]["ctx"])
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    _, font_key, variant = CONDITIONS[cond]
    font = FONTS[font_key]
    lines = ctx["lines"][cond][page]
    key = sha8(
        cond, json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]), str(args.size)
    )
    png = CACHE / f"exp19-doc-{font_key}-{variant}-{key}.png"
    save_png(png, lambda: render_doc(lines, font, args.size, variant, CACHE))
    cols, rows, _ = capacity(font, args.size)
    col_w = (cols - GUTTER) // 2
    prompt = load_prompt("exp19-qa-doc.md").format(col_w=col_w, rows=rows)
    return qa_and_score(model, cond, prompt, png, questions, start, ctx)


def parse_answers(text: str, n: int) -> list[str]:
    """parse_numbered, with a fallback for glm's intermittently unnumbered output.

    glm-4.6v often ignores the "numbered list" instruction and emits plain
    answer lines in question order. When numbered parsing recovers fewer than
    half the answers and the response is a clean <=n line list, map lines
    positionally instead (preamble line ending in ':' is dropped).
    """
    nums = squad.parse_numbered(text, n)
    if sum(bool(a) for a in nums) >= max(1, n // 2):
        return nums
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if lines and lines[0].endswith(":"):
        lines = lines[1:]
    if 0 < len(lines) <= n:
        return lines + [""] * (n - len(lines))
    return nums


def qa_and_score(
    model: str,
    cond: str,
    prompt: str,
    png: Path,
    questions: list[dict],
    start: int,
    ctx: dict,
) -> list[dict]:
    args, keys = ctx["args"], ctx["keys"]
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [
                {"text": prompt},
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        model,
        "exp19-qa",
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
    answers = parse_answers(qa["text"], len(questions))
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
        help="render sample pages + capacity stats, no API",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp19-bestglm"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    for c in conditions:
        if c not in CONDITIONS:
            sys.exit(f"unknown condition: {c}")

    keys = {}
    if not args.render_only:
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    capacity_stats = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        # Doc page packing per font (max_lines differs with pitch).
        page_lines: dict[str, dict] = {}
        doc_stats = {}
        for cond in conditions:
            kind, font_key, _ = CONDITIONS[cond]
            if kind != "doc":
                continue
            font = FONTS[font_key]
            cols, rows, _cap = capacity(font, args.size)
            col_w = (cols - GUTTER) // 2
            pages = pack_pages(paras, col_w, 2 * rows)
            page_lines[cond] = {
                pg: layout_page(paras[pg[0] : pg[1]], col_w) for pg in pages
            }
            chars = [
                offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i] for i, j in pages
            ]
            doc_stats[cond] = {
                "pages": len(pages),
                "mean_chars_page": round(sum(chars) / len(pages)),
                "col_w": col_w,
                "rows": rows,
            }
        capacity_stats[length] = {
            "corpus_chars": len(flow),
            "grid": {
                fk: dict(zip(("cols", "rows", "chars"), capacity(FONTS[fk], args.size)))
                for fk in FONTS
            },
            "doc": doc_stats,
        }
        ctx = {
            "args": args,
            "flow": flow,
            "paras": paras,
            "offsets": offsets,
            "keys": keys,
            "length": length,
            "lines": page_lines,
        }
        for model in models:
            for cond in conditions:
                kind, font_key, _ = CONDITIONS[cond]
                if kind == "grid":
                    budget = capacity(FONTS[font_key], args.size)[2]
                    for start in range(0, len(flow), budget):
                        tasks.append(
                            (
                                "grid",
                                model,
                                cond,
                                (start, min(start + budget, len(flow))),
                                ctx,
                            )
                        )
                else:
                    for pg in page_lines[cond]:
                        tasks.append(("doc", model, cond, pg, ctx))

    for length, st in capacity_stats.items():
        print(f"len {length}: corpus {st['corpus_chars']} chars")
        for fk, g in st["grid"].items():
            print(f"  grid {fk}: {g['cols']}x{g['rows']} = {g['chars']} chars/page")
        for cond, d in st["doc"].items():
            print(
                f"  {cond}: {d['pages']} pages, mean {d['mean_chars_page']} chars/page (2x{d['col_w']}w, {d['rows']} rows)"
            )

    if args.render_only:
        for length in lengths:
            ctx = next(t[4] for t in tasks if t[4]["length"] == length)
            for cond in conditions:
                kind, font_key, variant = CONDITIONS[cond]
                if kind == "grid":
                    budget = capacity(FONTS[font_key], args.size)[2]
                    chunk_text = ctx["flow"][:budget]
                    png = (
                        CACHE
                        / f"exp19-{font_key}-{variant}-{sha8(chunk_text, str(args.size))}.png"
                    )
                    save_png(
                        png,
                        lambda: render(
                            chunk_text, FONTS[font_key], CACHE, args.size, variant
                        ),
                    )
                else:
                    pg = next(iter(ctx["lines"][cond]))
                    i, j = pg
                    key = sha8(
                        cond,
                        json.dumps([(p["title"], p["ctx"]) for p in ctx["paras"][i:j]]),
                        str(args.size),
                    )
                    png = CACHE / f"exp19-doc-{font_key}-{variant}-{key}.png"
                    save_png(
                        png,
                        lambda: render_doc(
                            ctx["lines"][cond][pg],
                            FONTS[font_key],
                            args.size,
                            variant,
                            CACHE,
                        ),
                    )
                print(f"  sample: {png}")
        return

    print(f"grid: {len(tasks)} page/chunk tasks")
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_grid_chunk, m, c, u[0], u[1], ctx)
            if kind == "grid"
            else pool.submit(run_doc_page, m, c, u, ctx)
            for kind, m, c, u, ctx in tasks
        ]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} tasks", flush=True)

    # Merge with prior invocations: replace the cells we just ran, keep the rest.
    ran = {(m, ln, c) for ln in lengths for m in models for c in conditions}
    rec_path = out_dir / "records.jsonl"
    if rec_path.exists():
        old = [json.loads(ln) for ln in rec_path.read_text().splitlines() if ln.strip()]
        records = [
            r for r in old if (r["model"], r["length"], r["cond"]) not in ran
        ] + records
    with rec_path.open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for model in sorted({r["model"] for r in records}):
        for length in sorted({r["length"] for r in records}):
            for cond in CONDITIONS:
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
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    for c in cells:
        print(
            f"{c['model']:<16} len {c['length']:<4} {c['condition']:<26} "
            f"n={c['n']:<4} EM {c['em']:.3f}  F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.4f}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
