package omprpc

import (
	"bytes"
	"encoding/json"
	"errors"
)

// encoding/json refuses a value nested deeper than 10,000 levels, even into a
// json.RawMessage, and a get_tree answer nests two levels for each session
// entry. splitObject and splitArray split one object or array into the raw
// values of its members, as json.Unmarshal into a map or slice of
// json.RawMessage does, validating each member as encoding/json's scanner does
// but tracking the open containers on a slice, so a member may nest to any
// depth. The decoders call them only for a value json.Unmarshal refused.

// errInvalidJSON is every error of the scanners below: their callers only ask
// whether a value is valid, and decodeObject reports json.Unmarshal's error.
var errInvalidJSON = errors.New("omprpc: invalid JSON")

// byteAt is data[i], or 0 past its end.
func byteAt(data []byte, i int) byte {
	if i < len(data) {
		return data[i]
	}
	return 0
}

func skipSpace(data []byte, i int) int {
	for i < len(data) && (data[i] == ' ' || data[i] == '\t' || data[i] == '\n' || data[i] == '\r') {
		i++
	}
	return i
}

// valueBounds returns where the one JSON value data holds starts and ends,
// however deep it nests; ok is false unless data is that value alone, between
// whitespace.
func valueBounds(data []byte) (start, end int, ok bool) {
	start = skipSpace(data, 0)
	end, err := scanValue(data, start)
	return start, end, err == nil && endOfInput(data, end) == nil
}

// validJSON is json.Valid with no limit on how deep data nests.
func validJSON(data []byte) bool {
	_, _, ok := valueBounds(data)
	return ok
}

// decodeDeep decodes value into dst, with no limit on how deep it nests, when
// dst holds raw JSON only: a json.RawMessage, an object of them, or an array of
// such objects (a get_tree answer's data and tree). It reports whether it did.
func decodeDeep(value []byte, dst any) bool {
	switch dst := dst.(type) {
	case *json.RawMessage:
		start, end, ok := valueBounds(value)
		if !ok {
			return false
		}
		*dst = bytes.Clone(value[start:end])
	case *map[string]json.RawMessage:
		members, err := splitObject(value)
		if err != nil {
			return false
		}
		*dst = members
	case *[]map[string]json.RawMessage:
		items, err := splitArray(value)
		if err != nil {
			return false
		}
		objects := make([]map[string]json.RawMessage, len(items))
		for index, item := range items {
			if isNull(item) {
				continue
			}
			if objects[index], err = splitObject(item); err != nil {
				return false
			}
		}
		*dst = objects
	default:
		return false
	}
	return true
}

// splitObject decodes the JSON object data into its members' raw values, which
// may nest to any depth.
func splitObject(data []byte) (map[string]json.RawMessage, error) {
	members := map[string]json.RawMessage{}
	i := skipSpace(data, 0)
	if byteAt(data, i) != '{' {
		return nil, errInvalidJSON
	}
	i = skipSpace(data, i+1)
	if byteAt(data, i) == '}' {
		return members, endOfInput(data, i+1)
	}
	for {
		keyEnd, err := scanString(data, i)
		if err != nil {
			return nil, err
		}
		var key string
		if err := json.Unmarshal(data[i:keyEnd], &key); err != nil {
			return nil, err
		}
		i = skipSpace(data, keyEnd)
		if byteAt(data, i) != ':' {
			return nil, errInvalidJSON
		}
		start := skipSpace(data, i+1)
		end, err := scanValue(data, start)
		if err != nil {
			return nil, err
		}
		members[key] = bytes.Clone(data[start:end])
		i = skipSpace(data, end)
		switch byteAt(data, i) {
		case ',':
			i = skipSpace(data, i+1)
		case '}':
			return members, endOfInput(data, i+1)
		default:
			return nil, errInvalidJSON
		}
	}
}

// splitArray decodes the JSON array data into its items' raw values, which may
// nest to any depth. The items share data's bytes: decodeDeep only reads them.
func splitArray(data []byte) ([]json.RawMessage, error) {
	items := []json.RawMessage{}
	i := skipSpace(data, 0)
	if byteAt(data, i) != '[' {
		return nil, errInvalidJSON
	}
	i = skipSpace(data, i+1)
	if byteAt(data, i) == ']' {
		return items, endOfInput(data, i+1)
	}
	for {
		end, err := scanValue(data, i)
		if err != nil {
			return nil, err
		}
		items = append(items, data[i:end])
		i = skipSpace(data, end)
		switch byteAt(data, i) {
		case ',':
			i = skipSpace(data, i+1)
		case ']':
			return items, endOfInput(data, i+1)
		default:
			return nil, errInvalidJSON
		}
	}
}

// endOfInput fails unless only whitespace follows offset i.
func endOfInput(data []byte, i int) error {
	if i = skipSpace(data, i); i != len(data) {
		return errInvalidJSON
	}
	return nil
}

// scanValue returns the end of the JSON value that starts at data[i].
func scanValue(data []byte, i int) (int, error) {
	// The closing delimiter of each open container, innermost last.
	var open []byte
	for {
		// A value starts at i: open a container, or scan a scalar whole.
		var err error
		switch c := byteAt(data, i); {
		case c == '{' || c == '[':
			end := byte('}')
			if c == '[' {
				end = ']'
			}
			i = skipSpace(data, i+1)
			if byteAt(data, i) == end {
				i++
				break
			}
			open = append(open, end)
			if end == '}' {
				if i, err = scanKey(data, i); err != nil {
					return 0, err
				}
			}
			continue
		case c == '"':
			i, err = scanString(data, i)
		case c == '-' || c >= '0' && c <= '9':
			i, err = scanNumber(data, i)
		default:
			i, err = scanLiteral(data, i)
		}
		if err != nil {
			return 0, err
		}
		// A value ends at i: close each container it completes.
		for {
			if len(open) == 0 {
				return i, nil
			}
			i = skipSpace(data, i)
			end := open[len(open)-1]
			if c := byteAt(data, i); c != ',' {
				if c != end {
					return 0, errInvalidJSON
				}
				i++
				open = open[:len(open)-1]
				continue
			}
			i = skipSpace(data, i+1)
			if end == '}' {
				if i, err = scanKey(data, i); err != nil {
					return 0, err
				}
			}
			break
		}
	}
}

// scanKey scans the member name at data[i] and its colon, and returns where
// the member's value starts.
func scanKey(data []byte, i int) (int, error) {
	i, err := scanString(data, i)
	if err != nil {
		return 0, err
	}
	if i = skipSpace(data, i); byteAt(data, i) != ':' {
		return 0, errInvalidJSON
	}
	return skipSpace(data, i+1), nil
}

func scanString(data []byte, i int) (int, error) {
	if byteAt(data, i) != '"' {
		return 0, errInvalidJSON
	}
	for i++; i < len(data); i++ {
		switch c := data[i]; {
		case c == '"':
			return i + 1, nil
		case c < 0x20:
			return 0, errInvalidJSON
		case c == '\\':
			i++
			switch byteAt(data, i) {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			case 'u':
				for range 4 {
					if i++; !isHexDigit(byteAt(data, i)) {
						return 0, errInvalidJSON
					}
				}
			default:
				return 0, errInvalidJSON
			}
		}
	}
	return 0, errInvalidJSON
}

func scanNumber(data []byte, i int) (int, error) {
	if byteAt(data, i) == '-' {
		i++
	}
	switch c := byteAt(data, i); {
	case c == '0':
		i++
	case c >= '1' && c <= '9':
		i = scanDigits(data, i)
	default:
		return 0, errInvalidJSON
	}
	if byteAt(data, i) == '.' {
		if !isDigit(byteAt(data, i+1)) {
			return 0, errInvalidJSON
		}
		i = scanDigits(data, i+1)
	}
	if c := byteAt(data, i); c == 'e' || c == 'E' {
		if c := byteAt(data, i+1); c == '+' || c == '-' {
			i++
		}
		if !isDigit(byteAt(data, i+1)) {
			return 0, errInvalidJSON
		}
		i = scanDigits(data, i+1)
	}
	return i, nil
}

func scanLiteral(data []byte, i int) (int, error) {
	for _, literal := range [...]string{"true", "false", "null"} {
		if len(data)-i >= len(literal) && string(data[i:i+len(literal)]) == literal {
			return i + len(literal), nil
		}
	}
	return 0, errInvalidJSON
}

func scanDigits(data []byte, i int) int {
	for isDigit(byteAt(data, i)) {
		i++
	}
	return i
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func isHexDigit(c byte) bool {
	return isDigit(c) || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}
