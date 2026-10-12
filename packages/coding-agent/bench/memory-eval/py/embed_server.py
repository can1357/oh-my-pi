"""Embedding server for the Mnemopi engine: Python fastembed over JSON lines on stdio.

Request:  {"id": number, "op": "embed" | "resources", "params": {...}}
Response: {"id": number, "result": ...} or {"id": number, "error": string}  (one per stdout line)

Mnemopi's JS fastembed stack embeds about 20-40x slower than Python fastembed with the same ONNX model file, which
makes full benchmark runs impractical. This serves the same model so Mnemopi's retrieval code runs unchanged.
"""

import json
import logging
import os
import sys
import traceback

# Only protocol lines may reach the real stdout: keep a private copy of fd 1, then point fd 1 and sys.stdout at stderr
# so library prints, logging and native writes cannot corrupt the stream.
PROTOCOL_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
logging.basicConfig(stream=sys.stderr)
sys.stdin.reconfigure(encoding="utf-8")

from fastembed import TextEmbedding  # noqa: E402

MODEL = os.environ["MEMORY_EVAL_EMBED_MODEL"]
CACHE_DIR = os.environ["MEMORY_EVAL_EMBED_CACHE_DIR"]


def proc_status_bytes(field: str) -> int:
	# Linux only. getrusage's ru_maxrss survives spawn/exec, so a child would report its parent's peak; /proc is per-process.
	with open("/proc/self/status", encoding="ascii") as status:
		for line in status:
			if line.startswith(f"{field}:"):
				return int(line.split()[1]) * 1024  # the value is in kB
	raise RuntimeError(f"{field} not found in /proc/self/status")


BASELINE_RSS_BYTES = proc_status_bytes("VmRSS")
EMBEDDER = TextEmbedding(MODEL, cache_dir=CACHE_DIR)


def op_embed(params):
	return [vector.tolist() for vector in EMBEDDER.embed(params["texts"])]


def op_resources(_params):
	return {"peak_rss_bytes": proc_status_bytes("VmHWM"), "baseline_rss_bytes": BASELINE_RSS_BYTES}


OPS = {"embed": op_embed, "resources": op_resources}


def main():
	for line in sys.stdin:
		if not line.strip():
			continue
		request = json.loads(line)
		try:
			handler = OPS.get(request["op"])
			if handler is None:
				raise ValueError(f"unknown op {request['op']!r}")
			response = {"id": request["id"], "result": handler(request.get("params") or {})}
		except Exception:
			detail = traceback.format_exc().rstrip()
			print(detail, file=sys.stderr)
			response = {"id": request["id"], "error": detail}
		PROTOCOL_OUT.write(json.dumps(response) + "\n")
		PROTOCOL_OUT.flush()


if __name__ == "__main__":
	main()
