---
type: Concept
title: Remote workspace (phase-1 Docker jobs)
description: Standalone package for durable isolated Docker sandbox jobs on MSI; not the multi-node cloud mesh orchestrator.
tags: [remote-workspace, docker, sandbox, ompk-remote, jobs]
timestamp: 2026-07-12T00:00:00Z
status: implemented
---

# Remote workspace (phase-1 Docker jobs)

Status: implemented (phase 1)

## Scope

`packages/remote-workspace` (`@pk-nerdsaver-ai/pi-remote-workspace`) records and runs **local, isolated Docker workspace jobs**. CLI binary: `ompk-remote`. It is a standalone package and is **not** yet wired into the top-level `omp` CLI.

This is **not** multi-host mesh/cloud orchestration. Cloud auth, Colab/Hetzner/Mac/Pi launch, and codespace-style dispatch live in **environments-cloud** — see [Environments-cloud routing](environments-cloud-routing.md). Phase-1 code implements the Docker backend path plus thin SoT resolvers / `ompk-remote environments` handoff printouts.

## Lifecycle

Orchestrator-owned transitions (`RemoteWorkspaceOrchestrator`):

```text
submit → authorize → provision → clone → install → run_agent
  → validate → checkpoint → clean → succeed | fail
```

- State machine + durable SQLite job store (`JobStore`, default `~/.omp/remote-jobs.sqlite`, override `OMPK_REMOTE_DB`).
- Backend interface `ExecutionBackend`; only `MsiDockerBackend` is implemented.
- Cleanup runs on success, failure, timeout, and cancel paths and records cleanup proof (container/volume/network gone).

## CLI

From `packages/remote-workspace`:

```sh
bun src/cli.ts doctor
bun src/cli.ts run <repo-url> [ref] [prompt...]
bun src/cli.ts status [job-id]
bun src/cli.ts cancel <job-id>
bun src/cli.ts list
```

`doctor` probes Docker reachability and the local worker image (`oh-my-pi/pi:dev`).

## Library surface

```ts
import { MsiDockerBackend, RemoteWorkspaceOrchestrator } from "@pk-nerdsaver-ai/pi-remote-workspace";
```

Public exports: backend contracts, job types/store, orchestrator. Per-job container + volume, non-root user, CPU/memory/PID limits, labeled resources.

## Network / clone policy

- Remote cloning **disabled by default** (`networkEgress: "none"`).
- Restricted clone requires `networkEgress: "restricted"`, an operator-managed restricted-egress Docker network, and an allowlisted HTTPS repo host (no credentials in URL).
- CLI `run` does not expose restricted-egress flags; it fails safely before launch when clone would require network.

## Key files

| Path | Role |
| --- | --- |
| `packages/remote-workspace/src/orchestrator.ts` | Job lifecycle owner |
| `packages/remote-workspace/src/backend/msi-docker.ts` | Docker backend |
| `packages/remote-workspace/src/backend/types.ts` | `ExecutionBackend` contracts |
| `packages/remote-workspace/src/job/state-machine.ts` | Durable transitions |
| `packages/remote-workspace/src/db/job-store.ts` | SQLite persistence |
| `packages/remote-workspace/src/cli.ts` | `ompk-remote` CLI |
| `packages/remote-workspace/test/orchestrator-contract.test.ts` | Lifecycle / cleanup contracts |

## Limits (current)

- No remote-host backend selection or cloud ExecutionBackend.
- Worker clones repo, prints prompt, runs validation commands only — does not run a full Oh My Pi agent or publish PRs.
- No secret injection path yet.
- Host process crash can leave labeled Docker resources; no startup reaper yet.

## Related

- Package README: `packages/remote-workspace/README.md`
- [Ethereal workspaces](ethereal-workspaces.md) — session-scoped isolation of the *agent* cwd (different concern)
- [Task-contract orchestration](task-contract-orchestration.md) — in-session planning contracts, not Docker jobs
