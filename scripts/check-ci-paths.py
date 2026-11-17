#!/usr/bin/env python3
"""Check the single-workflow CI gate.

CI is one workflow, ci.yml. A pull request is never filtered out of it by a
path filter (a filtered workflow reports nothing, so its required checks stay
pending). Instead the `changes` job delegates to scripts/ci_scope.py and its
.github/ci-job-paths.json policy. Each scoped job uses its own fail-closed gate.
This script checks those declarations, unfiltered push/PR triggers and the
merge-group trigger. Event diff and full fallback behavior is tested directly
in test_ci_scope.py. The historical text path lists are not policy inputs.

It also checks:
* every required status check in .github/rulesets/omp2-protected.json is the
  `name:` of a job in ci.yml, because a required check is matched by name;
* in every workflow a pull request can start, a job whose `runs-on` could name
  a self-hosted runner (anything but a plain GitHub-hosted label) sends a pull
  request from another repository to a hosted label first, with the established
  fork test verbatim, and the BuildBuddy trust action applies that test.

Plain text scanning keeps this free of third-party YAML dependencies.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CI = ROOT / ".github/workflows/ci.yml"
SCOPED_JOBS = {
    "format", "protobuf", "lintx_ratchet", "runtime_spec", "extensions_conformance",
    "licenses", "rust", "lint_macos", "lint_linux", "p9_p10_linux", "p7_linux",
    "remote_linux", "affected",
}
RULESET = ROOT / ".github/rulesets/omp2-protected.json"
WORKFLOWS = ROOT / ".github/workflows"
TRUST_ACTION = ROOT / ".github/actions/buildbuddy-remote/action.yml"

# The established fork test, verbatim. `pull_request` runs the workflow file of
# the pull request's own merge ref, so this routes rather than guards: what keeps
# a stranger's code off the self-hosted Mac is the repository's approval policy
# for fork pull requests. The check keeps an honest edit from dropping the route.
FORK = (
    "github.event_name == 'pull_request' && "
    "github.event.pull_request.head.repo.full_name != github.repository"
)
HOSTED = r"(?:ubuntu|macos|windows)-[0-9A-Za-z.-]+"
# This expression can select only standard hosted labels; it never accepts a
# runner label from a variable. Keep the event boundary explicit and audited.
MACOS_ELIGIBLE = (
    "github.repository == 'blyzer/oh-my-pi' && "
    "((github.event_name == 'pull_request' && "
    "github.event.pull_request.head.repo.full_name == github.repository && github.base_ref == 'omp2') || "
    "(github.event_name == 'push' && github.ref == 'refs/heads/omp2') || "
    "(github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/omp2'))"
)
MACOS_CONTROLLER_RUNNER = "${{ (" + MACOS_ELIGIBLE + ") && 'ubuntu-24.04' || 'macos-15' }}"
# fromJSON((FORK) && '"<hosted label>"' || REST): `&&` binds tighter than `||`,
# so a fork gets the hosted label whatever REST says, provided REST stays inside
# fromJSON's one argument (see balanced()).
GUARDED = re.compile(
    r"\$\{\{ fromJSON\(\(" + re.escape(FORK) + r"\) && '\"" + HOSTED + r"\"' \|\| (.+)\) \}\}"
)
# Events a pull request from another repository can start. FORK covers only
# `pull_request`; a runs-on that is not a plain hosted label fails outright in a
# workflow that any of the others start.
FORK_EVENTS = {
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
    "issue_comment",
}


def unquote(value: str) -> str:
    value = value.split(" #")[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def block(lines: list[str], header: str, indent: int) -> list[str]:
    """Lines nested under the first `header:` at exactly `indent` spaces.

    A comment never ends the block, whatever its indent: ci.yml has one in column 0
    above `remote_seed`, and every job after it would otherwise be invisible here.
    """
    prefix = " " * indent + header + ":"
    for i, line in enumerate(lines):
        if line.rstrip() == prefix or line.startswith(prefix + " "):
            out = []
            for rest in lines[i + 1 :]:
                code = rest.strip() and not rest.lstrip().startswith("#")
                if code and (len(rest) - len(rest.lstrip())) <= indent:
                    break
                out.append(rest)
            return out
    return []


def job_names(lines: list[str]) -> list[str]:
    names = []
    for line in block(lines, "jobs", 0):
        match = re.match(r"^    name: (.+)$", line)
        if match:
            names.append(unquote(match.group(1)))
    return names

def events(lines: list[str]) -> set[str]:
    """The trigger names of a workflow: `on: x`, `on: [x, y]`, or a block of keys or items."""
    for line in lines:
        match = re.match(r"^on:(.*)$", line)
        if not match:
            continue
        inline = match.group(1).split(" #")[0].strip()
        if inline:
            return {name.strip() for name in inline.strip("[]").split(",") if name.strip()}
        return {
            item.group(1)
            for rest in block(lines, "on", 0)
            if (item := re.match(r"^  (?:- )?([A-Za-z_]+)", rest))
        }
    return set()


def runs_on(lines: list[str]) -> list[tuple[str, str]]:
    """(job id, `runs-on` value) for every job; a block value (labels, group) reads as ''."""
    found = []
    job = None
    for line in block(lines, "jobs", 0):
        key = re.match(r"^  ([A-Za-z_][A-Za-z0-9_-]*):", line)
        if key:
            job = key.group(1)
            continue
        value = re.match(r"^    runs-on:(.*)$", line)
        if value and job:
            found.append((job, unquote(value.group(1))))
    return found


def balanced(text: str) -> bool:
    """Parentheses outside single-quoted strings never close more than they opened, and end even."""
    depth = 0
    quoted = False
    for char in text:
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def fork_guard_failures() -> tuple[int, list[str]]:
    """Count the guarded runs-on values and report every unguarded one."""
    guarded = 0
    failures = []
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        lines = path.read_text().splitlines()
        reachable = events(lines) & FORK_EVENTS
        for job, value in runs_on(lines):
            if path.name == 'ci.yml' and job in {'rust', 'lint_macos'} and value == MACOS_CONTROLLER_RUNNER:
                continue
            if not reachable or re.fullmatch(HOSTED, value):
                continue
            where = f"{path.name} job {job}"
            others = sorted(reachable - {"pull_request"})
            if others:
                failures.append(
                    f"{where} can name a self-hosted runner, but {', '.join(others)} also starts "
                    "the workflow and the fork test covers only pull_request"
                )
                continue
            match = GUARDED.fullmatch(value)
            if not match or not balanced(match.group(1)):
                failures.append(
                    f"{where} can name a self-hosted runner without the fork test in front: write "
                    "fromJSON((<the rust job's fork test>) && '\"<hosted label>\"' || ...)"
                )
                continue
            guarded += 1
    if FORK not in TRUST_ACTION.read_text():
        failures.append(f"{TRUST_ACTION.relative_to(ROOT)} must apply the fork test verbatim")
    return guarded, failures


def main() -> int:
    ci = CI.read_text().splitlines()
    on = block(ci, "on", 0)
    ok = True

    jobs = block(ci, "jobs", 0)
    job_ids = [m.group(1) for line in jobs if (m := re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line))]
    for name in sorted(SCOPED_JOBS - set(job_ids)):
        ok = False
        print(f"SCOPED_JOBS names a job that is not in ci.yml: {name}")
    changes = block(jobs, "changes", 2)
    outputs = "\n".join(block(changes, "outputs", 4))
    for name in sorted(SCOPED_JOBS):
        gate = "\n".join(line for line in block(jobs, name, 2) if line.startswith("    if:"))
        scopes = set(re.findall(r"needs\.changes\.outputs\.([A-Za-z0-9_]+)\b", gate))
        if scopes != {name} or f"needs.changes.outputs.{name} != 'false'" not in gate or "!cancelled()" not in gate:
            ok = False
            print(f"job {name} must fail closed with !cancelled() and its own needs.changes.outputs.{name} != 'false' gate")
    for name in sorted(SCOPED_JOBS | {"ci", "format_rust", "macos_controls"}):
        if not re.search(r"^      " + re.escape(name) + r": \$\{\{ steps\.paths\.outputs\." + re.escape(name) + r" \}\}$", outputs, re.M):
            ok = False
            print(f"changes must declare the {name} scope output from steps.paths.outputs.{name}")

    format_job = "\n".join(block(jobs, "format", 2))
    for step in ("Select pinned Rust toolchain", "Check formatting"):
        pattern = (r"^      - name: " + re.escape(step) +
                   r"\n        if: needs\.changes\.outputs\.format_rust != 'false'$")
        if not re.search(pattern, format_job, re.M):
            ok = False
            print(f"format step {step!r} must use the fail-closed format_rust gate")

    for event in ("pull_request", "push"):
        for line in block(on, event, 2):
            if re.match(r"^    paths(?:-ignore)?:", line):
                ok = False
                print(f"ci.yml {event} must not filter paths: required checks would stay pending")

    affected_gate = "\n".join(line for line in block(jobs, "affected", 2) if line.startswith("    if:"))
    for needle in ("vars.CI_AFFECTED_ONLY == 'true'", "github.event_name == 'pull_request'"):
        if needle not in affected_gate:
            ok = False
            print(f"the affected job must stay opt-in and pull-request only: its if lacks {needle}")

    if not any("checks_requested" in line for line in block(on, "merge_group", 2)):
        ok = False
        print("ci.yml must trigger on merge_group with types: [checks_requested]: a merge queue waits for every required check")
    changes_job = "\n".join(block(jobs, "changes", 2))
    for needle in ('python3 scripts/ci_scope.py --workflow ci --github-output "$GITHUB_OUTPUT"',):
        if needle not in changes_job:
            ok = False
            print(f"the changes job must delegate PR/push diffs and manual/merge-group full fallback to the selector: missing {needle}")
    if not (ROOT / 'scripts/ci_scope.py').is_file() or not (ROOT / '.github/ci-job-paths.json').is_file():
        ok = False
        print("the changes selector and .github/ci-job-paths.json must exist")

    objective = (ROOT / 'scripts/ci-macos-objective.sh').read_text()
    for needle in ('"${AFFECTED_SCOPE:-full}" != subset', '"${AFFECTED_SCOPE:-full}" != none', '"${MACOS_WORKER:-false}" != true'):
        if needle not in objective:
            ok = False
            print(f"the proved-tree notice must be restricted to full direct native runs: missing {needle}")

    names = set(job_names(ci))
    required = [
        rule["context"]
        for entry in json.loads(RULESET.read_text())["rules"]
        if entry["type"] == "required_status_checks"
        for rule in entry["parameters"]["required_status_checks"]
    ]
    for context in required:
        if context not in names:
            ok = False
            print(f"required check has no job name in ci.yml: {context!r}")

    guarded, failures = fork_guard_failures()
    for failure in failures:
        ok = False
        print(failure)

    if ok:
        print(
            f"ok: {len(SCOPED_JOBS)} job scopes checked, {len(required)} required checks are ci.yml jobs, "
            f"{guarded} self-hosted-capable runs-on route forks to a hosted runner"
        )
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
