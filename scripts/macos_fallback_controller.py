#!/usr/bin/env python3
"""Hosted-first native macOS controller. All authority comes from GitHub reads."""

import argparse
import io
import json
import os
import re
import secrets
import shlex
import signal
import sys
import time
import zipfile

from macos_fallback_common import APIError, GitHub, VerificationError, request_digest, validate_request, verify_parent, verify_parent_liveness, resolve_worker_ref, verify_mac_configuration


POLL = 30
QUEUE_THRESHOLD = 300
CANCEL_BUDGET = 600
ADMISSION_DRAIN = 150
MAC_QUEUE_BUDGET = 9000
PARENT_BUDGET = 330 * 60 - 120
EXECUTION_BUDGET = {"rust": 120 * 60, "lint_macos": 45 * 60}
MAX_ARTIFACT = 1024 * 1024


def unique_object(pairs):
    """Reject ambiguous JSON, including duplicate keys in nested objects."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("duplicate JSON key")
        result[key] = value
    return result


def decode_artifact(data):
    """Read exactly one small regular result.json without extracting a ZIP."""
    if len(data) > MAX_ARTIFACT:
        raise VerificationError("artifact download too large")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) != 1 or entries[0].filename != "macos-result.json":
                raise VerificationError("unexpected artifact members")
            entry = entries[0]
            mode = entry.external_attr >> 16
            if entry.file_size > MAX_ARTIFACT or entry.flag_bits & 1 or (mode & 0o170000) not in (0, 0o100000):
                raise VerificationError("unsafe artifact member")
            with archive.open(entry) as stream:
                raw = stream.read(MAX_ARTIFACT + 1)
            if len(raw) > MAX_ARTIFACT:
                raise VerificationError("expanded artifact exceeds budget")
            value = json.loads(raw, object_pairs_hook=unique_object)
            if not isinstance(value, dict):
                raise VerificationError("result must be an object")
            return value
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise VerificationError("malformed result archive") from error


class Controller:
    """One objective, with injected API and monotonic clock for protocol tests."""

    def __init__(self, api, request, worker_ref, fallback=False, clock=time.monotonic, sleep=time.sleep):
        self.api = api
        self.request = validate_request(request)
        self.worker_ref = worker_ref
        self.fallback = fallback
        self.clock = clock
        self.sleep = sleep
        self.deadline = clock() + PARENT_BUDGET
        self.candidates = set()
        self.requests = {}
        self.historical = set()
        self.owned = set()
        self.prefix = "repos/" + self.request["repository"]
        self.workflow = self.prefix + "/actions/workflows/macos-verification.yml"

    def pause(self, deadline=None, interval=POLL):
        limit = min(self.deadline, deadline if deadline is not None else self.deadline)
        remaining = limit - self.clock()
        if remaining <= 0:
            raise VerificationError("controller deadline expired")
        self.sleep(min(interval, remaining))

    def parent(self):
        verify_parent(self.api, self.request, require_running=True)

    def run_path(self, run_id):
        return self.prefix + "/actions/runs/" + str(run_id)

    def snapshot(self, run_id):
        run = self.api.get(self.run_path(run_id))
        self.check_run(run, historical=run_id in self.historical)
        attempt = run.get("run_attempt")
        if (type(attempt) is not int or attempt < 1 or
                run_id not in self.historical and attempt != 1):
            raise VerificationError("candidate rerun cannot satisfy dispatch")
        if run_id in self.owned and run.get("status") != "completed":
            return run, None
        jobs = self.api.paginate(self.run_path(run_id) + "/attempts/" + str(attempt) + "/jobs", "jobs")
        native = [job for job in jobs if job.get("name") == "Native macOS objective"]
        if len(native) > 1:
            raise VerificationError("ambiguous native job")
        return run, native[0] if native else None

    def check_run(self, run, historical=False):
        if (run.get("event") != "workflow_dispatch" or
                run.get("repository", {}).get("id") != self.request["repository_id"] or
                run.get("path", "").split("@")[0] != ".github/workflows/macos-verification.yml"):
            raise VerificationError("candidate workflow identity mismatch")
        if historical:
            if resolve_worker_ref(self.api, self.request["repository"], run.get("head_branch")) != run.get("head_sha"):
                raise VerificationError("historical worker release tag changed")
        elif run.get("head_sha") != self.request["worker_sha"]:
            raise VerificationError("candidate workflow identity mismatch")

    @staticmethod
    def assigned(run, job):
        return (run.get("status") == "in_progress" or
                job is not None and (job.get("runner_id", 0) not in (0, None) or
                                     bool(job.get("runner_name")) or
                                     job.get("status") in ("in_progress", "completed") or
                                     any(step.get("status") == "in_progress" for step in job.get("steps", []))))

    def title(self, generation):
        return "macos:{}:{}:{}:{}:{}".format(self.request["parent_run_id"], self.request["parent_attempt"],
                                             self.request["objective"], self.request["nonce"], generation)

    def discover(self, generation):
        matches = []
        for run in self.api.paginate(self.workflow + "/runs?event=workflow_dispatch", "workflow_runs"):
            if run.get("display_title") == self.title(generation):
                self.check_run(run)
                matches.append(run)
        if len(matches) > 1:
            raise VerificationError("multiple dispatch candidates; refusing ownership")
        return matches[0] if matches else None

    def dispatch(self, generation, pool, hosted_run_id=None):
        self.parent()
        # A protected tag is mandatory; resolve it again immediately before use.
        ref = self.worker_ref
        if resolve_worker_ref(self.api, self.request["repository"], ref) != self.request["worker_sha"]:
            raise VerificationError("worker release tag changed")
        if self.discover(generation) is not None:
            raise VerificationError("candidate already exists before dispatch")
        payload = validate_request(dict(self.request, generation=generation, pool=pool, hosted_run_id=hosted_run_id or 0))
        verify_parent(self.api, payload, require_running=True)
        # A connection loss may follow acceptance. Never send this POST twice.
        response = None
        try:
            response = self.api.post(self.workflow + "/dispatches", {
                "ref": ref, "inputs": {"request_json": json.dumps(payload, sort_keys=True, separators=(",", ":")), "pool": pool}})
        except APIError as error:
            if not error.transient:
                raise
        except (OSError, TimeoutError):
            pass
        run_id = response.get("workflow_run_id") if isinstance(response, dict) else None
        if response is not None and (not isinstance(response, dict) or type(run_id) is not int or run_id <= 0):
            raise VerificationError("malformed dispatch acceptance response")
        reconcile_deadline = self.clock() + 120
        while True:
            run = self.discover(generation)
            if run is not None:
                if run_id is not None and run["id"] != run_id:
                    raise VerificationError("dispatch response disagrees with correlation")
                self.candidates.add(run["id"])
                self.requests[run["id"]] = payload
                return run["id"]
            if self.clock() >= reconcile_deadline:
                raise VerificationError("dispatch acceptance unknown; no retry permitted")
            self.pause(reconcile_deadline)

    def cancel_settle(self, run_id):
        if run_id not in self.candidates:
            raise VerificationError("refusing cancellation of unrecorded run")
        try:
            self.api.post(self.run_path(run_id) + "/cancel")
        except APIError as error:
            # Completion can race the POST; an uncertain response grants no
            # ownership. Read settlement without ever repeating cancellation.
            if error.status != 409 and not error.transient:
                raise
        deadline = self.clock() + CANCEL_BUDGET
        while True:
            verify_parent_liveness(self.api, self.request)
            run, job = self.snapshot(run_id)
            if run.get("status") == "completed":
                if run.get("conclusion") == "success":
                    return "success"
                if run.get("conclusion") != "cancelled":
                    raise VerificationError("unexpected candidate conclusion during cancellation")
                return "cancelled"
            self.pause(deadline)

    def reconcile_old(self):
        """Drain old parent generations; API pagination must be exhaustive."""
        old = []
        for run in self.api.paginate(self.workflow + "/runs?event=workflow_dispatch", "workflow_runs"):
            title = run.get("display_title", "")
            if not title.startswith("macos:") or run.get("status") == "completed":
                continue
            parts = title.split(":")
            if len(parts) != 6 or parts[1] != str(self.request["parent_run_id"]) or parts[3] != self.request["objective"]:
                continue
            if not parts[2].isdigit() or not re.fullmatch(r"[0-9a-f]{32}", parts[4]) or parts[5] not in ("0", "1"):
                raise VerificationError("malformed older generation identity")
            if int(parts[2]) >= self.request["parent_attempt"]:
                raise VerificationError("overlapping current or newer controller generation")
            self.check_run(run, historical=True)
            old.append(run["id"])
        for run_id in old:
            self.candidates.add(run_id)
            self.historical.add(run_id)
            if self.cancel_settle(run_id) != "cancelled":
                raise VerificationError("older generation completed during reconciliation")
        if old:
            self.drain_admission()

    def drain_admission(self):
        """Allow the old worker lease and owned-process cleanup to expire."""
        expiry = self.clock() + ADMISSION_DRAIN
        while self.clock() < expiry:
            verify_parent_liveness(self.api, self.request)
            self.pause(expiry)

    def wait(self, run_id, pool):
        first_queued = None
        attempt = None
        owned = False
        execution_deadline = None
        queue_deadline = self.clock() + (MAC_QUEUE_BUDGET if pool == "self-hosted" else PARENT_BUDGET)
        while True:
            verify_parent_liveness(self.api, self.request)
            run, job = self.snapshot(run_id)
            if attempt != run["run_attempt"]:
                if attempt is not None:
                    raise VerificationError("candidate rerun cannot satisfy original dispatch")
                attempt = run["run_attempt"]
                first_queued = None
            if run.get("status") == "completed":
                if run.get("conclusion") != "success":
                    raise VerificationError("native objective did not succeed")
                return run_id
            if self.assigned(run, job):
                owned = True
                self.owned.add(run_id)
                if execution_deadline is None:
                    execution_deadline = self.clock() + EXECUTION_BUDGET[self.request["objective"]]
            if not owned:
                if run.get("status") == "queued":
                    if first_queued is None:
                        first_queued = self.clock()
                else:
                    first_queued = None
                if pool == "hosted" and self.fallback and first_queued is not None and self.clock() - first_queued >= QUEUE_THRESHOLD:
                    self.parent()
                    try:
                        verify_mac_configuration(self.api, self.request)
                    except VerificationError:
                        self.fallback = False
                        continue
                    latest, latest_job = self.snapshot(run_id)
                    if latest.get("status") == "completed":
                        if latest.get("conclusion") == "success":
                            return run_id
                        raise VerificationError("hosted terminal failure before cancellation")
                    if self.assigned(latest, latest_job):
                        owned = True
                        self.owned.add(run_id)
                        execution_deadline = self.clock() + EXECUTION_BUDGET[self.request["objective"]]
                    elif latest.get("status") == "queued":
                        if self.cancel_settle(run_id) == "success":
                            return run_id
                        self.drain_admission()
                        self.parent()
                        fallback = self.dispatch(1, "self-hosted", run_id)
                        return self.wait(fallback, "self-hosted")
            self.pause(execution_deadline if owned else queue_deadline, 60 if owned else POLL)

    def verify_result(self, run_id):
        run, job = self.snapshot(run_id)
        if run.get("status") != "completed" or run.get("conclusion") != "success" or not job or job.get("conclusion") != "success":
            raise VerificationError("native job did not succeed")
        steps = [s for s in job.get("steps", []) if s.get("name") == "Run native objective"]
        if len(steps) != 1 or steps[0].get("status") != "completed" or steps[0].get("conclusion") != "success":
            raise VerificationError("native command step did not succeed")
        parts = run.get("display_title", "").split(":")
        if len(parts) != 6 or run.get("display_title") not in (self.title(0), self.title(1)):
            raise VerificationError("result generation identity mismatch")
        generation = int(parts[5])
        artifacts = self.api.paginate(self.run_path(run_id) + "/artifacts", "artifacts")
        name = "macos-result-{}-{}".format(self.request["nonce"], generation)
        matches = [a for a in artifacts if a.get("name") == name and not a.get("expired")]
        if len(matches) != 1 or matches[0].get("size_in_bytes", MAX_ARTIFACT + 1) > MAX_ARTIFACT:
            raise VerificationError("missing or excessive result artifact")
        artifact_id = matches[0].get("id")
        if type(artifact_id) is not int or artifact_id <= 0:
            raise VerificationError("invalid artifact identity")
        result = decode_artifact(self.api.get_bytes(self.prefix + "/actions/artifacts/" + str(artifact_id) + "/zip"))
        selected_request = self.requests[run_id]
        expected = dict(result_schema=1, request_digest=request_digest(selected_request),
                        request=selected_request, outcome="success", runner_arch="arm64", objective_complete=True)
        if set(result) != set(expected):
            raise VerificationError("unknown result fields")
        validate_request(result.get("request"))
        for key, value in expected.items():
            if type(result.get(key)) is not type(value) or result.get(key) != value:
                raise VerificationError("result identity mismatch: " + key)
        self.parent()
        return result

    def cleanup(self):
        """Best effort, only recorded IDs, no cleanup-induced success authority."""
        for run_id in self.candidates:
            try:
                run = self.api.get(self.run_path(run_id))
                if run.get("status") != "completed":
                    self.api.post(self.run_path(run_id) + "/cancel")
            except Exception:
                pass

    def execute(self):
        try:
            self.parent()
            self.reconcile_old()
            selected = self.wait(self.dispatch(0, "hosted"), "hosted")
            return self.verify_result(selected)
        finally:
            self.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--objective", required=True, choices=("rust", "lint_macos"))
    args = parser.parse_args()
    # Identity construction is intentionally separate from the state machine.
    request = build_request(GitHub(), args.objective)
    api = GitHub()
    controller = Controller(api, request, os.environ["CI_MACOS_WORKER_REF"], fallback_enabled(request))
    def stop(signum, frame):
        raise VerificationError("controller interrupted")
    signal.signal(signal.SIGTERM, stop)
    result = controller.execute()
    if args.objective == "rust" and request["coverage"] == "full":
        print("::notice title=proved-tree::" + result["request"]["tree_sha"])


def build_request(api, objective):
    """Resolve source and parent identities from the Actions environment and API."""
    repository = os.environ["GITHUB_REPOSITORY"]
    prefix = "repos/" + repository
    parent_run_id = int(os.environ["GITHUB_RUN_ID"])
    parent_attempt = int(os.environ["GITHUB_RUN_ATTEMPT"])
    parent = api.get(prefix + "/actions/runs/" + str(parent_run_id))
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
        event = json.load(stream, object_pairs_hook=unique_object)
    event_name = os.environ["GITHUB_EVENT_NAME"]
    source_sha = os.environ["GITHUB_SHA"]
    commit = api.get(prefix + "/git/commits/" + source_sha)
    if commit.get("sha") != source_sha:
        raise VerificationError("source commit lookup mismatch")
    tree_sha = commit["tree"]["sha"]
    pr_number = 0
    head_sha = source_sha
    base_sha = ""
    if event_name == "pull_request":
        pr_number = event["number"]
        pr = api.get(prefix + "/pulls/" + str(pr_number))
        if pr["head"]["repo"]["full_name"] != repository or pr["base"]["ref"] != "omp2":
            raise VerificationError("PR is not eligible for controller dispatch")
        head_sha, base_sha = pr["head"]["sha"], pr["base"]["sha"]
        if pr.get("merge_commit_sha") != source_sha or [p["sha"] for p in commit.get("parents", [])] != [base_sha, head_sha]:
            raise VerificationError("parent checkout is not the current PR merge")
    elif event_name == "push":
        if event.get("ref") != "refs/heads/omp2" or event.get("after") != source_sha:
            raise VerificationError("push is not eligible for controller dispatch")
    elif event_name == "merge_group":
        group = event["merge_group"]
        if group.get("base_ref") != "refs/heads/omp2" or group.get("head_sha") != source_sha:
            raise VerificationError("merge group identity mismatch")
        base_sha = group["base_sha"]
    else:
        raise VerificationError("event is not eligible for controller dispatch")
    jobs = api.paginate(prefix + "/actions/runs/" + str(parent_run_id) + "/attempts/" + str(parent_attempt) + "/jobs", "jobs")
    name = {"rust": "Rust workspace and acceptance proofs", "lint_macos": "Lint workspace (macOS)"}[objective]
    matches = [job for job in jobs if job.get("name") == name and job.get("status") == "in_progress"]
    if len(matches) != 1:
        raise VerificationError("cannot identify owning controller job")
    def packages(variable):
        words = shlex.split(os.environ.get(variable, ""))
        if len(words) % 2 or any(words[i] != "-p" for i in range(0, len(words), 2)):
            raise VerificationError("invalid affected package arguments")
        return words[1::2]
    coverage = os.environ.get("AFFECTED_SCOPE", "full") or "full"
    if coverage == "all":
        coverage = "full"
    selected_packages = packages("AFFECTED_ARGS")
    selected_docs = packages("AFFECTED_DOC_ARGS")
    if objective == "lint_macos":
        coverage, selected_packages, selected_docs = "full", [], []
    request = dict(version=1, repository=repository, repository_id=parent["repository"]["id"],
                   parent_run_id=parent_run_id, parent_attempt=parent_attempt,
                   parent_job_id=matches[0]["id"], parent_job=objective, objective=objective,
                   event=event_name, source_sha=source_sha, tree_sha=tree_sha,
                   pr_number=pr_number, head_sha=head_sha, base_sha=base_sha,
                   worker_sha=os.environ["CI_MACOS_WORKER_SHA"], nonce=secrets.token_hex(16),
                   generation=0, pool="hosted", hosted_run_id=0, coverage=coverage,
                   packages=selected_packages, doc_packages=selected_docs,
                   actor=parent["actor"]["login"], triggering_actor=parent["triggering_actor"]["login"])
    request = validate_request(request)
    verify_parent(api, request, require_running=True)
    return request


def fallback_enabled(request):
    """Configuration must authorize Mac admission before hosted cancellation."""
    if (os.environ.get("CI_MACOS_FALLBACK_ENABLED") != "true" or
            os.environ.get("CI_MACOS_FALLBACK_TRUST") != "repository-writers" or
            request["actor"] != "blyzer" or request["triggering_actor"] != "blyzer" or
            (os.environ.get("CI_MACOS_CONTROL_POLICY") != "source-bound" and
             not re.fullmatch(r"[0-9a-f]{64}", os.environ.get("CI_MACOS_PARENT_WORKFLOW_SHA256", "")))):
        return False
    try:
        labels = json.loads(os.environ.get("CI_MACOS_FALLBACK_LABELS", ""))
    except ValueError:
        return False
    return (isinstance(labels, list) and len(labels) >= 3
            and all(isinstance(label, str) and re.fullmatch(r"[A-Za-z0-9_.-]+", label) for label in labels)
            and len(set(labels)) == len(labels)
            and "self-hosted" in labels and "macOS" in labels and "ARM64" in labels)


if __name__ == "__main__":
    try:
        main()
    except (VerificationError, OSError, KeyError, ValueError) as error:
        print("macOS controller refused: " + str(error), file=sys.stderr)
        sys.exit(1)
