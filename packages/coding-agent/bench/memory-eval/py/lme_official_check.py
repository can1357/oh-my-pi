"""Check our LongMemEval metrics against the official evaluator (Layer 0 check 4).

Usage (venv-lme python, numpy<2 because the official code uses np.asfarray):
    lme_official_check.py <result.json>                       exit 0 iff every metric matches within 1e-12
    lme_official_check.py <result.json> --oracle-from-cases   score the official oracle ranking on our loaded cases
"""

import os
import sys

# Run as `python -I`. Only isolated mode keeps a PYTHONPATH sitecustomize.py from running at interpreter startup, before
# any line here, and it ignores every PYTHON* variable (PYTHONPATH, PYTHONPYCACHEPREFIX, ...) that could change which
# NumPy, pinned_source or bytecode runs. Isolated mode leaves this script's directory off sys.path, so it is added back
# for the harness's own modules.
if not sys.flags.isolated:
	sys.exit("lme_official_check.py: run it with `python -I`, so nothing outside the venv can change what it imports")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json  # noqa: E402
from pathlib import Path  # noqa: E402

from pinned_source import pinned_snapshot

LME_REPO = Path.home() / ".cache" / "omp-memory-eval" / "src" / "LongMemEval"
LME_SOURCE = pinned_snapshot(LME_REPO, "9e0b455f4ef0e2ab8f2e582289761153549043fc")
sys.path.insert(0, str(LME_SOURCE / "src" / "retrieval"))
from eval_utils import evaluate_retrieval, evaluate_retrieval_turn2session  # noqa: E402

TOL = 1e-12


def official_metrics(rankings, correct_docs, corpus_ids):
    out = {}
    for k in (5, 10):
        any_, all_, ndcg = evaluate_retrieval_turn2session(rankings, correct_docs, corpus_ids, k=k)
        out[f"session.recall_any@{k}"] = any_
        out[f"session.recall_all@{k}"] = all_
        out[f"session.ndcg_any@{k}"] = ndcg
    for k in (5, 10, 50):
        _, all_, ndcg = evaluate_retrieval(rankings, correct_docs, corpus_ids, k=k)
        out[f"turn.recall_all@{k}"] = all_
        if k == 10:
            out["turn.ndcg_any@10"] = ndcg
    return out


def lme_questions(path):
    all_questions = json.loads(Path(path).read_text(encoding="utf-8"))["questions"]
    missing = [q["questionId"] for q in all_questions if "lme" not in q]
    if missing or not all_questions:
        sys.exit(f"{path}: {len(missing)}/{len(all_questions)} questions lack `lme` (first: {missing[:5]})")
    return all_questions


def compare(path):
    questions = lme_questions(path)
    mismatches = 0
    for q in questions:
        lme = q["lme"]
        official = official_metrics(lme["rankings"], lme["correctDocs"], lme["corpusIds"])
        if set(official) != set(q["metrics"]):
            print(f"MISMATCH {q['questionId']} keys: ours={sorted(q['metrics'])} official={sorted(official)}")
            mismatches += 1
            continue
        for key, theirs in official.items():
            ours = q["metrics"][key]
            if not abs(ours - theirs) <= TOL:  # NaN-safe: NaN compares false, so counts as a mismatch
                print(f"MISMATCH {q['questionId']} {key}: ours={ours!r} official={theirs!r}")
                mismatches += 1
    print(f"{path}: {len(questions)} questions, {mismatches} mismatches")
    return mismatches == 0


def oracle_from_cases(path):
    """Official run_retrieval.py oracle: gold indices first, then the rest, both in corpus order."""
    questions = lme_questions(path)
    sums = {}
    capable = capable_perfect = 0
    for q in questions:
        corpus_ids, correct = q["lme"]["corpusIds"], set(q["lme"]["correctDocs"])
        rankings = [i for i, c in enumerate(corpus_ids) if c in correct] + [
            i for i, c in enumerate(corpus_ids) if c not in correct
        ]
        scores = official_metrics(rankings, list(correct), corpus_ids)
        for key, value in scores.items():
            sums[key] = sums.get(key, 0.0) + value
        gold_sessions = {"_".join(c.split("_")[:-1]) for c in correct}
        if len(gold_sessions) <= 5:
            capable += 1
            capable_perfect += scores["session.recall_all@5"] == 1.0
    n = len(questions)
    for key, total in sums.items():
        print(f"{key}: mean {total / n:.6f}")
    over = n - capable
    print(f"questions {n}; <=5 gold sessions {capable} (scoring 1.0: {capable_perfect}); >5 gold sessions {over}")
    expected = sums["session.recall_all@5"] == capable
    print(f"session.recall_all@5 sum {sums['session.recall_all@5']:.0f}/{n} (= attainable {capable}/{n})")
    return capable == capable_perfect and expected


def main():
    args = sys.argv[1:]
    oracle = "--oracle-from-cases" in args
    paths = [a for a in args if a != "--oracle-from-cases"]
    if len(paths) != 1:
        sys.exit(__doc__)
    ok = oracle_from_cases(paths[0]) if oracle else compare(paths[0])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
