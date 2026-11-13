# wakeup

> Schedule a durable one-shot delayed checkback in the owning session, optionally gated on a shell check whose output changes.

## Source

- Entry: `packages/coding-agent/src/tools/wakeup.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wakeup.md`
- Scheduler and journal: `packages/coding-agent/src/async/wakeup-manager.ts`
- Delivery: `packages/coding-agent/src/session/wakeup-delivery.ts`

## Input and availability

`wakeup` is a discoverable tool available only in a persistent top-level interactive
session using a session store with exclusive writer leases (currently local file
storage), never print/RPC/ACP, disposable `/tan`, subagent or advisor sessions. Its input is:

```json
{
  "delaySeconds": 60,
  "prompt": "Check whether the local build has finished; report the result if still relevant.",
  "check": { "command": "test -f build.done && printf done || printf pending", "maxWaitSeconds": 600 }
}
```

- `delaySeconds`: integer 1–86400. `prompt`: nonblank, self-contained saved instruction
  data, at most 8000 characters. Latest user intent and current permissions supersede it.
- Without `check`, one follow-up is attempted after the delay. With `check`, a baseline
  is captured immediately, then the same command runs in the original cwd after each
  delay. Unchanged stdout/exit status does not invoke a model. Changed output, a nonzero
  exit, later failure/denial, timeout, output overflow, or the mandatory deadline causes
  one follow-up. A rejected initial approval/preflight fails scheduling without accepting
  a timer. Repeated unchanged checks compare against the original baseline.
- `check.command`: nonblank, at most 4000 characters. `check.maxWaitSeconds`: required
  integer from `delaySeconds` through 86400. Checks are serial, bounded to ten seconds
  including approval/preflight, and at most 8192 raw stdout bytes, hashed before any
  text decoding. Stderr is discarded. Only a SHA-256 digest/status is retained; no
  output artifact or minimizer capture is written. After cancellation, a subsequent
  check waits for the native process tree to terminate. Command text and the prompt
  are saved: never put credentials in them.
- Every baseline and later check uses current bash approvals, extension preflight,
  interception and git guards, including after restore. Conditional checks require the
  enabled native bash tool, not a replacement registered by an extension; fixed timers
  do not. Use bounded read-only checks: the scheduler does not make arbitrary shell
  commands read-only or safe.
- Eight timers may be pending, independently of execution-job capacity. They do not
  occupy execution slots, block `wait`, keep a process alive, or suppress stop hooks.
  Jobs/agents already auto-deliver: do not add redundant wakeups. Keep one timer per
  continuing watch; cancel old watches when intent changes.
- `read proc://` lists only pending timers, so terminal history cannot grow the table.
  `read proc://<wakeup-id>` still shows saved cancelled/claimed state by explicit ID.
  `write proc://<wakeup-id>/kill` persists cancellation before returning success.
  Once delivery is claimed it may already have happened; `/kill` explicitly refuses
  cancellation and never rewrites that claim as a successful cancellation.
- Closing OMP, `/new`, switching or forking suspends the old session's timers.
  Reopening the exact original session restores them, including overdue checkbacks,
  only after initial extension startup and tool activation have settled. Deferred
  extensions also finish loading before a check or follow-up. The strict owner
  reconciles newer durable entries before restoring, without changing the selected
  transcript branch; a missing, replaced or divergent journal fails closed and
  requires a normal coordinated reload. New sessions and forks never inherit timers.
  `omp session unpack` cancels timers carried in the archive before the session lands,
  so an imported journal never runs a saved check command or prompt on this machine.
  No shell checks run while closed; after an expired conditional deadline, the overdue
  notice fires without another check.
- Delivery is durably claimed **before** enqueueing the follow-up: a crash in that
  gap can lose it, rather than duplicate it. This is at-most-once delivery attempts,
  not exactly-once model execution. Cancelled and claimed timers are never replayed,
  even after transcript branch navigation. A strict session ownership lease prevents
  another live process from restoring the same owner's timers or running a baseline
  check. Contention or OS lease setup errors fail closed, without shell execution or
  delivery; the session writer's unrelated best-effort fallback is not used here.
  A later `wakeup` scheduling request retries activation under the same startup and
  authorization gates, taking a new strict lease and refreshing durable state first;
  there is no background lease polling.
