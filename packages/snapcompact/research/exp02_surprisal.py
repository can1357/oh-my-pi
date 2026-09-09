# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "wordfreq"]
# ///
"""exp02: surprisal-weighted glyph contrast + stopword-removal/disemvowel density.

Conditions (all 6x10 font, 1568px, vs baseline img-6x10-sent):
  img-6x10-surp       full text; glyph gray level = unigram surprisal bucket
                      (wordfreq zipf: ultra-common -> light gray, rare -> black)
  img-6x10-sent-surp  sentence hues; lightness scaled by surprisal bucket
  img-6x10-disemv     stopwords dropped + lowercase non-entity words disemvoweled,
                      rendered with plain `sent` hues; chunks sized by *transformed*
                      capacity so each page carries more original chars (fewer pages)

Usage: uv run exp02_surprisal.py [--report] [--fresh]
Keys:  OPENAI_API_KEY + OPENROUTER_API_KEY from ~/.env.
"""

import argparse
import colorsys
import csv
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import _sentence_indices, capacity, ensure_font, parse_bdf, render  # noqa: E402
from PIL import Image  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402
from wordfreq import zipf_frequency  # noqa: E402

MODELS = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
LENGTHS = (50, 150)
CONDITIONS = ("img-6x10-surp", "img-6x10-sent-surp", "img-6x10-disemv")
FONT = FONTS["6x10"]

# Baseline cells from results/optimal-*/matrix.csv (img-6x10-sent): F1, se, cost$.
BASELINE = {
    ("gpt-5.5", 50): (0.850, 0.051, 0.068),
    ("gpt-5.5", 150): (0.822, 0.029, 0.245),
    ("google/gemini-3.5-flash", 50): (0.984, 0.012, 0.018),
    ("google/gemini-3.5-flash", 150): (0.805, 0.035, 0.097),
}

SURP_NOTE = (
    "Glyph darkness encodes word informativeness: very common words are printed in lighter gray, "
    "rarer / more informative words in darker ink. All words are spelled out in full."
)
DISEMV_NOTE = (
    "To fit more text, very common function words (the, of, and, is, ...) were removed, and other "
    'common lowercase words are abbreviated by stripping their interior vowels (e.g. "qck brwn fx jmpd" '
    'means "quick brown fox jumped"; "gvrnmnt" means "government"). Proper nouns, capitalized words, '
    "numbers, dates, and words adjacent to numbers are kept verbatim. Mentally reconstruct the original "
    "wording; ALWAYS write your answers in normal, fully spelled English."
)

# --- text transform: stopword drop + disemvowel ------------------------------

# bdf._STOPWORDS minus "not" (removal flips meaning; dimming it was harmless).
_STOP = frozenset(
    "the a an and or of to in on at as is are was were be been by for with that this it its from had has have but "
    "he she his her they their them which also who whom when where while will would could should there then than "
    "into over under about after before between during each such these those some most more other only same so".split()
)
# Spelled-out numbers/ordinals/units stay verbatim: golds are full of them.
_NUMWORDS = frozenset(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million "
    "billion trillion first second third fourth fifth sixth seventh eighth ninth tenth half quarter percent".split()
)
_VOWELS = frozenset("aeiou")
_TOKEN_RE = re.compile(r"([^A-Za-z]*)([a-z]+)([^A-Za-z]*)")
_WORD_RE = re.compile(r"[A-Za-z]+")


def _has_digit(s: str) -> bool:
    return any(c.isdigit() for c in s)


def _disemvowel(w: str) -> str:
    if len(w) <= 2:
        return w
    return w[0] + "".join(c for c in w[1:-1] if c not in _VOWELS) + w[-1]


def transform(text: str) -> str:
    """Drop lowercase stopwords, disemvowel other lowercase words.

    Never touches: capitalized words, tokens containing digits or apostrophes,
    tokens adjacent to a digit-bearing token, spelled-out numbers/units.
    """
    toks = text.split()
    out: list[str] = []
    for i, tok in enumerate(toks):
        m = _TOKEN_RE.fullmatch(tok)
        if not m:  # uppercase, digits, apostrophes, hyphens-with-letters: verbatim
            out.append(tok)
            continue
        pre, core, suf = m.groups()
        if (
            _has_digit(pre)
            or _has_digit(suf)
            or (i > 0 and _has_digit(toks[i - 1]))
            or (i + 1 < len(toks) and _has_digit(toks[i + 1]))
            or core in _NUMWORDS
        ):
            out.append(tok)
            continue
        if core in _STOP:
            if pre + suf:  # keep punctuation of dropped words
                out.append(pre + suf)
            continue
        out.append(pre + _disemvowel(core) + suf)
    return " ".join(out)


# --- surprisal-weighted rendering --------------------------------------------

# 4 buckets, near-black (rare) .. light gray (ultra-common). Lightest matches
# the old _DIMMED (176) readability point.
_GRAYS = [(185, 185, 185), (135, 135, 135), (75, 75, 75), (0, 0, 0)]
_LIGHT = [0.72, 0.55, 0.40, 0.22]  # lightness per bucket for sent hues
_HUES = [0.0, 0.08, 0.3, 0.5, 0.62, 0.78]
_SENT_SURP = [
    [tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, l, 0.95)) for l in _LIGHT]
    for h in _HUES
]
_WHITE = (255, 255, 255)


@lru_cache(maxsize=65536)
def _zipf_bucket(word: str) -> int:
    """0 = ultra-common (lightest) .. 3 = rare/unknown (black)."""
    z = zipf_frequency(word, "en")
    if z >= 6.0:
        return 0
    if z >= 5.0:
        return 1
    if z >= 4.0:
        return 2
    return 3


def _shade_indices(text: str) -> list[int]:
    """Per-char surprisal bucket; non-letters (digits, punctuation) stay black."""
    out = [3] * len(text)
    for m in _WORD_RE.finditer(text):
        b = _zipf_bucket(m.group().lower())
        if b != 3:
            for k in range(m.start(), m.end()):
                out[k] = b
    return out


def render_surp(
    text: str, cfg, cache: Path, size: int = 1568, sent_hues: bool = False
) -> Image.Image:
    """bdf.render() with the boolean dim_mask generalized to surprisal buckets."""
    glyphs, font_ascent = parse_bdf(ensure_font(cfg, cache))
    ascent = cfg.ascent if cfg.ascent is not None else font_ascent
    cols, rows, cap = capacity(cfg, size)
    text = text[:cap]
    shades = _shade_indices(text)
    sent_idx = _sentence_indices(text) if sent_hues else None
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for row in range(rows):
        y0 = row * cfg.pitch
        for col in range(cols):
            i = row * cols + col
            if i >= len(text):
                break
            glyph = glyphs.get(ord(text[i]))
            if glyph is None:
                continue
            b = shades[i]
            fg = _SENT_SURP[sent_idx[i] % 6][b] if sent_idx is not None else _GRAYS[b]
            w, h, xoff, yoff = glyph["bbx"]
            top = y0 + ascent - h - yoff
            shift = 0x80 if w <= 8 else 0x8000
            for r, bits in enumerate(glyph["rows"]):
                y = top + r
                if not 0 <= y < size:
                    continue
                for bcol in range(w):
                    if bits & (shift >> bcol):
                        x = col * cfg.adv + xoff + bcol
                        if 0 <= x < size:
                            px[x, y] = fg
    return img


# --- chunk planning -----------------------------------------------------------


def plan_chunks(flow: str, cond: str, size: int) -> list[tuple[int, int]]:
    cap = capacity(FONT, size)[2]
    if cond != "img-6x10-disemv":
        return [(s, min(s + cap, len(flow))) for s in range(0, len(flow), cap)]
    # Greedy: max original span whose *transformed* text fits a page; word-snapped.
    chunks: list[tuple[int, int]] = []
    s, n = 0, len(flow)
    while s < n:
        if len(transform(flow[s:n])) <= cap:
            chunks.append((s, n))
            break
        lo, hi = s + cap, n  # transform never lengthens => s+cap always fits
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(transform(flow[s:mid])) <= cap:
                lo = mid
            else:
                hi = mid - 1
        e = lo
        sp = flow.rfind(" ", s, e)  # don't split a word across pages
        if sp > s:
            e = sp
        chunks.append((s, e))
        s = e + (1 if e < n and flow[e] == " " else 0)
    return chunks


# --- harness (mirrors final.py) -----------------------------------------------


def cached(model: str, tag: str, payload: object, fn, fresh: bool) -> dict:
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


def build_png(cond: str, render_text: str, size: int) -> Path:
    png = CACHE / f"exp02-{cond}-{sha8(render_text, str(size))}.png"
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        if cond == "img-6x10-surp":
            img = render_surp(render_text, FONT, CACHE, size, sent_hues=False)
        elif cond == "img-6x10-sent-surp":
            img = render_surp(render_text, FONT, CACHE, size, sent_hues=True)
        else:  # disemv: text transform is the variable; keep baseline sent hues
            img = render(render_text, FONT, CACHE, size, "sent")
        img.save(tmp)
        tmp.replace(png)
    return png


def run_chunk(
    model: str, cond: str, start: int, end: int, png: Path, render_chars: int, ctx: dict
) -> list[dict]:
    args, keys = ctx["args"], ctx["keys"]
    questions = squad.sample_chunk_questions(
        ctx["paras"], ctx["offsets"], start, end, args.qpc, args.seed
    )
    if not questions:
        return []
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
    cols, rows, _ = capacity(FONT, args.size)
    extra = DISEMV_NOTE if cond == "img-6x10-disemv" else SURP_NOTE
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "text": load_prompt("exp02-qa-image.md").format(
                        cols=cols, rows=rows, extra=extra
                    )
                },
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    qa = cached(
        model,
        "exp02-qa",
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
    records[0]["chunk_orig_chars"] = end - start
    records[0]["chunk_render_chars"] = render_chars
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
    pages = sum(1 for r in records if "chunk_orig_chars" in r)
    orig_chars = sum(r.get("chunk_orig_chars", 0) for r in records)
    return {
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        "pages": pages,
        "orig_chars": orig_chars,
        "orig_chars_per_page": round(orig_chars / pages) if pages else 0,
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
    ap.add_argument("--report", action="store_true", help="reprint from cache only")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp02-surprisal"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]

    keys = {}
    if not args.report:
        keys["openai"] = load_env_key("OPENAI_API_KEY", args.env)
        keys["openrouter"] = load_env_key("OPENROUTER_API_KEY", args.env)

    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    for length in lengths:
        paras = all_paras[:length]
        flow, offsets = squad.build_flow(paras)
        ctx = {
            "args": args,
            "paras": paras,
            "offsets": offsets,
            "keys": keys,
            "length": length,
        }
        for cond in conditions:
            chunks = plan_chunks(flow, cond, args.size)
            for start, end in chunks:
                orig = flow[start:end]
                render_text = transform(orig) if cond == "img-6x10-disemv" else orig
                png = build_png(
                    cond, render_text, args.size
                )  # pre-render: no tmp races in pool
                if cond == "img-6x10-disemv":
                    print(
                        f"  len={length} disemv chunk [{start},{end}): {end - start} orig -> "
                        f"{len(render_text)} rendered chars (x{(end - start) / len(render_text):.2f})"
                    )
                for model in models:
                    tasks.append((model, cond, start, end, png, len(render_text), ctx))
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x {len(conditions)} conditions = {len(tasks)} chunk tasks"
    )

    records: list[dict] = []
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_chunk, *t) for t in tasks]
        for i, fut in enumerate(futures):
            records.extend(fut.result())
            print(f"  {i + 1}/{len(tasks)} tasks", flush=True)

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
        json.dumps({"args": vars(args), "cells": cells}, indent=1)
    )
    with (out_dir / "matrix.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cells[0].keys()))
        writer.writeheader()
        writer.writerows(cells)

    print(
        f"\n{'model':<26}{'len':>5}{'condition':<22}{'n':>4}{'EM':>7}{'F1':>7}{'se':>7}{'cost$':>8}{'dF1 vs base':>13}"
    )
    for c in cells:
        base = BASELINE.get((c["model"], c["length"]))
        d = f"{c['f1'] - base[0]:+.3f}" if base else "-"
        print(
            f"{c['model']:<26}{c['length']:>5}  {c['condition']:<20}{c['n']:>4}{c['em']:>7.3f}"
            f"{c['f1']:>7.3f}{c['f1_se']:>7.3f}{c['cost_usd']:>8.3f}{d:>13}"
        )
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")


if __name__ == "__main__":
    main()
