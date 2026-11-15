// Copyright 2021 The BoringSSL Authors
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

// trimvectors takes an ACVP vector set file and discards all but a single test
// from each test group, and also discards any test that serializes to more than
// 4096 bytes. This hope is that this achieves good coverage without having to
// check in megabytes worth of JSON files.
package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"os"
	"slices"
)

func main() {
	var vectorSets []any
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&vectorSets); err != nil {
		panic(err)
	}

	// The first element is the metadata which is left unmodified.
	for i := 1; i < len(vectorSets); i++ {
		vectorSet := vectorSets[i].(map[string]any)
		testGroups := vectorSet["testGroups"].([]any)
		for _, testGroupInterface := range testGroups {
			testGroup := testGroupInterface.(map[string]any)
			tests := testGroup["tests"].([]any)

			// Take only the smallest test.
			type testAndSize struct {
				test any
				size int
			}
			var testsAndSizes []testAndSize

			for _, test := range tests {
				var b bytes.Buffer
				encoder := json.NewEncoder(&b)
				if err := encoder.Encode(test); err != nil {
					panic(err)
				}
				testsAndSizes = append(testsAndSizes, testAndSize{test, b.Len()})
			}

			slices.SortFunc(testsAndSizes, func(a, b testAndSize) int {
				return cmp.Compare(a.size, b.size)
			})
			testGroup["tests"] = []any{testsAndSizes[0].test}
		}
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(vectorSets); err != nil {
		panic(err)
	}
}
