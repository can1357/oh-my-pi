# Which CI jobs use the self-hosted Mac

Historical configuration. **2026-11-14 update:** native jobs now select standard
GitHub-hosted Ubuntu/macOS explicitly; only BuildBuddy-capable jobs retain the
variable-based launcher routing below. See
[hosted-runner restoration](ci-hosted-runners-restoration.md) for current policy
and observed runner failures. The older "without hosted minutes" rationale below
is not evidence that public-repository standard hosted compute is exhausted.

The self-hosted Apple silicon runner is registered on **this** repository
(`blyzer/oh-my-pi`), via `vars.MACOS_RUNNER`. It is not the upstream
repository's runner. Same-repo branches and pull requests use it directly.

## Split

| Job | Runner | Why |
|---|---|---|
| `rust` (workspace tests, P1–P8, P12) | `vars.MACOS_RUNNER`, else `macos-15` | Persistent target dir outside the checkout: incremental Rust compile and the embedded CPython link survive between runs |
| `lint_macos` | GitHub-hosted `macos-15` | No reuse of that target dir; a warm clippy was no faster than a cold one |
| Linux jobs (format, lint, P7, P9–P11, `tool_sources`, BuildBuddy) | GitHub-hosted `ubuntu-24.04`; with `vars.CI_LINUX_MODE` = `remote`, all but `lint_linux`, `p7_linux` and `p9_p10_linux` use the Mac and BuildBuddy (below) | Do not need the Mac |

That keeps the Mac for the one job that benefits from its disk cache, and
runs everything else on GitHub so the Mac stays free.

## What we do not do

There is no availability probe. GitHub's default token cannot list
self-hosted runners, and sending `rust` to hosted when the probe fails throws
away the cache the Mac exists for. If the Mac is offline, that one job waits;
the admin bypass in the ruleset is the escape hatch. Unset `MACOS_RUNNER` to
move `rust` to hosted `macos-15`.

A pull request opened **from another repository** (head repo full name ≠
`github.repository`) is forced to hosted `macos-15` in the workflow file, so
that code does not run on the Mac. `head.repo.fork` is the wrong signal: it
is true when this repository itself was forked from upstream, including for
our own branches.

## Operating CI without hosted minutes

The repository variable `CI_LINUX_MODE` takes most Linux jobs of `ci.yml` off
GitHub-hosted runners. Unset, or set to anything but `remote`, nothing
changes: every Linux job runs on `ubuntu-24.04` as before. With `remote`, a
trusted run (a push, a manual dispatch, or a pull request from a branch of
this repository) sends ten of the thirteen Linux jobs to the self-hosted Mac.
Six run there natively. `lintx_ratchet` and `runtime_spec` skip their
GitHub-hosted steps and run their `just ci-*` recipe on a BuildBuddy remote
Linux runner through `scripts/remote-verify.sh`, so the Mac only uploads the
change and streams the log; `remote_linux` and `remote_seed` start their
BuildBuddy runs from the Mac instead of a hosted runner. `lint_linux`,
`p9_p10_linux` and `p7_linux` stay on `ubuntu-24.04` in either mode until
their recipes pass on BuildBuddy (Status, below). Every job keeps its `name:`,
so the required checks do not change.

Turn it on, and back off:

```sh
gh variable set CI_LINUX_MODE --repo blyzer/oh-my-pi --body remote
gh variable delete CI_LINUX_MODE --repo blyzer/oh-my-pi
```

The mode needs `MACOS_RUNNER` (already set) and the
`BUILDBUDDY_ORG_API_KEY` secret. A job that lands on the Mac without the
key fails rather than passing.

| Job (required check) | In `remote` mode | Why |
|---|---|---|
| `changes` | Mac | `gh api` and a shell loop |
| `format` (Rust format) | Mac | rustfmt and two standard-library Python checks; nothing compiles |
| `protobuf` (Protobuf format and lint) | Mac | The pinned `buf-Darwin-arm64` release, checked against its SHA-256 |
| `extensions_conformance` | Mac | Standard-library Python and unittest |
| `licenses` (License policy and release notices) | Mac | The pinned cargo-deny release in the job's temp dir; `cargo deny` reads metadata and compiles nothing |
| `push_verified` | Mac | `gh api` and `jq` |
| `lintx_ratchet` (Error-formatting ratchet) | Mac, then BuildBuddy `ci-lintx-ratchet` | Builds and tests lintx |
| `runtime_spec` (Runtime symbol and dependency contracts) | Mac, then BuildBuddy `ci-runtime-spec` | `cargo -Zscript` builds omp-core and omp-tool |
| `lint_linux` (Lint workspace (Linux)) | Hosted `ubuntu-24.04` in either mode | `just ci-lint-linux` is not proven on BuildBuddy yet |
| `p9_p10_linux` (Acceptance proofs P9, P10 and tool sources (Linux)) | Hosted `ubuntu-24.04` in either mode | `just ci-p9-p10-linux` is not proven on BuildBuddy yet |
| `p7_linux` (Terminal proof P7 (Linux PTY)) | Hosted `ubuntu-24.04` in either mode | `just ci-p7-linux` (PTY) is not proven on BuildBuddy yet |
| `remote_linux` (Remote Linux verification (BuildBuddy)) | Mac, then BuildBuddy as before | Already remote; only its client moves |
| `remote_seed` | Mac, then BuildBuddy as before | Manual dispatch on `omp2` only |
| `rust`, `lint_macos` | Unchanged | Not Linux jobs |

`lint_macos` still runs on GitHub-hosted `macos-15` in either mode.
`pr-labels.yml`, `codeql.yml`, `semantic-index-eval.yml` and the summary job
of `p8-baseline.yml` are separate workflows and still use hosted Linux.

### Status

No GitHub Actions run has used `remote` yet. What was checked by hand:
`just remote ci-lintx-ratchet` and `just remote ci-runtime-spec` passed on
BuildBuddy, and the native steps of `changes`, `format`, `protobuf`,
`extensions_conformance`, `licenses` and `push_verified` ran clean on the Mac
with the runner's own `PATH`. With the variable unset, the push run on the
merge commit of #596, which added the mode (run 43136579113), passed every job
on its usual runner. `just remote ci-lint-linux` passed its clippy step, but no
run of it has finished; `ci-p9-p10-linux` and `ci-p7-linux` have never run.
Wire one of those three jobs to its recipe only after `just remote <recipe>`
passes, and treat the first run with the variable set as the real test.

### Fork pull requests

Every `runs-on` that can name a self-hosted runner starts with the fork test
the `rust` job uses:
`github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository`.
A pull request from another repository therefore runs every job on hosted
`ubuntu-24.04` in either mode, `remote_linux` still skips its remote steps,
and the key is never used for it. The same test opens
`.github/actions/buildbuddy-remote`, which fails the job rather than handing
the key over, and every step that sets `BUILDBUDDY_API_KEY` waits for that
action's `remote` output. `just check-ci-paths` (run by the `format` job)
fails if a job's `runs-on` could name a self-hosted runner without the fork
test in front, in any workflow that a pull request can start.

This is routing, not a trust boundary. A `pull_request` run uses the workflow
file of the pull request's own merge ref, so whoever writes a pull request
writes its CI. Two settings stop a stranger: GitHub gives a fork's run no
secrets, and the repository requires approval before any workflow runs for an
outside contributor (`all_external_contributors`). Anyone who can push a
branch here is trusted with the Mac and the key: a branch can change
`ci.yml`. That includes every person, App and agent token with write access.

### Limits

- One runner instance runs one job at a time, so in `remote` mode the jobs of
  a run queue behind each other and behind `rust`. To run the light jobs in
  parallel, register more runner instances with a label `rust` does not ask
  for, and point `CI_LINUX_RUNNER` at them (it defaults to `MACOS_RUNNER`):

  ```sh
  gh variable set CI_LINUX_RUNNER --repo blyzer/oh-my-pi --body '["self-hosted","macOS","ARM64","omp-light"]'
  gh variable delete CI_LINUX_RUNNER --repo blyzer/oh-my-pi
  ```

  Give the `rust` runner its own label too, and add it to `MACOS_RUNNER`,
  so `rust` never lands on a light instance.
- The runner's own build state, the developer's credentials and the
  BuildBuddy keys in its Keychain are reachable from every job it runs, as
  they are for `rust` today.
- BuildBuddy does not forward the workflow's `env` (`RUST_BACKTRACE`,
  `CARGO_TERM_COLOR`) to the remote runner, the same as for `remote_linux`.
