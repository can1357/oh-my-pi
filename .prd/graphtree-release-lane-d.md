# Lane D — Adversarial integrated audit [parallel-verifier]

## 1. Mission + read-first

You are a fresh read-only reviewer. Read the orchestration overview, AGENTS.md, and the integrated A/B/C diff.

## 2. Owned files

Read-only. Do not edit files or commit.

## 3. Gap

> D — Adversarial audit: determine whether GraphTree can lose or cross-contaminate work and whether every README install command resolves to a functioning current source. [SMALL] depends on: A, B, C.

## 4. What to verify

Review behavior and run bounded probes. Focus on dirty worktree deletion, repo collisions, custom branches, path traversal, detached HEAD, non-Git cwd, stale aliases, installer default branches, and Worker source origin. Return findings ordered by severity with file/line evidence and exact remediation.

## 5. Hard constraints

No writes, commits, source-grep tests, releases, deployments, or destructive worktree operations outside disposable temporary repositories.

## 6. Verification

Run focused GraphTree tests and Worker tests, plus `git diff --check`. Do not run project-wide checks.

## 7. Commit message

None (read-only).

## 8. Final report

Return findings, commands/results, residual risks, and verdict.
