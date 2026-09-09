#!/usr/bin/env python3
"""Inference gRPC spec cases over the real ``omp serve`` binary."""

from __future__ import annotations

import sys
import unittest
from contextlib import contextmanager
from pathlib import Path

# Keep the mechanically inspected coverage declaration importable without grpcio.
COVERS: dict[str, list[str]] = {
	"py": [],
	"rpc": [
		"omp.inference.v1.Inference/AttachGeneration",
		"omp.inference.v1.Inference/CancelGeneration",
		"omp.inference.v1.Inference/CountTokens",
		"omp.inference.v1.Inference/DeclareProvider",
		"omp.inference.v1.Inference/Detokenize",
		"omp.inference.v1.Inference/Drop",
		"omp.inference.v1.Inference/Embed",
		"omp.inference.v1.Inference/ExecuteProviderRequest",
		"omp.inference.v1.Inference/Fork",
		"omp.inference.v1.Inference/GenerateImage",
		"omp.inference.v1.Inference/GenerateVideo",
		"omp.inference.v1.Inference/GetGeneration",
		"omp.inference.v1.Inference/ListModels",
		"omp.inference.v1.Inference/ListProviders",
		"omp.inference.v1.Inference/MintProviderSession",
		"omp.inference.v1.Inference/Native",
		"omp.inference.v1.Inference/ProviderAuthenticated",
		"omp.inference.v1.Inference/ProviderCatalog",
		"omp.inference.v1.Inference/Realtime",
		"omp.inference.v1.Inference/RefreshModels",
		"omp.inference.v1.Inference/ReplaceProvider",
		"omp.inference.v1.Inference/RetractProvider",
		"omp.inference.v1.Inference/Search",
		"omp.inference.v1.Inference/Speak",
		"omp.inference.v1.Inference/Tokenize",
		"omp.inference.v1.Inference/Transcribe",
		"omp.inference.v1.Inference/Turn",
		"omp.inference.v1.Inference/Usage",
		"omp.inference.v1.Inference/WatchModels",
		"omp.inference.v1.Inference/WatchProviderCatalog",
	],
}

try:
	import grpc
except ModuleNotFoundError:
	grpc = None

if grpc is not None:
	try:
		sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
		from grpcsupport import ServeSession, stub_dir
		from harness import MockModel

		sys.path.insert(0, str(stub_dir()))
		from omp.inference.v1 import inference_pb2 as inference_pb
		from omp.inference.v1 import inference_pb2_grpc
		from omp.inference.v1 import media_pb2, models_pb2, search_pb2
		from omp.thread.v1 import thread_pb2
	except Exception:  # stale grpcio / protobuf runtime / codegen failure
		grpc = None


if grpc is None:
	class ServeInferenceUnavailable(unittest.TestCase):
		@unittest.skip("grpcio unavailable; run via uv run --with grpcio")
		def test_grpcio_required(self):
			pass
else:
	class ServeInference(unittest.TestCase):
		RPC_TIMEOUT = 10
		CONTEXT_ID = "01JQB000000000000000000001"
		FORK_ID = "01JQB000000000000000000002"
		TURN_ID = "01JQB000000000000000000101"
		MISSING_GENERATION = "01JQB000000000000000000999"

		@contextmanager
		def served(self, *replies):
			mock = MockModel(*(replies or ("serve inference works",)))
			session = ServeSession(mock_port=mock.port)
			try:
				with session:
					yield inference_pb2_grpc.InferenceStub(session.channel), mock
			finally:
				if session.process is not None and session.process.stderr is not None:
					session.process.stderr.close()
				mock.close()

		def assert_rpc_error(self, thunk, code, detail=None):
			with self.assertRaises(grpc.RpcError) as caught:
				thunk()
			error = caught.exception
			self.assertEqual(code, error.code(), error.details())
			self.assertNotEqual(grpc.StatusCode.INTERNAL, error.code(), error.details())
			if detail is not None:
				self.assertIn(detail, error.details())
			return error

		@staticmethod
		def user_thread(text="hello"):
			return thread_pb2.Thread(
				items=[
					thread_pb2.Item(
						message=thread_pb2.Message(
							role=thread_pb2.ROLE_USER,
							parts=[thread_pb2.Part(text=text)],
						)
					)
				]
			)

		def test_turn_fork_and_drop_context_lifecycle(self):
			"""A real mock-provider turn commits, forks, and explicitly drops both contexts."""
			with self.served() as (stub, mock):
				open_frame = inference_pb.TurnFrame(
					open=inference_pb.TurnRequest(
						turn_id=self.TURN_ID,
						seed=inference_pb.Seed(
							context_id=self.CONTEXT_ID,
							thread=self.user_thread("say the scripted phrase"),
						),
						params=inference_pb.ChatParams(model="mock/mock"),
					)
				)
				events = list(stub.Turn(iter([open_frame]), timeout=20))
				kinds = [event.WhichOneof("event") for event in events]
				self.assertEqual("accepted", kinds[0])
				self.assertIn("part_delta", kinds)
				self.assertEqual("outcome", kinds[-1])
				outcome = events[-1].outcome
				self.assertEqual("mock", outcome.provider)
				self.assertEqual("mock", outcome.model)
				self.assertEqual(2, outcome.revision.head)
				text = b"".join(event.part_delta.chunk for event in events if event.HasField("part_delta"))
				self.assertIn(b"serve inference works", text)
				self.assertEqual(1, mock.state()["served"])

				forked = stub.Fork(
					inference_pb.ForkRequest(
						parent=inference_pb.ContextRef(
							context_id=self.CONTEXT_ID,
							expected=outcome.revision,
						),
						context_id=self.FORK_ID,
					),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertEqual(outcome.revision.head, forked.revision.head)
				self.assertTrue(forked.revision.token)
				stub.Drop(inference_pb.DropRequest(context_id=self.FORK_ID), timeout=self.RPC_TIMEOUT)
				stub.Drop(inference_pb.DropRequest(context_id=self.CONTEXT_ID), timeout=self.RPC_TIMEOUT)

		def test_turn_fork_and_drop_reject_malformed_requests(self):
			with self.served() as (stub, _):
				self.assert_rpc_error(
					lambda: list(stub.Turn(iter(()), timeout=self.RPC_TIMEOUT)),
					grpc.StatusCode.INVALID_ARGUMENT,
				)
				self.assert_rpc_error(
					lambda: stub.Fork(inference_pb.ForkRequest(), timeout=self.RPC_TIMEOUT),
					grpc.StatusCode.INVALID_ARGUMENT,
				)
				self.assert_rpc_error(
					lambda: stub.Drop(inference_pb.DropRequest(), timeout=self.RPC_TIMEOUT),
					grpc.StatusCode.INVALID_ARGUMENT,
				)

		@unittest.expectedFailure
		def test_realtime_reports_missing_model_capability(self):
			"""Ledger: capability failures use INVALID_ARGUMENT instead of FAILED_PRECONDITION."""
			with self.served() as (stub, _):
				frame = inference_pb.RealtimeFrame(
					open=inference_pb.RealtimeOpen(
						request_id="realtime-1",
						model="mock/mock",
						modalities=[inference_pb.RealtimeOpen.MODALITY_TEXT],
					)
				)
				self.assert_rpc_error(
					lambda: list(stub.Realtime(iter([frame]), timeout=self.RPC_TIMEOUT)),
					grpc.StatusCode.FAILED_PRECONDITION,
				)

		def test_realtime_requires_an_open_frame(self):
			with self.served() as (stub, _):
				self.assert_rpc_error(
					lambda: list(stub.Realtime(iter(()), timeout=self.RPC_TIMEOUT)),
					grpc.StatusCode.INVALID_ARGUMENT,
				)

		@unittest.expectedFailure
		def test_token_utilities_report_typed_capability_errors(self):
			"""Ledger: Detokenize leaks planner CapabilityMismatch as INVALID_ARGUMENT."""
			with self.served() as (stub, _):
				calls = [
					lambda: stub.CountTokens(
						inference_pb.CountTokensRequest(model="mock/mock", thread=self.user_thread()),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: stub.Tokenize(
						inference_pb.TokenizeRequest(model="mock/mock", text="hello world"),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: stub.Detokenize(
						inference_pb.DetokenizeRequest(model="mock/mock", tokens=[1]),
						timeout=self.RPC_TIMEOUT,
					),
				]
				errors = []
				for call in calls:
					try:
						call()
					except grpc.RpcError as error:
						errors.append(error)
				self.assertEqual(3, len(errors))
				self.assertEqual(
					[grpc.StatusCode.FAILED_PRECONDITION] * 3,
					[error.code() for error in errors],
					[error.details() for error in errors],
				)
				for error in errors:
					self.assertIn("lacks required capability", error.details())

		@unittest.expectedFailure
		def test_token_utilities_validate_required_model(self):
			"""Ledger: Tokenize and Detokenize omit required-model validation."""
			with self.served() as (stub, _):
				calls = [
					lambda: stub.CountTokens(inference_pb.CountTokensRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.Tokenize(inference_pb.TokenizeRequest(text="x"), timeout=self.RPC_TIMEOUT),
					lambda: stub.Detokenize(inference_pb.DetokenizeRequest(tokens=[1]), timeout=self.RPC_TIMEOUT),
				]
				errors = []
				for call in calls:
					try:
						call()
					except grpc.RpcError as error:
						errors.append(error)
				self.assertEqual(3, len(errors))
				self.assertEqual(
					[grpc.StatusCode.INVALID_ARGUMENT] * 3,
					[error.code() for error in errors],
					[error.details() for error in errors],
				)

		@unittest.expectedFailure
		def test_embedding_and_media_facets_report_capability_errors(self):
			"""Ledger: media capability failures leak planner INVALID_ARGUMENT."""
			with self.served() as (stub, _):
				audio = thread_pb2.Blob(mime="audio/wav", size=1, inline=b"x")
				calls = [
					lambda: stub.Embed(
						inference_pb.EmbedRequest(model="mock/mock", texts=["hello"]),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: list(stub.GenerateImage(
						media_pb2.GenerateImageRequest(model="mock/mock", prompt="a blue square"),
						timeout=self.RPC_TIMEOUT,
					)),
					lambda: list(stub.Speak(
						media_pb2.SpeakRequest(model="mock/mock", text="hello", voice="alloy"),
						timeout=self.RPC_TIMEOUT,
					)),
					lambda: stub.Transcribe(
						media_pb2.TranscribeRequest(model="mock/mock", audio=audio),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: stub.GenerateVideo(
						media_pb2.GenerateVideoRequest(model="mock/mock", prompt="a blue square"),
						timeout=self.RPC_TIMEOUT,
					),
				]
				errors = []
				for call in calls:
					try:
						call()
					except grpc.RpcError as error:
						errors.append(error)
				self.assertEqual(5, len(errors))
				self.assertEqual(
					[grpc.StatusCode.FAILED_PRECONDITION] * 5,
					[error.code() for error in errors],
					[error.details() for error in errors],
				)

		def test_embedding_and_media_validate_empty_requests(self):
			with self.served() as (stub, _):
				calls = [
					lambda: stub.Embed(inference_pb.EmbedRequest(), timeout=self.RPC_TIMEOUT),
					lambda: list(stub.GenerateImage(media_pb2.GenerateImageRequest(), timeout=self.RPC_TIMEOUT)),
					lambda: list(stub.Speak(media_pb2.SpeakRequest(), timeout=self.RPC_TIMEOUT)),
					lambda: stub.Transcribe(media_pb2.TranscribeRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.GenerateVideo(media_pb2.GenerateVideoRequest(), timeout=self.RPC_TIMEOUT),
				]
				for call in calls:
					with self.subTest(call=call):
						self.assert_rpc_error(call, grpc.StatusCode.INVALID_ARGUMENT)

		def test_generation_lifecycle_reports_unknown_generation(self):
			with self.served() as (stub, _):
				calls = [
					lambda: stub.GetGeneration(
						media_pb2.GetGenerationRequest(generation_id=self.MISSING_GENERATION),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: list(stub.AttachGeneration(
						media_pb2.AttachGenerationRequest(generation_id=self.MISSING_GENERATION),
						timeout=self.RPC_TIMEOUT,
					)),
					lambda: stub.CancelGeneration(
						media_pb2.CancelGenerationRequest(generation_id=self.MISSING_GENERATION),
						timeout=self.RPC_TIMEOUT,
					),
				]
				for call in calls:
					with self.subTest(call=call):
						self.assert_rpc_error(call, grpc.StatusCode.NOT_FOUND)

		def test_generation_lifecycle_validates_id(self):
			with self.served() as (stub, _):
				calls = [
					lambda: stub.GetGeneration(media_pb2.GetGenerationRequest(), timeout=self.RPC_TIMEOUT),
					lambda: list(stub.AttachGeneration(media_pb2.AttachGenerationRequest(), timeout=self.RPC_TIMEOUT)),
					lambda: stub.CancelGeneration(media_pb2.CancelGenerationRequest(), timeout=self.RPC_TIMEOUT),
				]
				for call in calls:
					with self.subTest(call=call):
						self.assert_rpc_error(call, grpc.StatusCode.INVALID_ARGUMENT)

		@unittest.expectedFailure
		def test_search_usage_and_native_typed_failures(self):
			"""Ledger: non-chat capability failures leak planner INVALID_ARGUMENT."""
			with self.served() as (stub, _):
				native = inference_pb.NativeRequest(
					model="mock/mock",
					method=inference_pb.NativeRequest.METHOD_POST,
					path=inference_pb.NativeRequest.PATH_CHAT_COMPLETIONS,
					json=b'{"messages":[{"role":"user","content":"hello"}]}',
					framing=inference_pb.NativeRequest.FRAMING_JSON,
					max_response_bytes=65536,
				)
				calls = [
					lambda: stub.Search(
						search_pb2.SearchRequest(query="omp", engine="mock"),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: stub.Usage(
						inference_pb.UsageRequest(provider="mock"),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: list(stub.Native(native, timeout=self.RPC_TIMEOUT)),
				]
				errors = []
				for call in calls:
					try:
						call()
					except grpc.RpcError as error:
						errors.append(error)
				self.assertEqual(3, len(errors))
				self.assertEqual(
					[grpc.StatusCode.FAILED_PRECONDITION] * 3,
					[error.code() for error in errors],
					[error.details() for error in errors],
				)

		def test_search_usage_and_native_validate_empty_requests(self):
			with self.served() as (stub, _):
				self.assert_rpc_error(
					lambda: stub.Search(search_pb2.SearchRequest(), timeout=self.RPC_TIMEOUT),
					grpc.StatusCode.INVALID_ARGUMENT,
				)
				self.assert_rpc_error(
					lambda: stub.Usage(inference_pb.UsageRequest(), timeout=self.RPC_TIMEOUT),
					grpc.StatusCode.INVALID_ARGUMENT,
				)
				self.assert_rpc_error(
					lambda: list(stub.Native(inference_pb.NativeRequest(), timeout=self.RPC_TIMEOUT)),
					grpc.StatusCode.INVALID_ARGUMENT,
				)

		def test_model_discovery_projects_configured_mock_catalog(self):
			with self.served() as (stub, _):
				providers = stub.ListProviders(models_pb2.ListProvidersRequest(), timeout=self.RPC_TIMEOUT)
				mock_provider = next(card for card in providers.providers if card.id == "mock")
				self.assertTrue(mock_provider.credentialed)
				self.assertEqual(1, mock_provider.model_count)
				self.assertIn(models_pb2.ProviderCard.AUTH_KIND_NONE, mock_provider.auth)
				self.assertTrue(providers.cursor.epoch)

				models = stub.ListModels(
					models_pb2.ListModelsRequest(provider="mock", available_only=True),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertEqual(["mock/mock"], [card.id for card in models.models])
				card = models.models[0]
				self.assertEqual("mock", card.provider)
				self.assertEqual("mock", card.model)
				self.assertEqual(models_pb2.ModelCard.SOURCE_CONFIGURED, card.source)

				refreshed = stub.RefreshModels(
					models_pb2.RefreshModelsRequest(provider="mock"),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertEqual(["mock/mock"], [card.id for card in refreshed.models])
				self.assertTrue(refreshed.cursor.epoch)

				watch = stub.WatchModels(models_pb2.WatchModelsRequest(), timeout=self.RPC_TIMEOUT)
				first = next(watch)
				self.assertEqual("reset", first.WhichOneof("event"))
				self.assertTrue(first.cursor.epoch)
				watch.cancel()

		def test_model_discovery_filters_have_defined_boundaries(self):
			with self.served() as (stub, _):
				providers = stub.ListProviders(
					models_pb2.ListProvidersRequest(facet=models_pb2.FACET_IMAGE_GEN),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertNotIn("mock", [provider.id for provider in providers.providers])
				models = stub.ListModels(
					models_pb2.ListModelsRequest(provider="missing"),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertEqual([], list(models.models))
				refreshed = stub.RefreshModels(
					models_pb2.RefreshModelsRequest(provider="missing"),
					timeout=self.RPC_TIMEOUT,
				)
				self.assertEqual([], list(refreshed.models))

		def test_provider_authority_is_typed_on_plain_serve_transport(self):
			"""Provider CONTROL operations require extension-established authority."""
			with self.served() as (stub, _):
				caller = inference_pb.ProviderCaller(
					extension="qa-provider",
					artifact_digest="sha256:qa",
					host_generation=1,
					session_generation=1,
				)
				declaration = inference_pb.ProviderDeclarationRequest(
					caller=caller,
					provider="qa-provider",
					document_json=b'{"name":"QA Provider","models":[]}',
					expected_generation=1,
				)
				operation = inference_pb.ProviderOperationRequest(
					caller=caller,
					provider="qa-provider",
					kind=inference_pb.ProviderOperationRequest.KIND_GENERATE_IMAGE,
					payload_json=b'{}',
					expected_generation=1,
				)
				calls = [
					lambda: stub.ProviderCatalog(inference_pb.ProviderCatalogRequest(provider="mock"), timeout=self.RPC_TIMEOUT),
					lambda: stub.WatchProviderCatalog(inference_pb.WatchProviderCatalogRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.ProviderAuthenticated(inference_pb.ProviderAuthenticatedRequest(provider="mock"), timeout=self.RPC_TIMEOUT),
					lambda: stub.DeclareProvider(declaration, timeout=self.RPC_TIMEOUT),
					lambda: stub.ReplaceProvider(declaration, timeout=self.RPC_TIMEOUT),
					lambda: stub.RetractProvider(
						inference_pb.RetractProviderRequest(
							caller=caller,
							provider="qa-provider",
							expected_generation=1,
						),
						timeout=self.RPC_TIMEOUT,
					),
					lambda: stub.ExecuteProviderRequest(operation, timeout=self.RPC_TIMEOUT),
					lambda: stub.MintProviderSession(operation, timeout=self.RPC_TIMEOUT),
				]
				for call in calls:
					with self.subTest(call=call):
						self.assert_rpc_error(
							call,
							grpc.StatusCode.FAILED_PRECONDITION,
							"provider application authority is not installed",
						)

		def test_provider_declaration_lifecycle_requires_installable_authority(self):
			"""OWNER CONTRACT: provider declaration RPCs demand extension authority.

			Contrib publication is downstream of authenticated extension CONTROL
			ownership/capability/generation checks; a direct catalog upsert from
			plain serve would bypass them, so every lifecycle RPC fails with the
			typed FAILED_PRECONDITION naming the missing authority.
			"""
			with self.served() as (stub, _):
				caller = inference_pb.ProviderCaller(
					extension="qa-provider",
					artifact_digest="sha256:qa",
					host_generation=1,
					session_generation=1,
				)
				declaration = inference_pb.ProviderDeclarationRequest(
					caller=caller,
					provider="qa-provider",
					document_json=b'{"name":"QA Provider","models":[]}',
					expected_generation=1,
				)
				calls = [
					lambda: stub.DeclareProvider(declaration, timeout=self.RPC_TIMEOUT),
					lambda: stub.ReplaceProvider(declaration, timeout=self.RPC_TIMEOUT),
					lambda: stub.RetractProvider(
						inference_pb.RetractProviderRequest(
							caller=caller,
							provider="qa-provider",
							expected_generation=1,
						),
						timeout=self.RPC_TIMEOUT,
					),
				]
				for call in calls:
					with self.subTest():
						self.assert_rpc_error(
							call,
							grpc.StatusCode.FAILED_PRECONDITION,
							"provider application authority is not installed",
						)

		def test_provider_authority_rejects_empty_requests_without_internal_errors(self):
			with self.served() as (stub, _):
				calls = [
					lambda: stub.ProviderCatalog(inference_pb.ProviderCatalogRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.WatchProviderCatalog(inference_pb.WatchProviderCatalogRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.ProviderAuthenticated(inference_pb.ProviderAuthenticatedRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.DeclareProvider(inference_pb.ProviderDeclarationRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.ReplaceProvider(inference_pb.ProviderDeclarationRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.RetractProvider(inference_pb.RetractProviderRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.ExecuteProviderRequest(inference_pb.ProviderOperationRequest(), timeout=self.RPC_TIMEOUT),
					lambda: stub.MintProviderSession(inference_pb.ProviderOperationRequest(), timeout=self.RPC_TIMEOUT),
				]
				for call in calls:
					with self.subTest(call=call):
						self.assert_rpc_error(call, grpc.StatusCode.FAILED_PRECONDITION)


if __name__ == "__main__":
	unittest.main()
