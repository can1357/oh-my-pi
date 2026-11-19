# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Fix demonstration: mono_prod protocol for kimi, but routed DIRECT to Fireworks
(bypassing OpenRouter's silent 8-image truncation). Identical frames, prompt,
questions (chars=400k, n=25, qpb=5, seed=42) as mono-prod-moonshotai-kimi-k2.6-8on16-bw.

  uv run --with pillow python diag_kimi_mono.py [--shape 8on16-bw] [--max-questions 25]
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from diag_kimi_forensics import build_messages  # noqa: E402
from final import cached  # noqa: E402
from providers import _png_b64, _post, load_env_key  # noqa: E402
from run import RESULTS  # noqa: E402

FW_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
FW_MODEL = "accounts/fireworks/models/kimi-k2p6"
# Fireworks serverless list price for kimi-k2p6 family ($/Mtok in, out).
PRICE_IN, PRICE_OUT = 0.6, 2.5


def fw_complete(messages: list[dict], max_tokens: int = 32768) -> dict:
    key = load_env_key("FIREWORKS_API_KEY")

    def content(blocks: list[dict]) -> list[dict]:
        out = []
        for b in blocks:
            if "text" in b:
                out.append({"type": "text", "text": b["text"]})
            else:
                out.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{_png_b64(b['image_path'])}"
                        },
                    }
                )
        return out

    chat_messages = [
        {"role": m["role"], "content": content(m["content"])} for m in messages
    ]
    body = {"model": FW_MODEL, "messages": chat_messages, "max_tokens": max_tokens}
    out = _post(
        FW_URL, body, {"authorization": f"Bearer {key}", "user-agent": "diag/1.0"}
    )
    choice = (out.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    text = msg.get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    u = out.get("usage", {})
    usage = {
        "in": u.get("prompt_tokens", 0),
        "out": u.get("completion_tokens", 0),
        "cache_w": 0,
        "cache_r": 0,
        "reasoning": (u.get("completion_tokens_details") or {}).get(
            "reasoning_tokens", 0
        ),
    }
    stop = (
        "max_tokens"
        if choice.get("finish_reason") == "length"
        else (choice.get("finish_reason") or "")
    )
    return {"text": text, "usage": usage, "stop": stop}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", default="8on16-bw")
    ap.add_argument("--max-questions", type=int, default=25)
    ap.add_argument("--fresh", action="store_true")
    args = ap.parse_args()

    pngs, batches = build_messages(args.shape, questions=args.max_questions)
    cond = f"diag-fw-{args.shape}"
    answers, usages, stops, qs_all = [], [], [], []
    for batch, messages in batches:
        qa = cached(
            "fireworks/kimi-k2p6",
            "qa-mono-prod",
            {"messages": messages, "effort": None},
            lambda m=messages: fw_complete(m),
            args.fresh,
        )
        answers.extend(squad.parse_numbered(qa["text"], len(batch)))
        usages.append(qa["usage"])
        stops.append(qa["stop"])
        qs_all.extend(batch)

    rows = [
        {
            "model": "fireworks/kimi-k2p6",
            "cond": cond,
            "pos_rel": q["pos_rel"],
            "q": q["q"],
            "answer": a,
            "golds": q["golds"],
            "em": squad.exact_match(a, q["golds"]),
            "f1": squad.f1(a, q["golds"]),
            "abstained": "unreadable" in a.lower(),
        }
        for q, a in zip(qs_all, answers)
    ]
    u = {
        k: sum(x[k] for x in usages)
        for k in ("in", "out", "cache_w", "cache_r", "reasoning")
    }
    cost = u["in"] / 1e6 * PRICE_IN + u["out"] / 1e6 * PRICE_OUT
    quart = []
    for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.01)):
        sel = [r["f1"] for r in rows if lo <= r["pos_rel"] < hi]
        quart.append(sum(sel) / len(sel) if sel else float("nan"))
    summary = {
        "cond": cond,
        "n": len(rows),
        "imgs": len(pngs),
        "em": sum(r["em"] for r in rows) / len(rows),
        "f1": sum(r["f1"] for r in rows) / len(rows),
        "abst": sum(r["abstained"] for r in rows),
        "tok_in": u["in"],
        "tok_out": u["out"],
        "reas": u["reasoning"],
        "cost": cost,
        "stop": next(
            (s for s in stops if s == "max_tokens"), stops[-1] if stops else ""
        ),
        "q1": quart[0],
        "q2": quart[1],
        "q3": quart[2],
        "q4": quart[3],
    }
    out_dir = RESULTS / f"diag-kimi-fireworks-{args.shape}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    print(
        f"{cond} imgs={summary['imgs']} f1={summary['f1']:.3f} em={summary['em']:.3f} "
        f"abst={summary['abst']} ${summary['cost']:.2f} stop={summary['stop']}"
    )
    print(
        "F1 by quartile: " + "  ".join(f"q{i + 1}={v:.3f}" for i, v in enumerate(quart))
    )


if __name__ == "__main__":
    main()
