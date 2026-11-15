// Copyright 2016 The BoringSSL Authors
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

package runner

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/asn1"
	"errors"
)

// TestShimTicketKey is the testing key assumed for the shim.
var TestShimTicketKey = make([]byte, 48)

func DecryptShimTicket(in []byte) ([]byte, error) {
	name := TestShimTicketKey[:16]
	macKey := TestShimTicketKey[16:32]
	encKey := TestShimTicketKey[32:48]

	h := hmac.New(sha256.New, macKey)

	block, err := aes.NewCipher(encKey)
	if err != nil {
		panic(err)
	}

	if len(in) < len(name)+block.BlockSize()+1+h.Size() {
		return nil, errors.New("tls: shim ticket too short")
	}

	// Check the key name.
	if !bytes.Equal(name, in[:len(name)]) {
		return nil, errors.New("tls: shim ticket name mismatch")
	}

	// Check the MAC at the end of the ticket.
	mac := in[len(in)-h.Size():]
	in = in[:len(in)-h.Size()]
	h.Write(in)
	if !hmac.Equal(mac, h.Sum(nil)) {
		return nil, errors.New("tls: shim ticket MAC mismatch")
	}

	// The MAC covers the key name, but the encryption does not.
	in = in[len(name):]

	// Decrypt in-place.
	iv := in[:block.BlockSize()]
	in = in[block.BlockSize():]
	if l := len(in); l == 0 || l%block.BlockSize() != 0 {
		return nil, errors.New("tls: ticket ciphertext not a multiple of the block size")
	}
	out := make([]byte, len(in))
	cbc := cipher.NewCBCDecrypter(block, iv)
	cbc.CryptBlocks(out, in)

	// Remove the padding.
	pad := int(out[len(out)-1])
	if pad == 0 || pad > block.BlockSize() || pad > len(in) {
		return nil, errors.New("tls: bad shim ticket CBC pad")
	}

	for i := 0; i < pad; i++ {
		if out[len(out)-1-i] != byte(pad) {
			return nil, errors.New("tls: bad shim ticket CBC pad")
		}
	}

	return out[:len(out)-pad], nil
}

func EncryptShimTicket(in []byte) []byte {
	name := TestShimTicketKey[:16]
	macKey := TestShimTicketKey[16:32]
	encKey := TestShimTicketKey[32:48]

	h := hmac.New(sha256.New, macKey)

	block, err := aes.NewCipher(encKey)
	if err != nil {
		panic(err)
	}

	// Use the zero IV for rewritten tickets.
	iv := make([]byte, block.BlockSize())
	cbc := cipher.NewCBCEncrypter(block, iv)
	pad := block.BlockSize() - (len(in) % block.BlockSize())

	out := make([]byte, 0, len(name)+len(iv)+len(in)+pad+h.Size())
	out = append(out, name...)
	out = append(out, iv...)
	out = append(out, in...)
	for i := 0; i < pad; i++ {
		out = append(out, byte(pad))
	}

	ciphertext := out[len(name)+len(iv):]
	cbc.CryptBlocks(ciphertext, ciphertext)

	h.Write(out)
	return h.Sum(out)
}

const asn1Constructed = 0x20

func parseDERElement(in []byte) (tag byte, body, rest []byte, ok bool) {
	rest = in
	if len(rest) < 1 {
		return
	}

	tag = rest[0]
	rest = rest[1:]

	if tag&0x1f == 0x1f {
		// Long-form tags not supported.
		return
	}

	if len(rest) < 1 {
		return
	}

	length := int(rest[0])
	rest = rest[1:]
	if length > 0x7f {
		lengthLength := length & 0x7f
		length = 0
		if lengthLength == 0 {
			// No indefinite-length encoding.
			return
		}

		// Decode long-form lengths.
		for lengthLength > 0 {
			if len(rest) < 1 || (length<<8)>>8 != length {
				return
			}
			if length == 0 && rest[0] == 0 {
				// Length not minimally-encoded.
				return
			}
			length <<= 8
			length |= int(rest[0])
			rest = rest[1:]
			lengthLength--
		}

		if length < 0x80 {
			// Length not minimally-encoded.
			return
		}
	}

	if len(rest) < length {
		return
	}

	body = rest[:length]
	rest = rest[length:]
	ok = true
	return
}

func SetShimTicketVersion(in []byte, vers uint16) ([]byte, error) {
	plaintext, err := DecryptShimTicket(in)
	if err != nil {
		return nil, err
	}

	tag, session, _, ok := parseDERElement(plaintext)
	if !ok || tag != asn1.TagSequence|asn1Constructed {
		return nil, errors.New("tls: could not decode shim session")
	}

	// Skip the session version.
	tag, _, session, ok = parseDERElement(session)
	if !ok || tag != asn1.TagInteger {
		return nil, errors.New("tls: could not decode shim session")
	}

	// Next field is the protocol version.
	tag, version, _, ok := parseDERElement(session)
	if !ok || tag != asn1.TagInteger {
		return nil, errors.New("tls: could not decode shim session")
	}

	// This code assumes both old and new versions are encoded in two
	// bytes. This isn't quite right as INTEGERs are minimally-encoded, but
	// we do not need to support other caess for now.
	if len(version) != 2 || vers < 0x80 || vers >= 0x8000 {
		return nil, errors.New("tls: unsupported version in shim session")
	}

	version[0] = byte(vers >> 8)
	version[1] = byte(vers)

	return EncryptShimTicket(plaintext), nil
}

func SetShimTicketCipherSuite(in []byte, id uint16) ([]byte, error) {
	plaintext, err := DecryptShimTicket(in)
	if err != nil {
		return nil, err
	}

	tag, session, _, ok := parseDERElement(plaintext)
	if !ok || tag != asn1.TagSequence|asn1Constructed {
		return nil, errors.New("tls: could not decode shim session")
	}

	// Skip the session version.
	tag, _, session, ok = parseDERElement(session)
	if !ok || tag != asn1.TagInteger {
		return nil, errors.New("tls: could not decode shim session")
	}

	// Skip the protocol version.
	tag, _, session, ok = parseDERElement(session)
	if !ok || tag != asn1.TagInteger {
		return nil, errors.New("tls: could not decode shim session")
	}

	// Next field is the cipher suite.
	tag, cipherSuite, _, ok := parseDERElement(session)
	if !ok || tag != asn1.TagOctetString || len(cipherSuite) != 2 {
		return nil, errors.New("tls: could not decode shim session")
	}

	cipherSuite[0] = byte(id >> 8)
	cipherSuite[1] = byte(id)

	return EncryptShimTicket(plaintext), nil
}
