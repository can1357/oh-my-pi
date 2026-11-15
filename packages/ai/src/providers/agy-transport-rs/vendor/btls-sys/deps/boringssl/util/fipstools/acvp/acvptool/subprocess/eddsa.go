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
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of ACVP EDDSA tests. See
// https://pages.nist.gov/ACVP/draft-celi-acvp-eddsa.html#name-test-types

type eddsaTestVectorSet struct {
	Groups []eddsaTestGroup `json:"testGroups"`
	Mode   string           `json:"mode"`
}

type eddsaTestGroup struct {
	ID      uint64 `json:"tgId"`
	Type    string `json:"testType"`
	Curve   string `json:"curve"`
	Prehash bool   `json:"prehash"`
	Tests   []struct {
		ID            uint64 `json:"tcId"`
		QHex          string `json:"q,omitempty"`
		ContextHex    string `json:"context,omitempty"`
		ContextLength uint64 `json:"contextLength,omitempty"`
		MsgHex        string `json:"message,omitempty"`
		SignatureHex  string `json:"signature,omitempty"`
	} `json:"tests"`
}

type eddsaTestGroupResponse struct {
	ID    uint64              `json:"tgId"`
	Tests []eddsaTestResponse `json:"tests"`
	QHex  string              `json:"q,omitempty"`
}

type eddsaTestResponse struct {
	ID           uint64 `json:"tcId"`
	DHex         string `json:"d,omitempty"`
	QHex         string `json:"q,omitempty"`
	Passed       *bool  `json:"testPassed,omitempty"` // using pointer so value is not omitted when it is false
	SignatureHex string `json:"signature,omitempty"`
}

// eddsa implements an ACVP algorithm by making requests to the
// subprocess to generate and verify EDDSA keys and signatures.
type eddsa struct {
	algo   string
	curves map[string]bool // supported curve names
}

func (e *eddsa) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed eddsaTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []eddsaTestGroupResponse
	// See
	// https://pages.nist.gov/ACVP/draft-celi-acvp-eddsa.html#name-test-vectors
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group

		if _, ok := e.curves[group.Curve]; !ok {
			return nil, fmt.Errorf("curve %q in test group %d not supported", group.Curve, group.ID)
		}

		response := eddsaTestGroupResponse{
			ID: group.ID,
		}

		var sigGenPrivKeySeed []byte
		var sigGenPrivKeyQHex string
		for _, test := range group.Tests {
			test := test

			var testResp eddsaTestResponse
			testResp.ID = test.ID

			switch parsed.Mode {
			case "keyGen":
				if group.Type != "AFT" {
					return nil, fmt.Errorf("unknown test type %q in keyGen test group %d", group.Type, group.ID)
				}
				m.TransactAsync(e.algo+"/keyGen", 2, [][]byte{[]byte(group.Curve)}, func(result [][]byte) error {
					testResp.DHex = hex.EncodeToString(result[0])
					testResp.QHex = hex.EncodeToString(result[1])
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			case "keyVer":
				if group.Type != "AFT" {
					return nil, fmt.Errorf("unknown test type %q in keyGen test group %d", group.Type, group.ID)
				}
				q, err := hex.DecodeString(test.QHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode q in test case %d/%d: %s", group.ID, test.ID, err)
				}
				m.TransactAsync(e.algo+"/keyVer", 1, [][]byte{[]byte(group.Curve), q}, func(result [][]byte) error {
					// result[0] should be a single byte: zero if false, one if true
					switch {
					case bytes.Equal(result[0], []byte{00}):
						f := false
						testResp.Passed = &f
					case bytes.Equal(result[0], []byte{01}):
						t := true
						testResp.Passed = &t
					default:
						return fmt.Errorf("key verification returned unexpected result: %q", result[0])
					}
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			case "sigGen":
				if group.Type != "AFT" && group.Type != "BFT" {
					return nil, fmt.Errorf("unknown test type %q in keyGen test group %d", group.Type, group.ID)
				}

				if len(sigGenPrivKeySeed) == 0 {
					result, err := m.Transact(e.algo+"/keyGen", 2, []byte(group.Curve))
					if err != nil {
						return nil, fmt.Errorf("key generation failed for test case %d/%d: %s", group.ID, test.ID, err)
					}

					sigGenPrivKeySeed = result[0]
					sigGenPrivKeyQHex = hex.EncodeToString(result[1])
				}
				response.QHex = sigGenPrivKeyQHex

				msg, err := hex.DecodeString(test.MsgHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode message hex in test case %d/%d: %s", group.ID, test.ID, err)
				}

				prehash := []byte{0}
				if group.Prehash {
					prehash = []byte{1}
				}
				var context []byte
				if test.ContextHex != "" {
					if uint64(len(test.ContextHex)) != test.ContextLength*2 {
						return nil, fmt.Errorf("context hex length %d does not match context length %d in test case %d/%d", len(test.ContextHex), test.ContextLength, group.ID, test.ID)
					}
					context, err = hex.DecodeString(test.ContextHex)
					if err != nil {
						return nil, fmt.Errorf("failed to decode context hex in test case %d/%d: %s", group.ID, test.ID, err)
					}
				}

				args := [][]byte{[]byte(group.Curve), sigGenPrivKeySeed, msg, prehash, context}
				m.TransactAsync(e.algo+"/sigGen", 1, args, func(result [][]byte) error {
					testResp.SignatureHex = hex.EncodeToString(result[0])
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			case "sigVer":
				if group.Type != "AFT" {
					return nil, fmt.Errorf("unknown test type %q in keyGen test group %d", group.Type, group.ID)
				}

				if test.ContextHex != "" {
					return nil, fmt.Errorf("unexpected context field in sigVer test case %d/%d", group.ID, test.ID)
				}

				msg, err := hex.DecodeString(test.MsgHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode message hex in test case %d/%d: %s", group.ID, test.ID, err)
				}
				q, err := hex.DecodeString(test.QHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode q in test case %d/%d: %s", group.ID, test.ID, err)
				}
				signature, err := hex.DecodeString(test.SignatureHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode signature in test case %d/%d: %s", group.ID, test.ID, err)
				}
				prehash := []byte{0}
				if group.Prehash {
					prehash = []byte{1}
				}

				args := [][]byte{[]byte(group.Curve), msg, q, signature, prehash}
				m.TransactAsync(e.algo+"/sigVer", 1, args, func(result [][]byte) error {
					// result[0] should be a single byte: zero if false, one if true
					switch {
					case bytes.Equal(result[0], []byte{00}):
						f := false
						testResp.Passed = &f
					case bytes.Equal(result[0], []byte{01}):
						t := true
						testResp.Passed = &t
					default:
						return fmt.Errorf("signature verification returned unexpected result: %q", result[0])
					}
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			default:
				return nil, fmt.Errorf("invalid mode %q in EDDSA vector set", parsed.Mode)
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
