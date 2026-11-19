# omp-rpc (Go)

Go client for the omp RPC protocol (`omp --mode rpc`, JSON lines over stdio).
Module `github.com/can1357/oh-my-pi/sdk/go/omp-rpc`, package `omprpc`, standard library only.

## Layout

- `wire.go` — **generated**: every frame and shared type, JSON codecs, `<Name>Command`
  parameter structs, and one typed method per command on `Commands`. Do not edit.
- `runtime.go` — codec helpers, `Transport`, `Commands`, `UnknownNotification`, `Ptr`.
- `client.go` — `Client`: correlation, protocol v2 negotiation, frame delivery.
- `frame.go` — `rpc_chunk` reassembly. `prompt.go` — `PromptAndWait`, `GetMessages` paging.
  `hosttools.go` — host tools. `hosturis.go` — host URI schemes.

Regenerate `wire.go` from the repository root after changing the wire schema
(`packages/coding-agent/src/modes/rpc/wire`):

```sh
bun run gen:rpc
```

## Binding

- Enums are string types with constants (`GoalStatusBudgetLimited`); decoding an unknown value fails.
- Closed objects decode strictly: required keys must be present, defaulted keys take their
  schema default, unknown keys are ignored. Optional fields are pointers (or nil slices/maps).
- Open records (messages, content blocks, usage, streaming events) validate only their
  discriminator: a declared field may be absent, and a value of the wrong shape leaves the field
  zero and stays in `Extra` with the undeclared keys. Encoding writes `Extra` back.
- `string | UserContent[]` message content is `MessageContent{String, Array}`, chosen by JSON kind.
- Unions are wrappers around a sealed interface: `RpcServerFrame{Value: …}`; switch on
  `frame.Value.(type)`. Discriminators (`type`, `role`, `method`) are not struct fields; encoding
  writes them. Session events are flattened into `RpcNotification`/`RpcServerFrame`;
  `ExtensionUiRequest` stays nested and is routed by `method`.
- An unrecognized frame `type` decodes to `UnknownNotification` with the raw frame. A known frame
  whose payload fails to decode is an error, which `Client` turns into `UnknownNotification` with `Err` set.
- Schema-marked leniencies: `subagent_event`'s payload event becomes `UnknownNotification` (raw +
  `Err`) instead of failing the frame, and `SessionState.SystemPrompt` accepts the bare string
  older servers sent.

## Usage

```go
echo := omprpc.HostTool{
	Definition: omprpc.HostToolDefinition{
		Name:        "echo_host",
		Description: "Echo a message back from the host.",
		Parameters: map[string]json.RawMessage{
			"type":       json.RawMessage(`"object"`),
			"properties": json.RawMessage(`{"message":{"type":"string"}}`),
		},
		LoadMode: omprpc.Ptr(omprpc.ToolLoadModeEssential),
	},
	Handler: func(ctx context.Context, call *omprpc.HostToolCall, args json.RawMessage) (omprpc.HostToolResultPayload, error) {
		var p struct{ Message string }
		if err := json.Unmarshal(args, &p); err != nil {
			return omprpc.HostToolResultPayload{}, err
		}
		_ = call.SendUpdate(omprpc.TextResult("working"))
		return omprpc.TextResult("host:" + p.Message), nil
	},
}

cmd := exec.Command("omp", "--mode", "rpc", "--no-session")
cmd.Stderr = os.Stderr
client, err := omprpc.Start(ctx, cmd, omprpc.WithHostTools(echo))
if err != nil {
	return err
}
defer client.Close()

go func() {
	for frame := range client.Frames() {
		switch v := frame.Value.(type) {
		case omprpc.MessageUpdateEvent:
			// stream output
		case omprpc.ExtensionUiRequest:
			if confirm, ok := v.Value.(omprpc.ConfirmUiRequest); ok {
				_ = client.Send(omprpc.ConfirmUiResponse{ID: confirm.ID, Confirmed: true})
			}
		case omprpc.UnknownNotification:
			// newer server, or a payload that failed to decode (v.Err)
		}
	}
}()

turn, err := client.PromptAndWait(ctx, omprpc.PromptCommand{Message: "say hi"}, time.Minute)
fmt.Println(*turn.AssistantText, turn.Result.Status)
messages, err := client.GetMessages(ctx)
```

`Start` runs a process; `NewClient(ctx, stdout, stdin, options...)` connects over any reader and
writer. Failed commands return `*omprpc.CommandError` (`Command`, `Message`, `Code`). `Frames()`
delivers every frame the client does not consume (host tool and host URI requests are answered
internally) and must be drained; it closes when the
connection ends, and `Err()` then says why (`ErrClosed`, plus `ErrProtocol` for a transport violation).
After that, calls and `Send` fail with `Err()`; `Close` is still required. A call's context bounds the
wait for its response, not the write itself: only `Close` releases a write to a server that stopped
reading.

`Start` leaves `cmd.Stdin`/`cmd.Stdout` to the client (keep them nil) and, on Unix, runs the server in
its own process group (merged into `cmd.SysProcAttr`). `Close` then mirrors the Python client: it
cancels host work, closes stdin, sends SIGTERM to the group, waits up to a second for the server,
sends SIGKILL to the group, and returns an error only if a process survives; it is bounded (a few
seconds at most). Elsewhere it kills the server process. Commands the server moved to another process
group (as its bash tool does for external commands) are out of reach.

### Protocol v2

When the ready frame advertises v2 with the standard limits (1 MiB frames, 64 MiB reassembled),
the client negotiates v2 before `Start`/`NewClient` returns (`ProtocolVersion()` reports it) and
reassembles `rpc_chunk` sequences, validating them strictly; an invalid sequence closes the
connection. Otherwise it stays on v1, where oversized frames arrive truncated or as errors.

### Prompts

`Prompt` returns the acknowledgement only. `PromptAndWait(ctx, p, timeout)` submits a prompt and
waits for its own `prompt_result` (60 s by default): the turn holds the session events received
meanwhile, the final messages (a compacted `agent_end` is completed from streamed `message_end`
events), the assistant message and its text, and the result (`nil` when the server handled the
prompt locally). A late failure response for the prompt fails the wait with `*CommandError`.
Concurrent waits are allowed; each waits for its own request id and collects every session event
received while it waits. Session events still reach `Frames()`.

### Host tools

Register tools with `WithHostTools` (sent once connected) or `SetCustomTools`. The client answers
`host_tool_call` itself: handlers run on their own goroutine with a context canceled by
`host_tool_cancel` or `Close`, may stream `SendUpdate`s, and return a result or an error
(`isError`). Unknown tools and non-object arguments get error results. Host tool frames are not
delivered on `Frames()`; `tool_execution_update`/`tool_execution_end` events of a host call carry
the host tool's name even when the agent ran it through `write` (an `xd://` device).

### Host URIs

Register schemes with `WithHostUris` (sent after host tools) or `SetHostUris`; a `HostUri` has a
`Scheme` (trimmed and lowercased, must not be empty), `Description`, `Immutable`, a required `Read`
and an optional `Write` (without it the scheme is read-only). The client answers `host_uri_request`
itself: handlers run on their own goroutine with a context canceled by `host_uri_cancel` or `Close`;
a read returns `HostUriReadResult{Content, ContentType, Notes, Immutable}`, a write gets the
frame's content. Unknown schemes, writes without a handler, unsupported operations, and handler
errors become `isError` results. Host URI frames are not delivered on `Frames()`.

```go
notes := omprpc.HostUri{
	Scheme: "notes",
	Read: func(ctx context.Context, url string) (omprpc.HostUriReadResult, error) {
		return omprpc.HostUriReadResult{Content: "note body"}, nil
	},
	Write: func(ctx context.Context, url, content string) error { return save(url, content) },
}
client, err := omprpc.Start(ctx, cmd, omprpc.WithHostUris(notes))
```

### Messages

`GetMessages` pages with `get_messages_page` (256 per page) under v2, checking that totals and
cursors stay consistent, and falls back to the monolithic `get_messages` when the session changes
mid-way (`session_busy`, `stale_cursor`); under v1 it sends `get_messages`.
`Commands.GetMessages` is always the monolithic command.

## Tests

```sh
go test -race ./...
OMP_RPC_SMOKE=1 go test -run TestSmoke -v ./...   # real servers via bun, from this checkout
```

`TestSmokeModel` drives full prompt turns against the scripted model in
`packages/coding-agent/test/rpc-wire/fake-openai-server.ts`.
