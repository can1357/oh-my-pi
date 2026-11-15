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

package main

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var (
	testDataDir = flag.String("testdata", "testdata", "The path to the test data directory.")
	update      = flag.Bool("update", false, "If true, update output files rather than compare them.")
)

type delocateTest struct {
	name string
	in   []string
	out  string
}

func (test *delocateTest) Path(file string) string {
	return filepath.Join(*testDataDir, test.name, file)
}

var delocateTests = []delocateTest{
	{"generic-FileDirectives", []string{"in.s"}, "out.s"},
	{"x86_64-Basic", []string{"in.s"}, "out.s"},
	{"x86_64-BSS", []string{"in.s"}, "out.s"},
	{"x86_64-GOTRewrite", []string{"in.s"}, "out.s"},
	{"x86_64-LargeMemory", []string{"in.s"}, "out.s"},
	{"x86_64-LabelRewrite", []string{"in1.s", "in2.s"}, "out.s"},
	{"x86_64-Sections", []string{"in.s"}, "out.s"},
	{"x86_64-ThreeArg", []string{"in.s"}, "out.s"},
	{"aarch64-Basic", []string{"in.s"}, "out.s"},
}

func TestDelocate(t *testing.T) {
	for _, test := range delocateTests {
		t.Run(test.name, func(t *testing.T) {
			var inputs []inputFile
			for i, in := range test.in {
				inputs = append(inputs, inputFile{
					index: i,
					path:  test.Path(in),
				})
			}

			if err := parseInputs(inputs, nil); err != nil {
				t.Fatalf("parseInputs failed: %s", err)
			}

			var buf bytes.Buffer
			if err := transform(&buf, inputs); err != nil {
				t.Fatalf("transform failed: %s", err)
			}

			if *update {
				os.WriteFile(test.Path(test.out), buf.Bytes(), 0666)
			} else {
				expected, err := os.ReadFile(test.Path(test.out))
				if err != nil {
					t.Fatalf("could not read %q: %s", test.Path(test.out), err)
				}
				if !bytes.Equal(buf.Bytes(), expected) {
					t.Errorf("delocated output differed. Wanted:\n%s\nGot:\n%s\n", expected, buf.Bytes())
				}
			}
		})
	}
}
