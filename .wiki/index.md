---
okf_version: "0.1"
---

# Knowledge Bundle

Project knowledge for the `oh-my-pi` fork (`kingkillery/oh-my-pi`), authored in
[Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md):
plain markdown + YAML frontmatter, diffable in git, readable by humans and agents alike.

# Concepts

* [Concepts](concepts/) - design decisions and synthesized patterns for this codebase.

Recent additions (2026-07-29):

* [Coding-agent reliability hardening](concepts/coding-agent-reliability-hardening.md) — CI recovery evidence, Bun 1.3.14 singleton-bucket mitigation, and context-file disable-ID migration status
* [Environments-cloud routing](concepts/environments-cloud-routing.md) — pkscloudenvs MSI SoT handoff
* [Remote workspace](concepts/remote-workspace.md) — phase-1 Docker sandbox jobs
* [Task-contract orchestration](concepts/task-contract-orchestration.md) — ephemeral contracts + evidence stack
* [Ethereal workspaces](concepts/ethereal-workspaces.md) — session cwd isolation
* [Collab live sessions](concepts/collab-live-sessions.md) — `/collab` multi-client sharing

# References

* [References](references/) - external sources (papers, vendor docs) mirrored as first-class concepts.

# History

* [Recent History — 2026-07](concepts/recent-history-2026-07.md) — browser agents, context evidence, orchestration, side-agent coordination, remote workspaces, and environments-cloud routing.
