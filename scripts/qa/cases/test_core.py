#!/usr/bin/env python3
"""Core lifecycle spec cases for the real `omp` binary.

Run the whole suite with ``python3 scripts/qa/run.py``; see
``scripts/qa/README.md``. Cases encode EXPECTED behavior; known product gaps
carry ``@unittest.expectedFailure`` with a ``Ledger:`` docstring.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import OMP_BINARY, call, drive, raw_call  # noqa: E402
# Core cases exercise the print/session surface, not the coverage targets.
COVERS: dict[str, list[str]] = {"py": [], "rpc": []}


class ToolLoop(unittest.TestCase):
	"""Scripted tool call → real envd execution → scripted final turn."""

	def test_smoke_tool_loop_executes_and_exits(self):
		# Ledger: Cluster B (exit) — the loop itself passed pre-fix.
		result = drive(
			call("bash", command="echo qa-case-ok", i="Running case command"),
			"done",
			prompt="run echo qa-case-ok",
		)
		self.assertFalse(result.timed_out, "print must exit after agent_end (Cluster B)")
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertTrue(result.of_type("agent_end"), "terminal agent_end missing")
		self.assertIn("qa-case-ok", result.stdout, "tool stdout must reach the event stream")
		self.assertEqual(result.mock["served"], 2, "exactly two model requests expected")

	def test_tool_result_reaches_next_model_request(self):
		result = drive(
			call("bash", command="echo marker-7391", i="Running case command"),
			"saw it",
			prompt="echo the marker",
		)
		follow_up = result.mock["captures"][1]
		self.assertIn("marker-7391", str(follow_up), "tool output missing from follow-up request")

	def test_toolcall_events_are_wellformed(self):
		# Ledger: Cluster C — duplicate starts / id-less deltas.
		result = drive(call("bash", command="true", i="Running case command"), "done")
		starts = result.of_type("tool_execution_start")
		self.assertEqual(
			len(starts), 1, f"tool_execution_start must fire once per call, saw {len(starts)}"
		)
		deltas = [e for e in result.assistant_events() if e.get("type") == "toolcall_delta"]
		self.assertTrue(deltas, "expected toolcall deltas")
		for delta in deltas:
			self.assertIn("toolCallId", delta, f"id-less toolcall_delta: {delta}")


class Lifecycle(unittest.TestCase):
	"""Process termination contracts. Ledger: Cluster B."""

	def test_exits_after_terminal_provider_error(self):
		result = drive(dead_endpoint=True, timeout=45)
		self.assertFalse(result.timed_out, "print must exit after a terminal turn error")
		self.assertNotEqual(result.exit_code, 0, "provider failure must not exit 0")

	def test_exits_after_scenario_exhaustion(self):
		# One tool turn, no final turn: the follow-up request answers HTTP 500.
		result = drive(call("bash", command="true", i="Running case command"), timeout=45)
		self.assertFalse(result.timed_out, "print must exit after upstream 500")

	def test_max_time_terminates_the_process(self):
		result = drive(
			call("bash", command="sleep 1", i="Running case command"),
			loop=True,
			args=["--max-time", "5s"],
			timeout=25,
		)
		self.assertFalse(result.timed_out, "--max-time must terminate the process")


class Arguments(unittest.TestCase):
	"""Tool-argument settlement. Ledger: Cluster C (safety)."""

	def test_truncated_arguments_are_never_executed(self):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-proj-"))
		try:
			sentinel = project / "truncated-args-ran"
			truncated = '{"command":"touch ' + sentinel.name + '","i":"Trunc'  # unclosed document
			result = drive(
				raw_call("bash", truncated),
				"done",
				project=project,
				timeout=45,
			)
			self.assertFalse(
				sentinel.exists(), "structurally truncated arguments were AUTHORIZED AND EXECUTED"
			)
			self.assertFalse(result.timed_out, "truncated arguments must settle, not hang")
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_missing_required_arguments_settle_with_a_verdict(self):
		result = drive(
			call("bash", {}),
			"done",
			timeout=45,
		)
		self.assertFalse(result.timed_out, "missing required args must not orphan the invocation")
		self.assertGreaterEqual(
			result.mock["served"], 2, "the model must receive a typed error verdict turn"
		)


class MultiTurn(unittest.TestCase):
	"""Follow-ups and durable resume."""

	def test_follow_up_messages_apply_in_order(self):
		result = drive(
			"first",
			"second",
			prompt="one",
			args=["--follow-up", "two"],
		)
		self.assertEqual(result.mock["served"], 2)
		self.assertIn("two", str(result.mock["captures"][1]), "follow-up text missing")

	def test_resume_replays_the_durable_session(self):
		data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-data-"))
		project = Path(tempfile.mkdtemp(prefix="omp-qa-proj-"))
		try:
			first = drive(
				"remember lemon-42",
				prompt="say lemon-42",
				data_dir=data_dir,
				project=project,
				keep=True,
			)
			session = first.of_type("session")
			self.assertTrue(session, "session header event missing")
			ulid = session[0]["id"]
			second = drive(
				"recalled",
				prompt="what did you say?",
				args=["--resume", ulid],
				data_dir=data_dir,
				project=project,
				keep=True,
			)
			self.assertIn(
				"lemon-42", str(second.mock["captures"][0]), "resumed transcript missing prior turn"
			)
		finally:
			shutil.rmtree(data_dir, ignore_errors=True)
			shutil.rmtree(project, ignore_errors=True)


class ConfiguredProvider(unittest.TestCase):
	"""models.toml custom-provider contract (fixed during rig bring-up)."""

	def test_configured_model_is_visible_to_models_cli(self):
		import os
		import subprocess

		data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-data-"))
		try:
			(data_dir / "models.toml").write_text(
				'[providers.mock]\nbaseUrl = "http://127.0.0.1:9/v1"\nauth = "none"\n\n'
				'[providers.mock.models.mock]\nname = "Mock Model"\napi = "openai-completions"\n'
				"supportsTools = true\n"
			)
			listing = subprocess.run(
				[str(OMP_BINARY), "models"],
				env={**os.environ, "OMP_DATA_DIR": str(data_dir)},
				capture_output=True,
				text=True,
				timeout=30,
			)
			self.assertIn("mock", listing.stdout, "configured model missing from `omp models`")
		finally:
			shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}; run `cargo build --bin omp` first")
	unittest.main()
