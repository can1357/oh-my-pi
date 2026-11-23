#!/usr/bin/env python3
"""Offline protocol tests: no dispatches or GitHub credentials are used."""

import io
import json
import os
import unittest
import zipfile
from unittest.mock import patch

import macos_fallback_controller as controller


def request():
    return dict(version=1, repository="owner/repo", repository_id=1,
                parent_run_id=10, parent_attempt=2, parent_job_id=20, parent_job="rust",
                objective="rust", event="push", source_sha="a" * 40, tree_sha="b" * 40,
                pr_number=0, head_sha="a" * 40, base_sha="", worker_sha="c" * 40,
                nonce="d" * 32, generation=0, pool="hosted", hosted_run_id=0,
                coverage="full", packages=[], doc_packages=[], actor="blyzer", triggering_actor="blyzer")


def archive(text, name="macos-result.json"):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.writestr(name, text)
    return buffer.getvalue()


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class SourceBoundFallbackTests(unittest.TestCase):
    def test_changed_controls_do_not_require_a_frozen_parent_workflow_digest(self):
        env = {"CI_MACOS_FALLBACK_ENABLED": "true", "CI_MACOS_FALLBACK_TRUST": "repository-writers",
               "CI_MACOS_CONTROL_POLICY": "source-bound",
               "CI_MACOS_FALLBACK_LABELS": '["self-hosted","macOS","ARM64"]'}
        with patch.dict(os.environ, env, clear=True):
            self.assertTrue(controller.fallback_enabled(request()))
            for field, value in (("CI_MACOS_FALLBACK_ENABLED", "false"),
                                 ("CI_MACOS_FALLBACK_TRUST", ""),
                                 ("CI_MACOS_FALLBACK_LABELS", '["macos-15"]'),
                                 ("CI_MACOS_CONTROL_POLICY", "")):
                with self.subTest(field=field), patch.dict(os.environ, {field: value}):
                    self.assertFalse(controller.fallback_enabled(request()))
            self.assertFalse(controller.fallback_enabled(dict(request(), triggering_actor="outsider")))


class FakeAPI:
    def __init__(self):
        self.posts = []

    def post(self, path, body=None):
        self.posts.append((path, body))
        return None


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.verification = patch.object(controller, "verify_parent")
        self.liveness = patch.object(controller, "verify_parent_liveness")
        self.mac_policy = patch.object(controller, "verify_mac_configuration")
        self.verification.start()
        self.liveness.start()
        self.mac_policy.start()
        self.addCleanup(self.verification.stop)
        self.addCleanup(self.liveness.stop)
        self.addCleanup(self.mac_policy.stop)
        self.clock = Clock()
        self.api = FakeAPI()
        self.subject = controller.Controller(self.api, request(), "ci-macos-worker-v1", True,
                                             self.clock, self.clock.sleep)
        self.subject.candidates.add(30)

    def queued(self):
        return ({"id": 30, "run_attempt": 1, "status": "queued"}, None)

    def completed(self, conclusion="success"):
        return ({"id": 30, "run_attempt": 1, "status": "completed", "conclusion": conclusion}, None)

    def test_exact_queue_threshold_and_one_fallback(self):
        seen = []
        def cancel(run_id):
            seen.append(self.clock())
            return "cancelled"
        def snapshot(run_id):
            return self.queued() if run_id == 30 else self.completed()
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle", side_effect=cancel), patch.object(self.subject, "dispatch", return_value=31) as dispatch:
            self.assertEqual(self.subject.wait(30, "hosted"), 31)
        self.assertEqual(seen, [300])
        self.assertEqual(self.clock(), 450)
        dispatch.assert_called_once_with(1, "self-hosted", 30)

    def test_queued_job_started_at_is_not_assignment(self):
        def snapshot(run_id):
            if run_id != 30:
                return self.completed()
            run, _ = self.queued()
            return run, dict(status="queued", runner_id=0, runner_name="", started_at="2026-11-17T17:44:00Z")
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle", return_value="cancelled") as cancel, patch.object(self.subject, "dispatch", return_value=31):
            self.assertEqual(self.subject.wait(30, "hosted"), 31)
            cancel.assert_called_once_with(30)
        self.assertEqual(self.clock(), 450)

    def test_assignment_at_cancel_recheck_commits_to_hosted(self):
        def snapshot(run_id):
            if self.clock() < 300:
                return self.queued()
            if self.clock() == 300:
                self.clock.now += 1
                return self.queued()
            if self.clock() < 360:
                return ({"id": 30, "run_attempt": 1, "status": "in_progress"}, {"runner_id": 7})
            return self.completed()
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle") as cancel:
            self.assertEqual(self.subject.wait(30, "hosted"), 30)
            cancel.assert_not_called()

    def test_cancel_202_never_means_settlement(self):
        with patch.object(self.subject, "snapshot", side_effect=lambda run_id: self.queued()):
            with self.assertRaises(controller.VerificationError):
                self.subject.cancel_settle(30)
        self.assertEqual(self.clock(), 600)
        self.assertEqual(len(self.api.posts), 1)

    def test_cancel_409_then_success_preserves_hosted_result(self):
        self.api.post = unittest.mock.Mock(side_effect=controller.APIError(409))
        with patch.object(self.subject, "snapshot", return_value=self.completed()):
            self.assertEqual(self.subject.cancel_settle(30), "success")
        self.assertEqual(self.api.post.call_count, 1)

    def test_cancel_409_without_settlement_fails_bounded(self):
        self.api.post = unittest.mock.Mock(side_effect=controller.APIError(409))
        with patch.object(self.subject, "snapshot", return_value=self.queued()):
            with self.assertRaises(controller.VerificationError):
                self.subject.cancel_settle(30)
        self.assertEqual(self.api.post.call_count, 1)
        self.assertEqual(self.clock(), 600)

    def test_uncertain_cancel_response_still_requires_terminal_cancel(self):
        self.api.post = unittest.mock.Mock(side_effect=controller.APIError())
        with patch.object(self.subject, "snapshot", return_value=self.completed("cancelled")):
            self.assertEqual(self.subject.cancel_settle(30), "cancelled")
        self.assertEqual(self.api.post.call_count, 1)

    def test_late_hosted_success_wins(self):
        with patch.object(self.subject, "snapshot", side_effect=lambda run_id: self.queued()), patch.object(self.subject, "cancel_settle", return_value="success"), patch.object(self.subject, "dispatch") as dispatch:
            self.assertEqual(self.subject.wait(30, "hosted"), 30)
            dispatch.assert_not_called()

    def test_hosted_failure_dispatches_fallback(self):
        """When a hosted runner fails, the controller falls back to self-hosted."""
        def snapshot(run_id):
            if run_id == 30:
                return self.completed("failure")
            return self.completed("success")
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle", return_value="cancelled"), patch.object(self.subject, "dispatch", return_value=31) as dispatch:
            self.assertEqual(self.subject.wait(30, "hosted"), 31)
        dispatch.assert_called_once_with(1, "self-hosted", 30)

    def test_failure_never_dispatches_fallback_when_disabled(self):
        """When fallback is disabled, a failed hosted runner raises immediately."""
        self.subject.fallback = False
        with patch.object(self.subject, "snapshot", return_value=self.completed("failure")), patch.object(self.subject, "dispatch") as dispatch:
            with self.assertRaises(controller.VerificationError):
                self.subject.wait(30, "hosted")
            dispatch.assert_not_called()

    def test_disabled_mac_retains_hosted_beyond_threshold(self):
        self.subject.fallback = False
        def snapshot(run_id):
            return self.queued() if self.clock() < 360 else self.completed()
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle") as cancel:
            self.assertEqual(self.subject.wait(30, "hosted"), 30)
            cancel.assert_not_called()
        self.assertEqual(self.clock(), 360)

    def test_rejected_mac_policy_retains_hosted(self):
        def snapshot(run_id):
            return self.queued() if self.clock() < 360 else self.completed()
        with patch.object(controller, "verify_mac_configuration", side_effect=controller.VerificationError("unreviewed workflow")), patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle") as cancel:
            self.assertEqual(self.subject.wait(30, "hosted"), 30)
            cancel.assert_not_called()
        self.assertFalse(self.subject.fallback)

    def test_attempt_age_is_not_inherited(self):
        calls = 0
        def snapshot(run_id):
            nonlocal calls
            calls += 1
            run, job = self.queued()
            run["created_at"] = "2000-01-01T00:00:00Z"
            if calls > 1:
                run["run_attempt"] = 2
            return run, job
        with patch.object(self.subject, "snapshot", side_effect=snapshot), patch.object(self.subject, "cancel_settle") as cancel:
            with self.assertRaises(controller.VerificationError):
                self.subject.wait(30, "hosted")
            cancel.assert_not_called()

    def test_ambiguous_dispatch_discovery_fails(self):
        run = dict(id=30, display_title=self.subject.title(0), event="workflow_dispatch",
                   head_sha=request()["worker_sha"], repository={"id": 1}, path=".github/workflows/macos-verification.yml")
        self.api.paginate = lambda path, key: [run, dict(run, id=31)]
        with self.assertRaises(controller.VerificationError):
            self.subject.discover(0)

    def test_lost_dispatch_response_reconciles_without_second_post(self):
        self.api.post = unittest.mock.Mock(side_effect=controller.APIError())
        candidate = {"id": 31}
        with patch.object(controller, "resolve_worker_ref", return_value=request()["worker_sha"]), patch.object(self.subject, "discover", side_effect=[None, None, candidate]):
            self.assertEqual(self.subject.dispatch(0, "hosted"), 31)
        self.assertEqual(self.api.post.call_count, 1)
        self.assertEqual(self.clock(), 30)
        self.assertEqual(self.subject.requests[31]["generation"], 0)

    def test_dispatch_response_id_must_match_discovery(self):
        self.api.post = lambda path, body: {"workflow_run_id": 31}
        with patch.object(controller, "resolve_worker_ref", return_value=request()["worker_sha"]), patch.object(self.subject, "discover", side_effect=[None, {"id": 32}]):
            with self.assertRaises(controller.VerificationError):
                self.subject.dispatch(0, "hosted")

    def test_unknown_dispatch_is_not_retried(self):
        self.api.post = unittest.mock.Mock(return_value=None)
        with patch.object(controller, "resolve_worker_ref", return_value=request()["worker_sha"]), patch.object(self.subject, "discover", return_value=None):
            with self.assertRaises(controller.VerificationError):
                self.subject.dispatch(0, "hosted")
        self.assertEqual(self.api.post.call_count, 1)
        self.assertEqual(self.clock(), 120)

    def test_older_attempt_reconciled_and_guard_expiry_waited(self):
        run = dict(id=29, display_title="macos:10:1:rust:" + "e" * 32 + ":0", status="queued",
                   event="workflow_dispatch", head_sha="f" * 40, head_branch="ci-macos-worker-v0", repository={"id": 1}, path=".github/workflows/macos-verification.yml")
        self.api.paginate = lambda path, key: [run] if key == "workflow_runs" else []
        self.api.get = lambda path: dict(run, status="completed", conclusion="cancelled", run_attempt=2)
        with patch.object(controller, "resolve_worker_ref", return_value="f" * 40) as resolve:
            self.subject.reconcile_old()
            self.assertEqual(resolve.call_count, 2)
        self.assertEqual(self.api.posts, [("repos/owner/repo/actions/runs/29/cancel", None)])
        self.assertEqual(self.clock(), 150)

    def test_moving_or_missing_historical_tag_blocks_replacement(self):
        run = dict(id=29, display_title="macos:10:1:rust:" + "e" * 32 + ":0", status="queued",
                   event="workflow_dispatch", head_sha="f" * 40, head_branch="ci-macos-worker-v0", repository={"id": 1}, path=".github/workflows/macos-verification.yml")
        self.api.paginate = lambda path, key: [run]
        for effect in ("0" * 40, controller.APIError(404)):
            with self.subTest(effect=effect), patch.object(controller, "resolve_worker_ref", **({"side_effect": effect} if isinstance(effect, Exception) else {"return_value": effect})), patch.object(self.subject, "cancel_settle") as cancel:
                with self.assertRaises(controller.VerificationError):
                    self.subject.reconcile_old()
                cancel.assert_not_called()

    def test_owned_candidate_poll_does_not_fetch_job_list(self):
        run = dict(id=30, run_attempt=1, status="in_progress", event="workflow_dispatch",
                   head_sha=request()["worker_sha"], repository={"id": 1}, path=".github/workflows/macos-verification.yml")
        self.api.get = lambda path: run
        self.api.paginate = unittest.mock.Mock(side_effect=AssertionError("unnecessary job read"))
        self.subject.owned.add(30)
        self.assertEqual(self.subject.snapshot(30), (run, None))

    def test_malformed_artifacts(self):
        for data in (b"not zip", archive('{"x":1,"x":2}'), archive("{}", "../macos-result.json"), archive("[]")):
            with self.subTest(data=data[:20]):
                with self.assertRaises(controller.VerificationError):
                    controller.decode_artifact(data)

    def test_stale_proof_rejected(self):
        run = dict(id=30, run_attempt=1, status="completed", conclusion="success", display_title=self.subject.title(0))
        job = dict(conclusion="success", steps=[dict(name="Run native objective", status="completed", conclusion="success")])
        self.subject.requests[30] = request()
        result = dict(result_schema=1, request_digest="0" * 64, request=request(), outcome="success", runner_arch="arm64", objective_complete=True)
        self.api.paginate = lambda path, key: [dict(id=40, name="macos-result-" + request()["nonce"] + "-0", size_in_bytes=100)]
        self.api.get_bytes = lambda path: archive(json.dumps(result))
        with patch.object(self.subject, "snapshot", return_value=(run, job)):
            with self.assertRaises(controller.VerificationError):
                self.subject.verify_result(30)

    def test_hosted_available_returns_true_when_no_queued_runs(self):
        """When no macOS runs are queued, hosted runners appear available."""
        self.api.paginate = lambda path, key: []
        self.assertTrue(self.subject.hosted_available())

    def test_hosted_available_returns_true_when_one_queued_run(self):
        """A single queued run does not indicate backed-up hosted runners."""
        self.api.paginate = lambda path, key: [
            {"display_title": "macos:10:2:rust:" + "d" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"}
        ] if key == "workflow_runs" else []
        self.assertTrue(self.subject.hosted_available())

    def test_hosted_available_returns_false_when_queue_backed_up(self):
        """Multiple old queued runs indicate hosted runners are unavailable."""
        self.api.paginate = lambda path, key: [
            {"display_title": "macos:10:2:rust:" + "d" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
            {"display_title": "macos:10:2:rust:" + "e" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
        ] if key == "workflow_runs" else []
        self.assertFalse(self.subject.hosted_available())

    def test_hosted_available_defaults_to_true_on_api_error(self):
        """If the availability check fails, default to trying hosted."""
        self.api.paginate = lambda path, key: (_ for _ in ()).throw(controller.APIError(500))
        self.assertTrue(self.subject.hosted_available())

    def test_execute_dispatches_self_hosted_when_hosted_unavailable(self):
        """When hosted is unavailable, execute dispatches directly to self-hosted."""
        dispatched_pool = None
        def capture_dispatch(generation, pool, hosted_run_id=None):
            nonlocal dispatched_pool
            dispatched_pool = pool
            return 30
        self.api.paginate = lambda path, key: [
            {"display_title": "macos:10:2:rust:" + "d" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
            {"display_title": "macos:10:2:rust:" + "e" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
        ] if key == "workflow_runs" else []
        with patch.object(self.subject, "dispatch", side_effect=capture_dispatch), \
             patch.object(self.subject, "wait", return_value=30), \
             patch.object(self.subject, "verify_result", return_value={}), \
             patch.object(self.subject, "reconcile_old"):
            self.subject.execute()
        self.assertEqual(dispatched_pool, "self-hosted")

    def test_execute_dispatches_hosted_when_available(self):
        """When hosted is available, execute dispatches to hosted as normal."""
        dispatched_pool = None
        def capture_dispatch(generation, pool, hosted_run_id=None):
            nonlocal dispatched_pool
            dispatched_pool = pool
            return 30
        self.api.paginate = lambda path, key: []
        with patch.object(self.subject, "dispatch", side_effect=capture_dispatch), \
             patch.object(self.subject, "wait", return_value=30), \
             patch.object(self.subject, "verify_result", return_value={}), \
             patch.object(self.subject, "reconcile_old"):
            self.subject.execute()
        self.assertEqual(dispatched_pool, "hosted")

    def test_execute_skips_self_hosted_when_fallback_disabled(self):
        """When fallback is disabled, always dispatch to hosted regardless of availability."""
        self.subject.fallback = False
        dispatched_pool = None
        def capture_dispatch(generation, pool, hosted_run_id=None):
            nonlocal dispatched_pool
            dispatched_pool = pool
            return 30
        self.api.paginate = lambda path, key: [
            {"display_title": "macos:10:2:rust:" + "d" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
            {"display_title": "macos:10:2:rust:" + "e" * 32 + ":0", "status": "queued",
             "created_at": "2000-01-01T00:00:00Z"},
        ] if key == "workflow_runs" else []
        with patch.object(self.subject, "dispatch", side_effect=capture_dispatch), \
             patch.object(self.subject, "wait", return_value=30), \
             patch.object(self.subject, "verify_result", return_value={}), \
             patch.object(self.subject, "reconcile_old"):
            self.subject.execute()
        self.assertEqual(dispatched_pool, "hosted")


class BuildRequestTests(unittest.TestCase):
    """Test the build_request function directly."""

    def test_build_request_accepts_unmerged_pr(self):
        """An unmerged PR (parents empty) should not be rejected by build_request."""
        import tempfile, os
        api = unittest.mock.Mock()
        pr = dict(number=42, head=dict(sha="h" * 40, repo=dict(full_name="blyzer/oh-my-pi")),
                  base=dict(sha="b" * 40, ref="omp2"),
                  state="open", merged=False)
        commit = dict(sha="h" * 40, parents=[], tree=dict(sha="t" * 40))
        parent_run = dict(repository=dict(id=1), actor=dict(login="blyzer"),
                          triggering_actor=dict(login="blyzer"))
        api.get = lambda path: (parent_run if "/actions/runs/" in path and "/git/" not in path else
                                commit if "/git/commits/" in path else pr)
        api.paginate = lambda path, key: [
            dict(id=10, name="Rust workspace and acceptance proofs", status="in_progress"),
        ]
        event_path = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump({"number": 42}, event_path)
        event_path.close()
        env = {
            "GITHUB_REPOSITORY": "blyzer/oh-my-pi",
            "GITHUB_RUN_ID": "1",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_EVENT_PATH": event_path.name,
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_SHA": "h" * 40,
            "CI_MACOS_WORKER_SHA": "w" * 40,
            "AFFECTED_SCOPE": "full",
            "AFFECTED_ARGS": "",
            "AFFECTED_DOC_ARGS": "",
        }
        try:
            with unittest.mock.patch.dict(os.environ, env, clear=True):
                req = controller.build_request(api, "rust")
            self.assertEqual(req["pr_number"], 42)
            self.assertEqual(req["head_sha"], "h" * 40)
        finally:
            os.unlink(event_path.name)


if __name__ == "__main__":
    unittest.main()
