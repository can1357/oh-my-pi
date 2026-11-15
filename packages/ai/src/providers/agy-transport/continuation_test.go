//go:build protolegacy

package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const continuationTestRequest = `{"project":"p","requestId":"agent/cascade/1/trajectory/3","request":{"contents":[{"role":"user","parts":[{"text":"wire input"}]}],"labels":{"request_id":"trajectory-1","last_step_index":"2"},"generationConfig":{"maxOutputTokens":256},"sessionId":"-3750763034362895579"},"model":"m","requestType":"agent"}`
const continuationFirst = `{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]},"finishReason":"CONTINUATION","continuationToken":"Y2hlY2twb2ludC0x"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":2,"candidatesTokenCount":10,"totalTokenCount":112}}}`
const continuationLast = `{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"B"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":110,"cachedContentTokenCount":25,"thoughtsTokenCount":1,"candidatesTokenCount":5,"totalTokenCount":116}}}`

type continuationFixture struct {
	bodies [][]byte
	mu     sync.Mutex
	serve  func(http.ResponseWriter, *http.Request, int)
}

func (fixture *continuationFixture) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		http.Error(writer, err.Error(), 400)
		return
	}
	fixture.mu.Lock()
	index := len(fixture.bodies)
	fixture.bodies = append(fixture.bodies, body)
	fixture.mu.Unlock()
	writer.Header().Set("Content-Type", "text/event-stream")
	fixture.serve(writer, request, index)
}
func runContinuationFixture(t *testing.T, fixture *continuationFixture, original string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), tlsTestTimeout)
	defer cancel()
	return runContinuationFixtureContext(t, ctx, fixture, original)
}

func runContinuationFixtureContext(t *testing.T, ctx context.Context, fixture *continuationFixture, original string) (string, error) {
	t.Helper()
	server := httptest.NewServer(fixture)
	defer server.Close()
	descriptor, err := requestDescriptor()
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, io.NopCloser(strings.NewReader(original)))
	if err != nil {
		t.Fatal(err)
	}
	// Keep compressed responses intact so the bridge's decompression is exercised.
	request.Header.Set("Accept-Encoding", "gzip")
	transport := server.Client().Transport
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	err = streamCCPA(ctx, recorder, transport, request, response, []byte(original), descriptor)
	return recorder.Body.String(), err
}
func sseEvent(writer http.ResponseWriter, event string) {
	io.WriteString(writer, "data: "+event+"\n\n")
	writer.(http.Flusher).Flush()
}
func decodeContinuationEvents(t *testing.T, stream string) []map[string]json.RawMessage {
	t.Helper()
	var events []map[string]json.RawMessage
	if err := readCCPAEvents(strings.NewReader(stream), func(raw []byte) error {
		var event map[string]json.RawMessage
		if err := json.Unmarshal(raw, &event); err != nil {
			return err
		}
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

func continuationOutput(t *testing.T, stream string) (string, string, map[string]int64) {
	t.Helper()
	var text strings.Builder
	var finish string
	var usage map[string]int64
	for _, event := range decodeContinuationEvents(t, stream) {
		var response struct {
			Candidates []struct {
				FinishReason string `json:"finishReason"`
				Content      struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
			Usage map[string]int64 `json:"usageMetadata"`
		}
		if err := json.Unmarshal(event["response"], &response); err != nil {
			t.Fatal(err)
		}
		for _, candidate := range response.Candidates {
			for _, part := range candidate.Content.Parts {
				text.WriteString(part.Text)
			}
			if candidate.FinishReason != "" {
				finish = candidate.FinishReason
			}
		}
		if response.Usage != nil {
			usage = response.Usage
		}
	}
	return text.String(), finish, usage
}

func interruptContinuationResponse(writer http.ResponseWriter) {
	connection, _, err := writer.(http.Hijacker).Hijack()
	if err != nil {
		panic(err)
	}
	connection.Close()
}

func TestContinuationPreservesRequestAndAggregatesUsage(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
		switch index {
		case 0:
			sseEvent(writer, continuationFirst)
		case 1:
			sseEvent(writer, continuationLast)
		default:
			http.Error(writer, "unexpected third leg", 500)
		}
	}}
	output, err := runContinuationFixture(t, fixture, continuationTestRequest)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.bodies) != 2 {
		t.Fatalf("continuation dial count=%d, want 2", len(fixture.bodies))
	}
	var first, next map[string]json.RawMessage
	if err = json.Unmarshal(fixture.bodies[0], &first); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(fixture.bodies[1], &next); err != nil {
		t.Fatal(err)
	}
	var id string
	json.Unmarshal(next["requestId"], &id)
	parts := strings.Split(id, "/")
	if len(parts) != 5 || parts[0] != "agent" || parts[1] != "cascade" || parts[2] == "1" || parts[3] != "trajectory" || parts[4] != "3" {
		t.Fatalf("continuation advanced logical identity: %s", id)
	}
	var firstRequest, nextRequest map[string]json.RawMessage
	json.Unmarshal(first["request"], &firstRequest)
	json.Unmarshal(next["request"], &nextRequest)
	if string(nextRequest["continuationToken"]) != `"Y2hlY2twb2ludC0x"` {
		t.Fatalf("missing checkpoint: %s", nextRequest["continuationToken"])
	}
	delete(nextRequest, "continuationToken")
	for key, value := range firstRequest {
		var a, b interface{}
		json.Unmarshal(value, &a)
		json.Unmarshal(nextRequest[key], &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("continuation changed request.%s", key)
		}
	}
	events := decodeContinuationEvents(t, output)
	if len(events) != 2 {
		t.Fatalf("exposed event count=%d, want2", len(events))
	}
	var observed []struct {
		Candidates []struct {
			FinishReason string `json:"finishReason"`
			Content      struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Usage map[string]int64 `json:"usageMetadata"`
	}
	for _, event := range events {
		var response struct {
			Candidates []struct {
				FinishReason string `json:"finishReason"`
				Content      struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
			Usage map[string]int64 `json:"usageMetadata"`
		}
		json.Unmarshal(event["response"], &response)
		observed = append(observed, response)
	}
	if observed[0].Candidates[0].FinishReason != "" || observed[1].Candidates[0].FinishReason != "STOP" {
		t.Fatal("intermediate finish appeared terminal")
	}
	if observed[0].Candidates[0].Content.Parts[0].Text+observed[1].Candidates[0].Content.Parts[0].Text != "AB" {
		t.Fatal("continued output was lost or duplicated")
	}
	want := map[string]int64{"promptTokenCount": 100, "cachedContentTokenCount": 20, "thoughtsTokenCount": 3, "candidatesTokenCount": 15, "totalTokenCount": 118}
	if !reflect.DeepEqual(observed[1].Usage, want) {
		t.Fatalf("aggregated usage=%v want%v", observed[1].Usage, want)
	}
}

func TestContinuationStopsAtInitialOutputBudget(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) { sseEvent(writer, continuationFirst) }}
	output, err := runContinuationFixture(t, fixture, strings.Replace(continuationTestRequest, `"maxOutputTokens":256`, `"maxOutputTokens":12`, 1))
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.bodies) != 1 {
		t.Fatalf("exceeded initial budget with %d requests", len(fixture.bodies))
	}
	if !strings.Contains(output, `"finishReason":"MAX_TOKENS"`) {
		t.Fatal("exhausted continuation not exposed as MAX_TOKENS")
	}
}

func TestCheckpointResumeDoesNotReplayDirtyOutput(t *testing.T) {
	for _, dirty := range []bool{false, true} {
		name := "checkpoint-safe"
		if dirty {
			name = "output-after-checkpoint"
		}
		t.Run(name, func(t *testing.T) {
			fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
				if index == 0 {
					sseEvent(writer, strings.Replace(continuationFirst, `"finishReason":"CONTINUATION",`, "", 1))
					if dirty {
						sseEvent(writer, `{"response":{"candidates":[{"content":{"parts":[{"text":"already-visible"}]}}]}}`)
					}
					interruptContinuationResponse(writer)
					return
				}
				sseEvent(writer, continuationLast)
			}}
			output, err := runContinuationFixture(t, fixture, continuationTestRequest)
			if dirty {
				if err == nil || len(fixture.bodies) != 1 || !strings.Contains(output, "already-visible") {
					t.Fatalf("unsafe dirty replay: calls=%d error=%v output=%s", len(fixture.bodies), err, output)
				}
			} else {
				if err != nil || len(fixture.bodies) != 2 {
					t.Fatalf("safe checkpoint did not resume: calls=%d error=%v", len(fixture.bodies), err)
				}
				text, finish, usage := continuationOutput(t, output)
				if text != "AB" || finish != "STOP" || usage["candidatesTokenCount"] != 15 || usage["totalTokenCount"] != 118 {
					t.Fatalf("checkpoint resume lost or duplicated output/usage: text=%q finish=%q usage=%v", text, finish, usage)
				}
			}
		})
	}
}

func TestContinuationPreservesInBandQuotaError(t *testing.T) {
	failure := `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}`
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) {
		sseEvent(writer, strings.Replace(continuationFirst, `"finishReason":"CONTINUATION",`, "", 1))
		sseEvent(writer, failure)
	}}
	output, err := runContinuationFixture(t, fixture, continuationTestRequest)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixture.bodies) != 1 {
		t.Fatal("quota error retried")
	}
	events := decodeContinuationEvents(t, output)
	if len(events) != 2 || !bytes.Equal(events[1]["error"], json.RawMessage(`{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}`)) {
		t.Fatalf("provider error was hidden: %s", output)
	}
}

func TestContinuationAggregatesUsageOnlySnapshots(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		name := "completed-leg"
		if interrupted {
			name = "checkpoint-recovery"
		}
		t.Run(name, func(t *testing.T) {
			fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
				if index == 0 {
					event := `{"response":{"candidates":[{"content":{"parts":[{"text":"A"}]},"finishReason":"CONTINUATION","continuationToken":"Y2hlY2twb2ludC0x"}]}}`
					if interrupted {
						event = strings.Replace(event, `"finishReason":"CONTINUATION",`, "", 1)
					}
					sseEvent(writer, event)
					sseEvent(writer, `{"response":{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":2,"candidatesTokenCount":8}}}`)
					sseEvent(writer, `{"response":{"usageMetadata":{"candidatesTokenCount":10}}}`)
					if interrupted {
						interruptContinuationResponse(writer)
					}
					return
				}
				sseEvent(writer, continuationLast)
				sseEvent(writer, `{"response":{"candidates":[],"usageMetadata":{"candidatesTokenCount":7}}}`)
			}}
			output, err := runContinuationFixture(t, fixture, continuationTestRequest)
			if err != nil {
				t.Fatal(err)
			}
			text, finish, usage := continuationOutput(t, output)
			want := map[string]int64{"promptTokenCount": 100, "cachedContentTokenCount": 20, "thoughtsTokenCount": 3, "candidatesTokenCount": 17, "totalTokenCount": 120}
			if len(fixture.bodies) != 2 || text != "AB" || finish != "STOP" || !reflect.DeepEqual(usage, want) {
				t.Fatalf("usage-only snapshots lost or counted twice: calls=%d text=%q finish=%q usage=%v", len(fixture.bodies), text, finish, usage)
			}
		})
	}
}

func TestContinuationStopsWhenTrailingUsageExhaustsBudget(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) {
		sseEvent(writer, `{"response":{"candidates":[{"content":{"parts":[{"text":"A"}]},"finishReason":"CONTINUATION","continuationToken":"Y2hlY2twb2ludC0x"}]}}`)
		sseEvent(writer, `{"response":{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"thoughtsTokenCount":2,"candidatesTokenCount":10}}}`)
	}}
	output, err := runContinuationFixture(t, fixture, strings.Replace(continuationTestRequest, `"maxOutputTokens":256`, `"maxOutputTokens":12`, 1))
	if err != nil {
		t.Fatal(err)
	}
	text, finish, usage := continuationOutput(t, output)
	if len(fixture.bodies) != 1 || text != "A" || finish != "MAX_TOKENS" || usage["totalTokenCount"] != 112 {
		t.Fatalf("trailing usage failed to end generation: calls=%d text=%q finish=%q usage=%v", len(fixture.bodies), text, finish, usage)
	}
}

func TestContinuationDoesNotReplayOutputAfterCheckpoint(t *testing.T) {
	for _, test := range []struct{ name, tail string }{
		{"same-candidate", `{"response":{"candidates":[{"content":{"parts":[{"text":"tail"}]},"finishReason":"CONTINUATION"}]}}`},
		{"other-candidate", `{"response":{"candidates":[{"finishReason":"CONTINUATION"},{"content":{"parts":[{"text":"tail"}]}}]}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) {
				sseEvent(writer, continuationFirst)
				sseEvent(writer, test.tail)
			}}
			output, err := runContinuationFixture(t, fixture, continuationTestRequest)
			text, _, _ := continuationOutput(t, output)
			if err == nil || len(fixture.bodies) != 1 || text != "Atail" {
				t.Fatalf("dirty checkpoint was replayed: calls=%d error=%v text=%q", len(fixture.bodies), err, text)
			}
		})
	}
}

func TestContinuationDoesNotReuseConsumedCheckpoint(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		name := "finish-without-new-checkpoint"
		if interrupted {
			name = "interrupted-before-new-checkpoint"
		}
		t.Run(name, func(t *testing.T) {
			fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
				if index == 0 {
					sseEvent(writer, continuationFirst)
					return
				}
				if interrupted {
					sseEvent(writer, `{"response":{"usageMetadata":{"thoughtsTokenCount":1}}}`)
					interruptContinuationResponse(writer)
				} else {
					sseEvent(writer, `{"response":{"candidates":[{"finishReason":"CONTINUATION"}]}}`)
				}
			}}
			output, err := runContinuationFixture(t, fixture, continuationTestRequest)
			text, _, _ := continuationOutput(t, output)
			if err == nil || len(fixture.bodies) != 2 || text != "A" {
				t.Fatalf("consumed checkpoint reused: calls=%d error=%v text=%q", len(fixture.bodies), err, text)
			}
		})
	}
}

func TestContinuationTerminatesAtLegLimit(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) {
		sseEvent(writer, continuationFirst)
	}}
	output, err := runContinuationFixture(t, fixture, strings.Replace(continuationTestRequest, `"maxOutputTokens":256`, `"maxOutputTokens":0`, 1))
	if err != nil {
		t.Fatal(err)
	}
	text, finish, usage := continuationOutput(t, output)
	legs := maxContinuations + 1
	if len(fixture.bodies) != legs || text != strings.Repeat("A", legs) || finish != "MAX_TOKENS" || usage["totalTokenCount"] != 100+12*int64(legs) {
		t.Fatalf("unbounded continuation or lost final accounting: calls=%d text=%q finish=%q usage=%v", len(fixture.bodies), text, finish, usage)
	}
}

func TestCheckpointRecoveryTerminatesAtRetryLimit(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
		sseEvent(writer, fmt.Sprintf(`{"response":{"candidates":[{"content":{"parts":[{"text":"%d"}]},"continuationToken":"Y2hlY2twb2ludC0x"}],"usageMetadata":{"promptTokenCount":100,"thoughtsTokenCount":2,"candidatesTokenCount":10}}}`, index))
		interruptContinuationResponse(writer)
	}}
	output, err := runContinuationFixture(t, fixture, continuationTestRequest)
	text, _, usage := continuationOutput(t, output)
	var want strings.Builder
	for index := 0; index <= maxCheckpointRetries; index++ {
		fmt.Fprint(&want, index)
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) || len(fixture.bodies) != maxCheckpointRetries+1 || text != want.String() || usage["totalTokenCount"] != 100+12*int64(maxCheckpointRetries+1) {
		t.Fatalf("unbounded checkpoint recovery: calls=%d error=%v text=%q usage=%v", len(fixture.bodies), err, text, usage)
	}
}

func TestContinuationCancellationStopsInFlightLeg(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), tlsTestTimeout)
	defer cancel()
	started := make(chan struct{})
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, request *http.Request, index int) {
		if index == 0 {
			sseEvent(writer, continuationFirst)
			return
		}
		close(started)
		<-request.Context().Done()
	}}
	go func() {
		select {
		case <-started:
			cancel()
		case <-ctx.Done():
		}
	}()
	output, err := runContinuationFixtureContext(t, ctx, fixture, continuationTestRequest)
	text, _, _ := continuationOutput(t, output)
	if !errors.Is(err, context.Canceled) || len(fixture.bodies) != 2 || text != "A" {
		t.Fatalf("cancellation restarted or completed a partial stream: calls=%d error=%v text=%q", len(fixture.bodies), err, text)
	}
}

func TestContinuationHTTPFailuresReachSSEConsumer(t *testing.T) {
	for _, test := range []struct {
		name, body, message, status string
		code                        int
		gzip                        bool
	}{
		{"auth", `{"error":{"code":401,"message":"expired token","status":"UNAUTHENTICATED"}}`, "expired token", "UNAUTHENTICATED", 401, false},
		{"permission-gzip", `{"error":{"code":403,"message":"permission denied","status":"PERMISSION_DENIED"}}`, "permission denied", "PERMISSION_DENIED", 403, true},
		{"quota", `{"error":{"code":429,"message":"quota exhausted","status":"RESOURCE_EXHAUSTED"}}`, "quota exhausted", "RESOURCE_EXHAUSTED", 429, false},
		{"upstream-text", "upstream unavailable", "upstream unavailable", "", 502, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, index int) {
				if index == 0 {
					sseEvent(writer, continuationFirst)
					return
				}
				writer.Header().Set("Content-Type", "application/json")
				if test.gzip {
					writer.Header().Set("Content-Encoding", "gzip")
				}
				writer.WriteHeader(test.code)
				if test.gzip {
					compressor := gzip.NewWriter(writer)
					io.WriteString(compressor, test.body)
					compressor.Close()
				} else {
					io.WriteString(writer, test.body)
				}
			}}
			output, err := runContinuationFixture(t, fixture, continuationTestRequest)
			if err != nil {
				t.Fatal(err)
			}
			events := decodeContinuationEvents(t, output)
			if len(fixture.bodies) != 2 || len(events) != 2 {
				t.Fatalf("HTTP failure retried or hidden: calls=%d output=%s", len(fixture.bodies), output)
			}
			var failure ccpaError
			if err := json.Unmarshal(events[1]["error"], &failure); err != nil {
				t.Fatal(err)
			}
			if failure.Code != test.code || failure.Status != test.status || !strings.Contains(failure.Message, test.message) {
				t.Fatalf("HTTP failure lost status or provider explanation: %+v", failure)
			}
		})
	}
}

func TestContinuationRejectsMalformedCompressedStream(t *testing.T) {
	fixture := &continuationFixture{serve: func(writer http.ResponseWriter, _ *http.Request, _ int) {
		writer.Header().Set("Content-Encoding", "gzip")
		io.WriteString(writer, "not a gzip stream")
	}}
	output, err := runContinuationFixture(t, fixture, continuationTestRequest)
	if err == nil || len(fixture.bodies) != 1 || output != "" {
		t.Fatalf("malformed compression was accepted or retried: calls=%d error=%v output=%q", len(fixture.bodies), err, output)
	}
}
