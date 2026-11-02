package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"testing"
	"time"
)

// A server that stops reading its stdin blocks a write; Close must release it
// rather than deadlock behind it.
func TestCloseReleasesWriteBlockedOnPeer(t *testing.T) {
	clientIn, serverOut := io.Pipe()
	_, clientOut := io.Pipe() // nobody ever reads what the client writes
	go func() {
		_, _ = io.WriteString(serverOut, readyV1+"\n")
	}()
	c, err := NewClient(context.Background(), clientIn, clientOut)
	if err != nil {
		t.Fatal(err)
	}
	called := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), "get_state", nil, 50*time.Millisecond)
		called <- err
	}()
	for {
		c.mu.Lock()
		registered := len(c.pending)
		c.mu.Unlock()
		if registered == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	closed := make(chan error, 1)
	go func() {
		closed <- c.Close()
	}()
	select {
	case err := <-called:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked call: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not release the blocked write")
	}
	if err := c.Send(HostToolResult{ID: "h1"}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Send after Close: %v", err)
	}
	// Close returns once the server's stdout ends.
	_ = serverOut.Close()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return")
	}
}

// A client that fails to connect after ready must not leave its delivery
// goroutine blocked on the unread Frames channel.
func TestFailedConnectReleasesGoroutines(t *testing.T) {
	baseline := runtime.NumGoroutine()
	s, r, w := newFakeServer(t)
	go func() {
		s.send(readyV2)
		s.respond(s.recv(), `{"protocolVersion":1}`)
	}()
	if _, err := NewClient(context.Background(), r, w); !errors.Is(err, ErrProtocol) {
		t.Fatalf("err = %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseline {
		if time.Now().After(deadline) {
			buf := make([]byte, 1<<16)
			t.Fatalf("%d goroutines left over (baseline %d):\n%s", runtime.NumGoroutine(), baseline, buf[:runtime.Stack(buf, true)])
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSendFailsAfterFatalError(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	s.send(chunkFrames("rpc-1", commandOutput(maxFrameBytes), chunkPayloadBytes)[0])
	waitClosed(t, c)
	if err := c.Send(HostToolResult{ID: "h1", Result: TextResult("x")}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("Send after a fatal error: %v", err)
	}
	s.expectSilence()
}

// A cancel processed while a finished host call waits to write suppresses
// its result. With the fix this passes deterministically; it catches a
// cancellation check made before taking the write lock whenever the result
// goroutine reaches that check during the 20 ms pause (practically always).
func TestHostToolCancelWhileWaitingToWrite(t *testing.T) {
	contexts := make(chan context.Context, 1)
	proceed := make(chan struct{})
	quick := HostTool{
		Definition: HostToolDefinition{Name: "quick", Description: "Returns at once.", Parameters: map[string]json.RawMessage{}},
		Handler: func(ctx context.Context, call *HostToolCall, args json.RawMessage) (HostToolResultPayload, error) {
			contexts <- ctx
			<-proceed
			return TextResult("done"), nil
		},
	}
	c, s := startFake(t, readyV1, func(s *fakeServer) {
		s.respond(s.recv(), `{"toolNames":["quick"]}`)
	}, WithHostTools(quick))

	c.writeMu.Lock()
	s.send(`{"type":"host_tool_call","id":"h1","toolCallId":"tc1","toolName":"quick","arguments":{}}`)
	ctx := <-contexts
	close(proceed)
	time.Sleep(20 * time.Millisecond) // the result goroutine is now waiting for writeMu
	s.send(`{"type":"host_tool_cancel","id":"c1","targetId":"h1"}`)
	<-ctx.Done()
	c.writeMu.Unlock()

	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		running := len(c.hostCalls)
		c.mu.Unlock()
		if running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("host call still running")
		}
		time.Sleep(time.Millisecond)
	}
	s.expectSilence()
}

// A call's cleanup must not remove the pending entry of a later call that
// reuses its id (WithRequestID).
func TestReleaseKeepsALaterOwner(t *testing.T) {
	c, _ := startFake(t, readyV1, nil)
	first, second := make(chan RpcResponse, 1), make(chan RpcResponse, 1)
	c.mu.Lock()
	c.pending["shared"] = pendingCall{command: "get_state", reply: second}
	c.mu.Unlock()
	c.release("shared", first)
	c.mu.Lock()
	_, kept := c.pending["shared"]
	c.mu.Unlock()
	if !kept {
		t.Fatal("the first call's cleanup removed the second call's entry")
	}
	c.release("shared", second)
	c.mu.Lock()
	_, kept = c.pending["shared"]
	c.mu.Unlock()
	if kept {
		t.Fatal("the owner's cleanup left its entry")
	}
}
