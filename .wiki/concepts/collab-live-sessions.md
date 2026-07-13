---
type: Concept
title: Collab live sessions
description: /collab shares a running omp session with other terminals and a browser guest client via packages/collab-web.
tags: [collab, remote-control, live-session, collab-web]
timestamp: 2026-07-12T00:00:00Z
status: implemented
---

# Collab live sessions

Status: implemented

## Scope

`/collab` (and aliases such as `/remote-control`) shares a **running omp session** with other omp instances and a browser guest client in real time. Guests render the session natively in their own TUI or web UI — streaming assistant text, tool cards, footer state — without terminal mirroring. The **host machine** still runs the agent and all tools; guests can prompt and interrupt.

## Surfaces

| Surface | Role |
| --- | --- |
| Host TUI | `/collab` starts hosting; prints join link + QR |
| Guest TUI | `oh-my-pk join "<token>"` (or equivalent) |
| Browser | Relay serves guest client; room id + key in URL fragment (e.g. `my.omp.sh/#…`) |
| `packages/collab-web` | Browser guest client and local relay tooling |

## Operator doc

Canonical long-form: `docs/collab.md`.

## Related

- [Remote workspace](remote-workspace.md) — Docker jobs, not live session sharing
- [Ethereal workspaces](ethereal-workspaces.md) — isolated cwd for a single agent session
