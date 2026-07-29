# Side-Agent Command

Launch a split-view multi-agent workflow with one main agent (coordinator) and N sub-agents (workers) coordinating through a file-based queue. Race-safe on POSIX and Windows.

## Arguments

- `$ARGUMENTS` — **optional**. Usually the work description for the main agent to decompose. A small set of exact strings select the role directly instead (see the table below).

### Role selection

The current agent decides its role from `$ARGUMENTS`. To **match** a role alias, normalize the argument — trim it and collapse runs of whitespace (spaces, tabs) to a single space — then compare the entire normalized string, case-insensitively, against these aliases:

| `$ARGUMENTS` (normalized: trimmed, whitespace-collapsed, lowercased) | Role | Work description |
|---|---|---|
| `join` | **sub-agent** | — |
| `sub-agent` | **sub-agent** | — |
| `sub agent` | **sub-agent** | — |
| `main-agent` | **main-agent** | (none — ask the user) |
| `main agent` | **main-agent** | (none — ask the user) |
| _(empty)_ | **main-agent** | (none — ask the user) |
| _anything else_ | **main-agent** | `$ARGUMENTS` (trimmed; matching normalization does not alter it) |

This is unambiguous: only an exact match to one of the five role aliases selects a role explicitly; every other value is treated as a work description for the main agent. If you need a work description that collides with an alias, rephrase it (for example `main-agent coordination for the auth refactor`).

## Steps

### 1. Determine role

Apply the role-selection table above.

- **Sub-agent** → read `.omp/skills/side-agent/SUB-AGENT.md` and follow the sub-agent protocol.
- **Main-agent** → read `.omp/skills/side-agent/MAIN-AGENT.md` and follow the main agent protocol, using the work description (if any).

### 2. Main agent path

Follow [MAIN-AGENT.md](../skills/side-agent/MAIN-AGENT.md):

1. Create the `.side-agent/` coordination directory, including the `claims/`, `claims-revoked/`, `workers/`, and `results/` subdirectories.
2. Decompose the work into 2–6 independent tasks.
3. Write `session.md`, `queue.md`, and `log.md`.
4. Tell the user how many sub-agent instances to launch and give them the command: `/side-agent join`.
5. Poll for results: mirror active claims into the queue, publish completed claim-local results, fence stale claims, and aggregate.
6. Report to the user and offer cleanup.

### 3. Sub-agent path

Follow [SUB-AGENT.md](../skills/side-agent/SUB-AGENT.md):

1. Read `.side-agent/session.md` to confirm an active session.
2. Enter the poll loop: **atomically** claim a task by creating its claim directory with an immutable claim token, execute it while renewing the heartbeat, write the claim-local result + completion marker, then stop touching the claim, and repeat. Never edit `queue.md`.
3. Exit when the session is complete or aborted.

## Examples

### Main agent — coordinate research

```
/side-agent research the auth module, review the API surface, and write a migration plan
```

The agent decomposes this into 3 tasks (research auth, review API, write migration plan), creates the queue, and asks the user to launch 3 sub-agent instances.

### Sub-agent — join an existing session

```
/side-agent join
```

The agent reads the existing queue (read-only), atomically claims a task via its claim directory with an immutable token, executes it while renewing the heartbeat, writes the result + completion marker into the claim directory, and loops.

### Explicit role selection

```
/side-agent sub-agent       # sub-agent role (same as /side-agent join)
/side-agent sub agent       # space form also selects the sub-agent role
/side-agent main-agent      # main-agent role, then asks what to coordinate
/side-agent main agent      # space form also selects the main-agent role
```

### Main agent — no arguments

```
/side-agent
```

The agent asks the user what work to coordinate, then proceeds with the main agent path.

## Notes

- The main agent and sub-agents must all run in the **same workspace** so they share `.side-agent/`.
- Sub-agents can run in any CLI IDE that can read/write files and create directories — they just follow the protocol in `SUB-AGENT.md`.
- The coordination is entirely file-based. No IPC, no sockets, no extensions required.
- Use portable atomic primitives only: POSIX `mkdir` / PowerShell `New-Item -ErrorAction Stop` for claims; POSIX `mv -n` / PowerShell `Move-Item -ErrorAction Stop` for fencing renames; temp-write+replace for heartbeat/result rewrites. Never use cmd.exe `mkdir`.
- After a fencing rename, verify source absence, destination presence, and the expected claim token; command exit status alone is not proof (`mv -n` can skip with success).
- Full protocol spec: [PROTOCOL.md](../skills/side-agent/PROTOCOL.md) (also reachable as `.omp/skills/side-agent/PROTOCOL.md` from the workspace root).
