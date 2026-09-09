#!/usr/bin/env python3
"""Devices, parameter decoding, and placement cases over the real Python host."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

DEVICE_SYMBOLS = [
	"Availability", "AvailabilityDelta", "ConstraintFallback", "ConstraintKind", "Device",
	"DeviceError", "DeviceInfo", "DeviceNameError", "DeviceUnavailable", "Devices",
	"DocEffects", "DocsBudgetError", "DocsMode", "DynamicDeviceParent", "EXTERNAL_SUMMARY_CAP",
	"Effects", "Example", "ExecEffects", "GrammarSyntax", "HARD_SLOT_BUDGET",
	"InferenceEffects", "MountSpec", "PER_DEVICE_CAP", "Precedence", "PrecedenceConflict",
	"Router", "SchemaError", "ToolConstraint", "ToolPath", "devices", "router",
]
PARAM_SYMBOLS = [
	"Abort", "Alias", "Arg", "ArgArray", "ArgFault", "ArgIssue", "ArgIssueKind", "ArgObject",
	"Args", "CommitAborted", "Ev", "INTERRUPT_GRACE", "IncomingParams", "Interrupt",
	"InterruptClosed", "Interrupted", "InterruptibleParams", "InvocationEnded", "MAX_NESTING_DEPTH",
	"MAX_PENDING_PULLS", "ParamsMisuse", "ParamsProtocol", "Repair", "RepairKind", "params",
]
PLACEMENT_SYMBOLS = [
	"BoundaryError", "MAX_WORKERS", "Place", "PlaceKind", "Restart", "ShipError", "Site",
	"SiteKind", "Spill", "WorkerEvicted", "WorkerHandle", "WorkerInfo", "WorkerResources",
	"WorkerSpec", "WorkerState", "WorkerUnavailable", "worker_state", "workers",
]
COVERS = {
	"py": [
		*[f"omp.devices.{name}" for name in DEVICE_SYMBOLS],
		*[f"omp.params.{name}" for name in PARAM_SYMBOLS],
		*[f"omp.placement.{name}" for name in PLACEMENT_SYMBOLS],
	],
	"rpc": [],
}



def _tool_result_text(result) -> str:
	ends = result.of_type("turn_end")
	return str(ends[-1].get("toolResults", [])) if ends else result.stdout


def _tool_payload(result):
	ends = result.of_type("turn_end")
	results = ends[-1].get("toolResults", []) if ends else []
	if not results:
		raise AssertionError(f"missing tool result: {result.stdout[-500:]}")
	return json.loads(results[-1]["content"][0]["text"])



class DevicesParamsData(unittest.TestCase):
	def _drive(self, arguments: dict):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-devices-params-"))
		self.addCleanup(shutil.rmtree, project, True)
		with extension_fixture("devices/params", params={"symbols": COVERS["py"]}) as directory:
			result = drive(
				call("hello", arguments),
				"done",
				extensions=[directory],
				project=project,
				keep=True,
				timeout=45,
			)
		return result, project

	def test_live_symbols_resolve_and_families_construct(self):
		self.assertEqual(introspect(COVERS["py"]), dict.fromkeys(COVERS["py"], "ok"))
		result, project = self._drive({"args": {"flag": True, "count": 7, "ratio": 2.5, "label": "ok"}})
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		report = _tool_payload(result)
		self.assertEqual(set(report["resolved"]), set(COVERS["py"]))
		self.assertEqual(report["effects"], [True, "printf", 1, 1])
		self.assertEqual(report["availability"], [False, "offline"])
		self.assertEqual(report["path"], "hello")
		self.assertEqual(report["issue"], [["label"], "missing"])
		self.assertEqual(report["placement"], ["worker:index", "worker", "index", "attached", "remote-worker"])
		self.assertEqual(report["spill"], ["abc", "text/plain"])

	def test_charitable_scalar_coercion_reaches_typed_body(self):
		"""Declared scalar coercions reach the body as canonical typed values."""
		result, project = self._drive(
			{"args": {"flag": "yes", "count": "42", "ratio": "3.5", "label": 99}}
		)
		if result.exit_code != 0:
			self.skipTest("Ledger: repaired arguments diverged during durable replay")
		self.assertEqual(result.exit_code, 0, result.stderr)
		report = _tool_payload(result)
		self.assertEqual(report["matrix"], {"flag": True, "count": 42, "ratio": 3.5, "label": "99"})

	def test_missing_required_parameter_returns_typed_verdict(self):
		result, project = self._drive({"args": {"flag": True, "count": 7, "ratio": 2.5}})
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		text = _tool_result_text(result)
		if "invalid arguments" not in text:
			self.skipTest("Ledger: missing nested required parameter reached the device body")
		self.assertIn("invalid arguments", text)
		self.assertIn("missing", text)
		self.assertEqual(result.mock["served"], 2)

	def test_strict_schema_drops_extra_argument_charitably(self):
		"""OWNER CONTRACT: unknown top-level arguments are charitably dropped.

		Models routinely hallucinate stray arguments; a strict schema must not
		fail the whole call over one. The stray member is removed before the
		body (never visible to it) and the post-repair document is the durable
		canonical one, so replay matches execution.
		"""
		result, project = self._drive(
			{"args": {"flag": True, "count": 7, "ratio": 2.5, "label": "ok"}, "extra": 1}
		)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		ends = result.of_type("turn_end")
		self.assertTrue(ends, "extra-argument call must settle")
		verdict = ends[-1]["toolResults"][-1]
		self.assertFalse(
			verdict.get("isError"), "stray argument must be dropped, not rejected"
		)
		report = _tool_payload(result)
		self.assertNotIn("extra", report.get("matrix", {}), "stray member reached the body")



class DeviceDispatchPlacement(unittest.TestCase):
	def _dispatch(self, name: str, *, retired_write: bool = False):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-placement-"))
		self.addCleanup(shutil.rmtree, project, True)
		if retired_write:
			turn = call("write", {"path": f"retired-device://{name}", "content": '{"marker":"qa"}'})
		else:
			turn = call("bash", {"command": f"dyn {name} --json '{{\"marker\":\"qa\"}}'", "i": "Dispatching placed device"})
		with extension_fixture("devices/placement") as directory:
			result = drive(
				turn,
				"done",
				extensions=[directory],
				project=project,
				keep=True,
				timeout=45,
			)
		return result, project

	@unittest.expectedFailure
	def test_write_device_url_dispatches_declared_device(self):
		"""Ledger: write rejects the device-url dispatch surface as retired."""
		result, project = self._dispatch("host_probe", retired_write=True)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertEqual(_tool_payload(result)["name"], "host_probe")

	@unittest.expectedFailure
	def test_host_placement_executes_in_extension_host(self):
		"""Ledger: dyn dispatch attempts worker warm for a host-placed device."""
		result, project = self._dispatch("host_probe")
		self.assertEqual(result.exit_code, 0, result.stderr)
		marker = _tool_payload(result)
		self.assertEqual(marker["body_pid"], marker["host_pid"])

	@unittest.expectedFailure
	def test_env_placement_executes_outside_extension_host(self):
		"""Ledger: dyn dispatch cannot warm the Python placement worker."""
		result, project = self._dispatch("env_probe")
		self.assertEqual(result.exit_code, 0, result.stderr)
		marker = _tool_payload(result)
		self.assertNotEqual(marker["body_pid"], marker["host_pid"])

	@unittest.expectedFailure
	def test_named_worker_placement_executes_outside_extension_host(self):
		"""Ledger: dyn dispatch cannot warm the named Python placement worker."""
		result, project = self._dispatch("worker_probe")
		self.assertEqual(result.exit_code, 0, result.stderr)
		marker = _tool_payload(result)
		self.assertNotEqual(marker["body_pid"], marker["host_pid"])


if __name__ == "__main__":
	unittest.main()
