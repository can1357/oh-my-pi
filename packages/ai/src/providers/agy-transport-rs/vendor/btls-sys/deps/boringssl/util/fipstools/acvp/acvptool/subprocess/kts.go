// Copyright 2025 The BoringSSL Authors
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

// The following structures reflect the JSON of ACVP KTS-IFC tests. See
// https://pages.nist.gov/ACVP/draft-hammett-acvp-kas-ifc.html#name-test-vectors

type ktsVectorSet struct {
	Groups   []ktsTestGroup `json:"testGroups"`
	Revision string         `json:"revision"`
}

type ktsTestGroup struct {
	ID         uint64    `json:"tgId"`
	Type       string    `json:"testType"`
	Scheme     string    `json:"scheme"`
	Role       string    `json:"kasRole"`
	Modulo     uint64    `json:"modulo"`
	KeyGen     string    `json:"keyGenerationMethod"`
	KTSConf    ktsConfig `json:"ktsConfiguration"`
	OutputBits uint64    `json:"l"`
	Tests      []ktsTest `json:"tests"`
}

type ktsConfig struct {
	HashAlg               string `json:"hashAlg"`
	AssociatedDataPattern string `json:"associatedDataPattern"`
	Encoding              string `json:"encoding"`
}

type ktsTest struct {
	ID uint64 `json:"tcId"`

	ServerN string `json:"serverN,omitempty"`
	ServerE string `json:"serverE,omitempty"`
	ServerC string `json:"serverC,omitempty"`

	IutN string `json:"iutN,omitempty"`
	IutE string `json:"iutE,omitempty"`
	IutP string `json:"iutP,omitempty"`
	IutQ string `json:"iutQ,omitempty"`
	IutD string `json:"iutD,omitempty"`
}

type ktsTestGroupResponse struct {
	ID    uint64            `json:"tgId"`
	Tests []ktsTestResponse `json:"tests"`
}

type ktsTestResponse struct {
	ID   uint64 `json:"tcId"`
	IutC string `json:"iutC,omitempty"` // initiator role only
	Dkm  string `json:"dkm,omitempty"`
}

type kts struct {
	hashAlgs map[string]bool // the supported hash algorithm primitives
}

func (k *kts) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed ktsVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	if parsed.Revision != "Sp800-56Br2" {
		return nil, fmt.Errorf("unsupported revision %q", parsed.Revision)
	}

	var ret []ktsTestGroupResponse
	for _, group := range parsed.Groups {
		group := group
		response := ktsTestGroupResponse{
			ID: group.ID,
		}

		if group.Type != "AFT" {
			return nil, fmt.Errorf("unsupported test type %q in test group %d", group.Type, group.ID)
		}

		if group.Scheme != "KTS-OAEP-basic" {
			return nil, fmt.Errorf("unsupported scheme %q in test group %d", group.Scheme, group.ID)
		}

		if group.KeyGen != "rsakpg1-basic" {
			return nil, fmt.Errorf("unsupported key generation method %q in test group %d - only fixed public exponent (rsakpg1-basic) is supported", group.KeyGen, group.ID)
		}

		if group.OutputBits%8 != 0 {
			return nil, fmt.Errorf("%d bit L in test group %d: fractional bytes not supported", group.OutputBits, group.ID)
		}

		if _, ok := k.hashAlgs[group.KTSConf.HashAlg]; !ok {
			return nil, fmt.Errorf("test group %d specifies unsupported hash alg %q", group.ID, group.KTSConf.HashAlg)
		}

		var testResponses []ktsTestResponse
		for _, test := range group.Tests {
			test := test

			var err error
			switch group.Role {
			case "initiator":
				err = k.processInitiator(m, &testResponses, group.KTSConf.HashAlg, group.OutputBits, test)
			case "responder":
				err = k.processResponder(m, &testResponses, group.KTSConf.HashAlg, test)
			default:
				err = fmt.Errorf("unknown role %q", group.Role)
			}

			if err != nil {
				return nil, err
			}
		}

		m.Barrier(func() {
			response.Tests = testResponses
			ret = append(ret, response)
		})
	}

	if err := m.Flush(); err != nil {
		return nil, err
	}

	return ret, nil
}

func (k *kts) processInitiator(m Transactable, responses *[]ktsTestResponse, hashAlg string, outputBits uint64, test ktsTest) error {
	outputBytes := uint32le(uint32(outputBits / 8))

	nBytes, err := hex.DecodeString(test.ServerN)
	if err != nil {
		return fmt.Errorf("invalid ServerN: %v", err)
	}
	eBytes, err := hex.DecodeString(test.ServerE)
	if err != nil {
		return fmt.Errorf("invalid ServerE: %v", err)
	}

	cmd := fmt.Sprintf("KTS-IFC/%s/initiator", hashAlg)
	args := [][]byte{outputBytes, nBytes, eBytes}

	m.TransactAsync(cmd, 2, args, func(result [][]byte) error {
		*responses = append(*responses,
			ktsTestResponse{
				ID:   test.ID,
				IutC: hex.EncodeToString(result[0]),
				Dkm:  hex.EncodeToString(result[1]),
			})
		return nil
	})

	return nil
}

func (k *kts) processResponder(m Transactable, responses *[]ktsTestResponse, hashAlg string, test ktsTest) error {
	nBytes, err := hex.DecodeString(test.IutN)
	if err != nil {
		return fmt.Errorf("invalid IutN: %v", err)
	}

	eBytes, err := hex.DecodeString(test.IutE)
	if err != nil {
		return fmt.Errorf("invalid IutE: %v", err)
	}

	pBytes, err := hex.DecodeString(test.IutP)
	if err != nil {
		return fmt.Errorf("invalid IutP: %v", err)
	}

	qBytes, err := hex.DecodeString(test.IutQ)
	if err != nil {
		return fmt.Errorf("invalid IutQ: %v", err)
	}

	dBytes, err := hex.DecodeString(test.IutD)
	if err != nil {
		return fmt.Errorf("invalid IutD: %v", err)
	}

	cBytes, err := hex.DecodeString(test.ServerC)
	if err != nil {
		return fmt.Errorf("invalid ServerC: %v", err)
	}

	cmd := fmt.Sprintf("KTS-IFC/%s/responder", hashAlg)
	args := [][]byte{nBytes, eBytes, pBytes, qBytes, dBytes, cBytes}

	m.TransactAsync(cmd, 1, args, func(result [][]byte) error {
		*responses = append(*responses,
			ktsTestResponse{
				ID:  test.ID,
				Dkm: hex.EncodeToString(result[0]),
			})
		return nil
	})

	return nil
}
