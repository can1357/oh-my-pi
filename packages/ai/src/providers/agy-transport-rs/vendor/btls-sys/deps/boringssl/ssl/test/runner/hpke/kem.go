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
	"crypto"
	"crypto/hkdf"
	"crypto/rand"

	"golang.org/x/crypto/curve25519"
)

const (
	versionLabel string = "HPKE-v1"
)

func getKDFHash(kdfID uint16) crypto.Hash {
	switch kdfID {
	case HKDFSHA256:
		return crypto.SHA256
	case HKDFSHA384:
		return crypto.SHA384
	case HKDFSHA512:
		return crypto.SHA512
	}
	panic("unknown KDF")
}

func labeledExtract(kdfHash crypto.Hash, salt, suiteID, label, ikm []byte) []byte {
	var labeledIKM []byte
	labeledIKM = append(labeledIKM, versionLabel...)
	labeledIKM = append(labeledIKM, suiteID...)
	labeledIKM = append(labeledIKM, label...)
	labeledIKM = append(labeledIKM, ikm...)
	ret, err := hkdf.Extract(kdfHash.New, labeledIKM, salt)
	if err != nil {
		panic(err)
	}
	return ret
}

func labeledExpand(kdfHash crypto.Hash, prk, suiteID, label, info []byte, length int) []byte {
	lengthU16 := uint16(length)
	if int(lengthU16) != length {
		panic("length must be a valid uint16 value")
	}

	var labeledInfo []byte
	labeledInfo = appendBigEndianUint16(labeledInfo, lengthU16)
	labeledInfo = append(labeledInfo, versionLabel...)
	labeledInfo = append(labeledInfo, suiteID...)
	labeledInfo = append(labeledInfo, label...)
	labeledInfo = append(labeledInfo, info...)

	key, err := hkdf.Expand(kdfHash.New, prk, string(labeledInfo), length)
	if err != nil {
		panic(err)
	}
	return key
}

// GenerateKeyPairX25519 generates a random X25519 key pair.
func GenerateKeyPairX25519() (publicKey, secretKeyOut []byte, err error) {
	// Generate a new private key.
	var secretKey [curve25519.ScalarSize]byte
	_, err = rand.Read(secretKey[:])
	if err != nil {
		return
	}
	// Compute the corresponding public key.
	publicKey, err = curve25519.X25519(secretKey[:], curve25519.Basepoint)
	if err != nil {
		return
	}
	return publicKey, secretKey[:], nil
}

// x25519Encap returns an ephemeral, fixed-length symmetric key |sharedSecret|
// and a fixed-length encapsulation of that key |enc| that can be decapsulated
// by the receiver with the secret key corresponding to |publicKeyR|.
// Internally, |keygenOptional| is used to generate an ephemeral keypair. If
// |keygenOptional| is nil, |GenerateKeyPairX25519| will be substituted.
func x25519Encap(publicKeyR []byte, keygen GenerateKeyPairFunc) ([]byte, []byte, error) {
	if keygen == nil {
		keygen = GenerateKeyPairX25519
	}
	publicKeyEphem, secretKeyEphem, err := keygen()
	if err != nil {
		return nil, nil, err
	}
	dh, err := curve25519.X25519(secretKeyEphem, publicKeyR)
	if err != nil {
		return nil, nil, err
	}
	sharedSecret := extractAndExpand(dh, publicKeyEphem, publicKeyR)
	return sharedSecret, publicKeyEphem, nil
}

// x25519Decap uses the receiver's secret key |secretKeyR| to recover the
// ephemeral symmetric key contained in |enc|.
func x25519Decap(enc, secretKeyR []byte) ([]byte, error) {
	dh, err := curve25519.X25519(secretKeyR, enc)
	if err != nil {
		return nil, err
	}
	// For simplicity, we recompute the receiver's public key. A production
	// implementation of HPKE should incorporate it into the receiver key
	// and halve the number of point multiplications needed.
	publicKeyR, err := curve25519.X25519(secretKeyR, curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	return extractAndExpand(dh, enc, publicKeyR[:]), nil
}

func extractAndExpand(dh, enc, publicKeyR []byte) []byte {
	var kemContext []byte
	kemContext = append(kemContext, enc...)
	kemContext = append(kemContext, publicKeyR...)

	suite := []byte("KEM")
	suite = appendBigEndianUint16(suite, X25519WithHKDFSHA256)

	kdfHash := getKDFHash(HKDFSHA256)
	prk := labeledExtract(kdfHash, nil, suite, []byte("eae_prk"), dh)
	return labeledExpand(kdfHash, prk, suite, []byte("shared_secret"), kemContext, 32)
}
