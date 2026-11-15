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
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of ACVP ECDSA tests. See
// https://pages.nist.gov/ACVP/draft-fussell-acvp-ecdsa.html#name-test-vectors

type ecdsaTestVectorSet struct {
	Groups []ecdsaTestGroup `json:"testGroups"`
	Algorithm string        `json:"algorithm"`
	Mode   string           `json:"mode"`
}

type ecdsaTestGroup struct {
	ID                   uint64 `json:"tgId"`
	Curve                string `json:"curve"`
	SecretGenerationMode string `json:"secretGenerationMode,omitempty"`
	HashAlgo             string `json:"hashAlg,omitEmpty"`
	ComponentTest        bool   `json:"componentTest"`
	Tests                []struct {
		ID     uint64 `json:"tcId"`
		QxHex  string `json:"qx,omitempty"`
		QyHex  string `json:"qy,omitempty"`
		RHex   string `json:"r,omitempty"`
		SHex   string `json:"s,omitempty"`
		MsgHex string `json:"message,omitempty"`
	} `json:"tests"`
}

type ecdsaTestGroupResponse struct {
	ID    uint64              `json:"tgId"`
	Tests []ecdsaTestResponse `json:"tests"`
	QxHex string              `json:"qx,omitempty"`
	QyHex string              `json:"qy,omitempty"`
}

type ecdsaTestResponse struct {
	ID     uint64 `json:"tcId"`
	DHex   string `json:"d,omitempty"`
	QxHex  string `json:"qx,omitempty"`
	QyHex  string `json:"qy,omitempty"`
	RHex   string `json:"r,omitempty"`
	SHex   string `json:"s,omitempty"`
	Passed *bool  `json:"testPassed,omitempty"` // using pointer so value is not omitted when it is false
}

// ecdsa implements an ACVP algorithm by making requests to the
// subprocess to generate and verify ECDSA keys and signatures.
type ecdsa struct {
	// algo is the ACVP name for this algorithm and also the command name
	// given to the subprocess to hash with this hash function.
	algo       string
	curves     map[string]bool // supported curve names
	primitives map[string]primitive
}

func (e *ecdsa) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed ecdsaTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	if parsed.Algorithm == "DetECDSA" && parsed.Mode != "sigGen" {
		return nil, fmt.Errorf("DetECDSA only specifies sigGen mode")
	}

	var ret []ecdsaTestGroupResponse
	// See
	// https://pages.nist.gov/ACVP/draft-fussell-acvp-ecdsa.html#name-test-vectors
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group

		if _, ok := e.curves[group.Curve]; !ok {
			return nil, fmt.Errorf("curve %q in test group %d not supported", group.Curve, group.ID)
		}

		response := ecdsaTestGroupResponse{
			ID: group.ID,
		}
		var sigGenPrivateKey []byte

		for _, test := range group.Tests {
			test := test

			var testResp ecdsaTestResponse
			testResp.ID = test.ID

			switch parsed.Mode {
			case "keyGen":
				if group.SecretGenerationMode != "testing candidates" {
					return nil, fmt.Errorf("invalid secret generation mode in test group %d: %q", group.ID, group.SecretGenerationMode)
				}
				m.TransactAsync(e.algo+"/"+"keyGen", 3, [][]byte{[]byte(group.Curve)}, func(result [][]byte) error {
					testResp.DHex = hex.EncodeToString(result[0])
					testResp.QxHex = hex.EncodeToString(result[1])
					testResp.QyHex = hex.EncodeToString(result[2])
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			case "keyVer":
				qx, err := hex.DecodeString(test.QxHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode qx in test case %d/%d: %s", group.ID, test.ID, err)
				}
				qy, err := hex.DecodeString(test.QyHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode qy in test case %d/%d: %s", group.ID, test.ID, err)
				}
				m.TransactAsync(e.algo+"/"+"keyVer", 1, [][]byte{[]byte(group.Curve), qx, qy}, func(result [][]byte) error {
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
				if group.ComponentTest && parsed.Algorithm == "DetECDSA" {
					return nil, fmt.Errorf("DetECDSA does not support component tests")
				}

				p := e.primitives[group.HashAlgo]
				h, ok := p.(*hashPrimitive)
				if !ok {
					return nil, fmt.Errorf("unsupported hash algorithm %q in test group %d", group.HashAlgo, group.ID)
				}

				if len(sigGenPrivateKey) == 0 {
					// Ask the subprocess to generate a key for this test group.
					cmd := e.algo + "/keyGen"
					if e.algo == "DetECDSA" {
						// Use "ECDSA/keyGen" for DetECDSA to avoid the module wrapper needing to support a second
						// keyGen command for DetECDSA.
						cmd = "ECDSA/keyGen"
					}
					result, err := m.Transact(cmd, 3, []byte(group.Curve))
					if err != nil {
						return nil, fmt.Errorf("key generation failed for test case %d/%d: %s", group.ID, test.ID, err)
					}

					sigGenPrivateKey = result[0]
					response.QxHex = hex.EncodeToString(result[1])
					response.QyHex = hex.EncodeToString(result[2])
				}

				msg, err := hex.DecodeString(test.MsgHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode message hex in test case %d/%d: %s", group.ID, test.ID, err)
				}
				op := e.algo + "/" + "sigGen"
				if group.ComponentTest {
					if len(msg) != h.size {
						return nil, fmt.Errorf("test case %d/%d contains message %q of length %d, but expected length %d", group.ID, test.ID, test.MsgHex, len(msg), h.size)
					}
					op += "/componentTest"
				}
				m.TransactAsync(op, 2, [][]byte{[]byte(group.Curve), sigGenPrivateKey, []byte(group.HashAlgo), msg}, func(result [][]byte) error {
					testResp.RHex = hex.EncodeToString(result[0])
					testResp.SHex = hex.EncodeToString(result[1])
					response.Tests = append(response.Tests, testResp)
					return nil
				})

			case "sigVer":
				p := e.primitives[group.HashAlgo]
				_, ok := p.(*hashPrimitive)
				if !ok {
					return nil, fmt.Errorf("unsupported hash algorithm %q in test group %d", group.HashAlgo, group.ID)
				}

				msg, err := hex.DecodeString(test.MsgHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode message hex in test case %d/%d: %s", group.ID, test.ID, err)
				}
				qx, err := hex.DecodeString(test.QxHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode qx in test case %d/%d: %s", group.ID, test.ID, err)
				}
				qy, err := hex.DecodeString(test.QyHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode qy in test case %d/%d: %s", group.ID, test.ID, err)
				}
				r, err := hex.DecodeString(test.RHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode R in test case %d/%d: %s", group.ID, test.ID, err)
				}
				s, err := hex.DecodeString(test.SHex)
				if err != nil {
					return nil, fmt.Errorf("failed to decode S in test case %d/%d: %s", group.ID, test.ID, err)
				}
				m.TransactAsync(e.algo+"/"+"sigVer", 1, [][]byte{[]byte(group.Curve), []byte(group.HashAlgo), msg, qx, qy, r, s}, func(result [][]byte) error {
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
				return nil, fmt.Errorf("invalid mode %q in ECDSA vector set", parsed.Mode)
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
