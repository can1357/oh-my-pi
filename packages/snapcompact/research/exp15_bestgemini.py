# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp15: combined best optical profile for google/gemini-3.5-flash.

Combines the round-1 validated levers:
  - 8x13 glyphs on a patch-aligned 8x16 cell (exp01 `8on16`)
  - two-column document layout with headings (exp04), parameterized for font/pitch
  - gemini's winning variant `sent-dim` (exp10), plus `sent` runner-up

Phase A (screen @150): img-doc-8on16-sent-dim, img-doc-8on16-sent, and the
missing round-1 grid cell img-8on16-sent-dim.
Phase B (confirm): screening winner at lengths 50 and 250.

Bar (findings.md best known for gemini): .984@50 / .915@150 / .909@250.
Text ceiling: .989 / .898 / .918.
"""

import argparse
import csv
import json
import os
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
    _stopword_mask,
    FontCfg,
    capacity,
    parse_bdf,
    ensure_font,
    render,
)  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp15"
OUT_DIR = RESULTS / f"{EXP}-bestgemini"
MODEL = "google/gemini-3.5-flash"
PRICE = (0.6, 4.0)  # $/M in, out
FONT = FontCfg("8on16", "8x13", 8, 16)  # 8x13 glyphs, ViT-patch-aligned 16px pitch
GUTTER = 3  # char cells between doc columns (exp04)
SCREEN_CONDS = ("img-doc-8on16-sent-dim", "img-doc-8on16-sent", "img-8on16-sent-dim")
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)

# Best-known cells from local findings (for the printed delta column only).
BEST_KNOWN = {50: (0.984, 0.012), 150: (0.915, 0.019), 250: (0.909, 0.016)}
TEXT_CEILING = {50: 0.989, 150: 0.898, 250: 0.918}


def cached(model: str, payload: object, fn, fresh: bool) -> dict:
    """Disk-cache `fn() -> dict` keyed by (model, exp15-qa, payload). Truncations not cached."""
    key = sha8(model, f"{EXP}-qa", json.dumps(payload, sort_keys=True, default=str))
    path = QA_CACHE / f"{key}.json"
    if path.exists() and not fresh:
        hit = json.loads(path.read_text())
        if hit.get("stop") != "max_tokens":
            return hit
    out = fn()
    if out.get("stop") == "max_tokens":
        print(f"  WARN truncated, not cached: {model} {key}")
    else:
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(out))
        tmp.replace(path)
    return out


# --- document layout (ported from exp04, parameterized font) ----------------


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

    Headings repeat at the top of a page when an article continues, since
    each page is read in isolation."""
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


def _doc_colors(lines: list[dict], variant: str) -> list[list[tuple[int, int, int]]]:
    """Per-line per-char glyph colors: sentence hue cycle, optionally with the
    stopword dim mask composed on top (sent-dim = exp04 sent + bdf dim)."""
    joined = "\n".join(ln["text"] for ln in lines)
    sidx, idx = [], 0
    for i, ch in enumerate(joined):
        sidx.append(idx)
        if ch in ".!?" and i + 1 < len(joined) and joined[i + 1] in " \n":
            idx += 1
    dim = _stopword_mask(joined) if variant == "sent-dim" else None
    colors, pos = [], 0
    for ln in lines:
        n = len(ln["text"])
        colors.append(
            [
                _DIMMED
                if dim is not None and dim[pos + k]
                else _DARK[sidx[pos + k] % 6]
                for k in range(n)
            ]
        )
        pos += n + 1  # the joining newline
    return colors


def render_doc(lines: list[dict], size: int, variant: str, cache: Path) -> Image.Image:
    """Two-column page at FONT: left column top-to-bottom, then right column."""
    glyphs, font_ascent = parse_bdf(ensure_font(FONT, cache))
    ascent = FONT.ascent if FONT.ascent is not None else font_ascent
    cols, rows, _ = capacity(FONT, size)
    col_w = (cols - GUTTER) // 2
    colors = _doc_colors(lines, variant)
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
            fg = _BLACK if ln["kind"] == "heading" else colors[li][ci]
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


# --- runners -----------------------------------------------------------------


def _qa_call(
    model: str,
    messages: list[dict],
    questions: list[dict],
    ctx: dict,
    cond: str,
    start: int,
) -> list[dict]:
    args, keys = ctx["args"], ctx["keys"]
    qa = cached(
        model,
        {"messages": messages, "extra": None, "effort": args.effort},
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


def run_doc_page(model: str, cond: str, page: tuple[int, int], ctx: dict) -> list[dict]:
    args, paras, offsets = ctx["args"], ctx["paras"], ctx["offsets"]
    i, j = page
    start = offsets[i]
    end = offsets[j - 1] + len(paras[j - 1]["ctx"])
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    variant = cond.removeprefix("img-doc-8on16-")
    lines = ctx["lines"][page]
    page_key = sha8(
        cond, json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]), str(args.size)
    )
    png = CACHE / f"{EXP}-doc-8on16-{variant}-{page_key}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(f".{os.getpid()}.tmp.png")
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
    return _qa_call(model, messages, questions, ctx, cond, start)


def run_grid_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    args, flow, paras, offsets = ctx["args"], ctx["flow"], ctx["paras"], ctx["offsets"]
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    chunk_text = flow[start:end]
    variant = cond.removeprefix("img-8on16-")
    png = CACHE / f"{EXP}-grid-8on16-{variant}-{sha8(chunk_text, str(args.size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(f".{os.getpid()}.tmp.png")
        render(chunk_text, FONT, CACHE, args.size, variant).save(tmp)
        tmp.replace(png)
    cols, rows, _ = capacity(FONT, args.size)
    q_block = "\n".join(f"{k + 1}. {q['q']}" for k, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [
                {"text": load_prompt("qa-image.md").format(cols=cols, rows=rows)},
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    return _qa_call(model, messages, questions, ctx, cond, start)


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
        "calls": len(us),
        **{f"tok_{k}": v for k, v in tok.items()},
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
    }


class Runner:
    def __init__(self, args, keys):
        self.args = args
        self.keys = keys
        self.records: list[dict] = []
        self.done: set[tuple[int, str]] = set()
        self.ctxs: dict[int, dict] = {}
        self.all_paras = squad.load_paragraphs(CACHE)
        self.capacity_stats: dict = {}

    def ctx(self, length: int) -> dict:
        if length not in self.ctxs:
            paras = self.all_paras[:length]
            flow, offsets = squad.build_flow(paras)
            cols, rows, grid_cap = capacity(FONT, self.args.size)
            col_w = (cols - GUTTER) // 2
            pages = pack_pages(paras, col_w, 2 * rows)
            page_lines = {pg: layout_page(paras[pg[0] : pg[1]], col_w) for pg in pages}
            page_chars = [
                offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i] for i, j in pages
            ]
            self.capacity_stats[length] = {
                "doc_pages": len(pages),
                "doc_mean_chars_page": round(sum(page_chars) / len(pages)),
                "doc_chars_page": page_chars,
                "grid_chars_page": grid_cap,
                "corpus_chars": len(flow),
                "grid_pages": -(-len(flow) // grid_cap),
            }
            self.ctxs[length] = {
                "args": self.args,
                "flow": flow,
                "paras": paras,
                "offsets": offsets,
                "keys": self.keys,
                "length": length,
                "pages": pages,
                "lines": page_lines,
            }
        return self.ctxs[length]

    def run(self, cells: list[tuple[int, str]], label: str) -> None:
        cells = [c for c in cells if c not in self.done]
        self.done.update(cells)
        tasks = []
        for length, cond in cells:
            ctx = self.ctx(length)
            if cond.startswith("img-doc-"):
                for pg in ctx["pages"]:
                    tasks.append((run_doc_page, (MODEL, cond, pg, ctx)))
            else:
                grid_cap = capacity(FONT, self.args.size)[2]
                flow = ctx["flow"]
                for start in range(0, len(flow), grid_cap):
                    tasks.append(
                        (
                            run_grid_chunk,
                            (MODEL, cond, start, min(start + grid_cap, len(flow)), ctx),
                        )
                    )
        if not tasks:
            return
        print(f"[{label}] {len(cells)} cells -> {len(tasks)} page/chunk tasks")
        with ThreadPoolExecutor(self.args.workers) as pool:
            futures = [pool.submit(fn, *t) for fn, t in tasks]
            for k, fut in enumerate(futures):
                self.records.extend(fut.result())
                print(f"  {k + 1}/{len(tasks)}", flush=True)

    def cell(self, length: int, cond: str) -> dict | None:
        sub = [r for r in self.records if r["length"] == length and r["cond"] == cond]
        return (
            {
                "model": MODEL,
                "length": length,
                "condition": cond,
                **aggregate(sub, *PRICE),
            }
            if sub
            else None
        )

    def all_cells(self) -> list[dict]:
        keys = sorted({(r["length"], r["cond"]) for r in self.records})
        return [c for ln, cond in keys if (c := self.cell(ln, cond))]


def print_cells(cells: list[dict]) -> None:
    for c in cells:
        best, best_se = BEST_KNOWN.get(c["length"], (None, None))
        extra = ""
        if best is not None:
            comb = (c["f1_se"] ** 2 + best_se**2) ** 0.5
            d = c["f1"] - best
            extra = f"  vs best {best:.3f}: {d:+.3f} ({d / comb:+.1f}se)"
            if c["f1"] >= TEXT_CEILING[c["length"]] - 1e-9:
                extra += "  >= TEXT CEILING"
        print(
            f"  len {c['length']:<4} {c['condition']:<24} n={c['n']:<4} EM {c['em']:.3f}  "
            f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  out {c['tok_out']}  reas {c['tok_reasoning']}  "
            f"${c['cost_usd']:.3f}{extra}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument(
        "--screen-only", action="store_true", help="skip the 50/250 confirmation phase"
    )
    ap.add_argument(
        "--confirm-conds",
        default=None,
        help="comma list; default = screening F1 winner",
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    keys = {}
    if not args.render_only:
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    cols, rows, grid_cap = capacity(FONT, args.size)
    col_w = (cols - GUTTER) // 2
    print(
        f"font 8on16: {cols} cols x {rows} rows; grid cap {grid_cap}; doc 2 x {col_w} + gutter {GUTTER}, {2 * rows} line slots"
    )

    runner = Runner(args, keys)

    if args.render_only:
        ctx = runner.ctx(150)
        pg = ctx["pages"][0]
        for cond in SCREEN_CONDS:
            if cond.startswith("img-doc-"):
                variant = cond.removeprefix("img-doc-8on16-")
                key = sha8(
                    cond,
                    json.dumps(
                        [(p["title"], p["ctx"]) for p in ctx["paras"][pg[0] : pg[1]]]
                    ),
                    str(args.size),
                )
                png = CACHE / f"{EXP}-doc-8on16-{variant}-{key}.png"
                img = render_doc(ctx["lines"][pg], args.size, variant, CACHE)
            else:
                variant = cond.removeprefix("img-8on16-")
                chunk = ctx["flow"][:grid_cap]
                png = (
                    CACHE
                    / f"{EXP}-grid-8on16-{variant}-{sha8(chunk, str(args.size))}.png"
                )
                img = render(chunk, FONT, CACHE, args.size, variant)
            tmp = png.with_suffix(f".{os.getpid()}.tmp.png")
            img.save(tmp)
            tmp.replace(png)
            print(f"  sample: {png}")
        for length, st in runner.capacity_stats.items():
            print(
                f"  len {length}: {st['doc_pages']} doc pages, mean {st['doc_mean_chars_page']} chars/page "
                f"(grid {st['grid_chars_page']} -> {st['grid_pages']} pages)"
            )
        return

    # Phase A: screen at 150
    runner.run([(150, c) for c in SCREEN_CONDS], "screen@150")
    screen_cells = [c for c in runner.all_cells() if c["length"] == 150]
    print_cells(screen_cells)
    winner = max(screen_cells, key=lambda c: (c["f1"], -c["cost_usd"]))["condition"]
    print(f"screen winner: {winner}")

    # Phase B: confirm winner at 50 and 250
    if not args.screen_only:
        confirm = (
            [w.strip() for w in args.confirm_conds.split(",")]
            if args.confirm_conds
            else [winner]
        )
        runner.run([(ln, c) for ln in (50, 250) for c in confirm], "confirm@50/250")

    cells = runner.all_cells()
    with (OUT_DIR / "records.jsonl").open("w") as fh:
        for r in runner.records:
            fh.write(json.dumps(r) + "\n")
    (OUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "args": vars(args),
                "model": MODEL,
                "capacity": runner.capacity_stats,
                "screen_winner": winner,
                "cells": cells,
            },
            indent=1,
        )
    )
    with (OUT_DIR / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=[k for k in cells[0].keys() if k != "doc_chars_page"]
        )
        writer.writeheader()
        writer.writerows(cells)

    print_cells(cells)
    print(f"\n-> {OUT_DIR}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
