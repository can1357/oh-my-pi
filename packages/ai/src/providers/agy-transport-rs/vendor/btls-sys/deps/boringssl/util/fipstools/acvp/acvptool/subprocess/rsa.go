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

// See https://pages.nist.gov/ACVP/draft-celi-acvp-rsa.html#name-test-vectors
// although, at the time of writing, that spec doesn't match what the NIST demo
// server actually produces. This code matches the server.

type rsaTestVectorSet struct {
	Mode string `json:"mode"`
}

type rsaKeyGenTestVectorSet struct {
	Groups []rsaKeyGenGroup `json:"testGroups"`
}

type rsaKeyGenGroup struct {
	ID          uint64          `json:"tgId"`
	Type        string          `json:"testType"`
	ModulusBits uint32          `json:"modulo"`
	Tests       []rsaKeyGenTest `json:"tests"`
}

type rsaKeyGenTest struct {
	ID uint64 `json:"tcId"`
}

type rsaKeyGenTestGroupResponse struct {
	ID    uint64                  `json:"tgId"`
	Tests []rsaKeyGenTestResponse `json:"tests"`
}

type rsaKeyGenTestResponse struct {
	ID uint64 `json:"tcId"`
	E  string `json:"e"`
	P  string `json:"p"`
	Q  string `json:"q"`
	N  string `json:"n"`
	D  string `json:"d"`
}

type rsaSigGenTestVectorSet struct {
	Groups []rsaSigGenGroup `json:"testGroups"`
}

type rsaSigGenGroup struct {
	ID          uint64          `json:"tgId"`
	Type        string          `json:"testType"`
	SigType     string          `json:"sigType"`
	ModulusBits uint32          `json:"modulo"`
	Hash        string          `json:"hashAlg"`
	Tests       []rsaSigGenTest `json:"tests"`
}

type rsaSigGenTest struct {
	ID         uint64 `json:"tcId"`
	MessageHex string `json:"message"`
}

type rsaSigGenTestGroupResponse struct {
	ID    uint64                  `json:"tgId"`
	N     string                  `json:"n"`
	E     string                  `json:"e"`
	Tests []rsaSigGenTestResponse `json:"tests"`
}

type rsaSigGenTestResponse struct {
	ID  uint64 `json:"tcId"`
	Sig string `json:"signature"`
}

type rsaSigVerTestVectorSet struct {
	Groups []rsaSigVerGroup `json:"testGroups"`
}

type rsaSigVerGroup struct {
	ID      uint64          `json:"tgId"`
	Type    string          `json:"testType"`
	SigType string          `json:"sigType"`
	Hash    string          `json:"hashAlg"`
	N       string          `json:"n"`
	E       string          `json:"e"`
	Tests   []rsaSigVerTest `json:"tests"`
}

type rsaSigVerTest struct {
	ID           uint64 `json:"tcId"`
	MessageHex   string `json:"message"`
	SignatureHex string `json:"signature"`
}

type rsaSigVerTestGroupResponse struct {
	ID    uint64                  `json:"tgId"`
	Tests []rsaSigVerTestResponse `json:"tests"`
}

type rsaSigVerTestResponse struct {
	ID     uint64 `json:"tcId"`
	Passed bool   `json:"testPassed"`
}

func processKeyGen(vectorSet []byte, m Transactable) (any, error) {
	var parsed rsaKeyGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []rsaKeyGenTestGroupResponse

	for _, group := range parsed.Groups {
		group := group

		// GDT means "Generated data test", i.e. "please generate an RSA key".
		const expectedType = "GDT"
		if group.Type != expectedType {
			return nil, fmt.Errorf("RSA KeyGen test group has type %q, but only generation tests (%q) are supported", group.Type, expectedType)
		}

		response := rsaKeyGenTestGroupResponse{
			ID: group.ID,
		}

		for _, test := range group.Tests {
			test := test

			m.TransactAsync("RSA/keyGen", 5, [][]byte{uint32le(group.ModulusBits)}, func(result [][]byte) error {
				response.Tests = append(response.Tests, rsaKeyGenTestResponse{
					ID: test.ID,
					E:  hex.EncodeToString(result[0]),
					P:  hex.EncodeToString(result[1]),
					Q:  hex.EncodeToString(result[2]),
					N:  hex.EncodeToString(result[3]),
					D:  hex.EncodeToString(result[4]),
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

func processSigGen(vectorSet []byte, m Transactable) (any, error) {
	var parsed rsaSigGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []rsaSigGenTestGroupResponse

	for _, group := range parsed.Groups {
		group := group

		// GDT means "Generated data test", i.e. "please generate an RSA signature".
		const expectedType = "GDT"
		if group.Type != expectedType {
			return nil, fmt.Errorf("RSA SigGen test group has type %q, but only generation tests (%q) are supported", group.Type, expectedType)
		}

		response := rsaSigGenTestGroupResponse{
			ID: group.ID,
		}

		operation := "RSA/sigGen/" + group.Hash + "/" + group.SigType

		for _, test := range group.Tests {
			test := test

			msg, err := hex.DecodeString(test.MessageHex)
			if err != nil {
				return nil, fmt.Errorf("test case %d/%d contains invalid hex: %s", group.ID, test.ID, err)
			}

			m.TransactAsync(operation, 3, [][]byte{uint32le(group.ModulusBits), msg}, func(result [][]byte) error {
				if len(response.N) == 0 {
					response.N = hex.EncodeToString(result[0])
					response.E = hex.EncodeToString(result[1])
				} else if response.N != hex.EncodeToString(result[0]) {
					return fmt.Errorf("module wrapper returned different RSA keys for the same SigGen configuration")
				}

				response.Tests = append(response.Tests, rsaSigGenTestResponse{
					ID:  test.ID,
					Sig: hex.EncodeToString(result[2]),
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

func processSigVer(vectorSet []byte, m Transactable) (any, error) {
	var parsed rsaSigVerTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []rsaSigVerTestGroupResponse

	for _, group := range parsed.Groups {
		group := group

		// GDT means "Generated data test", which makes no sense in this context.
		const expectedType = "GDT"
		if group.Type != expectedType {
			return nil, fmt.Errorf("RSA SigVer test group has type %q, but only 'generation' tests (%q) are supported", group.Type, expectedType)
		}

		n, err := hex.DecodeString(group.N)
		if err != nil {
			return nil, fmt.Errorf("test group %d contains invalid hex: %s", group.ID, err)
		}
		e, err := hex.DecodeString(group.E)
		if err != nil {
			return nil, fmt.Errorf("test group %d contains invalid hex: %s", group.ID, err)
		}

		response := rsaSigVerTestGroupResponse{
			ID: group.ID,
		}

		operation := "RSA/sigVer/" + group.Hash + "/" + group.SigType

		for _, test := range group.Tests {
			test := test
			msg, err := hex.DecodeString(test.MessageHex)
			if err != nil {
				return nil, fmt.Errorf("test case %d/%d contains invalid hex: %s", group.ID, test.ID, err)
			}
			sig, err := hex.DecodeString(test.SignatureHex)
			if err != nil {
				return nil, fmt.Errorf("test case %d/%d contains invalid hex: %s", group.ID, test.ID, err)
			}

			m.TransactAsync(operation, 1, [][]byte{n, e, msg, sig}, func(result [][]byte) error {
				response.Tests = append(response.Tests, rsaSigVerTestResponse{
					ID:     test.ID,
					Passed: len(result[0]) == 1 && result[0][0] == 1,
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

type rsa struct{}

func (*rsa) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed rsaTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	switch parsed.Mode {
	case "keyGen":
		return processKeyGen(vectorSet, m)
	case "sigGen":
		return processSigGen(vectorSet, m)
	case "sigVer":
		return processSigVer(vectorSet, m)
	default:
		return nil, fmt.Errorf("Unknown RSA mode %q", parsed.Mode)
	}
}
