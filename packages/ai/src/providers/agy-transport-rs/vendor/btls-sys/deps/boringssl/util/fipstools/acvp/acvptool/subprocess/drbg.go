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
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of ACVP DRBG tests. See
// https://pages.nist.gov/ACVP/draft-vassilev-acvp-drbg.html#name-test-vectors

type drbgTestVectorSet struct {
	Groups []drbgTestGroup `json:"testGroups"`
}

type drbgTestGroup struct {
	ID                    uint64 `json:"tgId"`
	Mode                  string `json:"mode"`
	UseDerivationFunction bool   `json:"derFunc,omitempty"`
	PredictionResistance  bool   `json:"predResistance"`
	Reseed                bool   `json:"reSeed"`
	EntropyBits           uint64 `json:"entropyInputLen"`
	NonceBits             uint64 `json:"nonceLen"`
	PersonalizationBits   uint64 `json:"persoStringLen"`
	AdditionalDataBits    uint64 `json:"additionalInputLen"`
	RetBits               uint64 `json:"returnedBitsLen"`
	Tests                 []struct {
		ID                 uint64           `json:"tcId"`
		EntropyHex         string           `json:"entropyInput"`
		NonceHex           string           `json:"nonce"`
		PersonalizationHex string           `json:"persoString"`
		Other              []drbgOtherInput `json:"otherInput"`
	} `json:"tests"`
}

type drbgOtherInput struct {
	Use               string `json:"intendedUse"`
	AdditionalDataHex string `json:"additionalInput"`
	EntropyHex        string `json:"entropyInput"`
}

type drbgTestGroupResponse struct {
	ID    uint64             `json:"tgId"`
	Tests []drbgTestResponse `json:"tests"`
}

type drbgTestResponse struct {
	ID     uint64 `json:"tcId"`
	OutHex string `json:"returnedBits,omitempty"`
}

// drbg implements an ACVP algorithm by making requests to the
// subprocess to generate random bits with the given entropy and other parameters.
type drbg struct {
	// algo is the ACVP name for this algorithm and also the command name
	// given to the subprocess to generate random bytes.
	algo  string
	modes map[string]bool // the supported underlying primitives for the DRBG
}

func (d *drbg) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed drbgTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var ret []drbgTestGroupResponse
	// See
	// https://pages.nist.gov/ACVP/draft-vassilev-acvp-drbg.html#name-test-vectors
	// for details about the tests.
	for _, group := range parsed.Groups {
		group := group
		response := drbgTestGroupResponse{
			ID: group.ID,
		}

		if _, ok := d.modes[group.Mode]; !ok {
			return nil, fmt.Errorf("test group %d specifies mode %q, which is not supported for the %s algorithm", group.ID, group.Mode, d.algo)
		}

		if group.RetBits%8 != 0 {
			return nil, fmt.Errorf("Test group %d requests %d-bit outputs, but fractional-bytes are not supported", group.ID, group.RetBits)
		}

		for _, test := range group.Tests {
			test := test

			ent, err := extractField(test.EntropyHex, group.EntropyBits)
			if err != nil {
				return nil, fmt.Errorf("failed to extract entropy hex from test case %d/%d: %s", group.ID, test.ID, err)
			}

			nonce, err := extractField(test.NonceHex, group.NonceBits)
			if err != nil {
				return nil, fmt.Errorf("failed to extract nonce hex from test case %d/%d: %s", group.ID, test.ID, err)
			}

			perso, err := extractField(test.PersonalizationHex, group.PersonalizationBits)
			if err != nil {
				return nil, fmt.Errorf("failed to extract personalization hex from test case %d/%d: %s", group.ID, test.ID, err)
			}

			outLen := group.RetBits / 8
			var outLenBytes [4]byte
			binary.LittleEndian.PutUint32(outLenBytes[:], uint32(outLen))

			var cmd string
			var args [][]byte
			if group.PredictionResistance {
				var a1, a2, a3, a4 []byte
				if err := extractOtherInputs(test.Other, []drbgOtherInputExpectations{
					{"generate", group.AdditionalDataBits, &a1, group.EntropyBits, &a2},
					{"generate", group.AdditionalDataBits, &a3, group.EntropyBits, &a4}}); err != nil {
					return nil, fmt.Errorf("failed to parse other inputs from test case %d/%d: %s", group.ID, test.ID, err)
				}
				cmd = d.algo + "-pr/" + group.Mode
				args = [][]byte{outLenBytes[:], ent, perso, a1, a2, a3, a4, nonce}
			} else if group.Reseed {
				var a1, a2, a3, a4 []byte
				if err := extractOtherInputs(test.Other, []drbgOtherInputExpectations{
					{"reSeed", group.AdditionalDataBits, &a1, group.EntropyBits, &a2},
					{"generate", group.AdditionalDataBits, &a3, 0, nil},
					{"generate", group.AdditionalDataBits, &a4, 0, nil}}); err != nil {
					return nil, fmt.Errorf("failed to parse other inputs from test case %d/%d: %s", group.ID, test.ID, err)
				}
				cmd = d.algo + "-reseed/" + group.Mode
				args = [][]byte{outLenBytes[:], ent, perso, a1, a2, a3, a4, nonce}
			} else {
				var a1, a2 []byte
				if err := extractOtherInputs(test.Other, []drbgOtherInputExpectations{
					{"generate", group.AdditionalDataBits, &a1, 0, nil},
					{"generate", group.AdditionalDataBits, &a2, 0, nil}}); err != nil {
					return nil, fmt.Errorf("failed to parse other inputs from test case %d/%d: %s", group.ID, test.ID, err)
				}
				cmd = d.algo + "/" + group.Mode
				args = [][]byte{outLenBytes[:], ent, perso, a1, a2, nonce}
			}

			m.TransactAsync(cmd, 1, args, func(result [][]byte) error {
				if l := uint64(len(result[0])); l != outLen {
					return fmt.Errorf("wrong length DRBG result: %d bytes but wanted %d", l, outLen)
				}

				// https://pages.nist.gov/ACVP/draft-vassilev-acvp-drbg.html#name-responses
				response.Tests = append(response.Tests, drbgTestResponse{
					ID:     test.ID,
					OutHex: hex.EncodeToString(result[0]),
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

type drbgOtherInputExpectations struct {
	use                   string
	additionalInputBitLen uint64
	additionalInputOut    *[]byte
	entropyBitLen         uint64
	entropyOut            *[]byte
}

func extractOtherInputs(inputs []drbgOtherInput, expected []drbgOtherInputExpectations) (err error) {
	if len(inputs) != len(expected) {
		return fmt.Errorf("found %d other inputs but %d were expected", len(inputs), len(expected))
	}

	for i := range inputs {
		input, expect := &inputs[i], &expected[i]

		if input.Use != expect.use {
			return fmt.Errorf("other input #%d has type %q but expected %q", i, input.Use, expect.use)
		}

		if expect.additionalInputBitLen == 0 {
			if len(input.AdditionalDataHex) != 0 {
				return fmt.Errorf("other input #%d has unexpected additional input", i)
			}
		} else {
			*expect.additionalInputOut, err = extractField(input.AdditionalDataHex, expect.additionalInputBitLen)
			if err != nil {
				return err
			}
		}

		if expect.entropyBitLen == 0 {
			if len(input.EntropyHex) != 0 {
				return fmt.Errorf("other input #%d has unexpected entropy value", i)
			}
		} else {
			*expect.entropyOut, err = extractField(input.EntropyHex, expect.entropyBitLen)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

// validate the length and hex of a JSON field in test vectors
func extractField(fieldHex string, bits uint64) ([]byte, error) {
	if uint64(len(fieldHex))*4 != bits {
		return nil, fmt.Errorf("expected %d bits but have %d-byte hex string", bits, len(fieldHex))
	}
	return hex.DecodeString(fieldHex)
}
