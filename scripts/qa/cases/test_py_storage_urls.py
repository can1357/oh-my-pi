#!/usr/bin/env python3
"""Storage, package-index, MCP, credential, secret, and URL Python API cases."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import call, drive, extension_fixture, introspect  # noqa: E402

COVERS: dict[str, list[str]] = {
	"py": [
		"omp.creds.Credential",
		"omp.creds.CredentialKind",
		"omp.creds.CredentialMeta",
		"omp.creds.ScopedToken",
		"omp.creds.Secret",
		"omp.creds.UsageReport",
		"omp.creds.UsageScope",
		"omp.creds.clear",
		"omp.creds.disable",
		"omp.creds.enable",
		"omp.creds.import_oauth",
		"omp.creds.list",
		"omp.creds.mint_scoped",
		"omp.creds.refresh",
		"omp.creds.report_block",
		"omp.creds.reveal",
		"omp.creds.store",
		"omp.creds.usage",
		"omp.secrets.SecretKind",
		"omp.secrets.SecretMode",
		"omp.secrets.SecretRule",
		"omp.secrets.declare",
		"omp.secrets.is_masked",
		"omp.secrets.mask",
		"omp.artifacts.ArtifactCorrupt",
		"omp.artifacts.ArtifactError",
		"omp.artifacts.ArtifactNotFound",
		"omp.artifacts.ArtifactNotText",
		"omp.artifacts.ArtifactReader",
		"omp.artifacts.ArtifactStat",
		"omp.artifacts.ArtifactWriter",
		"omp.artifacts.adopt",
		"omp.artifacts.get",
		"omp.artifacts.list",
		"omp.artifacts.open",
		"omp.artifacts.open_write",
		"omp.artifacts.pin",
		"omp.artifacts.put",
		"omp.artifacts.read",
		"omp.artifacts.stat",
		"omp.artifacts.url",
		"omp.packages.ContentDeclaration",
		"omp.packages.ContentKind",
		"omp.packages.Distribution",
		"omp.packages.GrantError",
		"omp.packages.IntegrityError",
		"omp.packages.Origin",
		"omp.packages.PackageError",
		"omp.packages.Provenance",
		"omp.packages.ResolutionError",
		"omp.packages.SettingSchema",
		"omp.packages.SiteTree",
		"omp.packages.get",
		"omp.packages.list",
		"omp.packages.of",
		"omp.packages.own",
		"omp.packages.site",
		"omp.urls.AgentUrl",
		"omp.urls.ArtifactUrl",
		"omp.urls.HistoryUrl",
		"omp.urls.Scheme",
		"omp.urls.SchemeInfo",
		"omp.urls.SchemeNotReadable",
		"omp.urls.Selector",
		"omp.urls.SelectorError",
		"omp.urls.Url",
		"omp.urls.UrlError",
		"omp.urls.parse",
		"omp.urls.parse_selector",
		"omp.urls.read",
		"omp.urls.schemes",
		"omp.mcp.Http",
		"omp.mcp.McpAuth",
		"omp.mcp.McpAuthKind",
		"omp.mcp.McpMount",
		"omp.mcp.McpResource",
		"omp.mcp.McpServer",
		"omp.mcp.McpServerState",
		"omp.mcp.McpTransport",
		"omp.mcp.McpTransportKind",
		"omp.mcp.Sse",
		"omp.mcp.Stdio",
		"omp.mcp.mount",
		"omp.mcp.servers",
		"omp.mcp.unmount",
		"omp.index.CapabilityAttestation",
		"omp.index.Catalog",
		"omp.index.CatalogEntry",
		"omp.index.IdentityClaim",
		"omp.index.IndexClient",
		"omp.index.IndexError",
		"omp.index.IndexTransportError",
		"omp.index.IndexVerificationError",
		"omp.index.ResolvedClosure",
		"omp.index.SimpleFile",
		"omp.index.SimpleProject",
		"omp.index.parse_catalog",
		"omp.index.parse_closure",
		"omp.index.parse_simple_project",
	],
	"rpc": [],
}


def _run_probe(name: str, *, timeout: float = 90.0) -> tuple[dict, object]:
	project = Path(tempfile.mkdtemp(prefix="omp-qa-storage-"))
	try:
		with extension_fixture(f"storage/{name}") as directory:
			result = drive(
				call("hello"),
				"done",
				prompt="run the storage probe",
				extensions=[directory],
				project=project,
				timeout=timeout,
			)
		tool_texts: list[str] = []
		for event in result.of_type("turn_end"):
			for tool in event.get("toolResults", []):
				for part in tool.get("content", []):
					text = part.get("text", "")
					tool_texts.append(text)
					if text.startswith("{"):
						return json.loads(text), result
		raise AssertionError(
			f"probe returned no JSON result (exit={result.exit_code}, timed_out={result.timed_out}, "
			f"stderr={result.stderr[-500:]!r}, tool_results={tool_texts!r}, stdout={result.stdout[-2000:]!r})"
		)
	finally:
		shutil.rmtree(project, ignore_errors=True)


class PyStorageUrls(unittest.TestCase):
	"""Exercise the seven storage/distribution utility namespaces in a real worker."""

	def test_live_surface_introspection(self):
		report = introspect(COVERS["py"])
		self.assertEqual(set(report), set(COVERS["py"]))
		self.assertEqual(
			{name: status for name, status in report.items() if status != "ok"},
			{},
		)

	def test_pure_urls_packages_mcp_and_index_contracts(self):
		report, result = _run_probe("storagepure")
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertTrue(all(report.values()), {name: ok for name, ok in report.items() if not ok})

	def test_secret_and_credential_contracts(self):
		report, result = _run_probe("storagecredentials")
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertTrue(
			all(report["checks"].values()),
			{"failed": {name: ok for name, ok in report["checks"].items() if not ok}, "outcomes": report["outcomes"]},
		)

	def test_artifact_store_digest_address_and_io(self):
		report, result = _run_probe("storageartifacts", timeout=120)
		self.assertFalse(result.timed_out)
		self.assertEqual(result.exit_code, 0, result.stderr)
		self.assertTrue(
			all(report["checks"].values()),
			{"failed": {name: ok for name, ok in report["checks"].items() if not ok}, "outcomes": report["outcomes"]},
		)


if __name__ == "__main__":
	unittest.main()
