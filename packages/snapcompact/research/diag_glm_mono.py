# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Mono-prod protocol for glm-4.6v with selectable routing (openrouter | zai-direct)
and robust answer parsing (glm sometimes omits list numbering, which
squad.parse_numbered scores as all-empty).

Also rescoers the cached OpenRouter run with the same robust parser so the
before->after comparison is parser-fair.

  uv run diag_glm_mono.py --route zai --shape 8on16-bw --chars 400000 --questions 25
  uv run diag_glm_mono.py --route rescore-cache --shape 8on16-bw   # no API calls
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import squad  # noqa: E402
from diag_glm_forensics import build_batches  # noqa: E402
from diag_glm_probe import ZAI_URL, complete, img_block  # noqa: E402
from providers import load_env_key  # noqa: E402
from run import QA_CACHE, RESULTS, sha8  # noqa: E402


def parse_robust(text: str, n: int) -> list[str]:
    """parse_numbered, falling back to bare lines when the model skipped numbering."""
    answers = squad.parse_numbered(text, n)
    if any(answers):
        return answers
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) == n:
        return lines
    return answers


def to_chat(messages: list[dict]) -> list[dict]:
    out = []
    for m in messages:
        content = []
        for b in m["content"]:
            if "text" in b:
                content.append({"type": "text", "text": b["text"]})
            else:
                content.append(img_block(b["image_path"]))
        out.append({"role": m["role"], "content": content})
    return out


def score(
    questions,
    answers,
    label: str,
    out_dir: Path | None = None,
    extra: dict | None = None,
):
    rows = [
        {
            "q": q["q"],
            "pos_rel": q["pos_rel"],
            "answer": a,
            "golds": q["golds"],
            "em": squad.exact_match(a, q["golds"]),
            "f1": squad.f1(a, q["golds"]),
            "abstained": "unreadable" in a.lower(),
        }
        for q, a in zip(questions, answers)
    ]
    n = len(rows)
    summary = {
        "label": label,
        "n": n,
        "em": sum(r["em"] for r in rows) / n,
        "f1": sum(r["f1"] for r in rows) / n,
        "abst": sum(r["abstained"] for r in rows),
        **(extra or {}),
    }
    print(
        f"{label:<34} n={n} f1={summary['f1']:.3f} em={summary['em']:.3f} abst={summary['abst']}"
    )
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "records.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
        (out_dir / "summary.json").write_text(json.dumps([summary], indent=1))
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--route", required=True, choices=["openrouter", "zai", "rescore-cache"]
    )
    ap.add_argument("--shape", default="8on16-bw")
    ap.add_argument("--chars", type=int, default=400_000)
    ap.add_argument("--questions", type=int, default=25)
    ap.add_argument("--qpb", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--model-or", default="z-ai/glm-4.6v")
    ap.add_argument("--model-zai", default="glm-4.6v")
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument("--env", default="~/.env")
    args = ap.parse_args()

    pngs, batches = build_batches(
        args.shape, args.chars, args.questions, args.qpb, args.seed
    )
    questions = [q for batch, _ in batches for q in batch]

    if args.route == "rescore-cache":
        # Reread the original OpenRouter run's cached raw texts, robust-parse, rescore.
        answers = []
        for batch, messages in batches:
            payload = {"messages": messages, "effort": None}
            key = sha8(
                args.model_or,
                "qa-mono-prod",
                json.dumps(payload, sort_keys=True, default=str),
            )
            path = QA_CACHE / f"{key}.json"
            text = json.loads(path.read_text())["text"] if path.exists() else ""
            answers.extend(parse_robust(text, len(batch)))
        score(
            questions,
            answers,
            f"openrouter-cached-robust-{args.shape}",
            RESULTS / f"diag-glm-or-robust-{args.shape}",
        )
        return

    keys = {
        "openrouter": load_env_key("OPENROUTER_API_KEY", args.env),
        "zai": load_env_key("ZAI_API_KEY", args.env),
    }

    def run_batch(item):
        batch, messages = item
        chat = to_chat(messages)
        r = complete(
            args.route, keys, chat, args.model_or, args.model_zai, args.max_tokens
        )
        if "http_error" in r:
            print(f"  HTTP {r['http_error']}: {r['body'][:200]}")
            return [""] * len(batch), {}
        return parse_robust(r["text"], len(batch)), r.get("usage", {})

    with ThreadPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(run_batch, batches))
    answers = [a for ans, _ in results for a in ans]
    tok_in = sum(u.get("prompt_tokens", 0) for _, u in results)
    tok_out = sum(u.get("completion_tokens", 0) for _, u in results)
    score(
        questions,
        answers,
        f"{args.route}-{args.shape}-{len(pngs)}f",
        RESULTS / f"diag-glm-{args.route}-{args.shape}-{len(pngs)}f",
        {"imgs": len(pngs), "tok_in": tok_in, "tok_out": tok_out},
    )


if __name__ == "__main__":
    main()
