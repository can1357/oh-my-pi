#!/usr/bin/env python3
"""Embedded Python provider API spec cases over the real OMP binary."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from harness import MockModel, OMP_BINARY, call, drive, extension_fixture  # noqa: E402

COVERS = {
	"py": [
		"omp.provider.AccountScope",
		"omp.provider.Api",
		"omp.provider.AudioFormat",
		"omp.provider.AuthMethod",
		"omp.provider.AuthMode",
		"omp.provider.AuthSpec",
		"omp.provider.Availability",
		"omp.provider.CacheRetention",
		"omp.provider.Cap",
		"omp.provider.CatalogAlias",
		"omp.provider.ChatCaps",
		"omp.provider.CodecProfile",
		"omp.provider.CompatFlags",
		"omp.provider.Completion",
		"omp.provider.Confidence",
		"omp.provider.ContextSpec",
		"omp.provider.Cost",
		"omp.provider.CostTier",
		"omp.provider.Credential",
		"omp.provider.CredentialKind",
		"omp.provider.CredentialSource",
		"omp.provider.Cursor",
		"omp.provider.Dimensions",
		"omp.provider.DiscoveryDefaults",
		"omp.provider.DiscoveryKind",
		"omp.provider.DiscoveryPage",
		"omp.provider.DiscoveryQuery",
		"omp.provider.DiscoverySpec",
		"omp.provider.DiscoveryTrigger",
		"omp.provider.Effort",
		"omp.provider.EmulationPolicy",
		"omp.provider.ErrorKind",
		"omp.provider.Facet",
		"omp.provider.Failover",
		"omp.provider.FailoverKind",
		"omp.provider.Fallback",
		"omp.provider.HostedTool",
		"omp.provider.ImageCaps",
		"omp.provider.ImageFeature",
		"omp.provider.ImageFormat",
		"omp.provider.ImageRequest",
		"omp.provider.ImageResult",
		"omp.provider.Intent",
		"omp.provider.IntentKind",
		"omp.provider.LoginRequest",
		"omp.provider.LoginUi",
		"omp.provider.LogprobCaps",
		"omp.provider.ManagementSpec",
		"omp.provider.MismatchPolicy",
		"omp.provider.Modality",
		"omp.provider.ModelCard",
		"omp.provider.ModelEvent",
		"omp.provider.ModelFallback",
		"omp.provider.ModelOverlay",
		"omp.provider.ModelPatch",
		"omp.provider.ModelRef",
		"omp.provider.ModelSpec",
		"omp.provider.NegotiationPolicy",
		"omp.provider.OAuthFlow",
		"omp.provider.OAuthFlowKind",
		"omp.provider.OAuthSpec",
		"omp.provider.Operation",
		"omp.provider.Pagination",
		"omp.provider.Price",
		"omp.provider.PriceUnit",
		"omp.provider.PrincipalResolution",
		"omp.provider.PromptCacheCaps",
		"omp.provider.ProviderError",
		"omp.provider.ProviderHandle",
		"omp.provider.ProviderSpec",
		"omp.provider.RealtimeCaps",
		"omp.provider.RealtimeCredentialRef",
		"omp.provider.RealtimeEagerness",
		"omp.provider.RealtimeEndpointRef",
		"omp.provider.RealtimeFeature",
		"omp.provider.RealtimeModality",
		"omp.provider.RealtimeRequest",
		"omp.provider.RealtimeSession",
		"omp.provider.RealtimeTurnDetectionMode",
		"omp.provider.ReasoningCaps",
		"omp.provider.RedirectTrust",
		"omp.provider.RefreshBehavior",
		"omp.provider.RefreshReason",
		"omp.provider.RefreshRequest",
		"omp.provider.RequestDraft",
		"omp.provider.RequestMutation",
		"omp.provider.Retryability",
		"omp.provider.Role",
		"omp.provider.RouteLimits",
		"omp.provider.RouteRef",
		"omp.provider.RouteSpec",
		"omp.provider.ScopedAlias",
		"omp.provider.SearchPage",
		"omp.provider.SearchQuery",
		"omp.provider.SearchResult",
		"omp.provider.ServerStateCaps",
		"omp.provider.ServiceTier",
		"omp.provider.Setting",
		"omp.provider.SettingKind",
		"omp.provider.SignRequest",
		"omp.provider.Signature",
		"omp.provider.Signer",
		"omp.provider.SpecError",
		"omp.provider.SpeechCaps",
		"omp.provider.SpeechFeature",
		"omp.provider.SpeechRequest",
		"omp.provider.SpeechResult",
		"omp.provider.StreamWatchdog",
		"omp.provider.ThinkingMode",
		"omp.provider.ThinkingSpec",
		"omp.provider.TokenPlacement",
		"omp.provider.ToolCaps",
		"omp.provider.ToolFeature",
		"omp.provider.ToolSchemaFlavor",
		"omp.provider.TranscriptionCaps",
		"omp.provider.TranscriptionFeature",
		"omp.provider.TranscriptionRequest",
		"omp.provider.TranscriptionResult",
		"omp.provider.Transport",
		"omp.provider.TrustDomain",
		"omp.provider.TurnDetection",
		"omp.provider.UnknownCapabilityPolicy",
		"omp.provider.UsageQuery",
		"omp.provider.UsageReport",
		"omp.provider.UsageScope",
		"omp.provider.UsageUnit",
		"omp.provider.UsageWindow",
		"omp.provider.WatchModels",
		"omp.provider.intent",
		"omp.provider.intents",
		"omp.provider.models",
		"omp.provider.provider",
		"omp.provider.watch_models",
	],
	"rpc": [],
}


def _tool_result_json(result) -> dict:
	for event in result.of_type("turn_end"):
		for tool in event.get("toolResults", []):
			for part in tool.get("content", []):
				text = part.get("text", "")
				if text.startswith("{"):
					return json.loads(text)
	raise AssertionError(f"provider tool returned no JSON result: {result.stdout[-1000:]}")


class ProviderApi(unittest.TestCase):
	def test_all_provider_symbols_exist_in_live_runtime(self):
		report = harness.introspect(COVERS["py"], timeout=45)
		self.assertEqual(set(report), set(COVERS["py"]))
		self.assertEqual(
			{symbol: status for symbol, status in report.items() if status != "ok"},
			{},
		)

	def test_representative_provider_data_round_trips_inside_tool(self):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-provider-proj-"))
		try:
			with MockModel("unused") as probe:
				with extension_fixture(
					"provider/data",
					params={"port": probe.port},
				) as directory:
					result = drive(
						call("hello"),
						"done",
						extensions=[directory],
						project=project,
						timeout=45,
					)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			report = _tool_result_json(result)
			self.assertEqual(report["declaration"], "representative")
			self.assertEqual(report["media"], [17, 19, 23])
			self.assertEqual(report["realtime"], "session")
			self.assertEqual(report["intent"], "service_tier")
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_models_control_io_returns_resolved_cards(self):
		"""Provider model control dispatch returns the resolved model cards."""
		with extension_fixture("provider/control") as directory:
			result = drive(
				call("hello", operation="models"),
				"done",
				extensions=[directory],
				timeout=45,
			)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertIsInstance(_tool_result_json(result)["cards"], int)

	def test_intent_contributions_reach_control_host(self):
		"""Provider intent contributions reach the control host."""
		with extension_fixture("provider/control") as directory:
			result = drive(
				call("hello", operation="intents"),
				"done",
				extensions=[directory],
				timeout=45,
			)
		self.assertFalse(result.timed_out, result.stderr)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertEqual(_tool_result_json(result)["intent"], "service_tier")

	def test_dynamic_provider_model_is_listed_with_plugin_dir(self):
		"""Models activates plugin providers before listing their declared models."""
		data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-provider-data-"))
		project = Path(tempfile.mkdtemp(prefix="omp-qa-provider-proj-"))
		try:
			with MockModel("dynamic-provider-routed-ok") as probe:
				with extension_fixture(
					"provider/dynamic",
					params={"port": probe.port},
				) as directory:
					listing = subprocess.run(
						[
							str(OMP_BINARY),
							"models",
							"--json",
							"--plugin-dir",
							str(directory),
							"qa-dynamic",
						],
						cwd=project,
						env={**os.environ, "OMP_DATA_DIR": str(data_dir)},
						capture_output=True,
						text=True,
						timeout=30,
					)
			self.assertEqual(listing.returncode, 0, listing.stderr)
			self.assertIn("qa-dynamic/mock-chat", listing.stdout)
		finally:
			shutil.rmtree(data_dir, ignore_errors=True)
			shutil.rmtree(project, ignore_errors=True)

	def test_dynamic_provider_routes_inference_to_declared_endpoint(self):
		"""Provider declarations are admitted before inference model selection."""
		data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-provider-data-"))
		project = Path(tempfile.mkdtemp(prefix="omp-qa-provider-proj-"))
		try:
			with MockModel("dynamic-provider-routed-ok") as probe:
				with extension_fixture(
					"provider/dynamic",
					params={"port": probe.port},
				) as directory:
					process = subprocess.run(
						[
							str(OMP_BINARY),
							"print",
							"--mode",
							"json",
							"--yolo",
							"--no-tools",
							"--plugin-dir",
							str(directory),
							"--model",
							"qa-dynamic/mock-chat",
							"--project",
							str(project),
							"route through dynamic provider",
						],
						cwd=project,
						env={**os.environ, "OMP_DATA_DIR": str(data_dir)},
						capture_output=True,
						text=True,
						timeout=45,
					)
				self.assertEqual(process.returncode, 0, process.stderr)
				self.assertIn("dynamic-provider-routed-ok", process.stdout)
				self.assertEqual(probe.state()["served"], 1)
		finally:
			shutil.rmtree(data_dir, ignore_errors=True)
			shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
	unittest.main()
