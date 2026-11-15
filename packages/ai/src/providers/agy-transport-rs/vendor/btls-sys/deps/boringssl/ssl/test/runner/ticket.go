// Copyright 2012 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"time"

	"golang.org/x/crypto/cryptobyte"
)

// sessionState contains the information that is serialized into a session
// ticket in order to later resume a connection.
type sessionState struct {
	vers                        uint16
	cipherSuite                 uint16
	secret                      []byte
	handshakeHash               []byte
	certificates                [][]byte
	extendedMasterSecret        bool
	earlyALPN                   []byte
	ticketCreationTime          time.Time
	ticketExpiration            time.Time
	ticketFlags                 uint32
	ticketAgeAdd                uint32
	hasApplicationSettings      bool
	localApplicationSettings    []byte
	peerApplicationSettings     []byte
	hasApplicationSettingsOld   bool
	localApplicationSettingsOld []byte
	peerApplicationSettingsOld  []byte
}

func (s *sessionState) marshal() []byte {
	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint16(s.vers)
	msg.AddUint16(s.cipherSuite)
	addUint16LengthPrefixedBytes(msg, s.secret)
	addUint16LengthPrefixedBytes(msg, s.handshakeHash)
	msg.AddUint16(uint16(len(s.certificates)))
	for _, cert := range s.certificates {
		addUint24LengthPrefixedBytes(msg, cert)
	}

	if s.extendedMasterSecret {
		msg.AddUint8(1)
	} else {
		msg.AddUint8(0)
	}

	if s.vers >= VersionTLS13 {
		msg.AddUint64(uint64(s.ticketCreationTime.UnixNano()))
		msg.AddUint64(uint64(s.ticketExpiration.UnixNano()))
		msg.AddUint32(s.ticketFlags)
		msg.AddUint32(s.ticketAgeAdd)
	}

	addUint16LengthPrefixedBytes(msg, s.earlyALPN)

	if s.hasApplicationSettings {
		msg.AddUint8(1)
		addUint16LengthPrefixedBytes(msg, s.localApplicationSettings)
		addUint16LengthPrefixedBytes(msg, s.peerApplicationSettings)
	} else {
		msg.AddUint8(0)
	}

	if s.hasApplicationSettingsOld {
		msg.AddUint8(1)
		addUint16LengthPrefixedBytes(msg, s.localApplicationSettingsOld)
		addUint16LengthPrefixedBytes(msg, s.peerApplicationSettingsOld)
	} else {
		msg.AddUint8(0)
	}

	return msg.BytesOrPanic()
}

func readBool(reader *cryptobyte.String, out *bool) bool {
	var value uint8
	if !reader.ReadUint8(&value) {
		return false
	}
	if value == 0 {
		*out = false
		return true
	}
	if value == 1 {
		*out = true
		return true
	}
	return false
}

func (s *sessionState) unmarshal(data []byte) bool {
	reader := cryptobyte.String(data)
	var numCerts uint16
	if !reader.ReadUint16(&s.vers) ||
		!reader.ReadUint16(&s.cipherSuite) ||
		!readUint16LengthPrefixedBytes(&reader, &s.secret) ||
		!readUint16LengthPrefixedBytes(&reader, &s.handshakeHash) ||
		!reader.ReadUint16(&numCerts) {
		return false
	}

	s.certificates = make([][]byte, int(numCerts))
	for i := range s.certificates {
		if !readUint24LengthPrefixedBytes(&reader, &s.certificates[i]) {
			return false
		}
	}

	if !readBool(&reader, &s.extendedMasterSecret) {
		return false
	}

	if s.vers >= VersionTLS13 {
		var ticketCreationTime, ticketExpiration uint64
		if !reader.ReadUint64(&ticketCreationTime) ||
			!reader.ReadUint64(&ticketExpiration) ||
			!reader.ReadUint32(&s.ticketFlags) ||
			!reader.ReadUint32(&s.ticketAgeAdd) {
			return false
		}
		s.ticketCreationTime = time.Unix(0, int64(ticketCreationTime))
		s.ticketExpiration = time.Unix(0, int64(ticketExpiration))
	}

	if !readUint16LengthPrefixedBytes(&reader, &s.earlyALPN) ||
		!readBool(&reader, &s.hasApplicationSettings) {
		return false
	}

	if s.hasApplicationSettings {
		if !readUint16LengthPrefixedBytes(&reader, &s.localApplicationSettings) ||
			!readUint16LengthPrefixedBytes(&reader, &s.peerApplicationSettings) {
			return false
		}
	}

	if !readBool(&reader, &s.hasApplicationSettingsOld) {
		return false
	}

	if s.hasApplicationSettingsOld {
		if !readUint16LengthPrefixedBytes(&reader, &s.localApplicationSettingsOld) ||
			!readUint16LengthPrefixedBytes(&reader, &s.peerApplicationSettingsOld) {
			return false
		}
	}

	if len(reader) > 0 {
		return false
	}

	return true
}

func (c *Conn) encryptTicket(state *sessionState) ([]byte, error) {
	key := c.config.SessionTicketKey[:]
	if c.config.Bugs.EncryptSessionTicketKey != nil {
		key = c.config.Bugs.EncryptSessionTicketKey[:]
	}

	serialized := state.marshal()
	encrypted := make([]byte, aes.BlockSize+len(serialized)+sha256.Size)
	iv := encrypted[:aes.BlockSize]
	macBytes := encrypted[len(encrypted)-sha256.Size:]

	if _, err := io.ReadFull(c.config.rand(), iv); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key[:16])
	if err != nil {
		return nil, errors.New("tls: failed to create cipher while encrypting ticket: " + err.Error())
	}
	cipher.NewCTR(block, iv).XORKeyStream(encrypted[aes.BlockSize:], serialized)

	mac := hmac.New(sha256.New, key[16:32])
	mac.Write(encrypted[:len(encrypted)-sha256.Size])
	mac.Sum(macBytes[:0])

	return encrypted, nil
}

func (c *Conn) decryptTicket(encrypted []byte) (*sessionState, bool) {
	if len(encrypted) < aes.BlockSize+sha256.Size {
		return nil, false
	}

	iv := encrypted[:aes.BlockSize]
	macBytes := encrypted[len(encrypted)-sha256.Size:]

	mac := hmac.New(sha256.New, c.config.SessionTicketKey[16:32])
	mac.Write(encrypted[:len(encrypted)-sha256.Size])
	expected := mac.Sum(nil)

	if subtle.ConstantTimeCompare(macBytes, expected) != 1 {
		return nil, false
	}

	block, err := aes.NewCipher(c.config.SessionTicketKey[:16])
	if err != nil {
		return nil, false
	}
	ciphertext := encrypted[aes.BlockSize : len(encrypted)-sha256.Size]
	plaintext := make([]byte, len(ciphertext))
	cipher.NewCTR(block, iv).XORKeyStream(plaintext, ciphertext)

	state := new(sessionState)
	ok := state.unmarshal(plaintext)
	return state, ok
}
