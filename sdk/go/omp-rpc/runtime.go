package omprpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"
)

// Transport sends one command and returns the successful response's data
// (nil when the response carries none). A zero timeout selects the
// transport's default deadline. Failed commands return a *CommandError.
type Transport interface {
	Call(ctx context.Context, command string, params any, timeout time.Duration) (json.RawMessage, error)
}

// Commands has one typed method per RPC command; the methods are generated in
// wire.go from the wire schema.
type Commands struct {
	Transport Transport
}

func (c Commands) call(ctx context.Context, command string, params any, timeout time.Duration, out any) error {
	data, err := c.Transport.Call(ctx, command, params, timeout)
	if err != nil || out == nil {
		return err
	}
	if len(data) == 0 {
		// An absent `data` is an empty result (the prompt ack of an agent-invoking
		// prompt has none), except for a nullable result (out is **T): no value.
		data = json.RawMessage("{}")
		if reflect.TypeOf(out).Elem().Kind() == reflect.Pointer {
			data = json.RawMessage("null")
		}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("omprpc: %s result: %w", command, err)
	}
	return nil
}

// UnknownNotification is a server frame this binding cannot represent: its
// type is not in the schema, or (Err != nil) its type is known but the payload
// failed to decode. Raw keeps the frame verbatim.
type UnknownNotification struct {
	Type string
	Raw  json.RawMessage
	Err  error
}

// MarshalJSON writes the frame verbatim.
func (v UnknownNotification) MarshalJSON() ([]byte, error) {
	if len(v.Raw) == 0 {
		return nil, errors.New("omprpc: UnknownNotification has no Raw frame")
	}
	return v.Raw, nil
}

func newUnknownNotification(tag string, data []byte) UnknownNotification {
	return UnknownNotification{Type: tag, Raw: bytes.Clone(data)}
}

// peekTag returns the string at property in a JSON object, or "".
func peekTag(data []byte, property string) string {
	var raw map[string]json.RawMessage
	var tag string
	if json.Unmarshal(data, &raw) == nil {
		_ = json.Unmarshal(raw[property], &tag)
	}
	return tag
}

// Ptr returns a pointer to a copy of v, for optional fields.
func Ptr[T any](v T) *T {
	return &v
}

func decodeObject(data []byte, owner string) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("%s: %w", owner, err)
	}
	if raw == nil {
		return nil, fmt.Errorf("%s: expected an object, got null", owner)
	}
	return raw, nil
}

func decodeWith(data []byte, owner string, decodeFrom func(map[string]json.RawMessage) error) error {
	raw, err := decodeObject(data, owner)
	if err != nil {
		return err
	}
	return decodeFrom(raw)
}

// decodeVariant decodes an already-parsed object as the union variant T.
func decodeVariant[T any, P interface {
	*T
	decodeFrom(map[string]json.RawMessage) error
}](raw map[string]json.RawMessage) (T, error) {
	var value T
	err := P(&value).decodeFrom(raw)
	return value, err
}

func unionTag(raw map[string]json.RawMessage, owner, property string) (string, error) {
	var tag string
	value, ok := raw[property]
	if !ok || json.Unmarshal(value, &tag) != nil || isNull(value) {
		return "", fmt.Errorf("%s: missing or non-string %q", owner, property)
	}
	return tag, nil
}

func decodeString(data []byte, owner string) (string, error) {
	var s string
	if isNull(data) {
		return "", fmt.Errorf("%s: expected a string, got null", owner)
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return "", fmt.Errorf("%s: %w", owner, err)
	}
	return s, nil
}

func unknownValue(owner, value string) error {
	return fmt.Errorf("%s: unknown value %q", owner, value)
}

func emptyUnion(owner string) error {
	return fmt.Errorf("%s: no variant set", owner)
}

func isNull(data []byte) bool {
	return string(bytes.TrimSpace(data)) == "null"
}

// jsonKind classifies a JSON value by its first byte: '"', '0' (number), 't'
// (boolean), '[', '{', 'n' (null), or 0 when empty.
func jsonKind(data []byte) byte {
	data = bytes.TrimLeft(data, " \t\r\n")
	if len(data) == 0 {
		return 0
	}
	switch c := data[0]; c {
	case 't', 'f':
		return 't'
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return '0'
	default:
		return c
	}
}

func unexpectedKind(owner string, data []byte) error {
	return fmt.Errorf("%s: unexpected JSON value %.40s", owner, data)
}

// encodeObject marshals value (a method-less copy of a generated struct),
// prepends the constant members (`"type":"x"`), and writes the extra keys over
// the struct's (an open record keeps a declared key there only when its value
// did not decode).
func encodeObject(value any, constants string, extra map[string]json.RawMessage) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if constants != "" {
		if len(body) == 2 {
			body = []byte("{" + constants + "}")
		} else {
			body = append([]byte("{"+constants+","), body[1:]...)
		}
	}
	if len(extra) == 0 {
		return body, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(body, &merged); err != nil {
		return nil, err
	}
	for key, item := range extra {
		merged[key] = item
	}
	return json.Marshal(merged)
}

func encodeVariant(owner string, value any) ([]byte, error) {
	if value == nil {
		return nil, emptyUnion(owner)
	}
	return json.Marshal(value)
}

// fieldDecoder decodes the fields of one object, keeping the first error.
// Open records validate only their constants: a declared field may be absent,
// and a value that does not decode leaves the field zero. They consume the keys
// they decode, so rest() returns the undeclared keys and the undecodable ones.
type fieldDecoder struct {
	raw   map[string]json.RawMessage
	owner string
	open  bool
	err   error
}

func (d *fieldDecoder) take(key string) (json.RawMessage, bool) {
	if d.err != nil {
		return nil, false
	}
	value, ok := d.raw[key]
	return value, ok
}

func (d *fieldDecoder) decode(key string, value json.RawMessage, dst any) {
	err := json.Unmarshal(value, dst)
	switch {
	case err == nil:
		d.consume(key)
	case d.open:
		reflect.ValueOf(dst).Elem().SetZero()
	default:
		d.err = fmt.Errorf("%s.%s: %w", d.owner, key, err)
	}
}

func (d *fieldDecoder) consume(key string) {
	if d.open {
		delete(d.raw, key)
	}
}

// required decodes a key that must be present and non-null (open records: may be absent).
func (d *fieldDecoder) required(key string, dst any) {
	value, ok := d.take(key)
	switch {
	case d.err != nil:
	case !ok:
		if !d.open {
			d.err = fmt.Errorf("%s: missing required field %q", d.owner, key)
		}
	case !d.open && isNull(value):
		d.err = fmt.Errorf("%s.%s: must not be null", d.owner, key)
	default:
		d.decode(key, value, dst)
	}
}

// nullable decodes a key that must be present but may be null (open records: may be absent).
func (d *fieldDecoder) nullable(key string, dst any) {
	value, ok := d.take(key)
	switch {
	case d.err != nil:
	case !ok:
		if !d.open {
			d.err = fmt.Errorf("%s: missing required field %q", d.owner, key)
		}
	default:
		d.decode(key, value, dst)
	}
}

func (d *fieldDecoder) optional(key string, dst any) {
	if value, ok := d.take(key); ok {
		d.decode(key, value, dst)
	}
}

// defaulted decodes fallback (JSON) when the key is absent.
func (d *fieldDecoder) defaulted(key string, dst any, fallback string) {
	value, ok := d.take(key)
	if d.err != nil {
		return
	}
	if !ok {
		value = json.RawMessage(fallback)
	}
	d.decode(key, value, dst)
}

// constant checks a constant member (a discriminator); want is a string or bool.
func (d *fieldDecoder) constant(key string, want any) {
	value, ok := d.take(key)
	if d.err != nil {
		return
	}
	var got any
	if !ok || json.Unmarshal(value, &got) != nil || got != want {
		d.err = fmt.Errorf("%s.%s: expected %#v", d.owner, key, want)
		return
	}
	d.consume(key)
}

// fallbackTarget is a union that can hold an UnknownNotification.
type fallbackTarget interface {
	json.Unmarshaler
	setUnknown(UnknownNotification)
}

// fallback decodes a required key whose value, when it fails to decode, is
// kept as an UnknownNotification (Type read from property) instead of failing
// the enclosing object.
func (d *fieldDecoder) fallback(key string, dst fallbackTarget, property string) {
	value, ok := d.take(key)
	switch {
	case d.err != nil:
	case !ok:
		if !d.open {
			d.err = fmt.Errorf("%s: missing required field %q", d.owner, key)
		}
	default:
		if err := json.Unmarshal(value, dst); err != nil {
			dst.setUnknown(UnknownNotification{
				Type: peekTag(value, property),
				Raw:  value,
				Err:  fmt.Errorf("%s.%s: %w", d.owner, key, err),
			})
		}
		d.consume(key)
	}
}

// scalarOrArray wraps a bare non-null scalar at key in a one-element array,
// for array fields older servers sent as a single value.
func (d *fieldDecoder) scalarOrArray(key string) {
	value, ok := d.raw[key]
	if !ok {
		return
	}
	if kind := jsonKind(value); kind != '[' && kind != 'n' {
		d.raw[key] = append(append(json.RawMessage{'['}, value...), ']')
	}
}

func (d *fieldDecoder) rest() map[string]json.RawMessage {
	if len(d.raw) == 0 {
		return nil
	}
	return d.raw
}
