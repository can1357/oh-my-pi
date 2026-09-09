#!/usr/bin/env python3
"""Embedded Python telemetry API cases over the real ``omp`` binary."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

COVERS = {
	"py": [
		"omp.telemetry.BATCH_MAX",
		"omp.telemetry.CapabilityDegraded",
		"omp.telemetry.Compaction",
		"omp.telemetry.ContextSnapshot",
		"omp.telemetry.Cost",
		"omp.telemetry.Counter",
		"omp.telemetry.DEFAULT_MAX_BYTES",
		"omp.telemetry.DEFAULT_MAX_COLUMN",
		"omp.telemetry.DEFAULT_MAX_LINES",
		"omp.telemetry.Degradation",
		"omp.telemetry.DegradeAction",
		"omp.telemetry.DropStats",
		"omp.telemetry.Envelope",
		"omp.telemetry.Eq",
		"omp.telemetry.Event",
		"omp.telemetry.ExportError",
		"omp.telemetry.ExportHandle",
		"omp.telemetry.ExportStats",
		"omp.telemetry.ExportTarget",
		"omp.telemetry.ExtensionRef",
		"omp.telemetry.FileTarget",
		"omp.telemetry.Histogram",
		"omp.telemetry.IssueReport",
		"omp.telemetry.Kind",
		"omp.telemetry.MAX_CARDINALITY",
		"omp.telemetry.MAX_INSTRUMENTS",
		"omp.telemetry.METRIC_PREFIX",
		"omp.telemetry.ModelRequest",
		"omp.telemetry.OtlpTarget",
		"omp.telemetry.Overflow",
		"omp.telemetry.Predicate",
		"omp.telemetry.ProcessTarget",
		"omp.telemetry.PromptFingerprint",
		"omp.telemetry.PromptSlotFingerprint",
		"omp.telemetry.QUERY_LIMIT_MAX",
		"omp.telemetry.QUEUE_DEFAULT",
		"omp.telemetry.QUEUE_MAX",
		"omp.telemetry.Query",
		"omp.telemetry.QueryError",
		"omp.telemetry.QueryResult",
		"omp.telemetry.RevMetrics",
		"omp.telemetry.Row",
		"omp.telemetry.SPILL_BYTES",
		"omp.telemetry.SPILL_COLUMN",
		"omp.telemetry.SPILL_LINES",
		"omp.telemetry.Scope",
		"omp.telemetry.SessionEnd",
		"omp.telemetry.SessionStart",
		"omp.telemetry.Span",
		"omp.telemetry.Step",
		"omp.telemetry.StopReason",
		"omp.telemetry.SubscriptionError",
		"omp.telemetry.TelemetryError",
		"omp.telemetry.Tokens",
		"omp.telemetry.TraceRef",
		"omp.telemetry.TurnEnd",
		"omp.telemetry.TurnStart",
		"omp.telemetry.attributes",
		"omp.telemetry.counter",
		"omp.telemetry.dropped",
		"omp.telemetry.export",
		"omp.telemetry.flush",
		"omp.telemetry.histogram",
		"omp.telemetry.query",
		"omp.telemetry.rev_metrics",
		"omp.telemetry.semconv",
		"omp.telemetry.span",
	],
	"rpc": [],
}


def _drive_extension(fixture: str):
	project = Path(tempfile.mkdtemp(prefix="omp-qa-telemetry-"))
	with extension_fixture(f"telemetry/{fixture}") as directory:
		result = drive(
			call("hello"),
			"done",
			extensions=[directory],
			project=project,
			keep=True,
			timeout=120,
		)
	return project, result


def _tool_result_text(result) -> str:
	for event in result.of_type("turn_end"):
		for tool_result in event.get("toolResults", ()):
			if tool_result.get("toolName") == "hello" and not tool_result.get("isError"):
				return tool_result["content"][0]["text"]
	raise AssertionError(f"successful hello result missing: {result.stdout}{result.stderr}")


class PyTelemetry(unittest.TestCase):
	def test_all_inventory_symbols_resolve_in_live_host(self):
		report = introspect(COVERS["py"])
		self.assertEqual(set(report), set(COVERS["py"]))
		self.assertEqual(set(report.values()), {"ok"}, report)

	def test_data_families_construct_and_round_trip_inside_tool(self):
		project, result = _drive_extension("construction")
		try:
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			report = json.loads(_tool_result_text(result))
			self.assertEqual(report["uncached"], 6)
			self.assertEqual(report["usd"], 1.0)
			self.assertEqual(report["drops"], 2)
			self.assertEqual(report["query"], "mock")
			self.assertEqual(report["metrics_rev"], "hello@qaext.1")
			self.assertEqual(report["targets"], ["OtlpTarget", "ProcessTarget", "FileTarget"])
			self.assertEqual(len(report["events"]), 9)
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_subscription_admits_and_delivers_model_request(self):
		"""An admitted telemetry subscription delivers matching model request events."""
		project, result = _drive_extension("subscription")
		try:
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			admission = json.loads(_tool_result_text(result))
			self.assertGreaterEqual(admission["delivered"], 0)
			marker = project / "telemetry-delivered.json"
			self.assertTrue(marker.exists(), "admitted subscription received no model_request event")
			event = json.loads(marker.read_text())
			self.assertEqual(event["kind"], "model_request")
			self.assertEqual(event["served_model"], "mock")
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_rev_metrics_is_callable_from_tool(self):
		"""Telemetry revision metrics are callable from an extension tool."""
		project, result = _drive_extension("rev-metrics")
		try:
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			report = json.loads(_tool_result_text(result))
			self.assertIsInstance(report["rows"], int)
		finally:
			shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
	unittest.main()
