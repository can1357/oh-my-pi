# Lane A — GraphTree core safety [parallel-builder]

## 1. Mission + read-first

You are the core-safety worker for oh-my-pk. Make `/graphtree` truthful, repository-scoped, non-destructive, and compliant with prompt/static rendering rules.

Read first: `.prd/graphtree-release-orchestration.md`, `AGENTS.md`, `packages/coding-agent/src/utils/git.ts`, `packages/utils/src/dirs.ts`, and the current GraphTree implementation.

## 2. Owned files

You may ONLY edit:
- `packages/coding-agent/src/slash-commands/builtin/graphtree.ts`
- `packages/coding-agent/src/slash-commands/builtin/graphtree-run.md` (new)

Do not edit registry, tests, changelog, README, installers, or package manifests.

## 3. Gap

> A — GraphTree core safety: fix destructive prune, repository leakage, incorrect branch discovery, unsafe names, custom-branch merge, static prompt, and rendered path sanitation. [LARGE] depends on: none.

## 4. What to build

- Discover worktrees through the existing typed Git utility (`git.worktree.list(cwd)`), which naturally scopes to the current repository. Include only this feature's repo-hashed GraphTree paths; support safe recognition of legacy `graphtree-*` paths belonging to this repo when possible.
- Use a repo-qualified path segment with `hashPath(cwd)` so two repositories can use the same node name.
- Validate node names as short filesystem-safe single segments. Validate custom branch names through Git before mutation.
- Resolve merge branch from the discovered named node, not by reconstructing `graphtree/<name>`.
- Change cleanup to explicit `/graphtree prune <name>`. No argument only reports usage/candidates. Refuse dirty nodes. Remove through Git without `force`; never raw `fs.rm` fallback.
- Keep squash merge semantics but report that changes are staged for review/commit.
- Move the `/run` instruction body to static Markdown imported with `with { type: "text" }`; use minimal Handlebars-style replacement or an existing safe template helper for the objective. Do not construct the prompt in code.
- Sanitize dynamic output: tabs/text through existing render helpers, paths through `shortenPath`, and bounded lines through repository constants.

## 5. Hard constraints

No dependencies; use top-level imports; no `any`, dynamic imports, `ReturnType<>`, console calls, raw recursive deletion, or force removal. Preserve exported handler signatures.

## 6. Verification

Do not run project-wide checks. Run the coding-agent package check if dependencies are available; otherwise `bunx biome check` only on owned TS and `git diff --check`. Confirm `git diff --name-only` lists only owned files.

## 7. Commit message

`fix(graphtree): make worktree lifecycle repository-safe (Gap A)`

## 8. Final report

Report branch/worktree, files, exported signatures, lines, verification, and blockers.
