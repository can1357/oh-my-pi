# omp-rpc

Typed Python bindings for the `omp --mode rpc` protocol used by the coding agent.

This package wraps the newline-delimited JSON RPC transport exposed by the CLI and
provides:

- typed command methods for the stable RPC surface
- typed startup options for common `omp --mode rpc` flags such as thinking level,
  tool selection, prompt appends, provider session IDs, and headless session toggles
- typed protocol models for state, bash results, compaction, and session stats
- automatic protocol v2 negotiation, lossless chunk reassembly, and stable message pagination
- a process-backed client that manages request correlation over stdio
- typed per-event listeners plus a typed catch-all notification hook
- helpers for collecting prompt runs (correlated by each prompt's `prompt_result`)
  and handling extension UI requests in manual or headless mode
- session binding (`open_session`) and server-side event filtering (`set_event_filter`)
- goal mode, session history/tree reads, slash-command discovery, subagent
  observation and control, live voice, OAuth login, handoff, and composer word prediction
- typed host-tool helpers so Python RPC owners can expose custom tools with JSON Schema metadata

## Generated from the wire schema

Protocol types, their decoders, every command method, and every `on_<frame type>`
listener live in `omp_rpc/_wire.py`, generated from the RPC wire schema in
`packages/coding-agent/src/modes/rpc/wire` (also emitted as the language-neutral
`rpc-wire.schema.json`). After changing the schema, regenerate from the repo root:

```bash
bun run gen:rpc
```

`packages/coding-agent/test/rpc-wire` fails when the committed outputs are stale or
when the schema drifts from the server's own types. Decoding follows the schema:

- records are frozen, keyword-only dataclasses with snake_case fields; required
  fields are validated, unknown keys are dropped, and fields older servers omit
  take their documented defaults
- messages, content blocks, usage, and assistant streaming events are open
  records (`TypedDict`s): only the `role`/`type` discriminator is checked and every
  key is kept, so persisted messages missing newer fields still decode
- a frame whose `type` this client does not model arrives as `UnknownNotification`

Hand-written code covers what the schema cannot express: process lifecycle,
prompt correlation (`prompt`, `prompt_and_wait`, `wait_for_settled`), message
paging, todo seeding, extension UI replies, and host tool/URI dispatch.

## Basic Usage

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

The wrapper also exposes the common RPC startup flags directly, so scripts do not
need to build `extra_args` by hand:

```python
from omp_rpc import RpcClient

with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6",
    thinking="high",
    no_session=True,
    no_skills=True,
    no_rules=True,
    tools=("read", "edit", "write"),
    append_system_prompt="Focus on reproducible benchmark behavior.",
    no_ui=True,
) as client:
    print(client.get_state().thinking_level)
```

`no_ui=True` passes `--no-ui`: extensions run headless and never send dialog
`extension_ui_request` frames to the host.

For orchestration hosts, the wrapper also exposes typed event hooks and a simple
way to seed todos before the first prompt:

```python
from omp_rpc import MessageUpdateEvent, RpcClient

def on_message_update(event: MessageUpdateEvent) -> None:
    assistant_event = event.assistant_message_event
    if assistant_event.get("type") == "text_delta":
        print(assistant_event["delta"], end="", flush=True)

with RpcClient(model="openrouter/anthropic/claude-sonnet-4.6", no_session=True) as client:
    client.on_message_update(on_message_update)
    client.set_todos(
        [
            "Map the read and edit tool surface.",
            "Exercise the supported edit paths.",
            "Write concrete findings and gaps.",
        ]
    )
    client.prompt_and_wait("Evaluate the current tool behavior.")
```

`set_todos()` accepts either a flat list of todo strings/items or explicit
phases, and `get_state().todo_phases` returns the typed current todo state.

By default the client runs:

```bash
omp --mode rpc
```

You can also point it at a custom command, which is useful inside this repo while
developing against the Bun entrypoint:

```python
from omp_rpc import RpcClient

with RpcClient(
    command=[
        "bun",
        "packages/coding-agent/src/cli.ts",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
    ],
) as client:
    print(client.get_state().session_id)
```

## Prompt Results

Every accepted `prompt` / `abort_and_prompt` ends with exactly one
`prompt_result` frame carrying the prompt's request id, emitted when the agent
yields after the prompt. `prompt()` and `abort_and_prompt()` return that
request id, and `on_prompt_result()` delivers each typed `PromptResultEvent`:

```python
from omp_rpc import PromptResultEvent, RpcClient

def on_result(result: PromptResultEvent) -> None:
    if result.status == "error" and result.error is not None:
        print(result.id, result.error.message, result.error.http_status, result.error.retryable)

with RpcClient(no_session=True) as client:
    client.on_prompt_result(on_result)
    request_id = client.prompt("Summarize the repo")
    client.wait_for_idle()
```

`prompt_and_wait()` waits for its own `prompt_result` rather than the first
terminal `agent_end`, so a late `agent_end` from an earlier run cannot end it
early. The returned `PromptTurn.result` holds that `PromptResultEvent`
(`status` is `"completed"`, `"aborted"`, or `"error"`); it is `None` when the
server handled the prompt locally (e.g. a slash command) and answered with
`agentInvoked: false`. `wait_for_idle()` returns once every prompt this client
submitted has received its `prompt_result`.

### Yielded vs. settled

A yield is not the end of the session: async bash/task/eval jobs or queued
messages can wake it for follow-up runs. `PromptResultEvent.session_settled` is
`True` when nothing will wake the session again. When it is `False`, the server
sends a `session_settled` frame once that background work has drained, after
any follow-up runs it triggers. `get_state()` reports the same condition as
`is_settled`, plus `has_pending_async_work`.

`prompt_and_wait()` returns at the agent's yield. `wait_for_settled()` waits
until the session is done: it returns at once when `get_state().is_settled`,
otherwise it blocks until the next `session_settled` frame.
`on_session_settled()` subscribes to those frames.

```python
turn = client.prompt_and_wait("Kick off the long build in the background")
if turn.result is not None and not turn.result.session_settled:
    client.wait_for_settled(timeout=600)
```

Each `AgentEndEvent` also reports `yielded`: `True` when the agent finished its
turn (it resumes only for queued input or background-job results), `False`
while it continues its own work (retry, compaction, stop-time reminders).
Older servers omit it (`None`); fall back to `is_terminal is not False`.
`awaiting_async_work` is `True` on a non-terminal end whose only possible resume
is a background-job result, which a cancelled job never delivers.

`message_start`, `message_update`, and `message_end` events expose
`message_id`, shared across one message's lifecycle and unique per process.

## Session Binding and Event Filtering

A pre-spawned process can bind to a host-keyed conversation directory, and a
host that only needs a few event kinds can have the server drop the rest:

```python
with RpcClient() as client:
    opened = client.open_session("/var/lib/bot/sessions/thread-42")
    print(opened.resumed, opened.session_id, opened.session_file)

    client.set_event_filter(["message_end", "tool_execution_end"])
    turn = client.prompt_and_wait("Continue where we left off")
    client.set_event_filter(None)  # forward every session event again
```

`open_session()` continues the newest non-empty session in the directory or
starts a fresh one there (`resumed=False`). The event filter applies only to
session events; responses, `prompt_result`, and UI/host frames always arrive,
so `prompt_and_wait()` still completes when `agent_end` is filtered out.

## Removing Queued Messages

`remove_queued_message(message, queue)` removes one matching prompt from the
`"steering"` or `"followUp"` queue. `QueuedMessageQueue` and
`RemoveQueuedMessageResult` are exported for typed callers:

```python
from omp_rpc import QueuedMessageQueue, RpcClient

with RpcClient() as client:
    client.follow_up("Review the diff")
    queue: QueuedMessageQueue = "followUp"
    result = client.remove_queued_message("Review the diff", queue)
    print(result.removed)
```

Check `result.removed`, not the truthiness of the result object. `True` means the
server removed the queued prompt; `False` means it did not, for example because
the prompt was already claimed or no longer queued. This does not abort a running
prompt. Native rejection, including an older server that does not support the
command, raises `RpcCommandError`. Missing or non-boolean `removed` values raise
`ValueError` rather than being treated as successful cancellation.

`promote_queued_message(message)` moves one matching follow-up, with its hidden
attachment context, to the end of the steering queue without resending it.
Check `result.promoted` on the returned `PromoteQueuedMessageResult`; `False`
means no matching follow-up was still queued. Never fall back to `steer()`,
which would enqueue a duplicate. Unsupported servers raise `RpcCommandError`,
and missing or non-boolean `promoted` values raise `ValueError`.

## Goal Mode

`goal(op, ...)` drives the same goal lifecycle as the interactive `/goal`
command. Every op returns a `GoalResult` (`goal` and `state` are `None` when the
session has no goal), `get_state().goal` carries the current `GoalModeState`, and
`on_goal_updated()` reports every change, including ones made by the agent's
`goal` tool:

```python
result = client.goal("create", objective="Ship the parser rewrite", token_budget=200_000)
print(result.goal.status if result.goal else None)  # "active"
client.goal("pause")
client.goal("resume")
client.goal("drop")
```

Goal turns continue on their own only when the server's `goal.continuationModes`
setting contains `"rpc"`. Refusals (plan mode, an existing goal, `goal.enabled`
off) raise `RpcCommandError`.

## History, Commands, and Thinking Levels

- `get_entries(since=None)` returns `SessionEntries`: OMP-native `SessionEntry`
  objects (raw dicts) in append order plus `leaf_id`. With `since`, only entries
  strictly after that entry id; an unknown id raises `RpcCommandError` with
  `code == "unknown_since"`.
- `get_tree()` returns the raw session tree as `SessionTree`.
- `get_available_commands()` returns typed `AvailableSlashCommand`s;
  `on_available_commands_update()` receives the same catalog at startup and
  whenever it changes.
- `get_available_thinking_levels()` returns the live model's selectable levels,
  `"off"` first.

## Subagents

Subagent frames are off by default. Select a level, then subscribe:

```python
client.set_subagent_subscription("progress")  # or "events" for full session events
client.on_subagent_lifecycle(lambda e: print(e.payload.id, e.payload.status))
client.on_subagent_progress(lambda e: print(e.payload.agent, e.payload.progress.get("toolCount")))

for snapshot in client.get_subagents():
    page = client.get_subagent_messages(subagent_id=snapshot.id)
    more = client.get_subagent_messages(subagent_id=snapshot.id, from_byte=page.next_byte)

client.steer_subagent("OmpWorker", "Drop the glob, keep the direct path.")
cancelled = client.cancel_subagent("OmpWorker")  # False when not running
```

At `"events"`, `on_subagent_event()` delivers each subagent's own session
events as `SubagentEvent.payload.event` (an `UnknownNotification` when it cannot
be parsed).

## Live Voice, Login, Handoff, and Word Prediction

- `live_start(voice=None, instructions=None)` starts a GPT live voice session
  bound to this session and returns the voice in use; `live_mute(muted=None)`
  sets or toggles the microphone; `live_stop()` ends it. `on_live_phase()`,
  `on_live_levels()`, `on_live_transcript()`, and `on_live_end()` receive the
  live frames.
- `get_login_providers()` lists OAuth providers; `login(provider_id)` blocks
  (up to 10 minutes) until credentials are stored. The flow arrives as UI
  requests: an `open_url` request (prefer `launch_url` as the copy target) and,
  for pasted-code providers, an `input` request answered with `send_ui_value()`.
- `handoff(custom_instructions=None)` returns a `HandoffResult`, or `None` when
  no handoff was produced.
- `predict_word(text, cursor)` returns ghost text for a host-rendered composer
  (`cursor` is a UTF-16 offset) or `None`; report shown suggestions with
  `predict_word_feedback(text, cursor, suggestion, accepted=...)`. It waits up to
  155 seconds regardless of `request_timeout`, since a cold prediction daemon can
  take that long; treat `RpcCommandError` as "no suggestion".

## Host-Owned Custom Tools

RPC hosts can expose custom tools to the agent with JSON Schema metadata. The
Python helper keeps the wire format simple while still giving the handler a
typed signature:

```python
from typing import TypedDict

from omp_rpc import RpcClient, host_tool


class EchoArgs(TypedDict):
    message: str


def echo_host(args: EchoArgs, context) -> str:
    context.send_update(f"working:{args['message']}")
    return f"host:{args['message']}"


with RpcClient(
    no_session=True,
    custom_tools=(
        host_tool(
            name="echo_host",
            description="Echo a value from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
        ),
    ),
) as client:
    client.prompt_and_wait("Use the echo_host tool with the value hello")
```

If you want runtime conversion into a richer Python type, pass `decode=` to
`host_tool(...)`. That lets you keep the JSON Schema contract on the wire while
parsing the incoming argument object into a dataclass or model in the handler.

`tool_execution_update`/`tool_execution_end` events for a top-level or
`xd://` device dispatch carry the host tool's name, but a call made through the
eval bridge only surfaces as the enclosing `eval` call. To observe which host
tools actually ran regardless of dispatch path, subscribe with
`client.on_host_tool_completed(...)`; it receives a
`HostToolCompletedEvent(tool_name, tool_call_id)` after `execute()` returns
without raising.

`host_tool(...)` also accepts `hidden=True` (register without enabling),
`load_mode="essential" | "discoverable"` (how an enabled tool is presented;
non-builtin names default to `"discoverable"`), and `reads_skill_uris=True` for
tools that can read `skill://` content.

## Host-Owned URI Schemes

Hosts can also expose custom URL schemes that behave like virtual files.
Registered schemes are routed through the agent's `read` (and `write`) tools
over the same RPC transport — handlers do the actual I/O on the Python side:

```python
from omp_rpc import RpcClient, host_uri

rows: dict[str, str] = {"42": "id=42\nname=Alice\n"}


def read_row(url: str, _ctx) -> str:
	row_id = url.removeprefix("db://users/")
	return rows[row_id]


def write_row(url: str, content: str, _ctx) -> None:
	row_id = url.removeprefix("db://users/")
	rows[row_id] = content


with RpcClient(
	no_session=True,
	host_uris=(
		host_uri(
			scheme="db",
			description="Virtual db row files",
			read=read_row,
			write=write_row,
		),
	),
) as client:
	client.prompt_and_wait("Read db://users/42 and rewrite it with name=Bob")
```

Schemes registered as read-only (no `write=`) reject `write` calls with a
clear error. The agent's `edit` tool does not target host URIs — hosts that
want mutation expose `write` and the model uses the `write` tool with the
full replacement content.

## Extension UI Requests

Extensions in RPC mode can ask the host for input. Those requests are available as
typed `ExtensionUiRequest` instances:

```python
request = client.next_ui_request(timeout=5.0)

if request.method == "confirm":
    client.send_ui_confirmation(request.id, True)
elif request.method == "select":
    # option_details aligns positionally with options when descriptions are present.
    for index, label in enumerate(request.options or ()):
        detail = request.option_details[index] if request.option_details else {}
        print(label, detail.get("description"))
    client.send_ui_value(request.id, "approved")
elif request.method in {"input", "editor"}:
    client.send_ui_value(request.id, "approved")
```

After `client.set_ask_dialog(True)`, the agent's `ask` tool sends one `ask`
request carrying every question (`request.questions`) instead of one `select`
per question. Answer with one `AskAnswer` per question, in order; hosts always
offer free text, sent as `custom_input`:

```python
from omp_rpc import AskAnswer

if request.method == "ask":
    client.send_ui_answers(
        request.id,
        [AskAnswer(id=question.id, selected_options=(question.options[0].label,))
         for question in request.questions or ()],
    )
```

Servers without the command raise `RpcCommandError` from `set_ask_dialog`, so
keep handling `select` as the fallback.

For non-interactive scripts, you can install a default headless policy instead of
handling every request manually:

```python
with RpcClient(model="anthropic/claude-sonnet-4-5") as client:
    client.install_headless_ui()
    turn = client.prompt_and_wait("needs ui-safe automation")
    print(turn.assistant_text)
```

That helper ignores passive UI notifications (`notify`, `setStatus`, `setWidget`,
`setTitle`, `set_editor_text`), answers `confirm` with `False`, cancels
`select`/`input`/`editor` requests unless you provide explicit values, and
cancels `ask` requests.

To keep extensions from issuing dialogs at all, start the client with
`no_ui=True` (`--no-ui`).

## Error Handling and Retained History

The client now surfaces more of the transport edge cases that the wire protocol
allows:

- id-less `parse` and unknown-command failures are correlated back to the
  waiting request when they can be matched unambiguously
- late `prompt` / `abort_and_prompt` scheduling failures cause
  `prompt_and_wait()` and `wait_for_idle()` to raise instead of timing out
- unmatched background error responses are exposed through
  `client.protocol_errors` and `client.on_protocol_error(...)`
- listener exceptions no longer kill the stdout reader thread; they are exposed
  through `client.listener_errors` and `client.on_listener_error(...)`

For long-lived hosts, retained event and stderr history is bounded by default:

```python
from omp_rpc import RpcClient

with RpcClient(max_event_history=20_000, max_stderr_chunks=256) as client:
    ...
```

If a single prompt streams more events than `max_event_history` allows,
`prompt_and_wait()` raises a clear error so hosts can increase the limit instead
of silently losing earlier events.

Prompt lifecycle collection is intentionally single-flight. Only one of
`prompt_and_wait()`, `wait_for_idle()`, or `collect_events()` may be active at a
time on a client instance. If a host needs concurrent orchestration, use
separate `RpcClient` instances instead of overlapping lifecycle waiters on one
session.

## Text Helpers

`assistant_text()` and `message_text()` now return visible text blocks only.
If a host explicitly needs reasoning text too, use the `*_with_thinking`
helpers:

```python
from omp_rpc import assistant_text, assistant_text_with_thinking

visible = assistant_text(message)
full = assistant_text_with_thinking(message)
```

## Protocol Reference

The canonical wire protocol still lives in the repo at
[`docs/rpc.md`](../../../docs/rpc.md).
