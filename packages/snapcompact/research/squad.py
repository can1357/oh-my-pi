"""SQuAD v1.1 dev: passage flow, question sampling, official EM/F1 scoring."""

import json
import random
import re
import string
import urllib.request
from collections import Counter
from pathlib import Path

SQUAD_URL = "https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json"


def load_paragraphs(cache: Path) -> list[dict]:
    """Flattened [{ctx, qas, title}] in deterministic dataset order."""
    path = cache / "squad-dev-v1.1.json"
    if not path.exists():
        urllib.request.urlretrieve(SQUAD_URL, path)
    data = json.loads(path.read_text())["data"]
    out = []
    for art in data:
        for p in art["paragraphs"]:
            out.append(
                {
                    "ctx": " ".join(p["context"].split()),
                    "qas": p["qas"],
                    "title": art["title"],
                }
            )
    return out


def build_flow(
    paras: list[dict], max_chars: int | None = None
) -> tuple[str, list[int]]:
    """Space-joined passage stream + start offset of each passage."""
    flow, offsets = "", []
    for p in paras:
        offsets.append(len(flow))
        flow += p["ctx"] + " "
        if max_chars is not None and len(flow) >= max_chars:
            break
    return flow, offsets


def sample_chunk_questions(
    paras: list[dict], offsets: list[int], start: int, end: int, n: int, seed: int
) -> list[dict]:
    """Up to n questions from passages fully inside [start, end), evenly spread.

    Passages straddling a chunk boundary are skipped (their answers may be cut).
    Each question records pos_rel: passage start relative to the chunk, 0..1.
    """
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
            }
        )
    return picked


# --- official SQuAD normalization / metrics ---


def _normalize(s: str) -> str:
    s = s.lower()
    s = "".join(ch for ch in s if ch not in string.punctuation)
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    return " ".join(s.split())


def exact_match(pred: str, golds: list[str]) -> float:
    return float(any(_normalize(pred) == _normalize(g) for g in golds))


def f1(pred: str, golds: list[str]) -> float:
    best = 0.0
    for g in golds:
        p_tok, g_tok = _normalize(pred).split(), _normalize(g).split()
        common = Counter(p_tok) & Counter(g_tok)
        overlap = sum(common.values())
        if overlap == 0:
            continue
        prec, rec = overlap / len(p_tok), overlap / len(g_tok)
        best = max(best, 2 * prec * rec / (prec + rec))
    return best


def parse_numbered(text: str, n: int) -> list[str]:
    """Extract answers from a numbered list; missing entries become ''."""
    answers = [""] * n
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)[.):]\s*(.*\S)?\s*$", line)
        if m and m.group(2):
            idx = int(m.group(1)) - 1
            if 0 <= idx < n and not answers[idx]:
                answers[idx] = m.group(2).strip()
    return answers


def score(answers: list[str], questions: list[dict]) -> dict:
    ems = [exact_match(a, q["golds"]) for a, q in zip(answers, questions)]
    f1s = [f1(a, q["golds"]) for a, q in zip(answers, questions)]
    return {
        "em": sum(ems) / len(ems),
        "f1": sum(f1s) / len(f1s),
        "abstained": sum("unreadable" in a.lower() for a in answers),
        "per_question": [
            {"answer": a, "golds": q["golds"], "em": e, "f1": f}
            for a, q, e, f in zip(answers, questions, ems, f1s)
        ],
    }
