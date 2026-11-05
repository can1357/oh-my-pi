# Fork maintenance

This checkout is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
that carries agent-messaging work on top of upstream. This file documents the
branch model, the profile isolation that keeps fork runs away from the
production `omp` install, and the rebase ritual that keeps feature branches on
top of upstream.

## Branch model

| Branch                     | Holds                                                        | Pushed?           |
| -------------------------- | ------------------------------------------------------------ | ----------------- |
| `main`                     | A pure mirror of `upstream/main`; no fork commits, ever.     | Yes — mirror only |
| `integrate/agents-upgrade` | The fork's integration base: upstream plus landed fork work. | No                |
| `feat/*`                   | Short-lived feature branches on the integration branch.      | No — local only   |

Do not commit on `main`. Keep fork work on `feat/*` and land it on
`integrate/agents-upgrade`; rebase the feature branches whenever the integration
branch moves.

## Profile isolation

Fork runs and fork test runs must use `$HOME/.omp-fork` as the agent directory
and must never touch the production profile in `~/.omp`:

```bash
PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test packages/coding-agent/test/<file>
```

- Set `PI_CODING_AGENT_DIR`, never `OMP_PROFILE`. A named profile derives its
  agent dir under `~/.omp/profiles/<name>` and ignores `PI_CODING_AGENT_DIR`
  (`packages/utils/src/dirs.ts`, `resolveActiveAgentDirOverride`), so a profile
  variable silently defeats the isolation.
- `bun test` is not hermetic on its own: run without the variable it writes
  session, collab, worktree, and security scratch data into the production
  profile.
- Never run `bun run setup` in this checkout. Its `coding-agent link` and
  `link omp` steps overwrite the production `~/.bun/bin/omp` link and the global
  `~/.bun/install/global/node_modules` tree. Run `bun run build:native` when the
  native addon is missing; `bun run build` builds the packages.
- `bun install` rewrites `bun.lock` (catalog version normalization). Revert it
  with `git checkout -- bun.lock`; never commit that diff.

## The `omp-fork` launcher

`scripts/omp-fork.sh` runs this checkout's CLI against the isolated profile:

```bash
install -m 755 scripts/omp-fork.sh ~/.local/bin/omp-fork
omp-fork --version              # omp/18.16.0, reads and writes only ~/.omp-fork
omp-fork config path            # /Users/<you>/.omp-fork
```

What it guarantees:

- exports `PI_CODING_AGENT_DIR=$HOME/.omp-fork` before `exec bun
  <fork>/packages/coding-agent/src/cli.ts "$@"`;
- refuses to run when `OMP_PROFILE` or `PI_PROFILE` is set (exit 64), because a
  named profile would bypass `PI_CODING_AGENT_DIR`;
- resolves the checkout from `$HOME/Documents/oh-my-pi` by default and honors
  `OMP_FORK_ROOT`; a missing checkout exits 66 with the expected path.

The production `omp` on `PATH` (`~/.bun/bin/omp`) is untouched: use `omp` for
the installed agent and `omp-fork` for this checkout.

## Chrome MCP bridge (base browser)

The fork treats the user's real Chrome as the primary browser through the
local `mcp-chrome-bridge`: at session start it probes
`http://127.0.0.1:12306/mcp` (2 s deadline, loopback only) and, when the
bridge answers, registers it as the `chrome` MCP server with its 81 `chrome_*`
/ page tools. A missing bridge is skipped silently — no error, no prompt
notice — and the built-in `browser` prelude stays available as an isolated
Chrome for Testing fallback. Turn the probe off with the `browser.chromeMcp`
setting (default on).

Requirements:

- The bridge runtime at `~/.local/share/mcp-chrome-bridge` (deployed from
  `~/Documents/mcp-chrome-2026`, see the anglicized fork notes). Start it once
  per login when Chrome does not spawn the native host itself:

  ```bash
  ~/.local/share/mcp-chrome-bridge/dist/run_host.sh
  ```

- The `chrome-mcp` extension must be loaded unpacked in the user's Chrome
  (`chrome://extensions`, Developer mode, Load unpacked from
  `~/Documents/chrome-mcp-server-2.8.2-chrome`) and be the English build — the
  bridge serves `tools/list` from its vendored shared catalog, not from the
  extension. Restart Chrome after swapping extension files; Chrome keeps the
  old extension in memory.

Regression pair (run after changing the extension or bridge build). Expect 81
English tools, `serverInfo.version` 2.8.5, and no CJK descriptions:

```bash
SID=$(curl -sS -X POST http://127.0.0.1:12306/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'Origin: http://127.0.0.1:12306' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}' \
  -D - -o /dev/null | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
curl -sS -X POST http://127.0.0.1:12306/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'Origin: http://127.0.0.1:12306' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep -c '"name":"'
```

The bridge exposes the 2025-06-18 revision at `/mcp` and the stateless
2026-07-28 revision at `/mcp-new`; the `streamable-http` transport negotiates
the era itself (falling back to `initialize` when the endpoint refuses
`server/discover`), so a config can point at either revision. Full setup
history and gotchas: `~/Documents/llmops/agents-memory/browser-mcp-chrome.md`.

## IRC ingress guard

Peer messaging (`write agent://<id>`) is guarded on the send path of the
process-global `IrcBus` (`packages/coding-agent/src/irc/bus.ts`, policy in
`irc/ingress-guard.ts`). Workers are covered without extra state: their
`RemoteIrcBus.send` proxies to the main bus, so one guard covers the process.

What is refused (always as a `failed` receipt naming the reason, never a throw):

| Guard        | Rule                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| Rate         | 30 tokens per sender per 500 ms; a message costs `characters / 4` (min 1) |
| Duplicate    | same (sender, recipient, sha256(body)) within 30 s                        |
| Hop chain    | more than 28 senders in `IrcMessage.hops` (the bus appends the sender)     |

Progress notes (`?progress`) and automated wake relays are exempt from the
duplicate check — both are meant to repeat — and `wait`, broadcast expansion,
and the internal display relay (`#relayToMainUi`) are untouched. A busy
recipient's incoming queues (`#interrupts`, `#asides` in
`session/irc-bridge.ts`) are capped at 50 pending records, dropping the oldest
exactly like the 100-message mailbox bound, which stays as it was.

Settings (`irc.*`, next to `mcp.*`/`browser.*` in the settings panel under
Tasks → Subagents):

- `irc.ingressGuard` (default on) — master switch.
- `irc.rateLimitTokens` (default 30) — tokens per sender per 500 ms; `0` off.
- `irc.dedupWindowMs` (default 30000) — duplicate window; `0` off.
- `irc.maxHops` (default 28) — longest accepted chain; `0` off. Only
  automatic wake relays carry a chain forward: an ordinary `write
  agent://<id>` reply starts a fresh one (`hops = [sender]`), because the
  reply tool never sees the inbound message's chain. The ceiling therefore
  binds automated ping-pong chains, not hand-written forwards.

The policy is read from the acting agent's session settings, falling back to
the main session's, so a worker-proxied send follows the main policy. Covering
tests: `test/irc-guard.test.ts` and the pinning suites listed under "Rebase
ritual".

## Spawn concurrency policy

`task.concurrencyPolicy` decides what a `task` spawn does when every
`task.maxConcurrency` slot is busy (default `32`; `0` means unlimited). One
session-scoped semaphore bounds every `SpawnRun`, and the permit is taken on
the main thread in `SpawnRun` before `runSubprocess` — so the policy covers
both direct and worker-thread dispatch (`task.workerThreads`).

| Policy            | What a spawn over the cap does                                    |
| ----------------- | ----------------------------------------------------------------- |
| `queue` (default) | Wait in the semaphore FIFO, then start when a slot frees. Unchanged upstream behavior. |
| `refuse`          | Fail immediately with a model-visible error; never queue.         |

Under `refuse` the spawn returns (it never blocks, and never silently waits):

```text
Concurrent subagent limit reached (1 running; task.maxConcurrency=1). Do not retry; wait for running tasks or ask the user to raise task.maxConcurrency.
```

- `1 running` is the live running count and `task.maxConcurrency=1` the
  configured limit; `, N waiting` is added when spawns were parked before the
  policy flipped. The policy is read at acquire time, so parked queue-mode
  spawns keep their place and the flip applies to the next acquire.
- An inline (`blocking`) spawn returns the text as a tool result with
  `isError: true`; a background spawn fails its job with the same text and the
  job's error delivery carries it to the model.
- A refused spawn emits one `task:subagent:progress` frame with
  `refusalReason: "concurrency_limit"` — the existing observability channel,
  no new event; it is emitted for spawns that already have a progress row, and
  observers keyed by agent id may ignore a frame for an unknown id.
- Enforcement lives in `packages/coding-agent/src/task/index.ts`
  (`#acquireSpawnPermit`), the error in `task/spawn-run.ts`
  (`SpawnRefusedError`), the non-blocking take in `task/parallel.ts`
  (`Semaphore.tryAcquire`, `running`, `waiting`), and the setting in
  `task/settings.ts`. Covering tests: `test/spawn-refusal.test.ts`.

## Rebase ritual

1. Sync the mirror (fast-forward only) and push it:

   ```bash
   git switch main
   git fetch upstream main
   git merge --ff-only upstream/main
   git push origin main            # mirror commits only
   ```

2. Bring upstream into the integration branch. Merge — do not rebase the
   integration branch itself, since feature branches are rebased onto it:

   ```bash
   git switch integrate/agents-upgrade
   git merge main
   ```

3. Move every feature branch onto the integration branch:

   ```bash
   scripts/rebase-forks.sh
   ```

   The script rebases each local branch matching `feat/*` (override with
   `OMP_FORK_BRANCHES`, or the base with `OMP_FORK_BASE`), skips branches already
   on the base, and skips branches checked out in another worktree. It refuses to
   start with uncommitted tracked changes or an unfinished rebase.

4. Resolve conflicts. On the first conflict the script stops, lists the
   conflicted files, and exits 1:

   ```bash
   git status                      # conflicted paths
   # edit the files, then:
   git add <files> && git rebase --continue
   # or abandon this branch's rebase:
   git rebase --abort
   ```

   Re-run `scripts/rebase-forks.sh` afterwards to continue with the remaining
   branches.

5. Re-run the fork's covering tests with the isolated profile before committing:

   ```bash
   PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test \
     packages/coding-agent/test/irc-bus.baseline.test.ts \
     packages/coding-agent/test/tools/irc.test.ts \
     packages/coding-agent/test/session/irc-bridge-relay.test.ts \
     packages/coding-agent/test/task/executor-irc-wake-yield-reset.test.ts
   ```

## Baseline tests

`packages/coding-agent/test/irc-bus.baseline.test.ts` pins the upstream mailbox
contract the fork's messaging work builds on. It is a tripwire, not a copy of
the IRC suite: its header names the upstream tests that already cover the
headline scenarios (waiter resolution, parked revival, busy aside, unknown-id
failure, mailbox cap) and asserts only the gaps — failed sends leave no mailbox
residue, a waiter on a parked recipient still revives it, bus-level delivery to
a streaming recipient queues an interrupt instead of prompting, and the mailbox
cap bounds unread counts while `wait` drains survivors oldest-first.

The full `bun test` run has pre-existing upstream failures (environmental
browser-tab and cross-platform cases, plus parallel-run flakes). Treat only
failures outside that recorded baseline as regressions.
