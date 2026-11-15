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

// The following structures reflect the JSON of CMAC-AES tests. See
// https://pages.nist.gov/ACVP/draft-fussell-acvp-mac.html#name-test-vectors

type keyedMACTestVectorSet struct {
	Groups []keyedMACTestGroup `json:"testGroups"`
}

type keyedMACTestGroup struct {
	ID        uint64 `json:"tgId"`
	Type      string `json:"testType"`
	Direction string `json:"direction"`
	MsgBits   uint32 `json:"msgLen"`
	KeyBits   uint32 `json:"keyLen"`
	MACBits   uint32 `json:"macLen"`
	Tests     []struct {
		ID     uint64 `json:"tcId"`
		KeyHex string `json:"key"`
		MsgHex string `json:"message"`
		MACHex string `json:"mac"`
	}
}

type keyedMACTestGroupResponse struct {
	ID    uint64                 `json:"tgId"`
	Tests []keyedMACTestResponse `json:"tests"`
}

type keyedMACTestResponse struct {
	ID     uint64 `json:"tcId"`
	MACHex string `json:"mac,omitempty"`
	Passed *bool  `json:"testPassed,omitempty"`
}

type keyedMACPrimitive struct {
	algo string
}

func (k *keyedMACPrimitive) Process(vectorSet []byte, m Transactable) (any, error) {
	var vs keyedMACTestVectorSet
	if err := json.Unmarshal(vectorSet, &vs); err != nil {
		return nil, err
	}

	var respGroups []keyedMACTestGroupResponse
	for _, group := range vs.Groups {
		group := group
		respGroup := keyedMACTestGroupResponse{ID: group.ID}

		if group.KeyBits%8 != 0 {
			return nil, fmt.Errorf("%d bit key in test group %d: fractional bytes not supported", group.KeyBits, group.ID)
		}
		if group.MsgBits%8 != 0 {
			return nil, fmt.Errorf("%d bit message in test group %d: fractional bytes not supported", group.KeyBits, group.ID)
		}
		if group.MACBits%8 != 0 {
			return nil, fmt.Errorf("%d bit MAC in test group %d: fractional bytes not supported", group.KeyBits, group.ID)
		}

		var generate bool
		switch group.Direction {
		case "gen":
			generate = true
		case "ver":
			generate = false
		default:
			return nil, fmt.Errorf("unknown test direction %q in test group %d", group.Direction, group.ID)
		}

		outputBytes := uint32le(group.MACBits / 8)

		for _, test := range group.Tests {
			test := test
			respTest := keyedMACTestResponse{ID: test.ID}

			// Validate input.
			if keyBits := uint32(len(test.KeyHex)) * 4; keyBits != group.KeyBits {
				return nil, fmt.Errorf("test case %d/%d contains key of length %d bits, but expected %d-bit value", group.ID, test.ID, keyBits, group.KeyBits)
			}
			if msgBits := uint32(len(test.MsgHex)) * 4; msgBits != group.MsgBits {
				return nil, fmt.Errorf("test case %d/%d contains message of length %d bits, but expected %d-bit value", group.ID, test.ID, msgBits, group.MsgBits)
			}

			if generate {
				if len(test.MACHex) != 0 {
					return nil, fmt.Errorf("test case %d/%d contains MAC but should not", group.ID, test.ID)
				}
			} else {
				if macBits := uint32(len(test.MACHex)) * 4; macBits != group.MACBits {
					return nil, fmt.Errorf("test case %d/%d contains MAC of length %d bits, but expected %d-bit value", group.ID, test.ID, macBits, group.MACBits)
				}
			}

			// Set up Transact parameters.
			key, err := hex.DecodeString(test.KeyHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode KeyHex in test case %d/%d: %v", group.ID, test.ID, err)
			}

			msg, err := hex.DecodeString(test.MsgHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode MsgHex in test case %d/%d: %v", group.ID, test.ID, err)
			}

			if generate {
				expectedNumBytes := int(group.MACBits / 8)

				m.TransactAsync(k.algo, 1, [][]byte{outputBytes, key, msg}, func(result [][]byte) error {
					calculatedMAC := result[0]
					if len(calculatedMAC) != expectedNumBytes {
						return fmt.Errorf("%s operation returned incorrect length value", k.algo)
					}

					respTest.MACHex = hex.EncodeToString(calculatedMAC)
					return nil
				})
			} else {
				expectedMAC, err := hex.DecodeString(test.MACHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode MACHex in test case %d/%d: %v", group.ID, test.ID, err)
				}
				if 8*len(expectedMAC) != int(group.MACBits) {
					return nil, fmt.Errorf("MACHex in test case %d/%d is %x, but should be %d bits", group.ID, test.ID, expectedMAC, group.MACBits)
				}

				m.TransactAsync(k.algo+"/verify", 1, [][]byte{key, msg, expectedMAC}, func(result [][]byte) error {
					if len(result[0]) != 1 || (result[0][0]&0xfe) != 0 {
						return fmt.Errorf("wrapper %s returned invalid success flag: %x", k.algo, result[0])
					}

					ok := result[0][0] == 1
					respTest.Passed = &ok
					return nil
				})
			}

			m.Barrier(func() {
				respGroup.Tests = append(respGroup.Tests, respTest)
			})
		}

		m.Barrier(func() {
			respGroups = append(respGroups, respGroup)
		})
	}

	if err := m.Flush(); err != nil {
		return nil, err
	}

	return respGroups, nil
}
