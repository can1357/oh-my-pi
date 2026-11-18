"""Keep native CI hosted while preserving BuildBuddy's explicit routing."""

import importlib.util
import re
import subprocess
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

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
        if job in MACOS_JOBS and runner == CI_PATHS.MACOS_CONTROLLER_RUNNER:
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
        redirected = self.ci.replace(CI_PATHS.MACOS_CONTROLLER_RUNNER, '${{ vars.MACOS_RUNNER }}', 1)
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

    def test_controller_runner_rejects_a_widened_event_boundary(self):
        redirected = self.ci.replace("github.base_ref == 'omp2'", "github.base_ref != ''", 1)
        self.assertEqual([failure[0] for failure in native_runner_failures(redirected)], ['rust'])

    @unittest.skipIf(yaml is None, 'PyYAML is unavailable')
    def test_fallback_default_runner_labels_match_admission_and_hosted_stays_first(self):
        worker = yaml.load((ROOT / '.github/workflows/macos-verification.yml').read_text(), Loader=yaml.BaseLoader)
        job = worker['jobs']['native']
        labels = '\'["self-hosted","macOS","ARM64"]\''
        self.assertEqual(job['runs-on'], "${{ inputs.pool == 'self-hosted' && fromJSON(vars.CI_MACOS_FALLBACK_LABELS || " + labels + ") || 'macos-15' }}")
        self.assertEqual(job['env']['CI_MACOS_FALLBACK_LABELS'], '${{ vars.CI_MACOS_FALLBACK_LABELS || ' + labels + ' }}')

    @unittest.skipIf(yaml is None, 'PyYAML is unavailable')
    def test_control_changes_keep_pinned_hosted_first_fallback_without_admin_variables(self):
        ci = yaml.load(self.ci, Loader=yaml.BaseLoader)
        self.assertEqual(ci['env']['CI_MACOS_CONTROL_POLICY'], 'source-bound')
        self.assertRegex(ci['env']['CI_MACOS_WORKER_SHA'], r'^[0-9a-f]{40}$')
        self.assertEqual(ci['env']['CI_MACOS_WORKER_REF'], 'ci-macos-worker-source-bound-v3')
        for name in MACOS_JOBS:
            job = ci['jobs'][name]
            self.assertNotIn('macos_controls', job['runs-on'])
            self.assertIn("github.repository == 'blyzer/oh-my-pi'", job['runs-on'])
            control = next(step for step in job['steps'] if step.get('name') == 'Check out reviewed macOS controller')
            self.assertEqual(control['with']['ref'], '${{ env.CI_MACOS_WORKER_SHA }}')
            coordinate = next(step for step in job['steps'] if step.get('name') == 'Coordinate macOS objective')
            self.assertEqual(coordinate['env']['CI_MACOS_FALLBACK_ENABLED'], "${{ vars.CI_MACOS_FALLBACK_ENABLED || 'true' }}")
            self.assertNotIn('CI_MACOS_WORKER_SHA', coordinate['env'])

    @unittest.skipIf(yaml is None, 'PyYAML is unavailable')
    def test_worker_and_shared_action_parse_as_real_yaml(self):
        worker = yaml.load((ROOT / '.github/workflows/macos-verification.yml').read_text(), Loader=yaml.BaseLoader)
        ci = yaml.load(self.ci, Loader=yaml.BaseLoader)
        action = yaml.load((ROOT / '.github/actions/macos-native-objective/action.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(worker['on']), {'workflow_dispatch'})
        self.assertEqual(worker['permissions'], {'contents': 'read', 'actions': 'read'})
        self.assertNotIn('paths', ci['on']['push'])
        self.assertIn('python3 scripts/ci_scope.py --workflow ci', self.ci)
        steps = worker['jobs']['native']['steps']
        admission = next(i for i, step in enumerate(steps) if step.get('id') == 'admit')
        candidate = next(i for i, step in enumerate(steps) if step.get('name') == 'Check out admitted candidate')
        self.assertLess(admission, candidate)
        self.assertEqual(steps[candidate]['with']['ref'], '${{ steps.admit.outputs.source_sha }}')
        for step in steps:
            if step.get('uses', '').startswith('actions/checkout@'):
                self.assertEqual(step['with']['persist-credentials'], 'false')
        native = next(step for step in steps if step.get('name') == 'Run native objective')
        self.assertEqual(native['with']['control-directory'], '.ci-control')
        self.assertEqual(native['with']['source-directory'], '.')
        self.assertEqual(native['with']['guarded'], 'true')
        restored = next(i for i, step in enumerate(steps) if step.get('with', {}).get('path') == '.ci-control')
        self.assertLess(candidate, restored)
        self.assertEqual(steps[restored]['with']['ref'], '${{ github.workflow_sha }}')
        self.assertNotIn('path', steps[candidate]['with'])
        self.assertEqual(worker['jobs']['native']['env']['CI_MACOS_CONTROL_POLICY'], 'source-bound')
        self.assertTrue(any('macos_worker_guard.py' in step.get('run', '') for step in action['runs']['steps']))
        for step in action['runs']['steps']:
            if step.get('name') in {'Select pinned Rust toolchain', 'Check provisioned cargo-nextest'} or step.get('uses') == './.github/actions/macos-build-state':
                self.assertIn("inputs.guarded != 'true'", step['if'])
        execute = next(step for step in action['runs']['steps'] if step.get('name') == 'Execute native objective')
        self.assertIn('-- python3 scripts/macos_worker_state.py -- bash scripts/ci-macos-objective.sh', execute['run'])
        self.assertIn('python3 "$control/scripts/macos_worker_guard.py" run', execute['run'])
        self.assertIn('--request-file "$RUNNER_TEMP/macos-request.json"', execute['run'])
        self.assertIn('&& 330 || 120', str(ci['jobs']['rust']['timeout-minutes']))
        self.assertIn('&& 330 || 45', str(ci['jobs']['lint_macos']['timeout-minutes']))
        self.assertNotIn('BUILDBUDDY', str(worker))

    def test_extracted_rust_objective_keeps_the_native_command_inventory(self):
        objective = ROOT / 'scripts/ci-macos-objective.sh'
        harness = '''
cargo() { printf 'cargo %s\\n' "$*"; }
python3() { printf 'python3 %s\\n' "$*"; }
git() { printf proved-tree; }
function scripts/ssh-loopback-fixture.sh { printf 'ssh-fixture %s\\n' "$*"; }
source "$1" rust
'''
        done = subprocess.run(['bash', '-c', harness, 'test', str(objective)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        for command in (
            'ssh-fixture cargo nextest run --profile ci -p omp-exec-ssh --locked --run-ignored all',
            'cargo nextest run --profile ci --workspace --no-run --locked',
            'cargo nextest run --profile ci --workspace --exclude omp-e2e --locked',
            'cargo test --doc --workspace --exclude omp-e2e --locked',
            'python3 scripts/check-python-examples.py',
            '--test p1_doc_race', '--test p2_cancel_matrix', '--test p3_detached_jobs',
            '--test p4_schema_isolation', '--test p5_prefix_stability', '--test p6_crash_resume',
            '--test p7_tui --test p7_tsp', '--test p12_daemon_approvals', '--test p8_baselines',
            '::notice title=proved-tree::proved-tree',
        ):
            self.assertIn(command, done.stdout)
        failed = subprocess.run(['bash', '-c', harness.replace('printf \'cargo %s\\n\' "$*";', 'return 1;'), 'test', str(objective)], capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn('::notice title=proved-tree', failed.stdout)


def load_tests(loader, tests, pattern):
    """Keep controller/guard tests on the existing CI runner-policy gate."""
    tests.addTests(loader.discover(str(ROOT / "scripts"), pattern="test_macos*.py"))
    return tests


if __name__ == "__main__":
    unittest.main()
