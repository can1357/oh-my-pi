#!/usr/bin/env python3
"""Embedded ``omp.env`` DATA-plane spec cases over the real binary."""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import OMP_BINARY, call, drive, extension_fixture, introspect  # noqa: E402


COVERS = {
	"py": """
omp.env.AlreadyExists
omp.env.BlobStat
omp.env.BlobWriter
omp.env.Cancelled
omp.env.Capability
omp.env.Channel
omp.env.Completed
omp.env.Conflict
omp.env.CopyResult
omp.env.Denied
omp.env.DirEntry
omp.env.DirectFilesystem
omp.env.DirectFilesystemDenied
omp.env.DirectFilesystemGrant
omp.env.Disconnected
omp.env.Doc
omp.env.DocEvent
omp.env.DocEventKind
omp.env.Edit
omp.env.EditConflictFault
omp.env.EditPlan
omp.env.EditResult
omp.env.EffectsNotAuthorized
omp.env.Entry
omp.env.EnvError
omp.env.EnvInfo
omp.env.Exit
omp.env.FileKind
omp.env.Follow
omp.env.Format
omp.env.HttpResponse
omp.env.Invalid
omp.env.Io
omp.env.Kind
omp.env.Lifecycle
omp.env.LinkKind
omp.env.LspBinding
omp.env.LspBindingEvent
omp.env.LspBindingEventKind
omp.env.LspEvent
omp.env.LspFailure
omp.env.LspStale
omp.env.Match
omp.env.NotFound
omp.env.OnStale
omp.env.OpenedDoc
omp.env.OpenedSession
omp.env.Outcome
omp.env.Output
omp.env.Overwrite
omp.env.Partial
omp.env.PathMeta
omp.env.PreconditionFailed
omp.env.Presence
omp.env.ProcState
omp.env.Process
omp.env.ProcessInfo
omp.env.ProcessOutput
omp.env.Pty
omp.env.QuotaExceeded
omp.env.Rank
omp.env.Ready
omp.env.ReadyAll
omp.env.ReadyLog
omp.env.ReadyPing
omp.env.ReadyTcp
omp.env.RestartPolicy
omp.env.Revision
omp.env.Run
omp.env.Session
omp.env.Stale
omp.env.StaleGeneration
omp.env.StartedProcess
omp.env.StartedRun
omp.env.StreamLost
omp.env.Summary
omp.env.SummaryOptions
omp.env.SummaryReason
omp.env.SummaryRender
omp.env.SummarySegment
omp.env.SummaryUnavailable
omp.env.SymlinkTarget
omp.env.SyncKind
omp.env.SyncPolicy
omp.env.TimedOut
omp.env.Txn
omp.env.TxnOutcome
omp.env.TxnReceipt
omp.env.Unsupported
omp.env.WorktreeInfo
omp.env.blobs
omp.env.direct_filesystem
omp.env.docs
omp.env.find
omp.env.fs
omp.env.has
omp.env.http_get
omp.env.http_post
omp.env.http_put
omp.env.info
omp.env.lsp
omp.env.proc
omp.env.require
omp.env.sh
omp.env.worktree
""".split(),
	"rpc": [],
}


class PyEnv(unittest.TestCase):
	"""Live DATA socket, revision, sandbox, exec, and value contracts."""

	def test_symbol_introspection(self):
		report = introspect(COVERS["py"], timeout=90)
		self.assertEqual(set(report), set(COVERS["py"]))
		self.assertEqual({name: status for name, status in report.items() if status != "ok"}, {})
	def test_sandbox_and_path_helpers(self):
		project = Path(tempfile.mkdtemp(prefix="omp-qa-env-path-proj-"))
		try:
			with extension_fixture("env/path") as directory:
				result = drive(
					call("hello"),
					"done",
					extensions=[directory],
					project=project,
					timeout=90,
				)
				self.assertFalse(result.timed_out, result.stderr)
				self.assertEqual(result.exit_code, 0, result.stderr)
				self.assertIn("env-path-ok", str(result.mock["captures"][1]), result.stdout)
				self.assertFalse(project.joinpath("sandbox-bypass.txt").exists())
		finally:
			shutil.rmtree(project, ignore_errors=True)

	@unittest.expectedFailure
	def test_tracked_exec_run_and_output(self):
		"""Ledger: env.sh.session panics by nesting the Tokio runtime in an async tool body."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-env-live-proj-"))
		try:
			(project / "notes.txt").write_text("hello world\nsecond line\n")
			with extension_fixture("env/live") as directory:
				result = drive(
					call("hello"),
					"done",
					extensions=[directory],
					project=project,
					timeout=90,
				)
				self.assertFalse(result.timed_out, result.stderr)
				self.assertEqual(result.exit_code, 0, result.stderr)
				tool_round_trip = str(result.mock["captures"][1])
				self.assertIn("env-live-ok", tool_round_trip, result.stdout)
				self.assertIn("tracked-exec", tool_round_trip)
				self.assertFalse(project.joinpath("sandbox-bypass.txt").exists())
		finally:
			shutil.rmtree(project, ignore_errors=True)

	def test_representative_data_constructions(self):
		with extension_fixture("env/values") as directory:
			result = drive(
				call("hello"),
				"done",
				extensions=[directory],
				timeout=90,
			)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			self.assertIn("env-values-ok", str(result.mock["captures"][1]), result.stdout)

	@unittest.expectedFailure
	def test_data_plane_contract_and_symbol_sweep(self):
		"""Ledger: Doc.edit aborts 'malformed document-server response: connection-owned lease and pinned revision' (envd docs.rs ensure_request_pin) — no disk edit lands."""
		project = Path(tempfile.mkdtemp(prefix="omp-qa-env-proj-"))
		try:
			(project / "notes.txt").write_text("hello world\nsecond line\n")
			with extension_fixture("env/contract") as directory:
				result = drive(
					call("hello"),
					"done",
					prompt="exercise omp.env",
					extensions=[directory],
					project=project,
					timeout=90,
				)
				self.assertFalse(result.timed_out, result.stderr)
				self.assertEqual(result.exit_code, 0, result.stderr)
				self.assertGreaterEqual(result.mock["served"], 2, result.stdout)
				tool_round_trip = str(result.mock["captures"][1])
				self.assertIn("env-contract-ok", tool_round_trip, result.stdout + result.stderr)
				self.assertIn("'symbols': 105", tool_round_trip)
				self.assertEqual((project / "notes.txt").read_text(), "HELLO world\nsecond line\n")
				self.assertFalse(project.joinpath("sandbox-bypass.txt").exists())
		finally:
			shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}; run the project build first")
	unittest.main()
