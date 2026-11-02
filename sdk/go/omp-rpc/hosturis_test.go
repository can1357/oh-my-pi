package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type uriRecorder struct {
	mu     sync.Mutex
	reads  []string
	writes [][2]string
}

func notesUris(record *uriRecorder) []HostUri {
	return []HostUri{
		{
			Scheme:      "  Notes ",
			Description: "Scratch notes",
			Read: func(ctx context.Context, url string) (HostUriReadResult, error) {
				record.mu.Lock()
				record.reads = append(record.reads, url)
				record.mu.Unlock()
				switch {
				case strings.HasSuffix(url, "/structured"):
					return HostUriReadResult{
						Content:     `{"a":1}`,
						ContentType: Ptr(HostUriResultContentTypeApplicationJSON),
						Notes:       []string{"first", "second"},
						Immutable:   Ptr(true),
					}, nil
				case strings.HasSuffix(url, "/fail"):
					return HostUriReadResult{}, errors.New("note missing")
				case strings.HasSuffix(url, "/block"):
					<-ctx.Done()
					return HostUriReadResult{Content: "too late"}, nil
				}
				return HostUriReadResult{Content: "note body"}, nil
			},
			Write: func(ctx context.Context, url, content string) error {
				record.mu.Lock()
				record.writes = append(record.writes, [2]string{url, content})
				record.mu.Unlock()
				return nil
			},
		},
		{
			Scheme:    "ro",
			Immutable: true,
			Read: func(ctx context.Context, url string) (HostUriReadResult, error) {
				return HostUriReadResult{Content: "fixed"}, nil
			},
		},
	}
}

func startWithUris(t *testing.T, record *uriRecorder) (*Client, *fakeServer) {
	t.Helper()
	return startFake(t, readyV1, func(s *fakeServer) {
		command := s.recv()
		want := `{"type":"set_host_uri_schemes","schemes":[{"scheme":"notes","description":"Scratch notes","writable":true,"immutable":false},{"scheme":"ro","writable":false,"immutable":true}]}`
		var got, expected map[string]json.RawMessage
		_ = json.Unmarshal([]byte(command.raw), &got)
		_ = json.Unmarshal([]byte(want), &expected)
		delete(got, "id")
		if string(got["schemes"]) != string(expected["schemes"]) || command.str("type") != "set_host_uri_schemes" {
			t.Errorf("registration %s", command.raw)
		}
		s.respond(command, `{"schemes":["notes","ro"]}`)
	}, WithHostUris(notesUris(record)...))
}

// uriResult reads the next host_uri_result and returns it without its type.
func uriResult(t *testing.T, s *fakeServer, id string) string {
	t.Helper()
	frame := s.recv()
	if frame.str("type") != "host_uri_result" || frame.str("id") != id {
		t.Fatalf("want host_uri_result %s, got %s", id, frame.raw)
	}
	return frame.raw
}

func TestHostUriReadsAndWrites(t *testing.T) {
	var record uriRecorder
	c, s := startWithUris(t, &record)
	s.send(`{"type":"host_uri_request","id":"u1","operation":"read","url":"notes://today"}`)
	if got := uriResult(t, s, "u1"); got != `{"type":"host_uri_result","id":"u1","content":"note body"}` {
		t.Fatalf("text read: %s", got)
	}
	s.send(`{"type":"host_uri_request","id":"u2","operation":"read","url":"NOTES://x/structured"}`)
	if got := uriResult(t, s, "u2"); got != `{"type":"host_uri_result","id":"u2","content":"{\"a\":1}","contentType":"application/json","notes":["first","second"],"immutable":true}` {
		t.Fatalf("structured read: %s", got)
	}
	s.send(`{"type":"host_uri_request","id":"u3","operation":"write","url":"notes://today","content":"written by model"}`)
	if got := uriResult(t, s, "u3"); got != `{"type":"host_uri_result","id":"u3"}` {
		t.Fatalf("write: %s", got)
	}
	s.send(`{"type":"host_uri_request","id":"u4","operation":"write","url":"notes://empty"}`)
	uriResult(t, s, "u4")
	record.mu.Lock()
	if strings.Join(record.reads, ",") != "notes://today,NOTES://x/structured" ||
		len(record.writes) != 2 || record.writes[0] != [2]string{"notes://today", "written by model"} || record.writes[1] != [2]string{"notes://empty", ""} {
		t.Fatalf("handlers saw reads %v writes %v", record.reads, record.writes)
	}
	record.mu.Unlock()

	// Host URI requests are consumed, not delivered.
	s.send(`{"type":"session_settled"}`)
	for frame := range c.Frames() {
		switch frame.Value.(type) {
		case ReadyEvent:
			continue
		case SessionSettledEvent:
		default:
			t.Fatalf("delivered %T", frame.Value)
		}
		break
	}
}

func TestHostUriErrors(t *testing.T) {
	var record uriRecorder
	_, s := startWithUris(t, &record)
	cases := []struct{ request, want string }{
		{`{"type":"host_uri_request","id":"e1","operation":"read","url":"zz://x"}`, `Host URI scheme \"zz://\" is not registered`},
		{`{"type":"host_uri_request","id":"e2","operation":"read","url":"no-scheme-here"}`, `Host URI scheme \"://\" is not registered`},
		{`{"type":"host_uri_request","id":"e3","operation":"write","url":"ro://x","content":"c"}`, `Host URI scheme \"ro://\" was not registered with a write handler`},
		{`{"type":"host_uri_request","id":"e4","operation":"delete","url":"notes://x"}`, `Unsupported host URI operation: delete`},
		{`{"type":"host_uri_request","id":"e5","operation":"read","url":"notes://x/fail"}`, `note missing`},
	}
	for i, tc := range cases {
		s.send(tc.request)
		id := "e" + string(rune('1'+i))
		want := `{"type":"host_uri_result","id":"` + id + `","isError":true,"error":"` + tc.want + `"}`
		if got := uriResult(t, s, id); got != want {
			t.Fatalf("%s:\n got %s\nwant %s", tc.request, got, want)
		}
	}
	// Frames with a non-string id, operation, or url are ignored.
	s.send(`{"type":"host_uri_request","id":7,"operation":"read","url":"notes://x"}`)
	s.expectSilence()
}

func TestHostUriCancelSuppressesResult(t *testing.T) {
	var record uriRecorder
	c, s := startWithUris(t, &record)
	s.send(`{"type":"host_uri_request","id":"u1","operation":"read","url":"notes://x/block"}`)
	for {
		record.mu.Lock()
		started := len(record.reads)
		record.mu.Unlock()
		if started > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	s.send(`{"type":"host_uri_cancel","id":"c1","targetId":"u1"}`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		running := len(c.uriCalls)
		c.mu.Unlock()
		if running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled host URI request still running")
		}
		time.Sleep(time.Millisecond)
	}
	s.expectSilence()
}

func TestHostUriRegistrationValidates(t *testing.T) {
	c, _ := startFake(t, readyV1, nil)
	if _, err := c.SetHostUris(context.Background(), []HostUri{{Scheme: "  ", Read: notesUris(&uriRecorder{})[1].Read}}); err == nil {
		t.Fatal("blank scheme accepted")
	}
	if _, err := c.SetHostUris(context.Background(), []HostUri{{Scheme: "x"}}); err == nil {
		t.Fatal("scheme without Read accepted")
	}
}
