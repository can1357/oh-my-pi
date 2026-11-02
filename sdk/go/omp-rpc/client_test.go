package omprpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKnownFrameWithBadPayloadDegradesToUnknown(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	line := `{"type":"goal_updated","goal":{"id":"g","objective":"o","status":"exploded","tokensUsed":1,"timeUsedSeconds":0,"createdAt":1,"updatedAt":2}}`
	s.send(line)
	unknown := nextFrame[UnknownNotification](t, c)
	if unknown.Type != "goal_updated" || unknown.Err == nil || string(unknown.Raw) != line {
		t.Fatalf("got %#v", unknown)
	}
	if c.Err() != nil {
		t.Fatalf("connection closed: %v", c.Err())
	}
}

func TestChunkReassembly(t *testing.T) {
	c, s := startFake(t, readyV2, negotiateV2)
	if c.ProtocolVersion() != 2 {
		t.Fatalf("protocol version %d", c.ProtocolVersion())
	}
	for _, size := range []int{maxFrameBytes, maxFrameBytes + maxFrameBytes/2} {
		s.send(chunkFrames(fmt.Sprintf("rpc-%d", size), commandOutput(size), chunkPayloadBytes)...)
		output := nextFrame[CommandOutputEvent](t, c)
		if want := size - len(`{"type":"command_output","text":""}`); len(output.Text) != want {
			t.Fatalf("size %d: text length %d, want %d", size, len(output.Text), want)
		}
	}
	// Chunks smaller than the maximum payload are valid too.
	s.send(chunkFrames("rpc-small", commandOutput(maxFrameBytes), 100_000)...)
	nextFrame[CommandOutputEvent](t, c)
	if c.Err() != nil {
		t.Fatalf("connection closed: %v", c.Err())
	}
}

func TestChunkRejections(t *testing.T) {
	valid := chunkFrames("rpc-1", commandOutput(maxFrameBytes), chunkPayloadBytes)
	other := chunkFrames("rpc-2", commandOutput(maxFrameBytes), chunkPayloadBytes)
	oversized := fmt.Sprintf(`{"type":"rpc_chunk","chunkId":"rpc-3","index":0,"count":4,"byteLength":1048576,"data":%q}`,
		base64.StdEncoding.EncodeToString(make([]byte, chunkPayloadBytes+1)))
	cases := []struct {
		name   string
		ready  string
		frames []string
	}{
		{"interrupted by a frame", readyV2, []string{valid[0], `{"type":"session_settled"}`}},
		{"interleaved sequences", readyV2, []string{valid[0], other[1]}},
		{"out of order", readyV2, []string{valid[0], valid[2]}},
		{"not starting at zero", readyV2, []string{valid[1]}},
		{"non-canonical base64", readyV2, []string{`{"type":"rpc_chunk","chunkId":"rpc-4","index":0,"count":4,"byteLength":1048576,"data":"QR=="}`}},
		{"oversized chunk", readyV2, []string{oversized}},
		{"float index", readyV2, []string{strings.Replace(valid[0], `"index":0`, `"index":0.0`, 1)}},
		{"short byteLength", readyV2, []string{strings.Replace(valid[0], `"byteLength":1048576`, `"byteLength":1048575`, 1)}},
		{"chunk before negotiation", readyV1, []string{valid[0]}},
		{"escaped discriminator before negotiation", readyV1, []string{strings.Replace(valid[0], `"rpc_chunk"`, `"rpc\u005fchunk"`, 1)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var handshake func(*fakeServer)
			if tc.ready == readyV2 {
				handshake = negotiateV2
			}
			c, s := startFake(t, tc.ready, handshake)
			s.send(tc.frames...)
			err := waitClosed(t, c)
			if !errors.Is(err, ErrProtocol) || !errors.Is(err, ErrClosed) {
				t.Fatalf("err = %v", err)
			}
			if _, err := c.GetState(context.Background()); !errors.Is(err, ErrProtocol) {
				t.Fatalf("call after a fatal error: %v", err)
			}
		})
	}
}

func TestNegotiationNeedsTheStandardLimits(t *testing.T) {
	for name, ready := range map[string]string{
		"v1 only":           readyV1,
		"other frame limit": strings.Replace(readyV2, "1048576", "2097152", 1),
		"other reassembly":  strings.Replace(readyV2, "67108864", "33554432", 1),
		"no v2":             strings.Replace(readyV2, "[1,2]", "[1]", 1),
	} {
		t.Run(name, func(t *testing.T) {
			c, s := startFake(t, ready, nil)
			if c.ProtocolVersion() != 1 {
				t.Fatalf("protocol version %d", c.ProtocolVersion())
			}
			go func() {
				command := s.recv()
				if command.str("type") != "get_session_stats" {
					t.Errorf("first command %s", command.raw)
				}
				s.fail(command, "", "not now")
			}()
			if _, err := c.GetSessionStats(context.Background()); err == nil {
				t.Fatal("expected the scripted failure")
			}
		})
	}

	s, r, w := newFakeServer(t)
	go func() {
		s.send(readyV2)
		s.respond(s.recv(), `{"protocolVersion":1}`)
	}()
	if _, err := NewClient(context.Background(), r, w); !errors.Is(err, ErrProtocol) {
		t.Fatalf("negotiation answered with v1: err = %v", err)
	}
}

const assistantHello = `{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"hel"},{"type":"text","text":"lo"}],"api":"a","provider":"p","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}`

type promptOutcome struct {
	turn PromptTurn
	err  error
}

// prompt starts PromptAndWait and returns the prompt command the server got.
func prompt(t *testing.T, c *Client, s *fakeServer, timeout time.Duration) (received, <-chan promptOutcome) {
	t.Helper()
	outcome := make(chan promptOutcome, 1)
	go func() {
		turn, err := c.PromptAndWait(context.Background(), PromptCommand{Message: "hi"}, timeout)
		outcome <- promptOutcome{turn, err}
	}()
	command := s.recv()
	if command.str("type") != "prompt" || command.str("message") != "hi" {
		t.Fatalf("prompt frame %s", command.raw)
	}
	return command, outcome
}

func await(t *testing.T, outcome <-chan promptOutcome) promptOutcome {
	t.Helper()
	select {
	case result := <-outcome:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("PromptAndWait did not return")
		return promptOutcome{}
	}
}

func TestPromptAndWaitWaitsForItsOwnResult(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	command, outcome := prompt(t, c, s, 0)
	id := command.str("id")
	s.send(
		`{"type":"agent_end","messages":[]}`,
		`{"type":"prompt_result","id":"someone-else","agentInvoked":true,"status":"completed","sessionSettled":true}`,
	)
	s.respond(command, `{"agentInvoked":true}`)
	s.send(
		`{"type":"agent_start"}`,
		`{"type":"message_end","message":`+assistantHello+`}`,
		`{"type":"agent_end","messages":[`+assistantHello+`]}`,
		`{"type":"prompt_result","id":"`+id+`","agentInvoked":true,"status":"completed","sessionSettled":true}`,
	)
	result := await(t, outcome)
	if result.err != nil {
		t.Fatal(result.err)
	}
	turn := result.turn
	if turn.Result == nil || *turn.Result.ID != id || turn.AssistantText == nil || *turn.AssistantText != "hello" {
		t.Fatalf("turn %#v", turn)
	}
	if len(turn.Events) != 4 || len(turn.Messages) != 1 {
		t.Fatalf("events %d messages %d", len(turn.Events), len(turn.Messages))
	}
	// Session events also reach Frames.
	nextFrame[AgentStartEvent](t, c)
}

func TestPromptAndWaitResultBeforeAck(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	command, outcome := prompt(t, c, s, 0)
	s.send(`{"type":"message_end","message":` + assistantHello + `}`)
	s.send(`{"type":"prompt_result","id":"` + command.str("id") + `","agentInvoked":true,"status":"completed","sessionSettled":false}`)
	s.respond(command, `{"agentInvoked":true}`)
	result := await(t, outcome)
	if result.err != nil || result.turn.AssistantText == nil || *result.turn.AssistantText != "hello" {
		t.Fatalf("%#v %v", result.turn, result.err)
	}
}

func TestPromptAndWaitLocalCompletion(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	command, outcome := prompt(t, c, s, 0)
	s.respond(command, `{"agentInvoked":false}`)
	result := await(t, outcome)
	if result.err != nil || result.turn.Result != nil {
		t.Fatalf("%#v %v", result.turn, result.err)
	}
}

func TestPromptAndWaitLateFailure(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	command, outcome := prompt(t, c, s, 0)
	s.respond(command, `{"agentInvoked":true}`)
	s.fail(command, "", "model exploded")
	result := await(t, outcome)
	var failure *CommandError
	if !errors.As(result.err, &failure) || failure.Message != "model exploded" {
		t.Fatalf("err = %v", result.err)
	}
}

func TestPromptAndWaitCompletesCompactedAgentEnd(t *testing.T) {
	user := `{"role":"user","content":"hi","timestamp":1}`
	assistant2 := strings.Replace(assistantHello, `"timestamp":2`, `"timestamp":3`, 1)
	for name, count := range map[string]int{"complete": 3, "missing": 5} {
		t.Run(name, func(t *testing.T) {
			c, s := startFake(t, readyV1, nil)
			command, outcome := prompt(t, c, s, 0)
			s.respond(command, `{"agentInvoked":true}`)
			s.send(
				`{"type":"message_end","message":{"role":"user","content":"stale","timestamp":0}}`,
				`{"type":"agent_start"}`,
				`{"type":"message_end","message":`+user+`}`,
				`{"type":"message_end","message":`+assistantHello+`}`,
				fmt.Sprintf(`{"type":"agent_end","messages":[%s],"messageCount":%d}`, assistant2, count),
				`{"type":"prompt_result","id":"`+command.str("id")+`","agentInvoked":true,"status":"completed","sessionSettled":true}`,
			)
			result := await(t, outcome)
			if count == 5 {
				if result.err == nil || !strings.Contains(result.err.Error(), "compacted agent_end") {
					t.Fatalf("err = %v", result.err)
				}
				return
			}
			if result.err != nil {
				t.Fatal(result.err)
			}
			messages := result.turn.Messages
			if len(messages) != 3 {
				t.Fatalf("messages %d", len(messages))
			}
			first, ok := messages[0].Value.(UserMessage)
			last, _ := messages[2].Value.(AssistantMessage)
			if !ok || *first.Content.String != "hi" || last.Timestamp != 3 || result.turn.AssistantMessage.Timestamp != 3 {
				t.Fatalf("messages %#v", messages)
			}
		})
	}
}

func TestPromptAndWaitEndsWithTheConnection(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	command, outcome := prompt(t, c, s, 0)
	s.respond(command, `{"agentInvoked":true}`)
	_ = s.out.Close()
	if result := await(t, outcome); !errors.Is(result.err, ErrClosed) {
		t.Fatalf("err = %v", result.err)
	}

	c, s = startFake(t, readyV1, nil)
	command, outcome = prompt(t, c, s, 100*time.Millisecond)
	s.respond(command, `{"agentInvoked":true}`)
	if result := await(t, outcome); !errors.Is(result.err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", result.err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.prompts) != 0 {
		t.Fatalf("prompt wait not removed: %v", c.prompts)
	}
}

// hostResult decodes a host_tool_result or host_tool_update frame.
func hostResult(t *testing.T, frame received, kind, id string) (text string, isError bool) {
	t.Helper()
	if frame.str("type") != kind || frame.str("id") != id {
		t.Fatalf("want %s %s, got %s", kind, id, frame.raw)
	}
	key := "result"
	if kind == "host_tool_update" {
		key = "partialResult"
	}
	var payload HostToolResultPayload
	if err := json.Unmarshal(frame.fields[key], &payload); err != nil {
		t.Fatalf("%s: %v", frame.raw, err)
	}
	if len(payload.Content) > 0 {
		if block, ok := payload.Content[0].Value.(TextContent); ok {
			text = block.Text
		}
	}
	return text, string(frame.fields["isError"]) == "true"
}

func echoTool(calls *atomic.Int32) HostTool {
	return HostTool{
		Definition: HostToolDefinition{
			Name:        "echo",
			Description: "Echo a message.",
			Parameters:  map[string]json.RawMessage{"type": json.RawMessage(`"object"`)},
			LoadMode:    Ptr(ToolLoadModeEssential),
		},
		Handler: func(ctx context.Context, call *HostToolCall, args json.RawMessage) (HostToolResultPayload, error) {
			calls.Add(1)
			var params struct {
				Message string `json:"message"`
				Fail    bool   `json:"fail"`
				Block   bool   `json:"block"`
			}
			if err := json.Unmarshal(args, &params); err != nil {
				return HostToolResultPayload{}, err
			}
			if params.Fail {
				return HostToolResultPayload{}, errors.New("echo refused")
			}
			if params.Block {
				<-ctx.Done()
				_ = call.SendUpdate(TextResult("too late"))
				return TextResult("too late"), nil
			}
			if err := call.SendUpdate(TextResult("working " + call.ToolCallID)); err != nil {
				return HostToolResultPayload{}, err
			}
			return TextResult("host:" + params.Message), nil
		},
	}
}

func startWithEcho(t *testing.T, calls *atomic.Int32) (*Client, *fakeServer) {
	t.Helper()
	return startFake(t, readyV1, func(s *fakeServer) {
		command := s.recv()
		if command.str("type") != "set_host_tools" || !strings.Contains(command.raw, `"loadMode":"essential"`) {
			t.Errorf("expected set_host_tools, got %s", command.raw)
		}
		s.respond(command, `{"toolNames":["echo"]}`)
	}, WithHostTools(echoTool(calls)))
}

func TestHostToolRunsWithUpdateAndRenamesEvents(t *testing.T) {
	var calls atomic.Int32
	c, s := startWithEcho(t, &calls)
	s.send(`{"type":"host_tool_call","id":"h1","toolCallId":"tc1","toolName":"echo","arguments":{"message":"hello"}}`)
	if text, _ := hostResult(t, s.recv(), "host_tool_update", "h1"); text != "working tc1" {
		t.Fatalf("update %q", text)
	}
	text, isError := hostResult(t, s.recv(), "host_tool_result", "h1")
	if text != "host:hello" || isError || calls.Load() != 1 {
		t.Fatalf("result %q isError=%v calls=%d", text, isError, calls.Load())
	}
	s.send(
		`{"type":"tool_execution_update","toolCallId":"tc1","toolName":"write"}`,
		`{"type":"tool_execution_end","toolCallId":"tc1","toolName":"write"}`,
		`{"type":"tool_execution_update","toolCallId":"tc1","toolName":"write"}`,
	)
	if update := nextFrame[ToolExecutionUpdateEvent](t, c); update.ToolName != "echo" {
		t.Fatalf("update renamed to %q", update.ToolName)
	}
	if end := nextFrame[ToolExecutionEndEvent](t, c); end.ToolName != "echo" {
		t.Fatalf("end renamed to %q", end.ToolName)
	}
	if update := nextFrame[ToolExecutionUpdateEvent](t, c); update.ToolName != "write" {
		t.Fatalf("mapping kept after end: %q", update.ToolName)
	}
}

func TestHostToolRejections(t *testing.T) {
	var calls atomic.Int32
	_, s := startWithEcho(t, &calls)
	s.send(`{"type":"host_tool_call","id":"h1","toolCallId":"tc1","toolName":"nope","arguments":{}}`)
	frame := s.recv()
	if text, isError := hostResult(t, frame, "host_tool_result", "h1"); text != `Host tool "nope" is not registered` || !isError || string(frame.fields["result"]) == "" ||
		!strings.Contains(frame.raw, `"details":{}`) {
		t.Fatalf("unknown tool: %s", frame.raw)
	}
	s.send(`{"type":"host_tool_call","id":"h2","toolCallId":"tc2","toolName":"echo","arguments":["hello"]}`)
	if text, isError := hostResult(t, s.recv(), "host_tool_result", "h2"); text != "Host tool arguments must be an object" || !isError {
		t.Fatalf("array arguments: %q", text)
	}
	s.send(`{"type":"host_tool_call","id":"h3","toolCallId":"tc3","toolName":"echo","arguments":{"fail":true}}`)
	if text, isError := hostResult(t, s.recv(), "host_tool_result", "h3"); text != "echo refused" || !isError {
		t.Fatalf("handler error: %q", text)
	}
	if calls.Load() != 1 {
		t.Fatalf("handler ran %d times", calls.Load())
	}
}

func TestHostToolCancelSuppressesResult(t *testing.T) {
	var calls atomic.Int32
	c, s := startWithEcho(t, &calls)
	s.send(`{"type":"host_tool_call","id":"h1","toolCallId":"tc1","toolName":"echo","arguments":{"block":true}}`)
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	s.send(`{"type":"host_tool_cancel","id":"c1","targetId":"h1"}`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		running := len(c.hostCalls)
		c.mu.Unlock()
		if running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled host call still running")
		}
		time.Sleep(time.Millisecond)
	}
	s.expectSilence()
}

func TestGetMessagesPagesUnderV2(t *testing.T) {
	user := func(text string) string { return `{"role":"user","content":"` + text + `","timestamp":1}` }
	c, s := startFake(t, readyV2, negotiateV2)
	go func() {
		first := s.recv()
		if first.str("type") != "get_messages_page" || string(first.fields["limit"]) != "256" || first.fields["cursor"] != nil {
			t.Errorf("first page request %s", first.raw)
		}
		s.respond(first, `{"messages":[`+user("a")+`],"totalMessages":2,"nextCursor":"c1"}`)
		second := s.recv()
		if second.str("cursor") != "c1" {
			t.Errorf("second page request %s", second.raw)
		}
		s.respond(second, `{"messages":[`+user("b")+`],"totalMessages":2}`)
	}()
	messages, err := c.GetMessages(context.Background())
	if err != nil || len(messages) != 2 {
		t.Fatalf("%d messages, %v", len(messages), err)
	}

	go func() {
		first := s.recv()
		s.respond(first, `{"messages":[`+user("a")+`],"totalMessages":2,"nextCursor":"c1"}`)
		s.fail(s.recv(), "stale_cursor", "RPC message cursor is stale")
		monolithic := s.recv()
		if monolithic.str("type") != "get_messages" {
			t.Errorf("fallback request %s", monolithic.raw)
		}
		s.respond(monolithic, `{"messages":[`+user("a")+`,`+user("b")+`,`+user("c")+`]}`)
	}()
	messages, err = c.GetMessages(context.Background())
	if err != nil || len(messages) != 3 {
		t.Fatalf("fallback: %d messages, %v", len(messages), err)
	}
}
