"""Source and token-boundary tests for the macOS verification protocol."""

import base64
import copy
import hashlib
import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch

import macos_fallback_common as common


def request():
    return {
        "version": 1, "repository": "blyzer/oh-my-pi", "repository_id": 10,
        "parent_run_id": 20, "parent_attempt": 1, "parent_job_id": 30,
        "parent_job": "rust", "objective": "rust", "event": "pull_request",
        "source_sha": "a" * 40, "tree_sha": "b" * 40, "pr_number": 42,
        "head_sha": "c" * 40, "base_sha": "d" * 40, "worker_sha": "e" * 40,
        "nonce": "f" * 32, "generation": 0, "pool": "hosted", "hosted_run_id": 0,
        "coverage": "full", "packages": [], "doc_packages": [],
        "actor": "blyzer", "triggering_actor": "blyzer",
    }


def observations(req):
    prefix = "repos/" + req["repository"]
    run = {
        "repository": {"id": 10, "full_name": req["repository"]},
        "run_attempt": 1, "status": "in_progress", "event": "pull_request",
        "path": ".github/workflows/ci.yml", "head_repository": {"full_name": req["repository"]},
        "actor": {"login": "blyzer"}, "triggering_actor": {"login": "blyzer"},
        "head_sha": req["head_sha"],
    }
    return {
        f"{prefix}/actions/runs/20": run,
        f"{prefix}/actions/jobs/30": {"run_id": 20, "run_attempt": 1, "name": common.GATES["rust"], "status": "in_progress"},
        f"{prefix}/git/commits/{req['source_sha']}": {
            "tree": {"sha": req["tree_sha"]},
            "parents": [{"sha": req["base_sha"]}, {"sha": req["head_sha"]}],
        },
        f"{prefix}/pulls/42": {
            "state": "open", "head": {"sha": req["head_sha"], "repo": {"full_name": req["repository"]}},
            "base": {"sha": req["base_sha"], "ref": "omp2"}, "merge_commit_sha": req["source_sha"],
        },
    }


class FakeAPI:
    def __init__(self, data):
        self.data = data
        self.calls = []

    def get(self, path):
        self.calls.append(path)
        return self.data[path]


class ProtocolTests(unittest.TestCase):
    def test_canonical_digest_does_not_depend_on_key_order(self):
        req = request()
        self.assertEqual(common.request_digest(req), common.request_digest(dict(reversed(list(req.items())))))

    def test_json_refuses_duplicates_nested_duplicates_and_nonfinite_numbers(self):
        for raw in ('{"x":1,"x":2}', '{"x":{"y":1,"y":2}}', '{"x":NaN}', '[]', 'x' * 16385):
            with self.subTest(raw=raw[:30]), self.assertRaises(common.VerificationError):
                common.parse_json(raw)

    def test_request_refuses_ambiguous_or_option_like_selection(self):
        for field, value in (("parent_run_id", True), ("objective", []), ("coverage", "unknown"),
                             ("packages", [{}]), ("packages", ["--workspace"]), ("nonce", "../x")):
            req = request()
            req[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(common.VerificationError):
                common.validate_request(req)

    def test_unknown_schema_fields_are_not_ignored(self):
        req = request()
        req["shell_command"] = "anything"
        with self.assertRaises(common.VerificationError):
            common.validate_request(req)

    def test_pool_generation_and_coverage_must_agree(self):
        for patch_fields in ({"pool": "self-hosted"}, {"generation": 1},
                             {"coverage": "full", "packages": ["omp-core"]},
                             {"coverage": "subset", "packages": ["omp-core", "omp-core"]}):
            req = dict(request(), **patch_fields)
            with self.subTest(patch_fields=patch_fields), self.assertRaises(common.VerificationError):
                common.validate_request(req)

    def test_current_synthetic_merge_is_admitted(self):
        req = request()
        common.verify_parent(FakeAPI(observations(req)), req)

    def test_head_base_tree_parent_and_workflow_changes_are_not_reusable(self):
        req = request()
        original = observations(req)
        changes = [
            ("actions/runs/20", "run_attempt", 2),
            ("actions/runs/20", "path", ".github/workflows/other.yml"),
            ("actions/jobs/30", "status", "completed"),
            ("actions/jobs/30", "run_attempt", 2),
            ("pulls/42", "merge_commit_sha", "0" * 40),
            (f"git/commits/{req['source_sha']}", "parents", []),
        ]
        for path, field, value in changes:
            data = copy.deepcopy(original)
            data["repos/" + req["repository"] + "/" + path][field] = value
            with self.subTest(path=path, field=field), self.assertRaises(common.VerificationError):
                common.verify_parent(FakeAPI(data), req)
        data = copy.deepcopy(original)
        data["repos/" + req["repository"] + "/pulls/42"]["base"]["sha"] = "0" * 40
        with self.assertRaises(common.VerificationError):
            common.verify_parent(FakeAPI(data), req)

    def test_external_repository_is_not_a_trusted_pr(self):
        req = request()
        data = observations(req)
        data["repos/" + req["repository"] + "/pulls/42"]["head"]["repo"]["full_name"] = "outside/repo"
        with self.assertRaises(common.VerificationError):
            common.verify_parent(FakeAPI(data), req)

    def test_lease_check_does_not_refetch_source_or_artifacts(self):
        req = request()
        api = FakeAPI(observations(req))
        common.verify_parent_liveness(api, req)
        self.assertEqual(len(api.calls), 2)
        self.assertTrue(all("/actions/" in path for path in api.calls))

    def test_mac_policy_requires_explicit_acceptance_and_actual_workflow_digest(self):
        req = request()
        code = b"reviewed workflow bytes"
        api = FakeAPI({f"repos/{req['repository']}/contents/.github/workflows/ci.yml?ref={req['source_sha']}": {
            "content": base64.b64encode(code).decode(), "encoding": "base64"}})
        env = {"CI_MACOS_FALLBACK_ENABLED": "true", "CI_MACOS_FALLBACK_TRUST": "repository-writers",
               "CI_MACOS_CONTROL_POLICY": "",
               "CI_MACOS_PARENT_WORKFLOW_SHA256": hashlib.sha256(code).hexdigest()}
        with patch.dict(os.environ, env):
            common.verify_mac_configuration(api, req)
            with patch.dict(os.environ, {"CI_MACOS_FALLBACK_TRUST": ""}):
                with self.assertRaises(common.VerificationError):
                    common.verify_mac_configuration(api, req)
            with patch.dict(os.environ, {"CI_MACOS_PARENT_WORKFLOW_SHA256": "0" * 64}):
                with self.assertRaises(common.VerificationError):
                    common.verify_mac_configuration(api, req)

    def test_release_ref_is_a_versioned_tag_not_a_moving_branch(self):
        for name in ("omp2", "main", "../x", "https://example.com"):
            with self.subTest(name=name), self.assertRaises(common.VerificationError):
                common.resolve_worker_ref(FakeAPI({}), "blyzer/oh-my-pi", name)

    def test_source_bound_policy_admits_changed_workflow_only_for_current_owner_source(self):
        req = request()
        env = {"CI_MACOS_FALLBACK_ENABLED": "true", "CI_MACOS_FALLBACK_TRUST": "repository-writers",
               "CI_MACOS_CONTROL_POLICY": "source-bound", "CI_MACOS_PARENT_WORKFLOW_SHA256": "outdated"}
        data = observations(req)
        with patch.dict(os.environ, env):
            common.verify_mac_configuration(FakeAPI(data), req)
            for mutation in ("actor", "triggering_actor", "fork", "stale", "cancelled"):
                bad = copy.deepcopy(data)
                run = bad["repos/blyzer/oh-my-pi/actions/runs/20"]
                if mutation in ("actor", "triggering_actor"):
                    run[mutation]["login"] = "someone-else"
                elif mutation == "fork":
                    run["head_repository"]["full_name"] = "outside/fork"
                elif mutation == "stale":
                    bad["repos/blyzer/oh-my-pi/pulls/42"]["head"]["sha"] = "0" * 40
                else:
                    run["status"] = "completed"
                with self.subTest(mutation=mutation), self.assertRaises(common.VerificationError):
                    common.verify_mac_configuration(FakeAPI(bad), req)

    def test_artifact_redirect_does_not_forward_the_job_token(self):
        calls = []
        class Opener:
            def open(self, req, timeout):
                calls.append(req)
                if len(calls) == 1:
                    raise urllib.error.HTTPError(req.full_url, 302, "redirect", {"Location": "https://storage.example/artifact"}, None)
                return io.BytesIO(b"zip bytes")
        api = common.GitHub("private-test-value")
        api.opener = Opener()
        self.assertEqual(api.get_bytes("repos/blyzer/oh-my-pi/actions/artifacts/1/zip"), b"zip bytes")
        self.assertIsNotNone(calls[0].get_header("Authorization"))
        # The newer API removes merge_commit_sha; source fences depend on the
        # explicit stable contract, not the server's default version.
        self.assertEqual(calls[0].get_header("X-github-api-version"), "2022-11-28")
        self.assertIsNone(calls[1].get_header("Authorization"))

    def test_only_safe_reads_retry_and_honor_retry_budget(self):
        api = common.GitHub("fixture")
        with patch.object(api, "_request", side_effect=[common.APIError(503), {"ok": True}]) as call, patch.object(common.time, "sleep") as sleep:
            self.assertEqual(api.get("repos/owner/repo"), {"ok": True})
            self.assertEqual(call.call_count, 2)
            sleep.assert_called_once_with(1)
        with patch.object(api, "_request", side_effect=common.APIError(429, 120)) as call, patch.object(common.time, "sleep") as sleep:
            with self.assertRaises(common.APIError):
                api.get("repos/owner/repo")
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()
        with patch.object(api, "_request", side_effect=common.APIError(503)) as call:
            with self.assertRaises(common.APIError):
                api.post("repos/owner/repo/actions/workflows/worker.yml/dispatches", {})
            self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
