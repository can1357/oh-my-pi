# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""snapcompact: QA recall per context-compression strategy, over the full SQuAD dev set.

The corpus (all SQuAD v1.1 dev passages, space-joined; ~1.5M chars) is processed
per condition in chunks sized to that condition's carrying capacity:

  text             plain text, fixed 40,716-char chunks (= img-6x10 capacity)
  compact          agent compaction summary of each text chunk, QA on the summary
  handoff          agent handoff document of each text chunk, QA on the summary
  img-<font>-<v>   one 1568x1568 image per chunk; font in {8x13,6x10,5x8,5x7,
                   4x6tt,4x5tt}, render variant v in {color,zebra,bw}

Per chunk, up to --qpc questions are sampled (seeded, evenly spread across the
chunk so answers land at every image row band; pos_rel is recorded for position
analysis). Scoring is official SQuAD EM/F1. Responses are cached by payload
hash, so interrupted runs resume for free.

Usage examples:
  uv run run.py                              # default condition set, full corpus
  uv run run.py --limit-chars 200000         # quick pass on a corpus prefix
  uv run run.py --conditions img-6x10-bw     # one condition
  uv run run.py --report                     # re-print tables from cache, no API

Key: ANTHROPIC_API_KEY from ~/.env (last assignment wins).
"""

import argparse
import hashlib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent

def find_agent_prompts() -> Path:
    for parent in HERE.parents:
        for candidate in (
            parent / "packages" / "agent" / "src" / "compaction" / "prompts",
            parent / "agent" / "src" / "compaction" / "prompts",
        ):
            if candidate.exists():
                return candidate
    raise FileNotFoundError("Could not find agent compaction prompts")


sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from anthropic_api import complete, image_block, load_api_key  # noqa: E402
from bdf import VARIANTS, FontCfg, capacity, render  # noqa: E402

AGENT_PROMPTS = find_agent_prompts()
CACHE = HERE / ".cache"
QA_CACHE = CACHE / "qa"
RESULTS = HERE / "results"

FONTS = {
    "8x13": FontCfg("8x13", "8x13", 8, 13),
    "7x13": FontCfg("7x13", "7x13", 7, 13),
    "6x12": FontCfg("6x12", "6x12", 6, 12),
    "6x10": FontCfg("6x10", "6x10", 6, 10),
    "6x9": FontCfg("6x9", "6x9", 6, 9),
    # Anisotropic squashes: same glyphs, tighter grid. Crop flavor (6x6/6x8/3x10):
    # next row's band paints over the vertical overhang, halved advance fuses ink.
    # Stretch flavor (*s): rasterize native 6x10, Lanczos-resize to the target cell.
    "6x8s": FontCfg("6x8s", "6x10", 6, 8, native=(6, 10)),
    "6x6s": FontCfg("6x6s", "6x10", 6, 6, native=(6, 10)),
    "3x10s": FontCfg("3x10s", "6x10", 3, 10, native=(6, 10)),
    # Human-designed square cell: unscii-8 native, and stretched to a 6x6 cell.
    "8x8u": FontCfg("8x8u", "unscii-8", 8, 8),
    "6x6u": FontCfg("6x6u", "unscii-8", 6, 6, native=(8, 8)),
    "6x8": FontCfg("6x8", "6x9", 6, 8, ascent=7),
    "6x6": FontCfg("6x6", "6x9", 6, 6, ascent=6),
    "3x10": FontCfg("3x10", "6x10", 3, 10),
    # Redundancy coding: every line rendered twice, duplicate on a pale highlight.
    "8x8r": FontCfg("8x8r", "unscii-8", 8, 8, repeat=2),
    # Downsample-survivors: unscii-8 upscaled so gateway resizes leave legible glyphs.
    "12x12u": FontCfg("12x12u", "unscii-8", 12, 12, native=(8, 8)),
    "16x16u": FontCfg("16x16u", "unscii-8", 16, 16, native=(8, 8)),
    "5x8": FontCfg("5x8", "5x8", 5, 8),
    "5x7": FontCfg("5x7", "5x7", 5, 7),
    "4x6tt": FontCfg("4x6tt", "tom-thumb", 4, 6, ascent=5),
    "4x5tt": FontCfg("4x5tt", "tom-thumb", 4, 5, ascent=5),
}
TEXT_CHUNK = 40716  # = img-6x10 capacity; keeps text/summary chunks comparable
DEFAULT_CONDITIONS = (
    "text,compact,handoff,"
    "img-8x13-color,img-6x10-color,img-5x8-color,img-5x7-color,"
    "img-6x10-zebra,img-5x8-zebra,img-6x10-bw,img-5x8-bw"
)


def sha8(*parts: str) -> str:
    return hashlib.sha1("\x00".join(parts).encode()).hexdigest()[:8]


def load_prompt(name: str) -> str:
    return (HERE / "prompts" / name).read_text()


def agent_prompt(name: str) -> str:
    text = (AGENT_PROMPTS / name).read_text()
    # Drop unused Handlebars conditionals (no custom focus in this eval).
    return re.sub(r"\{\{#if .*?\{\{/if\}\}\n?", "", text, flags=re.DOTALL)


def cached_complete(api_key: str, model: str, messages: list[dict], fresh: bool, **kw) -> tuple[str, dict]:
    """complete() with response caching keyed on the full request payload.

    Truncated responses (stop_reason == max_tokens) are never cached and never
    served from cache, so re-runs with a larger budget repair them.
    """
    key = sha8(model, kw.get("effort") or "", json.dumps(messages, sort_keys=True))
    path = QA_CACHE / f"{key}.json"
    if path.exists() and not fresh:
        hit = json.loads(path.read_text())
        if hit.get("stop") != "max_tokens" and hit["text"]:
            return hit["text"], hit["usage"]
    text, usage, stop = complete(api_key, model, messages, **kw)
    if stop == "max_tokens":
        print(f"  WARN truncated response (stop=max_tokens), not cached: {key}")
    else:
        path.write_text(json.dumps({"text": text, "usage": usage, "stop": stop}))
    return text, usage


def parse_condition(name: str) -> dict:
    if name in ("text", "compact", "handoff"):
        return {"name": name, "kind": name}
    m = re.fullmatch(r"img-([a-z0-9]+)-([a-z-]+)", name)
    if not m or m.group(1) not in FONTS or m.group(2) not in VARIANTS:
        raise SystemExit(f"bad condition {name!r}; expected text|compact|handoff|img-<font>-<variant>")
    return {"name": name, "kind": "image", "font": FONTS[m.group(1)], "variant": m.group(2)}


def run_chunk(cond: dict, start: int, end: int, ctx_args: dict) -> list[dict]:
    """Execute one (condition, chunk) task; returns per-question records."""
    args, flow, paras, offsets, api_key = (
        ctx_args["args"],
        ctx_args["flow"],
        ctx_args["paras"],
        ctx_args["offsets"],
        ctx_args["api_key"],
    )
    questions = squad.sample_chunk_questions(paras, offsets, start, end, args.qpc, args.seed)
    if not questions:
        return []
    chunk_text = flow[start:end]
    usage_rows: list[tuple[str, dict]] = []

    png = cols = rows = None
    context = chunk_text
    if cond["kind"] == "image":
        salt = ("dimv2",) if cond["variant"] == "dim" else ()  # cache-bust pre-fix sticky-fg dim renders
        png = CACHE / f"img-{cond['font'].name}-{cond['variant']}-{sha8(chunk_text, str(args.size), *salt)}.png"
        if not png.exists():
            render(chunk_text, cond["font"], CACHE, args.size, cond["variant"]).save(png)
        cols, rows, _ = capacity(cond["font"], args.size)
    elif cond["kind"] in ("compact", "handoff"):
        prompt_file = {"compact": "compaction-summary.md", "handoff": "handoff-document.md"}[cond["kind"]]
        gen_messages = [
            {"role": "user", "content": load_prompt("session-frame.md").format(context=chunk_text)},
            {"role": "assistant", "content": "Noted. I have read the passages and will keep them in mind."},
            {"role": "user", "content": agent_prompt(prompt_file)},
        ]
        context, gen_usage = cached_complete(
            api_key, args.model, gen_messages, args.fresh,
            system=agent_prompt("summarization-system.md"), max_tokens=4096,
        )
        usage_rows.append(("summarize", gen_usage))

    use_cache = args.cache == "on" or (args.cache == "auto" and args.qpb > 0)
    batch_size = args.qpb or len(questions)
    answers: list[str] = []
    for b in range(0, len(questions), batch_size):
        batch = questions[b : b + batch_size]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        if cond["kind"] == "image":
            carrier = image_block(png)
            preamble = {"type": "text", "text": load_prompt("qa-image.md").format(cols=cols, rows=rows)}
        else:
            carrier = {"type": "text", "text": load_prompt("qa-text.md").format(context=context)}
            preamble = None
        if use_cache:
            carrier["cache_control"] = {"type": "ephemeral"}
        content = ([preamble] if preamble else []) + [carrier, {"type": "text", "text": q_block}]
        messages = [{"role": "user", "content": content}]
        text, usage = cached_complete(
            api_key, args.model, messages, args.fresh, max_tokens=args.max_tokens, effort=args.effort
        )
        usage_rows.append(("qa", usage))
        answers.extend(squad.parse_numbered(text, len(batch)))
    records = []
    for q, a in zip(questions, answers):
        records.append(
            {
                "cond": cond["name"],
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
    # Attach token usage to the first record of the chunk (avoids double counting).
    records[0]["usage"] = [
        {
            "phase": phase,
            "in": u.get("input_tokens", 0),
            "out": u.get("output_tokens", 0),
            "cache_w": u.get("cache_creation_input_tokens", 0),
            "cache_r": u.get("cache_read_input_tokens", 0),
        }
        for phase, u in usage_rows
    ]
    return records


def aggregate(name: str, records: list[dict], price_in: float, price_out: float) -> dict:
    n = len(records)
    f1s = [r["f1"] for r in records]
    mean_f1 = sum(f1s) / n
    se = (sum((x - mean_f1) ** 2 for x in f1s) / (n * (n - 1))) ** 0.5 if n > 1 else 0.0
    usages = [u for r in records if "usage" in r for u in r["usage"]]
    tok_in = sum(u["in"] for u in usages)
    tok_out = sum(u["out"] for u in usages)
    cache_w = sum(u.get("cache_w", 0) for u in usages)
    cache_r = sum(u.get("cache_r", 0) for u in usages)
    quart = []
    for lo, hi in ((0.0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
        qs = [r["f1"] for r in records if lo <= r["pos_rel"] < hi]
        quart.append(sum(qs) / len(qs) if qs else None)
    return {
        "name": name,
        "n": n,
        "em": sum(r["em"] for r in records) / n,
        "f1": mean_f1,
        "f1_se": se,
        "abstained": sum(r["abstained"] for r in records),
        "tokens_in": tok_in,
        "tokens_out": tok_out,
        "cache_w": cache_w,
        "cache_r": cache_r,
        # Anthropic pricing: cache write 1.25x input, cache read 0.1x input (5m TTL).
        "cost_usd": (tok_in + 1.25 * cache_w + 0.1 * cache_r) / 1e6 * price_in + tok_out / 1e6 * price_out,
        "f1_by_quartile": quart,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="claude-fable-5")
    ap.add_argument("--conditions", default=DEFAULT_CONDITIONS)
    ap.add_argument("--qpc", type=int, default=30, help="questions sampled per chunk")
    ap.add_argument("--qpb", type=int, default=0, help="questions per API call (batches the chunk); 0 = all at once")
    ap.add_argument("--cache", choices=["auto", "on", "off"], default="auto",
                    help="prompt-cache the carrier block; auto = on when --qpb is set")
    ap.add_argument("--max-tokens", type=int, default=8192, help="output budget per QA call (incl. thinking)")
    ap.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], default=None,
                    help="adaptive-thinking effort for QA calls; default = provider default")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--size", type=int, default=1568)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit-chars", type=int, default=0, help="cap corpus size; 0 = full dev set")
    ap.add_argument("--limit-paras", type=int, default=0, help="cap corpus to first N passages; 0 = all")
    ap.add_argument("--fresh", action="store_true", help="ignore cached responses")
    ap.add_argument("--report", action="store_true", help="aggregate cached records only; no API calls")
    ap.add_argument("--price-in", type=float, default=10.0, help="$ per 1M input tokens")
    ap.add_argument("--price-out", type=float, default=50.0, help="$ per 1M output tokens")
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    QA_CACHE.mkdir(exist_ok=True)
    scope = f"p{args.limit_paras}" if args.limit_paras else (args.limit_chars or "full")
    tag = "".join(
        [
            f"-qpb{args.qpb}" if args.qpb else "",
            f"-s{args.size}" if args.size != 1568 else "",
            f"-e{args.effort}" if args.effort else "",
        ]
    )
    run_dir = RESULTS / f"{args.model}-seed{args.seed}-qpc{args.qpc}-{scope}{tag}"
    run_dir.mkdir(parents=True, exist_ok=True)

    paras = squad.load_paragraphs(CACHE)
    if args.limit_paras:
        paras = paras[: args.limit_paras]
    flow, offsets = squad.build_flow(paras, args.limit_chars or None)
    conditions = [parse_condition(c.strip()) for c in args.conditions.split(",") if c.strip()]

    tasks: list[tuple[dict, int, int]] = []
    for cond in conditions:
        budget = capacity(cond["font"], args.size)[2] if cond["kind"] == "image" else TEXT_CHUNK
        for start in range(0, len(flow), budget):
            tasks.append((cond, start, min(start + budget, len(flow))))
    calls = len(tasks) + sum(1 for c, *_ in tasks if c["kind"] in ("compact", "handoff"))
    print(
        f"corpus={len(flow):,} chars ({len(offsets):,} passages), {len(conditions)} conditions, "
        f"{len(tasks)} chunks, <= {calls} API calls, qpc={args.qpc}, model={args.model}"
    )

    api_key = "" if args.report else load_api_key(args.env)
    ctx_args = {"args": args, "flow": flow, "paras": paras, "offsets": offsets, "api_key": api_key}
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(run_chunk, cond, start, end, ctx_args) for cond, start, end in tasks]
        for fut in futures:
            records.extend(fut.result())
            done += 1
            if done % 20 == 0:
                print(f"  {done}/{len(tasks)} chunks", flush=True)

    with (run_dir / "records.jsonl").open("w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")

    rows = [
        aggregate(cond["name"], [r for r in records if r["cond"] == cond["name"]], args.price_in, args.price_out)
        for cond in conditions
        if any(r["cond"] == cond["name"] for r in records)
    ]
    rows.sort(key=lambda r: -r["f1"])
    (run_dir / "summary.json").write_text(json.dumps({"args": vars(args), "rows": rows}, indent=1))

    hdr = (
        f"{'condition':<15}{'n':>6}{'EM':>7}{'F1':>7}{'±se':>6}{'abst':>6}"
        f"{'in tok':>10}{'cache w':>9}{'cache r':>9}{'out tok':>9}{'$':>7}"
    )
    print("\n" + hdr + "\n" + "-" * len(hdr))
    for r in rows:
        print(
            f"{r['name']:<15}{r['n']:>6}{r['em']:>7.3f}{r['f1']:>7.3f}{r['f1_se']:>6.3f}{r['abstained']:>6}"
            f"{r['tokens_in']:>10,}{r['cache_w']:>9,}{r['cache_r']:>9,}{r['tokens_out']:>9,}{r['cost_usd']:>7.2f}"
        )
    print(f"\n{'condition':<15}  F1 by position quartile (Q1..Q4)")
    for r in rows:
        cells = "  ".join("  -  " if q is None else f"{q:.3f}" for q in r["f1_by_quartile"])
        print(f"{r['name']:<15}  {cells}")
    print(f"\nresults -> {run_dir}/")


if __name__ == "__main__":
    main()
