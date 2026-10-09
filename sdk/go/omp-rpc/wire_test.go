package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func decodeFrame(t *testing.T, line string) RpcServerFrameVariant {
	t.Helper()
	var frame RpcServerFrame
	if err := json.Unmarshal([]byte(line), &frame); err != nil {
		t.Fatalf("decode %s: %v", line, err)
	}
	return frame.Value
}

func TestUnknownNotificationKeepsRawFrame(t *testing.T) {
	line := `{"type":"brand_new_frame","payload":{"x":[1,2]}}`
	var notification RpcNotification
	if err := json.Unmarshal([]byte(line), &notification); err != nil {
		t.Fatal(err)
	}
	unknown, ok := notification.Value.(UnknownNotification)
	if !ok || unknown.Type != "brand_new_frame" || string(unknown.Raw) != line || unknown.Err != nil {
		t.Fatalf("got %#v", notification.Value)
	}
	if frame, ok := decodeFrame(t, line).(UnknownNotification); !ok || string(frame.Raw) != line {
		t.Fatalf("server frame: got %#v", frame)
	}
	encoded, err := json.Marshal(notification)
	if err != nil || string(encoded) != line {
		t.Fatalf("re-encode: %s %v", encoded, err)
	}
}

func TestSessionEventsRouteThroughNestedUnions(t *testing.T) {
	if _, ok := decodeFrame(t, `{"type":"agent_start"}`).(AgentStartEvent); !ok {
		t.Fatal("agent_start is not flattened into RpcServerFrame")
	}
	value := decodeFrame(t, `{"type":"subagent_event","payload":{"id":"sub-1","event":{"type":"goal_updated","goal":null}}}`)
	event, ok := value.(SubagentEvent)
	if !ok || event.Payload.ID != "sub-1" {
		t.Fatalf("got %#v", value)
	}
	if updated, ok := event.Payload.Event.Value.(GoalUpdatedEvent); !ok || updated.Goal != nil {
		t.Fatalf("payload event: got %#v", event.Payload.Event.Value)
	}
}

func TestExtensionUiRequestRoutesByMethod(t *testing.T) {
	value := decodeFrame(t, `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"Delete?","message":"Really"}`)
	request, ok := value.(ExtensionUiRequest)
	if !ok {
		t.Fatalf("got %#v", value)
	}
	confirm, ok := request.Value.(ConfirmUiRequest)
	if !ok || confirm.ID != "ui-1" || confirm.Title != "Delete?" || confirm.Message != "Really" {
		t.Fatalf("got %#v", request.Value)
	}
	var frame RpcServerFrame
	err := json.Unmarshal([]byte(`{"type":"extension_ui_request","id":"ui-2","method":"teleport"}`), &frame)
	if err == nil || !strings.Contains(err.Error(), "teleport") {
		t.Fatalf("unknown method: err = %v", err)
	}
}

func TestOpenRecordKeepsUnknownKeysAndToleratesMissingFields(t *testing.T) {
	var message AgentMessage
	line := `{"role":"user","content":[{"type":"text","text":"hi","cacheHint":"x"}],"timestamp":1,"futureKey":{"a":1}}`
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		t.Fatal(err)
	}
	user, ok := message.Value.(UserMessage)
	if !ok || string(user.Extra["futureKey"]) != `{"a":1}` {
		t.Fatalf("got %#v", message.Value)
	}
	block, ok := user.Content.Array[0].Value.(TextContent)
	if !ok || block.Text != "hi" || string(block.Extra["cacheHint"]) != `"x"` {
		t.Fatalf("content block: %#v", user.Content)
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip map[string]any
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip["role"] != "user" || roundTrip["futureKey"] == nil {
		t.Fatalf("re-encoded %s", encoded)
	}

	// An assistant message missing most declared fields still decodes.
	if err := json.Unmarshal([]byte(`{"role":"assistant","content":[]}`), &message); err != nil {
		t.Fatalf("missing declared fields: %v", err)
	}
	if assistant, ok := message.Value.(AssistantMessage); !ok || assistant.Model != "" {
		t.Fatalf("got %#v", message.Value)
	}
	// The discriminator is still checked against the known set.
	if err := json.Unmarshal([]byte(`{"role":"oracle"}`), &message); err == nil {
		t.Fatal("unknown role decoded")
	}
}

func TestOpenRecordKeepsUndecodableFieldInExtra(t *testing.T) {
	var message AgentMessage
	line := `{"role":"user","content":42,"timestamp":"yesterday","synthetic":true}`
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		t.Fatalf("wrong-typed declared fields failed the record: %v", err)
	}
	user := message.Value.(UserMessage)
	if user.Timestamp != 0 || user.Content.String != nil || user.Content.Array != nil || user.Synthetic == nil || !*user.Synthetic {
		t.Fatalf("fields: %#v", user)
	}
	if string(user.Extra["timestamp"]) != `"yesterday"` || string(user.Extra["content"]) != `42` || len(user.Extra) != 2 {
		t.Fatalf("extra: %v", user.Extra)
	}
	user.Content = MessageContent{String: Ptr("unused")}
	encoded, err := json.Marshal(user)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if string(roundTrip["timestamp"]) != `"yesterday"` || string(roundTrip["content"]) != `42` || string(roundTrip["role"]) != `"user"` {
		t.Fatalf("re-encoded %s", encoded)
	}
}

func TestUnknownFallbackFieldKeepsEnclosingFrame(t *testing.T) {
	for _, event := range []string{
		`{"type":"future_session_event","detail":1}`,
		`{"type":"goal_updated","goal":{"id":"g"}}`,
	} {
		value := decodeFrame(t, `{"type":"subagent_event","payload":{"id":"sub-1","event":`+event+`}}`)
		frame, ok := value.(SubagentEvent)
		if !ok || frame.Payload.ID != "sub-1" {
			t.Fatalf("got %#v", value)
		}
		unknown, ok := frame.Payload.Event.Value.(UnknownNotification)
		if !ok || unknown.Err == nil || string(unknown.Raw) != event || unknown.Type != peekTag([]byte(event), "type") {
			t.Fatalf("event %s: got %#v", event, frame.Payload.Event.Value)
		}
		encoded, err := json.Marshal(frame)
		if err != nil || !strings.Contains(string(encoded), event) {
			t.Fatalf("re-encode: %s %v", encoded, err)
		}
	}
	var frame RpcServerFrame
	if err := json.Unmarshal([]byte(`{"type":"subagent_event","payload":{"id":"sub-1"}}`), &frame); err == nil {
		t.Fatal("a missing fallback field still fails the frame")
	}
}

func TestScalarOrArrayAcceptsBareScalar(t *testing.T) {
	for line, want := range map[string][]string{
		`{"sessionId":"s","systemPrompt":"You are omp."}`: {"You are omp."},
		`{"sessionId":"s","systemPrompt":["a","b"]}`:      {"a", "b"},
		`{"sessionId":"s"}`:                               {},
	} {
		var state SessionState
		if err := json.Unmarshal([]byte(line), &state); err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		if state.SystemPrompt == nil || strings.Join(state.SystemPrompt, "|") != strings.Join(want, "|") {
			t.Fatalf("%s: got %#v", line, state.SystemPrompt)
		}
	}
}

func TestClosedRecordRequiresFields(t *testing.T) {
	var goal Goal
	err := json.Unmarshal([]byte(`{"id":"g","objective":"o","status":"active","tokensUsed":1,"timeUsedSeconds":0,"createdAt":1}`), &goal)
	if err == nil || !strings.Contains(err.Error(), `"updatedAt"`) {
		t.Fatalf("err = %v", err)
	}
	err = json.Unmarshal([]byte(`{"id":null,"objective":"o","status":"active","tokensUsed":1,"timeUsedSeconds":0,"createdAt":1,"updatedAt":2}`), &goal)
	if err == nil {
		t.Fatal("null required field decoded")
	}
}

func TestDefaultedFieldsTakeTheirDefault(t *testing.T) {
	var state SessionState
	if err := json.Unmarshal([]byte(`{"sessionId":"s","unknownKey":true}`), &state); err != nil {
		t.Fatal(err)
	}
	if state.SteeringMode != QueueModeOneAtATime || state.InterruptMode != InterruptModeImmediate {
		t.Fatalf("modes: %q %q", state.SteeringMode, state.InterruptMode)
	}
	if state.QueuedMessages.Steering == nil || state.TodoPhases == nil || state.TokensPerSecond != nil || state.Goal != nil {
		t.Fatalf("defaults: %#v", state)
	}
}

func TestUnknownEnumValueFails(t *testing.T) {
	var goal Goal
	err := json.Unmarshal([]byte(`{"id":"g","objective":"o","status":"exploded","tokensUsed":1,"timeUsedSeconds":0,"createdAt":1,"updatedAt":2}`), &goal)
	if err == nil || !strings.Contains(err.Error(), "exploded") {
		t.Fatalf("err = %v", err)
	}
}

type fakeTransport struct {
	command string
	params  any
	timeout time.Duration
	data    json.RawMessage
	err     error
}

func (f *fakeTransport) Call(_ context.Context, command string, params any, timeout time.Duration) (json.RawMessage, error) {
	f.command, f.params, f.timeout = command, params, timeout
	return f.data, f.err
}

func (f *fakeTransport) frame(t *testing.T) string {
	t.Helper()
	frame, err := EncodeCommand("req_1", f.command, f.params)
	if err != nil {
		t.Fatal(err)
	}
	return string(frame)
}

func TestCommandEncoding(t *testing.T) {
	ctx := context.Background()
	transport := &fakeTransport{data: json.RawMessage(`{"goal":null,"state":null}`)}
	commands := Commands{Transport: transport}

	if _, err := commands.Goal(ctx, GoalCommand{Op: GoalOpCreate, TokenBudget: Ptr(int64(5000))}); err != nil {
		t.Fatal(err)
	}
	if got := transport.frame(t); got != `{"id":"req_1","type":"goal","op":"create","token_budget":5000}` {
		t.Fatalf("goal frame: %s", got)
	}

	transport.data = json.RawMessage(`{"entries":[],"leafId":null}`)
	if _, err := commands.GetEntries(ctx, GetEntriesCommand{}); err != nil {
		t.Fatal(err)
	}
	if got := transport.frame(t); got != `{"id":"req_1","type":"get_entries"}` {
		t.Fatalf("get_entries frame: %s", got)
	}

	transport.data = json.RawMessage(`{"events":null}`)
	events, err := commands.SetEventFilter(ctx, SetEventFilterCommand{})
	if err != nil || events != nil {
		t.Fatalf("set_event_filter: %v %v", events, err)
	}
	if got := transport.frame(t); got != `{"id":"req_1","type":"set_event_filter","events":null}` {
		t.Fatalf("set_event_filter frame: %s", got)
	}

	transport.data = nil
	if err := commands.Abort(ctx); err != nil {
		t.Fatal(err)
	}
	if got := transport.frame(t); got != `{"id":"req_1","type":"abort"}` {
		t.Fatalf("abort frame: %s", got)
	}

	inbound, err := json.Marshal(RpcInbound{Value: CancelUiResponse{ID: "ui-1"}})
	if err != nil || string(inbound) != `{"type":"extension_ui_response","cancelled":true,"id":"ui-1"}` {
		t.Fatalf("inbound: %s %v", inbound, err)
	}
}

func TestResultDecoding(t *testing.T) {
	ctx := context.Background()
	transport := &fakeTransport{}
	commands := Commands{Transport: transport}

	transport.data = json.RawMessage(`{"suffix":"ld"}`)
	suffix, err := commands.PredictWord(ctx, PredictWordCommand{Text: "hello wor", Cursor: 9})
	if err != nil || suffix == nil || *suffix != "ld" || transport.timeout != 155*time.Second {
		t.Fatalf("predict_word: %v %v %v", suffix, err, transport.timeout)
	}
	transport.data = json.RawMessage(`{"suffix":null}`)
	if suffix, err = commands.PredictWord(ctx, PredictWordCommand{}); err != nil || suffix != nil {
		t.Fatalf("null suffix: %v %v", suffix, err)
	}

	transport.data = json.RawMessage(`{"cancelled":false}`)
	if cancelled, err := commands.CancelSubagent(ctx, CancelSubagentCommand{SubagentID: "x"}); err != nil || cancelled {
		t.Fatalf("cancel_subagent: %v %v", cancelled, err)
	}
	transport.data = json.RawMessage(`{}`)
	if _, err := commands.CancelSubagent(ctx, CancelSubagentCommand{SubagentID: "x"}); err == nil {
		t.Fatal("unwrap envelope without its field decoded")
	}

	for _, data := range []json.RawMessage{nil, json.RawMessage(`null`)} {
		transport.data = data
		if result, err := commands.CycleModel(ctx); err != nil || result != nil {
			t.Fatalf("cycle_model %q: %v %v", data, result, err)
		}
	}
	transport.data = json.RawMessage(`{"level":"high"}`)
	if result, err := commands.CycleThinkingLevel(ctx); err != nil || result == nil || result.Level != EffortHigh {
		t.Fatalf("cycle_thinking_level: %v %v", result, err)
	}
	transport.data = json.RawMessage(`null`)
	if _, err := commands.GetState(ctx); err == nil {
		t.Fatal("null non-nullable result decoded")
	}
	transport.data = nil
	if ack, err := commands.Prompt(ctx, PromptCommand{Message: "hi"}); err != nil || ack.AgentInvoked != nil {
		t.Fatalf("absent prompt ack data: %#v %v", ack, err)
	}
	if _, err := commands.GetState(ctx); err == nil || !strings.Contains(err.Error(), "sessionId") {
		t.Fatalf("absent data for a result with required fields: %v", err)
	}

	_, err = responseData(RpcResponse{Command: "get_entries", Error: Ptr("no such entry"), Code: Ptr("unknown_since")})
	var failure *CommandError
	if !errors.As(err, &failure) || failure.Code != "unknown_since" || failure.Message != "no such entry" {
		t.Fatalf("command error: %v", err)
	}
}
