// Copyright 2023 The BoringSSL Authors
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

package kyber

import (
	"bufio"
	"bytes"
	"crypto/sha3"
	"encoding/hex"
	"flag"
	"os"
	"strings"
	"testing"
)

var testVectorsPath = flag.String("test-vectors", "../../../../crypto/kyber/kyber_tests.txt", "The path to the test vectors to use")

func TestVectors(t *testing.T) {
	in, err := os.Open(*testVectorsPath)
	if err != nil {
		t.Error(err)
		return
	}
	defer in.Close()

	scanner := bufio.NewScanner(in)
	var priv *PrivateKey
	var encodedPublicKey *[PublicKeySize]byte
	var ciphertext *[CiphertextSize]byte
	sharedSecret := make([]byte, 32)

	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := scanner.Text()

		parts := strings.Split(line, "=")
		if len(parts) != 2 || strings.HasPrefix(line, "count ") {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value, err := hex.DecodeString(strings.TrimSpace(parts[1]))
		if err != nil {
			t.Errorf("bad hex value on line %d: %q", lineNo, parts[1])
			return
		}

		switch key {
		case "generateEntropy":
			priv, encodedPublicKey = NewPrivateKey((*[64]byte)(value))
		case "encapEntropyPreHash":
			hashedEntropy := sha3.Sum256(value)
			ciphertext = priv.Encap(sharedSecret, &hashedEntropy)
			decapSharedSecret := make([]byte, len(sharedSecret))
			priv.Decap(decapSharedSecret, ciphertext)
			if !bytes.Equal(sharedSecret, decapSharedSecret) {
				t.Errorf("instance on line %d did not round trip", lineNo)
				return
			}
		case "pk":
			if !bytes.Equal(encodedPublicKey[:], value) {
				t.Errorf("bad 'pk' value on line %d:\nwant: %x\ncalc: %x", lineNo, value, encodedPublicKey)
				return
			}
		case "sk":
			encodedPrivateKey := priv.Marshal()
			if !bytes.Equal(encodedPrivateKey[:], value) {
				t.Errorf("bad 'sk' value on line %d:\nwant: %x\ncalc: %x", lineNo, value, encodedPrivateKey)
				return
			}
		case "ct":
			if !bytes.Equal(ciphertext[:], value) {
				t.Errorf("bad 'ct' value on line %d:\nwant: %x\ncalc: %x", lineNo, value, ciphertext[:])
				return
			}
		case "ss":
			if !bytes.Equal(sharedSecret[:], value) {
				t.Errorf("bad 'ss' value on line %d:\nwant: %x\ncalc: %x", lineNo, value, sharedSecret[:])
				return
			}
		}
	}
}

func TestIteration(t *testing.T) {
	h := sha3.NewSHAKE256()

	for i := 0; i < 4096; i++ {
		var generateEntropy [64]byte
		h.Read(generateEntropy[:])
		var encapEntropy [32]byte
		h.Read(encapEntropy[:])

		priv, encodedPublicKey := NewPrivateKey(&generateEntropy)
		h.Reset()
		h.Write(encodedPublicKey[:])
		encodedPrivateKey := priv.Marshal()
		h.Write(encodedPrivateKey[:])

		var sharedSecret [32]byte
		ciphertext := priv.Encap(sharedSecret[:], &encapEntropy)
		h.Write(ciphertext[:])
		h.Write(sharedSecret[:])

		var decapSharedSecret [32]byte
		priv.Decap(decapSharedSecret[:], ciphertext)
		if !bytes.Equal(decapSharedSecret[:], sharedSecret[:]) {
			t.Errorf("Decap failed on iteration %d", i)
			return
		}
	}

	var result [16]byte
	h.Read(result[:])
	const expected = "18c6cd04eaebb33b20bb1e8e2762d30d"
	if hex.EncodeToString(result[:]) != expected {
		t.Errorf("iteration test produced %x, but should be %v", result, expected)
	}
}
