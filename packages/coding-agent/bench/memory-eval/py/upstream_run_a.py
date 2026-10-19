"""Calibration run A: upstream Mnemosyne's own `benchmark_mnemosyne` on BEAM 100K, dumped for comparison with Run B.

Run with venv-engine's python: upstream_run_a.py --out <dump.json>

Run B is the harness's `upstream-compat` protocol (run.ts); `run.ts calibration-check` pairs the two dumps. Nothing under
the upstream checkout is modified: the module is imported as is, with four wrappers installed first:
setrlimit (clamped to the hard limit), load_dataset (pinned BEAM revision, harness cache dir), BeamMemory.recall and
BeamMemory.consolidate_to_episodic (recorded, because upstream swallows their exceptions).
"""

import argparse
import json
import os
import shutil
import statistics
import sys
import tempfile
from pathlib import Path

# Another package tree could supply Mnemosyne or its dependencies; the harness's own Python children scrub these.
for name in ("PYTHONPATH", "PYTHONHOME"):
	if os.environ.get(name):
		sys.exit(f"upstream_run_a.py: refusing to run with {name} set; unset it so the venv's packages are imported")

try:
	import resource
except ImportError:
	# Upstream's benchmark imports it unconditionally, so Run A cannot run where CPython lacks it (native Windows).
	sys.exit("upstream_run_a.py: upstream's benchmark needs the Unix-only `resource` module; run calibration on Linux, macOS or WSL")

from pinned_source import require_pinned

CACHE = Path.home() / ".cache" / "omp-memory-eval"
UPSTREAM_REPO = CACHE / "src" / "mnemosyne"
UPSTREAM_COMMIT = "e871f39480b9b9156faa4396162f7ec1f3b11525"
UPSTREAM_TESTS = UPSTREAM_REPO / "tests"
BEAM_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03"
TOP_K = 10

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
out_path = Path(parser.parse_args().out)

# The environment engines/mnemosyne.ts gives its child. Embedding settings are read when mnemosyne is imported.
for key in [key for key in os.environ if key.startswith("MNEMOSYNE_")]:
	del os.environ[key]
data_dir = tempfile.mkdtemp(prefix="mnemosyne-calib-a-")
os.environ.update(
	{
		"MNEMOSYNE_DATA_DIR": data_dir,
		"MNEMOSYNE_FASTEMBED_CACHE_DIR": str(CACHE / "fastembed"),
		"MNEMOSYNE_EMBEDDING_MODEL": "BAAI/bge-small-en-v1.5",
		"MNEMOSYNE_LLM_ENABLED": "false",
	}
)

# Import mnemosyne before upstream's `sys.path.insert(0, PROJECT_ROOT)` can run: sys.modules then pins the venv's
# installed package, the same one the harness adapter (Run B) uses, instead of the source checkout.
import mnemosyne  # noqa: E402
from mnemosyne.core.beam import BeamMemory  # noqa: E402

# Run B's adapter runs this exact package; another install or version would calibrate a different runtime.
if mnemosyne.__version__ != "4.0.0b4" or not Path(mnemosyne.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()):
	sys.exit(f"mnemosyne must be 4.0.0b4 from this venv ({sys.prefix}), got {mnemosyne.__version__} from {mnemosyne.__file__}")
print(f"mnemosyne {mnemosyne.__version__} from {mnemosyne.__file__}")

_setrlimit = resource.setrlimit


def clamped_setrlimit(which, limits):
	hard = resource.getrlimit(which)[1]
	if hard != resource.RLIM_INFINITY:
		limits = tuple(min(limit, hard) for limit in limits)
	_setrlimit(which, limits)


resource.setrlimit = clamped_setrlimit

import datasets  # noqa: E402

_load_dataset = datasets.load_dataset
datasets.load_dataset = lambda *args, **kwargs: _load_dataset(
	*args, **{**kwargs, "revision": BEAM_REVISION, "cache_dir": str(CACHE / "hf")}
)

recalls = []  # (query, contents of the first TOP_K results), one entry per completed BeamMemory.recall call
_recall = BeamMemory.recall


def recording_recall(self, query, *args, **kwargs):
	results = _recall(self, query, *args, **kwargs)
	recalls.append((query, [row["content"] for row in results[:TOP_K]]))
	debug_path = os.environ.get("MEMORY_EVAL_DEBUG_SCORES")
	if debug_path:
		# Calibration debugging only: same record as the Run B engine's, to tell a reordering from a tie.
		rows = [
			{"score": row.get("score"), "tier": row.get("tier"), "id": row["id"], "content": row["content"][:60]}
			for row in results[:TOP_K]
		]
		with open(debug_path, "a", encoding="utf-8") as debug_file:
			debug_file.write(json.dumps({"query": query, "rows": rows}) + "\n")
	return results


BeamMemory.recall = recording_recall

consolidations = []  # the returned memory id, or the exception upstream then swallows
_consolidate = BeamMemory.consolidate_to_episodic


def recording_consolidate(self, *args, **kwargs):
	try:
		memory_id = _consolidate(self, *args, **kwargs)
	except Exception as error:
		consolidations.append(error)
		raise
	consolidations.append(memory_id)
	return memory_id


BeamMemory.consolidate_to_episodic = recording_consolidate

require_pinned(UPSTREAM_REPO, UPSTREAM_COMMIT)
sys.path.insert(0, str(UPSTREAM_TESTS))
import benchmark_vs_vectordbs as up  # noqa: E402

conversations = up.load_beam_data(["100K"], max_convs=3)["100K"]
result = up.benchmark_mnemosyne(conversations, top_k=TOP_K)

if len(consolidations) != 1 or isinstance(consolidations[0], Exception):
	sys.exit(f"expected one successful consolidation, got {consolidations!r}")
if len(recalls) != len(result["recalls"]):
	sys.exit(f"{len(recalls)} recorded recalls but upstream scored {len(result['recalls'])}: a recall raised")

# Same skip rule as upstream's query loop, so each recorded call lines up with its conversation and question.
queries = [
	(index, q["question"])
	for index, conv in enumerate(conversations)
	for q in conv["questions"]
	if q["question"] and q.get("gold_message_indices")
]
if [query for _, query in queries] != [query for query, _ in recalls]:
	sys.exit("recorded recall queries do not match the questions upstream evaluates")

questions = [
	{"conversation": conversation, "question": question, "rankedContents": contents, "recall": recall}
	for (conversation, question), (_, contents), recall in zip(queries, recalls, result["recalls"])
]
mean_recall = statistics.mean(result["recalls"])
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps({"questions": questions, "meanRecall": mean_recall}), encoding="utf-8")
shutil.rmtree(data_dir, ignore_errors=True)
print(f"evaluated {len(questions)} questions, mean recall {mean_recall:.6f}")
print(f"wrote {out_path}")
