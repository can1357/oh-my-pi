#!/usr/bin/env python3
"""Python ``omp.agents`` spec cases over the real extension host."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import OMP_BINARY, call, drive, extension_fixture, introspect  # noqa: E402

COVERS = {
	"py": [
		"omp.agents.AfterIdle",
		"omp.agents.AgentGone",
		"omp.agents.AgentKind",
		"omp.agents.AgentRef",
		"omp.agents.AgentStatus",
		"omp.agents.AgentsError",
		"omp.agents.At",
		"omp.agents.Budget",
		"omp.agents.Completion",
		"omp.agents.CompletionFailed",
		"omp.agents.ConcurrencyExhausted",
		"omp.agents.Conflict",
		"omp.agents.ContinuationLedger",
		"omp.agents.ContinuationPolicy",
		"omp.agents.Continue",
		"omp.agents.Cron",
		"omp.agents.DEFAULT_CONTINUATION_CAP",
		"omp.agents.DEFAULT_MAX_CONCURRENCY",
		"omp.agents.DEFAULT_MAX_DEPTH",
		"omp.agents.Delivery",
		"omp.agents.DeliveryMode",
		"omp.agents.DepthExceeded",
		"omp.agents.EMPTY_OUTPUT_RETRY_CAP",
		"omp.agents.Every",
		"omp.agents.Firing",
		"omp.agents.Inject",
		"omp.agents.Isolation",
		"omp.agents.LoopSignal",
		"omp.agents.MAILBOX_CAPACITY",
		"omp.agents.MAX_BACKFILL",
		"omp.agents.MIN_SCHEDULE_INTERVAL",
		"omp.agents.MergeMode",
		"omp.agents.Message",
		"omp.agents.MissedRunPolicy",
		"omp.agents.ModelSwitchDenied",
		"omp.agents.PolicyDenied",
		"omp.agents.Progress",
		"omp.agents.Receipt",
		"omp.agents.RestoreReport",
		"omp.agents.RestoreScope",
		"omp.agents.RewindPending",
		"omp.agents.RewindReport",
		"omp.agents.RewindTarget",
		"omp.agents.RunStatus",
		"omp.agents.STEER_GRACE",
		"omp.agents.Schedule",
		"omp.agents.ScheduleBudget",
		"omp.agents.ScheduleHandle",
		"omp.agents.ScheduleRejected",
		"omp.agents.ScheduleScope",
		"omp.agents.SessionInjectionDenied",
		"omp.agents.Settle",
		"omp.agents.Snapshot",
		"omp.agents.SnapshotUnsupported",
		"omp.agents.Spawn",
		"omp.agents.SpawnDenied",
		"omp.agents.SpawnLimits",
		"omp.agents.SubagentHandle",
		"omp.agents.SubagentResult",
		"omp.agents.SubagentSpec",
		"omp.agents.ThinkingLevel",
		"omp.agents.TimerHandle",
		"omp.agents.Trigger",
		"omp.agents.UpgradePolicy",
		"omp.agents.Usage",
		"omp.agents.WorktreeOutcome",
		"omp.agents.abort",
		"omp.agents.broadcast",
		"omp.agents.completion",
		"omp.agents.continuations",
		"omp.agents.depth",
		"omp.agents.get",
		"omp.agents.inbox",
		"omp.agents.inject",
		"omp.agents.is_idle",
		"omp.agents.limits",
		"omp.agents.list",
		"omp.agents.loop_signal",
		"omp.agents.peers",
		"omp.agents.pending_messages",
		"omp.agents.reload_extensions",
		"omp.agents.restore",
		"omp.agents.revive",
		"omp.agents.rewind",
		"omp.agents.rewind_targets",
		"omp.agents.schedule",
		"omp.agents.schedules",
		"omp.agents.send",
		"omp.agents.set_continuation_policy",
		"omp.agents.set_model",
		"omp.agents.shutdown",
		"omp.agents.snapshot",
		"omp.agents.snapshots",
		"omp.agents.spawn",
		"omp.agents.spawn_all",
		"omp.agents.timer",
		"omp.agents.unschedule",
		"omp.agents.wait_for",
		"omp.agents.wait_for_idle",
	],
	"rpc": [],
}


def tool_json(result) -> dict:
	"""Decode the JSON returned by the extension tool from its settled turn."""
	for event in result.of_type("turn_end"):
		for tool in event.get("toolResults", []):
			for part in tool.get("content", []):
				text = part.get("text", "")
				if text.startswith("{"):
					return json.loads(text)
	raise AssertionError(f"missing JSON tool result: {result.stdout}{result.stderr}")


class AgentSurface(unittest.TestCase):
	"""Live-host existence and representative value-family coverage."""

	def test_all_symbols_and_registration_surfaces_resolve(self):
		self.assertEqual(len(COVERS["py"]), 99)
		resolved = introspect(COVERS["py"], timeout=90)
		self.assertEqual(set(resolved), set(COVERS["py"]))
		self.assertEqual(
			{symbol: state for symbol, state in resolved.items() if state != "ok"},
			{},
		)
		project = Path(tempfile.mkdtemp(prefix="omp-qa-agents-meta-proj-"))
		try:
			with extension_fixture(
				"agents/introspection",
				params={"symbols": COVERS["py"]},
			) as directory:
				result = drive(
					call("hello"),
					"done",
					prompt="inspect the agents surface",
					extensions=[directory],
					project=project,
					keep=True,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			report = tool_json(result)
			self.assertEqual(set(report["resolved"]), set(COVERS["py"]))
			self.assertEqual(
				{symbol: state for symbol, state in report["resolved"].items() if state != "ok"},
				{},
			)
			self.assertEqual(
				report["registrations"],
				{"async_calls": True, "steering": True, "scheduling": True},
			)
			self.assertEqual(report["representatives"]["spawn"], ["Probe", 0, 3])
			self.assertEqual(report["representatives"]["schedule"], ["qa-schedule", "Spawn", "injected", 4])
			self.assertEqual(report["representatives"]["messaging"], ["hello", "aside"])
			self.assertEqual(report["representatives"]["time_travel"], [2, "thread"])
			self.assertEqual(result.mock["served"], 2)
		finally:
			shutil.rmtree(project, ignore_errors=True)


class AgentSpawn(unittest.TestCase):
	"""A tool-owned child must materialize, yield, settle, and round-trip."""

	@unittest.expectedFailure
	def test_tool_spawns_and_awaits_structured_child(self):
		"""Ledger: extension tool hosts still have no CONTROL request bridge for agents.spawn."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-agents-spawn-proj-"))
		data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-agents-spawn-data-"))
		try:
			with extension_fixture("agents/spawn") as directory:
				result = drive(
					call("hello"),
					call("yield", result={"data": {"token": "child-settled-7319"}}),
					"parent received the child settlement",
					prompt="call hello once and use its child result",
					loop=True,
					extensions=[directory],
					project=project,
					data_dir=data_dir,
					keep=True,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			report = tool_json(result)
			self.assertNotIn("error", report, report.get("error"))
			handle = report["handle"]
			settled = report["result"]
			self.assertTrue(handle["steer_registered"])
			self.assertEqual(handle["session_id"], settled["session_id"])
			self.assertEqual(handle["run_id"], settled["run_id"])
			self.assertEqual(settled["status"], "completed")
			self.assertEqual(settled["data"], {"token": "child-settled-7319"})
			self.assertEqual(handle["output_url"], settled["output_url"])
			self.assertEqual(handle["transcript_url"], settled["transcript_url"])
			session_files = list(data_dir.glob("projects/*/sessions/*.jsonl"))
			self.assertIn(handle["session_id"], {path.stem for path in session_files})
			self.assertGreaterEqual(len(session_files), 2, "parent and child journals must materialize")
			follow_up_wire = str(result.mock["captures"])
			self.assertIn("child-settled-7319", follow_up_wire)
			self.assertIn(handle["session_id"], follow_up_wire)
		finally:
			shutil.rmtree(project, ignore_errors=True)
			shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}; run the existing debug build first")
	unittest.main()
