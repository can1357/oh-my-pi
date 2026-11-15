// Copyright 2020 The BoringSSL Authors
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
)

// aead implements an ACVP algorithm by making requests to the subprocess
// to encrypt and decrypt with an AEAD.
type aead struct {
	algo                    string
	tagMergedWithCiphertext bool
}

type aeadVectorSet struct {
	Groups []aeadTestGroup `json:"testGroups"`
}

type aeadTestGroup struct {
	ID          uint64 `json:"tgId"`
	Type        string `json:"testType"`
	Direction   string `json:"direction"`
	KeyBits     int    `json:"keyLen"`
	TagBits     int    `json:"tagLen"`
	NonceSource string `json:"ivGen"`
	Tests       []struct {
		ID            uint64 `json:"tcId"`
		PlaintextHex  string `json:"pt"`
		CiphertextHex string `json:"ct"`
		IVHex         string `json:"iv"`
		KeyHex        string `json:"key"`
		AADHex        string `json:"aad"`
		TagHex        string `json:"tag"`
	} `json:"tests"`
}

type aeadTestGroupResponse struct {
	ID    uint64             `json:"tgId"`
	Tests []aeadTestResponse `json:"tests"`
}

type aeadTestResponse struct {
	ID            uint64  `json:"tcId"`
	CiphertextHex *string `json:"ct,omitempty"`
	TagHex        string  `json:"tag,omitempty"`
	NonceHex      string  `json:"iv,omitempty"`
	PlaintextHex  *string `json:"pt,omitempty"`
	Passed        *bool   `json:"testPassed,omitempty"`
}

func (a *aead) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed aeadVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []aeadTestGroupResponse
	// See draft-celi-acvp-symmetric.html#table-6. (NIST no longer publish HTML
	// versions of the ACVP documents. You can find fragments in
	// https://github.com/usnistgov/ACVP.)
	for _, group := range parsed.Groups {
		group := group
		response := aeadTestGroupResponse{
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

		var randnonce bool
		switch group.NonceSource {
		case "internal":
			randnonce = true
		case "external", "":
			randnonce = false
		default:
			return nil, fmt.Errorf("test group %d has unknown nonce source %q", group.ID, group.NonceSource)
		}

		op := a.algo
		if randnonce {
			op += "-randnonce"
		}
		if encrypt {
			op += "/seal"
		} else {
			op += "/open"
		}

		if group.KeyBits%8 != 0 || group.KeyBits < 0 {
			return nil, fmt.Errorf("test group %d contains non-byte-multiple key length %d", group.ID, group.KeyBits)
		}
		keyBytes := group.KeyBits / 8

		if group.TagBits%8 != 0 || group.TagBits < 0 {
			return nil, fmt.Errorf("test group %d contains non-byte-multiple tag length %d", group.ID, group.TagBits)
		}
		tagBytes := group.TagBits / 8

		for _, test := range group.Tests {
			test := test

			if len(test.KeyHex) != keyBytes*2 {
				return nil, fmt.Errorf("test case %d/%d contains key %q of length %d, but expected %d-bit key", group.ID, test.ID, test.KeyHex, len(test.KeyHex), group.KeyBits)
			}

			key, err := hex.DecodeString(test.KeyHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode key in test case %d/%d: %s", group.ID, test.ID, err)
			}

			nonce, err := hex.DecodeString(test.IVHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode nonce in test case %d/%d: %s", group.ID, test.ID, err)
			}

			aad, err := hex.DecodeString(test.AADHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode aad in test case %d/%d: %s", group.ID, test.ID, err)
			}

			var inputHex, otherHex string
			if encrypt {
				inputHex, otherHex = test.PlaintextHex, test.CiphertextHex
			} else {
				inputHex, otherHex = test.CiphertextHex, test.PlaintextHex
			}

			if len(otherHex) != 0 {
				return nil, fmt.Errorf("test case %d/%d has unexpected plain/ciphertext input", group.ID, test.ID)
			}

			input, err := hex.DecodeString(inputHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			var tag []byte
			if a.tagMergedWithCiphertext {
				if len(test.TagHex) != 0 {
					return nil, fmt.Errorf("test case %d/%d has unexpected tag input (should be merged into ciphertext)", group.ID, test.ID)
				}
				if !encrypt && len(input) < tagBytes {
					return nil, fmt.Errorf("test case %d/%d has ciphertext shorter than the tag, but the tag should be included in it", group.ID, test.ID)
				}
			} else {
				if !encrypt {
					if tag, err = hex.DecodeString(test.TagHex); err != nil {
						return nil, fmt.Errorf("failed to decode tag in test case %d/%d: %s", group.ID, test.ID, err)
					}
					if len(tag) != tagBytes {
						return nil, fmt.Errorf("tag in test case %d/%d is %d bytes long, but should be %d", group.ID, test.ID, len(tag), tagBytes)
					}
				} else if len(test.TagHex) != 0 {
					return nil, fmt.Errorf("test case %d/%d has unexpected tag input", group.ID, test.ID)
				}
			}

			testResp := aeadTestResponse{ID: test.ID}

			if encrypt {
				m.TransactAsync(op, 1, [][]byte{uint32le(uint32(tagBytes)), key, input, nonce, aad}, func(result [][]byte) error {
					if len(result[0]) < tagBytes {
						return fmt.Errorf("ciphertext from subprocess for test case %d/%d is shorter than the tag (%d vs %d)", group.ID, test.ID, len(result[0]), tagBytes)
					}

					if a.tagMergedWithCiphertext {
						ciphertextHex := hex.EncodeToString(result[0])
						testResp.CiphertextHex = &ciphertextHex
					} else {
						ciphertext := result[0]
						if randnonce {
							var nonce []byte
							ciphertext, nonce = splitOffRight(ciphertext, 12)
							testResp.NonceHex = hex.EncodeToString(nonce)
						}
						ciphertext, tag := splitOffRight(ciphertext, tagBytes)
						ciphertextHex := hex.EncodeToString(ciphertext)
						testResp.CiphertextHex = &ciphertextHex
						testResp.TagHex = hex.EncodeToString(tag)
					}
					response.Tests = append(response.Tests, testResp)
					return nil
				})
			} else {
				ciphertext := append(input, tag...)
				if randnonce {
					ciphertext = append(ciphertext, nonce...)
					nonce = []byte{}
				}
				m.TransactAsync(op, 2, [][]byte{uint32le(uint32(tagBytes)), key, ciphertext, nonce, aad}, func(result [][]byte) error {
					if len(result[0]) != 1 || (result[0][0]&0xfe) != 0 {
						return fmt.Errorf("invalid AEAD status result from subprocess")
					}
					passed := result[0][0] == 1
					testResp.Passed = &passed
					if passed {
						plaintextHex := hex.EncodeToString(result[1])
						testResp.PlaintextHex = &plaintextHex
					}
					response.Tests = append(response.Tests, testResp)
					return nil
				})
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

func splitOffRight(in []byte, suffixSize int) ([]byte, []byte) {
	if len(in) < suffixSize {
		panic("input too small to split")
	}
	split := len(in) - suffixSize
	return in[:split], in[split:]
}
