# safety-hook

An `omp` extension that demonstrates `tool_call` blocking. It intercepts `bash` tool calls and returns `{ block: true, reason: "..." }` when the command matches `rm -rf` followed by an absolute path, preventing the tool from executing.

This deliberately narrow regex also blocks targets such as `/tmp/example`. It does not parse shell syntax or cover reordered flags, quoting, aliases, other deletion tools, or direct eval helpers; do not treat it as a complete safety boundary.

## What it demonstrates

- `pi.on("tool_call", ...)` — pre-execution interception
- `return { block: true, reason: "..." }` — blocking contract
- Regex guard on bash input (`/\brm\s+-rf\s+\//`)

## Install

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

Restart `omp`. The hook is active in sessions that load this extension.

For a named profile, use that profile's agent extensions directory. `PI_CODING_AGENT_DIR` overrides the default profile's agent directory, not a named profile's. Initialized XDG roots can change these locations.

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
