# 0007. Subagents get a copy-on-write view and return a diff

Status: accepted
Date: 2026-09-02
Area: runtime

## Context

The host/sandbox boundary (0006) is usually discussed as host versus VM. The multiplexed-workspace
row of the envelope (0001) raises the same question one layer down: many agents share one
workspace, and a child that writes into the parent's working tree is mutating the parent's authority
directly.

The common answer, `git worktree`, isolates tracked files only. Untracked build output, generated
files, dependency directories, local config, and anything gitignored are either missing from the
child (so its builds fail) or shared with the parent (so its writes collide). The child therefore
starts in a workspace that is neither the parent's nor a faithful copy.

`pi-iso` established the working alternative: give each child a copy-on-write view of the whole
workspace. The backend is whatever the filesystem offers — APFS clonefile, btrfs, ZFS, overlayfs,
ProjFS on Windows — with a plain copy as the fallback. The child diverges freely; when it finishes,
the parent receives a diff.

## Decision

- A subagent that may write MUST receive its own view of the entire workspace, not of the tracked
  subset. The view is copy-on-write where the filesystem supports it and a full copy otherwise;
  backend choice is a setting, not a code path the child can observe.
- The child MUST NOT share the parent's mutable authority. It never writes into the parent's tree;
  it writes into its view.
- The child's result MUST be returned as changes — a content-addressed patch or a retained branch —
  which the parent applies or merges under its own policy. Whether to apply is the parent's
  decision, made after the child has settled.
- The isolation is the filesystem form of 0006: the parent is the host, the child's view is the
  sandbox, the diff is the bounded stream crossing back.

## Consequences

- Parallel children can edit overlapping files without corrupting each other; conflicts surface as
  a merge decision at the parent, not as interleaved writes.
- Children can build, because the view carries untracked and ignored files.
- A child that fails or is cancelled leaves nothing in the parent's tree; its view is discarded or
  retained for inspection.
- Prohibited: children spawned with direct write access to the parent workspace when isolation is
  available. Prohibited: worktree-only isolation presented as full isolation.
- Cost accepted: a copy fallback on filesystems without CoW is slow and space-hungry for large
  workspaces. That cost is paid by the backend selection, not by weakening the rule.
- Cost accepted: the parent must own merge and conflict policy. That is where it belongs.

## Status in omp

**Implemented.** Primary implementation: `crates/driver/src/subagent/settings.rs`. Subagent isolation and patch/branch merge policy are centralized in driver composition.

## References

- The Harness Playbook, "The runtime" — "Subagents cross the same boundary"
- `pi-iso` (prior art: CoW workspace views for pi subagents)
- 0006 (host/sandbox rule), 0010 (subagents as jobs), 0001 (multiplexed-workspace row)
- `crates/driver/src/subagent/settings.rs`, `crates/envd/src/workspace/operations.rs`,
  `crates/envd/src/lib.rs` (`isolated`), `crates/agent/src/subagent.rs`,
  `crates/e2e/tests/p9_isolation.rs`
