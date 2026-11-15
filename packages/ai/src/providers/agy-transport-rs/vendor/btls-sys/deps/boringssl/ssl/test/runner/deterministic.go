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

package runner

import (
	"encoding/binary"

	"golang.org/x/crypto/chacha20"
)

// Use a different key from crypto/rand/deterministic.c.
var deterministicRandKey = []byte("runner deterministic key 0123456")

type deterministicRand struct {
	numCalls uint64
}

func (d *deterministicRand) Read(buf []byte) (int, error) {
	clear(buf)
	var nonce [12]byte
	binary.LittleEndian.PutUint64(nonce[:8], d.numCalls)
	cipher, err := chacha20.NewUnauthenticatedCipher(deterministicRandKey, nonce[:])
	if err != nil {
		return 0, err
	}
	cipher.XORKeyStream(buf, buf)
	d.numCalls++
	return len(buf), nil
}
