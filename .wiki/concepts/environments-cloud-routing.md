---
type: Concept
title: Environments-cloud (pkscloudenvs) routing
description: MSI-local SoT for mesh/cloud skills and CLI handoff; OMPK phase-1 Docker remote-workspace stays local sandboxes only.
tags: [environments-cloud, pkscloudenvs, mesh, skills, handoff, remote-workspace]
timestamp: 2026-07-12T00:00:00Z
status: implemented
---

# Environments-cloud (pkscloudenvs) routing

Status: implemented (thin SoT wiring — not a second cloud backend)

## Split

| Concern | Owner |
| --- | --- |
| Local Docker sandbox jobs | `packages/remote-workspace` (`ompk-remote run`) |
| Mesh / cloud / auth / codespace-style launch | **environments-cloud** ([pkscloudenvs](https://github.com/kingkillery/pkscloudenvs)) |

**MSI-local canonical root:** `C:\dev\desktop-infra\environments-cloud`  
**Override:** `OMPK_ENVIRONMENTS_CLOUD_ROOT` or `PKS_ENVIRONMENTS_CLOUD_ROOT`

## Code surfaces

### Pure resolvers (remote-workspace)

`packages/remote-workspace/src/environments-cloud.ts`:

- `resolveEnvironmentsCloudRoot()`
- `resolveEnvironmentsCloudSkill("mesh-orchestrator")`
- `resolveMeshHandoff("mesh" | "cloud" | "mesh-run" | …, args)`
- `environmentsCloudSkillCustomDirectories()`

Exported from package index. Unit-tested without live mesh nodes.

### CLI

```sh
cd packages/remote-workspace
bun src/cli.ts environments
bun src/cli.ts environments skill mesh-orchestrator
bun src/cli.ts environments handoff mesh status
bun src/cli.ts cloud   # alias
```

Prints routes/argv only; does not replace pkscloudenvs CLIs.

### Session skill auto-route (coding-agent)

`packages/coding-agent/src/config/environments-cloud-skills.ts` + `loadSkills()`:

- When `{root}/.agents/skills` exists, merge into discovery as a custom directory.
- Skills: `mesh-orchestrator`, `colab-warmup` (and any other `*/SKILL.md` under that tree).
- Tests pass `environmentsCloudRoot: null` for isolation.

## Operator bins (SoT checkout)

`{root}/.agents/bin/`: `mesh`, `mesh-run`, `cloud`, `mesh-sync`, `mesh-ci`, `colab`, …

## Docs

- `docs/environments-cloud.md`
- `docs/skills.md` (mesh section)
- `docs/environment-variables.md`
- Package README SoT table
- [Remote workspace](remote-workspace.md) — Docker phase-1 only

## Non-goals

- No full remote-host `ExecutionBackend` inside OMPK that replaces pkscloudenvs.
- No vendoring mesh CLIs into the monorepo.
