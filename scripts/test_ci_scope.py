"""Behavioral scope tests, including real local Git diffs and safe fallbacks."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("ci_scope", ROOT / "scripts/ci_scope.py")
scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scope)


class SelectionTests(unittest.TestCase):
    def ci(self, *paths):
        return scope.classify("ci", list(paths))

    def test_python_protocol_is_policy_only(self):
        selected = self.ci("scripts/macos_worker_guard.py")
        self.assertTrue(selected["format"])
        for name in scope.CI_JOBS - {"format"}:
            self.assertFalse(selected[name], name)
        self.assertTrue(selected["macos_controls"])

    def test_docs_do_not_compile_rust(self):
        for path in ("docs/research/a.md", "README.md"):
            selected = self.ci(path)
            # Docs and top-level markdown files are ignored — they trigger no CI.
            self.assertFalse(selected["format"])
            self.assertFalse(selected["format_rust"])
            self.assertFalse(selected["rust"])
            self.assertFalse(selected["lintx_ratchet"])

    def test_agent_configs_and_scratch_do_not_trigger_ci(self):
        for path in (".agents/skills/research/SKILL.md", ".claude/skills/omp-adr/SKILL.md",
                      ".junie/plans/test.md", ".scratch/notes.md", ".omp/skills/pyo3/SKILL.md",
                      ".cm/gitstream.cm", ".remember/remember.md", "skills-lock.json",
                      "elastic/ELASTIC_SLOTS2.tex", "npm/pi-coding-agent/bin/omp.js",
                      "assets/hero.png"):
            selected = self.ci(path)
            self.assertFalse(any(selected[name] for name in scope.CI_JOBS), path)

    def test_native_mac_input_does_not_start_linux_or_buildbuddy(self):
        for path in (".github/workflows/macos-verification.yml", "scripts/ci-macos-objective.sh",
                     ".github/actions/macos-native-tools/action.yml"):
            selected = self.ci(path)
            self.assertTrue(selected["rust"], path)
            self.assertTrue(selected["lint_macos"], path)
            self.assertFalse(selected["lint_linux"], path)
            self.assertFalse(selected["remote_linux"], path)
            self.assertFalse(selected["p7_linux"], path)

    def test_shared_rust_source_runs_both_platforms(self):
        selected = self.ci("crates/agent/src/loop.rs")
        for name in ("rust", "lint_macos", "lint_linux", "p9_p10_linux", "remote_linux", "format_rust"):
            self.assertTrue(selected[name], name)
        self.assertFalse(selected["licenses"])

    def test_dependency_and_wire_changes_select_their_consumers(self):
        lock = self.ci("Cargo.lock")
        self.assertTrue(lock["licenses"])
        self.assertTrue(lock["rust"])
        proto = self.ci("crates/proto/proto/omp/env/v1/env.proto")
        self.assertTrue(proto["protobuf"])
        self.assertTrue(proto["rust"])

    def test_license_only_is_not_native_work(self):
        selected = self.ci("deny.toml")
        self.assertTrue(selected["licenses"])
        self.assertFalse(selected["rust"])
        self.assertFalse(selected["format_rust"])

    def test_known_runtime_script_does_not_compile_whole_workspace(self):
        selected = self.ci("scripts/check-spec.rs")
        self.assertTrue(selected["runtime_spec"])
        self.assertTrue(selected["format_rust"])
        self.assertFalse(selected["rust"])

    def test_standalone_lint_tool_does_not_retest_application(self):
        selected = self.ci("tools/lintx/src/main.rs")
        self.assertTrue(selected["lintx_ratchet"])
        self.assertFalse(selected["rust"])
        self.assertFalse(selected["remote_linux"])
        self.assertFalse(scope.classify("codeql", ["tools/lintx/src/main.rs"])["codeql_rust"])

    def test_remote_launcher_changes_do_not_build_on_the_mac(self):
        selected = self.ci("scripts/remote-verify.sh")
        self.assertTrue(selected["remote_linux"])
        self.assertTrue(selected["runtime_spec"])
        self.assertFalse(selected["rust"])
        self.assertFalse(selected["lint_macos"])

    def test_unknown_sources_and_unknown_scripts_fail_closed(self):
        for path in ("new-source/input.unknown", "scripts/new-production-helper.py"):
            selected = self.ci(path)
            self.assertTrue(all(selected[name] for name in scope.CI_JOBS), path)

    def test_global_selection_changes_run_full(self):
        for path in (".github/ci-job-paths.json", "scripts/ci_scope.py", ".github/workflows/ci.yml"):
            self.assertTrue(all(self.ci(path)[name] for name in scope.CI_JOBS), path)

    def test_mixed_changes_select_union(self):
        a, b = self.ci("deny.toml"), self.ci(".github/workflows/macos-verification.yml")
        both = self.ci("deny.toml", ".github/workflows/macos-verification.yml")
        for name in scope.CI_JOBS:
            self.assertEqual(both[name], a[name] or b[name], name)

    def test_complete_empty_diff_is_not_failure(self):
        self.assertFalse(any(scope.classify("ci", []).values()))

    def test_incomplete_diff_and_invalid_paths_are_full(self):
        self.assertTrue(all(scope.classify("ci", None)[name] for name in scope.CI_JOBS))
        self.assertTrue(all(self.ci("../outside")[name] for name in scope.CI_JOBS))

    def test_codeql_selects_only_language_that_changed(self):
        selected = scope.classify("codeql", ["scripts/macos_worker_guard.py"])
        self.assertEqual(json.loads(selected["codeql_languages"]), ["python"])
        self.assertFalse(selected["codeql_rust"])
        self.assertEqual(json.loads(scope.classify("codeql", ["app.py"])["codeql_languages"]), ["python"])
        selected = scope.classify("codeql", ["web/app.tsx"])
        self.assertEqual(json.loads(selected["codeql_languages"]), ["javascript-typescript"])

    def test_codeql_test_only_rust_is_not_production_extraction(self):
        selected = scope.classify("codeql", ["crates/agent/tests/lifecycle_hooks.rs"])
        self.assertFalse(selected["codeql_rust"])

    def test_p8_platforms_do_not_share_unrelated_launcher_inputs(self):
        selected = scope.classify("p8", [".github/actions/macos-native-tools/action.yml"])
        self.assertTrue(selected["p8_macos"])
        self.assertFalse(selected["p8_linux"])
        selected = scope.classify("p8", ["scripts/remote-verify.sh"])
        self.assertFalse(selected["p8_macos"])
        self.assertTrue(selected["p8_linux"])

    def test_p8_embedded_prompts_and_build_inputs_select_both_platforms(self):
        for path in ("crates/agent/prompts/personality/default.md", ".config/nextest.toml", "examples/demo/Cargo.toml", "fixtures/input.txt"):
            with self.subTest(path=path):
                selected = scope.classify("p8", [path])
                self.assertTrue(selected["p8_macos"])
                self.assertTrue(selected["p8_linux"])

    def test_configuration_rejects_missing_jobs_and_recursive_groups(self):
        config = scope.load_config()
        for bad in ("missing", "recursive"):
            changed = copy.deepcopy(config)
            if bad == "missing":
                del changed["workflows"]["ci"]["jobs"]["rust"]
            else:
                changed["groups"]["build"] = ["@build"]
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.json"
                path.write_text(json.dumps(changed))
                with self.assertRaises(scope.ScopeError):
                    scope.load_config(path)


class ChangeDiscoveryTests(unittest.TestCase):
    def test_manual_schedule_and_merge_queue_are_full(self):
        for event in ("workflow_dispatch", "schedule", "merge_group", "unrecognized"):
            self.assertIsNone(scope.changed_paths(event, {}, "blyzer/oh-my-pi", "a" * 40))

    def test_push_without_trustworthy_before_or_with_force_is_full(self):
        base = {"before": "a" * 40, "after": "b" * 40, "forced": False}
        for patch in ({"before": "0" * 40}, {"before": None}, {"forced": True}, {"forced": None}):
            self.assertIsNone(scope.changed_paths("push", dict(base, **patch), "blyzer/oh-my-pi", "b" * 40))

    def test_push_fetch_failure_does_not_become_no_changes(self):
        event = {"before": "a" * 40, "after": "b" * 40, "forced": False}
        def run(args, root):
            if args[1] == "rev-parse":
                return ("b" * 40).encode()
            raise subprocess.CalledProcessError(1, args)
        self.assertIsNone(scope.changed_paths("push", event, "blyzer/oh-my-pi", "b" * 40, run=run))

    def test_diff_parser_includes_old_and_new_names_and_deletions(self):
        self.assertEqual(scope.diff_names(b"R100\0old/name.py\0new/name.rs\0D\0deleted.rs\0"),
                         ["old/name.py", "new/name.rs", "deleted.rs"])
        with self.assertRaises(scope.ScopeError):
            scope.diff_names(b"R100\0missing")

    def test_pr_pagination_rename_and_identity_fence(self):
        metadata = {"head": {"sha": "a" * 40}, "base": {"sha": "b" * 40}, "changed_files": 1}
        event = {"number": 3, "pull_request": metadata}
        def run(args, root):
            if "--paginate" in args:
                return json.dumps([[{"filename": "docs/new.md", "previous_filename": "crates/old.rs"}]]).encode()
            return json.dumps(metadata).encode()
        self.assertEqual(scope.changed_paths("pull_request", event, "blyzer/oh-my-pi", "c" * 40, run=run),
                         ["docs/new.md", "crates/old.rs"])
        stale = {"number": 3, "pull_request": dict(metadata, head={"sha": "f" * 40})}
        self.assertIsNone(scope.changed_paths("pull_request", stale, "blyzer/oh-my-pi", "c" * 40, run=run))

    def test_truncated_or_moving_pr_is_full(self):
        metadata = {"head": {"sha": "a" * 40}, "base": {"sha": "b" * 40}, "changed_files": 2}
        event = {"number": 3, "pull_request": metadata}
        def truncated(args, root):
            return json.dumps([[{"filename": "one.py"}]] if "--paginate" in args else metadata).encode()
        self.assertIsNone(scope.changed_paths("pull_request", event, "blyzer/oh-my-pi", "c" * 40, run=truncated))

    def test_actual_local_push_tree_diff(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)
            git("init", "-q")
            git("config", "user.name", "Scope test")
            git("config", "user.email", "scope-test@example.invalid")
            (root / "old.py").write_text("fixture\n")
            git("add", ".")
            git("commit", "-qm", "before")
            before = git("rev-parse", "HEAD").decode().strip()
            git("mv", "old.py", "new.py")
            git("commit", "-qm", "after")
            after = git("rev-parse", "HEAD").decode().strip()
            paths = scope.changed_paths("push", {"before": before, "after": after, "forced": False},
                                        "blyzer/oh-my-pi", after, root=root)
            self.assertEqual(paths, ["old.py", "new.py"])


if __name__ == "__main__":
    unittest.main()
