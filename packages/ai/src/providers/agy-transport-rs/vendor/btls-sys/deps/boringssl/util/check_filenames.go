// Copyright 2018 The BoringSSL Authors
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

// check_filenames.go checks that filenames are unique. Some of our consumers do
// not support multiple files with the same name in the same build target, even
// if they are in different directories.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func isSourceFile(in string) bool {
	return strings.HasSuffix(in, ".c") || strings.HasSuffix(in, ".cc")
}

func main() {
	var roots = []string{
		"crypto",
		filepath.Join("third_party", "fiat"),
		"ssl",
	}

	names := make(map[string]string)
	var foundCollisions bool
	for _, root := range roots {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}
			name := strings.ToLower(info.Name()) // Windows and macOS are case-insensitive.
			if isSourceFile(name) {
				if oldPath, ok := names[name]; ok {
					fmt.Printf("Filename collision found: %s and %s\n", path, oldPath)
					foundCollisions = true
				} else {
					names[name] = path
				}
			}
			return nil
		})
		if err != nil {
			fmt.Printf("Error traversing %s: %s\n", root, err)
			os.Exit(1)
		}
	}
	if foundCollisions {
		os.Exit(1)
	}
}
