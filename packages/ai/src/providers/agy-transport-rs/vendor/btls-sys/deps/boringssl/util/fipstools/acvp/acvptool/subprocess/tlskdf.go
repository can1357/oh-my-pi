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
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

type tlsKDFVectorSet struct {
	Groups []tlsKDFTestGroup `json:"testGroups"`
}

type tlsKDFTestGroup struct {
	ID           uint64       `json:"tgId"`
	Hash         string       `json:"hashAlg"`
	TLSVersion   string       `json:"tlsVersion"`
	KeyBlockBits uint64       `json:"keyBlockLength"`
	PMSLength    uint64       `json:"preMasterSecretLength"`
	Tests        []tlsKDFTest `json:"tests"`
}

type tlsKDFTest struct {
	ID              uint64 `json:"tcId"`
	PMSHex          string `json:"preMasterSecret"`
	ClientRandomHex string `json:"clientRandom"`
	ServerRandomHex string `json:"serverRandom"`
	SessionHashHex  string `json:"sessionHash"`
}

type tlsKDFTestGroupResponse struct {
	ID    uint64               `json:"tgId"`
	Tests []tlsKDFTestResponse `json:"tests"`
}

type tlsKDFTestResponse struct {
	ID              uint64 `json:"tcId"`
	MasterSecretHex string `json:"masterSecret"`
	KeyBlockHex     string `json:"keyBlock"`
}

type tlsKDF struct{}

func (k *tlsKDF) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed tlsKDFVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	// See https://pages.nist.gov/ACVP/draft-celi-acvp-kdf-tls.html
	var ret []tlsKDFTestGroupResponse
	for _, group := range parsed.Groups {
		group := group
		response := tlsKDFTestGroupResponse{
			ID: group.ID,
		}

		switch group.Hash {
		case "SHA2-256", "SHA2-384", "SHA2-512":
			break
		default:
			return nil, fmt.Errorf("unknown hash %q", group.Hash)
		}

		if group.KeyBlockBits%8 != 0 {
			return nil, fmt.Errorf("requested key-block length (%d bits) is not a whole number of bytes", group.KeyBlockBits)
		}

		method := "TLSKDF/1.2/" + group.Hash

		for _, test := range group.Tests {
			test := test
			pms, err := hex.DecodeString(test.PMSHex)
			if err != nil {
				return nil, err
			}

			clientRandom, err := hex.DecodeString(test.ClientRandomHex)
			if err != nil {
				return nil, err
			}

			serverRandom, err := hex.DecodeString(test.ServerRandomHex)
			if err != nil {
				return nil, err
			}

			sessionHash, err := hex.DecodeString(test.SessionHashHex)
			if err != nil {
				return nil, err
			}

			const (
				masterSecretLength = 48
				masterSecretLabel  = "extended master secret"
				keyBlockLabel      = "key expansion"
			)

			var outLenBytes [4]byte
			binary.LittleEndian.PutUint32(outLenBytes[:], uint32(masterSecretLength))
			result, err := m.Transact(method, 1, outLenBytes[:], pms, []byte(masterSecretLabel), sessionHash, nil)
			if err != nil {
				return nil, err
			}

			binary.LittleEndian.PutUint32(outLenBytes[:], uint32(group.KeyBlockBits/8))
			// TLS 1.0, 1.1, and 1.2 use a different order for the client and server
			// randoms when computing the key block.
			m.TransactAsync(method, 1, [][]byte{outLenBytes[:], result[0], []byte(keyBlockLabel), serverRandom, clientRandom}, func(result2 [][]byte) error {
				response.Tests = append(response.Tests, tlsKDFTestResponse{
					ID:              test.ID,
					MasterSecretHex: hex.EncodeToString(result[0]),
					KeyBlockHex:     hex.EncodeToString(result2[0]),
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
