// Copyright (c) 2020 The BoringSSL Authors
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

// compare_benchmarks takes the JSON-formatted output of bssl speed and
// compares it against a baseline output.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

var baselineFile = flag.String("baseline", "", "the path to the JSON file containing the base results")

type Result struct {
	Description  string `json:"description"`
	NumCalls     int    `json:"numCalls"`
	Microseconds int    `json:"microseconds"`
	BytesPerCall int    `json:"bytesPerCall"`
}

func (r *Result) Speed() (float64, string) {
	callsPerSecond := float64(r.NumCalls) / float64(r.Microseconds) * 1000000
	if r.BytesPerCall == 0 {
		return callsPerSecond, "ops/sec"
	}
	return callsPerSecond * float64(r.BytesPerCall) / 1000000, "MB/sec"
}

func printResult(result Result, baseline *Result) error {
	if baseline != nil {
		if result.Description != baseline.Description {
			return fmt.Errorf("result did not match baseline: %q vs %q", result.Description, baseline.Description)
		}

		if result.BytesPerCall != baseline.BytesPerCall {
			return fmt.Errorf("result %q bytes per call did not match baseline: %d vs %d", result.Description, result.BytesPerCall, baseline.BytesPerCall)
		}
	}

	newSpeed, unit := result.Speed()
	fmt.Printf("Did %d %s operations in %dus (%.1f %s)", result.NumCalls, result.Description, result.Microseconds, newSpeed, unit)
	if baseline != nil {
		oldSpeed, _ := baseline.Speed()
		fmt.Printf(" [%+.1f%%]", (newSpeed-oldSpeed)/oldSpeed*100)
	}
	fmt.Printf("\n")
	return nil
}

func readResults(path string) ([]Result, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var ret []Result
	if err := json.Unmarshal(data, &ret); err != nil {
		return nil, err
	}
	return ret, nil
}

func main() {
	flag.Parse()

	baseline, err := readResults(*baselineFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading %q: %s\n", *baselineFile, err)
		os.Exit(1)
	}

	fmt.Println(*baselineFile)
	for _, result := range baseline {
		if err := printResult(result, nil); err != nil {
			fmt.Fprintf(os.Stderr, "Error in %q: %s\n", *baselineFile, err)
			os.Exit(1)
		}
	}

	for _, arg := range flag.Args() {
		results, err := readResults(arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading %q: %s\n", arg, err)
			os.Exit(1)
		}

		if len(results) != len(baseline) {
			fmt.Fprintf(os.Stderr, "Result files %q and %q have different lengths\n", arg, *baselineFile)
			os.Exit(1)
		}

		fmt.Printf("\n%s\n", arg)
		for i, result := range results {
			if err := printResult(result, &baseline[i]); err != nil {
				fmt.Fprintf(os.Stderr, "Error in %q: %s\n", arg, err)
				os.Exit(1)
			}
		}
	}
}
