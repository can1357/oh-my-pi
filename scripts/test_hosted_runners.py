"""Keep native CI hosted while preserving BuildBuddy's explicit routing."""

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("check_ci_paths", ROOT / "scripts/check-ci-paths.py")
CI_PATHS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI_PATHS)

BUILDBUDDY_JOBS = {"lintx_ratchet", "runtime_spec", "remote_linux", "remote_seed"}
MACOS_JOBS = {"rust", "lint_macos"}
CI_PATH = ROOT / ".github/workflows/ci.yml"


def native_runner_failures(text):
    """Report every native job that repository variables could redirect."""
    failures = []
    for job, runner in CI_PATHS.runs_on(text.splitlines()):
        if job in BUILDBUDDY_JOBS:
            continue
        expected = "macos-15" if job in MACOS_JOBS else "ubuntu-24.04"
        if runner != expected:
            failures.append((job, runner, expected))
    return failures


class HostedRunnerPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = CI_PATH.read_text()

    def test_every_native_ci_job_has_a_literal_standard_hosted_runner(self):
        self.assertEqual(native_runner_failures(self.ci), [])
        declared = dict(CI_PATHS.runs_on(self.ci.splitlines()))
        self.assertTrue({"changes", "rust", "lint_linux", "p7_linux", "p9_p10_linux"} <= declared.keys())

    def test_runner_variables_cannot_redirect_a_native_job(self):
        redirected = self.ci.replace(
            "    runs-on: ubuntu-24.04", "    runs-on: ${{ vars.CI_LINUX_RUNNER }}", 1
        )
        failures = native_runner_failures(redirected)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0][0], "changes")

    def test_rust_cannot_return_to_the_personal_mac(self):
        redirected = re.sub(
            r"(  rust:\n[\s\S]*?    runs-on:) macos-15",
            r"\1 ${{ vars.MACOS_RUNNER }}",
            self.ci,
            count=1,
        )
        failures = native_runner_failures(redirected)
        self.assertEqual([failure[0] for failure in failures], ["rust"])

    def test_buildbuddy_routing_remains_separate_and_fork_guarded(self):
        declared = dict(CI_PATHS.runs_on(self.ci.splitlines()))
        for job in BUILDBUDDY_JOBS:
            with self.subTest(job=job):
                runner = declared[job]
                self.assertIsNotNone(CI_PATHS.GUARDED.fullmatch(runner))
                self.assertIn("vars.CI_LINUX_MODE == 'remote'", runner)
                self.assertIn("vars.CI_LINUX_RUNNER || vars.MACOS_RUNNER", runner)
                body = "\n".join(CI_PATHS.block(self.ci.splitlines(), job, 2))
                self.assertIn("scripts/remote-verify.sh", body)
                self.assertIn("secrets.BUILDBUDDY_ORG_API_KEY", body)

    def test_manual_package_uses_the_hosted_mac_and_keeps_its_buildbuddy_cache(self):
        package = (ROOT / ".github/workflows/package-macos.yml").read_text()
        self.assertEqual(dict(CI_PATHS.runs_on(package.splitlines())), {"package": "macos-15"})
        self.assertIn("secrets.BUILDBUDDY_ORG_API_KEY", package)
        self.assertIn("sccache + BuildBuddy GCS cache active", package)

    def test_p8_buildbuddy_measurement_keeps_its_remote_runner(self):
        p8 = (ROOT / ".github/workflows/p8-baseline.yml").read_text()
        self.assertEqual(dict(CI_PATHS.runs_on(p8.splitlines()))["buildbuddy_linux"], "ubuntu-24.04")
        body = "\n".join(CI_PATHS.block(p8.splitlines(), "buildbuddy_linux", 2))
        self.assertIn("scripts/remote-verify.sh remote-p8-baseline", body)
        self.assertIn("secrets.BUILDBUDDY_ORG_API_KEY", body)


if __name__ == "__main__":
    unittest.main()
