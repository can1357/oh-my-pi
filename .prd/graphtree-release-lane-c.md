# Lane C — Installer and source-channel repair [parallel-builder]

## 1. Mission + read-first

You own truthful, working installation paths for oh-my-pk. Read `.prd/graphtree-release-orchestration.md`, `AGENTS.md`, `README.md`, both install scripts, `infra/install-redirect/README.md`, Worker code/tests, and `docs/RELEASING-FORK.md`.

## 2. Owned files

You may ONLY edit:
- `README.md`
- `docs/graphtree.md` (new)
- `scripts/install.sh`
- `scripts/install.ps1`
- `infra/install-redirect/worker.js`
- `infra/install-redirect/worker.test.js`

## 3. Gap

> C — Installer/source repair: fresh Unix installs must not fall into missing binary assets; dead Homebrew/mise instructions must not be advertised; Worker must proxy canonical scripts. [MEDIUM] depends on: none.

## 4. What to build

- On default install, when Bun is absent, install/validate Bun and use the npm package. Keep explicit `--binary`/`-Binary` behavior for users who request it.
- Preserve explicit source/ref behavior and aliases.
- Update Worker installer raw source from `kingkillery/oh-my-pi` to canonical `kingkillery/oh-my-pk`; add/update behavioral Worker test asserting proxied URL through an injected fetch spy if the current design permits.
- Remove or clearly mark unavailable README Homebrew and mise commands; do not publish commands whose repositories/releases return 404 or stale versions.
- Add a concise dedicated `GraphTree` section to the canonical GitHub README and link it to a substantive `docs/graphtree.md` guide. Document status/list/init/run/merge/prune, aliases, repository-scoped paths, dirty cleanup refusal, and that squash merge stages changes for review. Do not claim `/run` provides guarantees beyond its actual prompt-driven orchestration.
- Keep README concise and leave release docs outside owned scope.

## 5. Hard constraints

No dependencies, no release/tag/publish, no secret access, no editing distribution VERSION. Tests must execute behavior, not source-grep. Match shell/PowerShell idioms.

## 6. Verification

Run `bun test infra/install-redirect/worker.test.js`, `sh -n scripts/install.sh`, a PowerShell parser check for `scripts/install.ps1`, and `git diff --check`. Do not run project-wide checks.

## 7. Commit message

`fix(install): route fresh installs through available channels (Gap C)`

## 8. Final report

Report changed install behavior, removed/deferred channels, verification, and blockers.
