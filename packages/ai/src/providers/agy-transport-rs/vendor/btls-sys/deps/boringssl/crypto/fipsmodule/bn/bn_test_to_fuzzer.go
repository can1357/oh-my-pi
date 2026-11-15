// Copyright 2017 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//go:build ignore

package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
)

type test struct {
	LineNumber int
	Type       string
	Values     map[string]*big.Int
}

type testScanner struct {
	scanner *bufio.Scanner
	lineNo  int
	err     error
	test    test
}

func newTestScanner(r io.Reader) *testScanner {
	return &testScanner{scanner: bufio.NewScanner(r)}
}

func (s *testScanner) scanLine() bool {
	if !s.scanner.Scan() {
		return false
	}
	s.lineNo++
	return true
}

func (s *testScanner) addAttribute(line string) (key string, ok bool) {
	fields := strings.SplitN(line, "=", 2)
	if len(fields) != 2 {
		s.setError(errors.New("invalid syntax"))
		return "", false
	}

	key = strings.TrimSpace(fields[0])
	value := strings.TrimSpace(fields[1])

	valueInt, ok := new(big.Int).SetString(value, 16)
	if !ok {
		s.setError(fmt.Errorf("could not parse %q", value))
		return "", false
	}
	if _, dup := s.test.Values[key]; dup {
		s.setError(fmt.Errorf("duplicate key %q", key))
		return "", false
	}
	s.test.Values[key] = valueInt
	return key, true
}

func (s *testScanner) Scan() bool {
	s.test = test{
		Values: make(map[string]*big.Int),
	}

	// Scan until the first attribute.
	for {
		if !s.scanLine() {
			return false
		}
		if len(s.scanner.Text()) != 0 && s.scanner.Text()[0] != '#' {
			break
		}
	}

	var ok bool
	s.test.Type, ok = s.addAttribute(s.scanner.Text())
	if !ok {
		return false
	}
	s.test.LineNumber = s.lineNo

	for s.scanLine() {
		if len(s.scanner.Text()) == 0 {
			break
		}

		if s.scanner.Text()[0] == '#' {
			continue
		}

		if _, ok := s.addAttribute(s.scanner.Text()); !ok {
			return false
		}
	}
	return s.scanner.Err() == nil
}

func (s *testScanner) Test() test {
	return s.test
}

func (s *testScanner) Err() error {
	if s.err != nil {
		return s.err
	}
	return s.scanner.Err()
}

func (s *testScanner) setError(err error) {
	s.err = fmt.Errorf("line %d: %s", s.lineNo, err)
}

func checkKeys(t test, keys ...string) bool {
	var foundErrors bool

	for _, k := range keys {
		if _, ok := t.Values[k]; !ok {
			fmt.Fprintf(os.Stderr, "Line %d: missing key %q.\n", t.LineNumber, k)
			foundErrors = true
		}
	}

	for k := range t.Values {
		var found bool
		for _, k2 := range keys {
			if k == k2 {
				found = true
				break
			}
		}
		if !found {
			fmt.Fprintf(os.Stderr, "Line %d: unexpected key %q.\n", t.LineNumber, k)
			foundErrors = true
		}
	}

	return !foundErrors
}

func appendLengthPrefixed(ret, b []byte) []byte {
	ret = append(ret, byte(len(b)>>8), byte(len(b)))
	ret = append(ret, b...)
	return ret
}

func appendUnsigned(ret []byte, n *big.Int) []byte {
	b := n.Bytes()
	if n.Sign() == 0 {
		b = []byte{0}
	}
	return appendLengthPrefixed(ret, b)
}

func appendSigned(ret []byte, n *big.Int) []byte {
	var sign byte
	if n.Sign() < 0 {
		sign = 1
	}
	b := []byte{sign}
	b = append(b, n.Bytes()...)
	if n.Sign() == 0 {
		b = append(b, 0)
	}
	return appendLengthPrefixed(ret, b)
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "Usage: %s TESTS FUZZ_DIR\n", os.Args[0])
		os.Exit(1)
	}

	in, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening %s: %s.\n", os.Args[0], err)
		os.Exit(1)
	}
	defer in.Close()

	fuzzerDir := os.Args[2]

	scanner := newTestScanner(in)
	for scanner.Scan() {
		var fuzzer string
		var b []byte
		test := scanner.Test()
		switch test.Type {
		case "Quotient":
			if checkKeys(test, "A", "B", "Quotient", "Remainder") {
				fuzzer = "bn_div"
				b = appendSigned(b, test.Values["A"])
				b = appendSigned(b, test.Values["B"])
			}
		case "ModExp":
			if checkKeys(test, "A", "E", "M", "ModExp") {
				fuzzer = "bn_mod_exp"
				b = appendSigned(b, test.Values["A"])
				b = appendUnsigned(b, test.Values["E"])
				b = appendUnsigned(b, test.Values["M"])
			}
		}

		if len(fuzzer) != 0 {
			hash := sha1.Sum(b)
			path := filepath.Join(fuzzerDir, fuzzer+"_corpus", hex.EncodeToString(hash[:]))
			if err := os.WriteFile(path, b, 0666); err != nil {
				fmt.Fprintf(os.Stderr, "Error writing to %s: %s.\n", path, err)
				os.Exit(1)
			}
		}
	}
	if scanner.Err() != nil {
		fmt.Fprintf(os.Stderr, "Error reading tests: %s.\n", scanner.Err())
	}
}
