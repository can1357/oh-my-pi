# omp-fork — English

**A fork of [oh-my-pi](https://github.com/can1357/oh-my-pi): cross-terminal agent networking (A2A), chrome-mcp as the base browser, a deterministic workflow orchestrator, agent-storm guards.**

- Repository: [spgsroot/oh-my-pi-team-agents](https://github.com/spgsroot/oh-my-pi-team-agents), branch `main` = upstream mirror + features
- Upstream base: 18.16+ (main `96e4d8eb`)
- [Русская версия](./README-RU.md) · [Full settings guide (RU)](./FORK-RU.md)

## What was built

### 1. Cross-terminal agent messaging (A2A bridge, protocol v1.0)

Agents in **different terminals/tabs/sessions** exchange messages and statuses. Every terminal can be both server and client; any topology (all-to-all via `/a2a auto`).

```bash
omp                     # terminal A — the bridge starts by itself (fork base state)
omp                     # terminal B
omp                     # terminal C ...
```
Auto-registration is on by default (`a2a.autoRegister`): every new session finds all
live bridges on the machine and wires up their peers — the other terminals' agents are
available from the first turn as `a2a:Main`, `a2a:Main-2` … (the manual `/a2a auto`
command also remains; disable with `--no-a2a-auto-register`). Spawn and talk:
> "Give a2a:Main-2 task X" — the task is delivered to **terminal B's own main agent** (it lands in its chat; that agent decides whether to answer itself or spawn its own subagents). The result returns in the standard `<task-result>` envelope. Spawning a NEW agent on the peer terminal is opt-in via the task tool's `a2aSpawn: true`.

- Loopback-only (`127.0.0.1`), bearer token `~/.omp/agent/a2a.token` (mode 600, auto-generated);
- JSON-RPC 2.0: `SendMessage`, `SendStreamingMessage` (SSE with final frames), `GetTask`, `ListTasks`, `CancelTask`; `TASK_STATE_*` statuses;
- SendMessage addresses the terminal's own agent by default (`metadata.to`); spawning a new agent is opt-in (`metadata.spawn: true` / `a2aSpawn` in the task tool);
- rejection taxonomy: `AGENT_REJECTED` (−32010); registration timeout → `SUBMITTED`+pending with a 30s grace;
- bridge registry `~/.omp/agent/a2a-bridges.json` (pid+port; dead entries pruned on read);
- same-name skill collisions resolve with suffixes (`a2a:Main-2/-3`); re-adding the same URL refreshes in place.

### 2. chrome-mcp as the base browser

Auto-discovery of the [chrome-mcp](https://github.com/spgsroot/mcp-chrome-2026-en) bridge on `127.0.0.1:12306` at session start: 81 `chrome_*` tools in **your real Chrome** (logins, extensions, cookies). The built-in `browser` tool remains an isolated fallback for headless automation.

- transport: modern MCP 2026-07-28 (streamable-http, `/mcp-new`) with automatic downgrade to 2025-06-18 (from [PR #14172](https://github.com/can1357/oh-my-pi/pull/14172), authorship preserved);
- setting `browser.chromeMcp` (default on); off: `disabledServers: ["chrome"]`;
- probe is IP-literal loopback only, silent skip without a bridge (CI-safe); a user-configured `chrome` server is never overwritten.

### 3. Ingress guard for inter-agent messaging (IrcBus)

For `agent://` messages within a session: rate (30 tokens/500 ms per sender; **a single message of any size always passes**), dedup (30 s window), hops (chain ≤28), backpressure (queues ≤50). All refusals are silent receipts. Settings: `irc.ingressGuard`, `irc.rateLimitTokens`, `irc.dedupWindowMs`, `irc.maxHops`.

### 4. Refuse instead of queue under spawn pressure

`task.concurrencyPolicy: "refuse"` — when `task.maxConcurrency` is exhausted the model gets a clear, numbers-bearing "Do not retry" error instead of silently waiting in a queue. The limit covers every spawn path (task tool, A2A, extensions, workflow).

### 5. Subagent token budget + handback

`task.tokenBudget`: at 50% budget a `<total_tokens>N tokens left of M</total_tokens>` notice is injected into the subagent's context, at 90% a wrap-up steer; it survives revived agents (wake/restore/revive). The `handback` tool — a subagent's final report with anti-injection (a "model output, not user text" frame + harness-tag escaping, one call per run).

### 6. Workflow — deterministic JS orchestration

The `workflow({script, resumeFrom?})` tool: `agent(prompt)`, `parallel(items, fn, {concurrency})`, `pipeline`, `phase`, `log`, `clock`, `args`. A node:vm sandbox with a global **allowlist** (zero host capabilities), `require`/`import`/`Date.now`/`Math.random`/`eval` forbidden, a 30 s synchronous timeout, AbortSignal cancellation. **Journal + resume**: every agent call is journaled; after a kill/Ctrl-C `resumeFrom` replays the matching prefix and executes only the tail; a failed child is recorded as `failed` and re-executed.

### 7. Capability tokens for destructive operations

One-shot `<8hex>@<id>` tokens (10-minute TTL, in-memory). A destructive op (dirty-worktree removal, `proc://<id>/kill` with unsaved output) first refuses with the token; a retry with `force: "<token>"` executes. Interactive UI kills are not gated.

### 8. Extension seam: pi.spawnSubagent

Extensions can spawn subagents (`pi.spawnSubagent({agent, prompt})`) with ordinary subagent rights and the shared concurrency limit. An upstream-PR candidate.

### 9. Agent Teams — planned

An analog of Claude Code's Agent Teams is planned on top of the A2A bridge: a lead session plus persistent teammates (full sessions with own context), direct teammate-to-teammate messaging, a shared task list, per-agent mailboxes, and a team config file. Not implemented yet — see [docs/agent-teams.md](./docs/agent-teams.md) for the direction and the design doc.

## Settings summary

| Setting | Default | Description |
|---|---|---|
| `a2a.enabled` / `a2a.port` | **on / 0 (auto)** | A2A bridge on a free loopback port; `--a2a-port N` pins a port for the run |
| `browser.chromeMcp` | on | chrome-mcp bridge auto-discovery |
| `irc.ingressGuard` | on | `agent://` message guard |
| `irc.rateLimitTokens` | 30 | per-sender rate per 500 ms |
| `irc.dedupWindowMs` | 30000 | dedup window |
| `irc.maxHops` | 28 | relay-chain limit |
| `task.concurrencyPolicy` | "queue" | "refuse" = refuse when saturated |
| `team.enabled` / `team.maxTeammates` | off / 4 | declarative agent teams (`.omp/teams/*.md`, `/team start`) |
| `task.tokenBudget` | 0 (off) | subagent token budget |

## Install on this machine

The `omp` command points to the fork binary (`~/.local/lib/omp-fork/omp`, 233 MB Bun compile). Profile is the stock `~/.omp`.

```bash
# roll back to the original omp:
ln -sf ../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ~/.bun/bin/omp
# refresh the fork binary after edits:
cd <path-to-clone> && bun run build && rsync -a packages/coding-agent/dist/omp ~/.local/lib/omp-fork/omp
```

## Quality

- SDD execution: 13 tasks; per-task security/concurrency reviews (4 tasks); the final whole-branch review was closed by one fix wave (`all_addressed`);
- full suite: 38443 pass; our failures = 0 against the upstream baseline;
- zero corporate context in the diff (clean public fork);
- live runs: A2A spawn through the bridge, the subagent chain (A2A → main → subagent → answer), workflow journal-resume after SIGKILL, 81 chrome tools on both MCP revisions.

## Origins of the mechanics

The agent-interaction mechanics follow established industry patterns for multi-agent coordination (addressed delivery with a reply channel, report anti-injection, journal-resume, capability tokens).

### Details

ingress guard (rate/dedup/hops/queue-cap) · refuse-instead-of-queue with numbers in the error · subagent token budget (`<total_tokens>`) · a final-report tool with anti-injection · the workflow VM (journal + prefix-resume, determinism) · one-shot capability tokens for destructive ops. Settings and details — [FORK-RU.md](./FORK-RU.md).

## Known limitations

`hops` chains extend through wake-relays only; an A2A pending-spawn past the 30 s grace → FAILED (poll GetTask by taskId); `refusalReason` v1 covers concurrency only; workflow cannot interrupt async continuations after the first await. Full list — [FORK-RU.md](./FORK-RU.md).

## License / attribution

Upstream: [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT). The fork keeps the full upstream license. PR #14172 (streamable-http) — author spgsroot.