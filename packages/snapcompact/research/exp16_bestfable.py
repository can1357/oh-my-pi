# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp16: best optical profile for claude-fable-5.

Round-1 levers (patch-aligned pitch 16, document layout, per-model variant)
were validated on gpt-5.5/gemini only. Fable's known winner is img-6x12-dim
(smaller glyphs than the 8x13 the others prefer, plain dim variant). Test
whether the round-1 levers transfer:

  img-8on16-dim    8x13 glyphs on an 8x16 cell (pitch-16 alignment, big glyphs)
  img-6on7x14-dim  6x12 glyphs on a 7x14 cell (alignment, fable's glyph size)
  doc-6x12-dim     two-column newspaper layout at fable's winner font
  doc-8on16-dim    layout + alignment combined (run if either lever shows)

Screen at length 150, confirm the winner at 50/250. Baselines (do not re-run):
img-6x12-dim F1 .956/.911/.923 at $0.132/$0.437/$0.724; text ceiling
.956/.904/.920 at $0.144/$0.498/$0.734.

Usage: uv run exp16_bestfable.py --render-only          # sample PNGs + capacity
       uv run exp16_bestfable.py --lengths 150          # screen
       uv run exp16_bestfable.py --lengths 50,150,250 --conditions ...  # confirm
       (re-runs hit .cache/qa/, so the final full invocation rebuilds the
        combined records/matrix for free)
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
from bdf import (
    _DIMMED,
    _stopword_mask,
    FontCfg,
    capacity,
    ensure_font,
    parse_bdf,
    render,
)  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODEL = "claude-fable-5"
PRICE = (10.0, 50.0)  # $/M in, out
FONTS = {
    "8on16": FontCfg("8on16", "8x13", 8, 16),  # 8x13 glyphs, patch-aligned 16 px pitch
    "6on7x14": FontCfg(
        "6on7x14", "6x12", 7, 14
    ),  # 6x12 glyphs, 7x14 patch-aligned cell
    "6x12": FontCfg("6x12", "6x12", 6, 12),  # fable's round-0 winner font
}
CONDITIONS = ("img-8on16-dim", "img-6on7x14-dim", "doc-6x12-dim", "doc-8on16-dim")
LENGTHS = (150,)
GUTTER = 3  # char cells between doc columns
_WHITE = (255, 255, 255)
_BLACK = (0, 0, 0)

# img-6x12-dim per length: (f1, se, cost); text ceiling: (f1, se, cost).
BASE_IMG = {
    50: (0.9556, 0.0348, 0.132),
    150: (0.9113, 0.0244, 0.437),
    250: (0.9233, 0.0163, 0.724),
}
BASE_TEXT = {
    50: (0.9556, 0.0348, 0.144),
    150: (0.9043, 0.0216, 0.498),
    250: (0.9197, 0.0184, 0.734),
}


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


def parse_condition(name: str) -> tuple[str, str, str]:
    """'img-8on16-dim' -> (kind, font, variant)."""
    kind, font, variant = name.split("-", 2)
    return kind, font, variant


def atomic_save(img: Image.Image, png: Path) -> None:
    tmp = png.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp.png")
    img.save(tmp)
    tmp.replace(png)


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

    Article title changes become headings (repeated at the top of a page even
    when the article continues, since each page is read in isolation).
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


def _dim_masks(lines: list[dict]) -> list[list[bool]]:
    """Per-line stopword mask, computed over the joined page text."""
    joined = "\n".join(ln["text"] for ln in lines)
    mask = _stopword_mask(joined)
    out, pos = [], 0
    for ln in lines:
        n = len(ln["text"])
        out.append(mask[pos : pos + n])
        pos += n + 1  # the joining newline
    return out


def render_doc(lines: list[dict], cfg: FontCfg, size: int, cache: Path) -> Image.Image:
    """Two-column dim page: black content words, gray stopwords, double-strike headings."""
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, cache))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, _ = capacity(cfg, size)
    col_w = (cols - GUTTER) // 2
    masks = _dim_masks(lines)
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
            else:
                fg = _DIMMED if masks[li][ci] else _BLACK
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


# --- runners -----------------------------------------------------------------


def qa_call(cond: str, messages: list[dict], ctx: dict) -> dict:
    args, keys = ctx["args"], ctx["keys"]
    return cached(
        MODEL,
        f"exp16-qa-{cond}",
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


def score(
    questions: list[dict], qa: dict, cond: str, start: int, ctx: dict
) -> list[dict]:
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


def run_grid_chunk(cond: str, start: int, end: int, ctx: dict) -> list[dict]:
    """Row-major grid cell: chunk the flow by capacity, one QA call per chunk."""
    args, flow, paras, offsets = ctx["args"], ctx["flow"], ctx["paras"], ctx["offsets"]
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    chunk_text = flow[start:end]
    _, font, variant = parse_condition(cond)
    png = CACHE / f"exp16-{font}-{variant}-{sha8(chunk_text, str(args.size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        atomic_save(render(chunk_text, FONTS[font], CACHE, args.size, variant), png)
    cols, rows, _ = capacity(FONTS[font], args.size)
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
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
    return score(questions, qa_call(cond, messages, ctx), cond, start, ctx)


def run_doc_page(cond: str, page: tuple[int, int], ctx: dict) -> list[dict]:
    """Document cell: paragraph-aligned page, two-column dim render."""
    args, paras, offsets = ctx["args"], ctx["paras"], ctx["offsets"]
    i, j = page
    start = offsets[i]
    end = offsets[j - 1] + len(paras[j - 1]["ctx"])
    questions = squad.sample_chunk_questions(
        paras, offsets, start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    _, font, _ = parse_condition(cond)
    cfg = FONTS[font]
    lines = ctx["lines"][cond][page]
    page_key = sha8(
        cond, json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]), str(args.size)
    )
    png = CACHE / f"exp16-{cond}-{page_key}.png"
    if not png.exists() or png.stat().st_size == 0:
        atomic_save(render_doc(lines, cfg, args.size, CACHE), png)
    cols, rows, _ = capacity(cfg, args.size)
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
    return score(questions, qa_call(cond, messages, ctx), cond, start, ctx)


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
    out_dir = RESULTS / "exp16-bestfable"
    out_dir.mkdir(parents=True, exist_ok=True)

    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {}
    if not args.render_only:
        keys["anthropic"] = load_env_key("ANTHROPIC_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    capacity_stats: dict[str, dict] = {}
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        page_lines: dict[str, dict] = {}
        doc_pages: dict[str, list[tuple[int, int]]] = {}
        for cond in conditions:
            kind, font, _ = parse_condition(cond)
            cfg = FONTS[font]
            cols, rows, grid_cap = capacity(cfg, args.size)
            if kind == "doc":
                col_w = (cols - GUTTER) // 2
                pages = pack_pages(paras, col_w, 2 * rows)
                doc_pages[cond] = pages
                page_lines[cond] = {
                    pg: layout_page(paras[pg[0] : pg[1]], col_w) for pg in pages
                }
                page_chars = [
                    offsets[j - 1] + len(paras[j - 1]["ctx"]) - offsets[i]
                    for i, j in pages
                ]
                capacity_stats[f"{cond}@{length}"] = {
                    "pages": len(pages),
                    "mean_chars_page": round(sum(page_chars) / len(pages)),
                    "grid_chars_page": grid_cap,
                    "corpus_chars": len(flow),
                }
            else:
                capacity_stats[f"{cond}@{length}"] = {
                    "pages": -(-len(flow) // grid_cap),
                    "mean_chars_page": grid_cap,
                    "grid_chars_page": grid_cap,
                    "corpus_chars": len(flow),
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
        for cond in conditions:
            kind, font, _ = parse_condition(cond)
            if kind == "doc":
                for pg in doc_pages[cond]:
                    tasks.append(("doc", cond, pg, ctx))
            else:
                budget = capacity(FONTS[font], args.size)[2]
                for start in range(0, len(flow), budget):
                    tasks.append(
                        ("img", cond, (start, min(start + budget, len(flow))), ctx)
                    )

    for key, st in sorted(capacity_stats.items()):
        print(
            f"  {key}: {st['pages']} pages, mean {st['mean_chars_page']} chars/page "
            f"(grid cap {st['grid_chars_page']}; corpus {st['corpus_chars']})"
        )

    if args.render_only:
        for length in lengths:
            paras = all_paras[:length]
            for cond in conditions:
                kind, font, _ = parse_condition(cond)
                cfg = FONTS[font]
                if kind == "doc":
                    cols, rows, _ = capacity(cfg, args.size)
                    col_w = (cols - GUTTER) // 2
                    i, j = pack_pages(paras, col_w, 2 * rows)[0]
                    lines = layout_page(paras[i:j], col_w)
                    key = sha8(
                        cond,
                        json.dumps([(p["title"], p["ctx"]) for p in paras[i:j]]),
                        str(args.size),
                    )
                    png = CACHE / f"exp16-{cond}-{key}.png"
                    atomic_save(render_doc(lines, cfg, args.size, CACHE), png)
                else:
                    flow, _ = squad.build_flow(paras)
                    cap = capacity(cfg, args.size)[2]
                    chunk_text = flow[:cap]
                    _, _, variant = parse_condition(cond)
                    png = (
                        CACHE
                        / f"exp16-{font}-{variant}-{sha8(chunk_text, str(args.size))}.png"
                    )
                    atomic_save(render(chunk_text, cfg, CACHE, args.size, variant), png)
                print(f"  sample: {png}")
        return

    print(f"grid: {len(tasks)} tasks")
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_doc_page, cond, span, ctx)
            if kind == "doc"
            else pool.submit(run_grid_chunk, cond, span[0], span[1], ctx)
            for kind, cond, span, ctx in tasks
        ]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} tasks", flush=True)

    with (out_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    cells = []
    for length in lengths:
        for cond in conditions:
            sub = [r for r in records if r["length"] == length and r["cond"] == cond]
            if not sub:
                continue
            cells.append(
                {
                    "model": MODEL,
                    "length": length,
                    "condition": cond,
                    **aggregate(sub, *PRICE),
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
        bi, bt = BASE_IMG.get(c["length"]), BASE_TEXT.get(c["length"])
        comb_se = (c["f1_se"] ** 2 + bi[1] ** 2) ** 0.5 if bi else 0.0
        d_img = (
            f"vs 6x12-dim {c['f1'] - bi[0]:+.3f} ({(c['f1'] - bi[0]) / comb_se:+.1f}se)"
            if bi
            else ""
        )
        d_txt = f" vs text {c['f1'] - bt[0]:+.3f}" if bt else ""
        flag = "  ** beats text ceiling" if bt and c["f1"] > bt[0] else ""
        print(
            f"{MODEL} len {c['length']:<4} {c['condition']:<18} n={c['n']:<4} "
            f"EM {c['em']:.3f}  F1 {c['f1']:.3f} ±{c['f1_se']:.3f}  ${c['cost_usd']:.3f}  "
            f"{d_img}{d_txt}{flag}"
        )
    print(f"\n-> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
