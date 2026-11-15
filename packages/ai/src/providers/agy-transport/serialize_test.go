package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProtobufJSONDoesNotReclassifyImageRequests(t *testing.T) {
	descriptor, err := requestDescriptor()
	if err != nil {
		t.Fatal(err)
	}
	result, err := marshalCCPA(descriptor, []byte(`{"model":"image-model","user_prompt_id":"prompt-1","request":{"service_account":"image-worker@example.invalid","contents":[{"parts":[{"text":"draw a tree"}]}],"generation_config":{"response_modalities":["IMAGE"],"candidate_count":2}}}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(result, &body); err != nil {
		t.Fatal(err)
	}
	if _, exists := body["requestType"]; exists {
		t.Fatalf("image request was reclassified as chat: %s", result)
	}
	var request struct {
		ServiceAccount   string `json:"serviceAccount"`
		GenerationConfig struct {
			ResponseModalities []string `json:"responseModalities"`
			CandidateCount     int      `json:"candidateCount"`
		} `json:"generationConfig"`
	}
	if err := json.Unmarshal(body["request"], &request); err != nil {
		t.Fatal(err)
	}
	if string(body["userPromptId"]) != `"prompt-1"` || request.ServiceAccount != "image-worker@example.invalid" || len(request.GenerationConfig.ResponseModalities) != 1 || request.GenerationConfig.ResponseModalities[0] != "IMAGE" || request.GenerationConfig.CandidateCount != 2 {
		t.Fatalf("supported generation fields were stripped during protobuf JSON conversion: %s", result)
	}
}

func TestProtobufJSONRejectsUnrepresentableInput(t *testing.T) {
	descriptor, err := requestDescriptor()
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{"request":{"generationConfig":{"maxOutputTokens":2147483648}}}`, `{"request":{"contents":[{"parts":[{"text":"\ud800"}]}]}}`, `{"request":{"unknownWireField":true}}`} {
		if _, err := marshalCCPA(descriptor, []byte(input)); err == nil || !strings.Contains(err.Error(), "CCPA protobuf JSON") {
			t.Fatalf("expected native schema error for %s, got %v", input, err)
		}
	}
}
