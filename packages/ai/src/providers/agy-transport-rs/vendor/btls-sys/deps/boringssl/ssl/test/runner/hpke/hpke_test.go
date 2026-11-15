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

package hpke

import (
	"bytes"
	_ "crypto/sha256"
	_ "crypto/sha512"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

const (
	exportOnlyAEAD uint16 = 0xffff
)

//go:embed testdata/test-vectors.json
var testVectorsJSON []byte

// Simple round-trip test for fixed inputs.
func TestRoundTrip(t *testing.T) {
	publicKeyR, secretKeyR, err := GenerateKeyPairX25519()
	if err != nil {
		t.Errorf("failed to generate key pair: %s", err)
		return
	}

	// Set up the sender and receiver contexts.
	senderContext, enc, err := SetupBaseSenderX25519(HKDFSHA256, AES256GCM, publicKeyR, nil, nil)
	if err != nil {
		t.Errorf("failed to set up sender: %s", err)
		return
	}
	receiverContext, err := SetupBaseReceiverX25519(HKDFSHA256, AES256GCM, enc, secretKeyR, nil)
	if err != nil {
		t.Errorf("failed to set up receiver: %s", err)
		return
	}

	// Seal() our plaintext with the sender context, then Open() the
	// ciphertext with the receiver context.
	plaintext := []byte("foobar")
	ciphertext := senderContext.Seal(plaintext, nil)
	decrypted, err := receiverContext.Open(ciphertext, nil)
	if err != nil {
		t.Errorf("encryption round trip failed: %s", err)
		return
	}
	checkBytesEqual(t, "decrypted", decrypted, plaintext)
}

// HpkeTestVector defines the subset of test-vectors.json that we read.
type HpkeTestVector struct {
	KEM         uint16                 `json:"kem_id"`
	Mode        uint8                  `json:"mode"`
	KDF         uint16                 `json:"kdf_id"`
	AEAD        uint16                 `json:"aead_id"`
	Info        HexString              `json:"info"`
	PSK         HexString              `json:"psk"`
	PSKID       HexString              `json:"psk_id"`
	SecretKeyR  HexString              `json:"skRm"`
	SecretKeyE  HexString              `json:"skEm"`
	PublicKeyR  HexString              `json:"pkRm"`
	PublicKeyE  HexString              `json:"pkEm"`
	Enc         HexString              `json:"enc"`
	Encryptions []EncryptionTestVector `json:"encryptions"`
	Exports     []ExportTestVector     `json:"exports"`
}
type EncryptionTestVector struct {
	Plaintext      HexString `json:"pt"`
	AdditionalData HexString `json:"aad"`
	Ciphertext     HexString `json:"ct"`
}
type ExportTestVector struct {
	ExportContext HexString `json:"exporter_context"`
	ExportLength  int       `json:"L"`
	ExportValue   HexString `json:"exported_value"`
}

// TestVectors checks all relevant test vectors in test-vectors.json.
func TestVectors(t *testing.T) {
	var testVectors []HpkeTestVector
	if err := json.Unmarshal(testVectorsJSON, &testVectors); err != nil {
		t.Errorf("error parsing test vectors: %s", err)
		return
	}

	var numSkippedTests = 0

	for testNum, testVec := range testVectors {
		// Skip this vector if it specifies an unsupported parameter.
		if testVec.KEM != X25519WithHKDFSHA256 ||
			(testVec.Mode != hpkeModeBase && testVec.Mode != hpkeModePSK) ||
			testVec.AEAD == exportOnlyAEAD {
			numSkippedTests++
			continue
		}

		testVec := testVec // capture the range variable
		t.Run(fmt.Sprintf("test%d,Mode=%d,KDF=%d,AEAD=%d", testNum, testVec.Mode, testVec.KDF, testVec.AEAD), func(t *testing.T) {
			var senderContext *Context
			var receiverContext *Context
			var enc []byte
			var err error

			switch testVec.Mode {
			case hpkeModeBase:
				senderContext, enc, err = SetupBaseSenderX25519(testVec.KDF, testVec.AEAD, testVec.PublicKeyR, testVec.Info,
					func() ([]byte, []byte, error) {
						return testVec.PublicKeyE, testVec.SecretKeyE, nil
					})
				if err != nil {
					t.Errorf("failed to set up sender: %s", err)
					return
				}
				checkBytesEqual(t, "sender enc", enc, testVec.Enc)

				receiverContext, err = SetupBaseReceiverX25519(testVec.KDF, testVec.AEAD, enc, testVec.SecretKeyR, testVec.Info)
				if err != nil {
					t.Errorf("failed to set up receiver: %s", err)
					return
				}
			case hpkeModePSK:
				senderContext, enc, err = SetupPSKSenderX25519(testVec.KDF, testVec.AEAD, testVec.PublicKeyR, testVec.Info, testVec.PSK, testVec.PSKID,
					func() ([]byte, []byte, error) {
						return testVec.PublicKeyE, testVec.SecretKeyE, nil
					})
				if err != nil {
					t.Errorf("failed to set up sender: %s", err)
					return
				}
				checkBytesEqual(t, "sender enc", enc, testVec.Enc)

				receiverContext, err = SetupPSKReceiverX25519(testVec.KDF, testVec.AEAD, enc, testVec.SecretKeyR, testVec.Info, testVec.PSK, testVec.PSKID)
				if err != nil {
					t.Errorf("failed to set up receiver: %s", err)
					return
				}
			default:
				panic("unsupported mode")
			}

			for encryptionNum, e := range testVec.Encryptions {
				ciphertext := senderContext.Seal(e.Plaintext, e.AdditionalData)
				checkBytesEqual(t, "ciphertext", ciphertext, e.Ciphertext)

				decrypted, err := receiverContext.Open(ciphertext, e.AdditionalData)
				if err != nil {
					t.Errorf("decryption %d failed: %s", encryptionNum, err)
					return
				}
				checkBytesEqual(t, "decrypted plaintext", decrypted, e.Plaintext)
			}

			for _, ex := range testVec.Exports {
				exportValue := senderContext.Export(ex.ExportContext, ex.ExportLength)
				checkBytesEqual(t, "exportValue", exportValue, ex.ExportValue)

				exportValue = receiverContext.Export(ex.ExportContext, ex.ExportLength)
				checkBytesEqual(t, "exportValue", exportValue, ex.ExportValue)
			}
		})
	}

	if numSkippedTests == len(testVectors) {
		panic("no test vectors were used")
	}
}

// HexString enables us to unmarshal JSON strings containing hex byte strings.
type HexString []byte

func (h *HexString) UnmarshalJSON(data []byte) error {
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return errors.New("missing double quotes")
	}
	var err error
	*h, err = hex.DecodeString(string(data[1 : len(data)-1]))
	return err
}

func checkBytesEqual(t *testing.T, name string, actual, expected []byte) {
	if !bytes.Equal(actual, expected) {
		t.Errorf("%s = %x; want %x", name, actual, expected)
	}
}
