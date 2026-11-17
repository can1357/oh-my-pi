import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class CheckCiPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copytree(ROOT / ".github", self.tmp / ".github")
        (self.tmp / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/check-ci-paths.py", self.tmp / "scripts/check-ci-paths.py")
        shutil.copy(ROOT / "scripts/ci-macos-objective.sh", self.tmp / "scripts/ci-macos-objective.sh")
        shutil.copy(ROOT / "scripts/ci_scope.py", self.tmp / "scripts/ci_scope.py")
        self.ci = self.tmp / ".github/workflows/ci.yml"

    def run_check(self):
        done = subprocess.run(
            [sys.executable, "scripts/check-ci-paths.py"], cwd=self.tmp, capture_output=True, text=True
        )
        return done.returncode, done.stdout + done.stderr

    def mutate_ci(self, old, new, count=1):
        text = self.ci.read_text()
        self.assertEqual(text.count(old), count, old)
        self.ci.write_text(text.replace(old, new))

    def mutate_job_gate(self, name, old, new):
        text = self.ci.read_text()
        start = text.index(f"\n  {name}:\n") + 1
        nxt = text.find("\n  ", start + len(name) + 4)
        while nxt != -1 and text[nxt + 3 : nxt + 4] == " ":
            nxt = text.find("\n  ", nxt + 1)
        end = len(text) if nxt == -1 else nxt
        body = text[start:end]
        self.assertEqual(body.count(old), 1, f"{name}: {old}")
        self.ci.write_text(text[:start] + body.replace(old, new) + text[end:])

    def test_unmodified_tree_passes(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)

    def test_missing_merge_group_trigger_fails(self):
        self.mutate_ci("  merge_group:\n    types: [checks_requested]\n", "")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("merge_group", out)

    def test_merge_group_without_checks_requested_fails(self):
        self.mutate_ci("types: [checks_requested]", "types: [destroyed]")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("checks_requested", out)

    def test_changes_job_without_selector_fails(self):
        self.mutate_ci('python3 scripts/ci_scope.py --workflow ci --github-output "$GITHUB_OUTPUT"', 'echo "ci=true"')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("selector", out)

    def test_changes_job_without_workflow_selection_fails(self):
        self.mutate_ci('scripts/ci_scope.py --workflow ci --github-output', 'scripts/ci_scope.py --github-output')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("PR/push diffs and manual/merge-group full fallback", out)

    def test_heavy_job_gated_on_ci_only_fails(self):
        self.mutate_job_gate("p7_linux", "needs.changes.outputs.p7_linux != 'false'", "needs.changes.outputs.ci != 'false'")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("p7_linux", out)

    def test_light_job_gated_on_rust_fails(self):
        self.mutate_job_gate("protobuf", "needs.changes.outputs.protobuf != 'false'", "needs.changes.outputs.rust != 'false'")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("protobuf", out)

    def test_missing_declared_scope_fails(self):
        self.mutate_ci('      protobuf: ${{ steps.paths.outputs.protobuf }}\n', '')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("protobuf scope output", out)

    def test_push_path_filter_fails(self):
        self.mutate_ci('  push:\n', '  push:\n    paths: ["crates/**"]\n')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("push must not filter", out)

    def test_pull_request_path_filter_fails(self):
        self.mutate_ci('  pull_request:\n', '  pull_request:\n    paths-ignore: ["docs/**"]\n')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("pull_request must not filter", out)

    def test_scope_true_gate_does_not_fail_closed(self):
        self.mutate_job_gate("rust", "needs.changes.outputs.rust != 'false'", "needs.changes.outputs.rust == 'true'")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("fail closed", out)

    def test_missing_selector_file_fails(self):
        (self.tmp / 'scripts/ci_scope.py').unlink()
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("selector", out)

    def test_missing_scoped_job_fails(self):
        self.mutate_ci('  protobuf:\n', '  renamed_protobuf:\n')
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("SCOPED_JOBS names a job", out)

    def test_missing_job_gate_fails(self):
        self.mutate_job_gate("lint_linux", "needs.changes.outputs.lint_linux != 'false'", "true")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("lint_linux must fail closed", out)

    def test_cancelled_guard_is_required(self):
        self.mutate_job_gate("p7_linux", "!cancelled() && ", "")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("p7_linux must fail closed", out)

    def test_rust_format_steps_must_use_format_rust_scope(self):
        self.mutate_job_gate("format", "- name: Check formatting\n        if: needs.changes.outputs.format_rust != 'false'", "- name: Check formatting\n        if: needs.changes.outputs.format != 'false'")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("format_rust gate", out)

    def test_rust_setup_gate_must_fail_closed(self):
        self.mutate_job_gate("format", "- name: Select pinned Rust toolchain\n        if: needs.changes.outputs.format_rust != 'false'", "- name: Select pinned Rust toolchain\n        if: needs.changes.outputs.format_rust == 'true'")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("format_rust gate", out)


    def test_affected_job_without_the_opt_in_variable_fails(self):
        self.mutate_ci("vars.CI_AFFECTED_ONLY == 'true' && ", "")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("CI_AFFECTED_ONLY", out)

    def test_proved_tree_recorded_for_a_narrowed_run_fails(self):
        objective = self.tmp / 'scripts/ci-macos-objective.sh'
        objective.write_text(objective.read_text().replace(' && [ "${AFFECTED_SCOPE:-full}" != subset ]', ''))
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("proved-tree", out)

    def test_affected_job_on_every_event_fails(self):
        self.mutate_ci("github.event_name == 'pull_request' && vars.CI_AFFECTED_ONLY", "vars.CI_AFFECTED_ONLY")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("pull-request only", out)


def step_script(step_name):
    script = (ROOT / 'scripts/ci-macos-objective.sh').read_text()
    return script.split(f'# {step_name}\n', 1)[1].split('\n# ', 1)[0]


class AffectedScopeFallback(unittest.TestCase):
    def run_step(self, step, scope, args=""):
        script = "cargo() { echo \"cargo $*\"; }\n" + step_script(step)
        done = subprocess.run(
            ["bash", "-c", script],
            env={"AFFECTED_SCOPE": scope, "AFFECTED_ARGS": args, "AFFECTED_DOC_ARGS": args, "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def test_workspace_tests_run_everything_when_the_job_did_not_run(self):
        for scope in ("", "all", "unexpected"):
            out = self.run_step("Test workspace", scope, "-p omp-x")
            self.assertEqual(out, "cargo nextest run --profile ci --workspace --exclude omp-e2e --locked", scope)

    def test_workspace_tests_run_only_the_selected_crates_for_a_subset(self):
        out = self.run_step("Test workspace", "subset", "-p omp-a -p omp-b")
        self.assertEqual(out, "cargo nextest run --profile ci -p omp-a -p omp-b --locked")

    def test_workspace_tests_run_everything_when_a_subset_has_no_arguments(self):
        out = self.run_step("Test workspace", "subset", "")
        self.assertEqual(out, "cargo nextest run --profile ci --workspace --exclude omp-e2e --locked")

    def test_doctests_skip_when_a_subset_has_no_library_crate(self):
        out = self.run_step("Test doctests", "subset", "")
        self.assertNotIn("cargo", out)
        self.assertIn("skipping", out)

    def test_workspace_tests_skip_when_nothing_is_affected(self):
        out = self.run_step("Test workspace", "none")
        self.assertNotIn("cargo", out)
        self.assertIn("skipping", out)

    def test_doctests_follow_the_same_scope(self):
        self.assertEqual(self.run_step("Test doctests", ""), "cargo test --doc --workspace --exclude omp-e2e --locked")
        self.assertEqual(self.run_step("Test doctests", "subset", "-p omp-a"), "cargo test --doc -p omp-a --locked")
        self.assertIn("skipping", self.run_step("Test doctests", "none"))


if __name__ == "__main__":
    unittest.main()
