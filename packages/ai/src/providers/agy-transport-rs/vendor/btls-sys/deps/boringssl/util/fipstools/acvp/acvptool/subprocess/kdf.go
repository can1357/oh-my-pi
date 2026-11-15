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
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of ACVP KDF tests. See
// https://pages.nist.gov/ACVP/draft-celi-acvp-kdf-tls.html#name-test-vectors

type kdfTestVectorSet struct {
	Groups []kdfTestGroup `json:"testGroups"`
}

type kdfTestGroup struct {
	ID uint64 `json:"tgId"`
	// KDFMode can take the values "counter", "feedback", or
	// "double pipeline iteration".
	KDFMode         string `json:"kdfMode"`
	MACMode         string `json:"macMode"`
	CounterLocation string `json:"counterLocation"`
	OutputBits      uint32 `json:"keyOutLength"`
	CounterBits     uint32 `json:"counterLength"`
	ZeroIV          bool   `json:"zeroLengthIv"`

	Tests []struct {
		ID       uint64 `json:"tcId"`
		Key      string `json:"keyIn"`
		Deferred bool   `json:"deferred"`
	}
}

type kdfTestGroupResponse struct {
	ID    uint64            `json:"tgId"`
	Tests []kdfTestResponse `json:"tests"`
}

type kdfTestResponse struct {
	ID        uint64 `json:"tcId"`
	KeyIn     string `json:"keyIn,omitempty"`
	FixedData string `json:"fixedData"`
	KeyOut    string `json:"keyOut"`
}

type kdfPrimitive struct{}

func (k *kdfPrimitive) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed kdfTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var respGroups []kdfTestGroupResponse
	for _, group := range parsed.Groups {
		group := group
		groupResp := kdfTestGroupResponse{ID: group.ID}

		if group.OutputBits%8 != 0 {
			return nil, fmt.Errorf("%d bit key in test group %d: fractional bytes not supported", group.OutputBits, group.ID)
		}

		if group.KDFMode != "counter" && group.KDFMode != "feedback" {
			// double-pipeline mode is not useful.
			return nil, fmt.Errorf("KDF mode %q not supported", group.KDFMode)
		}

		if group.KDFMode == "feedback" && !group.ZeroIV {
			return nil, fmt.Errorf("feedback mode with non-zero IV not supported")
		}

		switch group.CounterLocation {
		case "after fixed data", "before fixed data":
			break
		default:
			return nil, fmt.Errorf("Label location %q not supported", group.CounterLocation)
		}

		counterBits := uint32le(group.CounterBits)
		outputBytes := uint32le(group.OutputBits / 8)

		for _, test := range group.Tests {
			test := test
			testResp := kdfTestResponse{ID: test.ID}

			var key []byte
			if test.Deferred {
				if len(test.Key) != 0 {
					return nil, fmt.Errorf("key provided in deferred test case %d/%d", group.ID, test.ID)
				}
			} else {
				var err error
				if key, err = hex.DecodeString(test.Key); err != nil {
					return nil, fmt.Errorf("failed to decode Key in test case %d/%d: %v", group.ID, test.ID, err)
				}
			}

			// Make the call to the crypto module.
			cmd := "KDF-counter"
			if group.KDFMode == "feedback" {
				cmd = "KDF-feedback"
			}
			m.TransactAsync(cmd, 3, [][]byte{outputBytes, []byte(group.MACMode), []byte(group.CounterLocation), key, counterBits}, func(result [][]byte) error {
				testResp.ID = test.ID
				if test.Deferred {
					testResp.KeyIn = hex.EncodeToString(result[0])
				}
				testResp.FixedData = hex.EncodeToString(result[1])
				testResp.KeyOut = hex.EncodeToString(result[2])

				if !test.Deferred && !bytes.Equal(result[0], key) {
					return fmt.Errorf("wrapper returned a different key for non-deferred KDF operation")
				}

				groupResp.Tests = append(groupResp.Tests, testResp)
				return nil
			})
		}

		m.Barrier(func() {
			respGroups = append(respGroups, groupResp)
		})
	}

	if err := m.Flush(); err != nil {
		return nil, err
	}

	return respGroups, nil
}
