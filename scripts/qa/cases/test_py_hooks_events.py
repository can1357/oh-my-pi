#!/usr/bin/env python3
"""Embedded Python hook decisions, dispatch, and event-catalog spec cases."""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

HOOK_SYMBOLS = [
	"omp.hooks.APPROVAL_DEADLINE",
	"omp.hooks.Allow",
	"omp.hooks.ApprovalKind",
	"omp.hooks.ApprovalRoute",
	"omp.hooks.ApprovalSpec",
	"omp.hooks.CallOrigin",
	"omp.hooks.CallTarget",
	"omp.hooks.Channel",
	"omp.hooks.Composition",
	"omp.hooks.CoreTool",
	"omp.hooks.DEFAULT_HOOK_TIMEOUT",
	"omp.hooks.Defer",
	"omp.hooks.Deny",
	"omp.hooks.DeviceCall",
	"omp.hooks.HookContractError",
	"omp.hooks.HookDecision",
	"omp.hooks.HookPhase",
	"omp.hooks.HostShuttingDown",
	"omp.hooks.LateRegistration",
	"omp.hooks.LatencyClass",
	"omp.hooks.McpCall",
	"omp.hooks.Modify",
	"omp.hooks.OnFailure",
	"omp.hooks.PhaseConflict",
	"omp.hooks.PolicyScope",
	"omp.hooks.ReentrancyError",
	"omp.hooks.RequireApproval",
	"omp.hooks.TargetKind",
	"omp.hooks.UNSET",
	"omp.hooks.UnknownEvent",
	"omp.hooks.Unreachable",
	"omp.hooks.When",
	"omp.hooks.dispatch_hook",
	"omp.hooks.hook",
]
EVENT_SYMBOLS = [
	"omp.events.EVENT_IDS",
	"omp.events.default_decision",
	"omp.events.field_composition",
	"omp.events.spec",
	"omp.events.specs",
]
COVERS = {"py": HOOK_SYMBOLS + EVENT_SYMBOLS, "rpc": []}


class PyHooksEvents(unittest.TestCase):
	"""Public ``omp.hooks`` and ``omp.events`` contracts in the live host."""

	def test_symbols_resolve_in_live_runtime(self):
		report = introspect(COVERS["py"], timeout=90)
		self.assertEqual(
			{k: v for k, v in report.items() if v != "ok"},
			{},
			"documented hook/event symbols must resolve in the embedded runtime",
		)

	def test_decisions_targets_and_event_catalog_have_public_wire_shapes(self):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-hooks-"))
		try:
			with extension_fixture("hooks/decisions") as directory:
				result = drive(
					call("hello"),
					"done",
					prompt="exercise hook decision values",
					extensions=[directory],
					project=project,
					timeout=60,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			follow_up = str(result.mock["captures"][1])
			self.assertIn("hooks-decisions-ok", follow_up)
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_precheck_deny_blocks_tool_execution(self):
		"""A denying precheck hook blocks the tool before it executes."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-hooks-deny-"))
		try:
			with extension_fixture("hooks/precheck-deny") as directory:
				result = drive(
					call("bash", command="touch denied-command-ran", i="deny probe"),
					"done",
					extensions=[directory],
					project=project,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertFalse(project.joinpath("denied-command-ran").exists())
			self.assertIn("blocked by qa hook", str(result.mock["captures"][1]))
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_transform_modify_rewrites_tool_arguments(self):
		"""A transform-phase Modify decision rewrites the arguments the tool receives."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-hooks-modify-"))
		try:
			with extension_fixture("hooks/transform-modify") as directory:
				result = drive(
					call("bash", command="printf original > hook-output", i="modify probe"),
					"done",
					extensions=[directory],
					project=project,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(project.joinpath("hook-output").read_text(), "modified")
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_observe_hook_fires_after_tool_outcome(self):
		"""An observation-only hook fires without changing the tool outcome."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-hooks-observe-"))
		try:
			with extension_fixture("hooks/observe") as directory:
				result = drive(
					call("bash", command="true", i="observe probe"),
					call("hello"),
					"done",
					extensions=[directory],
					project=project,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			follow_up = str(result.mock["captures"][2])
			self.assertIn("observed", follow_up)
			self.assertIn("true", follow_up.lower())
		finally:
			shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
	unittest.main()
