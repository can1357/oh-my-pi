"""Mnemosyne 4.0.0b4 engine for the memory-eval harness, driven over JSON lines.

Request:  {"id": number, "op": string, "params": object}  (one per stdin line)
Response: {"id": number, "result": ...} or {"id": number, "error": string}  (one per stdout line)

Run with venv-engine's python. The TS client (engines/mnemosyne.ts) sets the MNEMOSYNE_* environment before spawn:
embedding settings are read when mnemosyne is imported, so one process serves one protocol.
"""

import importlib.metadata
import json
import logging
import os
import sys
import traceback

EXPECTED_VERSION = "4.0.0b4"

# Only protocol lines may reach the real stdout: keep a private copy of fd 1, then point fd 1 and sys.stdout at stderr
# so library prints, logging and native writes cannot corrupt the stream.
PROTOCOL_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
logging.basicConfig(stream=sys.stderr)
sys.stdin.reconfigure(encoding="utf-8")

try:
	VERSION = importlib.metadata.version("mnemosyne-memory")
except importlib.metadata.PackageNotFoundError:
	VERSION = "not installed"
if VERSION != EXPECTED_VERSION:
	sys.exit(f"mnemosyne-memory {EXPECTED_VERSION} is required, found {VERSION}")

from mnemosyne.core import embeddings  # noqa: E402
from mnemosyne.core.beam import BeamMemory  # noqa: E402


RANKED_TIERS = ("working", "episodic")


class Engine:
	def __init__(self):
		self.beam = None
		self.dropped_tier_rows = 0

	def op_describe(self, _params):
		info = {
			"mnemosyne_version": VERSION,
			"embedding_model": embeddings._DEFAULT_MODEL,
			"embeddings_available": str(embeddings.available()).lower(),
			"dropped_tier_rows": str(self.dropped_tier_rows),
		}
		info.update({key: value for key, value in os.environ.items() if key.startswith("MNEMOSYNE_") and value})
		return info

	def op_warmup(self, _params):
		if embeddings.available():
			embeddings.embed(["warmup"])

	def op_open(self, params):
		self.op_close(None)
		self.beam = BeamMemory(session_id="eval", db_path=params["storePath"])

	def op_remember(self, params):
		return [
			self.beam.remember(item["content"], source=item["source"], importance=item["importance"])
			for item in params["items"]
		]

	def op_vector_count(self, _params):
		return self.beam.conn.execute("SELECT COUNT(*) FROM memory_embeddings").fetchone()[0]

	def op_sleep(self, _params):
		self.beam.sleep(force=True)

	def op_recall(self, params):
		query, k = params["query"], params["k"]
		rows = self.beam.recall(query, top_k=k)
		ranked = []
		dropped = []
		for rank, row in enumerate(rows):
			if len(ranked) == k:
				break
			if row["tier"] in RANKED_TIERS:
				ranked.append(row)
				continue
			# The spec ranks working and episodic rows only; derived rows in the native top k are dropped but recorded.
			self.dropped_tier_rows += 1
			dropped.append(
				{"tier": row["tier"], "engine_id": row["id"], "source_memory_id": row.get("source_memory_id"), "rank": rank}
			)
		# Derived rows took native slots: double top_k until k working/episodic rows are ranked or Mnemosyne runs out of
		# rows (upstream's recall_with_evidence_pack likewise widens, then filters tiers). A wider call scores larger
		# candidate pools and can reorder rows, so it only appends rows the native top k did not rank.
		seen = {(row["tier"], row["id"]) for row in ranked}
		fetch = k
		while len(ranked) < k and len(rows) >= fetch:
			fetch *= 2
			rows = self.beam.recall(query, top_k=fetch)
			for row in rows:
				if len(ranked) == k:
					break
				key = (row["tier"], row["id"])
				if row["tier"] in RANKED_TIERS and key not in seen:
					seen.add(key)
					ranked.append(row)
		return {"hits": [self.hit(row) for row in ranked], "dropped": dropped, "fetch_k": fetch}

	def hit(self, row):
		summary_of = []
		if row["tier"] == "episodic":
			found = self.beam.conn.execute("SELECT summary_of FROM episodic_memory WHERE id=?", (row["id"],)).fetchone()
			summary_of = [part for part in ((found and found["summary_of"]) or "").split(",") if part]
		return {"engine_id": row["id"], "tier": row["tier"], "content": row["content"], "summary_of": summary_of}

	def op_close(self, _params):
		if self.beam is not None:
			self.beam.conn.close()
			self.beam = None

	# Used only by the upstream-compat protocol.
	def op_oldest_working(self, params):
		rows = self.beam.conn.execute(
			"SELECT id, content FROM working_memory WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?",
			(self.beam.session_id, params["limit"]),
		).fetchall()
		return [{"engine_id": row["id"], "content": row["content"]} for row in rows]

	def op_consolidate(self, params):
		memory_id = self.beam.consolidate_to_episodic(
			summary=params["summary"],
			source_wm_ids=params["ids"],
			source=params["source"],
			importance=params["importance"],
			scope=params["scope"],
		)
		self.beam.conn.commit()
		return memory_id

	def op_recall_raw(self, params):
		rows = self.beam.recall(params["query"], top_k=params["k"])[: params["k"]]
		debug_path = os.environ.get("MEMORY_EVAL_DEBUG_SCORES")
		if debug_path:
			# Calibration debugging only: lets a reordering between Run A and Run B be told apart from a tie.
			debug_rows = [
				{"score": row.get("score"), "tier": row.get("tier"), "id": row["id"], "content": row["content"][:60]}
				for row in rows
			]
			with open(debug_path, "a", encoding="utf-8") as debug_file:
				debug_file.write(json.dumps({"query": params["query"], "rows": debug_rows}) + "\n")
		return [row["content"] for row in rows]


def main():
	engine = Engine()
	for line in sys.stdin:
		if not line.strip():
			continue
		request = json.loads(line)
		try:
			handler = getattr(engine, f"op_{request['op']}", None)
			if handler is None:
				raise ValueError(f"unknown op {request['op']!r}")
			response = {"id": request["id"], "result": handler(request.get("params") or {})}
		except Exception:
			# The traceback goes in the response too: the client's stderr tail may not have caught up with it yet.
			detail = traceback.format_exc().rstrip()
			print(detail, file=sys.stderr)
			response = {"id": request["id"], "error": detail}
		PROTOCOL_OUT.write(json.dumps(response) + "\n")
		PROTOCOL_OUT.flush()


if __name__ == "__main__":
	main()
