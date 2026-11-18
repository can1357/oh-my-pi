"""Validated package reuse tests; fixture bytes, no native Mac build claim."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import package_macos_evidence as evidence

try:
    import yaml
except ImportError:
    yaml = None


ROOT = Path(__file__).resolve().parents[1]


class PackageEvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.sha = "a" * 40
        prefix = "omp-" + self.sha[:7] + "-aarch64-apple-darwin"
        self.value = {"schema": 1, "source_sha": self.sha, "run_id": 10, "run_attempt": 2,
                      "target": "aarch64-apple-darwin", "install_smoke": "passed",
                      "build_command": evidence.COMMAND, "artifacts": {},
                      "release_profile": {"lto": "thin"}, "build_overrides": {},
                      "rustc": "rustc fixture\nhost: aarch64-apple-darwin",
                      "python_config": "vendor/python-release/pyo3-config.txt",
                      "input_sha256": {name: "0" * 64 for name in evidence.INPUTS}}
        for suffix in (".tar.gz", ".pkg", ".sha256"):
            name = prefix + suffix
            data = ("fixture:" + suffix).encode()
            (self.directory / name).write_bytes(data)
            self.value["artifacts"][name] = hashlib.sha256(data).hexdigest()
        self.write()

    def write(self, value=None):
        (self.directory / evidence.MANIFEST).write_text(json.dumps(value or self.value))

    def validate(self):
        return evidence.validate(self.directory, self.sha, 10, 2)

    def test_exact_same_source_and_run_assets_validate(self):
        self.assertEqual(self.validate(), self.value)

    def test_ambiguous_manifest_is_rejected(self):
        path = self.directory / evidence.MANIFEST
        path.write_text(path.read_text().replace('"schema": 1', '"schema": 1, "schema": 1'))
        with self.assertRaises(ValueError):
            self.validate()

    def test_missing_build_provenance_cannot_be_published_as_validated(self):
        for key in ("rustc", "release_profile", "input_sha256"):
            bad = dict(self.value)
            del bad[key]
            self.write(bad)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()

    def test_record_binds_real_checkout_build_profile_and_smoked_asset_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = Path.cwd()
            try:
                os.chdir(root)
                for name in ("Cargo.lock", "rust-toolchain.toml", "scripts/package-macos.sh",
                             "scripts/install-smoke-macos.sh", "crates/py/requirements.txt",
                             "crates/py/scripts/fetch-python.sh", "vendor/python-release/pyo3-config.txt"):
                    path = Path(name)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("fixture")
                Path("Cargo.toml").write_text('[profile.release]\nlto="thin"\ncodegen-units=1\n')
                def git(*args):
                    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", *args], text=True)
                git("init", "--quiet")
                git("add", ".")
                git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture")
                sha = git("rev-parse", "HEAD").strip()
                prefix = "omp-" + git("rev-parse", "--short", "HEAD").strip() + "-aarch64-apple-darwin"
                dist = Path("dist")
                dist.mkdir()
                for suffix in (".tar.gz", ".pkg", ".sha256"):
                    (dist / (prefix + suffix)).write_text("smoked fixture")
                def run(command, **kwargs):
                    if command == ["rustc", "-Vv"]:
                        return "rustc fixture\nhost: aarch64-apple-darwin"
                    return subprocess.check_output(command, **kwargs)
                with patch.dict(os.environ, {"CARGO_BUILD_JOBS": "4"}):
                    result = evidence.record(dist, sha, 9, 1, run)
                self.assertEqual(result["release_profile"]["lto"], "thin")
                self.assertEqual(result["build_overrides"]["CARGO_BUILD_JOBS"], "4")
                self.assertEqual(evidence.validate(dist, sha, 9, 1), result)
                Path("Cargo.lock").write_text("dirty")
                with self.assertRaises(subprocess.CalledProcessError):
                    evidence.record(dist, sha, 9, 1, run)
            finally:
                os.chdir(previous)

    def test_source_attempt_smoke_target_and_build_mismatch_are_rejected(self):
        for key, item in (("source_sha", "b" * 40), ("run_id", 11), ("run_attempt", 1),
                          ("install_smoke", "failed"), ("target", "x86_64-linux"),
                          ("build_command", ["cargo", "build"])):
            bad = dict(self.value, **{key: item})
            self.write(bad)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()

    def test_changed_or_missing_package_bytes_are_rejected(self):
        name = next(iter(self.value["artifacts"]))
        (self.directory / name).write_text("changed")
        with self.assertRaises(ValueError):
            self.validate()
        (self.directory / name).unlink()
        with self.assertRaises(ValueError):
            self.validate()

    def test_asset_paths_and_incomplete_sets_are_rejected(self):
        bad = copy.deepcopy(self.value)
        checksum = bad["artifacts"].pop(next(iter(bad["artifacts"])))
        bad["artifacts"]["../outside.pkg"] = checksum
        self.write(bad)
        with self.assertRaises(ValueError):
            self.validate()
        self.write(dict(self.value, artifacts={}))
        with self.assertRaises(ValueError):
            self.validate()

    def test_unlisted_and_symlink_files_are_rejected(self):
        extra = self.directory / "extra"
        extra.write_text("unexpected")
        with self.assertRaises(ValueError):
            self.validate()
        extra.unlink()
        name = next(iter(self.value["artifacts"]))
        original = self.directory / name
        original.rename(extra)
        original.symlink_to(extra)
        with self.assertRaises(ValueError):
            self.validate()

    def test_draft_publish_reuses_validated_bytes_without_compilation(self):
        run = Mock(return_value=subprocess.CompletedProcess([], 1, stderr="HTTP 404"))
        env = {"GITHUB_REPOSITORY": "blyzer/oh-my-pi", "GITHUB_REF": "refs/heads/omp2",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "blyzer"}
        with patch.dict(os.environ, env, clear=True):
            evidence.publish(self.directory, self.sha, 10, 2, run)
        create = run.call_args_list[-1].args[0]
        self.assertEqual(create[:3], ["gh", "release", "create"])
        self.assertIn("--draft", create)
        self.assertEqual(create[create.index("--target") + 1], self.sha)
        self.assertEqual(set(create[-4:]), {str(self.directory / name) for name in self.value["artifacts"]} | {str(self.directory / evidence.MANIFEST)})
        self.assertEqual(run.call_count, 2)

    def test_draft_publication_refuses_external_untrusted_or_non_omp2_requests(self):
        env = {"GITHUB_REPOSITORY": "blyzer/oh-my-pi", "GITHUB_REF": "refs/heads/omp2",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "blyzer"}
        for key, item in (("GITHUB_REPOSITORY", "outside/fork"), ("GITHUB_REF", "refs/heads/topic"),
                          ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_ACTOR", "someone")):
            run = Mock()
            with patch.dict(os.environ, dict(env, **{key: item}), clear=True), self.assertRaises(ValueError):
                evidence.publish(self.directory, self.sha, 10, 2, run)
            run.assert_not_called()

    def test_existing_tag_or_uncertain_lookup_never_publishes(self):
        env = {"GITHUB_REPOSITORY": "blyzer/oh-my-pi", "GITHUB_REF": "refs/heads/omp2",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "blyzer"}
        for result in (subprocess.CompletedProcess([], 0, stderr=""),
                       subprocess.CompletedProcess([], 1, stderr="HTTP 403")):
            run = Mock(return_value=result)
            with patch.dict(os.environ, env, clear=True), self.assertRaises(ValueError):
                evidence.publish(self.directory, self.sha, 10, 2, run)
            self.assertEqual(run.call_count, 1)

    def test_tampered_bytes_do_not_reach_any_publication_api(self):
        (self.directory / next(iter(self.value["artifacts"]))).write_text("tampered")
        run = Mock()
        with self.assertRaises(ValueError):
            evidence.publish(self.directory, self.sha, 10, 2, run)
        run.assert_not_called()


class PackagingWorkflowTests(unittest.TestCase):
    @unittest.skipIf(yaml is None, "PyYAML is optional")
    def test_smoke_gates_normal_upload_and_publication_has_separate_permissions(self):
        workflow = yaml.load((ROOT / ".github/workflows/package-macos.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow["on"]), {"workflow_dispatch"})
        jobs = workflow["jobs"]
        steps = jobs["package"]["steps"]
        smoke = next(step for step in steps if step.get("name") == "Install smoke")
        upload = next(step for step in steps if step.get("name") == "Upload packages")
        self.assertNotIn("continue-on-error", smoke)
        self.assertNotIn("if", upload)
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertEqual(jobs["publish"]["permissions"], {"contents": "write"})
        self.assertEqual(jobs["publish"]["needs"], "package")
        self.assertIn("inputs.publish_draft", jobs["publish"]["if"])
        self.assertIn("github.ref == 'refs/heads/omp2'", jobs["publish"]["if"])
        self.assertNotIn("BUILDBUDDY", str(jobs["publish"]))
        download = next(step for step in jobs["publish"]["steps"] if step.get("name", "").startswith("Download"))
        self.assertNotIn("run-id", download["with"])
        self.assertNotIn("github-token", download["with"])


if __name__ == "__main__":
    unittest.main()
