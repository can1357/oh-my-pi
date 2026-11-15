// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// TLS low level connection and record layer

package runner

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/subtle"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/cryptobyte"
)

type dtlsRecordInfo struct {
	typ   recordType
	epoch uint16
	// bytesAvailable is the number of additional bytes of plaintext that could
	// have been added to this record without exceeding the packet limit.
	bytesAvailable int
}

// A Conn represents a secured connection.
// It implements the net.Conn interface.
type Conn struct {
	// constant
	conn     net.Conn
	isDTLS   bool
	isClient bool

	// constant after handshake; protected by handshakeMutex
	handshakeMutex          sync.Mutex // handshakeMutex < in.Mutex, out.Mutex, errMutex
	handshakeErr            error      // error resulting from handshake
	wireVersion             uint16     // TLS wire version
	vers                    uint16     // TLS version
	haveVers                bool       // version has been negotiated
	config                  *Config    // configuration passed to constructor
	handshakeComplete       bool
	skipEarlyData           bool // On a server, indicates that the client is sending early data that must be skipped over.
	didResume               bool // whether this connection was a session resumption
	extendedMasterSecret    bool // whether this session used an extended master secret
	cipherSuite             *cipherSuite
	ocspResponse            []byte // stapled OCSP response
	sctList                 []byte // signed certificate timestamp list
	peerCertificates        []*x509.Certificate
	peerDelegatedCredential []byte
	// verifiedChains contains the certificate chains that we built, as
	// opposed to the ones presented by the server.
	verifiedChains [][]*x509.Certificate
	// serverName contains the server name indicated by the client, if any.
	serverName    string
	serverNameAck bool
	// firstFinished contains the first Finished hash sent during the
	// handshake. This is the "tls-unique" channel binding value.
	firstFinished [12]byte
	// peerSignatureAlgorithm contains the signature algorithm that was used
	// by the peer in the handshake, or zero if not applicable.
	peerSignatureAlgorithm signatureAlgorithm
	// curveID contains the curve that was used in the handshake, or zero if
	// not applicable.
	curveID CurveID
	// quicTransportParams contains the QUIC transport params received
	// by the peer using codepoint 57.
	quicTransportParams []byte
	// quicTransportParams contains the QUIC transport params received
	// by the peer using legacy codepoint 0xffa5.
	quicTransportParamsLegacy []byte

	clientRandom, serverRandom [32]byte
	earlyExporterSecret        []byte
	exporterSecret             []byte
	resumptionSecret           []byte

	clientProtocol         string
	clientProtocolFallback bool
	usedALPN               bool

	localApplicationSettings, peerApplicationSettings       []byte
	hasApplicationSettings                                  bool
	localApplicationSettingsOld, peerApplicationSettingsOld []byte
	hasApplicationSettingsOld                               bool

	// verify_data values for the renegotiation extension.
	clientVerify []byte
	serverVerify []byte

	channelID *ecdsa.PublicKey

	srtpProtectionProfile uint16

	clientVersion uint16

	// input/output
	in, out  halfConn     // in.Mutex < out.Mutex
	rawInput bytes.Buffer // raw input, right off the wire
	input    bytes.Buffer // application record waiting to be read
	hand     bytes.Buffer // handshake record waiting to be read

	// pendingFlight, if PackHandshakeFlight is enabled, is the buffer of
	// handshake data to be split into records at the end of the flight.
	pendingFlight bytes.Buffer

	// DTLS state
	sendHandshakeSeq uint16
	recvHandshakeSeq uint16
	handMsg          []byte // pending assembled handshake message
	handMsgLen       int    // handshake message length, not including the header
	pendingPacket    []byte // pending outgoing packet.
	maxPacketLen     int

	previousFlight        []DTLSMessage
	receivedFlight        []DTLSMessage
	receivedFlightRecords []DTLSRecordNumberInfo
	nextFlight            []DTLSMessage
	expectedACK           []DTLSRecordNumber

	keyUpdateSeen      bool
	keyUpdateRequested bool
	seenOneByteRecord  bool

	expectTLS13ChangeCipherSpec bool

	// seenHandshakePackEnd is whether the most recent handshake record was
	// not full for ExpectPackedEncryptedHandshake. If true, no more
	// handshake data may be received until the next flight or epoch change.
	seenHandshakePackEnd bool

	// lastRecordInFlight contains information about the previous handshake or
	// ChangeCipherSpec record from the current flight, or nil if we are not in
	// the middle of reading a flight from the peer.
	lastRecordInFlight *dtlsRecordInfo

	// bytesAvailableInPacket is the number of bytes that were still available
	// in the current DTLS packet, up to a budget of maxPacketLen.
	bytesAvailableInPacket int

	// skipRecordVersionCheck, if true, causes the DTLS record layer to skip the
	// record version check, even if the version is known. This is used when
	// simulating retransmits.
	skipRecordVersionCheck bool

	// echAccepted indicates whether ECH was accepted for this connection.
	echAccepted bool

	tmp [16]byte
}

func (c *Conn) init() {
	c.in.isDTLS = c.isDTLS
	c.out.isDTLS = c.isDTLS
	c.in.config = c.config
	c.out.config = c.config
	c.in.conn = c
	c.out.conn = c
	c.maxPacketLen = c.config.Bugs.MaxPacketLength
}

// Access to net.Conn methods.
// Cannot just embed net.Conn because that would
// export the struct field too.

// LocalAddr returns the local network address.
func (c *Conn) LocalAddr() net.Addr {
	return c.conn.LocalAddr()
}

// RemoteAddr returns the remote network address.
func (c *Conn) RemoteAddr() net.Addr {
	return c.conn.RemoteAddr()
}

// SetDeadline sets the read and write deadlines associated with the connection.
// A zero value for t means Read and Write will not time out.
// After a Write has timed out, the TLS state is corrupt and all future writes will return the same error.
func (c *Conn) SetDeadline(t time.Time) error {
	return c.conn.SetDeadline(t)
}

// SetReadDeadline sets the read deadline on the underlying connection.
// A zero value for t means Read will not time out.
func (c *Conn) SetReadDeadline(t time.Time) error {
	return c.conn.SetReadDeadline(t)
}

// SetWriteDeadline sets the write deadline on the underlying connection.
// A zero value for t means Write will not time out.
// After a Write has timed out, the TLS state is corrupt and all future writes will return the same error.
func (c *Conn) SetWriteDeadline(t time.Time) error {
	return c.conn.SetWriteDeadline(t)
}

// Arbitrarily cap the number of past epochs to 4. This is far more than is
// necessary. We set a limit only so tests can freely trigger unboundedly many
// KeyUpdates.
const maxEpochs = 4

type epochState struct {
	epoch                 uint16
	cipher                any // cipher algorithm
	recordNumberEncrypter recordNumberEncrypter
	mac                   macFunction
	seq                   [8]byte
}

// A halfConn represents one direction of the record layer
// connection, either sending or receiving.
type halfConn struct {
	sync.Mutex

	err         error  // first permanent error
	version     uint16 // protocol version
	wireVersion uint16 // wire version
	isDTLS      bool
	epoch       epochState
	pastEpochs  []epochState

	nextEpoch epochState

	// used to save allocating a new buffer for each MAC.
	macBuf []byte

	trafficSecret []byte

	config *Config
	conn   *Conn
}

func (hc *halfConn) setErrorLocked(err error) error {
	hc.err = err
	return err
}

func (hc *halfConn) error() error {
	// This should be locked, but I've removed it for the renegotiation
	// tests since we don't concurrently read and write the same tls.Conn
	// in any case during testing.
	err := hc.err
	return err
}

func (hc *halfConn) getEpoch(epochValue uint16) (*epochState, bool) {
	if hc.epoch.epoch == epochValue {
		return &hc.epoch, true
	}
	for i := range hc.pastEpochs {
		if hc.pastEpochs[i].epoch == epochValue {
			return &hc.pastEpochs[i], true
		}
	}
	return nil, false
}

func (hc *halfConn) changeEpoch(epoch epochState) {
	if len(hc.pastEpochs) < maxEpochs {
		hc.pastEpochs = append(hc.pastEpochs, hc.epoch)
	} else {
		for i := 1; i < len(hc.pastEpochs); i++ {
			hc.pastEpochs[i-1] = hc.pastEpochs[i]
		}
		hc.pastEpochs[len(hc.pastEpochs)-1] = hc.epoch
	}
	hc.epoch = epoch
}

func (hc *halfConn) newEpochState(epoch uint16, cipher any, mac macFunction) epochState {
	ret := epochState{epoch: epoch, cipher: cipher, mac: mac}
	if hc.isDTLS {
		binary.BigEndian.PutUint16(ret.seq[:2], epoch)
	}
	return ret
}

// prepareCipherSpec sets the encryption and MAC states
// that a subsequent changeCipherSpec will use.
func (hc *halfConn) prepareCipherSpec(version uint16, cipher any, mac macFunction) {
	hc.wireVersion = version
	protocolVersion, ok := wireToVersion(version, hc.isDTLS)
	if !ok {
		panic("TLS: unknown version")
	}
	hc.version = protocolVersion
	epoch := hc.epoch.epoch + 1
	if epoch == 0 {
		panic("TLS: epoch overflow")
	}
	hc.nextEpoch = hc.newEpochState(epoch, cipher, mac)
}

// changeCipherSpec changes the encryption and MAC states
// to the ones previously passed to prepareCipherSpec.
func (hc *halfConn) changeCipherSpec() error {
	if hc.nextEpoch.cipher == nil {
		return alertInternalError
	}
	hc.changeEpoch(hc.nextEpoch)
	hc.nextEpoch = epochState{}

	if hc.config.Bugs.NullAllCiphers {
		hc.epoch.cipher = nullCipher{}
		hc.epoch.mac = nil
	}
	return nil
}

// useTrafficSecret sets the current cipher state for TLS 1.3.
func (hc *halfConn) useTrafficSecret(version uint16, suite *cipherSuite, secret []byte, side trafficDirection, epoch uint16) {
	hc.wireVersion = version
	protocolVersion, ok := wireToVersion(version, hc.isDTLS)
	if !ok {
		panic("TLS: unknown version")
	}
	hc.version = protocolVersion
	newEpoch := hc.newEpochState(epoch, deriveTrafficAEAD(version, suite, secret, side, hc.isDTLS), nil)
	if hc.isDTLS && !hc.config.Bugs.NullAllCiphers {
		sn_key := hkdfExpandLabel(suite.hash(), secret, []byte("sn"), nil, suite.keyLen, hc.isDTLS)
		switch suite.id {
		case TLS_CHACHA20_POLY1305_SHA256:
			newEpoch.recordNumberEncrypter = newChachaRecordNumberEncrypter(sn_key)
		case TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384:
			newEpoch.recordNumberEncrypter = newAESRecordNumberEncrypter(sn_key)
		default:
			panic("Cipher suite does not support TLS 1.3")
		}
	}
	if hc.config.Bugs.NullAllCiphers {
		newEpoch.cipher = nullCipher{}
	}
	hc.trafficSecret = secret
	hc.changeEpoch(newEpoch)
}

// resetCipher resets the cipher state back to no encryption to be able
// to send an unencrypted ClientHello in response to HelloRetryRequest
// after 0-RTT data was rejected.
func (hc *halfConn) resetCipher() {
	initialEpoch, ok := hc.getEpoch(0)
	if !ok {
		panic("tls: could not find initial epoch")
	}
	hc.epoch = *initialEpoch
	hc.pastEpochs = nil
}

// incSeq increments the sequence number.
func (hc *halfConn) incSeq(epoch *epochState) {
	limit := 0
	increment := uint64(1)
	if hc.isDTLS {
		// Increment up to the epoch in DTLS.
		limit = 2
	}
	for i := 7; i >= limit; i-- {
		increment += uint64(epoch.seq[i])
		epoch.seq[i] = byte(increment)
		increment >>= 8
	}

	// Not allowed to let sequence number wrap.
	// Instead, must renegotiate before it does.
	// Not likely enough to bother.
	if increment != 0 {
		panic("TLS: sequence number wraparound")
	}
}

// lastRecordNumber returns the most recent record number decrypted or encrypted
// on a halfConn.
//
// TODO(crbug.com/376641666): This function is a bit hacky. It needs to rewind
// the state back to what the last call actually used. Fix the TLS/DTLS
// abstractions so we can return this value out directly.
func (hc *halfConn) lastRecordNumber(epoch *epochState, isOut bool) DTLSRecordNumber {
	seq := binary.BigEndian.Uint64(epoch.seq[:])
	// We maintain the next record number, so undo the increment.
	if seq&(1<<48-1) == 0 {
		panic("tls: epoch has never been used")
	}
	seq--
	if hc.isDTLS {
		if isOut && hc.config.Bugs.SequenceNumberMapping != nil {
			seq = hc.config.Bugs.SequenceNumberMapping(seq)
		}
		// Remove the embedded epoch number.
		seq &= 1<<48 - 1
	}
	return DTLSRecordNumber{Epoch: uint64(epoch.epoch), Sequence: seq}
}

func (hc *halfConn) sequenceNumberForOutput(epoch *epochState) []byte {
	if !hc.isDTLS || hc.config.Bugs.SequenceNumberMapping == nil {
		return epoch.seq[:]
	}

	var seq [8]byte
	seqU64 := binary.BigEndian.Uint64(epoch.seq[:])
	seqU64 = hc.config.Bugs.SequenceNumberMapping(seqU64)
	binary.BigEndian.PutUint64(seq[:], seqU64)
	// The DTLS epoch cannot be changed.
	copy(seq[:2], epoch.seq[:2])
	return seq[:]
}

func (hc *halfConn) explicitIVLen(epoch *epochState) int {
	if epoch.cipher == nil {
		return 0
	}
	switch c := epoch.cipher.(type) {
	case cipher.Stream:
		return 0
	case *tlsAead:
		if c.explicitNonce {
			return 8
		}
		return 0
	case *cbcMode:
		if hc.version >= VersionTLS11 || hc.isDTLS {
			return c.BlockSize()
		}
		return 0
	case nullCipher:
		return 0
	default:
		panic("unknown cipher type")
	}
}

func (hc *halfConn) computeMAC(epoch *epochState, seq, header, data []byte) []byte {
	hc.macBuf = epoch.mac.MAC(hc.macBuf[:0], seq, header[:3], header[len(header)-2:], data)
	return hc.macBuf
}

// removePadding returns an unpadded slice, in constant time, which is a prefix
// of the input. It also returns a byte which is equal to 255 if the padding
// was valid and 0 otherwise. See RFC 2246, section 6.2.3.2
func removePadding(payload []byte) ([]byte, byte) {
	if len(payload) < 1 {
		return payload, 0
	}

	paddingLen := payload[len(payload)-1]
	t := uint(len(payload)-1) - uint(paddingLen)
	// if len(payload) >= (paddingLen - 1) then the MSB of t is zero
	good := byte(int32(^t) >> 31)

	toCheck := 255 // the maximum possible padding length
	// The length of the padded data is public, so we can use an if here
	if toCheck+1 > len(payload) {
		toCheck = len(payload) - 1
	}

	for i := 0; i < toCheck; i++ {
		t := uint(paddingLen) - uint(i)
		// if i <= paddingLen then the MSB of t is zero
		mask := byte(int32(^t) >> 31)
		b := payload[len(payload)-1-i]
		good &^= mask&paddingLen ^ mask&b
	}

	// We AND together the bits of good and replicate the result across
	// all the bits.
	good &= good << 4
	good &= good << 2
	good &= good << 1
	good = uint8(int8(good) >> 7)

	toRemove := good&paddingLen + 1
	return payload[:len(payload)-int(toRemove)], good
}

func roundUp(a, b int) int {
	return a + (b-a%b)%b
}

// decrypt checks and strips the mac and decrypts the data in record. Returns a
// success boolean, the application payload, the encrypted record type (or 0
// if there is none), and an optional alert value. Decryption occurs in-place,
// so the contents of record will be overwritten as part of this process.
func (hc *halfConn) decrypt(epoch *epochState, recordHeaderLen int, record []byte) (ok bool, contentType recordType, data []byte, alertValue alert) {
	// pull out payload
	payload := record[recordHeaderLen:]

	macSize := 0
	if epoch.mac != nil {
		macSize = epoch.mac.Size()
	}

	paddingGood := byte(255)
	explicitIVLen := hc.explicitIVLen(epoch)

	// decrypt
	if epoch.cipher != nil {
		switch c := epoch.cipher.(type) {
		case cipher.Stream:
			c.XORKeyStream(payload, payload)
		case *tlsAead:
			nonce := epoch.seq[:]
			if hc.isDTLS && hc.version >= VersionTLS13 && !hc.conn.useDTLSPlaintextHeader() {
				// Unlike DTLS 1.2, DTLS 1.3's nonce construction does not use
				// the epoch number. We store the epoch and nonce numbers
				// together, so make a copy without the epoch.
				nonce = make([]byte, 8)
				copy(nonce[2:], epoch.seq[2:])
			}

			if explicitIVLen != 0 {
				if len(payload) < explicitIVLen {
					return false, 0, nil, alertBadRecordMAC
				}
				nonce = payload[:explicitIVLen]
				payload = payload[explicitIVLen:]
			}

			var additionalData []byte
			if hc.version < VersionTLS13 {
				additionalData = make([]byte, 13)
				copy(additionalData, epoch.seq[:])
				copy(additionalData[8:], record[:3])
				n := len(payload) - c.Overhead()
				additionalData[11] = byte(n >> 8)
				additionalData[12] = byte(n)
			} else {
				additionalData = record[:recordHeaderLen]
			}
			var err error
			payload, err = c.Open(payload[:0], nonce, payload, additionalData)
			if err != nil {
				return false, 0, nil, alertBadRecordMAC
			}
		case *cbcMode:
			blockSize := c.BlockSize()
			if len(payload)%blockSize != 0 || len(payload) < roundUp(explicitIVLen+macSize+1, blockSize) {
				return false, 0, nil, alertBadRecordMAC
			}

			if explicitIVLen > 0 {
				c.SetIV(payload[:explicitIVLen])
				payload = payload[explicitIVLen:]
			}
			c.CryptBlocks(payload, payload)
			payload, paddingGood = removePadding(payload)

			// note that we still have a timing side-channel in the
			// MAC check, below. An attacker can align the record
			// so that a correct padding will cause one less hash
			// block to be calculated. Then they can iteratively
			// decrypt a record by breaking each byte. See
			// "Password Interception in a SSL/TLS Channel", Brice
			// Canvel et al.
			//
			// However, our behavior matches OpenSSL, so we leak
			// only as much as they do.
		case nullCipher:
			break
		default:
			panic("unknown cipher type")
		}

		if hc.version >= VersionTLS13 {
			i := len(payload)
			for i > 0 && payload[i-1] == 0 {
				i--
			}
			payload = payload[:i]
			if len(payload) == 0 {
				return false, 0, nil, alertUnexpectedMessage
			}
			contentType = recordType(payload[len(payload)-1])
			payload = payload[:len(payload)-1]
		}
	}

	// check, strip mac
	if epoch.mac != nil {
		if len(payload) < macSize {
			return false, 0, nil, alertBadRecordMAC
		}

		// strip mac off payload
		n := len(payload) - macSize
		remoteMAC := payload[n:]
		payload = payload[:n]
		record[recordHeaderLen-2] = byte(n >> 8)
		record[recordHeaderLen-1] = byte(n)
		localMAC := hc.computeMAC(epoch, epoch.seq[:], record[:recordHeaderLen], payload)
		if subtle.ConstantTimeCompare(localMAC, remoteMAC) != 1 || paddingGood != 255 {
			return false, 0, nil, alertBadRecordMAC
		}
	}
	hc.incSeq(epoch)

	return true, contentType, payload, 0
}

// extendSlice updates *data to contain n more bytes and returns a slice
// containing the bytes that were added.
func extendSlice(data *[]byte, n int) []byte {
	// Reallocate the slice if needed.
	*data = slices.Grow(*data, n)
	// Extend data into the capacity and return the newly added slice.
	oldLen := len(*data)
	newLen := oldLen + n
	*data = (*data)[:newLen]
	return (*data)[oldLen:newLen]
}

// computingCBCPaddingLength returns the number of bytes of CBC padding to use
// for a payload (plaintext + MAC) of length payloadLen.
func computingCBCPaddingLength(payloadLen, blockSize int, config *Config) int {
	paddingLen := blockSize - payloadLen%blockSize
	if config.Bugs.MaxPadding {
		for paddingLen+blockSize <= 256 {
			paddingLen += blockSize
		}
	}
	return paddingLen
}

// appendCBCPadding computes paddingLen bytes of padding data, appends it to b,
// and returns the result.
func appendCBCPadding(b []byte, paddingLen int, config *Config) []byte {
	padding := extendSlice(&b, paddingLen)
	for i := range padding {
		padding[i] = byte(paddingLen - 1)
	}
	if config.Bugs.PaddingFirstByteBad || config.Bugs.PaddingFirstByteBadIf255 && paddingLen == 256 {
		padding[0] ^= 0xff
	}
	return b
}

func (hc *halfConn) maxEncryptOverhead(epoch *epochState, payloadLen int) int {
	var macSize int
	if epoch.mac != nil {
		macSize = epoch.mac.Size()
	}
	overhead := macSize + hc.explicitIVLen(epoch)
	if hc.version >= VersionTLS13 {
		overhead += 1 + hc.config.Bugs.RecordPadding // type + padding
	}
	if epoch.cipher != nil {
		switch c := epoch.cipher.(type) {
		case cipher.Stream, *nullCipher:
		case *tlsAead:
			overhead += c.Overhead()
		case *cbcMode:
			overhead += computingCBCPaddingLength(payloadLen+macSize, c.BlockSize(), hc.config)
		case nullCipher:
			break
		default:
			panic("unknown cipher type")
		}
	}
	return overhead
}

func (c *Conn) useDTLSPlaintextHeader() bool {
	return c.config.Bugs.DTLSUsePlaintextRecordHeader && c.handshakeComplete
}

// encrypt encrypts and MACs the data in payload, appending it record. On
// entry, the last headerLen bytes of record must be the header. The length
// (which must be in the last two bytes of the header) should be computed for
// the unencrypted, unpadded payload. It will be updated, potentially in-place,
// with the final length.
func (hc *halfConn) encrypt(epoch *epochState, record, payload []byte, typ recordType, headerLen int, headerHasLength bool) ([]byte, error) {
	seq := hc.sequenceNumberForOutput(epoch)
	prefixLen := len(record)
	header := record[prefixLen-headerLen:]
	explicitIVLen := hc.explicitIVLen(epoch)

	// Reserve some space for the explicit IV. The slice may get reallocated
	// after this, so don't use the return value.
	extendSlice(&record, explicitIVLen)

	// Stage the plaintext, TLS 1.3 padding, and TLS 1.2 MAC in the record, to
	// be encrypted in-place.
	record = append(record, payload...)

	if hc.version >= VersionTLS13 && epoch.cipher != nil {
		if hc.config.Bugs.OmitRecordContents {
			record = record[:len(record)-len(payload)]
		} else {
			record = append(record, byte(typ))
		}
		padding := extendSlice(&record, hc.config.Bugs.RecordPadding)
		clear(padding)
	}

	if epoch.mac != nil {
		record = append(record, hc.computeMAC(epoch, seq, header, payload)...)
	}

	explicitIV := record[prefixLen : prefixLen+explicitIVLen]
	if epoch.cipher != nil {
		switch c := epoch.cipher.(type) {
		case cipher.Stream:
			if explicitIVLen != 0 {
				panic("tls: unexpected explicit IV length")
			}
			c.XORKeyStream(record[prefixLen:], record[prefixLen:])
		case *tlsAead:
			nonce := seq
			if hc.isDTLS && hc.version >= VersionTLS13 && !hc.conn.useDTLSPlaintextHeader() {
				// Unlike DTLS 1.2, DTLS 1.3's nonce construction does not use
				// the epoch number. We store the epoch and nonce numbers
				// together, so make a copy without the epoch.
				nonce = make([]byte, 8)
				copy(nonce[2:], seq[2:])
			}

			// Save the explicit IV, if not empty.
			if len(explicitIV) != 0 {
				if explicitIVLen != len(nonce) {
					panic("tls: unexpected explicit IV length")
				}
				copy(explicitIV, nonce)
			}

			var additionalData []byte
			if hc.version < VersionTLS13 {
				// (D)TLS 1.2's AD is seq_num || type || version || plaintext length
				additionalData = make([]byte, 13)
				copy(additionalData, seq)
				copy(additionalData[8:], header[:3])
				additionalData[11] = byte(len(payload) >> 8)
				additionalData[12] = byte(len(payload))
			} else {
				// (D)TLS 1.3's AD is the ciphertext record header, so update the
				// length now.
				if headerHasLength {
					n := len(record) - prefixLen + c.Overhead()
					record[prefixLen-2] = byte(n >> 8)
					record[prefixLen-1] = byte(n)
				}
				additionalData = record[prefixLen-headerLen : prefixLen]
			}

			record = c.Seal(record[:prefixLen+explicitIVLen], nonce, record[prefixLen+explicitIVLen:], additionalData)
		case *cbcMode:
			if explicitIVLen > 0 {
				if _, err := io.ReadFull(hc.config.rand(), explicitIV); err != nil {
					return nil, err
				}
				c.SetIV(explicitIV)
			}

			blockSize := c.BlockSize()
			paddingLen := computingCBCPaddingLength(len(record)-prefixLen, blockSize, hc.config)
			record = appendCBCPadding(record, paddingLen, hc.config)
			c.CryptBlocks(record[prefixLen:], record[prefixLen:])
		case nullCipher:
			break
		default:
			panic("unknown cipher type")
		}
	}

	// Update the record header to include the encryption overhead.
	if headerHasLength {
		n := len(record) - prefixLen
		record[prefixLen-2] = byte(n >> 8)
		record[prefixLen-1] = byte(n)
	}
	hc.incSeq(epoch)

	return record, nil
}

type recordNumberEncrypter interface {
	// GenerateMask takes a sample of the encrypted record and returns the
	// mask used to encrypt and decrypt record numbers.
	generateMask(sample []byte) []byte
}

type aesRecordNumberEncrypter struct {
	aesCipher cipher.Block
}

func newAESRecordNumberEncrypter(key []byte) *aesRecordNumberEncrypter {
	aesCipher, err := aes.NewCipher(key)
	if err != nil {
		panic("Incorrect usage of newAESRecordNumberEncrypter")
	}
	return &aesRecordNumberEncrypter{
		aesCipher: aesCipher,
	}
}

func (a *aesRecordNumberEncrypter) generateMask(sample []byte) []byte {
	out := make([]byte, len(sample))
	a.aesCipher.Encrypt(out, sample)
	return out
}

type chachaRecordNumberEncrypter struct {
	key []byte
}

func newChachaRecordNumberEncrypter(key []byte) *chachaRecordNumberEncrypter {
	out := &chachaRecordNumberEncrypter{
		key: key,
	}
	return out
}

func (c *chachaRecordNumberEncrypter) generateMask(sample []byte) []byte {
	var counter, nonce []byte
	sampleReader := cryptobyte.String(sample)
	if !sampleReader.ReadBytes(&counter, 4) || !sampleReader.ReadBytes(&nonce, 12) {
		panic("chachaRecordNumberEncrypter.GenerateMask called with wrong size sample")
	}
	cipher, err := chacha20.NewUnauthenticatedCipher(c.key, nonce)
	if err != nil {
		panic("Failed to create chacha20 cipher for record number encryption")
	}
	cipher.SetCounter(binary.LittleEndian.Uint32(counter))
	out := make([]byte, 2)
	cipher.XORKeyStream(out, out)
	return out
}

func (c *Conn) useInTrafficSecret(epoch uint16, version uint16, suite *cipherSuite, secret []byte) error {
	if c.hand.Len() != 0 {
		return c.in.setErrorLocked(errors.New("tls: buffered handshake messages on cipher change"))
	}
	side := serverWrite
	if !c.isClient {
		side = clientWrite
	}
	if c.config.Bugs.MockQUICTransport != nil {
		if epoch > uint16(encryptionApplication) {
			panic("tls: KeyUpdate processed in QUIC")
		}
		c.config.Bugs.MockQUICTransport.readLevel = encryptionLevel(epoch)
		c.config.Bugs.MockQUICTransport.readSecret = secret
		c.config.Bugs.MockQUICTransport.readCipherSuite = suite.id
	}
	c.in.useTrafficSecret(version, suite, secret, side, epoch)
	c.seenHandshakePackEnd = false
	return nil
}

func (c *Conn) useOutTrafficSecret(epoch uint16, version uint16, suite *cipherSuite, secret []byte) {
	if !c.isDTLS {
		// The TLS logic relies on flushHandshake to write out packed handshake
		// data on key changes. The DTLS logic handles key changes directly.
		c.flushHandshake()
	}
	side := serverWrite
	if c.isClient {
		side = clientWrite
	}
	if c.config.Bugs.MockQUICTransport != nil {
		if epoch > uint16(encryptionApplication) {
			panic("tls: KeyUpdate processed in QUIC")
		}
		c.config.Bugs.MockQUICTransport.writeLevel = encryptionLevel(epoch)
		c.config.Bugs.MockQUICTransport.writeSecret = secret
		c.config.Bugs.MockQUICTransport.writeCipherSuite = suite.id
	}
	c.out.useTrafficSecret(version, suite, secret, side, epoch)
}

func (c *Conn) setSkipEarlyData() {
	if c.config.Bugs.MockQUICTransport != nil {
		c.config.Bugs.MockQUICTransport.skipEarlyData = true
	} else {
		c.skipEarlyData = true
	}
}

func (c *Conn) shouldSkipEarlyData() bool {
	if c.config.Bugs.MockQUICTransport != nil {
		return c.config.Bugs.MockQUICTransport.skipEarlyData
	}
	return c.skipEarlyData
}

func (c *Conn) readRawInputUntil(n int) error {
	if c.rawInput.Len() >= n {
		return nil
	}

	n -= c.rawInput.Len()
	c.rawInput.Grow(n)
	buf := c.rawInput.AvailableBuffer()
	nread, err := io.ReadAtLeast(c.conn, buf[:cap(buf)], n)
	c.rawInput.Write(buf[:nread])
	return err
}

func (c *Conn) doReadRecord(want recordType) (recordType, []byte, error) {
RestartReadRecord:
	if c.isDTLS {
		return c.dtlsDoReadRecord(&c.in.epoch, want)
	}

	recordHeaderLen := tlsRecordHeaderLen

	// Read header, payload.
	if err := c.readRawInputUntil(recordHeaderLen); err != nil {
		// RFC suggests that EOF without an alertCloseNotify is
		// an error, but popular web sites seem to do this,
		// so we can't make it an error, outside of tests.
		if err == io.EOF && c.config.Bugs.ExpectCloseNotify {
			err = io.ErrUnexpectedEOF
		}
		if e, ok := err.(net.Error); !ok || !e.Temporary() {
			c.in.setErrorLocked(err)
		}
		return 0, nil, err
	}

	header := c.rawInput.Bytes()[:recordHeaderLen]
	typ := recordType(header[0])

	// No valid TLS record has a type of 0x80, however SSLv2 handshakes
	// start with a uint16 length where the MSB is set and the first record
	// is always < 256 bytes long. Therefore typ == 0x80 strongly suggests
	// an SSLv2 client.
	if want == recordTypeHandshake && typ == 0x80 {
		c.sendAlert(alertProtocolVersion)
		return 0, nil, c.in.setErrorLocked(errors.New("tls: unsupported SSLv2 handshake received"))
	}

	vers := uint16(header[1])<<8 | uint16(header[2])
	n := int(header[3])<<8 | int(header[4])

	// Alerts sent near version negotiation do not have a well-defined
	// record-layer version prior to TLS 1.3. (In TLS 1.3, the record-layer
	// version is irrelevant.)
	if typ != recordTypeAlert {
		var expect uint16
		if c.haveVers {
			expect = c.vers
			if c.vers >= VersionTLS13 {
				expect = VersionTLS12
			}
		} else {
			expect = c.config.Bugs.ExpectInitialRecordVersion
		}
		if expect != 0 && vers != expect {
			c.sendAlert(alertProtocolVersion)
			return 0, nil, c.in.setErrorLocked(fmt.Errorf("tls: received record with version %x when expecting version %x", vers, expect))
		}
	}
	if n > maxCiphertext {
		c.sendAlert(alertRecordOverflow)
		return 0, nil, c.in.setErrorLocked(fmt.Errorf("tls: oversized record received with length %d", n))
	}
	if !c.haveVers {
		// First message, be extra suspicious:
		// this might not be a TLS client.
		// Bail out before reading a full 'body', if possible.
		// The current max version is 3.1.
		// If the version is >= 16.0, it's probably not real.
		// Similarly, a clientHello message encodes in
		// well under a kilobyte.  If the length is >= 12 kB,
		// it's probably not real.
		if (typ != recordTypeAlert && typ != want) || vers >= 0x1000 || n >= 0x3000 {
			c.sendAlert(alertUnexpectedMessage)
			return 0, nil, c.in.setErrorLocked(fmt.Errorf("tls: first record does not look like a TLS handshake"))
		}
	}
	if err := c.readRawInputUntil(recordHeaderLen + n); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		if e, ok := err.(net.Error); !ok || !e.Temporary() {
			c.in.setErrorLocked(err)
		}
		return 0, nil, err
	}

	// Process message.
	b := c.rawInput.Next(recordHeaderLen + n)
	epoch := &c.in.epoch
	ok, encTyp, data, alertValue := c.in.decrypt(epoch, recordHeaderLen, b)
	if !ok {
		// TLS 1.3 early data uses trial decryption.
		if c.skipEarlyData {
			goto RestartReadRecord
		}
		return 0, nil, c.in.setErrorLocked(c.sendAlert(alertValue))
	}

	// If the server is expecting a second ClientHello (in response to
	// a HelloRetryRequest) and the client sends early data, there
	// won't be a decryption failure (we will interpret the ciphertext
	// as plaintext application data) but it still needs to be skipped.
	if epoch.cipher == nil && typ == recordTypeApplicationData && c.skipEarlyData {
		goto RestartReadRecord
	}

	c.skipEarlyData = false

	if c.vers >= VersionTLS13 && epoch.cipher != nil {
		if typ != recordTypeApplicationData {
			return 0, nil, c.in.setErrorLocked(fmt.Errorf("tls: outer record type is not application data"))
		}
		typ = encTyp
	}

	if c.config.Bugs.ExpectRecordSplitting && typ == recordTypeApplicationData && len(data) != 1 && !c.seenOneByteRecord {
		return 0, nil, c.in.setErrorLocked(fmt.Errorf("tls: application data records were not split"))
	}

	c.seenOneByteRecord = typ == recordTypeApplicationData && len(data) == 1
	return typ, data, nil
}

func (c *Conn) readTLS13ChangeCipherSpec() error {
	if c.config.Bugs.MockQUICTransport != nil {
		return nil
	}
	if c.isDTLS {
		// ChangeCipherSpec in DTLS 1.3 is handled within dtlsDoReadRecord.
		return nil
	}
	if !c.expectTLS13ChangeCipherSpec {
		panic("c.expectTLS13ChangeCipherSpec not set")
	}

	// Read the ChangeCipherSpec.
	if err := c.readRawInputUntil(6); err != nil {
		return c.in.setErrorLocked(fmt.Errorf("tls: error reading TLS 1.3 ChangeCipherSpec: %s", err))
	}
	if recordType(c.rawInput.Bytes()[0]) == recordTypeAlert {
		// If the client is sending an alert, allow the ChangeCipherSpec
		// to be skipped. It may be rejecting a sufficiently malformed
		// ServerHello that it can't parse out the version.
		c.expectTLS13ChangeCipherSpec = false
		return nil
	}

	// Check they match that we expect.
	expected := [6]byte{byte(recordTypeChangeCipherSpec), 3, 1, 0, 1, 1}
	if c.vers >= VersionTLS13 {
		expected[2] = 3
	}
	if data := c.rawInput.Bytes()[:6]; !bytes.Equal(data, expected[:]) {
		return c.in.setErrorLocked(fmt.Errorf("tls: error invalid TLS 1.3 ChangeCipherSpec: %x", data))
	}

	// Discard the data.
	c.rawInput.Next(6)

	c.expectTLS13ChangeCipherSpec = false
	return nil
}

// readRecord reads the next TLS record from the connection
// and updates the record layer state.
// c.in.Mutex <= L; c.input == nil.
func (c *Conn) readRecord(want recordType) error {
	// Caller must be in sync with connection:
	// handshake data if handshake not yet completed,
	// else application data.
	switch want {
	default:
		c.sendAlert(alertInternalError)
		return c.in.setErrorLocked(errors.New("tls: unknown record type requested"))
	case recordTypeChangeCipherSpec:
		if c.handshakeComplete {
			c.sendAlert(alertInternalError)
			return c.in.setErrorLocked(errors.New("tls: ChangeCipherSpec requested after handshake complete"))
		}
	case recordTypeApplicationData, recordTypeAlert, recordTypeHandshake, recordTypeACK:
		break
	}

	if c.expectTLS13ChangeCipherSpec {
		if err := c.readTLS13ChangeCipherSpec(); err != nil {
			return err
		}
	}

Again:
	doReadRecord := c.doReadRecord
	if c.config.Bugs.MockQUICTransport != nil {
		doReadRecord = c.config.Bugs.MockQUICTransport.readRecord
	}
	typ, data, err := doReadRecord(want)
	if err != nil {
		return err
	}
	max := maxPlaintext
	if c.config.Bugs.MaxReceivePlaintext != 0 {
		max = c.config.Bugs.MaxReceivePlaintext
	}
	if len(data) > max {
		err := c.sendAlert(alertRecordOverflow)
		return c.in.setErrorLocked(err)
	}

	if typ != recordTypeHandshake {
		c.seenHandshakePackEnd = false
	} else if c.seenHandshakePackEnd {
		return c.in.setErrorLocked(errors.New("tls: peer violated ExpectPackedEncryptedHandshake"))
	}

	switch typ {
	default:
		c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))

	case recordTypeAlert:
		if len(data) != 2 {
			c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
			break
		}
		if alert(data[1]) == alertCloseNotify {
			c.in.setErrorLocked(io.EOF)
			break
		}
		switch data[0] {
		case alertLevelWarning:
			// drop on the floor
			goto Again
		case alertLevelError:
			c.in.setErrorLocked(&net.OpError{Op: "remote error", Err: alert(data[1])})
		default:
			c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
		}

	case recordTypeChangeCipherSpec:
		if typ != want || len(data) != 1 || data[0] != 1 {
			c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
			break
		}
		if c.hand.Len() != 0 {
			c.in.setErrorLocked(errors.New("tls: buffered handshake messages on cipher change"))
			break
		}
		if c.isDTLS {
			// Track the ChangeCipherSpec record in the current flight.
			c.receivedFlight = append(c.receivedFlight, DTLSMessage{
				Epoch:              c.in.epoch.epoch,
				IsChangeCipherSpec: true,
				Data:               slices.Clone(data),
			})
		}
		if err := c.in.changeCipherSpec(); err != nil {
			c.in.setErrorLocked(c.sendAlert(err.(alert)))
		}

	case recordTypeApplicationData:
		if typ != want {
			c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
			break
		}
		c.input.Write(data)

	case recordTypeHandshake:
		// Allow handshake data while reading application data to
		// trigger post-handshake messages.
		// TODO(rsc): Should at least pick off connection close.
		if typ != want && want != recordTypeApplicationData {
			return c.in.setErrorLocked(c.sendAlert(alertNoRenegotiation))
		}
		c.hand.Write(data)
		if pack := c.config.Bugs.ExpectPackedEncryptedHandshake; pack > 0 && len(data) < pack && c.out.epoch.cipher != nil {
			c.seenHandshakePackEnd = true
		}
		if c.isDTLS {
			record, err := c.makeDTLSRecordNumberInfo(&c.in.epoch, c.hand.Bytes())
			if err != nil {
				return err
			}
			c.receivedFlightRecords = append(c.receivedFlightRecords, record)
		}

	case recordTypeACK:
		if typ != want || !c.isDTLS {
			c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
			break
		}

		if err := c.checkACK(data); err != nil {
			c.in.setErrorLocked(err)
			break
		}
	}

	return c.in.err
}

// sendAlert sends a TLS alert message.
// c.out.Mutex <= L.
func (c *Conn) sendAlertLocked(level byte, err alert) error {
	c.tmp[0] = level
	c.tmp[1] = byte(err)
	if c.config.Bugs.FragmentAlert {
		c.writeRecord(recordTypeAlert, c.tmp[0:1])
		c.writeRecord(recordTypeAlert, c.tmp[1:2])
	} else if c.config.Bugs.DoubleAlert {
		copy(c.tmp[2:4], c.tmp[0:2])
		c.writeRecord(recordTypeAlert, c.tmp[0:4])
	} else {
		c.writeRecord(recordTypeAlert, c.tmp[0:2])
	}
	// Error alerts are fatal to the connection.
	if level == alertLevelError {
		return c.out.setErrorLocked(&net.OpError{Op: "local error", Err: err})
	}
	return nil
}

// sendAlert sends a TLS alert message.
// L < c.out.Mutex.
func (c *Conn) sendAlert(err alert) error {
	level := byte(alertLevelError)
	if err == alertNoRenegotiation || err == alertCloseNotify {
		level = alertLevelWarning
	}
	return c.SendAlert(level, err)
}

func (c *Conn) SendAlert(level byte, err alert) error {
	c.out.Lock()
	defer c.out.Unlock()
	return c.sendAlertLocked(level, err)
}

// writeV2Record writes a record for a V2ClientHello.
func (c *Conn) writeV2Record(data []byte) (n int, err error) {
	record := make([]byte, 2+len(data))
	record[0] = uint8(len(data)>>8) | 0x80
	record[1] = uint8(len(data))
	copy(record[2:], data)
	return c.conn.Write(record)
}

// writeRecord writes a TLS record with the given type and payload
// to the connection and updates the record layer state.
// c.out.Mutex <= L.
func (c *Conn) writeRecord(typ recordType, data []byte) (n int, err error) {
	c.seenHandshakePackEnd = false
	if c.hand.Len() == 0 {
		c.lastRecordInFlight = nil
	}
	if typ == recordTypeHandshake {
		msgType := data[0]
		if c.config.Bugs.SendWrongMessageType != 0 && msgType == c.config.Bugs.SendWrongMessageType {
			msgType += 42
		}
		if msgType != data[0] {
			data = append([]byte{msgType}, data[1:]...)
		}

		if c.config.Bugs.SendTrailingMessageData != 0 && msgType == c.config.Bugs.SendTrailingMessageData {
			// Add a 0 to the body.
			newData := make([]byte, len(data)+1)
			copy(newData, data)

			// Fix the header.
			newLen := len(newData) - 4
			newData[1] = byte(newLen >> 16)
			newData[2] = byte(newLen >> 8)
			newData[3] = byte(newLen)

			data = newData
		}

		if c.config.Bugs.TrailingDataWithFinished && msgType == typeFinished {
			// Add a 0 to the record. Note unused bytes in |data| may be owned by the
			// caller, so we force a new allocation.
			data = append(data[:len(data):len(data)], 0)
		}
	}

	if c.isDTLS {
		return c.dtlsWriteRecord(typ, data)
	}
	if c.config.Bugs.MockQUICTransport != nil {
		return c.config.Bugs.MockQUICTransport.writeRecord(typ, data)
	}

	if typ == recordTypeHandshake {
		if c.config.Bugs.SendHelloRequestBeforeEveryHandshakeMessage {
			newData := make([]byte, 0, 4+len(data))
			newData = append(newData, typeHelloRequest, 0, 0, 0)
			newData = append(newData, data...)
			data = newData
		}

		if c.config.Bugs.PackHandshakeFlight {
			c.pendingFlight.Write(data)
			return len(data), nil
		}
	}

	// Flush buffered data before writing anything.
	if err := c.flushHandshake(); err != nil {
		return 0, err
	}

	if typ == recordTypeApplicationData && c.config.Bugs.SendPostHandshakeChangeCipherSpec {
		if _, err := c.doWriteRecord(recordTypeChangeCipherSpec, []byte{1}); err != nil {
			return 0, err
		}
	}

	return c.doWriteRecord(typ, data)
}

func (c *Conn) doWriteRecord(typ recordType, data []byte) (n int, err error) {
	first := true
	for len(data) > 0 || first {
		m := len(data)
		if m > maxPlaintext && !c.config.Bugs.SendLargeRecords {
			m = maxPlaintext
		}
		if typ == recordTypeHandshake && c.config.Bugs.MaxHandshakeRecordLength > 0 && m > c.config.Bugs.MaxHandshakeRecordLength {
			m = c.config.Bugs.MaxHandshakeRecordLength
		}
		first = false

		// Determine record version.
		vers := c.vers
		if vers == 0 {
			// Some TLS servers fail if the record version is
			// greater than TLS 1.0 for the initial ClientHello.
			//
			// TLS 1.3 fixes the version number in the record
			// layer to {3, 1}.
			vers = VersionTLS10
		}
		if c.vers >= VersionTLS13 || c.out.version >= VersionTLS13 {
			vers = VersionTLS12
		}
		if c.config.Bugs.SendRecordVersion != 0 {
			vers = c.config.Bugs.SendRecordVersion
		}
		if c.vers == 0 && c.config.Bugs.SendInitialRecordVersion != 0 {
			vers = c.config.Bugs.SendInitialRecordVersion
		}

		// Assemble the record header.
		epoch := &c.out.epoch
		record := make([]byte, tlsRecordHeaderLen, tlsRecordHeaderLen+m+c.out.maxEncryptOverhead(epoch, m))
		record[0] = byte(typ)
		if c.vers >= VersionTLS13 && epoch.cipher != nil {
			record[0] = byte(recordTypeApplicationData)
			if outerType := c.config.Bugs.OuterRecordType; outerType != 0 {
				record[0] = byte(outerType)
			}
		}
		record[1] = byte(vers >> 8)
		record[2] = byte(vers)
		record[3] = byte(m >> 8) // encrypt will update this
		record[4] = byte(m)

		record, err = c.out.encrypt(epoch, record, data[:m], typ, tlsRecordHeaderLen, true /* header has length */)
		if err != nil {
			return
		}
		_, err = c.conn.Write(record)
		if err != nil {
			break
		}
		n += m
		data = data[m:]
	}

	if typ == recordTypeChangeCipherSpec && c.vers < VersionTLS13 {
		err = c.out.changeCipherSpec()
		if err != nil {
			return n, c.sendAlertLocked(alertLevelError, err.(alert))
		}
	}
	return
}

func (c *Conn) flushHandshake() error {
	if c.isDTLS {
		return c.dtlsFlushHandshake()
	}

	for c.pendingFlight.Len() > 0 {
		var buf [maxPlaintext]byte
		n, _ := c.pendingFlight.Read(buf[:])
		if _, err := c.doWriteRecord(recordTypeHandshake, buf[:n]); err != nil {
			return err
		}
	}

	c.pendingFlight.Reset()
	return nil
}

func (c *Conn) ackHandshake() error {
	if c.isDTLS {
		return c.dtlsACKHandshake()
	}
	return nil
}

func (c *Conn) doReadHandshake() ([]byte, error) {
	if c.isDTLS {
		return c.dtlsDoReadHandshake()
	}

	for c.hand.Len() < 4 {
		if err := c.in.err; err != nil {
			return nil, err
		}
		if err := c.readRecord(recordTypeHandshake); err != nil {
			return nil, err
		}
	}

	data := c.hand.Bytes()
	n := int(data[1])<<16 | int(data[2])<<8 | int(data[3])
	if n > maxHandshake {
		return nil, c.in.setErrorLocked(c.sendAlert(alertInternalError))
	}
	for c.hand.Len() < 4+n {
		if err := c.in.err; err != nil {
			return nil, err
		}
		if err := c.readRecord(recordTypeHandshake); err != nil {
			return nil, err
		}
	}
	return c.hand.Next(4 + n), nil
}

// readHandshake reads the next handshake message from
// the record layer.
// c.in.Mutex < L; c.out.Mutex < L.
func (c *Conn) readHandshake() (any, error) {
	data, err := c.doReadHandshake()
	if err != nil {
		return nil, err
	}

	typ := data[0]
	var m handshakeMessage
	switch typ {
	case typeHelloRequest:
		m = new(helloRequestMsg)
	case typeClientHello:
		m = &clientHelloMsg{
			isDTLS: c.isDTLS,
		}
	case typeServerHello:
		m = &serverHelloMsg{
			isDTLS: c.isDTLS,
		}
	case typeNewSessionTicket:
		m = &newSessionTicketMsg{
			vers:   c.wireVersion,
			isDTLS: c.isDTLS,
		}
	case typeEncryptedExtensions:
		if c.isClient {
			m = new(encryptedExtensionsMsg)
		} else {
			m = new(clientEncryptedExtensionsMsg)
		}
	case typeCertificate:
		m = &certificateMsg{
			hasRequestContext: c.vers >= VersionTLS13,
		}
	case typeCompressedCertificate:
		m = new(compressedCertificateMsg)
	case typeCertificateRequest:
		m = &certificateRequestMsg{
			vers:                  c.wireVersion,
			hasSignatureAlgorithm: c.vers >= VersionTLS12,
			hasRequestContext:     c.vers >= VersionTLS13,
		}
	case typeCertificateStatus:
		m = new(certificateStatusMsg)
	case typeServerKeyExchange:
		m = new(serverKeyExchangeMsg)
	case typeServerHelloDone:
		m = new(serverHelloDoneMsg)
	case typeClientKeyExchange:
		m = new(clientKeyExchangeMsg)
	case typeCertificateVerify:
		m = &certificateVerifyMsg{
			hasSignatureAlgorithm: c.vers >= VersionTLS12,
		}
	case typeNextProtocol:
		m = new(nextProtoMsg)
	case typeFinished:
		m = new(finishedMsg)
	case typeHelloVerifyRequest:
		m = new(helloVerifyRequestMsg)
	case typeChannelID:
		m = new(channelIDMsg)
	case typeKeyUpdate:
		m = new(keyUpdateMsg)
	case typeEndOfEarlyData:
		m = new(endOfEarlyDataMsg)
	default:
		return nil, c.in.setErrorLocked(c.sendAlert(alertUnexpectedMessage))
	}

	// The handshake message unmarshallers
	// expect to be able to keep references to data,
	// so pass in a fresh copy that won't be overwritten.
	data = slices.Clone(data)

	if data[0] == typeServerHello && len(data) >= 38 {
		vers := uint16(data[4])<<8 | uint16(data[5])
		if (vers == VersionDTLS12 || vers == VersionTLS12) && bytes.Equal(data[6:38], tls13HelloRetryRequest) {
			m = &helloRetryRequestMsg{isDTLS: c.isDTLS}
		}
	}

	if !m.unmarshal(data) {
		c.sendAlert(alertDecodeError)
		return nil, c.in.setErrorLocked(fmt.Errorf("tls: error decoding %s message", messageTypeToString(typ)))
	}
	return m, nil
}

func readHandshakeType[T any](c *Conn) (*T, error) {
	m, err := c.readHandshake()
	if err != nil {
		return nil, err
	}
	mType, ok := m.(*T)
	if !ok {
		c.sendAlert(alertUnexpectedMessage)
		return nil, unexpectedMessageError(mType, m)
	}
	return mType, nil
}

func (c *Conn) SendHalfHelloRequest() error {
	if err := c.Handshake(); err != nil {
		return err
	}

	c.out.Lock()
	defer c.out.Unlock()

	if _, err := c.writeRecord(recordTypeHandshake, []byte{typeHelloRequest, 0}); err != nil {
		return err
	}
	return c.flushHandshake()
}

// Write writes data to the connection.
func (c *Conn) Write(b []byte) (int, error) {
	if err := c.Handshake(); err != nil {
		return 0, err
	}

	c.out.Lock()
	defer c.out.Unlock()

	if err := c.out.err; err != nil {
		return 0, err
	}

	if !c.handshakeComplete {
		return 0, alertInternalError
	}

	if c.keyUpdateRequested {
		if err := c.sendKeyUpdateLocked(keyUpdateNotRequested); err != nil {
			return 0, err
		}
		c.keyUpdateRequested = false
	}

	if c.config.Bugs.SendSpuriousAlert != 0 {
		c.sendAlertLocked(alertLevelError, c.config.Bugs.SendSpuriousAlert)
	}

	if c.config.Bugs.SendHelloRequestBeforeEveryAppDataRecord {
		c.writeRecord(recordTypeHandshake, []byte{typeHelloRequest, 0, 0, 0})
		c.flushHandshake()
	}

	// SSL 3.0 and TLS 1.0 are susceptible to a chosen-plaintext
	// attack when using block mode ciphers due to predictable IVs.
	// This can be prevented by splitting each Application Data
	// record into two records, effectively randomizing the IV.
	//
	// http://www.openssl.org/~bodo/tls-cbc.txt
	// https://bugzilla.mozilla.org/show_bug.cgi?id=665814
	// http://www.imperialviolet.org/2012/01/15/beastfollowup.html

	var m int
	if len(b) > 1 && c.vers <= VersionTLS10 && !c.isDTLS {
		if _, ok := c.out.epoch.cipher.(*cbcMode); ok {
			n, err := c.writeRecord(recordTypeApplicationData, b[:1])
			if err != nil {
				return n, c.out.setErrorLocked(err)
			}
			m, b = 1, b[1:]
		}
	}

	n, err := c.writeRecord(recordTypeApplicationData, b)
	return n + m, c.out.setErrorLocked(err)
}

func (c *Conn) processTLS13NewSessionTicket(newSessionTicket *newSessionTicketMsg, cipherSuite *cipherSuite) error {
	session := &ClientSessionState{
		sessionTicket:               newSessionTicket.ticket,
		vers:                        c.vers,
		wireVersion:                 c.wireVersion,
		cipherSuite:                 cipherSuite,
		secret:                      deriveSessionPSK(cipherSuite, c.wireVersion, c.resumptionSecret, newSessionTicket.ticketNonce, c.isDTLS),
		serverCertificates:          c.peerCertificates,
		sctList:                     c.sctList,
		ocspResponse:                c.ocspResponse,
		ticketCreationTime:          c.config.time(),
		ticketExpiration:            c.config.time().Add(time.Duration(newSessionTicket.ticketLifetime) * time.Second),
		ticketAgeAdd:                newSessionTicket.ticketAgeAdd,
		maxEarlyDataSize:            newSessionTicket.maxEarlyDataSize,
		earlyALPN:                   c.clientProtocol,
		hasApplicationSettings:      c.hasApplicationSettings,
		localApplicationSettings:    c.localApplicationSettings,
		peerApplicationSettings:     c.peerApplicationSettings,
		hasApplicationSettingsOld:   c.hasApplicationSettingsOld,
		localApplicationSettingsOld: c.localApplicationSettingsOld,
		peerApplicationSettingsOld:  c.peerApplicationSettingsOld,
		resumptionAcrossNames:       newSessionTicket.flags.hasFlag(flagResumptionAcrossNames),
	}

	if c.config.Bugs.ExpectGREASE && !newSessionTicket.hasGREASEExtension {
		return errors.New("tls: no GREASE ticket extension found")
	}

	if c.config.Bugs.ExpectTicketEarlyData && newSessionTicket.maxEarlyDataSize == 0 {
		return errors.New("tls: no early_data ticket extension found")
	}

	if c.config.Bugs.ExpectNoNewSessionTicket || c.config.Bugs.ExpectNoNonEmptyNewSessionTicket {
		return errors.New("tls: received unexpected NewSessionTicket")
	}

	if expect := c.config.Bugs.ExpectResumptionAcrossNames; expect != nil && session.resumptionAcrossNames != *expect {
		return errors.New("tls: resumption_across_names status of ticket did not match expectation")
	}

	if c.config.ClientSessionCache == nil || newSessionTicket.ticketLifetime == 0 {
		return nil
	}

	cacheKey := clientSessionCacheKey(c.conn.RemoteAddr(), c.config)
	_, ok := c.config.ClientSessionCache.Get(cacheKey)
	if !ok || !c.config.Bugs.UseFirstSessionTicket {
		c.config.ClientSessionCache.Put(cacheKey, session)
	}

	return c.ackHandshake()
}

func (c *Conn) processKeyUpdate(keyUpdate *keyUpdateMsg) error {
	epoch := c.in.epoch.epoch + 1
	if epoch == 0 && !c.config.Bugs.AllowEpochOverflow {
		return errors.New("tls: too many KeyUpdates")
	}
	if err := c.useInTrafficSecret(epoch, c.in.wireVersion, c.cipherSuite, updateTrafficSecret(c.cipherSuite.hash(), c.wireVersion, c.in.trafficSecret, c.isDTLS)); err != nil {
		return err
	}
	if keyUpdate.keyUpdateRequest == keyUpdateRequested {
		c.keyUpdateRequested = true
	}
	return c.ackHandshake()
}

func (c *Conn) handlePostHandshakeMessage() error {
	msg, err := c.readHandshake()
	if err != nil {
		return err
	}

	if c.vers < VersionTLS13 {
		if !c.isClient {
			c.sendAlert(alertUnexpectedMessage)
			return errors.New("tls: unexpected post-handshake message")
		}

		_, ok := msg.(*helloRequestMsg)
		if !ok {
			c.sendAlert(alertUnexpectedMessage)
			return alertUnexpectedMessage
		}

		c.handshakeComplete = false
		return c.Handshake()
	}

	if c.isClient {
		if newSessionTicket, ok := msg.(*newSessionTicketMsg); ok {
			return c.processTLS13NewSessionTicket(newSessionTicket, c.cipherSuite)
		}
	}

	if keyUpdate, ok := msg.(*keyUpdateMsg); ok {
		c.keyUpdateSeen = true
		if c.config.Bugs.RejectUnsolicitedKeyUpdate {
			return errors.New("tls: unexpected KeyUpdate message")
		}
		return c.processKeyUpdate(keyUpdate)
	}

	c.sendAlert(alertUnexpectedMessage)
	return errors.New("tls: unexpected post-handshake message")
}

// Reads a KeyUpdate from the peer, with type key_update_not_requested. There
// may not be any application data records before the message.
func (c *Conn) ReadKeyUpdate() error {
	c.in.Lock()
	defer c.in.Unlock()

	keyUpdate, err := readHandshakeType[keyUpdateMsg](c)
	if err != nil {
		return err
	}

	if keyUpdate.keyUpdateRequest != keyUpdateNotRequested {
		return errors.New("tls: received invalid KeyUpdate message")
	}

	return c.processKeyUpdate(keyUpdate)
}

func (c *Conn) Renegotiate() error {
	if !c.isClient {
		helloReq := new(helloRequestMsg).marshal()
		if c.config.Bugs.BadHelloRequest != nil {
			helloReq = c.config.Bugs.BadHelloRequest
		}
		c.writeRecord(recordTypeHandshake, helloReq)
		c.flushHandshake()
	}

	c.handshakeComplete = false
	return c.Handshake()
}

// Read can be made to time out and return a net.Error with Timeout() == true
// after a fixed time limit; see SetDeadline and SetReadDeadline.
func (c *Conn) Read(b []byte) (n int, err error) {
	if err = c.Handshake(); err != nil {
		return
	}

	c.in.Lock()
	defer c.in.Unlock()

	// Some OpenSSL servers send empty records in order to randomize the
	// CBC IV. So this loop ignores a limited number of empty records.
	const maxConsecutiveEmptyRecords = 100
	for emptyRecordCount := 0; emptyRecordCount <= maxConsecutiveEmptyRecords; emptyRecordCount++ {
		for c.input.Len() == 0 && c.in.err == nil {
			if err := c.readRecord(recordTypeApplicationData); err != nil {
				// Soft error, like EAGAIN
				return 0, err
			}
			for c.hand.Len() > 0 {
				// We received handshake bytes, indicating a
				// post-handshake message.
				if err := c.handlePostHandshakeMessage(); err != nil {
					return 0, err
				}
			}
		}
		if err := c.in.err; err != nil {
			return 0, err
		}

		n, err = c.input.Read(b)
		if c.input.Len() == 0 || c.isDTLS {
			c.input.Reset()
		}

		// If a close-notify alert is waiting, read it so that
		// we can return (n, EOF) instead of (n, nil), to signal
		// to the HTTP response reading goroutine that the
		// connection is now closed. This eliminates a race
		// where the HTTP response reading goroutine would
		// otherwise not observe the EOF until its next read,
		// by which time a client goroutine might have already
		// tried to reuse the HTTP connection for a new
		// request.
		// See https://codereview.appspot.com/76400046
		// and http://golang.org/issue/3514
		if ri := c.rawInput.Bytes(); !c.isDTLS && n != 0 && err == nil &&
			c.input.Len() == 0 && len(ri) > 0 && recordType(ri[0]) == recordTypeAlert {
			if recErr := c.readRecord(recordTypeApplicationData); recErr != nil {
				err = recErr // will be io.EOF on closeNotify
			}
		}

		if n != 0 || err != nil {
			return n, err
		}
	}

	return 0, io.ErrNoProgress
}

// Close closes the connection.
func (c *Conn) Close() error {
	var alertErr error

	c.handshakeMutex.Lock()
	defer c.handshakeMutex.Unlock()
	if c.handshakeComplete && !c.config.Bugs.NoCloseNotify {
		alert := alertCloseNotify
		if c.config.Bugs.SendAlertOnShutdown != 0 {
			alert = c.config.Bugs.SendAlertOnShutdown
		}
		alertErr = c.sendAlert(alert)
		// Clear local alerts when sending alerts so we continue to wait
		// for the peer rather than closing the socket early.
		if opErr, ok := alertErr.(*net.OpError); ok && opErr.Op == "local error" {
			alertErr = nil
		}
	}

	// Consume a close_notify from the peer if one hasn't been received
	// already. This avoids the peer from failing |SSL_shutdown| due to a
	// write failing.
	if c.handshakeComplete && alertErr == nil && c.config.Bugs.ExpectCloseNotify {
		for c.in.error() == nil {
			c.readRecord(recordTypeAlert)
		}
		if c.in.error() != io.EOF {
			alertErr = c.in.error()
		}
	}

	if err := c.conn.Close(); err != nil {
		return err
	}
	return alertErr
}

// Handshake runs the client or server handshake
// protocol if it has not yet been run.
// Most uses of this package need not call Handshake
// explicitly: the first Read or Write will call it automatically.
func (c *Conn) Handshake() error {
	c.handshakeMutex.Lock()
	defer c.handshakeMutex.Unlock()
	if err := c.handshakeErr; err != nil {
		return err
	}
	if c.handshakeComplete {
		return nil
	}

	if c.isDTLS && c.config.Bugs.SendSplitAlert {
		c.conn.Write([]byte{
			byte(recordTypeAlert), // type
			0xfe, 0xff,            // version
			0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, // sequence
			0x0, 0x2, // length
		})
		c.conn.Write([]byte{alertLevelError, byte(alertInternalError)})
	}
	if data := c.config.Bugs.AppDataBeforeHandshake; data != nil {
		c.writeRecord(recordTypeApplicationData, data)
	}
	if c.isClient {
		c.handshakeErr = c.clientHandshake()
	} else {
		c.handshakeErr = c.serverHandshake()
	}
	if c.handshakeErr == nil && c.config.Bugs.SendInvalidRecordType {
		c.writeRecord(recordType(42), []byte("invalid record"))
	}
	return c.handshakeErr
}

// ConnectionState returns basic TLS details about the connection.
func (c *Conn) ConnectionState() ConnectionState {
	c.handshakeMutex.Lock()
	defer c.handshakeMutex.Unlock()

	var state ConnectionState
	state.HandshakeComplete = c.handshakeComplete
	if c.handshakeComplete {
		state.Version = c.vers
		state.NegotiatedProtocol = c.clientProtocol
		state.DidResume = c.didResume
		state.NegotiatedProtocolIsMutual = !c.clientProtocolFallback
		state.NegotiatedProtocolFromALPN = c.usedALPN
		state.CipherSuite = c.cipherSuite.id
		state.PeerCertificates = c.peerCertificates
		state.PeerDelegatedCredential = c.peerDelegatedCredential
		state.VerifiedChains = c.verifiedChains
		state.OCSPResponse = c.ocspResponse
		state.ServerName = c.serverName
		state.ServerNameAck = c.serverNameAck
		state.ChannelID = c.channelID
		state.SRTPProtectionProfile = c.srtpProtectionProfile
		state.TLSUnique = c.firstFinished[:]
		state.SCTList = c.sctList
		state.PeerSignatureAlgorithm = c.peerSignatureAlgorithm
		state.CurveID = c.curveID
		state.QUICTransportParams = c.quicTransportParams
		state.QUICTransportParamsLegacy = c.quicTransportParamsLegacy
		state.HasApplicationSettings = c.hasApplicationSettings
		state.PeerApplicationSettings = c.peerApplicationSettings
		state.HasApplicationSettingsOld = c.hasApplicationSettingsOld
		state.PeerApplicationSettingsOld = c.peerApplicationSettingsOld
		state.ECHAccepted = c.echAccepted
	}

	return state
}

// VerifyHostname checks that the peer certificate chain is valid for
// connecting to host.  If so, it returns nil; if not, it returns an error
// describing the problem.
func (c *Conn) VerifyHostname(host string) error {
	c.handshakeMutex.Lock()
	defer c.handshakeMutex.Unlock()
	if !c.isClient {
		return errors.New("tls: VerifyHostname called on TLS server connection")
	}
	if !c.handshakeComplete {
		return errors.New("tls: handshake has not yet been performed")
	}
	return c.peerCertificates[0].VerifyHostname(host)
}

func (c *Conn) exportKeyingMaterialTLS13(length int, secret, label, context []byte) []byte {
	hash := c.cipherSuite.hash()
	exporterKeyingLabel := []byte("exporter")
	contextHash := hash.New()
	contextHash.Write(context)
	exporterContext := hash.New().Sum(nil)
	derivedSecret := hkdfExpandLabel(c.cipherSuite.hash(), secret, label, exporterContext, hash.Size(), c.isDTLS)
	return hkdfExpandLabel(c.cipherSuite.hash(), derivedSecret, exporterKeyingLabel, contextHash.Sum(nil), length, c.isDTLS)
}

// ExportKeyingMaterial exports keying material from the current connection
// state, as per RFC 5705.
func (c *Conn) ExportKeyingMaterial(length int, label, context []byte, useContext bool) ([]byte, error) {
	c.handshakeMutex.Lock()
	defer c.handshakeMutex.Unlock()
	if !c.handshakeComplete {
		return nil, errors.New("tls: handshake has not yet been performed")
	}

	if c.vers >= VersionTLS13 {
		return c.exportKeyingMaterialTLS13(length, c.exporterSecret, label, context), nil
	}

	seedLen := len(c.clientRandom) + len(c.serverRandom)
	if useContext {
		seedLen += 2 + len(context)
	}
	seed := make([]byte, 0, seedLen)
	seed = append(seed, c.clientRandom[:]...)
	seed = append(seed, c.serverRandom[:]...)
	if useContext {
		seed = append(seed, byte(len(context)>>8), byte(len(context)))
		seed = append(seed, context...)
	}
	result := make([]byte, length)
	prfForVersion(c.vers, c.cipherSuite)(result, c.exporterSecret, label, seed)
	return result, nil
}

func (c *Conn) ExportEarlyKeyingMaterial(length int, label, context []byte) ([]byte, error) {
	if c.vers < VersionTLS13 {
		return nil, errors.New("tls: early exporters not defined before TLS 1.3")
	}

	if c.earlyExporterSecret == nil {
		return nil, errors.New("tls: no early exporter secret")
	}

	return c.exportKeyingMaterialTLS13(length, c.earlyExporterSecret, label, context), nil
}

// noRenegotiationInfo returns true if the renegotiation info extension
// should be supported in the current handshake.
func (c *Conn) noRenegotiationInfo() bool {
	if c.config.Bugs.NoRenegotiationInfo {
		return true
	}
	if c.cipherSuite == nil && c.config.Bugs.NoRenegotiationInfoInInitial {
		return true
	}
	if c.cipherSuite != nil && c.config.Bugs.NoRenegotiationInfoAfterInitial {
		return true
	}
	return false
}

func (c *Conn) SendNewSessionTicket(nonce []byte) error {
	if c.isClient || c.vers < VersionTLS13 {
		return errors.New("tls: cannot send post-handshake NewSessionTicket")
	}

	var peerCertificatesRaw [][]byte
	for _, cert := range c.peerCertificates {
		peerCertificatesRaw = append(peerCertificatesRaw, cert.Raw)
	}

	addBuffer := make([]byte, 4)
	_, err := io.ReadFull(c.config.rand(), addBuffer)
	if err != nil {
		c.sendAlert(alertInternalError)
		return errors.New("tls: short read from Rand: " + err.Error())
	}
	ticketAgeAdd := uint32(addBuffer[3])<<24 | uint32(addBuffer[2])<<16 | uint32(addBuffer[1])<<8 | uint32(addBuffer[0])

	// TODO(davidben): Allow configuring these values.
	m := &newSessionTicketMsg{
		vers:                        c.wireVersion,
		isDTLS:                      c.isDTLS,
		ticketLifetime:              uint32(24 * time.Hour / time.Second),
		duplicateEarlyDataExtension: c.config.Bugs.DuplicateTicketEarlyData,
		customExtension:             c.config.Bugs.CustomTicketExtension,
		ticketAgeAdd:                ticketAgeAdd,
		ticketNonce:                 nonce,
		maxEarlyDataSize:            c.config.MaxEarlyDataSize,
		flags: flagSet{
			mustInclude: c.config.Bugs.AlwaysSendTicketFlags,
			padding:     c.config.Bugs.TicketFlagPadding,
		},
	}
	if c.config.Bugs.MockQUICTransport != nil && m.maxEarlyDataSize > 0 {
		m.maxEarlyDataSize = 0xffffffff
	}

	if c.config.Bugs.SendTicketLifetime != 0 {
		m.ticketLifetime = uint32(c.config.Bugs.SendTicketLifetime / time.Second)
	}
	if c.config.ResumptionAcrossNames {
		m.flags.setFlag(flagResumptionAcrossNames)
	}
	for _, flag := range c.config.Bugs.SendTicketFlags {
		m.flags.setFlag(flag)
	}

	state := sessionState{
		vers:                        c.vers,
		cipherSuite:                 c.cipherSuite.id,
		secret:                      deriveSessionPSK(c.cipherSuite, c.wireVersion, c.resumptionSecret, nonce, c.isDTLS),
		certificates:                peerCertificatesRaw,
		ticketCreationTime:          c.config.time(),
		ticketExpiration:            c.config.time().Add(time.Duration(m.ticketLifetime) * time.Second),
		ticketAgeAdd:                uint32(addBuffer[3])<<24 | uint32(addBuffer[2])<<16 | uint32(addBuffer[1])<<8 | uint32(addBuffer[0]),
		earlyALPN:                   []byte(c.clientProtocol),
		hasApplicationSettings:      c.hasApplicationSettings,
		localApplicationSettings:    c.localApplicationSettings,
		peerApplicationSettings:     c.peerApplicationSettings,
		hasApplicationSettingsOld:   c.hasApplicationSettingsOld,
		localApplicationSettingsOld: c.localApplicationSettingsOld,
		peerApplicationSettingsOld:  c.peerApplicationSettingsOld,
	}

	if !c.config.Bugs.SendEmptySessionTicket {
		var err error
		m.ticket, err = c.encryptTicket(&state)
		if err != nil {
			return err
		}
	}
	c.out.Lock()
	defer c.out.Unlock()
	_, err = c.writeRecord(recordTypeHandshake, m.marshal())
	return err
}

func (c *Conn) SendKeyUpdate(keyUpdateRequest byte) error {
	c.out.Lock()
	defer c.out.Unlock()
	return c.sendKeyUpdateLocked(keyUpdateRequest)
}

func (c *Conn) sendKeyUpdateLocked(keyUpdateRequest byte) error {
	if c.vers < VersionTLS13 {
		return errors.New("tls: attempted to send KeyUpdate before TLS 1.3")
	}
	epoch := c.out.epoch.epoch + 1
	if epoch == 0 && !c.config.Bugs.AllowEpochOverflow {
		return errors.New("tls: too many KeyUpdates")
	}

	m := keyUpdateMsg{
		keyUpdateRequest: keyUpdateRequest,
	}
	if _, err := c.writeRecord(recordTypeHandshake, m.marshal()); err != nil {
		return err
	}
	// In DTLS 1.3, a real implementation would not install the new epoch until
	// receiving an ACK. Our test transport is ordered and reliable, so this is
	// not necessary. ACK effects will be simulated in tests by the WriteFlight
	// callback.
	c.useOutTrafficSecret(epoch, c.out.wireVersion, c.cipherSuite, updateTrafficSecret(c.cipherSuite.hash(), c.wireVersion, c.out.trafficSecret, c.isDTLS))
	return c.flushHandshake()
}

func (c *Conn) sendFakeEarlyData(len int) error {
	// Assemble a fake early data record. This does not use writeRecord
	// because the record layer may be using different keys at this point.
	payload := make([]byte, 5+len)
	payload[0] = byte(recordTypeApplicationData)
	payload[1] = 3
	payload[2] = 3
	payload[3] = byte(len >> 8)
	payload[4] = byte(len)
	_, err := c.conn.Write(payload)
	return err
}

func (c *Conn) usesEndOfEarlyData() bool {
	if c.isClient && c.config.Bugs.SendEndOfEarlyDataInQUICAndDTLS {
		return true
	}
	return c.config.Bugs.MockQUICTransport == nil && !c.isDTLS
}
