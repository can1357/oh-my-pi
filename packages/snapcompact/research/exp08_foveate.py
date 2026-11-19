# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp08: foveated two-tier reading — aggressive 5x8 archive + on-demand zoom.

Turn 1: a 5x8 (313 cols x 196 rows = 61348 chars/page, 1.5x denser than the
6x10 winner) archive image + all questions; the model answers what it can and
replies `ZOOM rows A-B` where the region is too small. Turn 2: the union of
requested row bands is sliced from the chunk text (row r covers chars
[(r-1)*cols, r*cols)) and re-rendered at a comfortable 8x13 font as zoom
image(s); the conversation continues with the zoom images + the pending
questions. Answers are merged; F1/cost vs the img-6x10-sent baseline.

Run from the snapcompact dir:  uv run exp08_foveate.py
"""

import argparse
import csv
import json
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, render  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODELS = {
    "gpt-5.5": (2.0, 16.0),
    "google/gemini-3.5-flash": (0.6, 4.0),
}
LENGTHS = (50, 150)
CONDITIONS = ("fov-5x8-bw", "fov-5x8-sent")
ARCHIVE_FONT = "5x8"
ZOOM_FONT = "8x13"
ZOOM_SIZES = (520, 784, 1040, 1568)  # smallest square that fits the band wins
# fov  = conservative prompt (zoom only when too small), rows addressing, tight pad
# fov2 = eager prompt (zoom unless fully certain), rows addressing, wide pad
# fov3 = eager prompt, phrase addressing (model quotes partially-read anchor words;
#        harness fuzzy-locates them in the chunk and zooms that row band)
PROTO = {
    "fov": ("exp08-archive.md", 2, "rows"),
    "fov2": ("exp08-archive-eager.md", 12, "rows"),
    "fov3": ("exp08-archive-phrase.md", 12, "phrase"),
}

# img-6x10-sent baseline (results/optimal-gpt55 + optimal-gemini): f1, se, cost$
BASELINE = {
    ("gpt-5.5", 50): (0.850, 0.0508, 0.068),
    ("gpt-5.5", 150): (0.8218, 0.0290, 0.2452),
    ("google/gemini-3.5-flash", 50): (0.9841, 0.0119, 0.0181),
    ("google/gemini-3.5-flash", 150): (0.8046, 0.0349, 0.097),
}

_ZOOM_RANGE = re.compile(r"(?i)\bzoom\b[^\d]*(\d+)\s*(?:[-\u2013\u2014]|to\b)\s*(\d+)")
_ZOOM_SINGLE = re.compile(r"(?i)\bzoom\b[^\d]*(\d+)")
_ZOOM_PHRASE = re.compile(r"(?i)\bzoom\b\s*[\"\u201c']+(.+?)[\"\u201d']*\s*$")


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


def atomic_png(img, path: Path) -> None:
    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.tmp.png")
    img.save(tmp)
    tmp.replace(path)


def parse_zoom(answer: str) -> tuple[int, int] | None:
    """`ZOOM rows A-B` (or single row) -> (A, B); None if not a zoom request."""
    m = _ZOOM_RANGE.search(answer)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return (a, b) if a <= b else (b, a)
    m = _ZOOM_SINGLE.search(answer)
    if m:
        r = int(m.group(1))
        return (r, r)
    return None


def locate_phrase(chunk: str, phrase: str) -> tuple[int, int] | None:
    """Best-effort char span of a (possibly misread) anchor phrase in the chunk."""
    lower = re.sub(r"[^a-z0-9]", " ", chunk.lower())  # length-preserving normalize
    p = re.sub(r"[^a-z0-9]", " ", phrase.lower()).split()
    if not p:
        return None
    exact = " ".join(p)
    i = lower.find(exact)
    if i >= 0:
        return i, i + len(exact)
    words = [(m.start(), m.group()) for m in re.finditer(r"\S+", lower)]
    pset = set(p)
    k = max(2 * len(p), 8)
    best_score, best_pos = 0, None
    for s in range(len(words)):
        score = sum(1 for _, w in words[s : s + k] if w in pset)
        if score > best_score:
            best_score, best_pos = score, words[s][0]
    if best_pos is not None and best_score >= max(2, (len(p) + 1) // 2):
        return best_pos, best_pos + len(exact)
    return None


def merge_bands(
    bands: list[tuple[int, int]], max_row: int, pad: int
) -> list[tuple[int, int]]:
    """Pad by `pad`, clamp to [1, max_row], merge overlapping/adjacent bands."""
    padded = sorted((max(1, a - pad), min(max_row, b + pad)) for a, b in bands)
    merged: list[tuple[int, int]] = []
    for a, b in padded:
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def zoom_renders(
    chunk_text: str, bands: list[tuple[int, int]], arch_cols: int
) -> list[tuple[tuple[int, int], Path]]:
    """Slice each band's rows from the chunk and render at ZOOM_FONT; oversized bands split."""
    zcfg = FONTS[ZOOM_FONT]
    max_rows = (
        capacity(zcfg, ZOOM_SIZES[-1])[2] // arch_cols
    )  # archive rows per zoom page
    out = []
    for a, b in bands:
        pieces = [(s, min(s + max_rows - 1, b)) for s in range(a, b + 1, max_rows)]
        for pa, pb in pieces:
            txt = chunk_text[(pa - 1) * arch_cols : pb * arch_cols]
            if not txt.strip():
                continue
            size = next(
                (s for s in ZOOM_SIZES if capacity(zcfg, s)[2] >= len(txt)),
                ZOOM_SIZES[-1],
            )
            png = CACHE / f"exp08-zoom-{ZOOM_FONT}-{size}-{sha8(txt)}.png"
            if not png.exists() or png.stat().st_size == 0:
                atomic_png(render(txt, zcfg, CACHE, size, "bw"), png)
            out.append(((pa, pb), png))
    return out


def run_cell_chunk(
    model: str, cond: str, start: int, end: int, ctx: dict
) -> list[dict]:
    """One (model, condition, chunk): archive QA turn, optional zoom turn, merge, score."""
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
    chunk_text = flow[start:end]
    proto, _, variant = cond.split("-", 2)
    prompt_file, pad, mode = PROTO[proto]
    cfg = FONTS[ARCHIVE_FONT]
    cols, rows, _ = capacity(cfg, args.size)

    png = (
        CACHE
        / f"exp08-arch-{ARCHIVE_FONT}-{variant}-{sha8(chunk_text, str(args.size))}.png"
    )
    if not png.exists() or png.stat().st_size == 0:
        atomic_png(render(chunk_text, cfg, CACHE, args.size, variant), png)

    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
    messages = [
        {
            "role": "user",
            "content": [
                {"text": load_prompt(prompt_file).format(cols=cols, rows=rows)},
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa1 = cached(
        model,
        "exp08-qa1",
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
    usage_rows = [("qa1", qa1["usage"])]
    answers1 = squad.parse_numbered(qa1["text"], len(questions))
    zoom_req: list[tuple[int, int] | None] = []
    anchors: list[str | None] = []
    for a in answers1:
        anchor = None
        if mode == "phrase":
            m = _ZOOM_PHRASE.search(a)
            text = m.group(1) if m else None
            if text is None and re.search(r"(?i)\bzoom\b", a) and not parse_zoom(a):
                text = re.sub(r"(?i)^.*?\bzoom\b[:\s]*", "", a).strip(
                    "\"'\u201c\u201d "
                )
            if text and len(text.split()) >= 2:
                anchor = text
                span = locate_phrase(chunk_text, anchor)
                zoom_req.append(
                    (span[0] // cols + 1, span[1] // cols + 1) if span else None
                )
            elif re.search(r"(?i)\bzoom\b", a):
                zoom_req.append(parse_zoom(a))  # rows fallback
            else:
                zoom_req.append(None)
        else:
            zoom_req.append(parse_zoom(a))
        anchors.append(anchor)
    requested = [i for i, a in enumerate(answers1) if re.search(r"(?i)\bzoom\b", a)]
    pending = [i for i, z in enumerate(zoom_req) if z is not None]
    final = list(answers1)
    for i in requested:
        if zoom_req[i] is None:
            final[i] = "UNREADABLE"  # zoom requested but band unresolvable

    if pending:
        bands = merge_bands([zoom_req[i] for i in pending], rows, pad)
        zooms = zoom_renders(chunk_text, bands, cols)
        z_content: list[dict] = [{"text": load_prompt("exp08-zoom.md")}]
        for (a, b), zpng in zooms:
            z_content.append({"text": f"Zoom of archive rows {a}-{b}:"})
            z_content.append({"image_path": zpng})
        z_content.append(
            {"text": "\n".join(f"{i + 1}. {questions[i]['q']}" for i in pending)}
        )
        messages2 = messages + [
            {"role": "assistant", "content": [{"text": qa1["text"]}]},
            {"role": "user", "content": z_content},
        ]
        qa2 = cached(
            model,
            "exp08-qa2",
            {"messages": messages2, "effort": args.effort},
            lambda: dict(
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(
                        keys,
                        model,
                        messages2,
                        max_tokens=args.max_tokens,
                        effort=args.effort,
                    ),
                )
            ),
            args.fresh,
        )
        usage_rows.append(("qa2", qa2["usage"]))
        answers2 = squad.parse_numbered(qa2["text"], len(questions))
        for i in pending:
            final[i] = answers2[i] or "UNREADABLE"

    records = []
    for i, (q, a) in enumerate(zip(questions, final)):
        records.append(
            {
                "model": model,
                "length": ctx["length"],
                "cond": cond,
                "chunk": start,
                "pos_rel": q["pos_rel"],
                "q": q["q"],
                "answer": a,
                "answer_turn1": answers1[i],
                "zoomed": i in requested,
                "zoom_band": list(zoom_req[i]) if zoom_req[i] else None,
                "anchor": anchors[i],
                "golds": q["golds"],
                "em": squad.exact_match(a, q["golds"]),
                "f1": squad.f1(a, q["golds"]),
                "abstained": "unreadable" in a.lower(),
            }
        )
    records[0]["usage"] = [{"phase": p, **u} for p, u in usage_rows]
    return records


def _phase_cost(us: list[dict], price_in: float, price_out: float) -> float:
    tok = {k: sum(u.get(k, 0) for u in us) for k in ("in", "out", "cache_w", "cache_r")}
    return (
        tok["in"] + 1.25 * tok["cache_w"] + 0.1 * tok["cache_r"]
    ) / 1e6 * price_in + tok["out"] / 1e6 * price_out


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
    zoomed = sum(r["zoomed"] for r in records)
    zoom_chunks = sum(
        1
        for r in records
        if "usage" in r and any(u["phase"] == "qa2" for u in r["usage"])
    )
    return {
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        "zoom_q": zoomed,
        "zoom_rate": round(zoomed / n, 4),
        "no_zoom_pct": round(100 * (n - zoomed) / n, 1),
        "zoom_chunks": zoom_chunks,
        **{f"tok_{k}": v for k, v in tok.items()},
        "cost_in_usd": round(cost_in, 4),
        "cost_out_usd": round(cost_out, 4),
        "cost_usd": round(cost_in + cost_out, 4),
        "cost_zoom_usd": round(
            _phase_cost([u for u in us if u["phase"] == "qa2"], price_in, price_out), 4
        ),
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
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--out", default="exp08-foveate")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }

    budget = capacity(FONTS[ARCHIVE_FONT], args.size)[2]
    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
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
        for model in models:
            for cond in conditions:
                for start in range(0, len(flow), budget):
                    tasks.append(
                        (model, cond, start, min(start + budget, len(flow)), ctx)
                    )
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x {len(conditions)} conditions = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell_chunk, m, c, s, e, ctx) for m, c, s, e, ctx in tasks
        ]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            print(f"  {done}/{len(tasks)} tasks", flush=True)

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
                cell = {
                    "model": model,
                    "length": length,
                    "condition": cond,
                    **aggregate(sub, *MODELS[model]),
                }
                base = BASELINE.get((model, length))
                if base:
                    cell["base_f1"] = base[0]
                    cell["base_cost_usd"] = base[2]
                    cell["d_f1"] = round(cell["f1"] - base[0], 4)
                    cell["d_cost_usd"] = round(cell["cost_usd"] - base[2], 4)
                cells.append(cell)
    (out_dir / "summary.json").write_text(
        json.dumps({"args": vars(args), "cells": cells}, indent=1)
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    for c in cells:
        print(
            f"{c['model']:>26} L{c['length']:<4}{c['condition']:<14} n={c['n']:<4} f1={c['f1']:.3f}±{c['f1_se']:.3f} "
            f"zoom={c['zoom_rate']:.0%} ${c['cost_usd']:.3f} (zoom ${c['cost_zoom_usd']:.3f}) "
            f"vs base f1={c.get('base_f1', float('nan')):.3f} ${c.get('base_cost_usd', float('nan')):.3f}"
        )
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
