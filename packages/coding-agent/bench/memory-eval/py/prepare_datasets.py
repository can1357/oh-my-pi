"""Download the pinned BEAM and LongMemEval files into ~/.cache/omp-memory-eval/data/.

Run with venv-engine's python. Each output gets a `<file>.revision` marker holding the revision it was downloaded at;
run.ts refuses data whose marker is missing or not its pinned revision. Idempotent: an output whose marker matches the
pinned revision is skipped, any other is downloaded again.
"""

import os
import sys

# First, before any import that searches PYTHONPATH: an override tree could supply a downloader that ignores the
# pinned revision or a converter that changes the data, which would then be published under the pinned marker.
for name in ("PYTHONPATH", "PYTHONHOME"):
	if os.environ.get(name):
		sys.exit(f"prepare_datasets.py: refusing to run with {name} set; unset it so venv-engine's packages are imported")

import ast  # noqa: E402
import json  # noqa: E402
import tempfile  # noqa: E402
from collections import Counter  # noqa: E402
from pathlib import Path  # noqa: E402

import pyarrow.parquet as pq  # noqa: E402
from huggingface_hub import hf_hub_download  # noqa: E402

DATA = Path.home() / ".cache" / "omp-memory-eval" / "data"

BEAM_REPO = "Mohammadta/BEAM"
BEAM_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03"
LME_REPO = "xiaowu0162/longmemeval-cleaned"
LME_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f"
LME_FILE = "longmemeval_s_cleaned.json"


def fetch(repo: str, filename: str, revision: str) -> str:
	return hf_hub_download(repo, filename, repo_type="dataset", revision=revision, cache_dir=DATA.parent / "hf")


def convert_beam(parquet_path: str) -> list[dict]:
	rows = []
	for row in pq.read_table(parquet_path).to_pylist():
		questions = row["probing_questions"]
		if isinstance(questions, str):
			questions = ast.literal_eval(questions)
		chat = [
			[{"id": m["id"], "role": m["role"], "content": m["content"]} for m in batch]
			for batch in row["chat"]
		]
		rows.append(
			{
				"conversationId": str(row["conversation_id"]),
				"chat": chat,
				"probingQuestions": questions,
			}
		)
	return rows


def marker(out: Path) -> Path:
	return out.with_name(f"{out.name}.revision")


def read_current(out: Path, revision: str) -> str | None:
	"""The cached file's text when its marker records `revision`; None when either is missing or stale."""
	try:
		if marker(out).read_text(encoding="utf-8").strip() != revision:
			return None
		return out.read_text(encoding="utf-8")
	except FileNotFoundError:
		return None


def publish(out: Path, text: str, revision: str) -> None:
	"""Replaces `out` with `text` and only then records `revision`.

	The old marker goes first, so neither an interrupted refresh nor a concurrent run can take the new
	or partial data for the old revision; the data lands by atomic rename from a staging file of its own.
	"""
	marker(out).unlink(missing_ok=True)
	# shortcut: two setups racing on one cache can still leave the later marker over the earlier data; lock if that is ever run.
	with tempfile.NamedTemporaryFile(
		"w", encoding="utf-8", dir=out.parent, prefix=f".{out.name}.", delete=False
	) as staging:
		staging.write(text)
	os.replace(staging.name, out)
	marker(out).write_text(revision + "\n", encoding="utf-8")


def write_beam(name: str, split: str) -> list[dict]:
	out = DATA / name
	cached = read_current(out, BEAM_REVISION)
	if cached is not None:
		return json.loads(cached)
	rows = convert_beam(fetch(BEAM_REPO, f"data/{split}-00000-of-00001.parquet", BEAM_REVISION))
	publish(out, json.dumps(rows, ensure_ascii=False), BEAM_REVISION)
	return rows


def main() -> None:
	DATA.mkdir(parents=True, exist_ok=True)

	beam = write_beam("beam-100k.json", "100K")
	kinds = Counter()
	count = 0
	for row in beam:
		for qs in row["probingQuestions"].values():
			for q in qs:
				count += 1
				ids = q.get("source_chat_ids")
				kinds["none" if ids is None else type(ids).__name__] += 1
	print(
		f"beam: {len(beam)} conversations, {count} questions "
		f"(source_chat_ids list={kinds['list']} dict={kinds['dict']} none={kinds['none']})"
	)

	beam500 = write_beam("beam-500k.json", "500K")
	count500 = sum(len(qs) for row in beam500 for qs in row["probingQuestions"].values())
	print(f"beam-500k: {len(beam500)} conversations, {count500} questions")

	lme = DATA / "lme-s.json"
	text = read_current(lme, LME_REVISION)
	if text is None:
		text = Path(fetch(LME_REPO, LME_FILE, LME_REVISION)).read_text(encoding="utf-8")
		publish(lme, text, LME_REVISION)
	print(f"lme: {len(json.loads(text))} questions")


if __name__ == "__main__":
	main()
