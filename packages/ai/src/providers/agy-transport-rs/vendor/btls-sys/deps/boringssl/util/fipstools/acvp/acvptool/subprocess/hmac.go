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
	"strconv"
)

// The following structures reflect the JSON of ACVP HMAC tests. See
// https://pages.nist.gov/ACVP/draft-fussell-acvp-mac.html#name-test-vectors

type hmacTestVectorSet struct {
	Groups []hmacTestGroup `json:"testGroups"`
}

type hmacTestGroup struct {
	ID      uint64 `json:"tgId"`
	Type    string `json:"testType"`
	MsgBits int    `json:"msgLen"`
	KeyBits int    `json:"keyLen"` // maximum possible value is 524288
	MACBits int    `json:"macLen"` // maximum possible value is 512
	Tests   []struct {
		ID     uint64 `json:"tcId"`
		KeyHex string `json:"key"`
		MsgHex string `json:"msg"`
	} `json:"tests"`
}

type hmacTestGroupResponse struct {
	ID    uint64             `json:"tgId"`
	Tests []hmacTestResponse `json:"tests"`
}

type hmacTestResponse struct {
	ID     uint64 `json:"tcId"`
	MACHex string `json:"mac,omitempty"`
}

// hmacPrimitive implements an ACVP algorithm by making requests to the
// subprocess to HMAC strings with the given key.
type hmacPrimitive struct {
	// algo is the ACVP name for this algorithm and also the command name
	// given to the subprocess to HMAC with this hash function.
	algo  string
	mdLen int // mdLen is the number of bytes of output that the underlying hash produces.
}

// hmac uses the subprocess to compute HMAC and returns the result.
func (h *hmacPrimitive) hmac(msg []byte, key []byte, outBits int, m Transactable) []byte {
	if outBits%8 != 0 {
		panic("fractional-byte output length requested: " + strconv.Itoa(outBits))
	}
	outBytes := outBits / 8
	result, err := m.Transact(h.algo, 1, msg, key)
	if err != nil {
		panic("HMAC operation failed: " + err.Error())
	}
	if l := len(result[0]); l < outBytes {
		panic(fmt.Sprintf("HMAC result too short: %d bytes but wanted %d", l, outBytes))
	}
	return result[0][:outBytes]
}

func (h *hmacPrimitive) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed hmacTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []hmacTestGroupResponse
	// See
	// https://pages.nist.gov/ACVP/draft-fussell-acvp-mac.html#name-test-vectors
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group
		response := hmacTestGroupResponse{
			ID: group.ID,
		}
		if group.MACBits > h.mdLen*8 {
			return nil, fmt.Errorf("test group %d specifies MAC length should be %d, but maximum possible length is %d", group.ID, group.MACBits, h.mdLen*8)
		}
		if group.MACBits%8 != 0 {
			return nil, fmt.Errorf("fractional-byte HMAC output length requested: %d", group.MACBits)
		}
		outBytes := group.MACBits / 8

		for _, test := range group.Tests {
			test := test

			if len(test.MsgHex)*4 != group.MsgBits {
				return nil, fmt.Errorf("test case %d/%d contains hex message of length %d but specifies a bit length of %d", group.ID, test.ID, len(test.MsgHex), group.MsgBits)
			}
			msg, err := hex.DecodeString(test.MsgHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			if len(test.KeyHex)*4 != group.KeyBits {
				return nil, fmt.Errorf("test case %d/%d contains hex key of length %d but specifies a bit length of %d", group.ID, test.ID, len(test.KeyHex), group.KeyBits)
			}
			key, err := hex.DecodeString(test.KeyHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode key in test case %d/%d: %s", group.ID, test.ID, err)
			}

			m.TransactAsync(h.algo, 1, [][]byte{msg, key}, func(result [][]byte) error {
				if l := len(result[0]); l != outBytes {
					return fmt.Errorf("incorrect HMAC length: %d bytes but wanted %d", l, outBytes)
				}

				// https://pages.nist.gov/ACVP/draft-fussell-acvp-mac.html#name-test-vectors
				response.Tests = append(response.Tests, hmacTestResponse{
					ID:     test.ID,
					MACHex: hex.EncodeToString(result[0]),
				})
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
