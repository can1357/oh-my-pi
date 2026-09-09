#!/usr/bin/env python3
"""Root-level embedded Python API cases over the real ``omp`` host."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

COVERS = {
	"py": [
		"omp.AbortKind",
		"omp.Aborted",
		"omp.AccountScope",
		"omp.ActivateReason",
		"omp.AgentUrl",
		"omp.Api",
		"omp.ApiLevelError",
		"omp.ArgsRejected",
		"omp.ArtifactCorrupt",
		"omp.ArtifactError",
		"omp.ArtifactLifetime",
		"omp.ArtifactNotFound",
		"omp.ArtifactNotText",
		"omp.ArtifactReader",
		"omp.ArtifactRef",
		"omp.ArtifactStat",
		"omp.ArtifactUrl",
		"omp.ArtifactWriter",
		"omp.AudioFormat",
		"omp.AuthMode",
		"omp.AuthSpec",
		"omp.Authority",
		"omp.Availability",
		"omp.AvailabilityDelta",
		"omp.BlobPart",
		"omp.BlobRef",
		"omp.Bucket",
		"omp.Budget",
		"omp.CANCEL_GRACE",
		"omp.CacheRetention",
		"omp.CallOutcome",
		"omp.CancelledError",
		"omp.Cap",
		"omp.CapabilityError",
		"omp.CatalogAlias",
		"omp.ChatCaps",
		"omp.ClientPath",
		"omp.CodecProfile",
		"omp.Coerce",
		"omp.CompatFlags",
		"omp.Completion",
		"omp.ConstraintFallback",
		"omp.ConstraintKind",
		"omp.Context",
		"omp.ContextSpec",
		"omp.Cost",
		"omp.CostClass",
		"omp.CostTier",
		"omp.Credential",
		"omp.CredentialKind",
		"omp.CredentialMeta",
		"omp.CredentialSource",
		"omp.Cursor",
		"omp.DeadlineExceeded",
		"omp.DeclarationDrift",
		"omp.DeclarationLimit",
		"omp.DeclarationRegistry",
		"omp.DeclarationSealed",
		"omp.DeclarationSnapshot",
		"omp.Detached",
		"omp.Device",
		"omp.DeviceError",
		"omp.DeviceInfo",
		"omp.DeviceNameError",
		"omp.DeviceUnavailable",
		"omp.Dialect",
		"omp.Dimensions",
		"omp.DiscoveryDefaults",
		"omp.DiscoveryKind",
		"omp.DiscoveryPage",
		"omp.DiscoveryQuery",
		"omp.DiscoverySpec",
		"omp.DocEffects",
		"omp.DocsBudgetError",
		"omp.DocsMode",
		"omp.Done",
		"omp.DuplicateRegistration",
		"omp.Durability",
		"omp.Duration",
		"omp.DynamicDeviceParent",
		"omp.Effects",
		"omp.EffectsNotAuthorized",
		"omp.Effort",
		"omp.EmulationPolicy",
		"omp.EntryId",
		"omp.EnvPath",
		"omp.EnvUnavailable",
		"omp.Example",
		"omp.ExecEffects",
		"omp.ExtensionError",
		"omp.Facet",
		"omp.Fault",
		"omp.Faulted",
		"omp.Field",
		"omp.FrameTooLarge",
		"omp.GrammarSyntax",
		"omp.GroupBy",
		"omp.HARD_SLOT_BUDGET",
		"omp.HEALTH_TIMEOUT",
		"omp.HistoryUrl",
		"omp.HostDisconnected",
		"omp.HostedTool",
		"omp.ImageCaps",
		"omp.ImageFeature",
		"omp.ImageFormat",
		"omp.ImageRequest",
		"omp.ImageResult",
		"omp.InferenceEffects",
		"omp.InvocationPhase",
		"omp.JobRef",
		"omp.JournalEntry",
		"omp.JournalError",
		"omp.JsonPart",
		"omp.LifecyclePhase",
		"omp.LiftedCall",
		"omp.LoginRequest",
		"omp.LogprobCaps",
		"omp.MAX_DECLARATIONS",
		"omp.MAX_FRAME_BYTES",
		"omp.ManagementSpec",
		"omp.ManifestError",
		"omp.MismatchPolicy",
		"omp.Modality",
		"omp.ModelCard",
		"omp.ModelClass",
		"omp.ModelEvent",
		"omp.ModelOverlay",
		"omp.ModelPatch",
		"omp.ModelSpec",
		"omp.MountSpec",
		"omp.NegotiationPolicy",
		"omp.NotWiredError",
		"omp.OAuthFlow",
		"omp.OAuthFlowKind",
		"omp.OAuthSpec",
		"omp.Ok",
		"omp.OmpError",
		"omp.Operation",
		"omp.OperationSpec",
		"omp.PHASE_LEGALITY_MATRIX",
		"omp.Pagination",
		"omp.PlacementError",
		"omp.Precedence",
		"omp.PrecedenceConflict",
		"omp.Price",
		"omp.PriceUnit",
		"omp.Principal",
		"omp.PrincipalResolution",
		"omp.PromptCacheCaps",
		"omp.PromptContext",
		"omp.PromptFingerprint",
		"omp.ProviderHandle",
		"omp.ProviderSpec",
		"omp.QuotaExceeded",
		"omp.RUNTIME_METADATA",
		"omp.RealtimeCaps",
		"omp.RealtimeCredentialRef",
		"omp.RealtimeEagerness",
		"omp.RealtimeEndpointRef",
		"omp.RealtimeFeature",
		"omp.RealtimeModality",
		"omp.RealtimeRequest",
		"omp.RealtimeSession",
		"omp.RealtimeTurnDetectionMode",
		"omp.ReasoningCaps",
		"omp.RedirectTrust",
		"omp.RefreshBehavior",
		"omp.RefreshReason",
		"omp.RefreshRequest",
		"omp.RestartReason",
		"omp.RouteLimits",
		"omp.RouteSpec",
		"omp.Router",
		"omp.SHUTDOWN_GRACE",
		"omp.SchemaError",
		"omp.Scheme",
		"omp.SchemeInfo",
		"omp.ScopedAlias",
		"omp.Secret",
		"omp.SecretKind",
		"omp.SecretMode",
		"omp.SecretRule",
		"omp.ServerStateCaps",
		"omp.ServiceTier",
		"omp.Setting",
		"omp.SettingKind",
		"omp.SignRequest",
		"omp.SpecError",
		"omp.SpeechCaps",
		"omp.SpeechFeature",
		"omp.SpeechRequest",
		"omp.SpeechResult",
		"omp.ThinkingMode",
		"omp.ThinkingSpec",
		"omp.TokenPlacement",
		"omp.ToolCaps",
		"omp.ToolConstraint",
		"omp.ToolFeature",
		"omp.ToolPath",
		"omp.ToolSchemaFlavor",
		"omp.TranscriptionCaps",
		"omp.TranscriptionFeature",
		"omp.TranscriptionRequest",
		"omp.TranscriptionResult",
		"omp.Transport",
		"omp.TrustDomain",
		"omp.TurnDetection",
		"omp.UnknownCapabilityPolicy",
		"omp.WarningCode",
		"omp.index",
		"omp.packages",
	],
	"rpc": [],
}


def _run_extension(fixture: str, arguments: dict):
	with extension_fixture(f"root/{fixture}") as directory:
		return drive(
			call("hello", arguments),
			"done",
			prompt="exercise the extension tool",
			extensions=[directory],
			timeout=45,
		)


def _structured_tool_result(result) -> dict:
	for event in result.of_type("turn_end"):
		for tool_result in event.get("toolResults", []):
			for part in tool_result.get("content", []):
				text = part.get("text", "")
				if text.startswith("{"):
					return json.loads(text)
	raise AssertionError(f"structured tool result missing from events: {result.stdout[-500:]}")


class PyRoot(unittest.TestCase):
	"""Root re-exports and the root-level callback ABI."""

	def test_all_root_exports_exist_in_the_live_host(self):
		report = introspect(COVERS["py"], timeout=90)
		self.assertEqual(set(report), set(COVERS["py"]))
		missing = {symbol: status for symbol, status in report.items() if status != "ok"}
		self.assertEqual(missing, {})

	def test_hard_tool_round_trips_result(self):
		result = _run_extension(
			"hard-tool",
			{"value": "root-tool-417"},
		)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertEqual(result.mock["served"], 2)
		self.assertIn("echo:root-tool-417:chars=13", str(result.mock["captures"][1]))

	def test_context_fields_are_bound_inside_a_tool(self):
		result = _run_extension(
			"context",
			{"label": "context-913"},
		)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		report = _structured_tool_result(result)
		self.assertEqual(report["label"], "context-913")
		self.assertTrue(report["is_context"])
		self.assertEqual(report["extension"], "qaext")
		self.assertTrue(report["session"])
		self.assertGreaterEqual(report["generation"], 0)
		if report["turn"] is not None:
			self.assertGreaterEqual(report["turn"], 0)
		self.assertIsNone(report["event"])
		self.assertTrue(report["call"])
		self.assertTrue(report["device"])
		if report["roots"]:
			self.assertEqual(report["root"], report["roots"][0])
		else:
			self.assertIsNone(report["root"])
		self.assertEqual(report["headless"], not report["has_ui"])
	def test_payload_and_fault_subclasses_construct_inside_a_tool(self):
		result = _run_extension(
			"payload-subclasses",
			{"label": "root-payload-638"},
		)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		report = _structured_tool_result(result)
		self.assertEqual(report["payload"], "root-payload-638")
		self.assertEqual(report["fault"], "root-fault-638")
		self.assertTrue(report["payload_type"])
		self.assertTrue(report["fault_type"])
		self.assertTrue(report["payload_terminate"])
		self.assertFalse(report["fault_terminate"])

	def test_payload_and_fault_results_round_trip_to_the_model(self):
		with extension_fixture("root/payload-results") as directory:
			payload_result = drive(
				call("hello", value="returned-payload-229"),
				"done",
				extensions=[directory],
				timeout=45,
			)
			fault_result = drive(
				call("hello", value="returned-fault-229", fault=True),
				"done",
				extensions=[directory],
				timeout=45,
			)
		for result, marker in (
			(payload_result, "returned-payload-229"),
			(fault_result, "returned-fault-229"),
		):
			self.assertFalse(result.timed_out)
			self.assertEqual(result.exit_code, 0, result.stderr)
			self.assertEqual(result.mock["served"], 2)
			self.assertNotIn("invalid structured result JSON", result.stderr)
			self.assertIn(marker, str(result.mock["captures"][1]))

	@unittest.expectedFailure
	def test_observe_hook_dispatch_preserves_its_tool_result(self):
		"""Ledger: declaring any hook corrupts results from the extension's tools."""
		with extension_fixture("root/observe-hook") as directory:
			result = drive(
				call("hello", value="hook-tool-result-751"),
				"done",
				extensions=[directory],
				timeout=45,
			)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		report = _structured_tool_result(result)
		self.assertEqual(report["activation"]["event"], "extension_activate")
		self.assertEqual(report["activation"]["extension"], "qaext")
		self.assertEqual(report["value"], "hook-tool-result-751")
		self.assertNotIn("invalid structured result JSON", result.stderr)


if __name__ == "__main__":
	unittest.main()
