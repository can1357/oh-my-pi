# Small-model orchestration acceptance evidence

`verificationStatus: feature-gates-passed; repository-gate-blocked-by-unrelated-worktree`

Rechecked on 2026-07-10 from the primary checkout. The baseline ref was removed after the original scope audit as required by the plan.

## Claim → test evidence

| Acceptance claim | Concrete test evidence | Status |
|---|---|---|
| Tier/autonomy independence and judgment floor | `test/orchestration/agent-execution-profile.test.ts` | passed |
| Allocation-free spawn-plan rejection | `test/task/spawn-plan.test.ts`, `test/task/task-spawn-profile-integration.test.ts` | passed |
| Canonical selector resolution and startup diagnostics | `test/config/spawn-selector-validation.test.ts`, `test/subagent-model-aliases.test.ts`, `test/sdk-startup-validation.test.ts` | passed |
| Source-qualified construction, activation, refresh, and revive ceilings | `test/tools/tool-profiles.test.ts`, `test/tools/tool-profile-integration.test.ts`, `test/agent-session-mcp-discovery.test.ts`, `test/task/persisted-profile-revive.test.ts` | passed |
| Digest-bound assignment verification fails closed | `test/task/assignment-verifier.test.ts`, `test/tools/yield.test.ts` | passed |
| Request fallback precedes deterministic fresh-child recovery | `test/task/recovery-policy.test.ts`, `test/task/task-recovery-integration.test.ts` | passed |
| Collaboration visibility, broadcast authorization, wake restoration, and cold revive | `test/orchestration/collaboration-policy.test.ts`, `test/tools/irc.test.ts`, `test/task/persisted-profile-revive.test.ts` | passed |
| Eval timeout and process-error evidence | `test/tools/eval-observability.test.ts`, `src/eval/py/__tests__/called-process-error.test.ts` | passed |
| Router default-off, enabled classification, and abort behavior | `packages/llm-router-agent/tests/task-spawn-policy.test.mjs`, `test/extensibility/task-spawn-policy.test.ts` | passed |
| Fusion stale-id clearing, configured-pool routing, initial-attempt accounting, and bounded recovery | `test/session/fusion-sidekick.test.ts` | passed |
| Legacy no-profile/no-contract behavior | `test/task/task-spawn.test.ts`, `test/tools/yield.test.ts`, `test/tools/irc.test.ts` | passed |
| Recovery metadata rendering | `test/task/task-render.test.ts` | passed |
| Profile grammar and Windows heredoc soft spot | `test/tools/tool-profile-grammar.test.ts`, `test/tools/bash-windows-heredoc.test.ts` | passed |

## Executed gates

| Command | Observed result |
|---|---|
| `bun --cwd=packages/coding-agent run check:types` | passed |
| Focused coding-agent suite listed in the Lane E PRD, plus `test/agent-session-mcp-discovery.test.ts` and `test/acp-builtins.test.ts` | 282 passed, 0 failed, 997 assertions, 27 files |
| `bun --cwd=packages/llm-router-agent run check` | passed |
| `bun --cwd=packages/llm-router-agent run test` | 44 passed, 0 failed |
| `bun --cwd=packages/coding-agent run format-prompts --check` | passed |
| `bun run check:tools` | blocked outside this feature: pre-existing `src/tools/ix-bridge.ts` lint and unrelated untracked `packages/desktop-tag/` errors; scoped changed-file Biome check passed |
| `bun packages/coding-agent/src/cli.ts --smoke-test` | passed |
| `git diff --check` | passed |

## Deterministic scope audit

- Original baseline audit: 97 changed paths, all in `planAmendments` or the union of lane files.
- The baseline ref was intentionally removed after that audit; it is unavailable for a current three-dot comparison.
- Every `requiredDeliverables` path exists.
- Both cleanup globs are empty.
- No `findings-*.md` fragments or temporary lane-review artifacts remain.

## Regression scenarios

- Invalid or alias-less selectors fail before id, job, worktree, or child-session allocation.
- A failed initial child is counted once; recovery chooses the next eligible candidate and verifies the fresh result.
- TLS-dead providers are suppressed before deterministic fallback/escalation.
- Fusion uses the configured tier pool and cannot exceed its bounded attempt count.
- Report-only agents cannot leak peers through `irc list` or broadcast through `to=all`; failed wake authorization restores reserved budgets.
- MCP refresh, discovery activation, Auto-QA injection, and persisted revive cannot widen a source-qualified tool ceiling.
- Missing/default/disabled task-spawn routing registers no policy handler and performs no classifier fetch.

## Intentional deferred boundary

`SOFT-SPOT(WIN-HEREDOC-PARSER)` remains explicit: Windows bound/light/mid heredoc enforcement is deferred until a safe native parser predicate exists. Remote collaboration owner semantics remain outside this scope.
