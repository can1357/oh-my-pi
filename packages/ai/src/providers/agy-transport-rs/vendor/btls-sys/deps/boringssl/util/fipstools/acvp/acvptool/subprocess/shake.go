// Copyright 2024 The BoringSSL Authors
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

// The following structures reflect the JSON of ACVP shake tests. See
// https://pages.nist.gov/ACVP/draft-celi-acvp-sha3.html#name-test-vectors

type shakeTestVectorSet struct {
	Groups []shakeTestGroup `json:"testGroups"`
}

type shakeTestGroup struct {
	ID            uint64 `json:"tgId"`
	Type          string `json:"testType"`
	MaxOutLenBits uint32 `json:"maxOutLen"`
	MinOutLenBits uint32 `json:"minOutLen"`
	Tests         []struct {
		ID           uint64 `json:"tcId"`
		BitLength    uint64 `json:"len"`
		BitOutLength uint32 `json:"outLen"`
		MsgHex       string `json:"msg"`
	} `json:"tests"`
}

type shakeTestGroupResponse struct {
	ID    uint64              `json:"tgId"`
	Tests []shakeTestResponse `json:"tests"`
}

type shakeTestResponse struct {
	ID         uint64           `json:"tcId"`
	DigestHex  string           `json:"md,omitempty"`
	MCTResults []shakeMCTResult `json:"resultsArray,omitempty"`
}

type shakeMCTResult struct {
	DigestHex string `json:"md"`
	OutputLen uint32 `json:"outLen,omitempty"`
}

// shake implements an ACVP algorithm by making requests to the
// subprocess to hash strings.
type shake struct {
	// algo is the ACVP name for this algorithm and also the command name
	// given to the subprocess to hash with this hash function.
	algo string
	// size is the number of bytes of digest that the hash produces for AFT tests.
	size int
}

func (h *shake) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed shakeTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []shakeTestGroupResponse
	// See
	// https://pages.nist.gov/ACVP/draft-celi-acvp-sha3.html#name-test-types
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group
		response := shakeTestGroupResponse{
			ID: group.ID,
		}

		for _, test := range group.Tests {
			test := test

			if uint64(len(test.MsgHex))*4 != test.BitLength {
				return nil, fmt.Errorf("test case %d/%d contains hex message of length %d but specifies a bit length of %d", group.ID, test.ID, len(test.MsgHex), test.BitLength)
			}
			msg, err := hex.DecodeString(test.MsgHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			if test.BitOutLength%8 != 0 {
				return nil, fmt.Errorf("test case %d/%d has bit length %d - fractional bytes not supported", group.ID, test.ID, test.BitOutLength)
			}

			switch group.Type {
			case "AFT":
				// "AFTs all produce a single digest size, matching the security strength of the extendable output function."
				if test.BitOutLength != uint32(h.size*8) {
					return nil, fmt.Errorf("AFT test case %d/%d has bit length %d but expected %d", group.ID, test.ID, test.BitOutLength, h.size*8)
				}

				m.TransactAsync(h.algo, 1, [][]byte{msg, uint32le(test.BitOutLength / 8)}, func(result [][]byte) error {
					response.Tests = append(response.Tests, shakeTestResponse{
						ID:        test.ID,
						DigestHex: hex.EncodeToString(result[0]),
					})
					return nil
				})
			case "VOT":
				// "The VOTs SHALL produce varying digest sizes based on the capabilities of the IUT"
				m.TransactAsync(h.algo+"/VOT", 1, [][]byte{msg, uint32le(test.BitOutLength / 8)}, func(result [][]byte) error {
					response.Tests = append(response.Tests, shakeTestResponse{
						ID:        test.ID,
						DigestHex: hex.EncodeToString(result[0]),
					})
					return nil
				})
			case "MCT":
				// https://pages.nist.gov/ACVP/draft-celi-acvp-sha3.html#name-shake-monte-carlo-test
				testResponse := shakeTestResponse{ID: test.ID}

				if group.MinOutLenBits%8 != 0 {
					return nil, fmt.Errorf("MCT test group %d has min output length %d - fractional bytes not supported", group.ID, group.MinOutLenBits)
				}
				if group.MaxOutLenBits%8 != 0 {
					return nil, fmt.Errorf("MCT test group %d has max output length %d - fractional bytes not supported", group.ID, group.MaxOutLenBits)
				}

				digest := msg
				minOutLenBytes := uint32le(group.MinOutLenBits / 8)
				maxOutLenBytes := uint32le(group.MaxOutLenBits / 8)
				outputLenBytes := uint32le(group.MaxOutLenBits / 8)

				for i := 0; i < 100; i++ {
					args := [][]byte{digest, minOutLenBytes, maxOutLenBytes, outputLenBytes}
					result, err := m.Transact(h.algo+"/MCT", 2, args...)
					if err != nil {
						panic(h.algo + " mct operation failed: " + err.Error())
					}

					digest = result[0]
					outputLenBytes = uint32le(binary.LittleEndian.Uint32(result[1]))
					mctResult := shakeMCTResult{DigestHex: hex.EncodeToString(digest), OutputLen: uint32(len(digest) * 8)}
					testResponse.MCTResults = append(testResponse.MCTResults, mctResult)
				}

				response.Tests = append(response.Tests, testResponse)
			default:
				return nil, fmt.Errorf("test group %d has unknown type %q", group.ID, group.Type)
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
