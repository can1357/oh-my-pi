// Copyright 2019 The BoringSSL Authors
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

package subprocess

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/bits"
)

// aesKeyShuffle is the "AES Monte Carlo Key Shuffle" from the ACVP
// specification.
func aesKeyShuffle(key, result, prevResult []byte) {
	switch len(key) {
	case 16:
		for i := range key {
			key[i] ^= result[i]
		}
	case 24:
		for i := 0; i < 8; i++ {
			key[i] ^= prevResult[i+8]
		}
		for i := range result {
			key[i+8] ^= result[i]
		}
	case 32:
		for i, b := range prevResult {
			key[i] ^= b
		}
		for i, b := range result {
			key[i+16] ^= b
		}
	default:
		panic("unhandled key length")
	}
}

// iterateAES implements the "AES Monte Carlo Test - ECB mode" from the ACVP
// specification.
func iterateAES(transact func(n int, args ...[]byte) ([][]byte, error), encrypt bool, key, input, iv []byte) (mctResults []blockCipherMCTResult) {
	for i := 0; i < 100; i++ {
		var iteration blockCipherMCTResult
		iteration.KeyHex = hex.EncodeToString(key)
		if encrypt {
			iteration.PlaintextHex = hex.EncodeToString(input)
		} else {
			iteration.CiphertextHex = hex.EncodeToString(input)
		}

		results, err := transact(2, key, input, uint32le(1000))
		if err != nil {
			panic(err)
		}
		input = results[0]
		prevResult := results[1]

		if encrypt {
			iteration.CiphertextHex = hex.EncodeToString(input)
		} else {
			iteration.PlaintextHex = hex.EncodeToString(input)
		}

		aesKeyShuffle(key, input, prevResult)
		mctResults = append(mctResults, iteration)
	}

	return mctResults
}

// iterateAESCBC implements the "AES Monte Carlo Test - CBC mode" from the ACVP
// specification.
func iterateAESCBC(transact func(n int, args ...[]byte) ([][]byte, error), encrypt bool, key, input, iv []byte) (mctResults []blockCipherMCTResult) {
	for i := 0; i < 100; i++ {
		var iteration blockCipherMCTResult
		iteration.KeyHex = hex.EncodeToString(key)
		if encrypt {
			iteration.PlaintextHex = hex.EncodeToString(input)
		} else {
			iteration.CiphertextHex = hex.EncodeToString(input)
		}

		iteration.IVHex = hex.EncodeToString(iv)

		results, err := transact(2, key, input, iv, uint32le(1000))
		if err != nil {
			panic("block operation failed")
		}

		result := results[0]
		prevResult := results[1]

		if encrypt {
			iteration.CiphertextHex = hex.EncodeToString(result)
		} else {
			iteration.PlaintextHex = hex.EncodeToString(result)
		}

		aesKeyShuffle(key, result, prevResult)

		iv = result
		input = prevResult

		mctResults = append(mctResults, iteration)
	}

	return mctResults
}

// xorKeyWithOddParityLSB XORs value into key while setting the LSB of each bit
// to establish odd parity. This embedding of a parity check in a DES key is an
// old tradition and something that NIST's tests require (despite being
// undocumented).
func xorKeyWithOddParityLSB(key, value []byte) {
	for i := range key {
		v := key[i] ^ value[i]
		// Use LSB to establish odd parity.
		v ^= byte((bits.OnesCount8(v) & 1)) ^ 1
		key[i] = v
	}
}

// desKeyShuffle implements the manipulation of the Key arrays in the "TDES
// Monte Carlo Test - ECB mode" algorithm from the ACVP specification.
func keyShuffle3DES(key, result, prevResult, prevPrevResult []byte) {
	xorKeyWithOddParityLSB(key[:8], result)
	xorKeyWithOddParityLSB(key[8:16], prevResult)
	xorKeyWithOddParityLSB(key[16:], prevPrevResult)
}

// iterate3DES implements "TDES Monte Carlo Test - ECB mode" from the ACVP
// specification.
func iterate3DES(transact func(n int, args ...[]byte) ([][]byte, error), encrypt bool, key, input, iv []byte) (mctResults []blockCipherMCTResult) {
	for i := 0; i < 400; i++ {
		var iteration blockCipherMCTResult
		keyHex := hex.EncodeToString(key)
		iteration.Key1Hex = keyHex[:16]
		iteration.Key2Hex = keyHex[16:32]
		iteration.Key3Hex = keyHex[32:]

		if encrypt {
			iteration.PlaintextHex = hex.EncodeToString(input)
		} else {
			iteration.CiphertextHex = hex.EncodeToString(input)
		}

		results, err := transact(3, key, input, uint32le(10000))
		if err != nil {
			panic("block operation failed")
		}
		result := results[0]
		prevResult := results[1]
		prevPrevResult := results[2]

		if encrypt {
			iteration.CiphertextHex = hex.EncodeToString(result)
		} else {
			iteration.PlaintextHex = hex.EncodeToString(result)
		}

		keyShuffle3DES(key, result, prevResult, prevPrevResult)
		mctResults = append(mctResults, iteration)
		input = result
	}

	return mctResults
}

// iterate3DESCBC implements "TDES Monte Carlo Test - CBC mode" from the ACVP
// specification.
func iterate3DESCBC(transact func(n int, args ...[]byte) ([][]byte, error), encrypt bool, key, input, iv []byte) (mctResults []blockCipherMCTResult) {
	for i := 0; i < 400; i++ {
		var iteration blockCipherMCTResult
		keyHex := hex.EncodeToString(key)
		iteration.Key1Hex = keyHex[:16]
		iteration.Key2Hex = keyHex[16:32]
		iteration.Key3Hex = keyHex[32:]

		if encrypt {
			iteration.PlaintextHex = hex.EncodeToString(input)
		} else {
			iteration.CiphertextHex = hex.EncodeToString(input)
		}
		iteration.IVHex = hex.EncodeToString(iv)

		results, err := transact(3, key, input, iv, uint32le(10000))
		if err != nil {
			panic("block operation failed")
		}

		result := results[0]
		prevResult := results[1]
		prevPrevResult := results[2]

		if encrypt {
			iteration.CiphertextHex = hex.EncodeToString(result)
		} else {
			iteration.PlaintextHex = hex.EncodeToString(result)
		}

		keyShuffle3DES(key, result, prevResult, prevPrevResult)

		if encrypt {
			input = prevResult
			iv = result
		} else {
			iv = prevResult
			input = result
		}

		mctResults = append(mctResults, iteration)
	}

	return mctResults
}

// blockCipher implements an ACVP algorithm by making requests to the subprocess
// to encrypt and decrypt with a block cipher.
type blockCipher struct {
	algo      string
	blockSize int
	// numResults is the number of values returned by the wrapper. The one-shot
	// tests always take the first value as the result, but the mctFunc may use
	// them all.
	numResults              int
	inputsAreBlockMultiples bool
	hasIV                   bool
	mctFunc                 func(transact func(n int, args ...[]byte) ([][]byte, error), encrypt bool, key, input, iv []byte) (result []blockCipherMCTResult)
}

type blockCipherVectorSet struct {
	Groups []blockCipherTestGroup `json:"testGroups"`
}

type blockCipherTestGroup struct {
	ID        uint64 `json:"tgId"`
	Type      string `json:"testType"`
	Direction string `json:"direction"`
	KeyBits   int    `json:"keylen"`
	Tests     []struct {
		ID            uint64  `json:"tcId"`
		InputBits     *uint64 `json:"payloadLen"`
		PlaintextHex  string  `json:"pt"`
		CiphertextHex string  `json:"ct"`
		IVHex         string  `json:"iv"`
		KeyHex        string  `json:"key"`

		// 3DES tests serialise the key differently.
		Key1Hex string `json:"key1"`
		Key2Hex string `json:"key2"`
		Key3Hex string `json:"key3"`
	} `json:"tests"`
}

type blockCipherTestGroupResponse struct {
	ID    uint64                    `json:"tgId"`
	Tests []blockCipherTestResponse `json:"tests"`
}

type blockCipherTestResponse struct {
	ID            uint64                 `json:"tcId"`
	CiphertextHex string                 `json:"ct,omitempty"`
	PlaintextHex  string                 `json:"pt,omitempty"`
	MCTResults    []blockCipherMCTResult `json:"resultsArray,omitempty"`
}

type blockCipherMCTResult struct {
	KeyHex        string `json:"key,omitempty"`
	PlaintextHex  string `json:"pt"`
	CiphertextHex string `json:"ct"`
	IVHex         string `json:"iv,omitempty"`

	// 3DES tests serialise the key differently.
	Key1Hex string `json:"key1,omitempty"`
	Key2Hex string `json:"key2,omitempty"`
	Key3Hex string `json:"key3,omitempty"`
}

func (b *blockCipher) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed blockCipherVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []blockCipherTestGroupResponse
	// See
	// http://usnistgov.github.io/ACVP/artifacts/draft-celi-acvp-block-ciph-00.html#rfc.section.5.2
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group
		response := blockCipherTestGroupResponse{
			ID: group.ID,
		}

		var encrypt bool
		switch group.Direction {
		case "encrypt":
			encrypt = true
		case "decrypt":
			encrypt = false
		default:
			return nil, fmt.Errorf("test group %d has unknown direction %q", group.ID, group.Direction)
		}

		op := b.algo + "/encrypt"
		if !encrypt {
			op = b.algo + "/decrypt"
		}

		var mct bool
		switch group.Type {
		case "AFT", "CTR":
			mct = false
		case "MCT":
			if b.mctFunc == nil {
				return nil, fmt.Errorf("test group %d has type MCT which is unsupported for %q", group.ID, op)
			}
			mct = true
		default:
			return nil, fmt.Errorf("test group %d has unknown type %q", group.ID, group.Type)
		}

		if group.KeyBits == 0 {
			// 3DES tests fail to set this parameter.
			group.KeyBits = 192
		}

		if group.KeyBits%8 != 0 {
			return nil, fmt.Errorf("test group %d contains non-byte-multiple key length %d", group.ID, group.KeyBits)
		}
		keyBytes := group.KeyBits / 8

		transact := func(n int, args ...[]byte) ([][]byte, error) {
			return m.Transact(op, n, args...)
		}

		for _, test := range group.Tests {
			test := test

			if len(test.KeyHex) == 0 && len(test.Key1Hex) > 0 {
				// 3DES encodes the key differently.
				test.KeyHex = test.Key1Hex + test.Key2Hex + test.Key3Hex
			}

			if len(test.KeyHex) != keyBytes*2 {
				return nil, fmt.Errorf("test case %d/%d contains key %q of length %d, but expected %d-bit key", group.ID, test.ID, test.KeyHex, len(test.KeyHex), group.KeyBits)
			}

			key, err := hex.DecodeString(test.KeyHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			var inputHex string
			if encrypt {
				inputHex = test.PlaintextHex
			} else {
				inputHex = test.CiphertextHex
			}

			if test.InputBits != nil {
				if *test.InputBits%8 != 0 {
					return nil, fmt.Errorf("input to test case %d/%d is not a whole number of bytes", group.ID, test.ID)
				}
				if inputBits := 4 * uint64(len(inputHex)); *test.InputBits != inputBits {
					return nil, fmt.Errorf("input to test case %d/%d is %q (%d bits), but %d bits is specified", group.ID, test.ID, inputHex, inputBits, *test.InputBits)
				}
			}

			input, err := hex.DecodeString(inputHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			if b.inputsAreBlockMultiples && len(input)%b.blockSize != 0 {
				return nil, fmt.Errorf("test case %d/%d has input of length %d, but expected multiple of %d", group.ID, test.ID, len(input), b.blockSize)
			}

			var iv []byte
			if b.hasIV {
				if iv, err = hex.DecodeString(test.IVHex); err != nil {
					return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
				}
				if len(iv) != b.blockSize {
					return nil, fmt.Errorf("test case %d/%d has IV of length %d, but expected %d", group.ID, test.ID, len(iv), b.blockSize)
				}
			}

			testResp := blockCipherTestResponse{ID: test.ID}
			if !mct {
				var args [][]byte
				if b.hasIV {
					args = [][]byte{key, input, iv, uint32le(1)}
				} else {
					args = [][]byte{key, input, uint32le(1)}
				}

				m.TransactAsync(op, b.numResults, args, func(result [][]byte) error {
					if encrypt {
						testResp.CiphertextHex = hex.EncodeToString(result[0])
					} else {
						testResp.PlaintextHex = hex.EncodeToString(result[0])
					}
					response.Tests = append(response.Tests, testResp)
					return nil
				})
			} else {
				testResp.MCTResults = b.mctFunc(transact, encrypt, key, input, iv)
				response.Tests = append(response.Tests, testResp)
			}
		}

		m.Barrier(func() {
			ret = append(ret, response)
		})
	}

	if err := m.Flush(); err != nil {
		return nil, err
	}

	return ret, nil
}
