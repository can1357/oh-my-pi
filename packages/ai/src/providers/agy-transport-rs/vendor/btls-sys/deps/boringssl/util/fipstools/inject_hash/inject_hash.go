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

// inject_hash parses an archive containing a file object file. It finds a FIPS
// module inside that object, calculates its hash and replaces the default hash
// value in the object with the calculated value.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"debug/elf"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"boringssl.googlesource.com/boringssl.git/util/ar"
	"boringssl.googlesource.com/boringssl.git/util/fipstools/fipscommon"
)

func do(outPath, oInput string, arInput string) error {
	var objectBytes []byte
	var isStatic bool
	var perm os.FileMode

	if len(arInput) > 0 {
		isStatic = true

		if len(oInput) > 0 {
			return fmt.Errorf("-in-archive and -in-object are mutually exclusive")
		}

		fi, err := os.Stat(arInput)
		if err != nil {
			return err
		}
		perm = fi.Mode()

		arFile, err := os.Open(arInput)
		if err != nil {
			return err
		}
		defer arFile.Close()

		ar, err := ar.ParseAR(arFile)
		if err != nil {
			return err
		}

		if len(ar) != 1 {
			return fmt.Errorf("expected one file in archive, but found %d", len(ar))
		}

		for _, contents := range ar {
			objectBytes = contents
		}
	} else if len(oInput) > 0 {
		fi, err := os.Stat(oInput)
		if err != nil {
			return err
		}
		perm = fi.Mode()

		if objectBytes, err = os.ReadFile(oInput); err != nil {
			return err
		}
		isStatic = strings.HasSuffix(oInput, ".o")
	} else {
		return fmt.Errorf("exactly one of -in-archive or -in-object is required")
	}

	object, err := elf.NewFile(bytes.NewReader(objectBytes))
	if err != nil {
		return errors.New("failed to parse object: " + err.Error())
	}

	// Find the .text and, optionally, .data sections.

	var textSection, rodataSection *elf.Section
	var textSectionIndex, rodataSectionIndex elf.SectionIndex
	for i, section := range object.Sections {
		switch section.Name {
		case ".text":
			textSectionIndex = elf.SectionIndex(i)
			textSection = section
		case ".rodata":
			rodataSectionIndex = elf.SectionIndex(i)
			rodataSection = section
		}
	}

	if textSection == nil {
		return errors.New("failed to find .text section in object")
	}

	// Find the starting and ending symbols for the module.

	var textStart, textEnd, rodataStart, rodataEnd *uint64

	symbols, err := object.Symbols()
	if err != nil {
		return errors.New("failed to parse symbols: " + err.Error())
	}

	for _, symbol := range symbols {
		var base uint64
		switch symbol.Section {
		case textSectionIndex:
			base = textSection.Addr
		case rodataSectionIndex:
			if rodataSection == nil {
				continue
			}
			base = rodataSection.Addr
		default:
			continue
		}

		if isStatic {
			// Static objects appear to have different semantics about whether symbol
			// values are relative to their section or not.
			base = 0
		} else if symbol.Value < base {
			return fmt.Errorf("symbol %q at %x, which is below base of %x", symbol.Name, symbol.Value, base)
		}

		value := symbol.Value - base
		switch symbol.Name {
		case "BORINGSSL_bcm_text_start":
			if textStart != nil {
				return errors.New("duplicate start symbol found")
			}
			textStart = &value
		case "BORINGSSL_bcm_text_end":
			if textEnd != nil {
				return errors.New("duplicate end symbol found")
			}
			textEnd = &value
		case "BORINGSSL_bcm_rodata_start":
			if rodataStart != nil {
				return errors.New("duplicate rodata start symbol found")
			}
			rodataStart = &value
		case "BORINGSSL_bcm_rodata_end":
			if rodataEnd != nil {
				return errors.New("duplicate rodata end symbol found")
			}
			rodataEnd = &value
		default:
			continue
		}
	}

	if textStart == nil || textEnd == nil {
		return errors.New("could not find .text module boundaries in object")
	}

	if (rodataStart == nil) != (rodataSection == nil) {
		return errors.New("rodata start marker inconsistent with rodata section presence")
	}

	if (rodataStart != nil) != (rodataEnd != nil) {
		return errors.New("rodata marker presence inconsistent")
	}

	if max := textSection.Size; *textStart > max || *textStart > *textEnd || *textEnd > max {
		return fmt.Errorf("invalid module .text boundaries: start: %x, end: %x, max: %x", *textStart, *textEnd, max)
	}

	if rodataSection != nil {
		if max := rodataSection.Size; *rodataStart > max || *rodataStart > *rodataEnd || *rodataEnd > max {
			return fmt.Errorf("invalid module .rodata boundaries: start: %x, end: %x, max: %x", *rodataStart, *rodataEnd, max)
		}
	}

	// Extract the module from the .text section and hash it.

	text := textSection.Open()
	if _, err := text.Seek(int64(*textStart), 0); err != nil {
		return errors.New("failed to seek to module start in .text: " + err.Error())
	}
	moduleText := make([]byte, *textEnd-*textStart)
	if _, err := io.ReadFull(text, moduleText); err != nil {
		return errors.New("failed to read .text: " + err.Error())
	}

	// Maybe extract the module's read-only data too
	var moduleROData []byte
	if rodataSection != nil {
		rodata := rodataSection.Open()
		if _, err := rodata.Seek(int64(*rodataStart), 0); err != nil {
			return errors.New("failed to seek to module start in .rodata: " + err.Error())
		}
		moduleROData = make([]byte, *rodataEnd-*rodataStart)
		if _, err := io.ReadFull(rodata, moduleROData); err != nil {
			return errors.New("failed to read .rodata: " + err.Error())
		}
	}

	var zeroKey [64]byte
	mac := hmac.New(sha256.New, zeroKey[:])

	if moduleROData != nil {
		var lengthBytes [8]byte
		binary.LittleEndian.PutUint64(lengthBytes[:], uint64(len(moduleText)))
		mac.Write(lengthBytes[:])
		mac.Write(moduleText)

		binary.LittleEndian.PutUint64(lengthBytes[:], uint64(len(moduleROData)))
		mac.Write(lengthBytes[:])
		mac.Write(moduleROData)
	} else {
		mac.Write(moduleText)
	}
	calculated := mac.Sum(nil)

	// Replace the default hash value in the object with the calculated
	// value and write it out.

	offset := bytes.Index(objectBytes, fipscommon.UninitHashValue[:])
	if offset < 0 {
		return errors.New("did not find uninitialised hash value in object file")
	}

	if bytes.Index(objectBytes[offset+1:], fipscommon.UninitHashValue[:]) >= 0 {
		return errors.New("found two occurrences of uninitialised hash value in object file")
	}

	if _, exists := os.LookupEnv("BORINGSSL_FIPS_SHOW_HASH"); exists {
		fmt.Printf("Module hash: %x\n", calculated)
	}
	copy(objectBytes[offset:], calculated)

	return os.WriteFile(outPath, objectBytes, perm&0777)
}

func main() {
	arInput := flag.String("in-archive", "", "Path to a .a file")
	oInput := flag.String("in-object", "", "Path to a .o file")
	outPath := flag.String("o", "", "Path to output object")

	flag.Parse()

	if err := do(*outPath, *oInput, *arInput); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}
}
