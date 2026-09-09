# safety-hook

An `oh-my-pi` extension that demonstrates `tool_call` blocking. It intercepts `bash` tool calls and returns `{ block: true, reason: "..." }` when the command contains `rm -rf /` with normal whitespace, preventing the tool from executing.

## What it demonstrates

- `pi.on("tool_call", ...)` — pre-execution interception
- `return { block: true, reason: "..." }` — blocking contract
- Regex guard on bash input (`/\brm\s+-rf\s+\//`)

## Install

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

Restart `omp`. The hook is active for all sessions.

Or load once:

```
omp --extension ./safety-hook
```

## How it works

```
LLM calls bash tool
       │
       ▼
tool_call handlers run
       │
       ├─ command matches /\brm\s+-rf\s+\// ?
       │       yes → { block: true, reason: "..." }  ←  execution stops, reason sent to LLM
       │       no  → undefined                        ←  execution continues normally
       ▼
tool executes (if not blocked)
```

The `reason` text is what the LLM receives as the tool error, so it can understand why the call was rejected and try a different approach.
