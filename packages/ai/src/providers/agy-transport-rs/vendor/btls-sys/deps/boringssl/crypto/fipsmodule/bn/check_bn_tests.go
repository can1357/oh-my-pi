// Copyright 2016 The BoringSSL Authors
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
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
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

func checkResult(t test, expr, key string, r *big.Int) {
	if t.Values[key].Cmp(r) != 0 {
		fmt.Fprintf(os.Stderr, "Line %d: %s did not match %s.\n\tGot %s\n", t.LineNumber, expr, key, r.Text(16))
	}
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s bn_tests.txt\n", os.Args[0])
		os.Exit(1)
	}

	in, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening %s: %s.\n", os.Args[0], err)
		os.Exit(1)
	}
	defer in.Close()

	scanner := newTestScanner(in)
	for scanner.Scan() {
		test := scanner.Test()
		switch test.Type {
		case "Sum":
			if checkKeys(test, "A", "B", "Sum") {
				r := new(big.Int).Add(test.Values["A"], test.Values["B"])
				checkResult(test, "A + B", "Sum", r)
			}
		case "LShift1":
			if checkKeys(test, "A", "LShift1") {
				r := new(big.Int).Add(test.Values["A"], test.Values["A"])
				checkResult(test, "A + A", "LShift1", r)
			}
		case "LShift":
			if checkKeys(test, "A", "N", "LShift") {
				r := new(big.Int).Lsh(test.Values["A"], uint(test.Values["N"].Uint64()))
				checkResult(test, "A << N", "LShift", r)
			}
		case "RShift":
			if checkKeys(test, "A", "N", "RShift") {
				r := new(big.Int).Rsh(test.Values["A"], uint(test.Values["N"].Uint64()))
				checkResult(test, "A >> N", "RShift", r)
			}
		case "Square":
			if checkKeys(test, "A", "Square") {
				r := new(big.Int).Mul(test.Values["A"], test.Values["A"])
				checkResult(test, "A * A", "Square", r)
			}
		case "Product":
			if checkKeys(test, "A", "B", "Product") {
				r := new(big.Int).Mul(test.Values["A"], test.Values["B"])
				checkResult(test, "A * B", "Product", r)
			}
		case "Quotient":
			if checkKeys(test, "A", "B", "Quotient", "Remainder") {
				q, r := new(big.Int).QuoRem(test.Values["A"], test.Values["B"], new(big.Int))
				checkResult(test, "A / B", "Quotient", q)
				checkResult(test, "A % B", "Remainder", r)
			}
		case "ModMul":
			if checkKeys(test, "A", "B", "M", "ModMul") {
				r := new(big.Int).Mul(test.Values["A"], test.Values["B"])
				r = r.Mod(r, test.Values["M"])
				checkResult(test, "A * B (mod M)", "ModMul", r)
			}
		case "ModExp":
			if checkKeys(test, "A", "E", "M", "ModExp") {
				r := new(big.Int).Exp(test.Values["A"], test.Values["E"], test.Values["M"])
				checkResult(test, "A ^ E (mod M)", "ModExp", r)
			}
		case "Exp":
			if checkKeys(test, "A", "E", "Exp") {
				r := new(big.Int).Exp(test.Values["A"], test.Values["E"], nil)
				checkResult(test, "A ^ E", "Exp", r)
			}
		case "ModSqrt":
			bigOne := big.NewInt(1)
			bigTwo := big.NewInt(2)

			if checkKeys(test, "A", "P", "ModSqrt") {
				test.Values["A"].Mod(test.Values["A"], test.Values["P"])

				r := new(big.Int).Mul(test.Values["ModSqrt"], test.Values["ModSqrt"])
				r = r.Mod(r, test.Values["P"])
				checkResult(test, "ModSqrt ^ 2 (mod P)", "A", r)

				if test.Values["P"].Cmp(bigTwo) > 0 {
					pMinus1Over2 := new(big.Int).Sub(test.Values["P"], bigOne)
					pMinus1Over2.Rsh(pMinus1Over2, 1)

					if test.Values["ModSqrt"].Cmp(pMinus1Over2) > 0 {
						fmt.Fprintf(os.Stderr, "Line %d: ModSqrt should be minimal.\n", test.LineNumber)
					}
				}
			}
		case "ModInv":
			if checkKeys(test, "A", "M", "ModInv") {
				a := test.Values["A"]
				m := test.Values["M"]
				var r *big.Int
				if a.Sign() == 0 && m.IsInt64() && m.Int64() == 1 {
					// OpenSSL says 0^(-1) mod (1) is 0, while Go says the
					// inverse does not exist.
					r = big.NewInt(0)
				} else {
					r = new(big.Int).ModInverse(a, m)
				}
				if r == nil {
					fmt.Fprintf(os.Stderr, "Line %d: A has no inverse mod M.\n", test.LineNumber)
				} else {
					checkResult(test, "A ^ -1 (mod M)", "ModInv", r)
				}
			}
		case "ModSquare":
			if checkKeys(test, "A", "M", "ModSquare") {
				r := new(big.Int).Mul(test.Values["A"], test.Values["A"])
				r = r.Mod(r, test.Values["M"])
				checkResult(test, "A * A (mod M)", "ModSquare", r)
			}
		case "NotModSquare":
			if checkKeys(test, "P", "NotModSquare") {
				if new(big.Int).ModSqrt(test.Values["NotModSquare"], test.Values["P"]) != nil {
					fmt.Fprintf(os.Stderr, "Line %d: value was a square.\n", test.LineNumber)
				}
			}
		case "GCD":
			if checkKeys(test, "A", "B", "GCD", "LCM") {
				a := test.Values["A"]
				b := test.Values["B"]
				// Go's GCD function does not accept zero, unlike OpenSSL.
				var g *big.Int
				if a.Sign() == 0 {
					g = b
				} else if b.Sign() == 0 {
					g = a
				} else {
					g = new(big.Int).GCD(nil, nil, a, b)
				}
				checkResult(test, "GCD(A, B)", "GCD", g)
				if g.Sign() != 0 {
					lcm := new(big.Int).Mul(a, b)
					lcm = lcm.Div(lcm, g)
					checkResult(test, "LCM(A, B)", "LCM", lcm)
				}
			}
		default:
			fmt.Fprintf(os.Stderr, "Line %d: unknown test type %q.\n", test.LineNumber, test.Type)
		}
	}
	if scanner.Err() != nil {
		fmt.Fprintf(os.Stderr, "Error reading tests: %s.\n", scanner.Err())
	}
}
