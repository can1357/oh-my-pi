#!/usr/bin/env python3
"""One-shot drive of `omp print` against a scripted mock model.

	python3 scripts/qa/drive.py --call bash '{"command":"echo hi","i":"Echoing"}'
	    --text done [--prompt TEXT] [--timeout SEC] [--keep] [-- <extra omp print args>]

NDJSON events stream to stdout; ``MOCK_STATE <json>`` (captured requests) and
scratch-dir locations go to stderr. Exit code mirrors omp's (124 on timeout).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import drive  # noqa: E402
from reply_cli import add_reply_arguments, require_replies  # noqa: E402

if __name__ == "__main__":
	argv = sys.argv[1:]
	passthrough: list[str] = []
	if "--" in argv:
		split = argv.index("--")
		argv, passthrough = argv[:split], argv[split + 1 :]
	parser = argparse.ArgumentParser()
	add_reply_arguments(parser)
	parser.add_argument("--prompt", default="go")
	parser.add_argument("--timeout", type=float, default=60.0)
	parser.add_argument("--keep", action="store_true")
	options = parser.parse_args(argv)
	replies = require_replies(parser, options)

	result = drive(
		*replies,
		prompt=options.prompt,
		loop=options.loop,
		args=passthrough,
		timeout=options.timeout,
		keep=options.keep,
	)
	sys.stdout.write(result.stdout)
	sys.stderr.write(result.stderr)
	print(f"MOCK_STATE {json.dumps(result.mock)}", file=sys.stderr)
	if options.keep:
		print(f"KEPT data={result.data_dir} project={result.project}", file=sys.stderr)
	sys.exit(124 if result.timed_out else result.exit_code or 0)
