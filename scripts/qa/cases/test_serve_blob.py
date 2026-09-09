#!/usr/bin/env python3
"""Blob service spec cases against an isolated real ``omp serve`` process."""

from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

COVERS: dict[str, list[str]] = {
	"py": [],
	"rpc": [
		"omp.blob.v1.Blob/Stat",
		"omp.blob.v1.Blob/Get",
		"omp.blob.v1.Blob/Put",
		"omp.blob.v1.Blob/Delete",
	],
}

try:
	import grpc
except ImportError:
	grpc = None

if grpc is not None:
	try:
		from grpcsupport import ServeSession, stub_dir

		sys.path.insert(0, str(stub_dir()))
		from omp.blob.v1 import blob_pb2, blob_pb2_grpc
	except Exception:  # stale grpcio / protobuf runtime / codegen failure
		grpc = None

if grpc is None:
	class ServeBlob(unittest.TestCase):
		@unittest.skip("grpcio unavailable; run via uv run --with grpcio")
		def test_grpcio_is_available(self):
			raise unittest.SkipTest("grpcio unavailable; run via uv run --with grpcio")
else:
	RPC_TIMEOUT = 15
	LARGE_SIZE = 5 * 1024 * 1024 + 3

	def sha256(data: bytes) -> bytes:
		return hashlib.sha256(data).digest()

	def upload_chunks(data: bytes, *, chunk_size: int = 64 * 1024):
		digest = sha256(data)
		if not data:
			yield blob_pb2.Chunk(data=b"", hash=digest, size=0)
			return
		for offset in range(0, len(data), chunk_size):
			yield blob_pb2.Chunk(
				data=data[offset : offset + chunk_size],
				hash=digest if offset == 0 else b"",
				size=len(data) if offset == 0 else None,
			)

	class ServeBlob(unittest.TestCase):
		def stub(self, session: ServeSession):
			return blob_pb2_grpc.BlobStub(session.channel)

		def assert_rpc_code(self, code, operation):
			with self.assertRaises(grpc.RpcError) as caught:
				operation()
			self.assertEqual(caught.exception.code(), code, caught.exception.details())

		def test_empty_blob_put_stat_get_delete(self):
			payload = b""
			digest = sha256(payload)
			with ServeSession() as session:
				stub = self.stub(session)
				put = stub.Put(upload_chunks(payload), timeout=RPC_TIMEOUT)
				self.assertEqual(put.hash, digest)
				self.assertEqual(len(put.hash), hashlib.sha256().digest_size)
				self.assertEqual(put.hash.hex(), hashlib.sha256(payload).hexdigest())
				self.assertEqual(put.size, 0)

				stat = stub.Stat(blob_pb2.StatRequest(hash=digest), timeout=RPC_TIMEOUT)
				self.assertTrue(stat.present)
				self.assertEqual(stat.size, 0)

				chunks = list(
					stub.Get(blob_pb2.GetRequest(hash=digest), timeout=RPC_TIMEOUT)
				)
				self.assertEqual(len(chunks), 1)
				self.assertEqual(chunks[0].data, payload)
				self.assertEqual(chunks[0].hash, digest)
				self.assertEqual(chunks[0].size, 0)

				deleted = stub.Delete(blob_pb2.DeleteRequest(hash=digest), timeout=RPC_TIMEOUT)
				self.assertTrue(deleted.deleted)

		def test_multi_megabyte_streamed_round_trip(self):
			seed = bytes(range(251))
			payload = (seed * (LARGE_SIZE // len(seed) + 1))[:LARGE_SIZE]
			digest = sha256(payload)
			with ServeSession() as session:
				stub = self.stub(session)
				put = stub.Put(upload_chunks(payload), timeout=RPC_TIMEOUT)
				self.assertEqual((put.hash, put.size), (digest, len(payload)))

				stat = stub.Stat(blob_pb2.StatRequest(hash=digest), timeout=RPC_TIMEOUT)
				self.assertEqual((stat.present, stat.size), (True, len(payload)))

				chunks = list(
					stub.Get(blob_pb2.GetRequest(hash=digest), timeout=RPC_TIMEOUT)
				)
				self.assertGreater(len(chunks), 1, "multi-MB Get must be a real stream")
				self.assertEqual(chunks[0].hash, digest)
				self.assertEqual(chunks[0].size, len(payload))
				self.assertEqual(b"".join(chunk.data for chunk in chunks), payload)
				self.assertTrue(
					stub.Delete(blob_pb2.DeleteRequest(hash=digest), timeout=RPC_TIMEOUT).deleted
				)

		def test_put_is_content_addressed_and_idempotent(self):
			payload = b"sha-256 content contract"
			digest = sha256(payload)
			with ServeSession() as session:
				stub = self.stub(session)
				first = stub.Put(upload_chunks(payload, chunk_size=5), timeout=RPC_TIMEOUT)
				second = stub.Put(upload_chunks(payload, chunk_size=7), timeout=RPC_TIMEOUT)
				self.assertEqual(first.hash, digest)
				self.assertEqual(second.hash, digest)
				self.assertEqual(first.size, len(payload))
				self.assertEqual(second.size, len(payload))

		def test_get_unknown_digest_is_not_found(self):
			with ServeSession() as session:
				stub = self.stub(session)
				self.assert_rpc_code(
					grpc.StatusCode.NOT_FOUND,
					lambda: list(
						stub.Get(blob_pb2.GetRequest(hash=b"\xff" * 32), timeout=RPC_TIMEOUT)
					),
				)

		def test_delete_reports_absence_on_second_delete(self):
			payload = b"delete exactly once"
			digest = sha256(payload)
			with ServeSession() as session:
				stub = self.stub(session)
				stub.Put(upload_chunks(payload), timeout=RPC_TIMEOUT)
				first = stub.Delete(blob_pb2.DeleteRequest(hash=digest), timeout=RPC_TIMEOUT)
				second = stub.Delete(blob_pb2.DeleteRequest(hash=digest), timeout=RPC_TIMEOUT)
				self.assertTrue(first.deleted)
				self.assertFalse(second.deleted)
				stat = stub.Stat(blob_pb2.StatRequest(hash=digest), timeout=RPC_TIMEOUT)
				self.assertEqual((stat.present, stat.size), (False, 0))

		def test_malformed_digests_and_declared_put_digest_are_invalid(self):
			with ServeSession() as session:
				stub = self.stub(session)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.Stat(blob_pb2.StatRequest(hash=b"short"), timeout=RPC_TIMEOUT),
				)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: list(
						stub.Get(blob_pb2.GetRequest(hash=b"short"), timeout=RPC_TIMEOUT)
					),
				)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.Delete(blob_pb2.DeleteRequest(hash=b"short"), timeout=RPC_TIMEOUT),
				)
				self.assert_rpc_code(
					grpc.StatusCode.INVALID_ARGUMENT,
					lambda: stub.Put(
						iter([blob_pb2.Chunk(data=b"actual", hash=b"\0" * 32, size=6)]),
						timeout=RPC_TIMEOUT,
					),
				)


if __name__ == "__main__":
	unittest.main()
