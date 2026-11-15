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

// godeps prints out dependencies of a package in either CMake or Make depfile
// format, for incremental rebuilds.
//
// The depfile format is preferred. It works correctly when new files are added.
// However, CMake only supports depfiles for custom commands with Ninja and
// starting CMake 3.7. For other configurations, we also support CMake's format,
// but CMake must be rerun when file lists change.
package main

import (
	"flag"
	"fmt"
	"go/build"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	format  = flag.String("format", "cmake", "The format to output to, either 'cmake' or 'depfile'")
	mainPkg = flag.String("pkg", "", "The package to print dependencies for")
	target  = flag.String("target", "", "The name of the output file")
	out     = flag.String("out", "", "The path to write the output to. If unset, this is stdout")
)

func cMakeQuote(in string) string {
	// See https://cmake.org/cmake/help/v3.0/manual/cmake-language.7.html#quoted-argument
	var b strings.Builder
	b.Grow(len(in))
	// Iterate over in as bytes.
	for i := 0; i < len(in); i++ {
		switch c := in[i]; c {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteByte(c)
		case '\t':
			b.WriteString("\\t")
		case '\r':
			b.WriteString("\\r")
		case '\n':
			b.WriteString("\\n")
		default:
			b.WriteByte(in[i])
		}
	}
	return b.String()
}

func writeCMake(outFile *os.File, files []string) error {
	for i, file := range files {
		if i != 0 {
			if _, err := outFile.WriteString(";"); err != nil {
				return err
			}
		}
		if _, err := outFile.WriteString(cMakeQuote(file)); err != nil {
			return err
		}
	}
	return nil
}

func makeQuote(in string) string {
	// See https://www.gnu.org/software/make/manual/make.html#Rule-Syntax
	var b strings.Builder
	b.Grow(len(in))
	// Iterate over in as bytes.
	for i := 0; i < len(in); i++ {
		switch c := in[i]; c {
		case '$':
			b.WriteString("$$")
		case '#', '\\', ' ':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func writeDepfile(outFile *os.File, files []string) error {
	if _, err := fmt.Fprintf(outFile, "%s:", makeQuote(*target)); err != nil {
		return err
	}
	for _, file := range files {
		if _, err := fmt.Fprintf(outFile, " %s", makeQuote(file)); err != nil {
			return err
		}
	}
	_, err := outFile.WriteString("\n")
	return err
}

func appendPrefixed(list, newFiles []string, prefix string) []string {
	for _, file := range newFiles {
		list = append(list, filepath.Join(prefix, file))
	}
	return list
}

func main() {
	flag.Parse()

	if len(*mainPkg) == 0 {
		fmt.Fprintf(os.Stderr, "-pkg argument is required.\n")
		os.Exit(1)
	}

	var isDepfile bool
	switch *format {
	case "depfile":
		isDepfile = true
	case "cmake":
		isDepfile = false
	default:
		fmt.Fprintf(os.Stderr, "Unknown format: %q\n", *format)
		os.Exit(1)
	}

	if isDepfile && len(*target) == 0 {
		fmt.Fprintf(os.Stderr, "-target argument is required for depfile.\n")
		os.Exit(1)
	}

	done := make(map[string]struct{})
	var files []string
	var recurse func(pkgName string) error
	recurse = func(pkgName string) error {
		pkg, err := build.Default.Import(pkgName, ".", 0)
		if err != nil {
			return err
		}

		// Skip standard packages.
		if pkg.Goroot {
			return nil
		}

		// Skip already-visited packages.
		if _, ok := done[pkg.Dir]; ok {
			return nil
		}
		done[pkg.Dir] = struct{}{}

		files = appendPrefixed(files, pkg.GoFiles, pkg.Dir)
		files = appendPrefixed(files, pkg.CgoFiles, pkg.Dir)
		// Include ignored Go files. A subsequent change may cause them
		// to no longer be ignored.
		files = appendPrefixed(files, pkg.IgnoredGoFiles, pkg.Dir)

		// Recurse into imports.
		for _, importName := range pkg.Imports {
			if err := recurse(importName); err != nil {
				return err
			}
		}
		return nil
	}
	if err := recurse(*mainPkg); err != nil {
		fmt.Fprintf(os.Stderr, "Error getting dependencies: %s\n", err)
		os.Exit(1)
	}

	sort.Strings(files)

	outFile := os.Stdout
	if len(*out) != 0 {
		var err error
		outFile, err = os.Create(*out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error writing output: %s\n", err)
			os.Exit(1)
		}
		defer outFile.Close()
	}

	var err error
	if isDepfile {
		err = writeDepfile(outFile, files)
	} else {
		err = writeCMake(outFile, files)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error writing output: %s\n", err)
		os.Exit(1)
	}
}
