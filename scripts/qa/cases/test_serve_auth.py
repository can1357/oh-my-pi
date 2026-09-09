#!/usr/bin/env python3
"""Durable gRPC spec cases for the auth service."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from contextlib import contextmanager
from unittest import mock

COVERS: dict[str, list[str]] = {
	"py": [],
	"rpc": [
		"omp.auth.v1.Auth/ListCredentials",
		"omp.auth.v1.Auth/WatchCredentials",
		"omp.auth.v1.Auth/BeginLogin",
		"omp.auth.v1.Auth/SubmitCode",
		"omp.auth.v1.Auth/WaitLogin",
		"omp.auth.v1.Auth/PutApiKey",
		"omp.auth.v1.Auth/PutAwsCredential",
		"omp.auth.v1.Auth/ImportOAuth",
		"omp.auth.v1.Auth/RefreshCredential",
		"omp.auth.v1.Auth/DisableCredential",
		"omp.auth.v1.Auth/EnableCredential",
		"omp.auth.v1.Auth/DeleteCredential",
		"omp.auth.v1.Auth/RevealCredential",
		"omp.auth.v1.Auth/ReportBlock",
		"omp.auth.v1.Auth/ClearBlocks",
		"omp.auth.v1.Auth/GetUsage",
		"omp.auth.v1.Auth/MarkUsageStale",
		"omp.auth.v1.Auth/GetUsageHistory",
		"omp.auth.v1.Auth/GetClientUsage",
		"omp.auth.v1.Auth/ProbeCredentials",
		"omp.auth.v1.Auth/MintScopedToken",
	],
}

try:
	import grpc
except ImportError:
	grpc = None

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if grpc is not None:
	try:
		from grpcsupport import ServeSession, stub_dir  # noqa: E402

		_generated = stub_dir()
		sys.path.insert(0, str(_generated))
		from omp.auth.v1 import auth_pb2, auth_pb2_grpc  # noqa: E402
	except Exception:  # stale grpcio / protobuf runtime / codegen failure
		grpc = None

if grpc is None:
	class ServeAuthUnavailable(unittest.TestCase):
		@unittest.skip("grpcio unavailable; run via uv run --with grpcio")
		def test_grpcio_required(self):
			pass
else:
	_TIMEOUT = 10
	_PROVIDER = "openrouter"
	_API_KEY = "qa-fake-openrouter-key"


	@contextmanager
	def auth_server():
		with mock.patch.dict("os.environ", {"OMP_LLM_KEY_SOURCE": "local-file"}):
			server = ServeSession()
			try:
				with server:
					yield server
			finally:
				if server.process is not None and server.process.stderr is not None:
					server.process.stderr.close()


	class ServeAuth(unittest.TestCase):
		"""Auth metadata, ingress, lifecycle, usage, and streaming contracts."""

		def assert_rpc_code(self, code, operation):
			with self.assertRaises(grpc.RpcError) as caught:
				operation()
			self.assertEqual(caught.exception.code(), code, caught.exception.details())
			return caught.exception

		def put_api_key(self, stub):
			meta = stub.PutApiKey(
				auth_pb2.PutApiKeyRequest(provider=_PROVIDER, api_key=_API_KEY),
				timeout=_TIMEOUT,
			)
			self.assertEqual(meta.provider, _PROVIDER)
			self.assertEqual(meta.kind, auth_pb2.CredentialMeta.KIND_API_KEY)
			self.assertEqual(meta.state, auth_pb2.CredentialMeta.STATE_ACTIVE)
			self.assertNotEqual(meta.id, 0)
			return meta

		def test_api_key_metadata_lifecycle_and_reveal_contract(self):
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				empty = stub.ListCredentials(auth_pb2.ListCredentialsRequest(), timeout=_TIMEOUT)
				self.assertEqual(list(empty.credentials), [])

				meta = self.put_api_key(stub)
				listed = stub.ListCredentials(
					auth_pb2.ListCredentialsRequest(provider=_PROVIDER), timeout=_TIMEOUT
				)
				self.assertEqual(len(listed.credentials), 1)
				self.assertEqual(listed.credentials[0].id, meta.id)
				self.assertEqual(listed.credentials[0].kind, auth_pb2.CredentialMeta.KIND_API_KEY)

				disabled = stub.DisableCredential(
					auth_pb2.DisableCredentialRequest(id=meta.id, cause="qa operator pause"),
					timeout=_TIMEOUT,
				)
				self.assertEqual(disabled.state, auth_pb2.CredentialMeta.STATE_DISABLED)
				self.assertEqual(disabled.disabled_cause, "qa operator pause")
				enabled = stub.EnableCredential(
					auth_pb2.EnableCredentialRequest(id=meta.id), timeout=_TIMEOUT
				)
				self.assertEqual(enabled.state, auth_pb2.CredentialMeta.STATE_ACTIVE)

				refresh = self.assert_rpc_code(
					grpc.StatusCode.FAILED_PRECONDITION,
					lambda: stub.RefreshCredential(
						auth_pb2.RefreshCredentialRequest(id=meta.id), timeout=_TIMEOUT
					),
				)
				self.assertIn("Authentication", refresh.details())

				denied = self.assert_rpc_code(
					grpc.StatusCode.PERMISSION_DENIED,
					lambda: stub.RevealCredential(
						auth_pb2.RevealCredentialRequest(
							id=meta.id,
							provider=_PROVIDER,
							extension="qa",
							caller_principal="qa-client",
							host_generation=1,
							session_generation=1,
							request_id=1,
							reason="exercise unauthenticated CONTROL boundary",
						),
						timeout=_TIMEOUT,
					),
				)
				self.assertIn("authenticated CONTROL", denied.details())

				stub.DeleteCredential(
					auth_pb2.DeleteCredentialRequest(id=meta.id), timeout=_TIMEOUT
				)
				after = stub.ListCredentials(
					auth_pb2.ListCredentialsRequest(provider=_PROVIDER), timeout=_TIMEOUT
				)
				self.assertEqual(list(after.credentials), [])

				for call in (
					lambda: stub.RefreshCredential(auth_pb2.RefreshCredentialRequest(), timeout=_TIMEOUT),
					lambda: stub.DisableCredential(auth_pb2.DisableCredentialRequest(), timeout=_TIMEOUT),
					lambda: stub.EnableCredential(auth_pb2.EnableCredentialRequest(), timeout=_TIMEOUT),
					lambda: stub.DeleteCredential(auth_pb2.DeleteCredentialRequest(), timeout=_TIMEOUT),
				):
					self.assert_rpc_code(grpc.StatusCode.NOT_FOUND, call)

		def test_aws_and_oauth_ingress_round_trips(self):
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				aws = stub.PutAwsCredential(
					auth_pb2.PutAwsCredentialRequest(
						provider="aws",
						identity="qa-aws",
						access_key_id=b"qa-access",
						secret_access_key=b"qa-secret",
						session_token=b"qa-session",
					),
					timeout=_TIMEOUT,
				)
				self.assertEqual(aws.kind, auth_pb2.CredentialMeta.KIND_AWS)
				self.assertEqual(aws.identity, "qa-aws")

				oauth = stub.ImportOAuth(
					auth_pb2.ImportOAuthRequest(
						provider=_PROVIDER,
						refresh_token="qa-refresh",
						access_token="qa-access",
						identity="qa-oauth",
						expires_at_ms=int(time.time() * 1000) + 300_000,
					),
					timeout=_TIMEOUT,
				)
				self.assertEqual(oauth.kind, auth_pb2.CredentialMeta.KIND_OAUTH)
				self.assertEqual(oauth.identity, "qa-oauth")

				listed = stub.ListCredentials(auth_pb2.ListCredentialsRequest(), timeout=_TIMEOUT)
				by_id = {credential.id: credential for credential in listed.credentials}
				self.assertEqual(by_id[aws.id].kind, auth_pb2.CredentialMeta.KIND_AWS)
				self.assertEqual(by_id[oauth.id].kind, auth_pb2.CredentialMeta.KIND_OAUTH)

		def test_import_oauth_rejects_missing_required_material(self):
			"""ImportOAuth rejects requests missing required provider and token material."""
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.ImportOAuth(
						auth_pb2.ImportOAuthRequest(), timeout=_TIMEOUT
					),
				)

		def test_login_orchestration_noninteractive_contracts(self):
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				started = stub.BeginLogin(
					auth_pb2.BeginLoginRequest(provider=_PROVIDER), timeout=_TIMEOUT
				)
				self.assertTrue(started.flow_id)
				self.assertEqual(started.WhichOneof("step"), "browse")
				self.assertTrue(started.browse.url.startswith(("http://", "https://")))

				for operation in (
					lambda: stub.SubmitCode(
						auth_pb2.SubmitCodeRequest(flow_id="missing-flow", code="qa-code"),
						timeout=_TIMEOUT,
					),
					lambda: stub.WaitLogin(
						auth_pb2.WaitLoginRequest(flow_id="missing-flow"), timeout=_TIMEOUT
					),
				):
					error = self.assert_rpc_code(grpc.StatusCode.NOT_FOUND, operation)
					self.assertIn("auth flow not found", error.details())

		def test_probe_and_scoped_token_replay(self):
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				meta = self.put_api_key(stub)

				probe = stub.ProbeCredentials(
					auth_pb2.ProbeCredentialsRequest(provider=_PROVIDER, strict=False),
					timeout=_TIMEOUT,
				)
				self.assertEqual(len(probe.credentials), 1)
				self.assertEqual(probe.credentials[0].credential_id, meta.id)
				self.assertEqual(probe.credentials[0].provider, _PROVIDER)

				request = auth_pb2.MintScopedTokenRequest(
					provider=_PROVIDER, facet="realtime", session_id="qa-session-1"
				)
				first = stub.MintScopedToken(request, timeout=_TIMEOUT)
				second = stub.MintScopedToken(request, timeout=_TIMEOUT)
				self.assertTrue(first.token)
				self.assertGreater(first.expires_at_ms, int(time.time() * 1000))
				self.assertEqual(second.token, first.token)
				self.assertEqual(second.expires_at_ms, first.expires_at_ms)

				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.MintScopedToken(
						auth_pb2.MintScopedTokenRequest(), timeout=_TIMEOUT
					),
				)

		def test_blocks_usage_and_typed_usage_preconditions(self):
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				meta = self.put_api_key(stub)
				until_ms = int(time.time() * 1000) + 60_000
				blocked = stub.ReportBlock(
					auth_pb2.ReportBlockRequest(
						id=meta.id,
						block=auth_pb2.Block(scope="realtime", until_ms=until_ms),
					),
					timeout=_TIMEOUT,
				)
				self.assertEqual([block.scope for block in blocked.blocks], ["realtime"])
				cleared = stub.ClearBlocks(
					auth_pb2.ClearBlocksRequest(id=meta.id, scopes=["realtime"]),
					timeout=_TIMEOUT,
				)
				self.assertEqual(list(cleared.blocks), [])

				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.ReportBlock(
						auth_pb2.ReportBlockRequest(id=meta.id), timeout=_TIMEOUT
					),
				)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.ClearBlocks(auth_pb2.ClearBlocksRequest(), timeout=_TIMEOUT),
				)

				stub.MarkUsageStale(
					auth_pb2.MarkUsageStaleRequest(provider=_PROVIDER, credential_id=meta.id),
					timeout=_TIMEOUT,
				)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.MarkUsageStale(
						auth_pb2.MarkUsageStaleRequest(), timeout=_TIMEOUT
					),
				)

				usage = self.assert_rpc_code(
					grpc.StatusCode.FAILED_PRECONDITION,
					lambda: stub.GetUsage(
						auth_pb2.GetUsageRequest(provider=_PROVIDER, credential_id=meta.id),
						timeout=_TIMEOUT,
					),
				)
				self.assertIn("usage", usage.details().lower())

				history = self.assert_rpc_code(
					grpc.StatusCode.FAILED_PRECONDITION,
					lambda: stub.GetUsageHistory(
						auth_pb2.GetUsageHistoryRequest(credential_id=meta.id),
						timeout=_TIMEOUT,
					),
				)
				self.assertIn("GetUsage", history.details())
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.GetUsageHistory(
						auth_pb2.GetUsageHistoryRequest(), timeout=_TIMEOUT
					),
				)

				client = self.assert_rpc_code(
					grpc.StatusCode.FAILED_PRECONDITION,
					lambda: stub.GetClientUsage(
						auth_pb2.GetClientUsageRequest(since_ms=0), timeout=_TIMEOUT
					),
				)
				self.assertIn("per-client usage accounting", client.details())

		def test_watch_credentials_observes_mutation(self):
			"""WatchCredentials streams credential store mutations after its initial reset."""
			with auth_server() as server:
				stub = auth_pb2_grpc.AuthStub(server.channel)
				stream = stub.WatchCredentials(
					auth_pb2.WatchCredentialsRequest(), timeout=_TIMEOUT
				)
				reset = next(stream)
				self.assertEqual(reset.WhichOneof("event"), "reset")
				meta = self.put_api_key(stub)
				upserted = next(stream)
				self.assertEqual(upserted.WhichOneof("event"), "upserted")
				self.assertEqual(upserted.upserted.id, meta.id)


if __name__ == "__main__":
	unittest.main()
