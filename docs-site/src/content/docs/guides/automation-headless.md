---
title: Automation & Headless
description: Drive omp non-interactively from scripts and CI with print mode, JSON and RPC output, session resume, and the SDK and Python clients.
coverage: B
---

omp runs without a terminal: a one-shot `omp -p` call answers a prompt and exits, `--mode json` and `--mode rpc` expose structured output to scripts and long-lived hosts, and the TypeScript SDK and Python `omp-rpc` client embed the agent in your own process. This page covers all three levels, plus hooks and the flags that make omp safe to run from CI. For the complete flag list see [CLI Reference](/oh-my-pi/reference/cli/); for the embedding APIs see [SDK](/oh-my-pi/extending/sdk/), [RPC](/oh-my-pi/extending/rpc/), and [Hooks](/oh-my-pi/extending/hooks/).

## One-shot runs

`-p, --print` runs the agent non-interactively: it processes the prompt and exits. In the default text mode the final assistant response is written to stdout, which makes plain command substitution work:

```bash
summary="$(omp -p 'Summarize the changes in this diff')"
omp -p 'Write a commit message for this diff' --max-time 10m --yolo
```

Anything after the flags that is not a registered subcommand is sent to the agent as the prompt. Prefix a path with `@` to attach a file to the initial message, and use `--` to stop flag parsing so flag-shaped text is treated as the prompt.

A `-p` run saves a session transcript by default, so the run can be resumed later; pass `--no-session` for an ephemeral run that saves nothing. A turn that ends in an error or is aborted writes the error line to stderr and exits with status `1` — a failed prompt never looks like a successful CI step.

| Flag | Description |
| --- | --- |
| `--model <model>` | Model to use (fuzzy match: `opus`, `gpt-5.2`, or `openai/gpt-5.2`) |
| `--max-time <duration>` | Stop the session after this duration (e.g. `600`, `10m`, `1h`) |
| `--cwd <dir>` | Directory to start in (overrides the launch cwd) |
| `--no-session` | Don't save the session (ephemeral) |
| `--approval-mode <mode>` | Override `tools.approvalMode` for this session (`always-ask`, `write`, or `yolo`) |
| `--auto-approve`, `--yolo` | Auto-approve all tool calls (skip approval prompts) |
| `--config <file>` | Load an extra `config.yml`-style overlay for this run (repeatable) |
| `--no-title` | Disable title auto-generation |
| `--print-thoughts` | Include thinking blocks in print-mode text output |
| `--` | End option parsing; everything after is literal prompt text |

## Structured output

`--mode` selects how the run reports progress. The default is `text` (final response only); `json` streams the session as JSON lines; `rpc` and `rpc-ui` run a long-lived protocol over stdio.

### JSON event stream

`omp -p "prompt" --mode json` prints one JSON object per line: a session header (when one exists) followed by every session event — `agent_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, and the `tool_execution_*` events. `message_update` lines carry only the incremental delta, so the stream stays linear in conversation size; the authoritative message arrives in `message_end`.

```bash
omp -p 'List the files in src/' --mode json | jq -c 'select(.type == "message_update")'
```

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Here"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" are the files:"}}
{"type":"message_end","message":{…}}
{"type":"agent_end","messages":[…]}
```

### RPC protocol

`omp --mode rpc` keeps the agent alive as a newline-delimited JSON server on stdio: commands arrive on stdin, and stdout carries a `ready` frame, per-command responses, and session events. This is the mode for long-lived drivers — IDE integrations, bots, and multi-step orchestration.

```bash
omp --mode rpc
```

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

Commands include `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `set_model`, `set_todos`, `bash` / `abort_bash`, `switch_session`, `branch`, `get_messages`, and `login`; every response carries the request `id`, so concurrent commands are correlated by `id`, not by emission order. `prompt` is acknowledged as soon as it is accepted — completion shows up as `agent_end` (or `data.agentInvoked: false` for local-only prompts). `bash` runs concurrently while the server keeps reading commands, so `abort_bash` works mid-command.

RPC mode is optimized for hosts: automatic title generation is disabled to avoid an extra model call, `@file` arguments are rejected, and workflow-altering settings (`todo.*`, `task.*`, memory, advisor, async, bash auto-background) reset to built-in defaults instead of inheriting user overrides. When stdin closes, pending host-tool and host-URI requests are rejected and the process exits with code `0`.

### rpc-ui

`--mode rpc-ui` is the RPC protocol with extension UI enabled: extension `confirm` / `select` / `input` requests arrive as `extension_ui_request` frames that a host-provided UI can render. Use it when your host has a UI surface (for example an IDE panel); headless hosts that cannot render UI should use plain `--mode rpc` or the Python client's `install_headless_ui()` policy.

## Long-running sessions

Sessions are stored as JSONL transcripts on disk and can be resumed across processes.

- `-r, --resume [session]` — resume a session by ID prefix, filename prefix, or path (interactive picker if omitted); `--session [session]` is the alternate spelling.
- `-c, --continue` — continue the previous session in the current directory.
- `--session-dir <dir>` — directory for session storage and lookup; point this at a fixed location to keep transcripts for a bot or worker out of the working tree.
- `--no-session` — ephemeral: nothing is saved and there is nothing to resume.

One-shot runs compose with resume, which is how scripted follow-ups keep context:

```bash
omp -r 4f2a -p 'Continue with the remaining TODO items' --max-time 5m
```

A resumed session carries the previous conversation into the new process. In RPC mode the session file is reported in `get_state` (`sessionFile`, `sessionId`), so a driver can persist the handle and `switch_session` or spawn a new `omp --mode rpc` with `-r <id>` later.

## Embedding in your own process

### TypeScript SDK

The SDK runs omp inside your Bun or Node process. `createAgentSession` discovers auth, settings, skills, extensions, and tools when they are not supplied; a minimal session needs no arguments:

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

const unsubscribe = session.subscribe((event) => {
  if (event.type === "agent_end") console.log("turn finished");
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

`SessionManager.create(cwd)` is file-backed (resume works across processes); `SessionManager.inMemory()` keeps everything in memory for tests and ephemeral workers. Long-running sessions hold MCP and LSP processes open — always call `session.dispose()` before tearing down your host.

### Python client

`omp-rpc` wraps the RPC transport as a process-backed client with typed commands, request correlation, protocol v2 negotiation, and message pagination:

```python
from omp_rpc import RpcClient

with RpcClient(model="anthropic/claude-sonnet-4-5", no_session=True) as client:
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

Common startup flags are exposed as typed options (`thinking=`, `no_session=`, `no_skills=`, `no_rules=`, `tools=(...)`, `append_system_prompt=...`), and hosts can register their own tools and URI schemes with `host_tool(...)` / `host_uri(...)`. For non-interactive scripts, `client.install_headless_ui()` answers extension `confirm` requests with `False` and cancels `select`/`input`/`editor` requests instead of prompting.

### Worked example: robomp

`python/robomp/` is a self-hosted GitHub triage bot built entirely on `omp --mode rpc`. The flow shows the full automation pattern:

1. A GitHub `issues.opened` webhook is HMAC-verified and queued in SQLite (deduplicated on `X-GitHub-Delivery`).
2. A worker claims the event, checks out a per-issue git worktree, and spawns `omp --mode rpc` with `cwd=worktree` and a persistent `session_dir`.
3. The agent classifies the issue through host tools — the exclusive surface for GitHub writes (`classify_issue`, `gh_post_comment`, `gh_push_branch`, `gh_open_pr`). Bugs and documentation issues are reproduced, fixed on a fresh branch, and opened as a PR whose body carries `## Repro` / `## Cause` / `## Fix` / `## Verification` and `Fixes #N`; questions and proposals get comments instead.
4. Follow-up comments and PR reviews resume the same omp session (`--continue` against the persisted JSONL transcript), and crash recovery re-queues in-flight events the same way.

GitHub credentials stay out of the agent's reach: writes go through a sidecar that holds the token, and the agent subprocess environment is scrubbed of secrets. The bot model, allowlist, and timeouts are all configuration, not code.

## Automation triggers

Hooks run custom logic on agent lifecycle events and are loaded with `--hook <file>` (an alias for `--extension`), so a CI pipeline can install the same hook file on every run:

```bash
omp -p 'Fix the failing tests' --hook .omp/hooks/notify-ci.ts
```

A hook module default-exports a factory that registers `pi.on(event, handler)`:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("agent_end", async () => {
    await fetch(process.env.STATUS_URL!, {
      method: "POST",
      body: JSON.stringify({ status: "finished" }),
    });
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && String(event.input.command ?? "").includes("rm -rf")) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

Useful events for automation are `session_start` / `session_shutdown` (run boundaries), `agent_start` / `agent_end` (turn completion), `turn_start` / `turn_end`, `todo_reminder`, and the `tool_call` / `tool_result` interceptors for policy and audit logging. Note that `ctx.hasUI` is `false` in headless, print, and subagent mode — guard any interactive `ctx.ui` call behind it, since `confirm` returns `false` and `select` / `input` return `undefined` without a UI.

## CI-friendly flags

| Flag | Effect in CI |
| --- | --- |
| `--yolo` / `--auto-approve` | Auto-approve all tool calls; no approval prompts to hang on |
| `--approval-mode write` | Auto-approve `read` and `write` tier tools; still prompt for `exec` tier |
| `--max-time 10m` | Hard stop for runaway sessions (formats: `600`, `10m`, `1h`) |
| `--config ci.yml` | Load an extra config overlay for this run only (repeatable); keep CI-specific settings out of the user config |
| `--cwd <dir>` | Pin the working directory |
| `--no-session` | Ephemeral runs that leave no transcripts |
| `--session-dir <dir>` | Keep transcripts in a known location for debugging |
| `--no-title` | Skip title generation (one less model call per run) |
| `--no-lsp`, `--no-skills`, `--no-rules`, `--no-extensions` | Narrow the run to what CI needs |

Approval behavior is governed by `tools.approvalMode`; see [Approvals](/oh-my-pi/configuration/approvals/) for how the modes interact with `--approval-mode` and per-tool settings.
