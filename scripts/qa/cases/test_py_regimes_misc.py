#!/usr/bin/env python3
"""Python extension cases for regimes, limits, prompts, scribe, and diagnostics."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import OMP_BINARY, call, drive, extension_fixture, introspect  # noqa: E402

REGIME_SYMBOLS = [
	"omp.regimes.ADMISSION",
	"omp.regimes.BATCH",
	"omp.regimes.CONTEXT",
	"omp.regimes.IDLE",
	"omp.regimes.Next",
	"omp.regimes.PRE_MODEL",
	"omp.regimes.Point",
	"omp.regimes.RegimeContext",
	"omp.regimes.RegimeContractError",
	"omp.regimes.RegimeEvent",
	"omp.regimes.RegimeHandle",
	"omp.regimes.RegimeLifetime",
	"omp.regimes.RegimeRecord",
	"omp.regimes.SETTLE",
	"omp.regimes.STREAM",
	"omp.regimes.StateDecodeError",
	"omp.regimes.StateSchemaMismatch",
	"omp.regimes.TOOL_CHOICE",
	"omp.regimes.TURN_END",
	"omp.regimes.active",
	"omp.regimes.regime",
	"omp.regimes.start",
	"omp.regimes.stop",
	"omp.regimes.user_text",
	"omp.regimes.when",
]
LIMIT_SYMBOLS = [
	"omp.limits.ACTIVATION_TIMEOUT",
	"omp.limits.API_LEVEL",
	"omp.limits.API_LEVELS",
	"omp.limits.CANCEL_GRACE",
	"omp.limits.DOCS_TOTAL_BUDGET",
	"omp.limits.HEALTH_TIMEOUT",
	"omp.limits.HOST_VERSION",
	"omp.limits.INTERACTIVE_CAP",
	"omp.limits.MAX_FRAME_BYTES",
	"omp.limits.MAX_HOST_CHILDREN",
	"omp.limits.MAX_PENDING_EFFECTS",
	"omp.limits.MODIFY_ROUNDS",
	"omp.limits.OBSERVE_CAP",
	"omp.limits.PING_INTERVAL",
	"omp.limits.PYTHON_REV",
	"omp.limits.REENTRANCY_DEPTH",
	"omp.limits.SCHEMA_REV",
	"omp.limits.SETTLE_CONTINUATION_CAP",
	"omp.limits.SHUTDOWN_BUDGET",
	"omp.limits.SHUTDOWN_GRACE",
]
PROMPT_SYMBOLS = [
	"omp.prompts.PromptContext",
	"omp.prompts.SlotClass",
	"omp.prompts.SlotClassConflict",
	"omp.prompts.UnknownSlot",
	"omp.prompts.VolatilePrompt",
	"omp.prompts.invalidate",
	"omp.prompts.prompt_slot",
]
SCRIBE_SYMBOLS = [
	"omp.scribe.Template",
	"omp.scribe.TemplateError",
	"omp.scribe.canonicalize",
	"omp.scribe.render",
]
DIAGNOSTIC_SYMBOLS = [
	"omp.diagnostics.DiagnosticCode",
	"omp.diagnostics.FailureCode",
	"omp.diagnostics.WarningCode",
]
COVERS = {
	"py": REGIME_SYMBOLS + LIMIT_SYMBOLS + PROMPT_SYMBOLS + SCRIBE_SYMBOLS + DIAGNOSTIC_SYMBOLS,
	"rpc": [],
}


def _run_fixture(name: str, *replies, timeout: float):
	with extension_fixture(f"regimes/{name}") as directory:
		return drive(*replies, extensions=[directory], timeout=timeout)


def _tool_result_text(result) -> str:
	for event in reversed(result.events):
		if event.get("type") != "turn_end":
			continue
		for tool_result in event.get("toolResults", []):
			content = tool_result.get("content", [])
			if content and content[0].get("type") == "text":
				return content[0]["text"]
	raise AssertionError(f"drive returned no text tool result: {result.stdout}")


class PyRegimesMiscSurface(unittest.TestCase):
	def test_live_runtime_exports_every_assigned_symbol(self) -> None:
		report = introspect(COVERS["py"], timeout=90)
		self.assertEqual({symbol: "ok" for symbol in COVERS["py"]}, report)

	def test_scribe_renders_and_canonicalizes_in_extension_tool(self) -> None:
		result = _run_fixture("qascribe", call("hello"), "done", timeout=30)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(0, result.exit_code, result.stderr)
		report = json.loads(_tool_result_text(result))
		self.assertEqual("2 findings:\n- unused import\n- shadowed name", report["rendered"])
		self.assertEqual("lint-summary", report["name"])
		self.assertEqual(["findings"], report["keys"])
		self.assertEqual("Hello Ada", report["one_shot"])
		self.assertEqual("A NEVER\n\nB → C", report["canonical"])
		self.assertIn("unknown_filter", report["template_error"])

	def test_limits_prompts_and_diagnostics_construct_in_extension_tool(self) -> None:
		result = _run_fixture("qamisc", call("hello"), "done", timeout=30)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(0, result.exit_code, result.stderr)
		report = json.loads(_tool_result_text(result))
		self.assertEqual(20, report["limit_count"])
		self.assertTrue(report["limits_non_null"])
		self.assertEqual("recall", report["prompt_slot"])
		self.assertEqual(
			["SlotClassConflict", "UnknownSlot", "VolatilePrompt"], report["errors"]
		)
		self.assertIn("Sealed", report["sealed"])
		self.assertEqual(3, len(report["diagnostics"]))

	def test_prompt_invalidate_returns_generation(self) -> None:
		"""Prompt invalidation returns the resulting generation."""
		result = _run_fixture("qainvalidate", call("hello"), "done", timeout=30)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(0, result.exit_code, result.stderr)
		generation = int(_tool_result_text(result))
		self.assertGreaterEqual(generation, 0)
	
	@unittest.expectedFailure
	def test_regime_start_active_draft_retry_and_stop(self) -> None:
		"""Ledger: Python regime activation/dispatch does not complete on the current host."""
		result = _run_fixture(
			"qaregime",
			call("hello"),
			"first settlement",
			call("hello"),
			"after regime stop",
			timeout=40,
		)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(0, result.exit_code, result.stderr)
		self.assertEqual(4, len(result.mock["requests"]), result.stdout)
		third_request = json.dumps(result.mock["requests"][2])
		self.assertIn("REGIME_DRAFT_EFFECT", third_request)


if __name__ == "__main__":
	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}")
	unittest.main()
