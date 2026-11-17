#!/usr/bin/env python3
"""Policy checks for path-scoped, non-required CodeQL and P8 workflows.

The text checks run with only the standard library. When PyYAML is available,
also verify the actual YAML structure used by GitHub Actions.
"""

from pathlib import Path
import re
import unittest

try:
    import yaml
except ImportError:
    yaml = None


ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    return (ROOT / ".github/workflows" / name).read_text()


def job(text, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:\n|\Z)", text, re.M | re.S)
    if match is None:
        raise AssertionError(f"Missing job: {name}")
    return match.group(1)


class OptionalWorkflowPolicy(unittest.TestCase):
    def test_selectors_have_bounded_read_only_execution(self):
        for name, scope in (("codeql.yml", "codeql"), ("p8-baseline.yml", "p8")):
            text = workflow(name)
            changes = job(text, "changes")
            with self.subTest(workflow=name):
                self.assertIn("permissions:\n  contents: read", text)
                self.assertIn("runs-on: ubuntu-24.04", changes)
                self.assertIn("timeout-minutes: 5", changes)
                self.assertIn("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", changes)
                self.assertIn("GH_TOKEN: ${{ github.token }}", changes)
                self.assertIn(f'python3 scripts/ci_scope.py --workflow {scope} --github-output "$GITHUB_OUTPUT"', changes)
                self.assertNotIn("github.event.", changes)

    def test_missing_or_failed_selector_runs_expensive_jobs(self):
        for filename, name, output in (
            ("codeql.yml", "analyze-rust", "codeql_rust"),
            ("p8-baseline.yml", "record", "p8_macos"),
            ("p8-baseline.yml", "buildbuddy_linux", "p8_linux"),
        ):
            body = job(workflow(filename), name)
            with self.subTest(job=name):
                self.assertIn("needs: changes", body)
                self.assertIn(f"if: ${{{{ !cancelled() && needs.changes.outputs.{output} != 'false' }}}}", body)

    def test_codeql_matrix_uses_needs_context_and_full_fallback(self):
        body = job(workflow("codeql.yml"), "analyze")
        self.assertIn("needs: changes", body)
        self.assertIn("if: ${{ !cancelled() && needs.changes.outputs.codeql_languages != '[]' }}", body)
        self.assertIn('fromJSON(needs.changes.outputs.codeql_languages || \'["actions","javascript-typescript","python"]\')', body)
        self.assertNotIn("steps.scope", body)

    def test_scheduled_and_manual_coverage_remains(self):
        for filename, cron in (("codeql.yml", "0 6 * * 1"), ("p8-baseline.yml", "0 4 * * *")):
            text = workflow(filename)
            self.assertIn(f'- cron: "{cron}"', text)
            self.assertRegex(text, r"(?m)^  workflow_dispatch:")
            self.assertNotRegex(text, r"(?m)^  pull_request:")

    def test_p8_push_reaches_selector_for_all_paths(self):
        text = workflow("p8-baseline.yml")
        self.assertIn("  push:\n    branches: [omp2]\n", text)
        self.assertNotRegex(text, r"(?m)^    paths(?:-ignore)?:")
        self.assertNotIn("macos-native-objective", text)

    @unittest.skipIf(yaml is None, "PyYAML is optional")
    def test_yaml_job_dependencies_and_output_contract(self):
        for filename, keys, downstream in (
            ("codeql.yml", ("codeql_actions", "codeql_python", "codeql_javascript", "codeql_rust", "codeql_languages"), ("analyze", "analyze-rust")),
            ("p8-baseline.yml", ("p8_macos", "p8_linux"), ("record", "buildbuddy_linux")),
        ):
            parsed = yaml.safe_load(workflow(filename))
            jobs = parsed["jobs"]
            self.assertEqual(set(jobs["changes"]["outputs"]), set(keys))
            for key in keys:
                self.assertEqual(jobs["changes"]["outputs"][key], "${{ steps.scope.outputs." + key + " }}")
            for name in downstream:
                self.assertEqual(jobs[name]["needs"], "changes")
            # YAML 1.1 readers treat the unquoted GitHub `on` key as true.
            triggers = parsed.get("on", parsed.get(True))
            self.assertIn("schedule", triggers)
            self.assertIn("workflow_dispatch", triggers)


if __name__ == "__main__":
    unittest.main()
