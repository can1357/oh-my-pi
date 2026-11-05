# workflow

> Run one deterministic JavaScript workflow over subagents, with a synchronous per-call journal and prefix resume.

## Source

- Entry: `packages/coding-agent/src/workflow/tool.ts`
- VM: `packages/coding-agent/src/workflow/vm.ts`
- Journal: `packages/coding-agent/src/workflow/journal.ts`
- Test: `packages/coding-agent/test/workflow.test.ts`
- Fork notes: `README-fork.md` → "Workflow VM with journal resume"

## Inputs

`{ script: string, args?: string, resumeFrom?: string }`.

- `script` is the body of an async function. Top-level `await` and `return`
  both work; the returned value must be JSON-serializable and is rendered in
  the tool result.
- `args` is exposed to the script as the `args` string (default `""`).
- `resumeFrom` is a prior run id (`wf-…`, printed in the result). The journal
  is read from the current session; an unknown run id is an error.

## Script context

| Helper                                   | Contract                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `agent(prompt, opts?)`                   | One inline `task` subagent; resolves `{ result, tokens, cached? }`. `opts.agent` selects the agent definition, `opts.context` is shared background. |
| `parallel(items, fn, { concurrency })`   | Bounded worker pool; results in item order; concurrency defaults to 4.    |
| `pipeline(items, ...stages)`             | Each item flows through the stages in order; different items overlap.    |
| `phase(name)` / `log(...)`               | Progress markers and run log, streamed as tool updates.                  |
| `clock()`                                | Deterministic 1-based counter.                                           |
| `args`                                   | The call's `args` string.                                                |

Only one `parallel()`/`pipeline()` may be in flight at a time; nesting or
overlapping two fan-outs is rejected.

## Determinism and isolation

The VM context enforces the rules:

- `require`, `process`, `Date`, `Date.now`, `Math.random`, and
  `Temporal.Now` throw a `ReferenceError` naming the rule;
- static `import` and `import()` are rejected before execution;
- `codeGeneration` is disabled, so `eval`/`new Function` throw `EvalError`;
- `ShadowRealm` is removed (it would create an unguarded realm);
- after the prelude, every global outside a documented allowlist is deleted
  or poisoned — runtime-injected host helpers (`Bun`, `fetch`, timers,
  `WebSocket`, `crypto`, `performance`, …) are absent.

The script's synchronous portion is bounded (`runInContext` timeout, default
30 s). An abort signal cancels the wait on an asynchronous script, but a tight
synchronous loop is only stopped by the VM timeout and asynchronous
continuations already queued cannot be cancelled.

## Journal and resume

Calls append synchronously to
`<session dir>/workflow/<session>/journal.jsonl` (fallback:
`<agent dir>/workflow/<session id>/journal.jsonl`). Each transition is one
JSONL line `{runId, index, promptHash, agent, result, tokens, status}` with
`status` ∈ `started | completed | failed | cached`. A truncated final line from
a kill is ignored by the reader, and the next append starts on a fresh line.

`resumeFrom` matches by call index and prompt hash (prompt + agent + context).
The completed/cached prefix is replayed with `cached: true` and journaled as
`cached`; execution starts at the first divergence and continues to the end.
Chained resumes are supported.
