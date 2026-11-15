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

// read_symbols scans one or more .a files and, for each object contained in
// the .a files, reads the list of symbols in that object file.
package main

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"flag"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"

	"boringssl.googlesource.com/boringssl.git/util/ar"
)

const (
	ObjFileFormatELF   = "elf"
	ObjFileFormatMachO = "macho"
	ObjFileFormatPE    = "pe"
)

var (
	outFlag       = flag.String("out", "-", "File to write output symbols")
	objFileFormat = flag.String("obj-file-format", defaultObjFileFormat(runtime.GOOS), "Object file format to expect (options are elf, macho, pe)")
)

func defaultObjFileFormat(goos string) string {
	switch goos {
	case "linux":
		return ObjFileFormatELF
	case "darwin":
		return ObjFileFormatMachO
	case "windows":
		return ObjFileFormatPE
	default:
		// By returning a value here rather than panicking, the user can still
		// cross-compile from an unsupported platform to a supported platform by
		// overriding this default with a flag. If the user doesn't provide the
		// flag, we will panic during flag parsing.
		return "unsupported"
	}
}

func printAndExit(format string, args ...any) {
	s := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, s)
	os.Exit(1)
}

func main() {
	flag.Parse()
	if flag.NArg() < 1 {
		printAndExit("Usage: %s [-out OUT] [-obj-file-format FORMAT] ARCHIVE_FILE [ARCHIVE_FILE [...]]", os.Args[0])
	}
	archiveFiles := flag.Args()

	out := os.Stdout
	if *outFlag != "-" {
		var err error
		out, err = os.Create(*outFlag)
		if err != nil {
			printAndExit("Error opening %q: %s", *outFlag, err)
		}
		defer out.Close()
	}

	var symbols []string
	// Only add first instance of any symbol; keep track of them in this map.
	added := make(map[string]struct{})
	for _, archive := range archiveFiles {
		f, err := os.Open(archive)
		if err != nil {
			printAndExit("Error opening %s: %s", archive, err)
		}
		objectFiles, err := ar.ParseAR(f)
		f.Close()
		if err != nil {
			printAndExit("Error parsing %s: %s", archive, err)
		}

		for name, contents := range objectFiles {
			syms, err := listSymbols(contents)
			if err != nil {
				printAndExit("Error listing symbols from %q in %q: %s", name, archive, err)
			}
			for _, s := range syms {
				if _, ok := added[s]; !ok {
					added[s] = struct{}{}
					symbols = append(symbols, s)
				}
			}
		}
	}

	sort.Strings(symbols)
	for _, s := range symbols {
		var skipSymbols = []string{
			// Inline functions, etc., from the compiler or language
			// runtime will naturally end up in the library, to be
			// deduplicated against other object files. Such symbols
			// should not be prefixed. It is a limitation of this
			// symbol-prefixing strategy that we cannot distinguish
			// our own inline symbols (which should be prefixed)
			// from the system's (which should not), so we skip known
			// system symbols.
			"__local_stdio_printf_options",
			"__local_stdio_scanf_options",
			"_vscprintf",
			"_vscprintf_l",
			"_vsscanf_l",
			"_xmm",
			"sscanf",
			"vsnprintf",
			// sdallocx is a weak symbol and intended to merge with
			// the real one, if present.
			"sdallocx",
		}
		var skip bool
		for _, sym := range skipSymbols {
			if sym == s {
				skip = true
				break
			}
		}
		if skip || isCXXSymbol(s) || strings.HasPrefix(s, "__real@") || strings.HasPrefix(s, "__x86.get_pc_thunk.") || strings.HasPrefix(s, "DW.") {
			continue
		}
		if _, err := fmt.Fprintln(out, s); err != nil {
			printAndExit("Error writing to %s: %s", *outFlag, err)
		}
	}
}

func isCXXSymbol(s string) bool {
	if *objFileFormat == ObjFileFormatPE {
		return strings.HasPrefix(s, "?")
	}
	return strings.HasPrefix(s, "_Z")
}

// listSymbols lists the exported symbols from an object file.
func listSymbols(contents []byte) ([]string, error) {
	switch *objFileFormat {
	case ObjFileFormatELF:
		return listSymbolsELF(contents)
	case ObjFileFormatMachO:
		return listSymbolsMachO(contents)
	case ObjFileFormatPE:
		return listSymbolsPE(contents)
	default:
		return nil, fmt.Errorf("unsupported object file format %q", *objFileFormat)
	}
}

func listSymbolsELF(contents []byte) ([]string, error) {
	f, err := elf.NewFile(bytes.NewReader(contents))
	if err != nil {
		return nil, err
	}
	syms, err := f.Symbols()
	if err == elf.ErrNoSymbols {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var names []string
	for _, sym := range syms {
		// Only include exported, defined symbols
		if elf.ST_BIND(sym.Info) != elf.STB_LOCAL && sym.Section != elf.SHN_UNDEF {
			names = append(names, sym.Name)
		}
	}
	return names, nil
}

func listSymbolsMachO(contents []byte) ([]string, error) {
	f, err := macho.NewFile(bytes.NewReader(contents))
	if err != nil {
		return nil, err
	}
	if f.Symtab == nil {
		return nil, nil
	}
	var names []string
	for _, sym := range f.Symtab.Syms {
		// Source: https://opensource.apple.com/source/xnu/xnu-3789.51.2/EXTERNAL_HEADERS/mach-o/nlist.h.auto.html
		const (
			N_PEXT uint8 = 0x10 // Private external symbol bit
			N_EXT  uint8 = 0x01 // External symbol bit, set for external symbols
			N_TYPE uint8 = 0x0e // mask for the type bits

			N_UNDF uint8 = 0x0 // undefined, n_sect == NO_SECT
			N_ABS  uint8 = 0x2 // absolute, n_sect == NO_SECT
			N_SECT uint8 = 0xe // defined in section number n_sect
			N_PBUD uint8 = 0xc // prebound undefined (defined in a dylib)
			N_INDR uint8 = 0xa // indirect
		)

		// Only include exported, defined symbols.
		if sym.Type&N_EXT != 0 && sym.Type&N_TYPE != N_UNDF {
			if len(sym.Name) == 0 || sym.Name[0] != '_' {
				return nil, fmt.Errorf("unexpected symbol without underscore prefix: %q", sym.Name)
			}
			names = append(names, sym.Name[1:])
		}
	}
	return names, nil
}

func listSymbolsPE(contents []byte) ([]string, error) {
	f, err := pe.NewFile(bytes.NewReader(contents))
	if err != nil {
		return nil, err
	}
	var ret []string
	for _, sym := range f.Symbols {
		const (
			// https://docs.microsoft.com/en-us/windows/desktop/debug/pe-format#section-number-values
			IMAGE_SYM_UNDEFINED = 0
			// https://docs.microsoft.com/en-us/windows/desktop/debug/pe-format#storage-class
			IMAGE_SYM_CLASS_EXTERNAL = 2
		)
		if sym.SectionNumber != IMAGE_SYM_UNDEFINED && sym.StorageClass == IMAGE_SYM_CLASS_EXTERNAL {
			name := sym.Name
			if f.Machine == pe.IMAGE_FILE_MACHINE_I386 {
				// On 32-bit Windows, C symbols are decorated by calling
				// convention.
				// https://msdn.microsoft.com/en-us/library/56h2zst2.aspx#FormatC
				if strings.HasPrefix(name, "_") || strings.HasPrefix(name, "@") {
					// __cdecl, __stdcall, or __fastcall. Remove the prefix and
					// suffix, if present.
					name = name[1:]
					if idx := strings.LastIndex(name, "@"); idx >= 0 {
						name = name[:idx]
					}
				} else if idx := strings.LastIndex(name, "@@"); idx >= 0 {
					// __vectorcall. Remove the suffix.
					name = name[:idx]
				}
			}
			ret = append(ret, name)
		}
	}
	return ret, nil
}
