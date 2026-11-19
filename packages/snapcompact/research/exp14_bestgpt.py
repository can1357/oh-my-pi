# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp14: best-of-round-1 combination for gpt-5.5.

Combines the validated levers from round 1:
  - 8x13 glyphs on a patch-aligned 8x16 cell (exp01: 8on16-sent .918@150)
  - two-column document layout (exp04: +F1 / -cost / -read-tax at 6x10)
  - per-model variant: gpt-5.5 prefers bw (exp10), sent is the runner-up

Conditions (gpt-5.5 only, 1568px):
  img-doc-8on16-bw    doc layout, near-black ink            (the combination)
  img-doc-8on16-sent  doc layout, sentence-hue glyphs       (variant probe)
  img-8on16-bw        plain grid, missing round-1 cell (8on16 ran only as sent)

Phased: screen all three at length 150, confirm the winner at 50/250,
optional effort=none probe at 50. Records merge across runs (cells keyed by
model/length/condition/effort are replaced when re-run, kept otherwise).

Usage:
  uv run exp14_bestgpt.py --render-only                     # capacity + sample PNGs
  uv run exp14_bestgpt.py                                   # screen @150 (default cells)
  uv run exp14_bestgpt.py --cells img-doc-8on16-bw@50,img-doc-8on16-bw@250
  uv run exp14_bestgpt.py --cells img-doc-8on16-bw@50 --effort none
  uv run exp14_bestgpt.py --report                          # re-aggregate, no API
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
from bdf import _DARK, FontCfg, capacity, ensure_font, parse_bdf, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

EXP = "exp14"
OUT_DIR = RESULTS / f"{EXP}-bestgpt"
MODEL = "gpt-5.5"
PRICE_IN, PRICE_OUT = 2.0, 16.0
FONT = FontCfg(
    "8on16", "8x13", 8, 16
)  # exp01 winner: 8x13 glyphs, 16px patch-aligned pitch
GUTTER = 3  # char cells between doc columns (as exp04)
SCREEN_CELLS = "img-doc-8on16-bw@150,img-doc-8on16-sent@150,img-8on16-bw@150"
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)
_INK = (24, 24, 24)  # exp04 body ink


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


# --- document layout (ported from exp04, parameterized for FONT) ------------


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
    when the article continues, since each page is read in isolation).
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
    sent_colors = _sentence_colors(lines) if variant == "sent" else None
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


def atomic_save(img: Image.Image, png: Path) -> None:
    tmp = png.with_suffix(".tmp.png")
    img.save(tmp)
    tmp.replace(png)


def qa_call(
    messages: list[dict],
    questions: list[dict],
    length: int,
    cond: str,
    start: int,
    ctx: dict,
) -> list[dict]:
    """One QA call + scoring; shared by doc and grid paths."""
    args, keys = ctx["args"], ctx["keys"]
    qa = cached(
        MODEL,
        f"{EXP}-qa",
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
                "length": length,
                "cond": cond,
                "effort": args.effort,
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


def run_doc_page(
    cond: str, length: int, page: tuple[int, int], ctx: dict
) -> list[dict]:
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
    png = CACHE / f"{EXP}-doc-{variant}-{page_key}.png"
    if not png.exists() or png.stat().st_size == 0:
        atomic_save(render_doc(lines, args.size, variant, CACHE), png)
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
    return qa_call(messages, questions, length, cond, start, ctx)


def run_grid_chunk(
    cond: str, length: int, start: int, end: int, ctx: dict
) -> list[dict]:
    args, flow, paras, offsets = ctx["args"], ctx["flow"], ctx["paras"], ctx["offsets"]
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    chunk_text = flow[start:end]
    variant = cond.removeprefix("img-8on16-")
    png = CACHE / f"{EXP}-8on16-{variant}-{sha8(chunk_text, str(args.size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        atomic_save(render(chunk_text, FONT, CACHE, args.size, variant), png)
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
    return qa_call(messages, questions, length, cond, start, ctx)


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


def cell_label(cond: str, effort: str | None) -> str:
    return f"{cond}+eff-{effort}" if effort else cond


def write_outputs(
    records: list[dict], capacity_stats: dict, args_dict: dict
) -> list[dict]:
    with (OUT_DIR / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    cell_keys = sorted(
        {(r["length"], r["cond"], r.get("effort")) for r in records},
        key=lambda k: (k[0], k[1], k[2] or ""),
    )
    cells = []
    for length, cond, effort in cell_keys:
        sub = [
            r
            for r in records
            if r["length"] == length and r["cond"] == cond and r.get("effort") == effort
        ]
        cells.append(
            {
                "model": MODEL,
                "length": length,
                "condition": cell_label(cond, effort),
                **aggregate(sub),
            }
        )
    (OUT_DIR / "summary.json").write_text(
        json.dumps(
            {"args": args_dict, "capacity": capacity_stats, "cells": cells}, indent=1
        )
    )
    with (OUT_DIR / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)
    return cells


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", default=SCREEN_CELLS, help="comma list of cond@length")
    ap.add_argument("--qpc", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--effort", default=None)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    ap.add_argument(
        "--report", action="store_true", help="re-aggregate existing records, no API"
    )
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cols, rows, grid_cap = capacity(FONT, args.size)
    col_w = (cols - GUTTER) // 2
    max_lines = 2 * rows
    print(
        f"8on16 @ {args.size}px: grid {cols}x{rows} = {grid_cap} chars; "
        f"doc 2 x {col_w} cols + gutter {GUTTER}, {max_lines} line slots"
    )

    rec_path = OUT_DIR / "records.jsonl"
    existing: list[dict] = []
    if rec_path.exists():
        existing = [
            json.loads(ln) for ln in rec_path.read_text().splitlines() if ln.strip()
        ]
    cap_path = OUT_DIR / "capacity.json"
    capacity_stats: dict = json.loads(cap_path.read_text()) if cap_path.exists() else {}

    if args.report:
        cells = write_outputs(existing, capacity_stats, vars(args))
        for c in cells:
            print(
                f"len {c['length']:<4} {c['condition']:<28} n={c['n']:<4} EM {c['em']:.3f}  "
                f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}  "
                f"out={c['tok_out']} rsn={c['tok_reasoning']}"
            )
        return

    cell_specs = []
    for spec in args.cells.split(","):
        spec = spec.strip()
        if not spec:
            continue
        cond, _, ln = spec.partition("@")
        cell_specs.append((cond, int(ln)))
    lengths = sorted({ln for _, ln in cell_specs})

    keys = {}
    if not args.render_only:
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        pages = pack_pages(paras, col_w, max_lines)
        page_lines = {pg: layout_page(paras[pg[0] : pg[1]], col_w) for pg in pages}
        page_chars = [
            offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i] for i, j in pages
        ]
        capacity_stats[str(length)] = {
            "doc_pages": len(pages),
            "mean_chars_page": round(sum(page_chars) / len(pages)),
            "min_chars_page": min(page_chars),
            "max_chars_page": max(page_chars),
            "grid_chars_page": grid_cap,
            "corpus_chars": len(flow),
            "grid_pages": -(-len(flow) // grid_cap),
        }
        st = capacity_stats[str(length)]
        print(
            f"  len {length}: {st['doc_pages']} doc pages (mean {st['mean_chars_page']} chars, "
            f"{round(100 * st['mean_chars_page'] / grid_cap)}% of grid {grid_cap}); "
            f"grid {st['grid_pages']} pages; corpus {st['corpus_chars']}"
        )
        ctx = {
            "args": args,
            "paras": paras,
            "flow": flow,
            "offsets": offsets,
            "keys": keys,
            "lines": page_lines,
        }
        for cond, ln in cell_specs:
            if ln != length:
                continue
            if cond.startswith("img-doc-"):
                for pg in pages:
                    tasks.append(("doc", cond, length, pg, ctx))
            else:
                for start in range(0, len(flow), grid_cap):
                    tasks.append(
                        (
                            "grid",
                            cond,
                            length,
                            (start, min(start + grid_cap, len(flow))),
                            ctx,
                        )
                    )

    cap_path.write_text(json.dumps(capacity_stats, indent=1))

    if args.render_only:
        for kind, cond, length, unit, ctx in tasks:
            if unit[0] != 0 and (kind == "grid" or unit != list(ctx["lines"])[0]):
                continue
            if kind == "doc":
                variant = cond.removeprefix("img-doc-8on16-")
                i, j = unit
                key = sha8(
                    cond,
                    json.dumps([(p["title"], p["ctx"]) for p in ctx["paras"][i:j]]),
                    str(args.size),
                )
                png = CACHE / f"{EXP}-doc-{variant}-{key}.png"
                atomic_save(
                    render_doc(ctx["lines"][unit], args.size, variant, CACHE), png
                )
            else:
                variant = cond.removeprefix("img-8on16-")
                chunk_text = ctx["flow"][unit[0] : unit[1]]
                png = (
                    CACHE
                    / f"{EXP}-8on16-{variant}-{sha8(chunk_text, str(args.size))}.png"
                )
                atomic_save(render(chunk_text, FONT, CACHE, args.size, variant), png)
            print(f"  sample: {png}")
        return

    print(f"{len(tasks)} page/chunk tasks")
    new_records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = []
        for kind, cond, length, unit, ctx in tasks:
            if kind == "doc":
                futures.append(pool.submit(run_doc_page, cond, length, unit, ctx))
            else:
                futures.append(
                    pool.submit(run_grid_chunk, cond, length, unit[0], unit[1], ctx)
                )
        for fut in futures:
            new_records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)}", flush=True)

    # merge: drop existing records for cells just re-run, keep everything else
    rerun = {(ln, cond, args.effort) for cond, ln in cell_specs}
    kept = [
        r for r in existing if (r["length"], r["cond"], r.get("effort")) not in rerun
    ]
    records = kept + new_records

    cells = write_outputs(records, capacity_stats, vars(args))
    for c in cells:
        print(
            f"len {c['length']:<4} {c['condition']:<28} n={c['n']:<4} EM {c['em']:.3f}  "
            f"F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}  "
            f"out={c['tok_out']} rsn={c['tok_reasoning']}"
        )
    print(f"\n-> {OUT_DIR}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
