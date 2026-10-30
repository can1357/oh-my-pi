package omprpc

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
)

// HostTool is a tool the agent can call that runs in the host process.
type HostTool struct {
	// Definition is sent with set_host_tools; Parameters is a JSON Schema object.
	Definition HostToolDefinition
	Handler    HostToolHandler
}

// HostToolHandler runs one call. args is the call's JSON object. ctx is
// canceled when the server cancels the call (host_tool_cancel) or the client
// closes; nothing is sent for a canceled call. An error becomes an isError
// result carrying its text.
type HostToolHandler func(ctx context.Context, call *HostToolCall, args json.RawMessage) (HostToolResultPayload, error)

// HostToolCall describes one host tool invocation.
type HostToolCall struct {
	// ToolCallID is the agent's tool call id (tool_execution_* events carry it).
	ToolCallID string
	update     func(HostToolResultPayload) error
}

// SendUpdate streams a partial result; it does nothing once the call is canceled.
func (h *HostToolCall) SendUpdate(partial HostToolResultPayload) error {
	return h.update(partial)
}

// TextResult is a result holding one text block.
func TextResult(text string) HostToolResultPayload {
	return HostToolResultPayload{Content: []UserContent{{Value: TextContent{Text: text}}}}
}

func hostToolError(id, message string) HostToolResult {
	payload := TextResult(message)
	payload.Details = json.RawMessage("{}")
	return HostToolResult{ID: id, Result: payload, IsError: Ptr(true)}
}

// SetCustomTools replaces the host tools: it records their handlers and sends
// their definitions with set_host_tools, returning the names the server
// registered.
func (c *Client) SetCustomTools(ctx context.Context, tools []HostTool) ([]string, error) {
	definitions := make([]HostToolDefinition, len(tools))
	for i, tool := range tools {
		definitions[i] = tool.Definition
	}
	c.mu.Lock()
	c.tools = slices.Clone(tools)
	c.mu.Unlock()
	return c.SetHostTools(ctx, SetHostToolsCommand{Tools: definitions})
}

// hostToolName renames a tool_execution_* event of a dispatched host call to
// the host tool that ran: tools mounted as xd:// devices run through `write`.
func (c *Client) hostToolName(toolCallID, toolName string, end bool) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	name, ok := c.hostNames[toolCallID]
	if !ok {
		return toolName
	}
	if end {
		delete(c.hostNames, toolCallID)
	}
	return name
}

func (c *Client) handleHostToolCall(line []byte) {
	var request struct {
		ID         *string         `json:"id"`
		ToolCallID *string         `json:"toolCallId"`
		ToolName   *string         `json:"toolName"`
		Arguments  json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(line, &request) != nil || request.ID == nil || request.ToolCallID == nil || request.ToolName == nil {
		return
	}
	id, toolName := *request.ID, *request.ToolName
	c.mu.Lock()
	c.hostNames[*request.ToolCallID] = toolName
	var handler HostToolHandler
	for _, tool := range c.tools {
		if tool.Definition.Name == toolName {
			handler = tool.Handler
		}
	}
	c.mu.Unlock()
	if jsonKind(request.Arguments) != '{' {
		_ = c.Send(hostToolError(id, "Host tool arguments must be an object"))
		return
	}
	if handler == nil {
		_ = c.Send(hostToolError(id, `Host tool "`+toolName+`" is not registered`))
		return
	}

	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.hostCalls[id] = cancel
	c.mu.Unlock()
	call := &HostToolCall{
		ToolCallID: *request.ToolCallID,
		update: func(partial HostToolResultPayload) error {
			return c.sendFor(ctx, HostToolUpdate{ID: id, PartialResult: partial})
		},
	}
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.hostCalls, id)
			c.mu.Unlock()
			cancel()
		}()
		// sendFor drops the frame when the call is canceled by the time it owns the stream.
		result, err := runHostTool(ctx, handler, call, request.Arguments)
		if err != nil {
			_ = c.sendFor(ctx, hostToolError(id, err.Error()))
			return
		}
		_ = c.sendFor(ctx, HostToolResult{ID: id, Result: result})
	}()
}

// runHostTool reports a handler panic as its error, as the reference clients
// report a raised exception.
func runHostTool(ctx context.Context, handler HostToolHandler, call *HostToolCall, args json.RawMessage) (result HostToolResultPayload, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("host tool panicked: %v", recovered)
		}
	}()
	return handler(ctx, call, args)
}
