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
	"bufio"
	"bytes"
	"encoding/asn1"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

func sanitizeName(in string) string {
	in = strings.Replace(in, "-", "_", -1)
	in = strings.Replace(in, ".", "_", -1)
	in = strings.Replace(in, " ", "_", -1)
	return in
}

type object struct {
	name string
	// shortName and longName are the short and long names, respectively. If
	// one is missing, it takes the value of the other, but the
	// corresponding SN_foo or LN_foo macro is not defined.
	shortName, longName       string
	hasShortName, hasLongName bool
	oid                       asn1.ObjectIdentifier
	encoded                   []byte
}

type objects struct {
	// byNID is the list of all objects, indexed by nid.
	byNID []object
	// nameToNID is a map from object name to nid.
	nameToNID map[string]int
}

func readNumbers(path string) (nameToNID map[string]int, numNIDs int, err error) {
	in, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer in.Close()

	nameToNID = make(map[string]int)
	nidsSeen := make(map[int]struct{})

	// Reserve NID 0 for NID_undef.
	numNIDs = 1
	nameToNID["undef"] = 0
	nidsSeen[0] = struct{}{}

	var lineNo int
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		line := scanner.Text()
		lineNo++
		withLine := func(err error) error {
			return fmt.Errorf("%s:%d: %s", path, lineNo, err)
		}

		fields := strings.Fields(line)
		if len(fields) == 0 {
			// Skip blank lines.
			continue
		}

		// Each line is a name and a nid, separated by space.
		if len(fields) != 2 {
			return nil, 0, withLine(errors.New("syntax error"))
		}
		name := fields[0]
		nid, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, 0, withLine(err)
		}
		if nid < 0 {
			return nil, 0, withLine(errors.New("invalid NID"))
		}

		// NID_undef is implicitly defined.
		if name == "undef" && nid == 0 {
			continue
		}

		// Forbid duplicates.
		if _, ok := nameToNID[name]; ok {
			return nil, 0, withLine(fmt.Errorf("duplicate name %q", name))
		}
		if _, ok := nidsSeen[nid]; ok {
			return nil, 0, withLine(fmt.Errorf("duplicate NID %d", nid))
		}

		nameToNID[name] = nid
		nidsSeen[nid] = struct{}{}

		if nid >= numNIDs {
			numNIDs = nid + 1
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, 0, fmt.Errorf("error reading %s: %s", path, err)
	}

	return nameToNID, numNIDs, nil
}

func parseOID(aliases map[string]asn1.ObjectIdentifier, in []string) (oid asn1.ObjectIdentifier, err error) {
	if len(in) == 0 {
		return
	}

	// The first entry may be a reference to a previous alias.
	if alias, ok := aliases[sanitizeName(in[0])]; ok {
		in = in[1:]
		oid = append(oid, alias...)
	}

	for _, c := range in {
		val, err := strconv.Atoi(c)
		if err != nil {
			return nil, err
		}
		if val < 0 {
			return nil, fmt.Errorf("negative component")
		}
		oid = append(oid, val)
	}
	return
}

func appendBase128(dst []byte, value int) []byte {
	// Zero is encoded with one, not zero bytes.
	if value == 0 {
		return append(dst, 0)
	}

	// Count how many bytes are needed.
	var l int
	for n := value; n != 0; n >>= 7 {
		l++
	}
	for ; l > 0; l-- {
		b := byte(value>>uint(7*(l-1))) & 0x7f
		if l > 1 {
			b |= 0x80
		}
		dst = append(dst, b)
	}
	return dst
}

func encodeOID(oid []int) []byte {
	if len(oid) < 2 {
		return nil
	}

	var der []byte
	der = appendBase128(der, 40*oid[0]+oid[1])
	for _, value := range oid[2:] {
		der = appendBase128(der, value)
	}
	return der
}

func readObjects(numPath, objectsPath string) (*objects, error) {
	nameToNID, numNIDs, err := readNumbers(numPath)
	if err != nil {
		return nil, err
	}

	in, err := os.Open(objectsPath)
	if err != nil {
		return nil, err
	}
	defer in.Close()

	// Implicitly define NID_undef.
	objs := &objects{
		byNID:     make([]object, numNIDs),
		nameToNID: make(map[string]int),
	}

	objs.byNID[0] = object{
		name:         "undef",
		shortName:    "UNDEF",
		longName:     "undefined",
		hasShortName: true,
		hasLongName:  true,
	}
	objs.nameToNID["undef"] = 0

	var module, nextName string
	var lineNo int
	longNamesSeen := make(map[string]struct{})
	shortNamesSeen := make(map[string]struct{})
	aliases := make(map[string]asn1.ObjectIdentifier)
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		line := scanner.Text()
		lineNo++
		withLine := func(err error) error {
			return fmt.Errorf("%s:%d: %s", objectsPath, lineNo, err)
		}

		// Remove comments.
		idx := strings.IndexRune(line, '#')
		if idx >= 0 {
			line = line[:idx]
		}

		// Skip empty lines.
		line = strings.TrimSpace(line)
		if len(line) == 0 {
			continue
		}

		if line[0] == '!' {
			args := strings.Fields(line)
			switch args[0] {
			case "!module":
				if len(args) != 2 {
					return nil, withLine(errors.New("too many arguments"))
				}
				module = sanitizeName(args[1]) + "_"
			case "!global":
				module = ""
			case "!Cname":
				// !Cname directives override the name for the
				// next object.
				if len(args) != 2 {
					return nil, withLine(errors.New("too many arguments"))
				}
				nextName = sanitizeName(args[1])
			case "!Alias":
				// !Alias directives define an alias for an OID
				// without emitting an object.
				if len(nextName) != 0 {
					return nil, withLine(errors.New("!Cname directives may not modify !Alias directives."))
				}
				if len(args) < 3 {
					return nil, withLine(errors.New("not enough arguments"))
				}
				aliasName := module + sanitizeName(args[1])
				oid, err := parseOID(aliases, args[2:])
				if err != nil {
					return nil, withLine(err)
				}
				if _, ok := aliases[aliasName]; ok {
					return nil, withLine(fmt.Errorf("duplicate name '%s'", aliasName))
				}
				aliases[aliasName] = oid
			default:
				return nil, withLine(fmt.Errorf("unknown directive '%s'", args[0]))
			}
			continue
		}

		fields := strings.Split(line, ":")
		if len(fields) < 2 || len(fields) > 3 {
			return nil, withLine(errors.New("invalid field count"))
		}

		obj := object{name: nextName}
		nextName = ""

		var err error
		obj.oid, err = parseOID(aliases, strings.Fields(fields[0]))
		if err != nil {
			return nil, withLine(err)
		}
		obj.encoded = encodeOID(obj.oid)

		obj.shortName = strings.TrimSpace(fields[1])
		if len(fields) == 3 {
			obj.longName = strings.TrimSpace(fields[2])
		}

		// Long and short names default to each other if missing.
		if len(obj.shortName) == 0 {
			obj.shortName = obj.longName
		} else {
			obj.hasShortName = true
		}
		if len(obj.longName) == 0 {
			obj.longName = obj.shortName
		} else {
			obj.hasLongName = true
		}
		if len(obj.shortName) == 0 || len(obj.longName) == 0 {
			return nil, withLine(errors.New("object with no name"))
		}

		// If not already specified, prefer the long name if it has no
		// spaces, otherwise the short name.
		if len(obj.name) == 0 && strings.IndexRune(obj.longName, ' ') < 0 {
			obj.name = sanitizeName(obj.longName)
		}
		if len(obj.name) == 0 {
			obj.name = sanitizeName(obj.shortName)
		}
		obj.name = module + obj.name

		// Check for duplicate names.
		if _, ok := aliases[obj.name]; ok {
			return nil, withLine(fmt.Errorf("duplicate name '%s'", obj.name))
		}
		if _, ok := shortNamesSeen[obj.shortName]; ok && len(obj.shortName) > 0 {
			return nil, withLine(fmt.Errorf("duplicate short name '%s'", obj.shortName))
		}
		if _, ok := longNamesSeen[obj.longName]; ok && len(obj.longName) > 0 {
			return nil, withLine(fmt.Errorf("duplicate long name '%s'", obj.longName))
		}

		// Allocate a NID.
		nid, ok := nameToNID[obj.name]
		if !ok {
			nid = len(objs.byNID)
			objs.byNID = append(objs.byNID, object{})
		}

		objs.byNID[nid] = obj
		objs.nameToNID[obj.name] = nid

		longNamesSeen[obj.longName] = struct{}{}
		shortNamesSeen[obj.shortName] = struct{}{}
		aliases[obj.name] = obj.oid
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	// The kNIDsIn*Order constants assume each NID fits in a uint16_t.
	if len(objs.byNID) > 0xffff {
		return nil, errors.New("too many NIDs allocated")
	}

	return objs, nil
}

func writeNumbers(path string, objs *objects) error {
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	defer out.Close()

	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 {
			continue
		}
		if _, err := fmt.Fprintf(out, "%s\t\t%d\n", obj.name, nid); err != nil {
			return err
		}
	}
	return nil
}

func clangFormat(input string) (string, error) {
	var b bytes.Buffer
	cmd := exec.Command("clang-format")
	cmd.Stdin = strings.NewReader(input)
	cmd.Stdout = &b
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return b.String(), nil
}

func writeHeader(path string, objs *objects) error {
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

// This file is generated by crypto/obj/objects.go.

#ifndef OPENSSL_HEADER_NID_H
#define OPENSSL_HEADER_NID_H

#include <openssl/base.h>  // IWYU pragma: export

#if defined(__cplusplus)
extern "C" {
#endif


// The nid library provides numbered values for ASN.1 object identifiers and
// other symbols. These values are used by other libraries to identify
// cryptographic primitives.
//
// A separate objects library, obj.h, provides functions for converting between
// nids and object identifiers. However it depends on large internal tables with
// the encodings of every nid defined. Consumers concerned with binary size
// should instead embed the encodings of the few consumed OIDs and compare
// against those.
//
// Constants are defined as follows:
//
// - NID_foo is the integer NID of foo.
// - SN_foo is the "short name" of foo, omitted if there is no short name.
// - LN_foo is the "long name" of foo, omitted if there is no long name.
// - OBJ_foo expands to a comma-separated sequence of integers for foo's OID,
//   omitted if foo has no OID.
// - OBJ_ENC_foo expands to a comma-separated sequence of bytes for foo's OID
//   encoded in DER, excluding the tag and length. This is omitted if foo has
//   no OID.
//
// NID values should not be used outside of a single process; they are not
// stable identifiers.


`)

	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 {
			continue
		}

		if obj.hasShortName {
			fmt.Fprintf(&b, "#define SN_%s \"%s\"\n", obj.name, obj.shortName)
		}
		if obj.hasLongName {
			fmt.Fprintf(&b, "#define LN_%s \"%s\"\n", obj.name, obj.longName)
		}
		fmt.Fprintf(&b, "#define NID_%s %d\n", obj.name, nid)

		// Although NID_undef does not have an OID, OpenSSL emits
		// OBJ_undef as if it were zero.
		oid := obj.oid
		if nid == 0 {
			oid = asn1.ObjectIdentifier{0}
		}
		if len(oid) != 0 {
			var oidStr strings.Builder
			for _, val := range oid {
				if oidStr.Len() != 0 {
					oidStr.WriteString(", ")
				}
				fmt.Fprintf(&oidStr, "%dL", val)
			}
			fmt.Fprintf(&b, "#define OBJ_%s %s\n", obj.name, oidStr.String())
		}
		// Some NIDs refer to the top-level OID arcs, which cannot be encoded
		// as OIDs. (The encoding can only represent two or more components.)
		if len(oid) > 1 {
			var oidEncStr strings.Builder
			for _, val := range encodeOID(oid) {
				if oidEncStr.Len() != 0 {
					oidEncStr.WriteString(", ")
				}
				fmt.Fprintf(&oidEncStr, "0x%02x", val)
			}
			fmt.Fprintf(&b, "#define OBJ_ENC_%s %s\n", obj.name, oidEncStr.String())
		}

		fmt.Fprintf(&b, "\n")
	}

	fmt.Fprintf(&b, `
#if defined(__cplusplus)
}  /* extern C */
#endif

#endif  /* OPENSSL_HEADER_NID_H */
`)

	formatted, err := clangFormat(b.String())
	if err != nil {
		return err
	}

	return os.WriteFile(path, []byte(formatted), 0666)
}

func sortNIDs(nids []int, objs *objects, cmp func(a, b object) bool) {
	sort.Slice(nids, func(i, j int) bool { return cmp(objs.byNID[nids[i]], objs.byNID[nids[j]]) })
}

func writeData(path string, objs *objects) error {
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

// This file is generated by crypto/obj/objects.go.


`)

	fmt.Fprintf(&b, "#define NUM_NID %d\n", len(objs.byNID))

	// Emit each object's DER encoding, concatenated, and save the offsets.
	fmt.Fprintf(&b, "\nstatic const uint8_t kObjectData[] = {\n")
	offsets := make([]int, len(objs.byNID))
	var nextOffset int
	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 || len(obj.encoded) == 0 {
			offsets[nid] = -1
			continue
		}

		offsets[nid] = nextOffset
		nextOffset += len(obj.encoded)
		fmt.Fprintf(&b, "/* NID_%s */\n", obj.name)
		for _, val := range obj.encoded {
			fmt.Fprintf(&b, "0x%02x, ", val)
		}
		fmt.Fprintf(&b, "\n")
	}
	fmt.Fprintf(&b, "};\n")

	// Emit an ASN1_OBJECT for each object.
	fmt.Fprintf(&b, "\nstatic const ASN1_OBJECT kObjects[NUM_NID] = {\n")
	for nid, obj := range objs.byNID {
		// Skip the entry for NID_undef. It is stored separately, so that
		// OBJ_get_undef avoids pulling in the table.
		if nid == 0 {
			continue
		}

		if len(obj.name) == 0 {
			fmt.Fprintf(&b, "{NULL, NULL, NID_undef, 0, NULL, 0},\n")
			continue
		}

		fmt.Fprintf(&b, "{\"%s\", \"%s\", NID_%s, ", obj.shortName, obj.longName, obj.name)
		if offset := offsets[nid]; offset >= 0 {
			fmt.Fprintf(&b, "%d, &kObjectData[%d], 0},\n", len(obj.encoded), offset)
		} else {
			fmt.Fprintf(&b, "0, NULL, 0},\n")
		}
	}
	fmt.Fprintf(&b, "};\n")

	// Emit a list of NIDs sorted by short name.
	var nids []int
	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 || len(obj.shortName) == 0 {
			continue
		}
		nids = append(nids, nid)
	}
	sortNIDs(nids, objs, func(a, b object) bool { return a.shortName < b.shortName })

	fmt.Fprintf(&b, "\nstatic const uint16_t kNIDsInShortNameOrder[] = {\n")
	for _, nid := range nids {
		// Including NID_undef in the table does not do anything. Whether OBJ_sn2nid
		// finds the object or not, it will return NID_undef.
		if nid != 0 {
			fmt.Fprintf(&b, "%d /* %s */,\n", nid, objs.byNID[nid].shortName)
		}
	}
	fmt.Fprintf(&b, "};\n")

	// Emit a list of NIDs sorted by long name.
	nids = nil
	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 || len(obj.longName) == 0 {
			continue
		}
		nids = append(nids, nid)
	}
	sortNIDs(nids, objs, func(a, b object) bool { return a.longName < b.longName })

	fmt.Fprintf(&b, "\nstatic const uint16_t kNIDsInLongNameOrder[] = {\n")
	for _, nid := range nids {
		// Including NID_undef in the table does not do anything. Whether OBJ_ln2nid
		// finds the object or not, it will return NID_undef.
		if nid != 0 {
			fmt.Fprintf(&b, "%d /* %s */,\n", nid, objs.byNID[nid].longName)
		}
	}
	fmt.Fprintf(&b, "};\n")

	// Emit a list of NIDs sorted by OID.
	nids = nil
	for nid, obj := range objs.byNID {
		if len(obj.name) == 0 || len(obj.encoded) == 0 {
			continue
		}
		nids = append(nids, nid)
	}
	sortNIDs(nids, objs, func(a, b object) bool {
		// This comparison must match the definition of |obj_cmp|.
		if len(a.encoded) < len(b.encoded) {
			return true
		}
		if len(a.encoded) > len(b.encoded) {
			return false
		}
		return bytes.Compare(a.encoded, b.encoded) < 0
	})

	fmt.Fprintf(&b, "\nstatic const uint16_t kNIDsInOIDOrder[] = {\n")
	for _, nid := range nids {
		obj := objs.byNID[nid]
		fmt.Fprintf(&b, "%d /* ", nid)
		for i, c := range obj.oid {
			if i > 0 {
				fmt.Fprintf(&b, ".")
			}
			fmt.Fprintf(&b, "%d", c)
		}
		fmt.Fprintf(&b, " (OBJ_%s) */,\n", obj.name)
	}
	fmt.Fprintf(&b, "};\n")

	formatted, err := clangFormat(b.String())
	if err != nil {
		return err
	}

	return os.WriteFile(path, []byte(formatted), 0666)
}

func main() {
	objs, err := readObjects("obj_mac.num", "objects.txt")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading objects: %s\n", err)
		os.Exit(1)
	}

	if err := writeNumbers("obj_mac.num", objs); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing numbers: %s\n", err)
		os.Exit(1)
	}

	if err := writeHeader("../../include/openssl/nid.h", objs); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing header: %s\n", err)
		os.Exit(1)
	}

	if err := writeData("obj_dat.h", objs); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing data: %s\n", err)
		os.Exit(1)
	}
}
