"""What the harness's Python engines (mnemosyne_engine.py, embed_server.py) and Run A (upstream_run_a.py) share.

Protocol over stdio, JSON lines:
Request:  {"id": number, "op": string, "params": object}  (one per stdin line)
Response: {"id": number, "result": ...} or {"id": number, "error": string}  (one per stdout line)

Each engine keeps its own dispatch: `serve` takes a function from an op name to its handler.
"""

import importlib.metadata
import json
import logging
import os
import sys
import traceback


def isolate_stdout():
	"""Returns the stream protocol lines go to. Call it before importing anything that may write to stdout.

	Only protocol lines may reach the real stdout: this keeps a private copy of fd 1, then points fd 1 and sys.stdout at
	stderr so library prints, logging and native writes cannot corrupt the stream.
	"""
	protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
	os.dup2(2, 1)
	sys.stdout = sys.stderr
	logging.basicConfig(stream=sys.stderr)
	sys.stdin.reconfigure(encoding="utf-8")
	return protocol_out


def serve(protocol_out, handler_for):
	"""Answers each stdin request with `handler_for(op)(params)`, or an error for an unknown op or a failing handler."""
	for line in sys.stdin:
		if not line.strip():
			continue
		request = json.loads(line)
		try:
			handler = handler_for(request["op"])
			if handler is None:
				raise ValueError(f"unknown op {request['op']!r}")
			response = {"id": request["id"], "result": handler(request.get("params") or {})}
		except Exception:
			# The traceback goes in the response too: the client's stderr tail may not have caught up with it yet.
			detail = traceback.format_exc().rstrip()
			print(detail, file=sys.stderr)
			response = {"id": request["id"], "error": detail}
		protocol_out.write(json.dumps(response) + "\n")
		protocol_out.flush()


def runtime_versions(suffix=""):
	"""The numerical runtime behind the vectors: other versions can reorder near-ties."""
	return {f"{name}{suffix}": importlib.metadata.version(name) for name in ("fastembed", "onnxruntime")}


def append_debug_scores(query, rows):
	"""Calibration debugging only: lets a reordering between Run A and Run B be told apart from a tie."""
	debug_path = os.environ.get("MEMORY_EVAL_DEBUG_SCORES")
	if not debug_path:
		return
	debug_rows = [
		{"score": row.get("score"), "tier": row.get("tier"), "id": row["id"], "content": row["content"][:60]}
		for row in rows
	]
	with open(debug_path, "a", encoding="utf-8") as debug_file:
		debug_file.write(json.dumps({"query": query, "rows": debug_rows}) + "\n")
