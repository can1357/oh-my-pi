// Copyright 2015 The BoringSSL Authors
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

package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
)

// libraryNames must be kept in sync with the enum in err.h. The generated code
// will contain static assertions to enforce this.
var libraryNames = []string{
	"NONE",
	"SYS",
	"BN",
	"RSA",
	"DH",
	"EVP",
	"BUF",
	"OBJ",
	"PEM",
	"DSA",
	"X509",
	"ASN1",
	"CONF",
	"CRYPTO",
	"EC",
	"SSL",
	"BIO",
	"PKCS7",
	"PKCS8",
	"X509V3",
	"RAND",
	"ENGINE",
	"OCSP",
	"UI",
	"COMP",
	"ECDSA",
	"ECDH",
	"HMAC",
	"DIGEST",
	"CIPHER",
	"HKDF",
	"TRUST_TOKEN",
	"CMS",
	"USER",
}

// stringList is a map from uint32 -> string which can output data for a sorted
// list as C literals.
type stringList struct {
	// entries is an array of keys and offsets into |stringData|. The
	// offsets are in the bottom 15 bits of each uint32 and the key is the
	// top 17 bits.
	entries []uint32
	// internedStrings contains the same strings as are in |stringData|,
	// but allows for easy deduplication. It maps a string to its offset in
	// |stringData|.
	internedStrings map[string]uint32
	stringData      []byte
}

func newStringList() *stringList {
	return &stringList{
		internedStrings: make(map[string]uint32),
	}
}

// offsetMask is the bottom 15 bits. It's a mask that selects the offset from a
// uint32 in entries.
const offsetMask = 0x7fff

func (st *stringList) Add(key uint32, value string) error {
	if key&offsetMask != 0 {
		return errors.New("need bottom 15 bits of the key for the offset")
	}
	offset, ok := st.internedStrings[value]
	if !ok {
		offset = uint32(len(st.stringData))
		if offset&offsetMask != offset {
			return errors.New("stringList overflow")
		}
		st.stringData = append(st.stringData, []byte(value)...)
		st.stringData = append(st.stringData, 0)
		st.internedStrings[value] = offset
	}

	for _, existing := range st.entries {
		if existing>>15 == key>>15 {
			panic("duplicate entry")
		}
	}
	st.entries = append(st.entries, key|offset)
	return nil
}

func (st *stringList) buildList() []uint32 {
	sort.Slice(st.entries, func(i, j int) bool { return (st.entries[i] >> 15) < (st.entries[j] >> 15) })
	return st.entries
}

type stringWriter interface {
	io.Writer
	WriteString(string) (int, error)
}

func (st *stringList) WriteTo(out stringWriter, name string) {
	list := st.buildList()
	values := "kOpenSSL" + name + "Values"
	out.WriteString("extern const uint32_t " + values + "[];\n")
	out.WriteString("const uint32_t " + values + "[] = {\n")
	for _, v := range list {
		fmt.Fprintf(out, "    0x%x,\n", v)
	}
	out.WriteString("};\n\n")
	out.WriteString("extern const size_t " + values + "Len;\n")
	out.WriteString("const size_t " + values + "Len = sizeof(" + values + ") / sizeof(" + values + "[0]);\n\n")

	stringData := "kOpenSSL" + name + "StringData"
	out.WriteString("extern const char " + stringData + "[];\n")
	out.WriteString("const char " + stringData + "[] =\n    \"")
	for i, c := range st.stringData {
		if c == 0 {
			out.WriteString("\\0\"\n    \"")
			continue
		}
		out.Write(st.stringData[i : i+1])
	}
	out.WriteString("\";\n\n")
}

type errorData struct {
	reasons    *stringList
	libraryMap map[string]uint32
}

func (e *errorData) readErrorDataFile(filename string) error {
	inFile, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer inFile.Close()

	scanner := bufio.NewScanner(inFile)
	comma := []byte(",")

	lineNo := 0
	for scanner.Scan() {
		lineNo++

		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		parts := bytes.Split(line, comma)
		if len(parts) != 3 {
			return fmt.Errorf("bad line %d in %s: found %d values but want 3", lineNo, filename, len(parts))
		}
		libNum, ok := e.libraryMap[string(parts[0])]
		if !ok {
			return fmt.Errorf("bad line %d in %s: unknown library", lineNo, filename)
		}
		if libNum >= 64 {
			return fmt.Errorf("bad line %d in %s: library value too large", lineNo, filename)
		}
		key, err := strconv.ParseUint(string(parts[1]), 10 /* base */, 32 /* bit size */)
		if err != nil {
			return fmt.Errorf("bad line %d in %s: %s", lineNo, filename, err)
		}
		if key >= 2048 {
			return fmt.Errorf("bad line %d in %s: key too large", lineNo, filename)
		}
		value := string(parts[2])

		listKey := libNum<<26 | uint32(key)<<15

		err = e.reasons.Add(listKey, value)
		if err != nil {
			return err
		}
	}

	return scanner.Err()
}

type ErrDataTask struct {
	TargetName string
	Inputs     []string
}

func (t *ErrDataTask) Destination() string {
	return path.Join("gen", t.TargetName, "err_data.cc")
}

func (t *ErrDataTask) Run() ([]byte, error) {
	e := &errorData{
		reasons:    newStringList(),
		libraryMap: make(map[string]uint32),
	}
	for i, name := range libraryNames {
		e.libraryMap[name] = uint32(i) + 1
	}

	for _, input := range t.Inputs {
		if err := e.readErrorDataFile(input); err != nil {
			return nil, err
		}
	}

	var out bytes.Buffer
	out.WriteString(`// Copyright 2015 The BoringSSL Authors
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

// This file was generated by go run ./util/pregenerate.

#include <openssl/base.h>
#include <openssl/err.h>

#include <assert.h>

`)

	for i, name := range libraryNames {
		fmt.Fprintf(&out, "static_assert(ERR_LIB_%s == %d, \"library value changed\");\n", name, i+1)
	}
	fmt.Fprintf(&out, "static_assert(ERR_NUM_LIBS == %d, \"number of libraries changed\");\n", len(libraryNames)+1)
	out.WriteString("\n")

	e.reasons.WriteTo(&out, "Reason")
	return out.Bytes(), nil
}
