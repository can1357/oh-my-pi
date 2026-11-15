package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// Extracted from the verified 1.5.9 ELF; regenerate with extract-schema.py.
//
//go:embed ccpa-descriptors.bin
var ccpaDescriptors []byte

// Random, session ID and public key exchange bytes are zeroed in this template;
// uTLS generates fresh cryptographic state on every connection.
//
//go:embed clienthello.bin
var consumerClientHello []byte

//go:embed profile.json
var clientProfileData []byte

func requestDescriptor() (protoreflect.MessageDescriptor, error) {
	set := new(descriptorpb.FileDescriptorSet)
	if err := proto.Unmarshal(ccpaDescriptors, set); err != nil {
		return nil, err
	}
	files, err := protodesc.NewFiles(set)
	if err != nil {
		return nil, err
	}
	descriptor, err := files.FindDescriptorByName("google.internal.cloud.code.v1internal.GenerateContentRequest")
	if err != nil {
		return nil, err
	}
	message, ok := descriptor.(protoreflect.MessageDescriptor)
	if !ok {
		return nil, fmt.Errorf("request descriptor is not a message")
	}
	return message, nil
}

func marshalCCPA(descriptor protoreflect.MessageDescriptor, body []byte) ([]byte, error) {
	message := dynamicpb.NewMessage(descriptor)
	if err := protojson.Unmarshal(body, message); err != nil {
		return nil, fmt.Errorf("CCPA protobuf JSON: %w", err)
	}
	current := message.ProtoReflect()
	for _, name := range []protoreflect.Name{"request", "generation_config", "thinking_config"} {
		field := current.Descriptor().Fields().ByName(name)
		if !current.Has(field) {
			current = nil
			break
		}
		current = current.Get(field).Message()
	}
	numericEnums := false
	if current != nil {
		field := current.Descriptor().Fields().ByName("thinking_level")
		level := current.Get(field).Enum()
		numericEnums = level == 5 || level == 6
	}
	encoded, err := (protojson.MarshalOptions{UseEnumNumbers: numericEnums}).Marshal(message)
	if err != nil {
		return nil, err
	}
	// This binary's positive even changelist seeds detrand; compact commas have
	// no spaces. Remove the public protobuf runtime's optional separator spaces
	// without touching strings, numbers, field order, enum policy, or escaping.
	var compact bytes.Buffer
	compact.Grow(len(encoded))
	if err = json.Compact(&compact, encoded); err != nil {
		return nil, err
	}
	return compact.Bytes(), nil
}
