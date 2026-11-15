package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// Continuation and checkpoint recovery are bounded independently of HTTP retries.
// Usage values are per-leg snapshots, not deltas.
const maxContinuations = 32
const maxCheckpointRetries = 3

type continuationState struct {
	token                                                      string
	dirty, finishHidden                                        bool
	finish                                                     string
	continuations, retries                                     int
	maxOutput                                                  int64
	input, cache, thinking, output, priorThinking, priorOutput int64
	initialDetails                                             map[string]json.RawMessage
}

type ccaStreamFailure struct{}

func (*ccaStreamFailure) Error() string { return "upstream CCPA in-band error" }

func decodeCheckpoint(token string) ([]byte, error) {
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err := encoding.DecodeString(token); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("invalid protobuf continuation checkpoint encoding")
}

func nonnegative(raw json.RawMessage) int64 {
	var number int64
	if json.Unmarshal(raw, &number) != nil || number < 0 {
		return 0
	}
	return number
}

func finishName(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var number int
	if json.Unmarshal(raw, &number) != nil {
		return ""
	}
	switch number {
	case 0:
		return ""
	case 2:
		return "MAX_TOKENS"
	case 18:
		return "CONTINUATION"
	default:
		return "TERMINAL"
	}
}

func (state *continuationState) budgetAllows() bool {
	return state.maxOutput <= 0 || state.priorThinking+state.priorOutput+state.thinking+state.output < state.maxOutput
}
func (state *continuationState) canContinue() bool {
	return state.token != "" && !state.dirty && state.continuations < maxContinuations && state.budgetAllows() && (state.finish == "CONTINUATION" || state.finish == "MAX_TOKENS")
}

func (state *continuationState) observe(data []byte) ([]byte, error) {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(data, &event); err != nil {
		return nil, err
	}
	if raw := event["error"]; len(raw) > 0 && string(raw) != "null" {
		return data, &ccaStreamFailure{}
	}
	var response map[string]json.RawMessage
	if len(event["response"]) == 0 || string(event["response"]) == "null" {
		return data, nil
	}
	if err := json.Unmarshal(event["response"], &response); err != nil {
		return nil, err
	}
	var candidates []map[string]json.RawMessage
	if raw := response["candidates"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &candidates); err != nil {
			return nil, err
		}
	}
	var usage map[string]json.RawMessage
	if raw := response["usageMetadata"]; len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &usage); err != nil {
			return nil, err
		}
		if raw, present := usage["thoughtsTokenCount"]; present {
			state.thinking = nonnegative(raw)
		}
		if raw, present := usage["candidatesTokenCount"]; present {
			state.output = nonnegative(raw)
		}
		if state.continuations == 0 && state.retries == 0 {
			prompt := state.input + state.cache
			if raw, present := usage["promptTokenCount"]; present {
				prompt = nonnegative(raw)
			}
			if raw, present := usage["cachedContentTokenCount"]; present {
				state.cache = nonnegative(raw)
			}
			state.input = max(prompt-state.cache, 0)
			if state.initialDetails == nil {
				state.initialDetails = make(map[string]json.RawMessage, 3)
			}
			for _, key := range []string{"promptTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"} {
				if raw, present := usage[key]; present || len(state.initialDetails[key]) == 0 {
					state.initialDetails[key] = raw
				}
			}
		}
		values := map[string]int64{"promptTokenCount": state.input + state.cache, "cachedContentTokenCount": state.cache, "thoughtsTokenCount": state.priorThinking + state.thinking, "candidatesTokenCount": state.priorOutput + state.output, "totalTokenCount": state.input + state.cache + state.priorThinking + state.thinking + state.priorOutput + state.output}
		for key, value := range values {
			usage[key] = strconv.AppendInt(nil, value, 10)
		}
		for key, value := range state.initialDetails {
			if len(value) == 0 {
				delete(usage, key)
			} else {
				usage[key] = value
			}
		}
		response["usageMetadata"], _ = json.Marshal(usage)
	}
	for _, candidate := range candidates {
		var token string
		if raw := candidate["continuationToken"]; len(raw) > 0 {
			if err := json.Unmarshal(raw, &token); err != nil {
				return nil, err
			}
		}
		if token != "" {
			if len(candidates) != 1 {
				return nil, errors.New("checkpoint continuation with multiple candidates is unsupported")
			}
			if _, err := decodeCheckpoint(token); err != nil {
				return nil, err
			}
			state.token = token
			state.dirty = false
		} else if raw := candidate["content"]; len(raw) > 0 && string(raw) != "null" {
			var content struct {
				Parts []json.RawMessage `json:"parts"`
			}
			if err := json.Unmarshal(raw, &content); err != nil {
				return nil, err
			}
			if len(content.Parts) > 0 {
				state.dirty = true
			}
		}
	}
	if len(candidates) > 0 {
		candidate := candidates[0]
		if finish := finishName(candidate["finishReason"]); finish != "" {
			state.finish = finish
			if state.canContinue() {
				delete(candidate, "finishReason")
				delete(candidate, "finishMessage")
				state.finishHidden = true
			} else if finish == "CONTINUATION" && (!state.budgetAllows() || state.continuations >= maxContinuations) {
				candidate["finishReason"] = json.RawMessage(`"MAX_TOKENS"`)
				state.finishHidden = false
			} else {
				state.finishHidden = false
			}
		}
		response["candidates"], _ = json.Marshal(candidates)
	}
	event["response"], _ = json.Marshal(response)
	return json.Marshal(event)
}

func readCCPAEvents(reader io.Reader, consume func([]byte) error) error {
	buffered := bufio.NewReader(reader)
	var data []byte
	for {
		line, err := buffered.ReadBytes('\n')
		line = bytes.TrimSuffix(bytes.TrimSuffix(line, []byte{'\n'}), []byte{'\r'})
		if len(line) == 0 {
			if len(data) > 0 {
				if bytes.Equal(data, []byte("[DONE]")) {
					return nil
				}
				if consumeErr := consume(data); consumeErr != nil {
					return consumeErr
				}
				data = data[:0]
			}
		} else if bytes.HasPrefix(line, []byte("data:")) {
			value := line[5:]
			if len(value) > 0 && value[0] == ' ' {
				value = value[1:]
			}
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, value...)
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(data) > 0 {
				if bytes.Equal(data, []byte("[DONE]")) {
					return nil
				}
				return consume(data)
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func freshContinuationRequest(descriptor protoreflect.MessageDescriptor, original []byte, checkpoint string) ([]byte, error) {
	message := dynamicpb.NewMessage(descriptor)
	if err := protojson.Unmarshal(original, message); err != nil {
		return nil, err
	}
	requestID := descriptor.Fields().ByName("request_id")
	originalID := message.Get(requestID).String()
	parts := strings.Split(originalID, "/")
	switch len(parts) {
	case 4:
		parts[1] = strconv.FormatInt(time.Now().UnixMilli(), 10)
	case 5:
		parts[2] = strconv.FormatInt(time.Now().UnixMilli(), 10)
	case 2:
		var uuid [16]byte
		if _, err := rand.Read(uuid[:]); err != nil {
			return nil, err
		}
		uuid[6] = uuid[6]&15 | 64
		uuid[8] = uuid[8]&63 | 128
		parts[1] = fmt.Sprintf("%x-%x-%x-%x-%x", uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16])
	default:
		return nil, errors.New("cannot continue an unrecognized native request ID shape")
	}
	message.Set(requestID, protoreflect.ValueOfString(strings.Join(parts, "/")))
	request := message.Mutable(descriptor.Fields().ByName("request")).Message()
	token, err := decodeCheckpoint(checkpoint)
	if err != nil {
		return nil, err
	}
	request.Set(request.Descriptor().Fields().ByName("continuation_token"), protoreflect.ValueOfBytes(token))
	body, err := protojson.Marshal(message)
	if err != nil {
		return nil, err
	}
	return marshalCCPA(descriptor, body)
}

func responseReader(response *http.Response) (io.Reader, io.Closer, error) {
	if response.Header.Get("Content-Encoding") != "gzip" {
		return response.Body, nil, nil
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		return nil, nil, err
	}
	return reader, reader, nil
}

func writeCCPAEvent(writer http.ResponseWriter, event []byte) error {
	if _, err := io.WriteString(writer, "data: "); err != nil {
		return err
	}
	if _, err := writer.Write(event); err != nil {
		return err
	}
	if _, err := io.WriteString(writer, "\n\n"); err != nil {
		return err
	}
	if flusher, ok := writer.(http.Flusher); ok {
		flusher.Flush()
	}
	return nil
}

type ccpaError struct {
	Code    int    `json:"code,omitempty"`
	Message string `json:"message"`
	Status  string `json:"status,omitempty"`
}

func writeCCPAError(writer http.ResponseWriter, failure ccpaError) error {
	event, err := json.Marshal(struct {
		Error ccpaError `json:"error"`
	}{Error: failure})
	if err != nil {
		return err
	}
	return writeCCPAEvent(writer, event)
}

func writeContinuationHTTPError(writer http.ResponseWriter, response *http.Response) error {
	defer response.Body.Close()
	reader, decompressor, readErr := responseReader(response)
	if decompressor != nil {
		defer decompressor.Close()
	}
	var envelope struct {
		Error ccpaError `json:"error"`
	}
	if readErr == nil {
		const maxErrorBody = 64 * 1024
		body, err := io.ReadAll(io.LimitReader(reader, maxErrorBody+1))
		readErr = err
		truncated := len(body) > maxErrorBody
		if truncated {
			body = body[:maxErrorBody]
		}
		if json.Unmarshal(body, &envelope) != nil || envelope.Error.Message == "" {
			envelope.Error.Message = strings.TrimSpace(string(body))
		}
		if truncated {
			envelope.Error.Message += " (truncated)"
		}
	}
	if envelope.Error.Message == "" {
		if readErr != nil {
			envelope.Error.Message = readErr.Error()
		} else {
			envelope.Error.Message = http.StatusText(response.StatusCode)
		}
	}
	envelope.Error.Code = response.StatusCode
	envelope.Error.Message = fmt.Sprintf("continuation HTTP status %d: %s", response.StatusCode, envelope.Error.Message)
	return writeCCPAError(writer, envelope.Error)
}

func streamCCPA(ctx context.Context, writer http.ResponseWriter, pool http.RoundTripper, request *http.Request, response *http.Response, original []byte, descriptor protoreflect.MessageDescriptor) error {
	var envelope struct {
		Request struct {
			GenerationConfig struct {
				MaxOutputTokens int64 `json:"maxOutputTokens"`
			} `json:"generationConfig"`
		} `json:"request"`
	}
	if err := json.Unmarshal(original, &envelope); err != nil {
		return err
	}
	state := continuationState{maxOutput: envelope.Request.GenerationConfig.MaxOutputTokens}
	if err := ctx.Err(); err != nil {
		response.Body.Close()
		return err
	}
	for {
		var writeErr error
		reader, decompressor, err := responseReader(response)
		if err == nil {
			err = readCCPAEvents(reader, func(event []byte) error {
				encoded, parseErr := state.observe(event)
				var upstreamFailure *ccaStreamFailure
				if parseErr != nil && !errors.As(parseErr, &upstreamFailure) {
					return parseErr
				}
				writeErr = writeCCPAEvent(writer, encoded)
				if writeErr != nil {
					return writeErr
				}
				return parseErr
			})
		}
		if decompressor != nil {
			decompressor.Close()
		}
		response.Body.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if writeErr != nil {
			return writeErr
		}
		var upstreamFailure *ccaStreamFailure
		if errors.As(err, &upstreamFailure) {
			return nil
		}
		if err == nil {
			if !state.canContinue() {
				if state.finish == "CONTINUATION" && state.budgetAllows() && state.continuations < maxContinuations {
					return errors.New("cannot continue without a checkpoint covering all emitted output")
				}
				if state.finishHidden {
					return writeCCPAEvent(writer, []byte(`{"response":{"candidates":[{"finishReason":"MAX_TOKENS"}]}}`))
				}
				return nil
			}
			state.continuations++
		} else {
			// Only transport interruptions may resume. Provider/schema errors retain
			// their original failure instead of turning an auth/quota denial into retry.
			var networkError interface{ Timeout() bool }
			transient := errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &networkError)
			if !transient || state.dirty || state.token == "" || state.retries >= maxCheckpointRetries || !state.budgetAllows() || (state.finish != "" && state.finish != "CONTINUATION" && state.finish != "MAX_TOKENS") {
				return err
			}
			state.retries++
			capDelay := min(100*time.Millisecond<<min(state.retries-1, 6), 5*time.Second)
			half := capDelay / 2
			jitter, randomErr := rand.Int(rand.Reader, big.NewInt(int64(half)))
			if randomErr != nil {
				return randomErr
			}
			timer := time.NewTimer(half + time.Duration(jitter.Int64()))
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		state.priorThinking += state.thinking
		state.priorOutput += state.output
		nextBody, err := freshContinuationRequest(descriptor, original, state.token)
		if err != nil {
			return err
		}
		next := request.Clone(ctx)
		next.Body = io.NopCloser(bytes.NewReader(nextBody))
		next.ContentLength = 0
		next.GetBody = nil
		state.thinking = 0
		state.output = 0
		state.finish = ""
		state.dirty = false
		state.token = ""
		state.finishHidden = false
		nextResponse, err := pool.RoundTrip(next)
		if err != nil {
			return err
		}
		if nextResponse.StatusCode < 200 || nextResponse.StatusCode >= 300 {
			return writeContinuationHTTPError(writer, nextResponse)
		}
		response = nextResponse
	}
}
