# GraphTree hardening and release-channel repair

## 1. Purpose

Harden the newly added `/graphtree` workflow against destructive cleanup, cross-repository leakage, invalid node names, and custom-branch merge failure while repairing the README installer channels so a fresh machine gets a working current build. Three disjoint builder lanes run in parallel, one independent review lane audits them, and the main checkout owns integration and release acceptance.

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | File |
|---|---|---|---|---|---|
| A | GraphTree core safety | `[parallel-builder]` | LARGE | none | `.prd/graphtree-release-lane-a.md` |
| B | GraphTree contract tests | `[parallel-verifier]` | MEDIUM | none | `.prd/graphtree-release-lane-b.md` |
| C | Installer/source repair | `[parallel-builder]` | MEDIUM | none | `.prd/graphtree-release-lane-c.md` |
| D | Adversarial audit | `[parallel-verifier]` | SMALL | A, B, C | `.prd/graphtree-release-lane-d.md` |
| E | Integration and release gate | `[acceptance-gate]` | LARGE | A, B, C, D | main orchestrator |

## 3. Operational dispatch table

| Lane | Gap letters | Owned files | Effort | Model | Runner | Isolation | Depends on | Verify commands |
|---|---|---|---|---|---|---|---|---|
| Core safety | A | `graphtree.ts`, new `graphtree-run.md` | LARGE | frontier | codex | worktree | none | focused package check |
| Contract tests | B | `graphtree.test.ts` | MEDIUM | frontier | codex | worktree | none | focused test |
| Installer repair | C | README/install scripts/Worker tests | MEDIUM | frontier | codex | worktree | none | Worker + source tests |
| Adversarial audit | D | read-only result | SMALL | frontier | codex | separate checkout | A/B/C | diff review |
| Acceptance | E | registry/changelog/evidence + release | LARGE | frontier | main | main checkout | all | focused tests, `bun run check:ts`, installers, artifact probes |

## 4. File ownership matrix

| File | A | B | C | E |
|---|---|---|---|---|
| `packages/coding-agent/src/slash-commands/builtin/graphtree.ts` | own | – | – | – |
| `packages/coding-agent/src/slash-commands/builtin/graphtree-run.md` | own | – | – | – |
| `packages/coding-agent/test/slash-commands/graphtree.test.ts` | – | own | – | – |
| `README.md` | – | – | own | – |
| `docs/graphtree.md` | – | – | own | – |
| `scripts/install.sh` | – | – | own | – |
| `scripts/install.ps1` | – | – | own | – |
| `infra/install-redirect/worker.js` | – | – | own | – |
| `infra/install-redirect/worker.test.js` | – | – | own | – |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | – | – | – | own |
| `packages/coding-agent/CHANGELOG.md` | – | – | – | own |
| `docs/graphtree-release-acceptance.md` | – | – | – | own |

## 5. Execution sequence

1. Write and track this PRD set; create three branches/worktrees from the same base SHA.
2. Dispatch A, B, C asynchronously. B writes black-box desired-contract tests without modifying production.
3. Merge A, B, C sequentially, resolving only integration drift in the main checkout.
4. Run D as a fresh read-only audit over the integrated diff; remediate findings in E.
5. E runs all focused and repository checks. Only after a clean gate may a release be proposed/executed; external publishing must verify all five binary URLs before advancing `/version`.

## 6. Acceptance criteria

- [ ] `/graphtree status` lists only current-repository GraphTree worktrees and resolves their real branches.
- [ ] Node names are safe single path segments and custom branches are validated and merged correctly.
- [ ] Cleanup never force-deletes dirty or unnamed worktrees; no raw recursive-delete fallback exists.
- [ ] `/graphtree run` uses a static imported prompt.
- [ ] Focused tests cover init, custom branch merge, repo isolation, and dirty cleanup refusal.
- [ ] The canonical GitHub repository README has a dedicated GraphTree section linking to `docs/graphtree.md` with safe lifecycle semantics.
- [ ] README has no dead Homebrew/mise route and default fresh-machine install does not depend on missing binary assets.
- [ ] Worker proxies installer scripts from the canonical `kingkillery/oh-my-pk` repository.
- [ ] `bun run check:ts` and focused suites exit 0.
- [ ] Hosted `/version` advances only after all five platform assets return 200 and report the intended version.
