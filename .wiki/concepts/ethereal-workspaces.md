---
type: Concept
title: Ethereal workspaces
description: Session-scoped isolated workspaces so omp tools and edits do not mutate the source checkout until exit.
tags: [ethereal, worktree, isolation, session, workspace]
timestamp: 2026-07-12T00:00:00Z
status: implemented
---

# Ethereal workspaces

Status: implemented

## Problem

Agent runs that edit the live checkout risk polluting the operator's branch with half-finished work. Ethereal workspaces materialize an isolated project root for the **whole agent session**.

## Behavior

Every prompt, tool call, shell command, edit, test, and follow-up turn sees the ethereal workspace as `cwd` until the session exits.

```sh
omp -p "fix failing tests" --ethereal --workspace-mode auto
omp --ethereal --workspace-mode auto
omp --ethereal --workspace-mode worktree --preserve-workspace
omp --ethereal --workspace-mode auto --export-patch ./agent-output/fix.patch
```

### Modes

| Mode | Behavior |
| --- | --- |
| `auto` | Git: probe reflink CoW → `reflink-copy`, else `worktree`. Non-git: `copy`. |
| `copy` | Full portable copy (excludes deps, build outputs, caches, `.git`, secret-looking files). |
| `worktree` | `git worktree add --detach` + overlay staged/unstaged/untracked non-ignored files. |

Manifest records requested `workspaceMode` and actual `actualWorkspaceMode` (`copy` | `reflink-copy` | `worktree`) under `.ethereal/manifest.json`.

### Lifecycle

1. Resolve source repo from launch cwd  
2. Materialize workspace  
3. Copy only explicitly allowed env/secret files  
4. Write manifest  
5. Start session with workspace as `cwd`  
6. On exit: optional patch export; clean by default (`--preserve-workspace` keeps it)

Secrets are never copied by default (`--copy-env`, `--env-file`, `--copy-secret`, allowlists exist).

## Contrast with remote-workspace

| | Ethereal | Remote workspace package |
| --- | --- | --- |
| Purpose | Isolate **this** agent session's cwd | Durable **Docker job** lifecycle |
| Package | coding-agent / omp flags | `packages/remote-workspace` |
| Persistence | Session-scoped (optional preserve) | SQLite job DB + containers |

## Source of truth

- Operator doc: `docs/ethereal-workspaces.md`
- Implementation lives under coding-agent workspace/ethereal paths (see that doc and CLI flags for exact modules)

## Related

- [Remote workspace](remote-workspace.md)
- [Task-contract orchestration](task-contract-orchestration.md)
