#!/usr/bin/env python3
"""Embedded Python policy, Bash IR, sandbox, and approval spec cases."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

POLICY_SYMBOLS = [
	"omp.policy.APPROVAL_DEADLINE",
	"omp.policy.Access",
	"omp.policy.Amend",
	"omp.policy.AndOrOp",
	"omp.policy.ApprovalDecision",
	"omp.policy.ApprovalSource",
	"omp.policy.ApprovalTicket",
	"omp.policy.BASH_IR_MAX_DEPTH",
	"omp.policy.BASH_IR_MAX_NODES",
	"omp.policy.BASH_IR_MAX_SOURCE",
	"omp.policy.BASH_IR_REV",
	"omp.policy.BashAndOrList",
	"omp.policy.BashArg",
	"omp.policy.BashAssignment",
	"omp.policy.BashCommandIR",
	"omp.policy.BashCompound",
	"omp.policy.BashFunctionDef",
	"omp.policy.BashIR",
	"omp.policy.BashNode",
	"omp.policy.BashPipeline",
	"omp.policy.BashRedirect",
	"omp.policy.BashTestExpr",
	"omp.policy.CompoundKind",
	"omp.policy.DnsPolicy",
	"omp.policy.DomainRule",
	"omp.policy.Dynamism",
	"omp.policy.EnforcementUnavailable",
	"omp.policy.ExecPolicy",
	"omp.policy.FilesystemGrade",
	"omp.policy.FilesystemPolicy",
	"omp.policy.HereDoc",
	"omp.policy.NetDirection",
	"omp.policy.NetKind",
	"omp.policy.NetRef",
	"omp.policy.NetworkGrade",
	"omp.policy.NetworkMode",
	"omp.policy.NetworkPolicy",
	"omp.policy.OpaqueEvaluator",
	"omp.policy.OpaqueReason",
	"omp.policy.POLICY_DEADLINE",
	"omp.policy.ParseError",
	"omp.policy.ParseFailure",
	"omp.policy.PathOrigin",
	"omp.policy.PathRef",
	"omp.policy.PathRule",
	"omp.policy.PolicyDenied",
	"omp.policy.PolicyError",
	"omp.policy.ProcessGrade",
	"omp.policy.ProcessSubDirection",
	"omp.policy.ProcessSubIR",
	"omp.policy.ProfileHandle",
	"omp.policy.ProfileRejected",
	"omp.policy.ProfileWidened",
	"omp.policy.Quoting",
	"omp.policy.RedirectOp",
	"omp.policy.RedirectTarget",
	"omp.policy.ResourceBudget",
	"omp.policy.RuleEffect",
	"omp.policy.RuleRef",
	"omp.policy.SandboxBackend",
	"omp.policy.SandboxCapabilities",
	"omp.policy.SandboxEnforcement",
	"omp.policy.SandboxMode",
	"omp.policy.SandboxProfile",
	"omp.policy.SandboxRequest",
	"omp.policy.SandboxSessionKind",
	"omp.policy.Separator",
	"omp.policy.Span",
	"omp.policy.TicketState",
	"omp.policy.Tier",
	"omp.policy.VIOLATION_COALESCE",
	"omp.policy.Violation",
	"omp.policy.ViolationKind",
	"omp.policy.amend",
	"omp.policy.approver",
	"omp.policy.capabilities",
	"omp.policy.decide",
	"omp.policy.effective_profile",
	"omp.policy.enforcement",
	"omp.policy.install",
	"omp.policy.match_paths",
	"omp.policy.parse",
	"omp.policy.pending",
	"omp.policy.tier_of",
]
COVERS = {"py": POLICY_SYMBOLS, "rpc": []}

def _tool_text(result) -> str:
	for event in result.of_type("turn_end"):
		for tool_result in event.get("toolResults", []):
			for part in tool_result.get("content", []):
				text = part.get("text")
				if isinstance(text, str):
					return text
	raise AssertionError(f"tool result text missing: {result.stdout[-500:]}")


class PyPolicy(unittest.TestCase):
	"""Public ``omp.policy`` contracts exercised in the live extension host."""

	def test_every_policy_symbol_is_exposed(self):
		report = introspect(POLICY_SYMBOLS)
		self.assertEqual(report, dict.fromkeys(POLICY_SYMBOLS, "ok"))

	def test_sandbox_profile_and_approval_values_serialize_through_a_tool(self):
		with extension_fixture("policy/serialize-values") as directory:
			result = drive(
				call("hello"),
				"done",
				prompt="serialize policy values",
				extensions=[directory],
				timeout=45,
			)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(result.exit_code, 0, result.stderr)
		encoded = json.loads(_tool_text(result))
		self.assertEqual(encoded["profile"]["label"], "qa-policy")
		self.assertEqual(encoded["profile"]["mode"], "enforce")
		self.assertEqual(
			encoded["profile"]["filesystem"]["deny_write"][0],
			{"create": False, "delete": True, "path": "/workspace/.git", "recursive": True},
		)
		self.assertEqual(encoded["profile"]["network"]["allow_domains"][0]["ports"], [443])
		self.assertEqual(encoded["profile"]["exec"]["deny"], ["sudo"])
		self.assertEqual(encoded["profile"]["resources"]["memory_bytes"], 1048576)
		self.assertEqual(encoded["profile"]["require"], ["seatbelt"])
		self.assertEqual(encoded["approval"]["evidence"], ["qa-rule"])
		self.assertEqual(encoded["decision"]["source"], "extension")
		self.assertTrue(encoded["decision"]["approved"])

	def test_parse_exposes_simple_commands_argv_structure_and_exact_segments(self):
		"""Policy parsing exposes command arguments, pipelines, and exact segments."""
		with extension_fixture("policy/parse-shell") as directory:
			result = drive(
				call("hello", script="echo one && printf '%s' two | cat"),
				"done",
				prompt="parse the shell program",
				extensions=[directory],
				timeout=45,
			)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(result.exit_code, 0, result.stderr)
		encoded = json.loads(_tool_text(result))
		self.assertEqual(encoded["names"], ["echo", "printf", "cat"])
		self.assertEqual(encoded["pipeline_widths"], [1, 2])
		self.assertEqual(encoded["segments"][1], "printf '%s' two")

	def test_precheck_policy_denies_a_matching_shell_invocation(self):
		"""A matching BashIR policy denial blocks execution and names its rule to the model."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-policy-deny-"))
		try:
			with extension_fixture("policy/precheck-deny") as directory:
				result = drive(
					call(
						"bash",
						command="touch policy-denied-command-ran",
						i="deny policy probe",
					),
					"done",
					extensions=[directory],
					project=project,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertFalse(project.joinpath("policy-denied-command-ran").exists())
			self.assertIn("qa_policy_deny", str(result.mock["captures"][1]))
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_approval_requirement_denies_when_no_approver_is_reachable(self):
		"""RequireApproval without a reachable approver denies and names its rule."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-policy-approval-"))
		try:
			with extension_fixture("policy/approval-required") as directory:
				result = drive(
					call(
						"bash",
						command="touch approval-denied-command-ran",
						i="approval policy probe",
					),
					"done",
					extensions=[directory],
					project=project,
					timeout=45,
				)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertFalse(project.joinpath("approval-denied-command-ran").exists())
			self.assertIn("qa-approval-rule", str(result.mock["captures"][1]))
		finally:
			shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
	unittest.main()
