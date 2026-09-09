# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""exp06 rolecolor: hue = message role, as zero-char metadata in optical compaction.

Synthetic transcript: each SQuAD passage gets a role (user/assistant/tool),
round-robin within shuffled triples (seed 42). Three conditions, same passages,
same questions:

  img-6x10-role    plain text, glyph hue per role (blue=user, green=assistant,
                   red=tool) -- metadata at zero character cost
  img-6x10-tagbw   black-on-white, inline "[user] "/"[asst] "/"[tool] " tag
                   before each passage -- text-equivalent control, ~7 chars/passage
  img-6x10-nometa  baseline sent variant, no role metadata -- provenance floor
                   (content F1 for this condition == img-6x10-sent baseline table)

Two evals per chunk image: (a) standard SQuAD QA (content F1; not run for
nometa), (b) provenance QA: "which role's message contains the answer?",
scored as plain accuracy against the assigned role of the source passage.

Chunking: greedy consecutive passages such that the TAGGED text fits the
6x10 capacity (40716 chars), so all three conditions share identical chunks
and question sets. Boundaries therefore shift slightly vs the baseline run
(which chunks the plain flow at exactly 40716); question sets overlap heavily
but are not char-identical to the baseline cells.

Saturation-decay-by-recency was considered and deliberately omitted: no eval
question tests recency, and desaturating old passages risks destroying the
hue signal the provenance task measures.

Run from the snapcompact dir:  uv run exp06_rolecolor.py
"""

import argparse
import colorsys
import csv
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from bdf import capacity, ensure_font, parse_bdf, render  # noqa: E402
from final import cached  # noqa: E402
from providers import llm_complete, load_env_key  # noqa: E402
from run import CACHE, FONTS, QA_CACHE, RESULTS, load_prompt, sha8  # noqa: E402

MODELS = {"gpt-5.5": (2.0, 16.0), "google/gemini-3.5-flash": (0.6, 4.0)}
LENGTHS = (50, 150)
CONDITIONS = ("img-6x10-role", "img-6x10-tagbw", "img-6x10-nometa")
FONT = FONTS["6x10"]

ROLES = ("user", "assistant", "tool")
TAGS = {"user": "user", "assistant": "asst", "tool": "tool"}  # all "[xxxx] " = 7 chars
ROLE_HUES = {"user": 0.62, "assistant": 0.33, "tool": 0.02}
ROLE_RGB = {
    r: tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, 0.27, 0.90))
    for r, h in ROLE_HUES.items()
}
_WHITE = (255, 255, 255)

ENCODING = {
    "img-6x10-role": (
        "Glyph color encodes the author role: dark blue = user, dark green = assistant, dark red = tool. "
        "A message boundary is where the glyph color changes."
    ),
    "img-6x10-tagbw": (
        "Each message is preceded by a bracketed role tag rendered in the text: [user], [asst], or [tool]."
    ),
    "img-6x10-nometa": (
        "The rendering does NOT visually indicate roles; glyph colors only cycle per sentence and carry "
        "no role information. Use your best guess."
    ),
}
QA_PROMPT = {
    "img-6x10-role": "exp06-qa-image.md",
    "img-6x10-tagbw": "exp06-qa-image-tag.md",
}


def assign_roles(n: int, seed: int) -> list[str]:
    """Round-robin role assignment: each consecutive triple of passages contains
    every role exactly once, triple-internal order shuffled deterministically."""
    rng = random.Random(seed)
    roles: list[str] = []
    while len(roles) < n:
        triple = list(ROLES)
        rng.shuffle(triple)
        roles.extend(triple)
    return roles[:n]


def build_chunks(paras: list[dict], budget: int) -> list[tuple[int, int]]:
    """Greedy consecutive passage ranges [a, b) whose TAGGED rendering fits budget."""
    chunks, cur, cur_len = [], 0, 0
    for i, p in enumerate(paras):
        add = 7 + len(p["ctx"]) + 1  # "[xxxx] " + ctx + " "
        if cur_len + add > budget and i > cur:
            chunks.append((cur, i))
            cur, cur_len = i, 0
        cur_len += add
    chunks.append((cur, len(paras)))
    return chunks


def sample_questions(
    paras: list[dict], offsets: list[int], start: int, end: int, n: int, seed: int
) -> list[dict]:
    """squad.sample_chunk_questions with the source passage index recorded (same rng sequence)."""
    rng = random.Random(seed * 1_000_003 + start)
    eligible = [
        i
        for i in range(len(offsets))
        if offsets[i] >= start and offsets[i] + len(paras[i]["ctx"]) <= end
    ]
    if not eligible:
        return []
    n = min(n, len(eligible))
    step = len(eligible) / n
    picked = []
    for k in range(n):
        pi = eligible[int(k * step)]
        qa = rng.choice(paras[pi]["qas"])
        picked.append(
            {
                "q": " ".join(qa["question"].split()),
                "golds": sorted({a["text"] for a in qa["answers"]}),
                "pos_rel": (offsets[pi] - start) / (end - start),
                "pi": pi,
            }
        )
    return picked


def render_role(
    text: str, colors: list[tuple[int, int, int]], size: int
) -> Image.Image:
    """bdf.render() copy, simplified: white background, per-character glyph color."""
    glyphs, font_ascent = parse_bdf(ensure_font(FONT, CACHE))
    ascent = FONT.ascent if FONT.ascent is not None else font_ascent
    cols, rows, cap = capacity(FONT, size)
    text = text[:cap]
    img = Image.new("RGB", (size, size), _WHITE)
    px = img.load()
    for row in range(rows):
        y0 = row * FONT.pitch
        for col in range(cols):
            i = row * cols + col
            if i >= len(text):
                break
            glyph = glyphs.get(ord(text[i]))
            if glyph is None:
                continue
            fg = colors[i]
            w, h, xoff, yoff = glyph["bbx"]
            top = y0 + ascent - h - yoff
            shift = 0x80 if w <= 8 else 0x8000
            for r, bits in enumerate(glyph["rows"]):
                y = top + r
                if not 0 <= y < size:
                    continue
                for b in range(w):
                    if bits & (shift >> b):
                        x = col * FONT.adv + xoff + b
                        if 0 <= x < size:
                            px[x, y] = fg
    return img


def chunk_carriers(paras: list[dict], roles: list[str], a: int, b: int) -> dict:
    """Plain text + per-char role colors, and tagged text, for passages [a, b)."""
    plain_parts, colors, tagged_parts = [], [], []
    for i in range(a, b):
        seg = paras[i]["ctx"] + " "
        plain_parts.append(seg)
        colors.extend([ROLE_RGB[roles[i]]] * len(seg))
        tagged_parts.append(f"[{TAGS[roles[i]]}] {seg}")
    return {
        "plain": "".join(plain_parts),
        "colors": colors,
        "tagged": "".join(tagged_parts),
    }


def atomic_png(png: Path, make) -> Path:
    if not png.exists() or png.stat().st_size == 0:
        tmp = png.with_suffix(".tmp.png")
        make().save(tmp)
        tmp.replace(png)
    return png


def build_image(cond: str, car: dict, size: int) -> Path:
    if cond == "img-6x10-role":
        png = CACHE / f"exp06-role-{sha8(car['plain'], str(size))}.png"
        return atomic_png(png, lambda: render_role(car["plain"], car["colors"], size))
    if cond == "img-6x10-tagbw":
        png = CACHE / f"exp06-tagbw-{sha8(car['tagged'], str(size))}.png"
        return atomic_png(png, lambda: render(car["tagged"], FONT, CACHE, size, "bw"))
    png = CACHE / f"exp06-nometa-{sha8(car['plain'], str(size))}.png"
    return atomic_png(png, lambda: render(car["plain"], FONT, CACHE, size, "sent"))


def norm_role(answer: str) -> str:
    a = answer.lower().strip(" \t.[]()\"'`*")
    if "assist" in a or a == "asst":
        return "assistant"
    if "user" in a or "human" in a:
        return "user"
    if "tool" in a or "function" in a:
        return "tool"
    return a


def run_cell(
    model: str, cond: str, length: int, ci: int, chunk: dict, args, keys
) -> list[dict]:
    """One (model, cond, chunk): content QA (role/tagbw only) + provenance QA."""
    questions, car = chunk["questions"], chunk["car"]
    if not questions:
        return []
    png = build_image(cond, car, args.size)
    cols, rows, _ = capacity(FONT, args.size)
    q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(questions))
    usage_rows: list[tuple[str, dict]] = []
    answers = [""] * len(questions)

    if cond in QA_PROMPT:
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": load_prompt(QA_PROMPT[cond]).format(cols=cols, rows=rows)},
                    {"image_path": png},
                    {"text": q_block},
                ],
            }
        ]
        qa = cached(
            model,
            "exp06-qa",
            {"cond": cond, "messages": messages},
            lambda: dict(
                zip(
                    ("text", "usage", "stop"),
                    llm_complete(keys, model, messages, max_tokens=args.max_tokens),
                )
            ),
            args.fresh,
        )
        usage_rows.append(("qa", qa["usage"]))
        answers = squad.parse_numbered(qa["text"], len(questions))

    prov_messages = [
        {
            "role": "user",
            "content": [
                {
                    "text": load_prompt("exp06-prov-image.md").format(
                        cols=cols, rows=rows, encoding=ENCODING[cond]
                    )
                },
                {"image_path": png},
                {"text": q_block},
            ],
        }
    ]
    prov = cached(
        model,
        "exp06-prov",
        {"cond": cond, "messages": prov_messages},
        lambda: dict(
            zip(
                ("text", "usage", "stop"),
                llm_complete(keys, model, prov_messages, max_tokens=args.max_tokens),
            )
        ),
        args.fresh,
    )
    usage_rows.append(("prov", prov["usage"]))
    prov_answers = squad.parse_numbered(prov["text"], len(questions))

    records = []
    for q, a, pa in zip(questions, answers, prov_answers):
        gold_role = chunk["roles"][q["pi"]]
        scored = cond in QA_PROMPT
        records.append(
            {
                "model": model,
                "length": length,
                "cond": cond,
                "chunk": ci,
                "pos_rel": q["pos_rel"],
                "q": q["q"],
                "answer": a,
                "golds": q["golds"],
                "em": squad.exact_match(a, q["golds"]) if scored else None,
                "f1": squad.f1(a, q["golds"]) if scored else None,
                "abstained": "unreadable" in a.lower() if scored else None,
                "prov_answer": pa,
                "prov_gold": gold_role,
                "prov_correct": float(norm_role(pa) == gold_role),
            }
        )
    records[0]["usage"] = [{"phase": p, **u} for p, u in usage_rows]
    return records


def phase_cost(
    records: list[dict], phase: str, price_in: float, price_out: float
) -> tuple[dict, float]:
    us = [u for r in records if "usage" in r for u in r["usage"] if u["phase"] == phase]
    tok = {
        k: sum(u.get(k, 0) for u in us)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost = (
        tok["in"] + 1.25 * tok["cache_w"] + 0.1 * tok["cache_r"]
    ) / 1e6 * price_in + tok["out"] / 1e6 * price_out
    return tok, cost


def aggregate(records: list[dict], price_in: float, price_out: float) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records if r["f1"] is not None]
    if f1s:
        mean_f1 = sum(f1s) / len(f1s)
        se = (
            (sum((x - mean_f1) ** 2 for x in f1s) / (len(f1s) * (len(f1s) - 1))) ** 0.5
            if len(f1s) > 1
            else 0.0
        )
        em = sum(r["em"] for r in records if r["em"] is not None) / len(f1s)
        abstained = sum(r["abstained"] for r in records if r["abstained"] is not None)
    else:
        mean_f1 = se = em = None
        abstained = None
    pacc = sum(r["prov_correct"] for r in records) / n
    pse = (pacc * (1 - pacc) / n) ** 0.5
    qa_tok, qa_cost = phase_cost(records, "qa", price_in, price_out)
    _, prov_cost = phase_cost(records, "prov", price_in, price_out)
    return {
        "n": n,
        "em": em,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": abstained,
        "prov_acc": round(pacc, 4),
        "prov_se": round(pse, 4),
        **{f"tok_{k}": v for k, v in qa_tok.items()},
        "qa_cost_usd": round(qa_cost, 4),
        "prov_cost_usd": round(prov_cost, 4),
        "cost_usd": round(qa_cost + prov_cost, 4),
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
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    out_dir = RESULTS / "exp06-rolecolor"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    lengths = [int(x) for x in args.lengths.split(",") if x.strip()]
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    keys = {
        "openai": load_env_key("OPENAI_API_KEY", args.env),
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
    }

    budget = capacity(FONT, args.size)[2]
    all_paras = squad.load_paragraphs(CACHE)
    tasks = []
    for length in lengths:
        paras = all_paras[:length]
        roles = assign_roles(length, args.seed)
        flow, offsets = squad.build_flow(paras)
        for ci, (a, b) in enumerate(build_chunks(paras, budget)):
            start, end = offsets[a], offsets[b - 1] + len(paras[b - 1]["ctx"])
            chunk = {
                "questions": sample_questions(
                    paras, offsets, start, end, args.qpc, args.seed
                ),
                "car": chunk_carriers(paras, roles, a, b),
                "roles": roles,
            }
            for model in models:
                for cond in conditions:
                    tasks.append((model, cond, length, ci, chunk))
    print(
        f"grid: {len(models)} models x {len(lengths)} lengths x {len(conditions)} conditions = {len(tasks)} cells"
    )

    records: list[dict] = []
    failed = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [
            pool.submit(run_cell, m, c, ln, ci, ch, args, keys)
            for m, c, ln, ci, ch in tasks
        ]
        for done, (fut, t) in enumerate(zip(futures, tasks), 1):
            try:
                records.extend(fut.result())
            except Exception as err:  # noqa: BLE001 -- partial results still get written; rerun resumes from cache
                failed += 1
                print(
                    f"  FAIL {t[0]} {t[1]} len={t[2]} chunk={t[3]}: {type(err).__name__}: {err}",
                    flush=True,
                )
            print(f"  {done}/{len(tasks)} cells", flush=True)

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
                if sub:
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

    for length in lengths:
        print(f"\n== {length} passages ==  (content F1 / prov acc / $total)")
        hdr = f"{'condition':<18}" + "".join(f"{m:>26}" for m in models)
        print(hdr + "\n" + "-" * len(hdr))
        for cond in conditions:
            row = f"{cond:<18}"
            for model in models:
                cell = next(
                    (
                        c
                        for c in cells
                        if c["model"] == model
                        and c["length"] == length
                        and c["condition"] == cond
                    ),
                    None,
                )
                if cell:
                    f1 = f"{cell['f1']:.3f}" if cell["f1"] is not None else "  -  "
                    row += f"{f1:>10} {cell['prov_acc']:>6.3f} {cell['cost_usd']:>8.3f}"
                else:
                    row += f"{'-':>26}"
            print(row)
    print(f"\ndataset -> {out_dir}/records.jsonl, matrix.csv, summary.json")
    if failed:
        raise SystemExit(f"{failed} cells failed -- rerun to resume from cache")


if __name__ == "__main__":
    main()
