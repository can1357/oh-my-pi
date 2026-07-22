# GraphTree release acceptance

## Decision

**HOLD.** GraphTree's local safety and behavior gates pass, but the public release channel is incomplete and the canonical GitHub CI run is red. Do not bump the package version, publish a release, or advance the hosted `/version` pointer.

## Integrated scope

- Repository-scoped worktree discovery through `git worktree list`.
- Repository-qualified node paths and filesystem-safe node names.
- Custom branch discovery and squash merge into staged, reviewable changes.
- Named cleanup only, with dirty-worktree refusal and no force/raw-delete fallback.
- Static `/graphtree run` prompt imported from `graphtree-run.md`.
- Canonical README and `docs/graphtree.md` command/lifecycle documentation.
- Fresh installs default to Bun/npm; binary installation is explicit.
- Installer Worker proxies scripts from `kingkillery/oh-my-pk`.

## Adversarial audit remediation

A fresh read-only audit found branch-option injection, non-repository error handling, and detached-HEAD display gaps. The acceptance pass:

- inserts Git's `--` option terminator when creating branches;
- rejects custom branch values such as `-u` without mutating refs or branch config;
- reports a friendly error outside a Git repository;
- renders detached roots as `detached@<sha>` rather than fabricating `main`;
- normalizes Worker fetch mocks to per-test spies;
- removes UTF-8 status glyphs that made `install.ps1` fail under Windows PowerShell 5.1's legacy script decoding.

## Verification

Run from the repository root on 2026-07-22:

| Gate | Result |
| --- | --- |
| `bun test packages/coding-agent/test/slash-commands/graphtree.test.ts infra/install-redirect/worker.test.js` | PASS — 16 tests |
| `bun run check:ts` | PASS |
| `bash -n scripts/install.sh` | PASS |
| Windows PowerShell parser for `scripts/install.ps1` | PASS after ASCII-safe status labels |
| `git diff --check` | PASS |

Behavioral tests cover repository isolation, real/custom branches, traversal and option-injection rejection, detached HEAD, non-Git directories, merge staging, explicit prune, dirty refusal, and clean removal.

## External release blockers

Hosted distribution currently reports `v16.2.6`:

| Asset | HTTP |
| --- | --- |
| `omp-windows-x64.exe` | 200 |
| `omp-linux-x64` | 404 |
| `omp-linux-arm64` | 404 |
| `omp-darwin-x64` | 404 |
| `omp-darwin-arm64` | 404 |

Canonical GitHub Actions run [`29951660266`](https://github.com/kingkillery/oh-my-pk/actions/runs/29951660266) completed with failure at commit `a5399ea03`. Failing jobs include install-method smoke tests, workspace type checking, Linux x64 modern native build, and Linux x64 baseline native build. Darwin x64/arm64 and Linux arm64 native jobs passed, but their binaries are not present in the hosted channel.

## Release gate

A later release may proceed only when:

1. the current canonical commit passes required CI;
2. npm and every intended binary are built from the same accepted source/version;
3. all five hosted asset URLs return 200 and report the intended version;
4. installer smoke tests pass in default npm mode and explicit binary mode; and
5. `/version` advances last, after artifact verification.
