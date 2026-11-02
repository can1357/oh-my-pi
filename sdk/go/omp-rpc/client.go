// Package omprpc is a Go client for the omp RPC protocol (`omp --mode rpc`):
// JSON lines over the server's stdin and stdout.
//
// wire.go is generated from the protocol's wire schema by `bun run gen:rpc`;
// it holds every frame type and one typed method per command on Commands.
// Client is the transport: it correlates responses, negotiates protocol v2
// (reassembling rpc_chunk sequences), waits for prompts, and runs host tools.
package omprpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultTimeout bounds a call whose command declares no timeout of its own.
const DefaultTimeout = 30 * time.Second

// ErrClosed is returned by calls made after, or interrupted by, the end of the
// connection. Err reports why it ended.
var ErrClosed = errors.New("omprpc: connection closed")

// CommandError is a failed command response (`success: false`).
type CommandError struct {
	Command string
	Message string
	// Code is the machine-readable reason (for example "unknown_since"), or "".
	Code string
}

func (e *CommandError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("omprpc: %s failed (%s): %s", e.Command, e.Code, e.Message)
	}
	return fmt.Sprintf("omprpc: %s failed: %s", e.Command, e.Message)
}

type requestIDKey struct{}

// WithRequestID makes the next call made with ctx use id instead of a
// generated `req_<n>`, so the caller can match a later frame that carries the
// same id (prompt_result).
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// EncodeCommand renders one command frame, `{"id":…,"type":…,…params}`,
// without the trailing newline. params must encode to a JSON object; nil means
// no parameters.
func EncodeCommand(id, command string, params any) ([]byte, error) {
	head, err := json.Marshal(struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}{id, command})
	if err != nil {
		return nil, err
	}
	if params == nil {
		return head, nil
	}
	body, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("omprpc: %s params: %w", command, err)
	}
	if isNull(body) {
		return head, nil
	}
	if len(body) < 2 || body[0] != '{' {
		return nil, fmt.Errorf("omprpc: %s params must encode to a JSON object", command)
	}
	if len(body) == 2 {
		return head, nil
	}
	return append(append(head[:len(head)-1], ','), body[1:]...), nil
}

// Option configures a Client.
type Option func(*Client)

// WithHostTools registers host tools; they are sent with set_host_tools once
// the connection is ready, before Start or NewClient returns.
func WithHostTools(tools ...HostTool) Option {
	return func(c *Client) {
		c.tools = slices.Clone(tools)
	}
}

type pendingCall struct {
	command string
	reply   chan RpcResponse
}

// Client is a connection to an omp RPC server. The embedded Commands provides
// the typed command methods; Client.GetMessages replaces the monolithic
// command with paging under protocol v2 (Commands.GetMessages remains).
type Client struct {
	Commands

	proc *process
	w    io.WriteCloser
	// writeMu orders whole lines on w; Close closes w without it so a write
	// blocked on a peer that stopped reading is released.
	writeMu sync.Mutex
	closing atomic.Bool
	nextID  atomic.Uint64
	v2      atomic.Bool
	chunks  chunkDecoder
	// reassembled counts frames rebuilt from rpc_chunk sequences.
	reassembled atomic.Uint64

	// ctx is canceled by Close and by the end of the connection; host tool
	// calls derive from it.
	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	pending   map[string]pendingCall
	prompts   map[string]*promptWait
	tools     []HostTool
	uris      []HostUri
	hostCalls map[string]context.CancelFunc
	uriCalls  map[string]context.CancelFunc
	hostNames map[string]string
	backlog   []RpcServerFrame
	cause     error
	wake      chan struct{}
	frames    chan RpcServerFrame
	// stopDelivery discards the backlog of a client that failed to connect.
	stopDelivery chan struct{}

	ready           ReadyEvent
	protocolVersion int
	readyOnce       sync.Once
	readyCh         chan struct{}
	closed          chan struct{}
	drained         chan struct{}

	closeOnce sync.Once
	closeErr  error
}

// Start starts cmd (for example `exec.Command("omp", "--mode", "rpc")`; set
// its Dir, Env, and Stderr as needed, and leave Stdin and Stdout nil) and
// connects to it with NewClient. On Unix the server runs in its own process
// group, so Close also stops the commands its tools started; cmd.WaitDelay
// defaults to one second.
func Start(ctx context.Context, cmd *exec.Cmd, options ...Option) (*Client, error) {
	proc, stdin, err := startProcess(cmd)
	if err != nil {
		return nil, err
	}
	return connect(ctx, proc.stdout, stdin, proc, options)
}

// NewClient connects over a server's stdout (r) and stdin (w): it waits for
// the ready frame, negotiates protocol v2 when the server advertises it with
// the standard limits, and registers WithHostTools tools and WithHostUris
// schemes. Close closes w and waits until r ends. w.Close must be safe while
// a Write is in progress and must unblock it (as for *os.File and
// *io.PipeWriter). When connecting fails, NewClient has already closed w and
// waited for r to end.
func NewClient(ctx context.Context, r io.Reader, w io.WriteCloser, options ...Option) (*Client, error) {
	return connect(ctx, r, w, nil, options)
}

func connect(ctx context.Context, r io.Reader, w io.WriteCloser, proc *process, options []Option) (*Client, error) {
	c := &Client{
		proc:            proc,
		w:               w,
		pending:         make(map[string]pendingCall),
		prompts:         make(map[string]*promptWait),
		hostCalls:       make(map[string]context.CancelFunc),
		uriCalls:        make(map[string]context.CancelFunc),
		hostNames:       make(map[string]string),
		wake:            make(chan struct{}, 1),
		frames:          make(chan RpcServerFrame),
		stopDelivery:    make(chan struct{}),
		protocolVersion: 1,
		readyCh:         make(chan struct{}),
		closed:          make(chan struct{}),
		drained:         make(chan struct{}),
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.Commands = Commands{Transport: c}
	for _, option := range options {
		option(c)
	}
	go c.read(r)
	go c.deliver()
	if err := c.handshake(ctx); err != nil {
		// Nobody will receive from Frames.
		close(c.stopDelivery)
		return nil, errors.Join(err, c.Close())
	}
	return c, nil
}

func (c *Client) handshake(ctx context.Context) error {
	select {
	case <-c.readyCh:
	case <-c.closed:
		select {
		case <-c.readyCh:
		default:
			return fmt.Errorf("omprpc: server stopped before ready: %w", c.Err())
		}
	case <-ctx.Done():
		return fmt.Errorf("omprpc: waiting for ready: %w", ctx.Err())
	}
	ready := c.ready
	if slices.Contains(ready.SupportedProtocolVersions, 2) &&
		ready.MaxFrameBytes != nil && *ready.MaxFrameBytes == maxFrameBytes &&
		ready.MaxReassembledFrameBytes != nil && *ready.MaxReassembledFrameBytes == maxReassembledFrameBytes {
		// Chunks may follow the negotiation response immediately.
		c.v2.Store(true)
		result, err := c.NegotiateProtocol(ctx, NegotiateProtocolCommand{ProtocolVersion: 2})
		if err != nil {
			return err
		}
		if result.ProtocolVersion != 2 {
			return fmt.Errorf("%w: protocol v2 negotiation returned version %d", ErrProtocol, result.ProtocolVersion)
		}
		c.protocolVersion = 2
	}
	if len(c.tools) > 0 {
		if _, err := c.SetCustomTools(ctx, c.tools); err != nil {
			return err
		}
	}
	if len(c.uris) > 0 {
		if _, err := c.SetHostUris(ctx, c.uris); err != nil {
			return err
		}
	}
	return nil
}

// Ready returns the server's ready frame.
func (c *Client) Ready() ReadyEvent {
	return c.ready
}

// ProtocolVersion is the negotiated protocol version: 2, or 1 when the server
// does not advertise v2 with the standard transport limits.
func (c *Client) ProtocolVersion() int {
	return c.protocolVersion
}

// Err is nil while the connection is open; afterwards it wraps ErrClosed and,
// for a transport violation, ErrProtocol.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cause
}

// Frames delivers every server frame the client does not consume, in order:
// notifications (session events after host tool renaming) and responses
// nobody waits for. Responses to calls and host tool and host URI requests
// are consumed. Frames that fail to decode arrive as UnknownNotification with
// Err set. Frames are buffered without bound until received; the channel
// closes once the connection ends and the backlog is drained.
func (c *Client) Frames() <-chan RpcServerFrame {
	return c.frames
}

// Call implements Transport: it writes one command frame and waits for the
// response with the same id. The deadline and ctx bound the wait for the
// response; writing the frame itself is preempted only by Close (a server
// that stops reading its stdin blocks the write).
func (c *Client) Call(ctx context.Context, command string, params any, timeout time.Duration) (json.RawMessage, error) {
	id, ok := ctx.Value(requestIDKey{}).(string)
	if !ok {
		id = "req_" + strconv.FormatUint(c.nextID.Add(1), 10)
	}
	frame, err := EncodeCommand(id, command, params)
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	reply := make(chan RpcResponse, 1)
	c.mu.Lock()
	if c.cause != nil {
		c.mu.Unlock()
		return nil, c.cause
	}
	if _, taken := c.pending[id]; taken {
		c.mu.Unlock()
		return nil, fmt.Errorf("omprpc: request id %q is already in flight", id)
	}
	c.pending[id] = pendingCall{command: command, reply: reply}
	c.mu.Unlock()
	defer c.release(id, reply)

	if err := c.write(context.Background(), frame); err != nil {
		return nil, err
	}
	select {
	case response := <-reply:
		return responseData(response)
	case <-c.closed:
		select {
		case response := <-reply:
			return responseData(response)
		default:
			return nil, c.Err()
		}
	case <-ctx.Done():
		return nil, fmt.Errorf("omprpc: %s: %w", command, ctx.Err())
	}
}

func responseData(response RpcResponse) (json.RawMessage, error) {
	if response.Success {
		return response.Data, nil
	}
	return nil, commandError(response)
}

func commandError(response RpcResponse) *CommandError {
	failure := &CommandError{Command: response.Command}
	if response.Error != nil {
		failure.Message = *response.Error
	}
	if response.Code != nil {
		failure.Code = *response.Code
	}
	return failure
}

// release removes the pending entry of a call, unless a later call reusing
// the id (WithRequestID) already owns it.
func (c *Client) release(id string, reply chan RpcResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if call, ok := c.pending[id]; ok && call.reply == reply {
		delete(c.pending, id)
	}
}

// Send writes a non-command frame: an extension UI response, a host tool
// update or result, or a host URI result. It fails once the connection has
// ended or Close was called.
func (c *Client) Send(frame RpcInboundVariant) error {
	return c.sendFor(context.Background(), frame)
}

// sendFor is Send for a frame of a host call: it is dropped when call is
// canceled by the time the write owns the stream.
func (c *Client) sendFor(call context.Context, frame RpcInboundVariant) error {
	data, err := json.Marshal(RpcInbound{Value: frame})
	if err != nil {
		return err
	}
	return c.write(call, data)
}

func (c *Client) write(call context.Context, frame []byte) error {
	if err := c.Err(); err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if call.Err() != nil {
		return nil
	}
	if c.closing.Load() {
		return ErrClosed
	}
	if err := c.Err(); err != nil {
		return err
	}
	if _, err := c.w.Write(append(frame, '\n')); err != nil {
		if c.closing.Load() {
			return fmt.Errorf("%w: %w", ErrClosed, err)
		}
		return fmt.Errorf("omprpc: write: %w", err)
	}
	return nil
}

// Close cancels in-flight host calls and closes the server's stdin (releasing
// a write blocked on it). For NewClient it then waits until the server's
// stdout ends. For Start it tears the process down like the Python client:
// SIGTERM to the process group, up to a second for the server to exit, then
// SIGKILL to the group; it returns an error only when a process survives.
// Close is bounded for Start and required even after the connection ended on
// its own or on a fatal protocol error. Unreceived frames stay available on
// Frames.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		c.closing.Store(true)
		c.cancel()
		_ = c.w.Close()
		if c.proc != nil {
			c.closeErr = c.proc.stop(c.drained)
			return
		}
		<-c.drained
	})
	return c.closeErr
}

func (c *Client) read(r io.Reader) {
	defer close(c.drained)
	reader := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := reader.ReadBytes('\n')
		// After a fatal error, keep draining so the server never blocks on stdout.
		if line = bytes.TrimSpace(line); len(line) > 0 && c.Err() == nil {
			if fatal := c.handleLine(line); fatal != nil {
				c.shutdown(fmt.Errorf("%w: %w", ErrClosed, fatal))
			}
		}
		if err != nil {
			break
		}
	}
	c.shutdown(ErrClosed)
}

// shutdown ends the connection once: pending calls and prompt waits fail with
// cause, host tool calls are canceled, and Frames closes after its backlog.
func (c *Client) shutdown(cause error) {
	c.mu.Lock()
	if c.cause != nil {
		c.mu.Unlock()
		return
	}
	c.cause = cause
	c.mu.Unlock()
	c.cancel()
	close(c.closed)
	c.signal()
}

func (c *Client) handleLine(line []byte) error {
	chunk := isChunk(line)
	if chunk && !c.v2.Load() {
		return protocolError("RPC chunk received before protocol negotiation")
	}
	frame, err := c.chunks.push(line, chunk)
	if err != nil || frame == nil {
		return err
	}
	if chunk {
		c.reassembled.Add(1)
	}
	c.dispatch(frame)
	return nil
}

func (c *Client) dispatch(line []byte) {
	var frame RpcServerFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		// Host requests are answered even when malformed (bad arguments or operation).
		switch tag := peekTag(line, "type"); tag {
		case "host_tool_call":
			c.handleHostToolCall(line)
			return
		case "host_uri_request":
			c.handleHostUriRequest(line)
			return
		default:
			frame.Value = UnknownNotification{Type: tag, Raw: line, Err: err}
		}
	}
	switch value := frame.Value.(type) {
	case RpcResponse:
		if c.handleResponse(value) {
			return
		}
	case HostToolCallRequest:
		c.handleHostToolCall(line)
		return
	case HostToolCancelRequest:
		c.cancelCall(c.hostCalls, value.TargetID)
		return
	case HostUriRequest:
		c.handleHostUriRequest(line)
		return
	case HostUriCancelRequest:
		c.cancelCall(c.uriCalls, value.TargetID)
		return
	case ToolExecutionUpdateEvent:
		value.ToolName = c.hostToolName(value.ToolCallID, value.ToolName, false)
		frame.Value = value
	case ToolExecutionEndEvent:
		value.ToolName = c.hostToolName(value.ToolCallID, value.ToolName, true)
		frame.Value = value
	case ReadyEvent:
		c.readyOnce.Do(func() {
			c.ready = value
			close(c.readyCh)
		})
	case PromptResultEvent:
		if value.ID != nil {
			c.mu.Lock()
			if wait := c.prompts[*value.ID]; wait != nil {
				wait.finish(&value, nil)
			}
			c.mu.Unlock()
		}
	}
	if _, unknown := frame.Value.(UnknownNotification); !unknown {
		if event, ok := frame.Value.(RpcAgentEventVariant); ok {
			c.mu.Lock()
			for _, wait := range c.prompts {
				wait.collect(RpcAgentEvent{Value: event})
			}
			c.mu.Unlock()
		}
	}
	c.mu.Lock()
	c.backlog = append(c.backlog, frame)
	c.mu.Unlock()
	c.signal()
}

// cancelCall cancels the host tool call or host URI request id in calls.
func (c *Client) cancelCall(calls map[string]context.CancelFunc, id string) {
	c.mu.Lock()
	cancel := calls[id]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// handleResponse routes a response to its call, or a late failure to its
// prompt wait; false leaves it for Frames.
func (c *Client) handleResponse(response RpcResponse) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if response.ID != nil {
		if call, ok := c.pending[*response.ID]; ok {
			delete(c.pending, *response.ID)
			call.reply <- response
			return true
		}
		if wait := c.prompts[*response.ID]; wait != nil && !response.Success {
			wait.finish(nil, commandError(response))
			return true
		}
		return false
	}
	if response.Success {
		return false
	}
	// A failure without an id (a dispatch failure) belongs to the only pending
	// call of that command, or to the only pending call for a parse failure.
	var target string
	matches := 0
	for id, call := range c.pending {
		if call.command == response.Command {
			target = id
			matches++
		}
	}
	if matches != 1 && response.Command == "parse" && len(c.pending) == 1 {
		for id := range c.pending {
			target = id
		}
		matches = 1
	}
	if matches != 1 {
		return false
	}
	call := c.pending[target]
	delete(c.pending, target)
	call.reply <- response
	return true
}

func (c *Client) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// deliver moves the backlog to the Frames channel so a slow consumer never
// blocks the reader (and with it, command responses).
func (c *Client) deliver() {
	defer close(c.frames)
	for {
		c.mu.Lock()
		batch, finished := c.backlog, c.cause != nil
		c.backlog = nil
		c.mu.Unlock()
		for _, frame := range batch {
			select {
			case c.frames <- frame:
			case <-c.stopDelivery:
				return
			}
		}
		if len(batch) == 0 {
			if finished {
				return
			}
			select {
			case <-c.wake:
			case <-c.stopDelivery:
				return
			}
		}
	}
}
