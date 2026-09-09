"""gRPC plumbing for serve-facing QA cases.

Generates Python stubs from ``crates/proto/proto`` once per checkout state
(cached under the system temp dir) and provides ``ServeSession``: an isolated
``omp serve`` on a Unix socket plus a connected channel.

Requires ``uv`` (repo standard) to provision ``grpcio``/``grpcio-tools`` and
run stub generation; case processes themselves import the generated stubs
with plain ``grpcio``, provisioned the same way — run serve cases via
``uv run --with "grpcio>=1.83" --with protobuf python3 scripts/qa/run.py`` (the
generated ``*_pb2`` modules need the protobuf runtime).

Transport contract: gRPC clients over unix sockets MUST set an explicit
authority (h2 validates ``:authority`` as a URI authority, and grpcio's
default for UDS targets is the percent-encoded socket path). Every channel
here sets ``grpc.default_authority=localhost``; tonic clients set the URI
authority. Owner decision: no vendored h2 fork — this is the documented
client contract (`.plan/qa/serve-blob.md`).
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
from pathlib import Path

from harness import CONFIG_TOML, MODELS_TOML, OMP_BINARY, REPO_ROOT

PROTO_ROOT = REPO_ROOT / "crates/proto/proto"


def stub_dir() -> Path:
	"""Generates (or reuses) grpcio stubs for every omp proto package."""
	protos = sorted(str(p.relative_to(PROTO_ROOT)) for p in PROTO_ROOT.rglob("*.proto"))
	digest = hashlib.sha256(
		"\n".join(
			f"{name}:{(PROTO_ROOT / name).stat().st_mtime_ns}" for name in protos
		).encode()
	).hexdigest()[:16]
	target = Path(tempfile.gettempdir()) / f"omp-qa-grpc-stubs-{digest}"
	marker = target / ".complete"
	if marker.exists():
		return target
	target.mkdir(parents=True, exist_ok=True)
	subprocess.run(
		[
			"uv", "run", "--with", "grpcio-tools", "python", "-m", "grpc_tools.protoc",
			f"-I{PROTO_ROOT}",
			f"--python_out={target}",
			f"--grpc_python_out={target}",
			*protos,
		],
		check=True,
		capture_output=True,
		timeout=300,
	)
	marker.touch()
	return target


class ServeSession:
	"""Isolated ``omp serve`` on a Unix socket, with mock-model routing.

	Context manager; yields itself with ``channel`` (grpc.Channel) connected
	through the authority workaround. ``mock_port`` routes the catalog's
	``mock`` model at a scripted server when one is supplied.
	"""

	def __init__(self, mock_port: int | None = None, ready_timeout: float = 30.0):
		self.mock_port = mock_port
		self.ready_timeout = ready_timeout
		self.data_dir: Path | None = None
		self.socket: Path | None = None
		self.process: subprocess.Popen | None = None
		self.channel = None

	def __enter__(self):
		import grpc  # provisioned via uv in the invoking environment

		self.data_dir = Path(tempfile.mkdtemp(prefix="omp-qa-serve-data-"))
		if self.mock_port is not None:
			(self.data_dir / "models.toml").write_text(MODELS_TOML.format(port=self.mock_port))
			(self.data_dir / "config.toml").write_text(CONFIG_TOML)
		self.socket = Path(tempfile.mkdtemp(prefix="omp-qa-serve-")) / "serve.sock"
		self.process = subprocess.Popen(
			[
				str(OMP_BINARY), "serve",
				"--endpoint", str(self.socket),
				"--data-dir", str(self.data_dir),
			],
			stdout=subprocess.DEVNULL,
			stderr=subprocess.PIPE,
			stdin=subprocess.DEVNULL,
			env={**os.environ},
		)
		deadline = time.monotonic() + self.ready_timeout
		while not self.socket.exists():
			if self.process.poll() is not None:
				raise RuntimeError(
					f"omp serve exited: {self.process.communicate()[1].decode()[-400:]}"
				)
			if time.monotonic() > deadline:
				raise TimeoutError("omp serve socket never appeared")
			time.sleep(0.05)
		self.channel = grpc.insecure_channel(
			f"unix://{self.socket}",
			options=[("grpc.default_authority", "localhost")],
		)
		return self

	def __exit__(self, *exc):
		if self.channel is not None:
			self.channel.close()
		if self.process is not None:
			self.process.terminate()
			try:
				self.process.wait(timeout=10)
			except subprocess.TimeoutExpired:
				self.process.kill()
				self.process.wait()
