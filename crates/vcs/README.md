# omp-vcs

In-process version control for the coding agent: one Rust interface over git
and Jujutsu.

- **git** (`git::GitRepo`) runs on gitoxide. The git binary survives only
  where an in-process implementation cannot reach parity: credential-bound
  network transfers (push/fetch/clone reuse the user's ssh config and
  credential helpers) and reftable repositories.
- **jj** (`jj::JjWorkspace`) runs on jj-lib, which shares the same gitoxide
  stack for its git backend. No subprocess at all.
- **generic** (`Repo`, `detect`) dispatches portable operations — status,
  diffs, logs, labels, watch targets — to whichever backend owns a directory,
  with explicit `Feature` capability checks where the backends diverge.

Structural philosophy: discovery is a pure filesystem walk (no subprocess, no
gix open) cheap enough for synchronous render paths; the gitoxide handle opens
lazily on first object/index access. Failure modes are structured `Error`
variants, never stderr regexes. The CLI escape hatch (`git/cli.rs`) is
deliberately small, hardened (non-interactive env, stripped `GIT_DIR` family,
bounded capture, deadline + SIGTERM→SIGKILL), and reserved for the two cases
above.
