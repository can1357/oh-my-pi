"""Admission state and owned-process cleanup tests; Linux is not Mac proof."""

import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import macos_worker_guard as guard


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class GuardTests(unittest.TestCase):
    def worker_fixture(self):
        req = {"repository": "owner/repo", "worker_sha": "a" * 40,
               "nonce": "b" * 32, "objective": "rust", "generation": 0, "pool": "hosted",
               "parent_run_id": 10, "parent_attempt": 1}
        env = {"GITHUB_WORKFLOW_SHA": req["worker_sha"], "CI_MACOS_WORKER_SHA": req["worker_sha"], "GITHUB_REPOSITORY": req["repository"],
               "GITHUB_RUN_ID": "20", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_OS": "macOS",
               "RUNNER_ARCH": "ARM64", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_NAME": "runner-1"}
        run = {"id": 20, "run_attempt": 1, "event": "workflow_dispatch", "head_sha": req["worker_sha"],
               "display_title": f'macos:10:1:rust:{req["nonce"]}:0', "status": "in_progress",
               "path": ".github/workflows/macos-verification.yml"}
        class API:
            def get(self, path):
                return run
            def paginate(self, path, key):
                return [{"name": "Native macOS objective", "status": "in_progress", "labels": ["macos-15"],
                         "runner_name": "runner-1", "runner_id": 42}]
        return req, env, run, API()

    def test_own_run_id_and_attempt_must_match(self):
        for field, value in (("id", 21), ("run_attempt", 2)):
            req, env, run, api = self.worker_fixture()
            run[field] = value
            with patch.object(guard.platform, "system", return_value="Darwin"), patch.object(guard.platform, "machine", return_value="arm64"):
                with self.assertRaises(guard.VerificationError):
                    guard.verify_worker(api, req, env)

    def test_pool_cannot_be_promoted_by_request(self):
        req, env, run, api = self.worker_fixture()
        req["pool"] = "self-hosted"
        with patch.object(guard.platform, "system", return_value="Darwin"), patch.object(guard.platform, "machine", return_value="arm64"):
            with self.assertRaises(guard.VerificationError):
                guard.verify_worker(api, req, env)

    def test_current_hosted_identity_admitted(self):
        req, env, run, api = self.worker_fixture()
        with patch.object(guard.platform, "system", return_value="Darwin"), patch.object(guard.platform, "machine", return_value="arm64"):
            guard.verify_worker(api, req, env)

    def test_self_host_requires_trust_and_cancelled_predecessor(self):
        req, env, run, _ = self.worker_fixture()
        req.update(pool="self-hosted", generation=1, hosted_run_id=19)
        env.update(RUNNER_ENVIRONMENT="self-hosted", CI_MACOS_FALLBACK_ENABLED="true",
                   CI_MACOS_FALLBACK_TRUST="repository-writers",
                   CI_MACOS_FALLBACK_LABELS='["self-hosted","macOS","ARM64"]')
        run.update(display_title=f'macos:10:1:rust:{req["nonce"]}:1', workflow_id=3)
        predecessor = dict(run, id=19, display_title=f'macos:10:1:rust:{req["nonce"]}:0',
                           status="completed", conclusion="cancelled")
        class API:
            def get(self, path):
                return predecessor if path.endswith("/19") else run
            def paginate(self, path, key):
                return [{"name": "Native macOS objective", "status": "in_progress", "runner_name": "runner-1",
                         "runner_id": 42, "labels": ["self-hosted", "macOS", "ARM64"]}]
        with patch.object(guard.platform, "system", return_value="Darwin"), patch.object(guard.platform, "machine", return_value="arm64"):
            guard.verify_worker(API(), req, env)
            predecessor["conclusion"] = "success"
            with self.assertRaises(guard.VerificationError):
                guard.verify_worker(API(), req, env)
            predecessor["conclusion"] = "cancelled"
            env["CI_MACOS_FALLBACK_ENABLED"] = "false"
            with self.assertRaises(guard.VerificationError):
                guard.verify_worker(API(), req, env)

    def test_initial_failure_never_launches(self):
        def check():
            raise OSError("offline")
        with self.assertRaises(guard.VerificationError):
            guard.supervise(["unused"], guard.Lease(check), popen=lambda *a, **k: self.fail("launched"))

    def test_stale_receipt_removed_even_if_initial_request_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            result = Path(directory) / "result.json"
            result.write_text('{"outcome":"success"}')
            with patch.object(guard, "load_request", side_effect=guard.VerificationError("bad request")):
                with self.assertRaises(guard.VerificationError):
                    guard.main(["run", "--request-file", "missing", "--result-file", str(result), "--", "/bin/bash", "objective"])
            self.assertFalse(result.exists())

    def test_admit_cli_parses_options_after_action(self):
        with patch.object(guard, "load_request", side_effect=FileNotFoundError("sentinel")) as load:
            with self.assertRaises(FileNotFoundError):
                guard.main(["admit", "--request-file", "/nonexistent"])
        load.assert_called_once_with("/nonexistent")

    def test_transient_failure_expires_exactly_at_lease_deadline(self):
        clock = Clock()
        errors = []
        def check():
            if errors:
                raise OSError("offline")
        lease = guard.Lease(check, clock)
        lease.refresh(initial=True)
        errors.append(True)
        clock.now = guard.LEASE_SECONDS - 0.001
        self.assertFalse(lease.refresh())
        clock.now = guard.LEASE_SECONDS
        with self.assertRaises(guard.VerificationError):
            lease.refresh()

    def test_positive_read_renews_from_start_not_arrival(self):
        clock = Clock()
        def check():
            clock.now += 10
        lease = guard.Lease(check, clock)
        lease.refresh(initial=True)
        self.assertEqual(lease.last_valid, 0)
        clock.now = guard.POLL_SECONDS
        lease.refresh()
        self.assertEqual(clock.now, guard.POLL_SECONDS + 10)
        self.assertEqual(lease.last_valid, guard.POLL_SECONDS)

    def test_late_positive_read_cannot_resurrect_expired_admission(self):
        clock = Clock()
        def check():
            clock.now += 2
        lease = guard.Lease(check, clock)
        lease.last_valid = 0
        clock.now = guard.LEASE_SECONDS - 1
        with self.assertRaises(guard.VerificationError):
            lease.refresh()
        self.assertEqual(lease.last_valid, 0)

    def test_initial_verification_taking_entire_lease_refused(self):
        clock = Clock()
        def check():
            clock.now += guard.LEASE_SECONDS
        lease = guard.Lease(check, clock)
        with self.assertRaises(guard.VerificationError):
            lease.refresh(initial=True)
        self.assertIsNone(lease.last_valid)

    def test_explicit_revocation_is_immediate(self):
        clock = Clock()
        def check():
            raise guard.VerificationError("parent cancelled")
        lease = guard.Lease(check, clock)
        lease.last_valid = 0
        with self.assertRaises(guard.VerificationError):
            lease.refresh()

    def test_stalled_read_cannot_outlive_remaining_lease(self):
        release = threading.Event()
        lease = guard.Lease(lambda: release.wait(5))
        lease.last_valid = time.monotonic() - guard.LEASE_SECONDS + 0.03
        started = time.monotonic()
        try:
            with self.assertRaises(guard.VerificationError):
                lease.refresh()
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            release.set()

    def test_running_process_stopped_on_expiry_or_revocation(self):
        for explicit, expected in ((False, guard.LEASE_SECONDS), (True, guard.POLL_SECONDS)):
            clock = Clock()
            checks, stopped = [], []
            def check():
                checks.append(1)
                if len(checks) > 1:
                    if explicit:
                        raise guard.VerificationError("cancelled")
                    raise OSError("offline")
            class Process:
                pid = 123456789
                def poll(self):
                    return None
            def sleep(seconds):
                clock.now += seconds
            with self.assertRaises(guard.VerificationError):
                guard.supervise(["unused"], guard.Lease(check, clock), clock=clock, sleep=sleep,
                                popen=lambda *a, **k: Process(), cleanup=lambda p: stopped.append(p.pid))
            self.assertEqual(stopped, [123456789])
            self.assertAlmostEqual(clock.now, expected)

    def test_worker_cancellation_revokes_without_waiting_for_expiry(self):
        req, _, _, _ = self.worker_fixture()
        class API:
            def get(self, path):
                return {"id": 20, "run_attempt": 1, "status": "completed"}
        with patch.object(guard, "verify_parent_liveness"), patch.object(guard, "verify_source_current"):
            lease = guard.Lease(lambda: guard.verify_admission_liveness(API(), req, 20, 1))
            lease.last_valid = time.monotonic()
            with self.assertRaises(guard.VerificationError):
                lease.refresh()

    def test_source_supersession_revokes_without_worker_read(self):
        req, _, _, _ = self.worker_fixture()
        class API:
            def get(self, path):
                raise AssertionError("source revocation should stop further reads")
        with patch.object(guard, "verify_parent_liveness"), patch.object(guard, "verify_source_current", side_effect=guard.VerificationError("superseded")):
            lease = guard.Lease(lambda: guard.verify_admission_liveness(API(), req, 20, 1))
            lease.last_valid = time.monotonic()
            with self.assertRaises(guard.VerificationError):
                lease.refresh()

    def test_actual_checkout_identity_and_modifications(self):
        req = {"source_sha": "a" * 40, "tree_sha": "b" * 40}
        identity = subprocess.CompletedProcess([], 0, stdout=(req["source_sha"] + "\n" + req["tree_sha"] + "\n").encode())
        clean = subprocess.CompletedProcess([], 0)
        with patch.object(guard.subprocess, "run", side_effect=[identity, clean]) as run:
            guard.verify_checkout(req)
            self.assertIn("--no-ext-diff", run.call_args_list[1].args[0])
        mismatch = subprocess.CompletedProcess([], 0, stdout=("c" * 40 + "\n" + req["tree_sha"] + "\n").encode())
        with patch.object(guard.subprocess, "run", return_value=mismatch):
            with self.assertRaises(guard.VerificationError):
                guard.verify_checkout(req)
        with patch.object(guard.subprocess, "run", side_effect=[identity, subprocess.CalledProcessError(1, "git diff")]):
            with self.assertRaises(guard.VerificationError):
                guard.verify_checkout(req)

    def test_real_git_checkout_modified_after_execution_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(["git", "-C", directory, "-c", "core.hooksPath=/dev/null",
                                       "-c", "commit.gpgsign=false", *args], check=True, capture_output=True).stdout.decode().strip()
            git("init", "-q")
            git("config", "user.name", "Guard test")
            git("config", "user.email", "guard-test@example.invalid")
            source = Path(directory) / "source.txt"
            source.write_text("reviewed\n")
            git("add", "source.txt")
            git("commit", "-qm", "fixture")
            req = {"source_sha": git("rev-parse", "HEAD"), "tree_sha": git("rev-parse", "HEAD^{tree}")}
            previous = os.getcwd()
            try:
                os.chdir(directory)
                guard.verify_checkout(req)
                source.write_text("modified during objective\n")
                with self.assertRaises(guard.VerificationError):
                    guard.verify_checkout(req)
            finally:
                os.chdir(previous)

    def test_host_lock_serializes_without_unlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "private" / "host.lock"
            first, second = guard.HostLock(path), guard.HostLock(path)
            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())
            inode = path.stat().st_ino
            first.close()
            self.assertTrue(second.acquire())
            self.assertEqual(inode, path.stat().st_ino)
            second.close()

    def test_unsafe_lock_directory_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o777)
            with self.assertRaises(guard.VerificationError):
                guard.HostLock(Path(directory).resolve() / "lock").acquire()

    def test_process_group_cleanup_real_posix(self):
        proc = subprocess.Popen(["/bin/sh", "-c", "trap 'wait; exit 143' TERM; sleep 60 & wait"], start_new_session=True)
        try:
            # The shell reaps its descendant on TERM, avoiding dependence on
            # container PID 1's orphan-reaping behavior.
            time.sleep(0.05)
            guard.stop_group(proc)
            self.assertIsNotNone(proc.poll())
            self.assertFalse(guard.group_alive(proc.pid))
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)

    def test_child_credentials_scrubbed_tracking_retained(self):
        class Process:
            pid = 123456789
            returncode = 0
            def poll(self):
                return 0
        captured = {}
        def launch(command, **kwargs):
            captured.update(kwargs)
            return Process()
        with patch.dict(os.environ, {"GH_TOKEN": "private", "GITHUB_TOKEN": "private", "RUNNER_TRACKING_ID": "keep"}):
            guard.supervise(["/bin/bash", "objective.sh"], guard.Lease(lambda: None),
                            popen=launch, cleanup=lambda proc: None)
        self.assertNotIn("GH_TOKEN", captured["env"])
        self.assertNotIn("GITHUB_TOKEN", captured["env"])
        self.assertEqual(captured["env"]["RUNNER_TRACKING_ID"], "keep")
        self.assertTrue(captured["start_new_session"])

    def test_source_change_after_command_prevents_completion(self):
        calls = []
        def check():
            calls.append(1)
            if len(calls) == 2:
                raise guard.VerificationError("source changed")
        class Process:
            pid = 123456789
            returncode = 0
            def poll(self):
                return 0
        with self.assertRaises(guard.VerificationError):
            guard.supervise(["unused"], guard.Lease(check), popen=lambda *a, **k: Process(), cleanup=lambda p: None)


if __name__ == "__main__":
    unittest.main()
