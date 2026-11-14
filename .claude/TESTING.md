# EGM Testing Playbook

This document provides a step-by-step developer playbook for running unit tests across the EGM skill suite.

---

## Setup

Install Node.js 22 or newer for the offline scope-advisory workflow tests.
These execute the workflow's JavaScript against a fake GitHub API.

### A. Python Environment Setup
Create and activate an isolated Python 3.10+ virtual environment:

```bash
# Navigate to the repository root
cd /path/to/elephant-goldfish-model

# Check Python version (3.10 or newer)
python3 --version

# Create virtual environment
python3 -m venv .venv

# Activate environment
source .venv/bin/activate

# Dependency groups require pip 25.1 or newer
python -m pip install --upgrade "pip>=25.1"
python -m pip install --group test
```

If your Python version is older than 3.10, install a newer version from [python.org/downloads](https://www.python.org/downloads/) or your system's package manager. Open a new terminal and verify the updated version before continuing. If `python3` still points to the older version, use the newer interpreter explicitly (for example, `python3.12 -m venv .venv`).

If you previously created `.venv` using an older Python version, delete it and recreate it using the updated version.

With Python 3.9 or older, `pytest` stops during test collection with `TypeError: unsupported operand type(s) for |`.

---

## Unit Tests

Unit tests run offline without network access, API keys, or model
dependencies. They validate YAML frontmatter schemas and relative link
integrity, the portable plugin manifest, shared metadata consistency, and
marketplace/component paths.

The read-hook tests require a POSIX `sh`, and the workflow-gate tests require
`bash` on `PATH` to execute the workflow's actual shell step. On Windows, use
Git for Windows and run the tests from Git Bash, or add its `bin` directory
(containing `sh.exe`) to `PATH` in the current PowerShell session. Create
the environment with `python -m venv .venv`, then activate it with
`.venv\Scripts\Activate.ps1` in PowerShell or `source .venv/Scripts/activate`
in Git Bash. Install the test dependencies as described above.
Shell scripts use LF line endings through `.gitattributes`, including when
Git's `core.autocrlf` is enabled. CI runs this offline suite on Ubuntu and
Windows; this does not establish native host workflow support.

The `CI` check waits for both unit jobs and fails if validation fails, is
cancelled, or is skipped. Workflows that include site validation must list it
as a `CI` dependency too. A new push cancels older runs for the same pull
request. Pushes to `main` keep independent runs.

```bash
# Run all unit tests
pytest tests/unit

# Run with verbose output
pytest tests/unit -v

# Run a specific unit test module
pytest tests/unit/test_frontmatter.py -v
pytest tests/unit/test_link_integrity.py -v
```

---

## Lint

CI lints Python with `ruff` and the workflows with `actionlint`. Run both locally:

```bash
python -m pip install --group lint && ruff check .
actionlint
```

---

## Native Claude Reviewer Probe (Opt-in)

With an authenticated Claude Code 2.1.271+ installation, run:

```bash
EGM_CLAUDE_LIVE=1 pytest tests/integration/test_claude.py
```

This uses the account's model quota. It builds the Claude runtime and gives it
a unique test name. Two probes invoke the review skill with folder-scoped read
permissions and no approval hook. They check that a native reviewer reads only
its persona, sees no parent or project `CLAUDE.md` context, and stops without a
verdict when an explicit deny rule blocks its persona. This is a focused probe,
not the full review workflow or a marketplace installation test.
See [Claude integration](docs/claude.md).

---

## Native Codex Integration Tests (Opt-in)

Opt-in integration tests run the live candidate through a temporary Codex marketplace:

```sh
EGM_CODEX_LIVE=1 pytest tests/integration/test_codex.py -v
```

Tests verify candidate installation, fresh-context reviewer isolation, and workflow artifacts.
Each test runs with an authenticated Codex CLI in an isolated sandbox.
See [Codex integration](docs/codex.md).

To test a tagged OpenAI release archive instead of the checkout, download the
archive and `SHA256SUMS` from the same GitHub release, verify the checksum, then
run the same suite with the archive path:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
EGM_CODEX_RELEASE_ZIP=/absolute/path/to/egm-openai-0.1.0.zip \
  EGM_CODEX_LIVE=1 pytest tests/integration/test_codex.py -v
```

The test creates a temporary local marketplace around the archive, checks every
installed archive file byte-for-byte, and removes the temporary plugin and
marketplace afterward. It consumes authenticated Codex model usage. Record the
release tag, source commit, archive checksum, host and model versions, and each
result separately. A failed workflow or missing native evidence is not a pass.

---

## Harness Test Record

A harness counts as supported after `/egm-brainstorm`, `/egm-draft`, and
`/egm-review` run end to end through its plugin install (see
[Harnesses](docs/harnesses.md)). Add a row for each run.

| Harness | Version | Date | Install | Brainstorm | Draft | Review | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Antigravity CLI | 1.4.5 | 2026-10-22 | Pass; validator warnings | Pass (fixture) | Pass (fixture) | Pass (fixture) | Temporary HOME with no hooks, MCP servers, or other plugins. Parent-turn isolation probe passed on the native child transcript; instruction-file exclusion was not tested. Issue #237 reports project `AGENTS.md` and `GEMINI.md` injection on CLI 1.4.0. 16 native reviewers ran. Stages 5 to 9 ran in sequence by timestamp. All required reads occurred. Five stage reports exist. No code was written. The final design differs from the draft in one `Status` line. Not tested: interactive approvals, `egm-bootstrap`, and synthesizer nesting. The bootstrap skill is larger than the load limit. |
| Claude Code | 2.1.308 | 2026-10-22 | Pass (`--plugin-dir`) | Pass (fixture) | Pass (fixture) | Pass after fix (fixture) | Isolation probe passed. Initial stage-order failure retained; focused nine-reviewer rerun verifies sequential stages and required reads. Process shutdown and parent no-shell fixture limits remain in the full report. |
| Claude Cowork | Opus 5.5 Medium, connected cloud task | 2026-10-22 | Pass (ZIP) | Completed with direct-dispatch recovery | Completed | Partial: stages 5–7 | Usage limit interrupted stage 8. Final artifacts, stage 9 and actual isolation-child output remain unverified; #105. Earlier complete run is reported separately. |
| OpenAI Codex | 0.163.0 | 2026-10-22 | Pass | Pass (fixture) | Pass (fixture) | Pass (fixture) | Two live tests passed in 573.13s; parent-turn isolation, 15 native reviewers, ordered stages and required reads verified. Instruction-file exclusion was not tested. Issue #237 reports project and user `AGENTS.md` injection on CLI 0.166.0. |
| OpenAI Codex CLI (v0.1.0 OpenAI ZIP) | 0.164.0-alpha.11.1 | 2026-10-29 | Pass; installed files matched ZIP | Pass (fixture) | Pass (fixture) | Pass (fixture) | `gpt-6.1-sol`, medium. Full opt-in live suite passed in 482.30s at PR commit `8bd11c5`; source `b3a35956759bf7f024af2ff061b2e0b44b438e4c`; ZIP SHA-256 `5f17b3942eaccc657621dfa550ef9fcaf626ad7d170085a9ef98a0e9e8afcefb`. The path-free workflow read all three installed `SKILL.md` files and returned the contents of `docs/codex.md`; it produced all requested artifacts and completed 15 native reviewers. Seven offline regression cases cover successful/failed reads, literal compound `cat`, and conservative rejection of `&&` and pipe commands. See the [full run report in PR #217](https://github.com/google/elephant-goldfish-model/pull/217). |
| ChatGPT Work | GPT-6.1 Sol, Light | 2026-10-22 | Pass; installed hashes verified | Completed | Completed | Nine native reviewers completed | Fresh probe returned UNKNOWN. Artifact download/final audit and full child tool traces remain outstanding; #106. |
| omp | v18.12.6 | 2026-10-27 | Pass (community install) | Not run | Not run | Not run | Community verification, not a fixture run: all seven skills discover and resolve via `skill://` in fresh headless sessions; all nine reviewer personas register as native `task` agents. TUI `/skill:` autocomplete for hidden skills unverified; end-to-end fixtures not run. Required manifest fixes: hyphenated skill directory names (underscore dirs are rejected by omp's validator) and no `$schema` key in `plugin.json` (omp's strict agent-plugins validation rejects `disable-model-invocation`); see #186. |
| Muse | 1.4.14 | 2026-10-30 | Pass (local path install + approve) | Pass (fixture) | Pass (fixture) | Pass (fixture) | Local install from a symlink-free copy of the worktree: plugin valid via Claude-compatible manifest; 7/7 skills valid with zero diagnostics and user-invocable-only activation; 9/9 agents trusted_enabled after approve; 9 tool projections unsupported (reviewers not tool-restricted); 29 validate warnings, 0 errors. Marketplace add discovers 0 plugins (Codex-catalog shadowing). End-to-end fixture (line-count design, `muse-wonder-1.0`, medium, headless `muse exec` in a temporary workspace, installed cache only; prompt named `docs/muse.md` because no skill routes there yet, [#252](https://github.com/google/elephant-goldfish-model/issues/252); approvals simulated up front, interactive approval gates not tested): brainstorm, draft, and uninterrupted review completed; 15 fresh-context reviewers completed (6 brainstorm + 9 stage reviewers across stages 5–9), stage reports sequential by timestamp, final design identical to the reviewed draft, no implementation code written. Isolation probe passed: fresh child returned `UNKNOWN` for a parent-only marker. Named reviewer agents are not spawnable in this runtime (spawn rejected `agent_definition_unavailable`), so every reviewer used the documented general-purpose fallback reading the installed persona first. Review findings on the fixture design are design findings, not workflow execution failures. Tested at commit `91407cf` (skills, agents, and manifests identical to the fixture source; guide and record wording expanded after the run). |

### Interpreting native test results

Keep full run reports in the [PR description](https://github.com/google/elephant-goldfish-model/pull/103).
This table is a summary. Record the tested commit, client version, commands,
native evidence, and limitations in each report. Parse JSONL on literal LF;
Python `splitlines()` also splits valid Unicode characters inside JSON strings.

Track open cloud verification gaps in [#105 (Cowork)](https://github.com/google/elephant-goldfish-model/issues/105) and [#106 (ChatGPT Work)](https://github.com/google/elephant-goldfish-model/issues/106).

- Inspect native tool traces for reviewer launches, completion, and intended resource reads.
- Verify sequential stage execution and persona lenses in addition to artifact existence.
- Distinguish fixture design findings from execution failures of the review workflow.
- Keep installation, execution, and transcript isolation results recorded separately.

### Offline evidence checks

Run `pytest tests/unit/test_claude_traces.py` to exercise the Claude probe's
native child validator with synthetic records. A persona read request alone is
not a successful read: require a matching, non-error, nonempty native tool
result containing non-whitespace text, either as a string or in native text
blocks. Missing or unrelated results fail even when the child says `UNKNOWN`.
These tests do not invoke models or establish cloud support. A successful tool
result also does not by itself prove that the entire resource was read.

For Cowork and ChatGPT Work, retain separate evidence for every reviewer:
native launch arguments, canonical persona/target/standard paths, actual read
results and coverage, completion, and stage timestamps. Child-written receipts
and parent summaries cannot substitute for unavailable tool records. Inspect
the actual isolation child's answer; test host-added context separately from
parent-turn isolation. Keep raw account-bearing records private. Publish only
sanitized findings and candidate identifiers. If the surface cannot expose the
required evidence, record that boundary and leave the affected checks open.
