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

// check_imported_libraries.go checks that each of its arguments only imports
// allowed libraries. This is used to avoid accidental dependencies on
// libstdc++.so.
package main

import (
	"debug/elf"
	"fmt"
	"os"
	"path/filepath"
)

func checkImportedLibraries(path string) bool {
	file, err := elf.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening %s: %s\n", path, err)
		return false
	}
	defer file.Close()

	libs, err := file.ImportedLibraries()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading %s: %s\n", path, err)
		return false
	}

	allowCpp := filepath.Base(path) == "libssl.so"
	for _, lib := range libs {
		if lib == "libc.so.6" || lib == "libcrypto.so" || lib == "libpthread.so.0" || lib == "libgcc_s.so.1" {
			continue
		}
		if allowCpp && lib == "libstdc++.so.6" {
			continue
		}
		fmt.Printf("Invalid dependency for %s: %s\n", path, lib)
		fmt.Printf("All dependencies:\n")
		for _, lib := range libs {
			fmt.Printf("    %s\n", lib)
		}
		return false
	}
	return true
}

func main() {
	ok := true
	for _, path := range os.Args[1:] {
		if !checkImportedLibraries(path) {
			ok = false
		}
	}
	if !ok {
		os.Exit(1)
	}
}
