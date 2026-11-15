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

package runner

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
)

type encryptionLevel byte

const (
	encryptionInitial     encryptionLevel = 0
	encryptionEarlyData   encryptionLevel = 1
	encryptionHandshake   encryptionLevel = 2
	encryptionApplication encryptionLevel = 3
)

func (e encryptionLevel) String() string {
	switch e {
	case encryptionInitial:
		return "initial"
	case encryptionEarlyData:
		return "early data"
	case encryptionHandshake:
		return "handshake"
	case encryptionApplication:
		return "application"
	}
	return fmt.Sprintf("unknown level (%d)", e)
}

// mockQUICTransport provides a record layer for sending/receiving messages
// when testing TLS over QUIC. It is only intended for testing, as it runs over
// an in-order reliable transport, looks nothing like the QUIC wire image, and
// provides no confidentiality guarantees. (In fact, it leaks keys in the
// clear.)
//
// Messages from TLS that are sent over a mockQUICTransport are a series of
// records in the following format:
//
//	enum {
//	    initial(0), early_data(1), handshake(2), application(3), (255)
//	} EncryptionLevel;
//
//	struct {
//	    ContentType record_type;
//	    EncryptionLevel level;
//	    CipherSuite cipher_suite;
//	    opaque encrypted_record<0..2^32-1>;
//	} MockQUICRecord;
//
// The "encrypted" record is the concatenation of the encryption key and
// plaintext. It and the cipher suite exist only to check both sides agree on
// encryption parameters. The key is included in the length prefix so records
// may be skipped without knowing the key length.
type mockQUICTransport struct {
	net.Conn
	readLevel, writeLevel             encryptionLevel
	readSecret, writeSecret           []byte
	readCipherSuite, writeCipherSuite uint16
	skipEarlyData                     bool
}

func newMockQUICTransport(conn net.Conn) *mockQUICTransport {
	return &mockQUICTransport{Conn: conn}
}

func (m *mockQUICTransport) read() (recordType, []byte, error) {
	for {
		header := make([]byte, 8)
		if _, err := io.ReadFull(m.Conn, header); err != nil {
			return 0, nil, err
		}
		typ := recordType(header[0])
		level := encryptionLevel(header[1])
		cipherSuite := binary.BigEndian.Uint16(header[2:4])
		length := binary.BigEndian.Uint32(header[4:])
		value := make([]byte, length)
		if _, err := io.ReadFull(m.Conn, value); err != nil {
			return 0, nil, fmt.Errorf("error reading record")
		}
		if level != m.readLevel {
			if m.skipEarlyData && level == encryptionEarlyData {
				continue
			}
			return 0, nil, fmt.Errorf("received record at %s encryption level, but expected %s", level, m.readLevel)
		}
		if cipherSuite != m.readCipherSuite {
			return 0, nil, fmt.Errorf("received cipher suite %d does not match expected %d", cipherSuite, m.readCipherSuite)
		}
		if len(m.readSecret) > len(value) {
			return 0, nil, fmt.Errorf("input length too short")
		}
		secret := value[:len(m.readSecret)]
		out := value[len(m.readSecret):]
		if !bytes.Equal(secret, m.readSecret) {
			return 0, nil, fmt.Errorf("secrets don't match: got %x but expected %x", secret, m.readSecret)
		}
		// Although not true for QUIC in general, our transport is ordered, so
		// we expect to stop skipping early data after a valid record.
		m.skipEarlyData = false
		return typ, out, nil
	}
}

func (m *mockQUICTransport) readRecord(want recordType) (recordType, []byte, error) {
	return m.read()
}

func (m *mockQUICTransport) writeRecord(typ recordType, data []byte) (int, error) {
	if typ != recordTypeApplicationData && typ != recordTypeHandshake {
		return 0, fmt.Errorf("unsupported record type %d\n", typ)
	}
	length := len(m.writeSecret) + len(data)
	payload := make([]byte, 1+1+2+4+length)
	payload[0] = byte(typ)
	payload[1] = byte(m.writeLevel)
	binary.BigEndian.PutUint16(payload[2:4], m.writeCipherSuite)
	binary.BigEndian.PutUint32(payload[4:8], uint32(length))
	copy(payload[8:], m.writeSecret)
	copy(payload[8+len(m.writeSecret):], data)
	if _, err := m.Conn.Write(payload); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (m *mockQUICTransport) Write(b []byte) (int, error) {
	panic("unexpected call to Write")
}

func (m *mockQUICTransport) Read(b []byte) (int, error) {
	panic("unexpected call to Read")
}
