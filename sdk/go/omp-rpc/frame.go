package omprpc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Protocol v2 transport limits; the client negotiates v2 only when the ready
// frame advertises exactly these.
const (
	maxFrameBytes            = 1 << 20
	maxReassembledFrameBytes = 64 << 20
	chunkPayloadBytes        = 256 << 10
	maxChunkCount            = (maxReassembledFrameBytes + chunkPayloadBytes - 1) / chunkPayloadBytes
)

// ErrProtocol marks a transport violation (an invalid rpc_chunk sequence);
// it closes the client.
var ErrProtocol = errors.New("omprpc: protocol error")

func protocolError(message string) error {
	return fmt.Errorf("%w: %s", ErrProtocol, message)
}

// chunkDecoder reassembles protocol v2 rpc_chunk sequences, validating them
// exactly as the reference clients do.
type chunkDecoder struct {
	pending *chunkSequence
}

type chunkSequence struct {
	id         string
	count      int64
	byteLength int64
	next       int64
	data       []byte
}

// isChunk reports whether line is an rpc_chunk frame. Decoding the type alone
// honors escapes (`"rpc\u005fchunk"`) without copying the other members.
func isChunk(line []byte) bool {
	var head struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(line, &head) == nil && head.Type == "rpc_chunk"
}

// push consumes one frame (chunk reports whether it is an rpc_chunk). It
// returns the frame to process: line itself, nil while a chunk sequence is
// incomplete, or the reassembled frame. Errors are fatal for the connection.
func (d *chunkDecoder) push(line []byte, chunk bool) ([]byte, error) {
	if !chunk {
		if d.pending != nil {
			return nil, protocolError("RPC chunk sequence was interrupted")
		}
		return line, nil
	}
	var fields struct {
		ChunkID    json.RawMessage `json:"chunkId"`
		Index      json.RawMessage `json:"index"`
		Count      json.RawMessage `json:"count"`
		ByteLength json.RawMessage `json:"byteLength"`
		Data       json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(line, &fields); err != nil {
		return nil, protocolError("Invalid RPC chunk metadata")
	}
	var id, data string
	index, indexOK := jsonInteger(fields.Index)
	count, countOK := jsonInteger(fields.Count)
	byteLength, lengthOK := jsonInteger(fields.ByteLength)
	if jsonKind(fields.ChunkID) != '"' || json.Unmarshal(fields.ChunkID, &id) != nil || id == "" || utf8.RuneCountInString(id) > 128 ||
		!indexOK || !countOK || !lengthOK ||
		index < 0 || count < 2 || count > maxChunkCount || index >= count ||
		byteLength < maxFrameBytes || byteLength > maxReassembledFrameBytes ||
		jsonKind(fields.Data) != '"' || json.Unmarshal(fields.Data, &data) != nil || data == "" {
		return nil, protocolError("Invalid RPC chunk metadata")
	}
	// Strict rejects non-zero pad bits; it still skips CR/LF, which canonical
	// base64 never contains.
	payload, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || strings.ContainsAny(data, "\r\n") {
		return nil, protocolError("Invalid RPC chunk data")
	}
	if len(payload) > chunkPayloadBytes {
		return nil, protocolError("RPC chunk payload exceeds the transport limit")
	}

	if d.pending == nil {
		if index != 0 {
			return nil, protocolError("RPC chunk sequence must start at index 0")
		}
		d.pending = &chunkSequence{id: id, count: count, byteLength: byteLength, data: make([]byte, 0, byteLength)}
	}
	sequence := d.pending
	if sequence.id != id || sequence.count != count || sequence.byteLength != byteLength || sequence.next != index {
		return nil, protocolError("RPC chunk sequence mismatch")
	}
	if int64(len(sequence.data)+len(payload)) > sequence.byteLength {
		return nil, protocolError("RPC chunk sequence exceeds its declared length")
	}
	sequence.data = append(sequence.data, payload...)
	sequence.next++
	if sequence.next < sequence.count {
		return nil, nil
	}
	d.pending = nil
	if int64(len(sequence.data)) != sequence.byteLength {
		return nil, protocolError("RPC chunk sequence length mismatch")
	}
	if !utf8.Valid(sequence.data) || !json.Valid(sequence.data) {
		return nil, protocolError("Failed to decode reassembled RPC frame")
	}
	if jsonKind(sequence.data) != '{' {
		return nil, protocolError("RPC frame must be a JSON object")
	}
	return sequence.data, nil
}

// jsonInteger parses a JSON integer literal; floats, exponents, booleans, and
// strings are rejected.
func jsonInteger(raw json.RawMessage) (int64, bool) {
	text := string(bytes.TrimSpace(raw))
	digits := text
	if len(digits) > 0 && digits[0] == '-' {
		digits = digits[1:]
	}
	if digits == "" {
		return 0, false
	}
	for _, c := range []byte(digits) {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseInt(text, 10, 64)
	return value, err == nil
}
