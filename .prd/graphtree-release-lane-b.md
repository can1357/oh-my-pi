# Lane B — GraphTree contract tests [parallel-verifier]

## 1. Mission + read-first

You own black-box regression coverage for GraphTree safety. Read `.prd/graphtree-release-orchestration.md`, `AGENTS.md`, the current GraphTree test, and existing temporary-Git fixture tests.

## 2. Owned files

You may ONLY edit `packages/coding-agent/test/slash-commands/graphtree.test.ts`. Do not edit production.

## 3. Gap

> B — GraphTree contract tests: replace heading-only checks with observable temporary-repository tests for init, custom branch merge, repo scoping, validation, and dirty cleanup refusal. [MEDIUM] depends on: none.

## 4. What to build

Use isolated temporary Git repositories and per-test `OMP_WORKTREE_DIR` spying/restoration. Exercise commands through the public registry. Assert:
- status excludes another repository's managed worktree and displays the actual branch;
- init rejects path separators/parent traversal and creates a repo-qualified node for a valid name;
- custom branch passed to init is the branch used by merge;
- prune requires a node, refuses a dirty node without deleting it, and clean named removal succeeds;
- run returns the expected objective-bearing prompt.

Tests must be full-suite safe: no global env leakage, no user worktree access, restore mocks in `afterEach`, and trigger real Git behavior rather than source-grepping.

## 5. Hard constraints

No dependencies, no production edits, no placeholders or bare non-empty assertions. Existing aliases remain covered if useful.

## 6. Verification

Run only `bun test packages/coding-agent/test/slash-commands/graphtree.test.ts` and `git diff --check`. If tests fail because Lane A is not merged, record exact expected failures; do not weaken assertions.

## 7. Commit message

`test(graphtree): cover safe worktree lifecycle contracts (Gap B)`

## 8. Final report

Report branch/worktree, test names, verification, expected pre-integration failures, and blockers.
