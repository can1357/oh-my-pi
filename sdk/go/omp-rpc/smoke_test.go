package omprpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The smoke tests drive real servers from the repository checkout:
//
//	OMP_RPC_SMOKE=1 go test -run TestSmoke -v ./...
//
// PI_CODING_AGENT_DIR points at a fresh directory so no user configuration
// applies. TestSmoke has no model and never prompts; TestSmokeModel prompts a
// scripted local model (packages/coding-agent/test/rpc-wire/fake-openai-server.ts).

func repoRoot(t *testing.T) string {
	t.Helper()
	if os.Getenv("OMP_RPC_SMOKE") != "1" {
		t.Skip("set OMP_RPC_SMOKE=1 to run against a real server (needs bun)")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// frameLog records every frame a client delivers.
type frameLog struct {
	mu       sync.Mutex
	counts   map[string]int
	unknowns []UnknownNotification
	done     chan struct{}
}

func (l *frameLog) count(frameType string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.counts[frameType]
}

func (l *frameLog) waitFor(t *testing.T, frameType string, n int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for l.count(frameType) < n {
		if time.Now().After(deadline) {
			t.Fatalf("saw fewer than %d %s frames", n, frameType)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// startServer runs omp in rpc mode and logs its frames; the returned function
// closes it and checks that every frame decoded.
func startServer(t *testing.T, root, agentDir string, args []string, options ...Option) (*Client, *frameLog, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.Command("bun", append([]string{"packages/coding-agent/src/cli.ts", "--mode", "rpc", "--no-session"}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PI_CODING_AGENT_DIR="+agentDir)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	client, err := Start(ctx, cmd, options...)
	if err != nil {
		t.Fatalf("start: %v\n%s", err, stderr.String())
	}
	// Reaps the process even when a check fails; Close is idempotent.
	t.Cleanup(func() {
		_ = client.Close()
	})
	ready := client.Ready()
	t.Logf("ready: protocolVersion=%d supported=%v negotiated=%d", deref(ready.ProtocolVersion), ready.SupportedProtocolVersions, client.ProtocolVersion())
	if client.ProtocolVersion() != 2 {
		t.Fatalf("negotiated protocol %d", client.ProtocolVersion())
	}
	log := &frameLog{counts: map[string]int{}, done: make(chan struct{})}
	go func() {
		defer close(log.done)
		for frame := range client.Frames() {
			log.mu.Lock()
			if unknown, ok := frame.Value.(UnknownNotification); ok {
				log.unknowns = append(log.unknowns, unknown)
			} else {
				log.counts[frameType(t, frame)]++
			}
			log.mu.Unlock()
		}
	}()
	return client, log, func() {
		if err := client.Close(); err != nil {
			t.Errorf("close: %v\n%s", err, stderr.String())
		}
		<-log.done
		log.mu.Lock()
		defer log.mu.Unlock()
		t.Logf("frames: %v", log.counts)
		for _, unknown := range log.unknowns {
			t.Errorf("unknown frame %q (err %v): %.300s", unknown.Type, unknown.Err, unknown.Raw)
		}
	}
}

func TestSmoke(t *testing.T) {
	root := repoRoot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	client, log, finish := startServer(t, root, t.TempDir(), nil)

	state, err := client.GetState(ctx)
	if err != nil {
		t.Fatalf("get_state: %v", err)
	}
	t.Logf("get_state: sessionId=%s steeringMode=%s isSettled=%v todoPhases=%d", state.SessionID, state.SteeringMode, state.IsSettled, len(state.TodoPhases))

	commands, err := client.GetAvailableCommands(ctx)
	if err != nil {
		t.Fatalf("get_available_commands: %v", err)
	}
	t.Logf("get_available_commands: %d commands", len(commands))
	log.waitFor(t, "available_commands_update", 1)

	created, err := client.Goal(ctx, GoalCommand{Op: GoalOpCreate, Objective: Ptr("Go binding smoke goal"), TokenBudget: Ptr(int64(5000))})
	if err != nil {
		t.Fatalf("goal create: %v", err)
	}
	if created.Goal == nil || created.Goal.Status != GoalStatusActive || deref(created.Goal.TokenBudget) != 5000 {
		t.Fatalf("goal create: %#v", created.Goal)
	}
	t.Logf("goal create: id=%s status=%s tokenBudget=%d", created.Goal.ID, created.Goal.Status, deref(created.Goal.TokenBudget))
	paused, err := client.Goal(ctx, GoalCommand{Op: GoalOpPause})
	if err != nil || paused.Goal == nil || paused.Goal.Status != GoalStatusPaused {
		t.Fatalf("goal pause: %#v %v", paused.Goal, err)
	}
	t.Logf("goal pause: status=%s", paused.Goal.Status)
	dropped, err := client.Goal(ctx, GoalCommand{Op: GoalOpDrop})
	if err != nil {
		t.Fatalf("goal drop: %v", err)
	}
	if dropped.Goal != nil {
		t.Logf("goal drop: status=%s", dropped.Goal.Status)
	} else {
		t.Logf("goal drop: goal=null")
	}
	log.waitFor(t, "goal_updated", 3)

	phases, err := client.SetTodos(ctx, SetTodosCommand{Phases: []TodoPhase{{
		Name:  "Smoke",
		Tasks: []TodoItem{{Content: "Wait for review", Status: TodoStatusInProgress}},
	}}})
	if err != nil || len(phases) != 1 || phases[0].Tasks[0].Status != TodoStatusInProgress {
		t.Fatalf("set_todos: %#v %v", phases, err)
	}
	t.Logf("set_todos: %s/%s status=%s", phases[0].Name, phases[0].Tasks[0].Content, phases[0].Tasks[0].Status)

	events, err := client.SetEventFilter(ctx, SetEventFilterCommand{Events: nil})
	if err != nil || events != nil {
		t.Fatalf("set_event_filter: %v %v", events, err)
	}
	t.Logf("set_event_filter: events=null")

	_, err = client.GetEntries(ctx, GetEntriesCommand{Since: Ptr("no-such-entry")})
	var failure *CommandError
	if !errors.As(err, &failure) || failure.Code != "unknown_since" {
		t.Fatalf("get_entries: %v", err)
	}
	t.Logf("get_entries: %v", err)

	cancelled, err := client.CancelSubagent(ctx, CancelSubagentCommand{SubagentID: "no-such-subagent"})
	if err != nil || cancelled {
		t.Fatalf("cancel_subagent: %v %v", cancelled, err)
	}
	t.Logf("cancel_subagent: %v", cancelled)

	suffix, err := client.PredictWord(ctx, PredictWordCommand{Text: "hello wor", Cursor: 9})
	if err != nil {
		t.Fatalf("predict_word: %v", err)
	}
	if suffix == nil {
		t.Logf("predict_word: null")
	} else {
		t.Logf("predict_word: %q", *suffix)
	}

	bash, err := client.Bash(ctx, BashCommand{Command: "echo hi"})
	if err != nil || bash.Output != "hi\n" && bash.Output != "hi" {
		t.Fatalf("bash: %#v %v", bash, err)
	}
	t.Logf("bash: output=%q exitCode=%d", bash.Output, deref(bash.ExitCode))
	finish()
}

func TestSmokeModel(t *testing.T) {
	root := repoRoot(t)
	agentDir := t.TempDir()
	model := exec.Command("bun", "packages/coding-agent/test/rpc-wire/fake-openai-server.ts", agentDir)
	model.Dir = root
	model.Stderr = os.Stderr
	modelStdin, err := model.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	modelStdout, err := model.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := model.Start(); err != nil {
		t.Fatal(err)
	}
	// Registered before the client's cleanup, so it runs after it.
	t.Cleanup(func() {
		_ = modelStdin.Close()
		_ = model.Wait()
	})
	banner, err := bufio.NewReader(modelStdout).ReadString('\n')
	if err != nil || !strings.HasPrefix(banner, "READY ") {
		t.Fatalf("fake model: %q %v", banner, err)
	}
	t.Logf("fake model: %s", strings.TrimSpace(banner))

	var calls atomic.Int32
	var callArgs atomic.Value
	echoHost := HostTool{
		Definition: HostToolDefinition{
			Name:        "echo_host",
			Description: "Echo a message back from the host.",
			Parameters: map[string]json.RawMessage{
				"type":       json.RawMessage(`"object"`),
				"properties": json.RawMessage(`{"message":{"type":"string"}}`),
				"required":   json.RawMessage(`["message"]`),
			},
			LoadMode: Ptr(ToolLoadModeEssential),
		},
		Handler: func(ctx context.Context, call *HostToolCall, args json.RawMessage) (HostToolResultPayload, error) {
			calls.Add(1)
			callArgs.Store(string(args))
			var params struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(args, &params); err != nil {
				return HostToolResultPayload{}, err
			}
			if err := call.SendUpdate(TextResult("echoing")); err != nil {
				return HostToolResultPayload{}, err
			}
			return TextResult("host:" + params.Message), nil
		},
	}
	var uriMu sync.Mutex
	var uriReads []string
	var uriWrites [][2]string
	notes := HostUri{
		Scheme:      "notes",
		Description: "Scratch notes",
		Read: func(ctx context.Context, url string) (HostUriReadResult, error) {
			uriMu.Lock()
			uriReads = append(uriReads, url)
			uriMu.Unlock()
			return HostUriReadResult{Content: "note body", ContentType: Ptr(HostUriResultContentTypeTextPlain)}, nil
		},
		Write: func(ctx context.Context, url, content string) error {
			uriMu.Lock()
			uriWrites = append(uriWrites, [2]string{url, content})
			uriMu.Unlock()
			return nil
		},
	}
	client, _, finish := startServer(t, root, agentDir, []string{"--model", "fake/fake-model"}, WithHostTools(echoHost), WithHostUris(notes))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	turn, err := client.PromptAndWait(ctx, PromptCommand{Message: "say hi"}, 0)
	if err != nil {
		t.Fatalf("say hi: %v", err)
	}
	if deref(turn.AssistantText) != "pong" || turn.Result == nil || turn.Result.Status != PromptStatusCompleted {
		t.Fatalf("say hi: text=%q result=%#v", deref(turn.AssistantText), turn.Result)
	}
	t.Logf("say hi: assistant=%q status=%s events=%d messages=%d", *turn.AssistantText, turn.Result.Status, len(turn.Events), len(turn.Messages))

	turn, err = client.PromptAndWait(ctx, PromptCommand{Message: "please use echo_host"}, 0)
	if err != nil {
		t.Fatalf("echo_host: %v", err)
	}
	if deref(turn.AssistantText) != "tool said: host:hello" || calls.Load() != 1 {
		t.Fatalf("echo_host: text=%q calls=%d", deref(turn.AssistantText), calls.Load())
	}
	if args, _ := callArgs.Load().(string); args != `{"message":"hello"}` {
		t.Fatalf("echo_host arguments %s", args)
	}
	toolEvents := map[string]string{}
	for _, event := range turn.Events {
		switch value := event.Value.(type) {
		case ToolExecutionStartEvent:
			toolEvents["tool_execution_start"] = value.ToolName
		case ToolExecutionUpdateEvent:
			toolEvents["tool_execution_update"] = value.ToolName
		case ToolExecutionEndEvent:
			toolEvents["tool_execution_end"] = value.ToolName
		}
	}
	for _, kind := range []string{"tool_execution_start", "tool_execution_update", "tool_execution_end"} {
		if toolEvents[kind] != "echo_host" {
			t.Fatalf("echo_host: %s toolName %q (all: %v)", kind, toolEvents[kind], toolEvents)
		}
	}
	t.Logf("echo_host: assistant=%q calls=%d args=%s toolEvents=%v status=%s", *turn.AssistantText, calls.Load(), callArgs.Load(), toolEvents, turn.Result.Status)

	turn, err = client.PromptAndWait(ctx, PromptCommand{Message: "please read_uri notes://today"}, 0)
	if err != nil {
		t.Fatalf("read_uri: %v", err)
	}
	uriMu.Lock()
	reads := slices.Clone(uriReads)
	uriMu.Unlock()
	if deref(turn.AssistantText) != "tool said: 1:note body" || !slices.Contains(reads, "notes://today") {
		t.Fatalf("read_uri: text=%q reads=%v", deref(turn.AssistantText), reads)
	}
	t.Logf("read_uri: assistant=%q reads=%v", *turn.AssistantText, reads)

	turn, err = client.PromptAndWait(ctx, PromptCommand{Message: "please write_uri notes://today"}, 0)
	if err != nil {
		t.Fatalf("write_uri: %v", err)
	}
	uriMu.Lock()
	writes := slices.Clone(uriWrites)
	uriMu.Unlock()
	if deref(turn.AssistantText) != "tool said: Successfully wrote 16 bytes to notes://today" ||
		len(writes) != 1 || writes[0] != [2]string{"notes://today", "written by model"} {
		t.Fatalf("write_uri: text=%q writes=%v", deref(turn.AssistantText), writes)
	}
	t.Logf("write_uri: assistant=%q writes=%v", *turn.AssistantText, writes)

	big := strings.Repeat("x", 1_200_000) + " say hi"
	turn, err = client.PromptAndWait(ctx, PromptCommand{Message: big}, 0)
	if err != nil {
		t.Fatalf("large prompt: %v", err)
	}
	echoed := false
	for _, event := range turn.Events {
		if end, ok := event.Value.(MessageEndEvent); ok {
			if user, ok := end.Message.Value.(UserMessage); ok && messageText(user.Content) == big {
				echoed = true
			}
		}
	}
	if !echoed || deref(turn.AssistantText) != "pong" || client.reassembled.Load() == 0 {
		t.Fatalf("large prompt: user message_end echoed=%v text=%q reassembled=%d", echoed, deref(turn.AssistantText), client.reassembled.Load())
	}
	t.Logf("large prompt: %d bytes, user message_end carried the full text, assistant=%q, frames reassembled from rpc_chunk=%d", len(big), *turn.AssistantText, client.reassembled.Load())

	state, err := client.GetState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	messages, err := client.GetMessages(ctx)
	if err != nil || int64(len(messages)) != state.MessageCount {
		t.Fatalf("get_messages: %d messages, messageCount %d, %v", len(messages), state.MessageCount, err)
	}
	t.Logf("get_messages: %d messages (messageCount %d)", len(messages), state.MessageCount)
	finish()
}

// deepChainEntries is past every depth the decoders once stopped at:
// encoding/json refuses 10,000 levels (5,000 entries, since get_tree nests each
// entry two levels under its parent).
const deepChainEntries = 100_000

// writeChainSession writes, as test/rpc-get-tree.test.ts does, a session that
// is one chain of deepChainEntries custom entries, e0 its root.
func writeChainSession(t *testing.T, dir string) string {
	t.Helper()
	const timestamp = "2026-01-01T00:00:00.000Z"
	header, err := json.Marshal(map[string]any{"type": "session", "version": 3, "id": "deep-chain", "timestamp": timestamp, "cwd": dir})
	if err != nil {
		t.Fatal(err)
	}
	var session bytes.Buffer
	session.Write(append(header, '\n'))
	for index := range deepChainEntries {
		parent := "null"
		if index > 0 {
			parent = fmt.Sprintf(`"e%d"`, index-1)
		}
		fmt.Fprintf(&session, `{"type":"custom","id":"e%d","parentId":%s,"timestamp":%q,"customType":"probe","data":{"index":%d}}`+"\n", index, parent, timestamp, index)
	}
	file := filepath.Join(dir, "sessions", "chain.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, session.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// walkChain follows the chain of tree nodes from root, each the only child of
// the one before, checking each entry's id and parent; it returns how many
// nodes the chain has and its last entry's id. The json v2 backend of
// encoding/json (the one Go 1.27 builds) reads no value nested 10,000 levels
// deep, even token by token, so it walks root's raw children once as the host
// writes them (compact, each node's entry before its children) and decodes
// each entry alone, which works on the v1 backend too.
func walkChain(t *testing.T, root map[string]json.RawMessage) (int, string) {
	t.Helper()
	type chainEntry struct {
		ID       string  `json:"id"`
		ParentID *string `json:"parentId"`
	}
	check := func(depth int, entry chainEntry) {
		placed := entry.ID == fmt.Sprintf("e%d", depth)
		if depth == 0 {
			placed = placed && entry.ParentID == nil
		} else {
			placed = placed && entry.ParentID != nil && *entry.ParentID == fmt.Sprintf("e%d", depth-1)
		}
		if !placed {
			t.Fatalf("node %d: entry %q, parent %q", depth, entry.ID, deref(entry.ParentID))
		}
	}
	var entry chainEntry
	if err := json.Unmarshal(root["entry"], &entry); err != nil {
		t.Fatalf("root entry: %v", err)
	}
	check(0, entry)
	depth, deepest := 1, entry.ID
	children := []byte(root["children"])
	expect := func(at int, want string) int {
		if !bytes.HasPrefix(children[at:], []byte(want)) {
			t.Fatalf("node %d: %.40q at offset %d, want %q", depth, children[at:], at, want)
		}
		return at + len(want)
	}
	at := 0
	for {
		// The children of the node at depth - 1: none, or the node at depth.
		at = expect(at, "[")
		if bytes.HasPrefix(children[at:], []byte("]")) {
			at++
			break
		}
		at = expect(at, `{"entry":`)
		decoder := json.NewDecoder(bytes.NewReader(children[at:]))
		entry = chainEntry{}
		if err := decoder.Decode(&entry); err != nil {
			t.Fatalf("node %d: entry: %v", depth, err)
		}
		at += int(decoder.InputOffset())
		check(depth, entry)
		deepest = entry.ID
		depth++
		at = expect(at, `,"children":`)
	}
	// Past the leaf each node and the children holding it close: a node with a
	// second child or another member would show here.
	if rest := string(children[at:]); rest != strings.Repeat("}]", depth-1) {
		t.Fatalf("after the leaf: %.80q, want %d closing nodes", rest, depth-1)
	}
	return depth, deepest
}

// If this regresses, get_tree on a long session (a long session can be one
// chain of tens of thousands of entries) fails with "exceeded max depth", or
// waits out its 30 s timeout while the decode error goes to Frames.
func TestSmokeGetTreeDeepChain(t *testing.T) {
	root := repoRoot(t)
	dir := t.TempDir()
	sessionFile := writeChainSession(t, dir)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Real RPC dispatch over the session file; its mock model is never called here.
	cmd := exec.Command("bun", "packages/coding-agent/test/fixtures/tree-rpc-agent.ts", dir, sessionFile)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PI_CODING_AGENT_DIR="+dir, "PI_NO_TITLE=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	client, err := Start(ctx, cmd)
	if err != nil {
		t.Fatalf("start: %v\n%s", err, stderr.String())
	}
	t.Cleanup(func() {
		_ = client.Close()
	})
	if client.ProtocolVersion() != 2 {
		t.Fatalf("negotiated protocol %d", client.ProtocolVersion())
	}

	tree, err := client.GetTree(ctx)
	if err != nil {
		t.Fatalf("get_tree: %v", err)
	}
	leaf := fmt.Sprintf("e%d", deepChainEntries-1)
	if len(tree.Tree) != 1 || deref(tree.LeafID) != leaf {
		t.Fatalf("get_tree: %d roots, leaf %q", len(tree.Tree), deref(tree.LeafID))
	}
	depth, deepest := walkChain(t, tree.Tree[0])
	if depth != deepChainEntries || deepest != leaf {
		t.Fatalf("get_tree: chain of %d nodes ending at %q", depth, deepest)
	}
	// The client still serves commands after the deep answer.
	if _, err := client.GetState(ctx); err != nil {
		t.Fatalf("get_state: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Errorf("close: %v\n%s", err, stderr.String())
	}
}

func messageText(content MessageContent) string {
	if content.String != nil {
		return *content.String
	}
	var text strings.Builder
	for _, block := range content.Array {
		if value, ok := block.Value.(TextContent); ok {
			text.WriteString(value.Text)
		}
	}
	return text.String()
}

func frameType(t *testing.T, frame RpcServerFrame) string {
	t.Helper()
	var head struct {
		Type string `json:"type"`
	}
	data, err := frame.MarshalJSON()
	if err == nil {
		err = json.Unmarshal(data, &head)
	}
	if err != nil {
		t.Errorf("re-encode %T: %v", frame.Value, err)
	}
	return head.Type
}

func deref[T any](value *T) T {
	var zero T
	if value == nil {
		return zero
	}
	return *value
}
