// Copyright 2022 The BoringSSL Authors
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

// check_stack.go checks that each of its arguments has a non-executable stack.
// See https://www.airs.com/blog/archives/518 for details.
package main

import (
	"debug/elf"
	"fmt"
	"os"
)

func checkStack(path string) {
	file, err := elf.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening %s: %s\n", path, err)
		os.Exit(1)
	}
	defer file.Close()

	for _, prog := range file.Progs {
		if prog.Type == elf.PT_GNU_STACK && prog.Flags&elf.PF_X != 0 {
			fmt.Fprintf(os.Stderr, "%s has an executable stack.\n", path)
			os.Exit(1)
		}
	}
}

func main() {
	for _, path := range os.Args[1:] {
		checkStack(path)
	}
}
