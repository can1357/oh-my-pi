# 0012. Settings are convars: policy declared with the variable

Status: accepted
Date: 2026-09-02
Area: control-plane

## Context

omp v1's configuration system became a minefield. It grew dirty tracking and several
configuration levels (global, session-level, ephemeral), and most get/set operations were routed
through the `AgentSession` type because every change had to be persisted to the
session JSONL. Each new setting therefore added a property to a growing god object, a branch in
the persistence path, and a private decision at every setter about which level it lived in and
whether children saw it. The `tier: { openai: priority, subagent: inherit }` shape (0013) is one
visible product of that: inheritance became a second setting because nothing at the definition
site could say it.

The Source Engine solved this class of problem years ago and its users can recite `sv_cheats`
from memory. A convar is a typed variable with a name, a default, a help string, and a bitfield of
flags, declared once at the definition site:

```cpp
ConVar sv_gravity("sv_gravity", "800", FCVAR_REPLICATED | FCVAR_NOTIFY, "World gravity.");
```

The flags carry the policy: `REPLICATED` pushes the server's value down to every client,
`USERINFO` sends client-owned values up, `CHEAT` locks a variable behind `sv_cheats`, `ARCHIVE`
decides what reaches `config.cfg`, and every change is stamped into the `.dem` demo file so a
replay is honest. Persistence, ownership, scope, replication, and replay-honesty are properties of
the variable, not of the call site that mutates it. Nobody routes a `set` through a god object;
nobody hand-rolls dirty tracking.

## Decision

Every setting MUST be declared once, at its definition site, with its policy expressed as flags:

- **scope** — process, user profile, project, or session;
- **persistence** — whether and where the value is archived (`ARCHIVE`);
- **inheritance** — whether a spawned child seeds from the parent's live value (0013);
- **replication** — whether the authoritative value is pushed to remote views, and whether a
  client-owned value flows back up;
- **replay-honesty** — whether a change is journaled so resume and inspection observe it.

A setter NEVER routes through a session god object, and no subsystem MAY implement its own dirty
tracking, level resolution, or persistence branch for a setting. The typed variable owns those
concerns; call sites read and write it.

A session-scoped convar is one journaled node in the authoritative session tree (0003). It is NOT
a second settings database beside the DOM. Its flags declare how that node participates in
resume, rewind, spawn, replication, and archival; the tree's existing derivation rules (0004) do
the rest.

The convar is the only currency the control plane speaks: cfg files, console input, binds,
aliases, remote administration, and journal replay all address these declared variables (0014).

## Consequences

- Adding a setting is one declaration. Scope, archival, inheritance, and replication are answered
  in the same line, and reviewers can see the policy without tracing setters.
- Rewind and resume of session-scoped values fall out of the tree; no settings-specific
  serialization path exists to drift.
- Remote views (Spectator, remote driver in 0001) receive replicated values through the same
  replication that carries the rest of the tree; a value the host did not flag as replicated
  never leaves the host.
- Prohibited: per-setting `inherit` sub-keys, ad hoc "ephemeral" levels, and any `AgentSession`-
  style facade that persists settings on behalf of callers.
- Cost accepted: existing TOML-layered settings must be re-expressed as declarations with flags,
  and session-scoped values must move from process-local state into the tree.

## Status in omp

**Implemented.** Primary implementation: `crates/con/src/lib.rs`. Typed convars and DOM-backed SESSION writes replace the former settings stack.

## References

- The Harness Playbook, "The control plane" → "Values: declare policy with the setting"
- Valve Developer Community, ConVar (https://developer.valvesoftware.com/wiki/ConVar)
- 0003 (session tree as authority), 0004 (lifecycle derives from the tree), 0013 (seeding and
  cfg), 0014 (command stream)
- `crates/settings/src/schema.rs`, `crates/settings/src/snapshot.rs`, `crates/agent/src/regime.rs`
