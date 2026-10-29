package omprpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

const (
	readyV1 = `{"type":"ready","protocolVersion":1}`
	readyV2 = `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`
)

// fakeServer is a scripted RPC server on in-memory pipes.
type fakeServer struct {
	t     *testing.T
	out   *io.PipeWriter
	lines chan []byte
}

// received is one frame the client wrote.
type received struct {
	raw    string
	fields map[string]json.RawMessage
}

func (r received) str(key string) string {
	var value string
	_ = json.Unmarshal(r.fields[key], &value)
	return value
}

func newFakeServer(t *testing.T) (*fakeServer, io.Reader, io.WriteCloser) {
	clientIn, serverOut := io.Pipe()
	serverIn, clientOut := io.Pipe()
	s := &fakeServer{t: t, out: serverOut, lines: make(chan []byte, 64)}
	go func() {
		reader := bufio.NewReader(serverIn)
		for {
			line, err := reader.ReadBytes('\n')
			if line = bytes.TrimSpace(line); len(line) > 0 {
				s.lines <- line
			}
			if err != nil {
				break
			}
		}
		close(s.lines)
		// The client closed stdin: the server exits.
		_ = serverOut.Close()
	}()
	return s, clientIn, clientOut
}

func (s *fakeServer) send(frames ...string) {
	for _, frame := range frames {
		if _, err := io.WriteString(s.out, frame+"\n"); err != nil {
			s.t.Errorf("fake server write: %v", err)
			return
		}
	}
}

func (s *fakeServer) recv() received {
	select {
	case line, ok := <-s.lines:
		if !ok {
			s.t.Errorf("fake server: client closed stdin")
			return received{}
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(line, &fields); err != nil {
			s.t.Errorf("fake server: bad frame %s: %v", line, err)
		}
		return received{raw: string(line), fields: fields}
	case <-time.After(5 * time.Second):
		s.t.Errorf("fake server: no frame from the client")
		return received{}
	}
}

// expectSilence fails when the client writes anything within a short window.
func (s *fakeServer) expectSilence() {
	select {
	case line := <-s.lines:
		s.t.Errorf("fake server: unexpected frame %s", line)
	case <-time.After(100 * time.Millisecond):
	}
}

func (s *fakeServer) respond(command received, data string) {
	s.send(fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":true,"data":%s}`, command.str("id"), command.str("type"), data))
}

func (s *fakeServer) fail(command received, code, message string) {
	s.send(fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":false,"error":%q,"code":%q}`, command.str("id"), command.str("type"), message, code))
}

// startFake connects a client to a fake server; handshake plays the server's
// side of NewClient after the ready frame.
func startFake(t *testing.T, ready string, handshake func(s *fakeServer), options ...Option) (*Client, *fakeServer) {
	t.Helper()
	s, r, w := newFakeServer(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.send(ready)
		if handshake != nil {
			handshake(s)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := NewClient(ctx, r, w, options...)
	<-done
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() {
		_ = c.Close()
	})
	return c, s
}

// negotiateV2 answers the client's negotiate_protocol.
func negotiateV2(s *fakeServer) {
	command := s.recv()
	if command.str("type") != "negotiate_protocol" || string(command.fields["protocolVersion"]) != "2" {
		s.t.Errorf("expected negotiate_protocol v2, got %s", command.raw)
	}
	s.respond(command, `{"protocolVersion":2}`)
}

// nextFrame returns the next frame of type T, skipping others.
func nextFrame[T RpcServerFrameVariant](t *testing.T, c *Client) T {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-c.Frames():
			if !ok {
				var zero T
				t.Fatalf("frames closed waiting for %T: %v", zero, c.Err())
			}
			if value, ok := frame.Value.(T); ok {
				return value
			}
		case <-timeout:
			var zero T
			t.Fatalf("no %T frame", zero)
		}
	}
}

// waitClosed waits until the connection ends and returns why.
func waitClosed(t *testing.T, c *Client) error {
	t.Helper()
	select {
	case <-c.closed:
		return c.Err()
	case <-time.After(5 * time.Second):
		t.Fatal("connection still open")
		return nil
	}
}

// chunkFrames splits frame into rpc_chunk frames of at most size payload bytes.
func chunkFrames(id string, frame []byte, size int) []string {
	count := (len(frame) + size - 1) / size
	chunks := make([]string, 0, count)
	for index := range count {
		piece := frame[index*size : min((index+1)*size, len(frame))]
		chunks = append(chunks, fmt.Sprintf(`{"type":"rpc_chunk","chunkId":%q,"index":%d,"count":%d,"byteLength":%d,"data":%q}`,
			id, index, count, len(frame), base64.StdEncoding.EncodeToString(piece)))
	}
	return chunks
}

// commandOutput is a command_output frame of exactly size bytes.
func commandOutput(size int) []byte {
	head := `{"type":"command_output","text":"`
	return []byte(head + strings.Repeat("x", size-len(head)-2) + `"}`)
}
