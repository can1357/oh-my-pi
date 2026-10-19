"""Write lme-dev-subset.json: 100 LongMemEval-S question ids, deterministic.

Run with venv-engine's python. Scored set = not `_abs` and at least one user turn with has_answer.
Takes all single-session-assistant ids plus, for each other type, the 19 ids with the smallest
sha256(question_id).
"""

import hashlib
import json
from pathlib import Path

DATA = Path.home() / ".cache" / "omp-memory-eval" / "data" / "lme-s.json"
OUT = Path(__file__).resolve().parent.parent / "lme-dev-subset.json"
PER_TYPE = 19
KEEP_ALL = "single-session-assistant"


def scored(q: dict) -> bool:
	if q["question_id"].endswith("_abs"):
		return False
	return any(t.get("has_answer") for s in q["haystack_sessions"] for t in s if t["role"] == "user")


by_type: dict[str, list[str]] = {}
for q in json.loads(DATA.read_text(encoding="utf-8")):
	if scored(q):
		by_type.setdefault(q["question_type"], []).append(q["question_id"])

ids: list[str] = []
for qtype, qids in by_type.items():
	if qtype == KEEP_ALL:
		ids += qids
	else:
		ids += sorted(qids, key=lambda i: hashlib.sha256(i.encode()).hexdigest())[:PER_TYPE]

OUT.write_text(json.dumps(sorted(ids), indent="\t") + "\n", encoding="utf-8")
print(len(ids), {t: len(v) for t, v in by_type.items()})
