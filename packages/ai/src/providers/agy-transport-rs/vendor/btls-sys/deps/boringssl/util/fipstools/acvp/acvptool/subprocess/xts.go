// Copyright 2021 The BoringSSL Authors
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
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of ACVP XTS tests. See
// https://pages.nist.gov/ACVP/draft-celi-acvp-symmetric.html

type xtsTestVectorSet struct {
	Groups []xtsTestGroup `json:"testGroups"`
}

type xtsTestGroup struct {
	ID         uint64 `json:"tgId"`
	Type       string `json:"testType"`
	Direction  string `json:"direction"`
	KeyLen     int    `json:"keyLen"`
	PayloadLen int    `json:"payloadLen"`
	Tests      []struct {
		ID            uint64  `json:"tcId"`
		KeyHex        string  `json:"key"`
		PlaintextHex  string  `json:"pt"`
		CiphertextHex string  `json:"ct"`
		SectorNum     *uint64 `json:"sequenceNumber"`
		TweakHex      *string `json:"tweakValue"`
	} `json:"tests"`
}

type xtsTestGroupResponse struct {
	ID    uint64            `json:"tgId"`
	Tests []xtsTestResponse `json:"tests"`
}

type xtsTestResponse struct {
	ID            uint64 `json:"tcId"`
	PlaintextHex  string `json:"pt,omitempty"`
	CiphertextHex string `json:"ct,omitempty"`
}

// xts implements an ACVP algorithm by making requests to the subprocess to
// encrypt/decrypt with AES-XTS.
type xts struct{}

func (h *xts) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed xtsTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []xtsTestGroupResponse
	for _, group := range parsed.Groups {
		group := group
		response := xtsTestGroupResponse{
			ID: group.ID,
		}

		if group.Type != "AFT" {
			return nil, fmt.Errorf("unknown XTS test type %q", group.Type)
		}

		var decrypt bool
		switch group.Direction {
		case "encrypt":
			decrypt = false
		case "decrypt":
			decrypt = true
		default:
			return nil, fmt.Errorf("unknown XTS direction %q", group.Direction)
		}

		funcName := "AES-XTS/" + group.Direction

		for _, test := range group.Tests {
			test := test
			if group.KeyLen != len(test.KeyHex)*4/2 {
				return nil, fmt.Errorf("test case %d/%d contains hex message of length %d but specifies a key length of %d (remember that XTS keys are twice the length of the underlying key size)", group.ID, test.ID, len(test.KeyHex), group.KeyLen)
			}
			key, err := hex.DecodeString(test.KeyHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			var tweak [16]byte
			if test.TweakHex != nil {
				t, err := hex.DecodeString(*test.TweakHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
				}
				if len(t) != len(tweak) {
					return nil, fmt.Errorf("wrong tweak length (%d bytes) in test case %d/%d", len(t), group.ID, test.ID)
				}
				copy(tweak[:], t)
			} else if test.SectorNum != nil {
				// Sector numbers (or "sequence numbers", as NIST calls them) are turned
				// into tweak values by encoding them in little-endian form. See IEEE
				// 1619-2007, section 5.1.
				binary.LittleEndian.PutUint64(tweak[:8], *test.SectorNum)
			} else {
				return nil, fmt.Errorf("neither sector number nor explicit tweak in test case %d/%d", group.ID, test.ID)
			}

			var msg []byte
			if decrypt {
				msg, err = hex.DecodeString(test.CiphertextHex)
			} else {
				msg, err = hex.DecodeString(test.PlaintextHex)
			}

			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			m.TransactAsync(funcName, 1, [][]byte{key, msg, tweak[:]}, func(result [][]byte) error {
				testResponse := xtsTestResponse{ID: test.ID}
				if decrypt {
					testResponse.PlaintextHex = hex.EncodeToString(result[0])
				} else {
					testResponse.CiphertextHex = hex.EncodeToString(result[0])
				}

				response.Tests = append(response.Tests, testResponse)
				return nil
			})
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
