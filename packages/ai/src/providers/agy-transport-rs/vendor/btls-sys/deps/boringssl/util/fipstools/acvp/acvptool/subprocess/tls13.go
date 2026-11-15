// Copyright 2023 The BoringSSL Authors
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
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of TLS 1.3 tests. See
// https://pages.nist.gov/ACVP/draft-hammett-acvp-kdf-tls-v1.3.html

type tls13TestVectorSet struct {
	Groups []tls13TestGroup `json:"testGroups"`
}

type tls13TestGroup struct {
	ID       uint64      `json:"tgId"`
	HashFunc string      `json:"hmacAlg"`
	Tests    []tls13Test `json:"tests"`
}

type tls13Test struct {
	ID uint64 `json:"tcId"`
	// Although ACVP refers to these as client and server randoms, these
	// fields are misnamed and really contain portions of the handshake
	// transcript. Concatenated in order, they give the transcript up to
	// the named message. In case of HelloRetryRequest, ClientHelloHex
	// includes up to the second ClientHello.
	ClientHelloHex    string `json:"helloClientRandom"`
	ServerHelloHex    string `json:"helloServerRandom"`
	ServerFinishedHex string `json:"finishedServerRandom"`
	ClientFinishedHex string `json:"finishedClientRandom"`
	DHEInputHex       string `json:"dhe"`
	PSKInputHex       string `json:"psk"`
}

type tls13TestGroupResponse struct {
	ID    uint64              `json:"tgId"`
	Tests []tls13TestResponse `json:"tests"`
}

type tls13TestResponse struct {
	ID                                uint64 `json:"tcId"`
	ClientEarlyTrafficSecretHex       string `json:"clientEarlyTrafficSecret"`
	EarlyExporterMasterSecretHex      string `json:"earlyExporterMasterSecret"`
	ClientHandshakeTrafficSecretHex   string `json:"clientHandshakeTrafficSecret"`
	ServerHandshakeTrafficSecretHex   string `json:"serverHandshakeTrafficSecret"`
	ClientApplicationTrafficSecretHex string `json:"clientApplicationTrafficSecret"`
	ServerApplicationTrafficSecretHex string `json:"serverApplicationTrafficSecret"`
	ExporterMasterSecretHex           string `json:"exporterMasterSecret"`
	ResumptionMasterSecretHex         string `json:"resumptionMasterSecret"`
}

type tls13 struct{}

func (k *tls13) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed tls13TestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	var respGroups []tls13TestGroupResponse
	for _, group := range parsed.Groups {
		group := group
		groupResp := tls13TestGroupResponse{ID: group.ID}

		for _, test := range group.Tests {
			test := test
			testResp := tls13TestResponse{ID: test.ID}

			clientHello, err := hex.DecodeString(test.ClientHelloHex)
			if err != nil {
				return nil, err
			}
			serverHello, err := hex.DecodeString(test.ServerHelloHex)
			if err != nil {
				return nil, err
			}
			serverFinished, err := hex.DecodeString(test.ServerFinishedHex)
			if err != nil {
				return nil, err
			}
			clientFinished, err := hex.DecodeString(test.ClientFinishedHex)
			if err != nil {
				return nil, err
			}

			// See https://www.rfc-editor.org/rfc/rfc8446#section-7.1
			var hashLen int
			var emptyHash []byte
			switch group.HashFunc {
			case "SHA2-256":
				hashLen = 256 / 8
				digest := sha256.Sum256(nil)
				emptyHash = digest[:]
			case "SHA2-384":
				hashLen = 384 / 8
				digest := sha512.Sum384(nil)
				emptyHash = digest[:]
			default:
				return nil, fmt.Errorf("hash function %q is not supported for TLS v1.3", group.HashFunc)
			}
			hashLenBytes := uint32le(uint32(hashLen))

			psk, err := hex.DecodeString(test.PSKInputHex)
			if err != nil {
				return nil, err
			}
			if len(psk) == 0 {
				psk = make([]byte, hashLen)
			}

			dhe, err := hex.DecodeString(test.DHEInputHex)
			if err != nil {
				return nil, err
			}
			if len(dhe) == 0 {
				dhe = make([]byte, hashLen)
			}

			zeros := make([]byte, hashLen)
			earlySecret, err := m.Transact("HKDFExtract/"+group.HashFunc, 1, psk, zeros)
			if err != nil {
				return nil, fmt.Errorf("HKDFExtract operation failed: %s", err)
			}

			hashedToClientHello, err := m.Transact(group.HashFunc, 1, clientHello)
			if err != nil {
				return nil, fmt.Errorf("%q operation failed: %s", group.HashFunc, err)
			}
			hashedToServerHello, err := m.Transact(group.HashFunc, 1, concat(clientHello, serverHello))
			if err != nil {
				return nil, fmt.Errorf("%q operation failed: %s", group.HashFunc, err)
			}
			hashedToServerFinished, err := m.Transact(group.HashFunc, 1, concat(clientHello, serverHello, serverFinished))
			if err != nil {
				return nil, fmt.Errorf("%q operation failed: %s", group.HashFunc, err)
			}
			hashedMessages, err := m.Transact(group.HashFunc, 1, concat(clientHello, serverHello, serverFinished, clientFinished))
			if err != nil {
				return nil, fmt.Errorf("%q operation failed: %s", group.HashFunc, err)
			}

			clientEarlyTrafficSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, earlySecret[0], []byte("c e traffic"), hashedToClientHello[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ClientEarlyTrafficSecretHex = hex.EncodeToString(clientEarlyTrafficSecret[0])

			earlyExporter, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, earlySecret[0], []byte("e exp master"), hashedToClientHello[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.EarlyExporterMasterSecretHex = hex.EncodeToString(earlyExporter[0])

			derivedSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, earlySecret[0], []byte("derived"), emptyHash[:])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}

			handshakeSecret, err := m.Transact("HKDFExtract/"+group.HashFunc, 1, dhe, derivedSecret[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExtract operation failed: %s", err)
			}

			clientHandshakeTrafficSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, handshakeSecret[0], []byte("c hs traffic"), hashedToServerHello[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ClientHandshakeTrafficSecretHex = hex.EncodeToString(clientHandshakeTrafficSecret[0])

			serverHandshakeTrafficSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, handshakeSecret[0], []byte("s hs traffic"), hashedToServerHello[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ServerHandshakeTrafficSecretHex = hex.EncodeToString(serverHandshakeTrafficSecret[0])

			derivedSecret, err = m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, handshakeSecret[0], []byte("derived"), emptyHash[:])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}

			masterSecret, err := m.Transact("HKDFExtract/"+group.HashFunc, 1, zeros, derivedSecret[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExtract operation failed: %s", err)
			}

			clientAppTrafficSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, masterSecret[0], []byte("c ap traffic"), hashedToServerFinished[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ClientApplicationTrafficSecretHex = hex.EncodeToString(clientAppTrafficSecret[0])

			serverAppTrafficSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, masterSecret[0], []byte("s ap traffic"), hashedToServerFinished[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ServerApplicationTrafficSecretHex = hex.EncodeToString(serverAppTrafficSecret[0])

			exporterSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, masterSecret[0], []byte("exp master"), hashedToServerFinished[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ExporterMasterSecretHex = hex.EncodeToString(exporterSecret[0])

			resumptionSecret, err := m.Transact("HKDFExpandLabel/"+group.HashFunc, 1, hashLenBytes, masterSecret[0], []byte("res master"), hashedMessages[0])
			if err != nil {
				return nil, fmt.Errorf("HKDFExpandLabel operation failed: %s", err)
			}
			testResp.ResumptionMasterSecretHex = hex.EncodeToString(resumptionSecret[0])

			groupResp.Tests = append(groupResp.Tests, testResp)
		}
		respGroups = append(respGroups, groupResp)
	}

	return respGroups, nil
}

func concat(slices ...[]byte) []byte {
	var ret []byte
	for _, slice := range slices {
		ret = append(ret, slice...)
	}
	return ret
}
