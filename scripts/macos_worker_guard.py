#!/usr/bin/env python3
"""Read-only admission and bounded supervision of one native macOS objective.

The owned POSIX process group is a cleanup boundary, not an OS sandbox.
"""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import platform
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

from macos_fallback_common import (
    GitHub, VerificationError, parse_json, request_digest, validate_request,
    verify_parent, verify_parent_liveness, verify_source_current,
)

POLL_SECONDS = 45
LEASE_SECONDS = 135


class Lease:
    """Only a positive read renews admission; explicit rejection revokes it."""

    def __init__(self, check, clock=time.monotonic):
        self.check = check
        self.clock = clock
        self.last_valid = None

    def refresh(self, initial=False):
        started = self.clock()
        previous = self.last_valid
        try:
            if initial or self.last_valid is None:
                self.check()
            else:
                remaining = LEASE_SECONDS - (self.clock() - self.last_valid)
                if remaining <= 0:
                    raise VerificationError("admission lease expired")
                # A stalled HTTP read cannot keep native work alive beyond its
                # lease. This short-lived read thread owns no native processes;
                # it is deliberately unable to renew admission after timeout.
                complete = threading.Event()
                errors = []
                def read():
                    try:
                        self.check()
                    except Exception as error:
                        errors.append(error)
                    finally:
                        complete.set()
                threading.Thread(target=read, daemon=True).start()
                if not complete.wait(remaining):
                    raise VerificationError("admission lease expired")
                if errors:
                    raise errors[0]
                if self.clock() - self.last_valid >= LEASE_SECONDS:
                    raise VerificationError("admission lease expired")
            if (self.clock() - started >= LEASE_SECONDS
                    or previous is not None and self.clock() - previous >= LEASE_SECONDS):
                raise VerificationError("admission lease expired")
        except Exception as error:
            if isinstance(error, VerificationError) and not getattr(error, "transient", False):
                raise
            if initial or self.last_valid is None:
                raise VerificationError("initial admission unavailable") from error
            if self.clock() - self.last_valid >= LEASE_SECONDS:
                raise VerificationError("admission lease expired") from error
            return False
        # The observation grants time from when its read began, never from a
        # delayed response's arrival after cancellation may already have won.
        self.last_valid = started
        return True


class HostLock:
    """A persistent inode outside checkout serializes cooperating host work."""

    def __init__(self, path):
        self.path = Path(path)
        self.fd = None

    def acquire(self):
        parent = self.path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        for ancestor in (parent, *parent.parents):
            info = ancestor.lstat()
            if not stat.S_ISDIR(info.st_mode) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise VerificationError("unsafe host lock ancestor")
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise VerificationError("unsafe host lock directory")
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            self.close()
            raise VerificationError("unsafe host lock file")
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.close()
            return False
        return True

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_group(proc, clock=time.monotonic, sleep=time.sleep):
    """Terminate only this child's session, and confirm bounded settlement."""
    for sig, budget in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        deadline = clock() + budget
        while clock() < deadline:
            proc.poll()  # Reap our child before testing its process group.
            if not group_alive(proc.pid):
                return
            sleep(min(0.1, max(0, deadline - clock())))
    raise VerificationError("native process group did not settle")


def supervise(command, lease, *, clock=time.monotonic, sleep=time.sleep,
              popen=subprocess.Popen, cleanup=stop_group, native_env=None):
    """Run one objective with credentials removed and positive initial admission."""
    lease.refresh(initial=True)
    env = dict(os.environ)
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    if native_env:
        env.update(native_env)
    proc = popen(command, start_new_session=True, env=env)
    try:
        next_poll = clock() + POLL_SECONDS
        while proc.poll() is None:
            if clock() - lease.last_valid >= LEASE_SECONDS:
                raise VerificationError("admission lease expired")
            if clock() >= next_poll:
                lease.refresh()
                next_poll = clock() + POLL_SECONDS
            sleep(min(0.2, max(0, next_poll - clock())))
        if proc.returncode != 0:
            raise VerificationError("native objective failed")
        # An objective that exits while leaving descendants is incomplete.
        if group_alive(proc.pid):
            raise VerificationError("native objective left active descendants")
        if not lease.refresh():
            raise VerificationError("final admission unavailable")
    finally:
        cleanup(proc)


def load_request(path):
    with open(path, "rb") as stream:
        data = stream.read(16385)
    if len(data) > 16384:
        raise VerificationError("request exceeds size bound")
    return validate_request(parse_json(data))


def write_result(path, request):
    """Publish one bounded receipt atomically, only after final admission."""
    result = {"result_schema": 1, "request_digest": request_digest(request),
              "request": request, "outcome": "success", "runner_arch": "arm64",
              "objective_complete": True}
    data = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    if len(data) > 32768:
        raise VerificationError("result exceeds size bound")
    target = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".macos-result-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def verify_worker(api, request, env=None):
    """Check the actual Actions run and pool before accepting dispatch input."""
    env = os.environ if env is None else env
    if (env.get("GITHUB_WORKFLOW_SHA") != request["worker_sha"]
            or env.get("CI_MACOS_WORKER_SHA") != request["worker_sha"]):
        raise VerificationError("worker workflow revision mismatch")
    if env.get("GITHUB_REPOSITORY") != request["repository"]:
        raise VerificationError("worker repository mismatch")
    try:
        run_id = int(env["GITHUB_RUN_ID"])
        attempt = int(env["GITHUB_RUN_ATTEMPT"])
    except (KeyError, ValueError) as error:
        raise VerificationError("missing worker run identity") from error
    prefix = f'repos/{request["repository"]}/actions/runs'
    run = api.get(f"{prefix}/{run_id}")
    name_prefix = f'macos:{request["parent_run_id"]}:{request["parent_attempt"]}:{request["objective"]}:{request["nonce"]}'
    expected_name = f'{name_prefix}:{request["generation"]}'
    if (run.get("id") != run_id or run.get("run_attempt") != attempt
            or run.get("event") != "workflow_dispatch"
            or run.get("head_sha") != request["worker_sha"]
            or run.get("display_title") != expected_name
            or run.get("path", "").split("@")[0] != ".github/workflows/macos-verification.yml"
            or run.get("status") != "in_progress"):
        raise VerificationError("worker candidate identity mismatch")
    if env.get("RUNNER_OS") != "macOS" or env.get("RUNNER_ARCH") != "ARM64":
        raise VerificationError("native macOS ARM64 runner required")
    if platform.system() != "Darwin" or platform.machine().lower() not in ("arm64", "aarch64"):
        raise VerificationError("actual native macOS ARM64 host required")
    expected_environment = "self-hosted" if request["pool"] == "self-hosted" else "github-hosted"
    if env.get("RUNNER_ENVIRONMENT") != expected_environment:
        raise VerificationError("runner pool mismatch")
    if env.get("CI_MACOS_POOL", request["pool"]) != request["pool"]:
        raise VerificationError("configured pool mismatch")
    jobs = api.paginate(f"{prefix}/{run_id}/attempts/{attempt}/jobs", "jobs")
    native = [job for job in jobs if job.get("name") == "Native macOS objective"]
    if len(native) != 1 or native[0].get("status") != "in_progress":
        raise VerificationError("worker job is not current")
    if (not env.get("RUNNER_NAME") or native[0].get("runner_name") != env["RUNNER_NAME"]
            or not isinstance(native[0].get("runner_id"), int) or native[0]["runner_id"] <= 0):
        raise VerificationError("worker runner assignment mismatch")
    labels = native[0].get("labels", [])
    if request["pool"] == "self-hosted":
        if env.get("CI_MACOS_FALLBACK_ENABLED") != "true" or env.get("CI_MACOS_FALLBACK_TRUST") != "repository-writers":
            raise VerificationError("self-hosted preflight trust not accepted")
        try:
            configured = json.loads(env.get("CI_MACOS_FALLBACK_LABELS", "null"))
        except ValueError as error:
            raise VerificationError("invalid self-hosted labels") from error
        if (not isinstance(configured, list) or not all(isinstance(item, str) for item in configured)
                or not {"self-hosted", "macOS", "ARM64"}.issubset(configured)
                or not set(configured).issubset(labels)):
            raise VerificationError("self-hosted runner labels mismatch")
        hosted = api.get(f'{prefix}/{request["hosted_run_id"]}')
        if (hosted.get("id") != request["hosted_run_id"]
                or hosted.get("display_title") != f'{name_prefix}:0'
                or hosted.get("status") != "completed" or hosted.get("conclusion") != "cancelled"
                or hosted.get("event") != "workflow_dispatch"
                or hosted.get("head_sha") != request["worker_sha"]
                or hosted.get("workflow_id") != run.get("workflow_id")
                or hosted.get("path", "").split("@")[0] != ".github/workflows/macos-verification.yml"):
            raise VerificationError("hosted predecessor cancellation not settled")
    elif "self-hosted" in labels:
        raise VerificationError("hosted candidate assigned to self-hosted runner")


def verify_admission_liveness(api, request, worker_id, worker_attempt):
    """Renew only while parent, source, and this candidate remain current."""
    verify_parent_liveness(api, request)
    verify_source_current(api, request)
    run = api.get(f'repos/{request["repository"]}/actions/runs/{worker_id}')
    if (run.get("id") != worker_id or run.get("run_attempt") != worker_attempt
            or run.get("status") != "in_progress"):
        raise VerificationError("worker admission revoked")


def verify_checkout(request):
    """Bind the actual source working directory and tracked files to the request."""
    env = dict(os.environ)
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    git = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false"]
    try:
        resolved = subprocess.run(git + ["rev-parse", "HEAD", "HEAD^{tree}"],
                                  env=env, check=True, capture_output=True, timeout=10)
        identity = resolved.stdout.decode("ascii").splitlines()
        if identity != [request["source_sha"], request["tree_sha"]]:
            raise VerificationError("source checkout identity mismatch")
        subprocess.run(git + ["diff", "--no-ext-diff", "--quiet", "HEAD", "--"],
                       env=env, check=True, capture_output=True, timeout=10)
    except (subprocess.SubprocessError, UnicodeError) as error:
        raise VerificationError("source checkout is unavailable or modified") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("admit", "run"))
    parser.add_argument("--request-file", required=True)
    parser.add_argument("--result-file")
    args, command = parser.parse_known_args(argv)
    if args.action == "admit" and command:
        raise VerificationError("admit does not accept a native command")
    if args.action == "run" and args.result_file:
        # Even failed initial admission must remove a previous success receipt.
        with contextlib.suppress(FileNotFoundError):
            Path(args.result_file).unlink()
    request = load_request(args.request_file)
    api = GitHub()

    def check():
        verify_parent(api, request, require_running=True)
        verify_worker(api, request)

    admission_started = time.monotonic()
    check()
    if time.monotonic() - admission_started >= LEASE_SECONDS:
        raise VerificationError("initial admission verification expired")
    worker_id = int(os.environ["GITHUB_RUN_ID"])
    worker_attempt = int(os.environ["GITHUB_RUN_ATTEMPT"])
    lease = Lease(lambda: verify_admission_liveness(api, request, worker_id, worker_attempt))
    lease.refresh(initial=True)
    if args.action == "admit":
        output = os.environ.get("GITHUB_OUTPUT")
        if not output:
            raise VerificationError("GITHUB_OUTPUT missing")
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f'source_sha={request["source_sha"]}\ntree_sha={request["tree_sha"]}\n')
        return 0
    command = command[1:] if command[:1] == ["--"] else command
    if not args.result_file or not command:
        raise VerificationError("run requires result file and command")
    lock = None
    previous = {}

    def interrupted(signum, frame):
        raise VerificationError("worker interrupted")

    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, interrupted)
        if request["pool"] == "self-hosted":
            lock = HostLock(Path.home() / "Library/Caches/omp-macos-worker/physical-host.lock")
            while not lock.acquire():
                time.sleep(POLL_SECONDS)
                lease.refresh()
        native_env = {"AFFECTED_SCOPE": request["coverage"],
                      "AFFECTED_ARGS": " ".join("-p " + package for package in request["packages"]),
                      "AFFECTED_DOC_ARGS": " ".join("-p " + package for package in request["doc_packages"])}
        verify_checkout(request)
        supervise(command, lease, native_env=native_env)
        if not lease.refresh():
            raise VerificationError("publication admission unavailable")
        check()
        verify_checkout(request)
        if time.monotonic() - lease.last_valid >= LEASE_SECONDS:
            raise VerificationError("publication admission expired")
        write_result(args.result_file, request)
    finally:
        if lock:
            lock.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VerificationError, OSError):
        # Never echo API diagnostics or command/environment values containing tokens.
        print("macOS worker admission or objective failed", file=sys.stderr)
        sys.exit(1)
