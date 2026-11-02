package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// HostUri serves a URI scheme (`notes://…`) from the host: the agent's reads
// of such URLs, and writes when Write is set, run these handlers.
type HostUri struct {
	// Scheme is registered trimmed and lowercased; it must not be empty.
	Scheme      string
	Description string
	// Immutable tells the agent the content never changes.
	Immutable bool
	// Read serves a read of url; required.
	Read func(ctx context.Context, url string) (HostUriReadResult, error)
	// Write stores content at url; nil registers the scheme read-only.
	Write func(ctx context.Context, url, content string) error
}

// HostUriReadResult is what a read returns; only Content is required.
type HostUriReadResult struct {
	Content     string
	ContentType *HostUriResultContentType
	Notes       []string
	Immutable   *bool
}

// WithHostUris registers host URI schemes; they are sent with
// set_host_uri_schemes once the connection is ready (after host tools),
// before Start or NewClient returns.
func WithHostUris(uris ...HostUri) Option {
	return func(c *Client) {
		c.uris = slices.Clone(uris)
	}
}

// SetHostUris replaces the host URI schemes: it records their handlers and
// sends set_host_uri_schemes, returning the schemes the server registered.
// A scheme that is empty after trimming, or a nil Read, is an error.
func (c *Client) SetHostUris(ctx context.Context, uris []HostUri) ([]string, error) {
	registered := slices.Clone(uris)
	definitions := make([]HostUriSchemeDefinition, len(registered))
	for i := range registered {
		uri := &registered[i]
		uri.Scheme = strings.ToLower(strings.TrimSpace(uri.Scheme))
		if uri.Scheme == "" {
			return nil, errors.New("omprpc: host URI scheme must be a non-empty string")
		}
		if uri.Read == nil {
			return nil, fmt.Errorf("omprpc: host URI scheme %q has no Read handler", uri.Scheme)
		}
		definitions[i] = HostUriSchemeDefinition{
			Scheme:    uri.Scheme,
			Writable:  Ptr(uri.Write != nil),
			Immutable: Ptr(uri.Immutable),
		}
		if uri.Description != "" {
			definitions[i].Description = Ptr(uri.Description)
		}
	}
	c.mu.Lock()
	c.uris = registered
	c.mu.Unlock()
	return c.SetHostURISchemes(ctx, SetHostURISchemesCommand{Schemes: definitions})
}

func hostUriError(id, message string) HostUriResult {
	return HostUriResult{ID: id, Error: Ptr(message), IsError: Ptr(true)}
}

// uriScheme is the lowercased text before the first ':' of url when it is a
// valid scheme (`[A-Za-z][A-Za-z0-9+.-]*`), else "".
func uriScheme(url string) string {
	end := strings.IndexByte(url, ':')
	if end <= 0 {
		return ""
	}
	for i, c := range []byte(url[:end]) {
		letter := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !letter && (i == 0 || !(c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-')) {
			return ""
		}
	}
	return strings.ToLower(url[:end])
}

func (c *Client) handleHostUriRequest(line []byte) {
	var request struct {
		ID        *string         `json:"id"`
		Operation *string         `json:"operation"`
		URL       *string         `json:"url"`
		Content   json.RawMessage `json:"content"`
	}
	if json.Unmarshal(line, &request) != nil || request.ID == nil || request.Operation == nil || request.URL == nil {
		return
	}
	id, operation, url := *request.ID, *request.Operation, *request.URL
	if operation != string(HostUriOperationRead) && operation != string(HostUriOperationWrite) {
		_ = c.Send(hostUriError(id, "Unsupported host URI operation: "+operation))
		return
	}
	scheme := uriScheme(url)
	var uri *HostUri
	c.mu.Lock()
	for i := range c.uris {
		if c.uris[i].Scheme == scheme {
			found := c.uris[i]
			uri = &found
		}
	}
	c.mu.Unlock()
	if uri == nil {
		_ = c.Send(hostUriError(id, `Host URI scheme "`+scheme+`://" is not registered`))
		return
	}
	if operation == string(HostUriOperationWrite) && uri.Write == nil {
		_ = c.Send(hostUriError(id, `Host URI scheme "`+scheme+`://" was not registered with a write handler`))
		return
	}
	var content string
	if json.Unmarshal(request.Content, &content) != nil && jsonKind(request.Content) != 'n' {
		content = string(request.Content)
	}

	ctx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.uriCalls[id] = cancel
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.uriCalls, id)
			c.mu.Unlock()
			cancel()
		}()
		// sendFor drops the frame when the request is canceled by the time it owns the stream.
		result, err := runHostUri(ctx, uri, operation, url, content)
		if err != nil {
			_ = c.sendFor(ctx, hostUriError(id, err.Error()))
			return
		}
		result.ID = id
		_ = c.sendFor(ctx, result)
	}()
}

// runHostUri runs a handler, reporting a panic as its error.
func runHostUri(ctx context.Context, uri *HostUri, operation, url, content string) (result HostUriResult, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("host URI handler panicked: %v", recovered)
		}
	}()
	if operation == string(HostUriOperationWrite) {
		return HostUriResult{}, uri.Write(ctx, url, content)
	}
	read, err := uri.Read(ctx, url)
	if err != nil {
		return HostUriResult{}, err
	}
	if read.ContentType != nil {
		switch *read.ContentType {
		case HostUriResultContentTypeTextMarkdown, HostUriResultContentTypeApplicationJSON, HostUriResultContentTypeTextPlain:
		default:
			return HostUriResult{}, fmt.Errorf("Unsupported content_type: %q", *read.ContentType)
		}
	}
	return HostUriResult{Content: Ptr(read.Content), ContentType: read.ContentType, Notes: read.Notes, Immutable: read.Immutable}, nil
}
