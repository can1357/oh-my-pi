"""Write lme-dev-subset.json: 100 LongMemEval-S question ids, deterministic.

Run with venv-engine's python. Scored set = not `_abs` and at least one user turn with has_answer.
Takes all single-session-assistant ids plus, for each other type, the 19 ids with the smallest
sha256(question_id).
"""

# First: the script's own directory precedes PYTHONPATH on sys.path, so this import cannot be shadowed, and it runs
# prepare_datasets' guard against import overrides before anything else is imported.
from prepare_datasets import DATA as DATA_DIR, LME_REVISION, read_current  # isort: skip

import hashlib  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

DATA = DATA_DIR / "lme-s.json"
OUT = Path(__file__).resolve().parent.parent / "lme-dev-subset.json"
PER_TYPE = 19
KEEP_ALL = "single-session-assistant"


def scored(q: dict) -> bool:
	if q["question_id"].endswith("_abs"):
		return False
	return any(t.get("has_answer") for s in q["haystack_sessions"] for t in s if t["role"] == "user")


by_type: dict[str, list[str]] = {}
text = read_current(DATA, LME_REVISION)
if text is None:
	sys.exit(f"{DATA}: not the pinned revision {LME_REVISION} (or its marker does not match the data); re-run prepare_datasets.py")
for q in json.loads(text):
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
