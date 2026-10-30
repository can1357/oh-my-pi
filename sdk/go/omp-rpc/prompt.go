package omprpc

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DefaultPromptTimeout bounds PromptAndWait when it is given no timeout.
const DefaultPromptTimeout = 60 * time.Second

// PromptTurn is what PromptAndWait collected for one prompt.
type PromptTurn struct {
	// Events are the session events received from submission up to the
	// prompt's own prompt_result, in arrival order.
	Events []RpcAgentEvent
	// Messages are the messages of the last agent_end in Events, completed
	// from streamed message_end events when the frame was compacted.
	Messages []AgentMessage
	// AssistantMessage is the last assistant message of Messages, else the last
	// one any event carried; nil when there is none.
	AssistantMessage *AssistantMessage
	// AssistantText joins the visible text blocks of AssistantMessage; nil
	// when it has none.
	AssistantText *string
	// Result is the prompt's prompt_result; nil when the server handled the
	// prompt locally (`agentInvoked: false`).
	Result *PromptResultEvent
}

// promptWait collects the session events of one PromptAndWait call; the
// reader feeds it under Client.mu.
type promptWait struct {
	events   []RpcAgentEvent
	result   *PromptResultEvent
	err      error
	finished bool
	done     chan struct{}
}

func (w *promptWait) collect(event RpcAgentEvent) {
	if !w.finished {
		w.events = append(w.events, event)
	}
}

func (w *promptWait) finish(result *PromptResultEvent, err error) {
	if w.finished {
		return
	}
	w.finished = true
	w.result, w.err = result, err
	close(w.done)
}

// PromptAndWait submits a prompt and waits for its own prompt_result, i.e.
// until the agent yields. A stale agent_end or another prompt's result does
// not end the wait. A failure response for the same request id after the
// acknowledgement fails it with a *CommandError; the end of the connection
// fails it with ErrClosed; the deadline (timeout, or DefaultPromptTimeout when
// zero) with context.DeadlineExceeded.
//
// Concurrent calls are allowed: each waits for its own request id, and each
// collects every session event received while it waits, because events do not
// name the prompt that caused them.
func (c *Client) PromptAndWait(ctx context.Context, p PromptCommand, timeout time.Duration) (PromptTurn, error) {
	if timeout <= 0 {
		timeout = DefaultPromptTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	id, ok := ctx.Value(requestIDKey{}).(string)
	if !ok {
		id = "req_" + strconv.FormatUint(c.nextID.Add(1), 10)
	}

	// Registered before the command is written: the result may precede the ack.
	wait := &promptWait{done: make(chan struct{})}
	c.mu.Lock()
	if _, taken := c.prompts[id]; taken {
		c.mu.Unlock()
		return PromptTurn{}, fmt.Errorf("omprpc: prompt id %q is already waiting", id)
	}
	c.prompts[id] = wait
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.prompts, id)
		c.mu.Unlock()
	}()

	ack, err := c.Prompt(WithRequestID(ctx, id), p)
	if err != nil {
		return PromptTurn{}, err
	}
	if ack.AgentInvoked != nil && !*ack.AgentInvoked {
		c.mu.Lock()
		events := wait.events
		wait.finished = true
		c.mu.Unlock()
		return buildPromptTurn(events, nil)
	}
	select {
	case <-wait.done:
	case <-c.closed:
		select {
		case <-wait.done:
		default:
			return PromptTurn{}, c.Err()
		}
	case <-ctx.Done():
		return PromptTurn{}, fmt.Errorf("omprpc: waiting for prompt_result: %w", ctx.Err())
	}
	c.mu.Lock()
	events, result, failure := wait.events, wait.result, wait.err
	c.mu.Unlock()
	if failure != nil {
		return PromptTurn{}, failure
	}
	return buildPromptTurn(events, result)
}

func buildPromptTurn(events []RpcAgentEvent, result *PromptResultEvent) (PromptTurn, error) {
	turn := PromptTurn{Events: events, Result: result}
	for i := len(events) - 1; i >= 0; i-- {
		if end, ok := events[i].Value.(AgentEndEvent); ok {
			messages, err := completeAgentEndMessages(events[:i], end)
			if err != nil {
				return PromptTurn{}, err
			}
			turn.Messages = messages
			break
		}
	}
	for i := len(turn.Messages) - 1; i >= 0 && turn.AssistantMessage == nil; i-- {
		if message, ok := turn.Messages[i].Value.(AssistantMessage); ok {
			turn.AssistantMessage = &message
		}
	}
	for i := len(events) - 1; i >= 0 && turn.AssistantMessage == nil; i-- {
		var carried AgentMessage
		switch event := events[i].Value.(type) {
		case MessageStartEvent:
			carried = event.Message
		case MessageUpdateEvent:
			carried = event.Message
		case MessageEndEvent:
			carried = event.Message
		case TurnEndEvent:
			carried = event.Message
		}
		if message, ok := carried.Value.(AssistantMessage); ok {
			turn.AssistantMessage = &message
		}
	}
	if turn.AssistantMessage != nil {
		var text strings.Builder
		for _, block := range turn.AssistantMessage.Content {
			if content, ok := block.Value.(TextContent); ok {
				text.WriteString(content.Text)
			}
		}
		if text.Len() > 0 {
			turn.AssistantText = Ptr(text.String())
		}
	}
	return turn, nil
}

// completeAgentEndMessages restores the prefix a compacted agent_end dropped
// (`messageCount` > len(messages)) from the run's streamed message_end events.
func completeAgentEndMessages(before []RpcAgentEvent, end AgentEndEvent) ([]AgentMessage, error) {
	if end.MessageCount == nil || *end.MessageCount <= int64(len(end.Messages)) {
		return end.Messages, nil
	}
	runStart := 0
	for i := len(before) - 1; i >= 0; i-- {
		if _, ok := before[i].Value.(AgentStartEvent); ok {
			runStart = i + 1
			break
		}
	}
	var streamed []AgentMessage
	for _, event := range before[runStart:] {
		if message, ok := event.Value.(MessageEndEvent); ok {
			streamed = append(streamed, message.Message)
		}
	}
	prefix := int(*end.MessageCount) - len(end.Messages)
	if prefix > len(streamed) {
		return nil, fmt.Errorf("omprpc: compacted agent_end references %d streamed messages, but only %d were retained", prefix, len(streamed))
	}
	return append(streamed[:prefix:prefix], end.Messages...), nil
}

// messagesPageLimit is the page size GetMessages requests.
const messagesPageLimit = 256

// GetMessages returns every message of the session. Under protocol v2 it pages
// with get_messages_page so no response exceeds the transport limits, falling
// back to the monolithic get_messages when the session changes mid-way; under
// v1 it sends get_messages.
func (c *Client) GetMessages(ctx context.Context) ([]AgentMessage, error) {
	if c.protocolVersion == 2 {
		messages, err := c.pageMessages(ctx)
		var failure *CommandError
		if err == nil || !errors.As(err, &failure) || failure.Command != "get_messages_page" ||
			(failure.Code != "session_busy" && failure.Code != "stale_cursor" &&
				failure.Message != "Cannot page messages while the session is changing" &&
				failure.Message != "RPC message cursor is stale") {
			return messages, err
		}
	}
	return c.Commands.GetMessages(ctx)
}

func (c *Client) pageMessages(ctx context.Context) ([]AgentMessage, error) {
	var messages []AgentMessage
	seen := make(map[string]bool)
	total := int64(-1)
	var cursor *string
	for {
		page, err := c.GetMessagesPage(ctx, GetMessagesPageCommand{Cursor: cursor, Limit: Ptr(int64(messagesPageLimit))})
		if err != nil {
			return nil, err
		}
		if total >= 0 && page.TotalMessages != total {
			return nil, errors.New("omprpc: RPC message pagination returned an inconsistent total")
		}
		total = page.TotalMessages
		messages = append(messages, page.Messages...)
		cursor = page.NextCursor
		if cursor == nil {
			break
		}
		if seen[*cursor] {
			return nil, errors.New("omprpc: RPC message pagination repeated a cursor")
		}
		seen[*cursor] = true
	}
	if int64(len(messages)) != total {
		return nil, errors.New("omprpc: RPC message pagination ended before the advertised total")
	}
	return messages, nil
}
