# omp-rpc (Rust)

Rust client for the omp RPC protocol: JSON lines over the stdio of `omp --mode rpc`.

- `src/wire.rs` is **generated** from the wire schema (`packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json`). It contains serde types for every frame and the `RpcNotification`, `RpcServerFrame`, and `RpcInbound` unions; a frame of an unrecognized type decodes to `Unknown(Value)`. Each command gets a `<Name>Command` struct that implements `Command`. Do not edit the file by hand; regenerate it from the repository root with `bun run gen:rpc`.
- `src/client.rs` is a blocking transport over any reader/writer pair (`Client::spawn` for a process, `Client::from_io` for pipes). It can:
  - run commands with `call`
  - wait for a prompt with `prompt_and_wait`
  - fetch the whole transcript with `get_messages`
  - run host tools
  - serve host URI schemes
  - write extension UI responses with `send`
  - shut down with `close` (or by dropping the client)

  Every other frame reaches you through the event receiver as an `Event`.

```rust
use std::process::Command as Process;
use omp_rpc::*;

let mut process = Process::new("omp");
process.args(["--mode", "rpc", "--no-session"]);
let (client, events) = Client::spawn(process, ClientOptions::default())?; // waits for `ready`, negotiates v2
let state = client.call(&GetStateCommand {})?;
let turn = client.prompt_and_wait(
    &PromptCommand { message: "say hi".into(), images: None, streaming_behavior: None },
    DEFAULT_PROMPT_TIMEOUT,
)?;
println!("{:?} {:?}", turn.assistant_text, turn.result.map(|result| result.status));
for event in events.try_iter() {
    println!("{event:?}");
}
```

## Protocol v2

The ready frame may advertise protocol v2 with the standard limits: 1 MiB frames and 64 MiB after reassembly. In that case the client sends `negotiate_protocol` before `spawn`/`from_io` returns, and `protocol_version()` reports the version in use.

On v2, the server splits large frames into `rpc_chunk` sequences, and the client reassembles and validates them. A transport violation is fatal: invalid JSON, a malformed or interleaved chunk sequence, or a chunk received before negotiation. The reader stops, and pending and future calls fail with `Error::Protocol`.

## Writing, closing, and teardown

A writer thread owns the server's stdin. `call` queues its frame and then waits for the response, so the deadline covers the write too: a server that stops reading cannot block a caller past its timeout. `send` returns once its frame is queued.

The client closes on any of these: a fatal transport error, the server closing stdout, a failed write, `close()`, or drop. After that:
- pending and later calls and sends fail with the closing error
- no further server frame is dispatched
- queued frames are discarded
- the server sees EOF on stdin

`Client::spawn` starts the server as the leader of its own process group (on Unix). `close()` and drop then tear the whole group down:
1. cancel host tool and URI work
2. close stdin
3. send SIGTERM to the group
4. if the leader is still running after one second, send SIGKILL to the group and reap the leader

`close()` returns an error when it cannot confirm that the leader was reaped and the group is empty. Off Unix only the leader is killed. `pid()` returns the server's pid, which is also the process group id.

The bash tool runs each command in its own process group, so jobs that command leaves running in the background are outside the server's group and survive teardown.

With `from_io`, the reader thread cannot be interrupted. It stops dispatching once the client closes and exits when the peer closes its output.

## Prompt wait

`prompt_and_wait` registers a collector before it sends the prompt. It then waits for the `prompt_result` carrying its own request id. A stale `agent_end` or another prompt's result does not end the wait.

It returns a `PromptTurn` with these fields:
- `events`: the session events received during the wait.
- `messages`: the messages of the final `agent_end`. When the server compacted that frame, the leading messages are restored from the streamed `message_end` events.
- `assistant_message` and `assistant_text`: the last assistant message and its visible text.
- `result`: the `prompt_result`, or `None` when the server answered `agentInvoked: false`.

Waits end with these errors:
- `Error::Command`: the server sent an error response for the prompt after acknowledging it.
- `Error::Closed`: the process exited.
- `Error::Timeout`: the deadline passed.

Each wait has its own collector, so several threads may wait concurrently. Session events still reach the event receiver.

## Host tools

Build each tool with `HostTool::new(name, description, parameters_schema, handler)`. The builder methods `.label()`, `.hidden()`, `.load_mode()`, and `.reads_skill_uris()` are optional. Register tools by passing them in `ClientOptions::tools`, which sends them right after negotiation, or with `set_custom_tools`. Concurrent `set_custom_tools` / `set_host_uris` calls are serialized, so the tools the client dispatches to are always the ones last registered with the server.

The client answers `host_tool_call` frames itself and never delivers host tool frames as events. Each handler runs on its own thread and receives the arguments object and a `HostToolContext`. The context offers `tool_call_id()`, `is_cancelled()`, and `send_update()`.

A handler returns text or a `HostToolResultPayload`. If it returns an error or panics, the result is sent with `isError: true`. Once the server sends `host_tool_cancel`, nothing more is sent for that call: the writer checks the call's cancellation right before it writes each update or result, so even a reply already in the queue is dropped. Closing the client cancels every running call.

Host tools may be mounted as `xd://` devices and invoked through `write`. The `tool_execution_update` and `tool_execution_end` events of those calls are renamed to the host tool's name.

## Host URIs

Build each scheme with `HostUri::new(scheme, read_handler)`. The scheme is trimmed and lowercased; an empty scheme returns `Error::InvalidArgument`. The builder methods `.write(handler)`, `.description()`, and `.immutable()` are optional; a scheme with a write handler is registered as writable. Register schemes by passing them in `ClientOptions::uris`, which sends them right after the host tools, or with `set_host_uris`.

The client answers `host_uri_request` frames itself and never delivers host URI frames as events. The scheme is the part of the URL before the first `:`, lowercased. Each handler runs on its own thread and receives a `HostUriContext`, which offers `url()`, `operation()`, and `is_cancelled()`.

- A read handler returns a `HostUriRead` (`content`, plus optional `content_type`, `notes`, and `immutable`). A plain string converts to `HostUriRead` as well.
- A write handler receives the URL and the new content; it gets an empty string when the frame carries no content.

These requests are answered with `isError: true`:
- an unknown scheme
- a `write` to a scheme without a write handler
- an operation other than `read` or `write`
- a handler that returns an error or panics

Once the server sends `host_uri_cancel`, nothing is sent for that request, even if its reply is already queued. Closing the client cancels every running request.

## Messages

`get_messages()` on v2 reads `get_messages_page` 256 messages at a time. If the session changes mid-way (`session_busy` / `stale_cursor`), it falls back to the single `get_messages` command, which it also uses on v1.

## Tests

`cargo test` runs the wire tests and the transport tests, which use a scripted server on in-memory pipes.

`cargo test -- --ignored --nocapture` also runs two smoke tests against the repository's server (`bun packages/coding-agent/src/cli.ts --mode rpc`). The first never calls a model. The second uses the scripted model in `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`.
