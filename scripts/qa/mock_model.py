#!/usr/bin/env python3
"""Standalone scripted mock model server.

	python3 scripts/qa/mock_model.py --text "serve inference works"

Prints ``MOCK_MODEL_LISTENING port=<n>`` once ready and serves until killed.
Replies use the same ordered ``--text``/``--call`` DSL as ``drive.py``.
"""

import argparse
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import MockModel  # noqa: E402
from reply_cli import add_reply_arguments, require_replies  # noqa: E402

if __name__ == "__main__":
	parser = argparse.ArgumentParser()
	add_reply_arguments(parser)
	options = parser.parse_args()
	replies = require_replies(parser, options)
	mock = MockModel(*replies, loop=options.loop)
	print(f"MOCK_MODEL_LISTENING port={mock.port}", flush=True)
	threading.Event().wait()
