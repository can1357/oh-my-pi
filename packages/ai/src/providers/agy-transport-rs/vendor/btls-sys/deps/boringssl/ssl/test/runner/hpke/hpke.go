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

// Package hpke implements Hybrid Public Key Encryption (HPKE).
//
// See RFC 9180.
package hpke

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"fmt"

	"golang.org/x/crypto/chacha20poly1305"
)

// KEM scheme IDs.
const (
	P256WithHKDFSHA256   uint16 = 0x0010
	X25519WithHKDFSHA256 uint16 = 0x0020
)

// HPKE AEAD IDs.
const (
	AES128GCM        uint16 = 0x0001
	AES256GCM        uint16 = 0x0002
	ChaCha20Poly1305 uint16 = 0x0003
)

// HPKE KDF IDs.
const (
	HKDFSHA256 uint16 = 0x0001
	HKDFSHA384 uint16 = 0x0002
	HKDFSHA512 uint16 = 0x0003
)

// Internal constants.
const (
	hpkeModeBase uint8 = 0
	hpkeModePSK  uint8 = 1
)

// GetHKDFHash returns the crypto.Hash that corresponds to kdf. If kdf is not
// one the supported KDF IDs, returns an error.
func GetHKDFHash(kdf uint16) (crypto.Hash, error) {
	switch kdf {
	case HKDFSHA256:
		return crypto.SHA256, nil
	case HKDFSHA384:
		return crypto.SHA384, nil
	case HKDFSHA512:
		return crypto.SHA512, nil
	}
	return 0, fmt.Errorf("unknown KDF: %d", kdf)
}

type GenerateKeyPairFunc func() (public []byte, secret []byte, e error)

// Context holds the HPKE state for a sender or a receiver.
type Context struct {
	kemID  uint16
	kdfID  uint16
	aeadID uint16

	aead cipher.AEAD

	key            []byte
	baseNonce      []byte
	seq            uint64
	exporterSecret []byte
}

// SetupBaseSenderX25519 corresponds to the spec's SetupBaseS(), but only
// supports X25519.
func SetupBaseSenderX25519(kdfID, aeadID uint16, publicKeyR, info []byte, ephemKeygen GenerateKeyPairFunc) (context *Context, enc []byte, err error) {
	sharedSecret, enc, err := x25519Encap(publicKeyR, ephemKeygen)
	if err != nil {
		return nil, nil, err
	}
	context, err = keySchedule(hpkeModeBase, X25519WithHKDFSHA256, kdfID, aeadID, sharedSecret, info, nil, nil)
	return
}

// SetupBaseReceiverX25519 corresponds to the spec's SetupBaseR(), but only
// supports X25519.
func SetupBaseReceiverX25519(kdfID, aeadID uint16, enc, secretKeyR, info []byte) (context *Context, err error) {
	sharedSecret, err := x25519Decap(enc, secretKeyR)
	if err != nil {
		return nil, err
	}
	return keySchedule(hpkeModeBase, X25519WithHKDFSHA256, kdfID, aeadID, sharedSecret, info, nil, nil)
}

// SetupPSKSenderX25519 corresponds to the spec's SetupPSKS(), but only supports
// X25519.
func SetupPSKSenderX25519(kdfID, aeadID uint16, publicKeyR, info, psk, pskID []byte, ephemKeygen GenerateKeyPairFunc) (context *Context, enc []byte, err error) {
	sharedSecret, enc, err := x25519Encap(publicKeyR, ephemKeygen)
	if err != nil {
		return nil, nil, err
	}
	context, err = keySchedule(hpkeModePSK, X25519WithHKDFSHA256, kdfID, aeadID, sharedSecret, info, psk, pskID)
	return
}

// SetupPSKReceiverX25519 corresponds to the spec's SetupPSKR(), but only
// supports X25519.
func SetupPSKReceiverX25519(kdfID, aeadID uint16, enc, secretKeyR, info, psk, pskID []byte) (context *Context, err error) {
	sharedSecret, err := x25519Decap(enc, secretKeyR)
	if err != nil {
		return nil, err
	}
	context, err = keySchedule(hpkeModePSK, X25519WithHKDFSHA256, kdfID, aeadID, sharedSecret, info, psk, pskID)
	if err != nil {
		return nil, err
	}
	return context, nil
}

func (c *Context) KEM() uint16 { return c.kemID }

func (c *Context) KDF() uint16 { return c.kdfID }

func (c *Context) AEAD() uint16 { return c.aeadID }

func (c *Context) Overhead() int { return c.aead.Overhead() }

func (c *Context) Seal(plaintext, additionalData []byte) []byte {
	ciphertext := c.aead.Seal(nil, c.computeNonce(), plaintext, additionalData)
	c.incrementSeq()
	return ciphertext
}

func (c *Context) Open(ciphertext, additionalData []byte) ([]byte, error) {
	plaintext, err := c.aead.Open(nil, c.computeNonce(), ciphertext, additionalData)
	if err != nil {
		return nil, err
	}
	c.incrementSeq()
	return plaintext, nil
}

func (c *Context) Export(exporterContext []byte, length int) []byte {
	suiteID := buildSuiteID(c.kemID, c.kdfID, c.aeadID)
	kdfHash := getKDFHash(c.kdfID)
	return labeledExpand(kdfHash, c.exporterSecret, suiteID, []byte("sec"), exporterContext, length)
}

func buildSuiteID(kemID, kdfID, aeadID uint16) []byte {
	ret := make([]byte, 0, 10)
	ret = append(ret, "HPKE"...)
	ret = appendBigEndianUint16(ret, kemID)
	ret = appendBigEndianUint16(ret, kdfID)
	ret = appendBigEndianUint16(ret, aeadID)
	return ret
}

func newAEAD(aeadID uint16, key []byte) (cipher.AEAD, error) {
	if len(key) != expectedKeyLength(aeadID) {
		return nil, errors.New("wrong key length for specified AEAD")
	}
	switch aeadID {
	case AES128GCM, AES256GCM:
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		return aead, nil
	case ChaCha20Poly1305:
		aead, err := chacha20poly1305.New(key)
		if err != nil {
			return nil, err
		}
		return aead, nil
	}
	return nil, errors.New("unsupported AEAD")
}

func keySchedule(mode uint8, kemID, kdfID, aeadID uint16, sharedSecret, info, psk, pskID []byte) (*Context, error) {
	// Verify the PSK inputs.
	switch mode {
	case hpkeModeBase:
		if len(psk) > 0 || len(pskID) > 0 {
			panic("unnecessary psk inputs were provided")
		}
	case hpkeModePSK:
		if len(psk) == 0 || len(pskID) == 0 {
			panic("missing psk inputs")
		}
	default:
		panic("unknown mode")
	}

	kdfHash := getKDFHash(kdfID)
	suiteID := buildSuiteID(kemID, kdfID, aeadID)
	pskIDHash := labeledExtract(kdfHash, nil, suiteID, []byte("psk_id_hash"), pskID)
	infoHash := labeledExtract(kdfHash, nil, suiteID, []byte("info_hash"), info)

	keyScheduleContext := make([]byte, 0)
	keyScheduleContext = append(keyScheduleContext, mode)
	keyScheduleContext = append(keyScheduleContext, pskIDHash...)
	keyScheduleContext = append(keyScheduleContext, infoHash...)

	secret := labeledExtract(kdfHash, sharedSecret, suiteID, []byte("secret"), psk)
	key := labeledExpand(kdfHash, secret, suiteID, []byte("key"), keyScheduleContext, expectedKeyLength(aeadID))

	aead, err := newAEAD(aeadID, key)
	if err != nil {
		return nil, err
	}

	baseNonce := labeledExpand(kdfHash, secret, suiteID, []byte("base_nonce"), keyScheduleContext, aead.NonceSize())
	exporterSecret := labeledExpand(kdfHash, secret, suiteID, []byte("exp"), keyScheduleContext, kdfHash.Size())

	return &Context{
		kemID:          kemID,
		kdfID:          kdfID,
		aeadID:         aeadID,
		aead:           aead,
		key:            key,
		baseNonce:      baseNonce,
		seq:            0,
		exporterSecret: exporterSecret,
	}, nil
}

func (c Context) computeNonce() []byte {
	nonce := make([]byte, len(c.baseNonce))
	// Write the big-endian |c.seq| value at the *end* of |baseNonce|.
	binary.BigEndian.PutUint64(nonce[len(nonce)-8:], c.seq)
	// XOR the big-endian |seq| with |c.baseNonce|.
	for i, b := range c.baseNonce {
		nonce[i] ^= b
	}
	return nonce
}

func (c *Context) incrementSeq() {
	c.seq++
	if c.seq == 0 {
		panic("sequence overflow")
	}
}

func expectedKeyLength(aeadID uint16) int {
	switch aeadID {
	case AES128GCM:
		return 128 / 8
	case AES256GCM:
		return 256 / 8
	case ChaCha20Poly1305:
		return chacha20poly1305.KeySize
	}
	panic("unsupported AEAD")
}

func appendBigEndianUint16(b []byte, v uint16) []byte {
	return append(b, byte(v>>8), byte(v))
}
