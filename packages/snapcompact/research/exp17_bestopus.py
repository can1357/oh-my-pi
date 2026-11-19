# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp17: claude-opus-4-8 model-owner run — do round-1 levers transfer to Anthropic?

Round-1 (gpt-5.5/gemini) validated: (1) patch-aligned pitch 16 (8x13 glyphs on
an 8x16 cell), (2) two-column document layout, (3) per-model variant. Opus's
round-0 winner is img-8x13-bw; opus emits ~0 reasoning tokens on image QA so
any win here must come from F1, not output-token savings.

Conditions (variant anchor = bw):
  img-8on16-bw      grid, 8x13 glyphs on 16 px pitch (alignment only)
  img-doc-8on16-bw  two-column doc layout at 8on16 (alignment + layout)
  img-doc-8x13-bw   two-column doc layout at 8x13 (layout only)

Protocol: screen all three at length 150; only the winner goes to 50/250.
Records accumulate across invocations (re-run cells replace their old rows),
so the final matrix.csv holds the union of screen + confirm runs.

Usage: uv run exp17_bestopus.py --render-only          # capacity + sample PNGs
       uv run exp17_bestopus.py                        # screen @150
       uv run exp17_bestopus.py --conditions img-X --lengths 50,250   # confirm
       uv run exp17_bestopus.py --report               # reprint from cache
"""

import argparse
import csv
import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import FontCfg, capacity, ensure_font, parse_bdf, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODEL = "claude-opus-4-8"
PRICES = (15.0, 75.0)  # $/M in, $/M out
FONTS = {
    "8x13": FontCfg("8x13", "8x13", 8, 13),  # round-0 opus winner font
    "8on16": FontCfg("8on16", "8x13", 8, 16),  # same glyphs, patch-aligned 16 px pitch
}
CONDITIONS = ("img-8on16-bw", "img-doc-8on16-bw", "img-doc-8x13-bw")
LENGTHS = (150,)  # screening default; confirm via --lengths 50,250
GUTTER = 3  # char cells between doc columns
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_INK = (24, 24, 24)  # near-black body text, like a printed page

# claude-opus-4-8 baselines, results/optimal-combined/matrix.csv (qpc 30, seed 42):
BASELINE = {
    50: (0.9626, 0.0258, 0.143),
    150: (0.8937, 0.0223, 0.380),
    250: (0.8708, 0.0196, 0.559),
}
TEXT_CEIL = {50: (0.9278, 0.195), 150: (0.9112, 0.637), 250: (0.9268, 0.938)}


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


def parse_cond(name: str) -> tuple[str, FontCfg]:
    """'img-8on16-bw' -> ('grid', cfg); 'img-doc-8on16-bw' -> ('doc', cfg)."""
    parts = name.split("-")
    if parts[1] == "doc":
        return "doc", FONTS[parts[2]]
    return "grid", FONTS[parts[1]]


# --- document layout (ported from exp04_layout.py, parameterized font) ------


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

    Headings repeat at the top of a page when an article continues, since
    each page is read in isolation.
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


def render_doc(lines: list[dict], cfg: FontCfg, size: int) -> Image.Image:
    """Two-column bw page: left column rows top-to-bottom, then right column."""
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, CACHE))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, _ = capacity(cfg, size)
    col_w = (cols - GUTTER) // 2
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
            fg = _BLACK if ln["kind"] == "heading" else _INK
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


def render_unit_png(cond: str, unit: tuple[int, int], ctx: dict) -> Path:
    """Render (or reuse) the PNG for one chunk/page; atomic tmp-then-replace."""
    args, paras = ctx["args"], ctx["paras"]
    kind, cfg = parse_cond(cond)
    if kind == "grid":
        start, end = unit
        chunk_text = ctx["flow"][start:end]
        png = CACHE / f"exp17-{cond}-{sha8(chunk_text, str(args.size))}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp.png")
            render(chunk_text, cfg, CACHE, args.size, "bw").save(tmp)
            tmp.replace(png)
    else:
        i, j = unit
        key = sha8(
            cond,
            json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]),
            str(args.size),
        )
        png = CACHE / f"exp17-{cond}-{key}.png"
        if not png.exists() or png.stat().st_size == 0:
            tmp = png.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp.png")
            render_doc(ctx["lines"][(cond, unit)], cfg, args.size).save(tmp)
            tmp.replace(png)
    return png


def run_unit(cond: str, unit: tuple[int, int], ctx: dict) -> list[dict]:
    """One (condition, chunk-or-page) cell unit: render carrier, QA, score."""
    args, paras, offsets, keys = ctx["args"], ctx["paras"], ctx["offsets"], ctx["keys"]
    kind, cfg = parse_cond(cond)
    if kind == "grid":
        start, end = unit
    else:
        i, j = unit
        start = offsets[i]
        end = offsets[j - 1] + len(paras[j - 1]["ctx"])
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    png = render_unit_png(cond, unit, ctx)
    cols, rows, _ = capacity(cfg, args.size)
    if kind == "grid":
        preamble = load_prompt("qa-image.md").format(cols=cols, rows=rows)
    else:
        preamble = load_prompt("exp04-qa-image.md").format(
            col_w=(cols - GUTTER) // 2, rows=rows
        )
    messages = [
        {
            "role": "user",
            "content": [
                {"text": preamble},
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        MODEL,
        "exp17-qa",
        {"messages": messages, "effort": args.effort},
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
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--lengths", default=",".join(map(str, LENGTHS)))
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
        help="capacity stats + first-page PNGs, no API",
    )
    ap.add_argument(
        "--report",
        action="store_true",
        help="reprint matrix from accumulated records only",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp17-bestopus"
    out_dir.mkdir(parents=True, exist_ok=True)
    records_path = out_dir / "records.jsonl"

    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]

    all_paras = squad.load_paragraphs(CACHE)
    records: list[dict] = []

    if not args.report:
        keys = (
            {}
            if args.render_only
            else {"anthropic": load_env_key("ANTHROPIC_API_KEY", args.env)}
        )
        tasks = []
        capacity_stats = {}
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
                "lines": {},
            }
            for cond in conditions:
                kind, cfg = parse_cond(cond)
                cols, rows, grid_cap = capacity(cfg, args.size)
                if kind == "grid":
                    units = [
                        (s, min(s + grid_cap, len(flow)))
                        for s in range(0, len(flow), grid_cap)
                    ]
                    chars = [e - s for s, e in units]
                else:
                    col_w = (cols - GUTTER) // 2
                    pages = pack_pages(paras, col_w, 2 * rows)
                    for pg in pages:
                        ctx["lines"][(cond, pg)] = layout_page(
                            paras[pg[0] : pg[1]], col_w
                        )
                    units = pages
                    chars = [
                        offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i]
                        for i, j in pages
                    ]
                capacity_stats[f"{cond}@{length}"] = {
                    "pages": len(units),
                    "mean_chars_page": round(sum(chars) / len(units)),
                    "grid_chars_page": grid_cap,
                    "corpus_chars": len(flow),
                }
                tasks.extend((cond, u, ctx) for u in units)

        for k, st in capacity_stats.items():
            print(
                f"  {k}: {st['pages']} pages, mean {st['mean_chars_page']} chars/page "
                f"(grid cap {st['grid_chars_page']}; corpus {st['corpus_chars']})"
            )

        if args.render_only:
            seen = set()
            for cond, unit, ctx in tasks:
                if cond in seen:
                    continue
                seen.add(cond)
                print(f"  sample: {render_unit_png(cond, unit, ctx)}")
            return

        print(f"grid: {len(tasks)} unit tasks ({len(conditions)} conds x {lengths})")
        done = 0
        with ThreadPoolExecutor(args.workers) as pool:
            futures = [pool.submit(run_unit, c, u, ctx) for c, u, ctx in tasks]
            for fut in futures:
                records.extend(fut.result())
                done += 1
                print(f"  {done}/{len(tasks)} units", flush=True)

        # Merge: rows for cells just run replace any prior rows for those cells.
        ran_cells = {(length, cond) for length in lengths for cond in conditions}
        old = []
        if records_path.exists():
            with records_path.open() as fh:
                old = [json.loads(ln) for ln in fh if ln.strip()]
        records = [
            r for r in old if (r["length"], r["cond"]) not in ran_cells
        ] + records
        with records_path.open("w") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
    else:
        with records_path.open() as fh:
            records = [json.loads(ln) for ln in fh if ln.strip()]

    cells = []
    for length in sorted({r["length"] for r in records}):
        for cond in sorted({r["cond"] for r in records if r["length"] == length}):
            sub = [r for r in records if r["length"] == length and r["cond"] == cond]
            cells.append(
                {
                    "model": MODEL,
                    "length": length,
                    "condition": cond,
                    **aggregate(sub, *PRICES),
                }
            )
    (out_dir / "summary.json").write_text(
        json.dumps(
            {"args": vars(args), "baseline_img_8x13_bw": BASELINE, "cells": cells},
            indent=1,
        )
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    print(
        f"\n{'len':<5}{'condition':<22}{'n':>5}{'EM':>7}{'F1':>7}{'+-se':>7}{'$':>8}{'d/se vs 8x13-bw':>17}"
    )
    for c in cells:
        b_f1, b_se, b_cost = BASELINE[c["length"]]
        dse = (c["f1"] - b_f1) / ((c["f1_se"] ** 2 + b_se**2) ** 0.5 or 1)
        t_f1, _ = TEXT_CEIL[c["length"]]
        flag = "  > text ceiling" if c["f1"] > t_f1 else ""
        print(
            f"{c['length']:<5}{c['condition']:<22}{c['n']:>5}{c['em']:>7.3f}{c['f1']:>7.3f}"
            f"{c['f1_se']:>7.3f}{c['cost_usd']:>8.3f}{dse:>+17.2f}{flag}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
