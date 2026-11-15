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

// This program takes a file containing newline-separated symbols, and generates
// boringssl_prefix_symbols.h, boringssl_prefix_symbols_asm.h, and
// boringssl_prefix_symbols_nasm.inc. These header files can be used to build
// BoringSSL with a prefix for all symbols in order to avoid symbol name
// conflicts when linking a project with multiple copies of BoringSSL; see
// BUILDING.md for more details.
package main

// TODO(joshlf): For platforms which support it, use '#pragma redefine_extname'
// instead of a custom macro. This avoids the need for a custom macro, but also
// ensures that our renaming won't conflict with symbols defined and used by our
// consumers (the "HMAC" problem). An example of this approach can be seen in
// IllumOS' fork of OpenSSL:
// https://github.com/joyent/illumos-extra/blob/master/openssl1x/sunw_prefix.h

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var out = flag.String("out", ".", "Path to a directory where the outputs will be written")

// Read newline-separated symbols from a file, ignoring any comments started
// with '#'.
func readSymbols(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	var ret []string
	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.IndexByte(line, '#'); idx >= 0 {
			line = line[:idx]
		}
		line = strings.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		ret = append(ret, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return ret, nil
}

func writeCHeader(symbols []string, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.WriteString(`// Copyright 2018 The BoringSSL Authors
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

// BORINGSSL_ADD_PREFIX pastes two identifiers into one. It performs one
// iteration of macro expansion on its arguments before pasting.
#define BORINGSSL_ADD_PREFIX(a, b) BORINGSSL_ADD_PREFIX_INNER(a, b)
#define BORINGSSL_ADD_PREFIX_INNER(a, b) a ## _ ## b

`); err != nil {
		return err
	}

	for _, symbol := range symbols {
		if _, err := fmt.Fprintf(f, "#define %s BORINGSSL_ADD_PREFIX(BORINGSSL_PREFIX, %s)\n", symbol, symbol); err != nil {
			return err
		}
	}

	return nil
}

func writeASMHeader(symbols []string, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.WriteString(`// Copyright 2018 The BoringSSL Authors
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

#if !defined(__APPLE__)
#include <boringssl_prefix_symbols.h>
#else
// On iOS and macOS, we need to treat assembly symbols differently from other
// symbols. The linker expects symbols to be prefixed with an underscore.
// Perlasm thus generates symbol with this underscore applied. Our macros must,
// in turn, incorporate it.
#define BORINGSSL_ADD_PREFIX_MAC_ASM(a, b) BORINGSSL_ADD_PREFIX_INNER_MAC_ASM(a, b)
#define BORINGSSL_ADD_PREFIX_INNER_MAC_ASM(a, b) _ ## a ## _ ## b

`); err != nil {
		return err
	}

	for _, symbol := range symbols {
		if _, err := fmt.Fprintf(f, "#define _%s BORINGSSL_ADD_PREFIX_MAC_ASM(BORINGSSL_PREFIX, %s)\n", symbol, symbol); err != nil {
			return err
		}
	}

	_, err = fmt.Fprintf(f, "#endif\n")
	return nil
}

func writeNASMHeader(symbols []string, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	// NASM uses a different syntax from the C preprocessor.
	if _, err := f.WriteString(`; Copyright 2018 The BoringSSL Authors
;
; Licensed under the Apache License, Version 2.0 (the "License");
; you may not use this file except in compliance with the License.
; You may obtain a copy of the License at
;
;     https://www.apache.org/licenses/LICENSE-2.0
;
; Unless required by applicable law or agreed to in writing, software
; distributed under the License is distributed on an "AS IS" BASIS,
; WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
; See the License for the specific language governing permissions and
; limitations under the License.

; 32-bit Windows adds underscores to C functions, while 64-bit Windows does not.
%ifidn __OUTPUT_FORMAT__, win32
`); err != nil {
		return err
	}

	for _, symbol := range symbols {
		if _, err := fmt.Fprintf(f, "%%xdefine _%s _ %%+ BORINGSSL_PREFIX %%+ _%s\n", symbol, symbol); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprintf(f, "%%else\n"); err != nil {
		return err
	}

	for _, symbol := range symbols {
		if _, err := fmt.Fprintf(f, "%%xdefine %s BORINGSSL_PREFIX %%+ _%s\n", symbol, symbol); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprintf(f, "%%endif\n"); err != nil {
		return err
	}

	return nil
}

func main() {
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintf(os.Stderr, "Usage: %s [-out OUT] SYMBOLS\n", os.Args[0])
		os.Exit(1)
	}

	symbols, err := readSymbols(flag.Arg(0))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading symbols: %s\n", err)
		os.Exit(1)
	}

	if err := writeCHeader(symbols, filepath.Join(*out, "boringssl_prefix_symbols.h")); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing boringssl_prefix_symbols.h: %s\n", err)
		os.Exit(1)
	}

	if err := writeASMHeader(symbols, filepath.Join(*out, "boringssl_prefix_symbols_asm.h")); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing boringssl_prefix_symbols_asm.h: %s\n", err)
		os.Exit(1)
	}

	if err := writeNASMHeader(symbols, filepath.Join(*out, "boringssl_prefix_symbols_nasm.inc")); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing boringssl_prefix_symbols_nasm.inc: %s\n", err)
		os.Exit(1)
	}

}
