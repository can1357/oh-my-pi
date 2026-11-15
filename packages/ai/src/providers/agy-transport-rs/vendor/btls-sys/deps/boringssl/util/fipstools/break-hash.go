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

// break-hash parses an ELF binary containing the FIPS module and corrupts the
// first byte of the module. This should cause the integrity check to fail.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha512"
	"debug/elf"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
)

func do(outPath, inPath string) error {
	objectBytes, err := os.ReadFile(inPath)
	if err != nil {
		return err
	}

	object, err := elf.NewFile(bytes.NewReader(objectBytes))
	if err != nil {
		return errors.New("failed to parse object: " + err.Error())
	}

	// Find the .text section.
	var textSection *elf.Section
	var textSectionIndex elf.SectionIndex
	for i, section := range object.Sections {
		if section.Name == ".text" {
			textSectionIndex = elf.SectionIndex(i)
			textSection = section
			break
		}
	}

	if textSection == nil {
		return errors.New("failed to find .text section in object")
	}

	symbols, err := object.Symbols()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\nTrying dynamic symbols\n", err)
		symbols, err = object.DynamicSymbols()
	}
	if err != nil {
		return errors.New("failed to parse symbols: " + err.Error())
	}

	// Find the start and end markers of the module.
	var startSeen, endSeen bool
	var start, end uint64

	for _, symbol := range symbols {
		if symbol.Section != textSectionIndex {
			continue
		}

		switch symbol.Name {
		case "BORINGSSL_bcm_text_start":
			if startSeen {
				return errors.New("duplicate start symbol found")
			}
			startSeen = true
			start = symbol.Value
		case "BORINGSSL_bcm_text_end":
			if endSeen {
				return errors.New("duplicate end symbol found")
			}
			endSeen = true
			end = symbol.Value
		default:
			continue
		}
	}

	if !startSeen || !endSeen {
		return errors.New("could not find module in object")
	}

	moduleText := make([]byte, end-start)
	if n, err := textSection.ReadAt(moduleText, int64(start-textSection.Addr)); err != nil {
		return fmt.Errorf("failed to read from module start (at %d of %d) in .text: %s", start, textSection.Size, err)
	} else if n != len(moduleText) {
		return fmt.Errorf("short read from .text: wanted %d, got %d", len(moduleText), n)
	}

	// In order to match up the module start with the raw ELF contents,
	// search for the first 256 bytes and assume that will be unique.
	offset := bytes.Index(objectBytes, moduleText[:256])
	if offset < 0 {
		return errors.New("did not find module prefix in object file")
	}

	if bytes.Index(objectBytes[offset+1:], moduleText[:256]) >= 0 {
		return errors.New("found two occurrences of prefix in object file")
	}

	// Corrupt the module in the ELF.
	objectBytes[offset] ^= 1

	// Calculate the before and after hash of the module.
	var zeroKey [64]byte
	mac := hmac.New(sha512.New, zeroKey[:])
	mac.Write(moduleText)
	hashWas := mac.Sum(nil)

	moduleText[0] ^= 1
	mac.Reset()
	mac.Write(moduleText)
	newHash := mac.Sum(nil)

	fmt.Printf("Found start of module at offset 0x%x (VMA 0x%x):\n", start-textSection.Addr, start)
	fmt.Println(hex.Dump(moduleText[:128]))
	fmt.Printf("\nHash of module was:          %x\n", hashWas)
	fmt.Printf("Hash of corrupted module is: %x\n", newHash)

	return os.WriteFile(outPath, objectBytes, 0755)
}

func main() {
	if len(os.Args) != 3 {
		usage()
		os.Exit(1)
	}

	if err := do(os.Args[2], os.Args[1]); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: %s <input binary> <output path>\n", os.Args[0])
}
