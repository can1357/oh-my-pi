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
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

var (
	boringsslDir = flag.String("boringssl", ".", "The path to the BoringSSL checkout.")
	opensslDir   = flag.String("openssl", filepath.Join("..", "openssl"), "The path to the OpenSSL checkout.")
)

func mapName(path string) string {
	path = strings.Replace(path, filepath.FromSlash("/fipsmodule/"), string(filepath.Separator), 1)
	pathSlash := filepath.ToSlash(path)
	if strings.HasPrefix(pathSlash, "crypto/test/") {
		return ""
	}
	switch pathSlash {
	case "crypto/aes/asm/vpaes-armv7.pl",
		"crypto/bn/asm/bn-armv8.pl",
		"crypto/cipher/asm/aes128gcmsiv-x86_64.pl",
		"crypto/cipher/asm/chacha20_poly1305_armv8.pl",
		"crypto/cipher/asm/chacha20_poly1305_x86_64.pl",
		"crypto/ec/asm/p256_beeu-armv8-asm.pl",
		"crypto/ec/asm/p256_beeu-x86_64-asm.pl",
		"crypto/modes/asm/aesv8-gcm-armv8.pl",
		"crypto/modes/asm/ghash-neon-armv8.pl",
		"crypto/modes/asm/ghash-ssse3-x86.pl",
		"crypto/modes/asm/ghash-ssse3-x86_64.pl",
		"crypto/rand/asm/rdrand-x86_64.pl":
		return ""
	case "crypto/ec/asm/p256-x86_64-asm.pl":
		return filepath.FromSlash("crypto/ec/asm/ecp_nistz256-x86_64.pl")
	case "crypto/ec/asm/p256-armv8-asm.pl":
		return filepath.FromSlash("crypto/ec/asm/ecp_nistz256-armv8.pl")
	}
	return path
}

func diff(from, to string) error {
	cmd := exec.Command("diff", "-u", "--", from, to)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	// diff returns exit code 1 if the files differ but it was otherwise
	// successful.
	if exitError, ok := err.(*exec.ExitError); ok && exitError.Sys().(syscall.WaitStatus).ExitStatus() == 1 {
		return nil
	}
	return err
}

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: diff_asm [flag...] [filter...]\n")
		fmt.Fprintf(os.Stderr, "Filter arguments limit to assembly files which match arguments.\n")
		fmt.Fprintf(os.Stderr, "If not using a filter, piping to `diffstat` may be useful.\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	// Find all the assembly files.
	var files []string
	err := filepath.Walk(*boringsslDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		path, err = filepath.Rel(*boringsslDir, path)
		if err != nil {
			return err
		}

		dir := filepath.Base(filepath.Dir(path))
		if !info.IsDir() && (dir == "asm" || dir == "perlasm") && strings.HasSuffix(filepath.Base(path), ".pl") {
			files = append(files, path)
		}

		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error finding assembly: %s\n", err)
		os.Exit(1)
	}

	for _, file := range files {
		opensslFile := mapName(file)
		if len(opensslFile) == 0 {
			continue
		}

		if flag.NArg() > 0 {
			var found bool
			for _, arg := range flag.Args() {
				if strings.Contains(file, arg) {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		if err := diff(filepath.Join(*opensslDir, opensslFile), filepath.Join(*boringsslDir, file)); err != nil {
			fmt.Fprintf(os.Stderr, "Error comparing %s: %s\n", file, err)
			os.Exit(1)
		}
	}
}
