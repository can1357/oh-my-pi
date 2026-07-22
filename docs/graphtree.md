# GraphTree

`/graphtree` is a slash command for running several agents in parallel against
the same repository, each on its own isolated git worktree. It is a thin
orchestration layer over `git worktree` plus a static task-planning prompt —
it does not itself guarantee parallel correctness, conflict-free merges, or
any outcome beyond what the model does with the prompt it's handed.

## Concepts

- **Root node** — your current checkout, on whatever branch is checked out.
- **Worktree node** — a `git worktree` created under the shared worktrees
  directory, on its own branch (default `graphtree/<name>`, or an explicit
  branch you pass to `init`). Nodes are scoped to the repository you ran
  `/graphtree` from; nodes belonging to other repositories are not listed or
  operated on.
- **Task node** — a subagent run dispatched against a worktree node, typically
  via `/graphtree run`.

## Commands

| Command | Effect |
| --- | --- |
| `/graphtree` / `/graphtree status` / `/graphtree tree` | Print the active node hierarchy as an ASCII tree: root branch plus each worktree node's name, branch, and path. |
| `/graphtree list` | Print the same nodes as a flat list with kind, branch, and path. |
| `/graphtree init <name> [branch]` | Create a new worktree node under the worktrees directory. Without an explicit branch, the node is created on `graphtree/<name>`; pass a second argument to use a custom branch name instead. |
| `/graphtree run <objective>` | Return a static, prompt-driven plan: decompose the objective, create worktree nodes as needed, spawn subagents, and reduce the results back into the root. This only shapes what the model attempts next turn — it is not a guarantee of parallel execution, isolation, or success. |
| `/graphtree merge <name>` | Squash-merge the node's branch into the current `HEAD`. This stages the combined changes in the working tree for you to review and commit — it does not commit on your behalf. |
| `/graphtree prune` / `/graphtree cleanup` | Remove finished worktree nodes. Cleanup refuses to force-delete a worktree that has uncommitted or unnamed state; clean up or commit inside the node first. |
| `/graphtree help` | Show the command list. |

## Aliases

`/graphtree` with no subcommand is an alias for `/graphtree status`.
`/graphtree cleanup` is an alias for `/graphtree prune`.
`/graphtree tree` is an alias for `/graphtree status`.

## Lifecycle

1. `/graphtree init <name>` creates an isolated worktree node on its own
   branch, so a subagent can work there without touching your root checkout.
2. `/graphtree run <objective>` (from the root or from a node) asks the model
   to plan and dispatch work across one or more nodes.
3. Once a node's work is done and committed, `/graphtree merge <name>`
   squash-merges its branch into the current `HEAD` as staged changes —
   review and commit as you would any other staged diff.
4. `/graphtree prune` removes worktree nodes once you're done with them. A
   node with uncommitted changes is left in place rather than force-deleted;
   commit, stash, or discard the changes inside the node first, then prune
   again.

## Repository scoping

GraphTree only lists and operates on worktree nodes that belong to the
repository you invoked it from. Nodes created for other repositories under the
shared worktrees directory are not surfaced by `status`, `list`, `merge`, or
`prune`.
