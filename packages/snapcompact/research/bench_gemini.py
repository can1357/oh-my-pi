# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Direct Gemini API bench: per-part media_resolution (Gemini 3 only knob).

Same protocol as mono_prod.py (production frames via render_pages.ts, SQuAD
flow, seed 42), but calls generativelanguage.googleapis.com v1alpha directly
so we can set per-part `media_resolution` (e.g. MEDIA_RESOLUTION_ULTRA_HIGH =
2240 tokens/image), which OpenRouter does not forward.

  uv run --with pillow python bench_gemini.py --resolution MEDIA_RESOLUTION_ULTRA_HIGH \
      --shape-json '{...}' --name ultra-3072 --chars 400000 --questions 25
"""

import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from final import cached  # noqa: E402
from providers import load_env_key  # noqa: E402
from run import CACHE, RESULTS, load_prompt, sha8  # noqa: E402

GEMINI_MODEL = "gemini-3.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1alpha/models/{GEMINI_MODEL}:generateContent"
PRICE_IN, PRICE_OUT = 0.6, 4.0  # $/M, matches final.MODELS google/gemini-3.5-flash


def _post(body: dict, api_key: str, retries: int = 4) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        GEMINI_URL,
        data=payload,
        headers={"content-type": "application/json", "x-goog-api-key": api_key},
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            if err.code in (408, 429, 500, 502, 503) and attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  HTTP {err.code}, retrying in {wait:.0f}s: {detail[:120]}")
                time.sleep(wait)
                continue
            raise SystemExit(f"Gemini API error {err.code}: {detail}") from err
        except (json.JSONDecodeError, TimeoutError, urllib.error.URLError) as err:
            if attempt < retries:
                wait = 2.0 * 2**attempt
                print(f"  bad response ({type(err).__name__}), retrying in {wait:.0f}s")
                time.sleep(wait)
                continue
            raise
    raise AssertionError("unreachable")


def gemini_complete(
    api_key: str, blocks: list[dict], resolution: str | None, max_tokens: int
) -> dict:
    """blocks: [{"text": str} | {"image_path": Path}]; returns {"text", "usage", "stop"}."""
    parts = []
    for b in blocks:
        if "text" in b:
            parts.append({"text": b["text"]})
        else:
            part: dict = {
                "inline_data": {
                    "mime_type": "image/png",
                    "data": base64.b64encode(
                        Path(b["image_path"]).read_bytes()
                    ).decode(),
                }
            }
            if resolution:
                part["media_resolution"] = {"level": resolution}
            parts.append(part)
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    out = _post(body, api_key)
    cand = (out.get("candidates") or [{}])[0]
    text = "".join(
        p.get("text", "")
        for p in (cand.get("content") or {}).get("parts", [])
        if not p.get("thought")
    )
    u = out.get("usageMetadata", {})
    usage = {
        "in": u.get("promptTokenCount", 0) - u.get("cachedContentTokenCount", 0),
        "out": u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0),
        "cache_w": 0,
        "cache_r": u.get("cachedContentTokenCount", 0),
        "reasoning": u.get("thoughtsTokenCount", 0),
    }
    stop = (
        "max_tokens"
        if cand.get("finishReason") == "MAX_TOKENS"
        else (cand.get("finishReason") or "").lower()
    )
    return {"text": text, "usage": usage, "stop": stop}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape-json", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument(
        "--resolution",
        default=None,
        help="per-part media_resolution level, e.g. MEDIA_RESOLUTION_ULTRA_HIGH; omit for API default",
    )
    ap.add_argument("--chars", type=int, default=400_000)
    ap.add_argument("--questions", type=int, default=25)
    ap.add_argument("--qpb", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--env", default="~/.env")
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()

    api_key = load_env_key("GEMINI_API_KEY", args.env)
    paras = squad.load_paragraphs(CACHE)
    flow, offsets = squad.build_flow(paras, args.chars)
    questions = squad.sample_chunk_questions(
        paras, offsets, 0, len(flow), args.questions, args.seed
    )
    shape, label = json.loads(args.shape_json), args.name
    cond = f"prod-{label}"
    size = shape["frameSize"]

    frame_dir = (
        CACHE / f"prod-frames-{label}-{sha8(flow, json.dumps(shape, sort_keys=True))}"
    )
    if not frame_dir.exists() or not any(frame_dir.iterdir()):
        flow_file = CACHE / f"prod-flow-{sha8(flow)}.txt"
        flow_file.write_text(flow)
        subprocess.run(
            [
                "bun",
                str(HERE / "render_pages.ts"),
                str(flow_file),
                json.dumps(shape),
                str(frame_dir),
            ],
            check=True,
        )
    pngs = sorted(frame_dir.glob("page-*.png"))
    cols = (
        (size // shape["cellWidth"] - 3) // 2
        if shape.get("columns") == 2
        else size // shape["cellWidth"]
    )
    rows = size // shape["cellHeight"] // shape.get("lineRepeat", 1)
    preamble = load_prompt("qa-image-multi.md").format(
        k=len(pngs), cols=cols, rows=rows
    )
    if shape.get("columns") == 2:
        preamble += (
            "\nNote: each image lays text out as two word-wrapped newspaper columns separated by a gutter; "
            "read the left column top to bottom, then the right column."
        )
    ctx_blocks = [
        {"text": preamble},
        *({"image_path": str(p)} for p in pngs),
        {"text": "End of images."},
    ]

    out_dir = RESULTS / f"mono-prod-gemini-direct-{label}"
    out_dir.mkdir(parents=True, exist_ok=True)
    answers, usages, stops = [], [], []
    for b in range(0, len(questions), args.qpb):
        batch = questions[b : b + args.qpb]
        q_block = "\n".join(f"{i + 1}. {q['q']}" for i, q in enumerate(batch))
        blocks = [*ctx_blocks, {"text": q_block}]
        qa = cached(
            f"gemini-direct-{GEMINI_MODEL}",
            "qa-mono-prod-direct",
            {
                "blocks": [{k: str(v) for k, v in blk.items()} for blk in blocks],
                "resolution": args.resolution,
            },
            lambda blk=blocks: gemini_complete(
                api_key, blk, args.resolution, args.max_tokens
            ),
            args.fresh,
        )
        answers.extend(squad.parse_numbered(qa["text"], len(batch)))
        usages.append(qa["usage"])
        stops.append(qa["stop"])
    rows_out = [
        {
            "model": GEMINI_MODEL,
            "cond": cond,
            "pos_rel": q["pos_rel"],
            "q": q["q"],
            "answer": a,
            "golds": q["golds"],
            "em": squad.exact_match(a, q["golds"]),
            "f1": squad.f1(a, q["golds"]),
            "abstained": "unreadable" in a.lower(),
        }
        for q, a in zip(questions, answers)
    ]
    u = {
        k: sum(x[k] for x in usages)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost = (u["in"] + 0.1 * u["cache_r"]) / 1e6 * PRICE_IN + u["out"] / 1e6 * PRICE_OUT
    summary = {
        "cond": cond,
        "n": len(rows_out),
        "imgs": len(pngs),
        "resolution": args.resolution,
        "em": sum(r["em"] for r in rows_out) / len(rows_out),
        "f1": sum(r["f1"] for r in rows_out) / len(rows_out),
        "abst": sum(r["abstained"] for r in rows_out),
        "tok_in": u["in"],
        "tok_cached": u["cache_r"],
        "tok_out": u["out"],
        "reas": u["reasoning"],
        "cost": cost,
        "stop": next(
            (s for s in stops if s == "max_tokens"), stops[-1] if stops else ""
        ),
    }
    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows_out))
    (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    print(
        f"{cond:<28} res={args.resolution or 'default'} imgs={summary['imgs']:>2} "
        f"f1={summary['f1']:.3f} em={summary['em']:.3f} abst={summary['abst']} "
        f"tok_in={summary['tok_in']} ${summary['cost']:.3f} stop={summary['stop']}"
    )


if __name__ == "__main__":
    main()
