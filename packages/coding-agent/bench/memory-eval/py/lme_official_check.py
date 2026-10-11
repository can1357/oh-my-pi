"""Check our LongMemEval metrics against the official evaluator (Layer 0 check 4).

Usage (venv-lme python, numpy<2 because the official code uses np.asfarray):
    lme_official_check.py <result.json>                       exit 0 iff every metric matches within 1e-12
    lme_official_check.py <result.json> --oracle-from-cases   score the official oracle ranking on our loaded cases
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".cache" / "omp-memory-eval" / "src" / "LongMemEval" / "src" / "retrieval"))
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
    questions = [q for q in json.loads(Path(path).read_text())["questions"] if "lme" in q]
    if not questions:
        sys.exit(f"{path}: no question carries `lme`")
    return questions


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
            if abs(ours - theirs) > TOL:
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


main()
