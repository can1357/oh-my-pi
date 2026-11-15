// Copyright 2014 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// DTLS implementation.
//
// NOTE: This is a not even a remotely production-quality DTLS
// implementation. It is the bare minimum necessary to be able to
// achieve coverage on BoringSSL's implementation. Of note is that
// this implementation assumes the underlying net.PacketConn is not
// only reliable but also ordered. BoringSSL will be expected to deal
// with simulated loss, but there is no point in forcing the test
// driver to.

package runner

import (
	"bytes"
	"cmp"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"slices"
	"time"

	"golang.org/x/crypto/cryptobyte"
)

// A DTLSMessage is a DTLS handshake message or ChangeCipherSpec, along with the
// epoch that it is to be sent under.
type DTLSMessage struct {
	Epoch              uint16
	IsChangeCipherSpec bool
	// The following fields are only used if IsChangeCipherSpec is false.
	Type     uint8
	Sequence uint16
	Data     []byte
}

// Fragment returns a DTLSFragment for the message with the specified offset and
// length.
func (m *DTLSMessage) Fragment(offset, length int) DTLSFragment {
	if m.IsChangeCipherSpec {
		// Ignore the offset. ChangeCipherSpec cannot be fragmented.
		return DTLSFragment{
			Epoch:              m.Epoch,
			IsChangeCipherSpec: m.IsChangeCipherSpec,
			Data:               m.Data,
		}
	}

	return DTLSFragment{
		Epoch:       m.Epoch,
		Sequence:    m.Sequence,
		Type:        m.Type,
		Data:        m.Data[offset : offset+length],
		Offset:      offset,
		TotalLength: len(m.Data),
	}
}

// Split returns two fragments for the message.
func (m *DTLSMessage) Split(offset int) (DTLSFragment, DTLSFragment) {
	if m.IsChangeCipherSpec {
		panic("tls: cannot split ChangeCipherSpec")
	}

	return m.Fragment(0, offset), m.Fragment(offset, len(m.Data)-offset)
}

// A DTLSFragment is a DTLS handshake fragment or ChangeCipherSpec, along with
// the epoch that it is to be sent under.
type DTLSFragment struct {
	Epoch              uint16
	IsChangeCipherSpec bool
	// The following fields are only used if IsChangeCipherSpec is false.
	Type        uint8
	TotalLength int
	Sequence    uint16
	Offset      int
	Data        []byte
	// ShouldDiscard, if true, indicates the shim is expected to discard this
	// fragment. A record with such a fragment must not be ACKed by the shim.
	ShouldDiscard bool
}

func (f *DTLSFragment) Bytes() []byte {
	if f.IsChangeCipherSpec {
		return f.Data
	}

	bb := cryptobyte.NewBuilder(make([]byte, 0, 12+len(f.Data)))
	bb.AddUint8(f.Type)
	bb.AddUint24(uint32(f.TotalLength))
	bb.AddUint16(f.Sequence)
	bb.AddUint24(uint32(f.Offset))
	addUint24LengthPrefixedBytes(bb, f.Data)
	return bb.BytesOrPanic()
}

func comparePair[T1 cmp.Ordered, T2 cmp.Ordered](a1 T1, a2 T2, b1 T1, b2 T2) int {
	cmp1 := cmp.Compare(a1, b1)
	if cmp1 != 0 {
		return cmp1
	}
	return cmp.Compare(a2, b2)
}

type DTLSRecordNumber struct {
	// Store the Epoch as a uint64, so that tests can send ACKs for epochs that
	// the shim would never use.
	Epoch    uint64
	Sequence uint64
}

// A DTLSRecordNumberInfo contains information about a record received from the
// shim, which we may attempt to ACK.
type DTLSRecordNumberInfo struct {
	DTLSRecordNumber
	// The first byte covered by this record, inclusive. We only need to store
	// one range because we require that the shim arrange fragments in order.
	// Any gaps will have been previously-ACKed data, so there is no harm in
	// double-ACKing.
	MessageStartSequence uint16
	MessageStartOffset   int
	// The last byte covered by this record, exclusive.
	MessageEndSequence uint16
	MessageEndOffset   int
}

func (r *DTLSRecordNumberInfo) HasACKInformation() bool {
	return comparePair(r.MessageStartSequence, r.MessageStartOffset, r.MessageEndSequence, r.MessageEndOffset) < 0
}

func (c *Conn) readDTLS13RecordHeader(epoch *epochState, b []byte) (headerLen int, recordLen int, recTyp recordType, err error) {
	// The DTLS 1.3 record header starts with the type byte containing
	// 0b001CSLEE, where C, S, L, and EE are bits with the following
	// meanings:
	//
	// C=1: Connection ID is present (C=0: CID is absent)
	// S=1: the sequence number is 16 bits (S=0: it is 8 bits)
	// L=1: 16-bit length field is present (L=0: record goes to end of packet)
	// EE: low two bits of the epoch.
	//
	// A real DTLS implementation would parse these bits and take
	// appropriate action based on them. However, this is a test
	// implementation, and the code we are testing only ever sends C=0, S=1,
	// L=1. This code expects those bits to be set and will error if
	// anything else is set. This means we expect the type byte to look like
	// 0b001011EE, or 0x2c-0x2f.
	recordHeaderLen := 5
	if len(b) < recordHeaderLen {
		return 0, 0, 0, errors.New("dtls: failed to read record header")
	}
	typ := b[0]
	if typ&0xfc != 0x2c {
		return 0, 0, 0, errors.New("dtls: DTLS 1.3 record header has bad type byte")
	}
	// For test purposes, require the epoch received be the same as the
	// epoch we expect to receive.
	epochBits := typ & 0x03
	if epochBits != byte(epoch.epoch&0x03) {
		c.sendAlert(alertIllegalParameter)
		return 0, 0, 0, c.in.setErrorLocked(fmt.Errorf("dtls: bad epoch"))
	}
	wireSeq := b[1:3]
	if !c.config.Bugs.NullAllCiphers {
		sample := b[recordHeaderLen:]
		mask := epoch.recordNumberEncrypter.generateMask(sample)
		xorSlice(wireSeq, mask)
	}
	decWireSeq := binary.BigEndian.Uint16(wireSeq)
	// Reconstruct the sequence number from the low 16 bits on the wire.
	// A real implementation would compute the full sequence number that is
	// closest to the highest successfully decrypted record in the
	// identified epoch. Since this test implementation errors on decryption
	// failures instead of simply discarding packets, it reconstructs a
	// sequence number that is not less than c.in.seq. (This matches the
	// behavior of the check of the sequence number in the old record
	// header format.)
	seqInt := binary.BigEndian.Uint64(epoch.seq[:])
	// epoch.seq has the epoch in the upper two bytes - clear those.
	seqInt = seqInt &^ (0xffff << 48)
	newSeq := seqInt&^0xffff | uint64(decWireSeq)
	if newSeq < seqInt {
		newSeq += 0x10000
	}

	seq := make([]byte, 8)
	binary.BigEndian.PutUint64(seq, newSeq)
	copy(epoch.seq[2:], seq[2:])

	recordLen = int(b[3])<<8 | int(b[4])
	return recordHeaderLen, recordLen, 0, nil
}

// readDTLSRecordHeader reads the record header from the input. Based on the
// header it reads, it checks the header's validity and sets appropriate state
// as needed. This function returns the record header and the record type
// indicated in the header (if it contains the type). The connection's internal
// sequence number is updated to the value from the header.
func (c *Conn) readDTLSRecordHeader(epoch *epochState, b []byte) (headerLen int, recordLen int, typ recordType, err error) {
	if epoch.cipher != nil && c.in.version >= VersionTLS13 {
		return c.readDTLS13RecordHeader(epoch, b)
	}

	recordHeaderLen := 13
	// Read out one record.
	//
	// A real DTLS implementation should be tolerant of errors,
	// but this is test code. We should not be tolerant of our
	// peer sending garbage.
	if len(b) < recordHeaderLen {
		return 0, 0, 0, errors.New("dtls: failed to read record header")
	}
	typ = recordType(b[0])
	vers := uint16(b[1])<<8 | uint16(b[2])
	// Alerts sent near version negotiation do not have a well-defined
	// record-layer version prior to TLS 1.3. (In TLS 1.3, the record-layer
	// version is irrelevant.) Additionally, if we're reading a retransmission,
	// the peer may not know the version yet.
	if typ != recordTypeAlert && !c.skipRecordVersionCheck {
		if c.haveVers {
			wireVersion := c.wireVersion
			if c.vers >= VersionTLS13 {
				wireVersion = VersionDTLS12
			}
			if vers != wireVersion {
				c.sendAlert(alertProtocolVersion)
				return 0, 0, 0, c.in.setErrorLocked(fmt.Errorf("dtls: received record with version %x when expecting version %x", vers, c.wireVersion))
			}
		} else {
			if expect := c.config.Bugs.ExpectInitialRecordVersion; expect != 0 && vers != expect {
				c.sendAlert(alertProtocolVersion)
				return 0, 0, 0, c.in.setErrorLocked(fmt.Errorf("dtls: received record with version %x when expecting version %x", vers, expect))
			}
		}
	}
	epochValue := binary.BigEndian.Uint16(b[3:5])
	seq := b[5:11]
	// For test purposes, require the sequence number be monotonically
	// increasing, so c.in includes the minimum next sequence number. Gaps
	// may occur if packets failed to be sent out. A real implementation
	// would maintain a replay window and such.
	if epochValue != epoch.epoch {
		c.sendAlert(alertIllegalParameter)
		return 0, 0, 0, c.in.setErrorLocked(fmt.Errorf("dtls: bad epoch"))
	}
	if bytes.Compare(seq, epoch.seq[2:]) < 0 {
		c.sendAlert(alertIllegalParameter)
		return 0, 0, 0, c.in.setErrorLocked(fmt.Errorf("dtls: bad sequence number"))
	}
	copy(epoch.seq[2:], seq)
	recordLen = int(b[11])<<8 | int(b[12])
	return recordHeaderLen, recordLen, typ, nil
}

func (c *Conn) dtlsDoReadRecord(epoch *epochState, want recordType) (recordType, []byte, error) {
	// Read a new packet only if the current one is empty.
	var newPacket bool
	bytesAvailableInLastPacket := c.bytesAvailableInPacket
	if c.rawInput.Len() == 0 {
		// Pick some absurdly large buffer size.
		c.rawInput.Grow(maxCiphertext + dtlsMaxRecordHeaderLen)
		buf := c.rawInput.AvailableBuffer()
		n, err := c.conn.Read(buf[:cap(buf)])
		if err != nil {
			return 0, nil, err
		}
		if c.maxPacketLen != 0 {
			if n > c.maxPacketLen {
				return 0, nil, fmt.Errorf("dtls: exceeded maximum packet length")
			}
			c.bytesAvailableInPacket = c.maxPacketLen - n
		} else {
			c.bytesAvailableInPacket = 0
		}
		c.rawInput.Write(buf[:n])
		newPacket = true
	}

	// Consume the next record from the buffer.
	recordHeaderLen, n, typ, err := c.readDTLSRecordHeader(epoch, c.rawInput.Bytes())
	if err != nil {
		return 0, nil, err
	}
	if n > maxCiphertext || c.rawInput.Len() < recordHeaderLen+n {
		c.sendAlert(alertRecordOverflow)
		return 0, nil, c.in.setErrorLocked(fmt.Errorf("dtls: oversized record received with length %d", n))
	}
	b := c.rawInput.Next(recordHeaderLen + n)

	// Process message.
	ok, encTyp, data, alertValue := c.in.decrypt(epoch, recordHeaderLen, b)
	if !ok {
		// A real DTLS implementation would silently ignore bad records,
		// but we want to notice errors from the implementation under
		// test.
		return 0, nil, c.in.setErrorLocked(c.sendAlert(alertValue))
	}

	if typ == 0 {
		// readDTLSRecordHeader sets typ=0 when decoding the DTLS 1.3
		// record header. When the new record header format is used, the
		// type is returned by decrypt() in encTyp.
		typ = encTyp
	}

	if typ == recordTypeChangeCipherSpec || typ == recordTypeHandshake {
		// If this is not the first record in the flight, check if it was packed
		// efficiently.
		if c.lastRecordInFlight != nil {
			// 12-byte header + 1-byte fragment is the minimum to make progress.
			const handshakeBytesNeeded = 13
			if typ == recordTypeHandshake && c.lastRecordInFlight.typ == recordTypeHandshake && epoch.epoch == c.lastRecordInFlight.epoch {
				// The previous record was compatible with this one. The shim
				// should have fit more in this record before making a new one.
				// TODO(crbug.com/374991962): Enforce this for plaintext records
				// too.
				if c.lastRecordInFlight.bytesAvailable > handshakeBytesNeeded && epoch.epoch > 0 {
					return 0, nil, c.in.setErrorLocked(fmt.Errorf("dtls: previous handshake record had %d bytes available, but shim did not fit another fragment in it", c.lastRecordInFlight.bytesAvailable))
				}
			} else if newPacket {
				// The shim had to make a new record, but it did not need to
				// make a new packet if this record fit in the previous.
				bytesNeeded := 1
				if typ == recordTypeHandshake {
					bytesNeeded = handshakeBytesNeeded
				}
				bytesNeeded += recordHeaderLen + c.in.maxEncryptOverhead(epoch, bytesNeeded)
				if bytesNeeded < bytesAvailableInLastPacket {
					return 0, nil, c.in.setErrorLocked(fmt.Errorf("dtls: previous packet had %d bytes available, but shim did not fit record of type %d into it", bytesAvailableInLastPacket, typ))
				}
			}
		}

		// Save information about the current record, including how many more
		// bytes the shim could have added.
		recordBytesAvailable := c.bytesAvailableInPacket + c.rawInput.Len()
		if cbc, ok := epoch.cipher.(*cbcMode); ok {
			// It is possible that adding a byte would have added another block.
			recordBytesAvailable = max(0, recordBytesAvailable-cbc.BlockSize())
		}
		c.lastRecordInFlight = &dtlsRecordInfo{typ: typ, epoch: epoch.epoch, bytesAvailable: recordBytesAvailable}
	} else {
		c.lastRecordInFlight = nil
	}

	return typ, data, nil
}

func (c *Conn) dtlsWriteRecord(typ recordType, data []byte) (n int, err error) {
	epoch := &c.out.epoch

	// Outgoing DTLS records are buffered in several stages, to test the various
	// layers that data may be combined in.
	//
	// First, handshake and ChangeCipherSpec records are buffered in
	// c.nextFlight, to be flushed by dtlsWriteFlight.
	//
	// dtlsWriteFlight, with the aid of a test-supplied callback, will divide
	// them into handshake records containing fragments, possibly with some
	// rounds of shim retransmit tests. Those records and any other
	// non-handshake application data records are encrypted by dtlsPackRecord
	// into c.pendingPacket, which may combine multiple records into one packet.
	//
	// Finally, dtlsFlushPacket writes the packet to the shim.

	if typ == recordTypeChangeCipherSpec {
		// Don't send ChangeCipherSpec in DTLS 1.3.
		// TODO(crbug.com/42290594): Add an option to send them anyway and test
		// what our implementation does with unexpected ones.
		if c.vers >= VersionTLS13 {
			return
		}
		c.nextFlight = append(c.nextFlight, DTLSMessage{
			Epoch:              epoch.epoch,
			IsChangeCipherSpec: true,
			Data:               slices.Clone(data),
		})
		err = c.out.changeCipherSpec()
		if err != nil {
			return n, c.sendAlertLocked(alertLevelError, err.(alert))
		}
		return len(data), nil
	}
	if typ == recordTypeHandshake {
		// Handshake messages have to be modified to include fragment
		// offset and length and with the header replicated. Save the
		// TLS header here.
		header := data[:4]
		body := data[4:]

		c.nextFlight = append(c.nextFlight, DTLSMessage{
			Epoch:    epoch.epoch,
			Sequence: c.sendHandshakeSeq,
			Type:     header[0],
			Data:     slices.Clone(body),
		})
		c.sendHandshakeSeq++
		return len(data), nil
	}

	// Flush any packets buffered from the handshake.
	err = c.dtlsWriteFlight()
	if err != nil {
		return
	}

	if typ == recordTypeApplicationData && len(data) > 1 && c.config.Bugs.SplitAndPackAppData {
		_, _, err = c.dtlsPackRecord(epoch, typ, data[:len(data)/2], false)
		if err != nil {
			return
		}
		_, _, err = c.dtlsPackRecord(epoch, typ, data[len(data)/2:], true)
		if err != nil {
			return
		}
		n = len(data)
	} else {
		n, _, err = c.dtlsPackRecord(epoch, typ, data, false)
		if err != nil {
			return
		}
	}

	err = c.dtlsFlushPacket()
	return
}

// dtlsWriteFlight packs the pending handshake flight into the pending record.
// Callers should follow up with dtlsFlushPacket to write the packets.
func (c *Conn) dtlsWriteFlight() error {
	if len(c.nextFlight) == 0 {
		return nil
	}

	// Avoid re-entrancy issues by updating the state immediately. The callback
	// may try to write records.
	prev, received, next, records := c.previousFlight, c.receivedFlight, c.nextFlight, c.receivedFlightRecords
	c.previousFlight, c.receivedFlight, c.nextFlight, c.receivedFlightRecords = next, nil, nil, nil

	controller := newDTLSController(c, received)
	if c.config.Bugs.WriteFlightDTLS != nil {
		c.config.Bugs.WriteFlightDTLS(&controller, prev, received, next, records)
	} else {
		controller.WriteFlight(next)
	}
	if err := controller.Err(); err != nil {
		return err
	}

	if c.receivedFlight != nil || c.receivedFlightRecords != nil || c.nextFlight != nil {
		panic("tls: flight state changed while writing flight")
	}
	if controller.mergeIntoNextFlight {
		c.previousFlight, c.receivedFlight, c.nextFlight, c.receivedFlightRecords = prev, received, next, records
	}

	// Flush any ACKs, etc., we may have written.
	return c.dtlsFlushPacket()
}

func (c *Conn) dtlsFlushHandshake() error {
	if err := c.dtlsWriteFlight(); err != nil {
		return err
	}
	if err := c.dtlsFlushPacket(); err != nil {
		return err
	}

	return nil
}

func (c *Conn) dtlsACKHandshake() error {
	if len(c.receivedFlight) == 0 {
		return nil
	}

	if len(c.nextFlight) != 0 {
		panic("tls: not a final flight; more messages were queued up")
	}

	// Avoid re-entrancy issues by updating the state immediately. The callback
	// may try to write records.
	prev, received, records := c.previousFlight, c.receivedFlight, c.receivedFlightRecords
	c.previousFlight, c.receivedFlight, c.receivedFlightRecords = nil, nil, nil

	controller := newDTLSController(c, received)
	if c.config.Bugs.ACKFlightDTLS != nil {
		c.config.Bugs.ACKFlightDTLS(&controller, prev, received, records)
	} else {
		if c.vers >= VersionTLS13 {
			controller.WriteACK(controller.OutEpoch(), records)
		}
	}
	if err := controller.Err(); err != nil {
		return err
	}

	if c.previousFlight != nil || c.receivedFlight != nil || c.receivedFlightRecords != nil {
		panic("tls: flight state changed while ACKing flight")
	}
	if controller.mergeIntoNextFlight {
		c.previousFlight, c.receivedFlight, c.receivedFlightRecords = prev, received, records
	}

	// Flush any ACKs, etc., we may have written.
	return c.dtlsFlushPacket()
}

// appendDTLS13RecordHeader appends to b the record header for a record of length
// recordLen.
func (c *Conn) appendDTLS13RecordHeader(b, seq []byte, recordLen int) []byte {
	// Set the top 3 bits on the type byte to indicate the DTLS 1.3 record
	// header format.
	typ := byte(0x20)
	// Set the Connection ID bit
	if c.config.Bugs.DTLS13RecordHeaderSetCIDBit && c.handshakeComplete {
		typ |= 0x10
	}
	// Set the sequence number length bit
	if !c.config.DTLSUseShortSeqNums {
		typ |= 0x08
	}
	// Set the length presence bit
	if !c.config.DTLSRecordHeaderOmitLength {
		typ |= 0x04
	}
	// Set the epoch bits
	typ |= seq[1] & 0x3
	b = append(b, typ)
	if c.config.DTLSUseShortSeqNums {
		b = append(b, seq[7])
	} else {
		b = append(b, seq[6], seq[7])
	}
	if !c.config.DTLSRecordHeaderOmitLength {
		b = append(b, byte(recordLen>>8), byte(recordLen))
	}
	return b
}

// dtlsPackRecord packs a single record to the pending packet, flushing it
// if necessary. The caller should call dtlsFlushPacket to flush the current
// pending packet afterwards.
func (c *Conn) dtlsPackRecord(epoch *epochState, typ recordType, data []byte, mustPack bool) (n int, num DTLSRecordNumber, err error) {
	maxLen := c.config.Bugs.MaxHandshakeRecordLength
	if maxLen <= 0 {
		maxLen = 1024
	}

	vers := c.wireVersion
	if vers == 0 {
		// Some TLS servers fail if the record version is greater than
		// TLS 1.0 for the initial ClientHello.
		if c.isDTLS {
			vers = VersionDTLS10
		} else {
			vers = VersionTLS10
		}
	}
	if c.vers >= VersionTLS13 || c.out.version >= VersionTLS13 {
		vers = VersionDTLS12
	}

	useDTLS13RecordHeader := c.out.version >= VersionTLS13 && epoch.cipher != nil && !c.useDTLSPlaintextHeader()
	headerHasLength := true
	record := make([]byte, 0, dtlsMaxRecordHeaderLen+len(data)+c.out.maxEncryptOverhead(epoch, len(data)))
	seq := c.out.sequenceNumberForOutput(epoch)
	if useDTLS13RecordHeader {
		record = c.appendDTLS13RecordHeader(record, seq, len(data))
		headerHasLength = !c.config.DTLSRecordHeaderOmitLength
	} else {
		record = append(record, byte(typ))
		record = append(record, byte(vers>>8))
		record = append(record, byte(vers))
		// DTLS records include an explicit sequence number.
		record = append(record, seq...)
		record = append(record, byte(len(data)>>8))
		record = append(record, byte(len(data)))
	}

	recordHeaderLen := len(record)
	record, err = c.out.encrypt(epoch, record, data, typ, recordHeaderLen, headerHasLength)
	if err != nil {
		return
	}
	num = c.out.lastRecordNumber(epoch, true /* isOut */)

	// Encrypt the sequence number.
	if useDTLS13RecordHeader && !c.config.Bugs.NullAllCiphers {
		sample := record[recordHeaderLen:]
		mask := epoch.recordNumberEncrypter.generateMask(sample)
		seqLen := 2
		if c.config.DTLSUseShortSeqNums {
			seqLen = 1
		}
		// The sequence number starts at index 1 in the record header.
		xorSlice(record[1:1+seqLen], mask)
	}

	// Flush the current pending packet if necessary.
	if !mustPack && len(record)+len(c.pendingPacket) > c.config.Bugs.PackHandshakeRecords {
		err = c.dtlsFlushPacket()
		if err != nil {
			return
		}
	}

	// Add the record to the pending packet.
	c.pendingPacket = append(c.pendingPacket, record...)
	if c.config.DTLSRecordHeaderOmitLength {
		if c.config.Bugs.SplitAndPackAppData {
			panic("incompatible config")
		}
		err = c.dtlsFlushPacket()
		if err != nil {
			return
		}
	}
	n = len(data)
	return
}

func (c *Conn) dtlsFlushPacket() error {
	if c.hand.Len() == 0 {
		c.lastRecordInFlight = nil
	}
	if len(c.pendingPacket) == 0 {
		return nil
	}
	_, err := c.conn.Write(c.pendingPacket)
	c.pendingPacket = nil
	return err
}

func readDTLSFragment(s *cryptobyte.String) (DTLSFragment, error) {
	var f DTLSFragment
	var totLen, fragOffset uint32
	if !s.ReadUint8(&f.Type) ||
		!s.ReadUint24(&totLen) ||
		!s.ReadUint16(&f.Sequence) ||
		!s.ReadUint24(&fragOffset) ||
		!readUint24LengthPrefixedBytes(s, &f.Data) {
		return DTLSFragment{}, errors.New("dtls: bad handshake record")
	}
	f.TotalLength = int(totLen)
	f.Offset = int(fragOffset)
	if f.Offset > f.TotalLength || len(f.Data) > f.TotalLength-f.Offset {
		return DTLSFragment{}, errors.New("dtls: bad fragment offset")
	}
	// Although syntactically valid, the shim should never send empty fragments
	// of non-empty messages.
	if len(f.Data) == 0 && f.TotalLength != 0 {
		return DTLSFragment{}, errors.New("dtls: fragment makes no progress")
	}
	return f, nil
}

func (c *Conn) makeDTLSRecordNumberInfo(epoch *epochState, data []byte) (DTLSRecordNumberInfo, error) {
	info := DTLSRecordNumberInfo{DTLSRecordNumber: c.in.lastRecordNumber(epoch, false /* isOut */)}

	s := cryptobyte.String(data)
	first := true
	for !s.Empty() {
		f, err := readDTLSFragment(&s)
		if err != nil {
			return DTLSRecordNumberInfo{}, err
		}
		// This assumes the shim sent fragments in order. This isn't checked
		// here, but the caller will check when processing the fragments.
		if first {
			info.MessageStartSequence = f.Sequence
			info.MessageStartOffset = f.Offset
			first = false
		}
		info.MessageEndSequence = f.Sequence
		info.MessageEndOffset = f.Offset + len(f.Data)
	}

	return info, nil
}

func (c *Conn) dtlsDoReadHandshake() ([]byte, error) {
	// Assemble a full handshake message.  For test purposes, this
	// implementation assumes fragments arrive in order. It may
	// need to be cleverer if we ever test BoringSSL's retransmit
	// behavior.
	for len(c.handMsg) < 4+c.handMsgLen {
		// Get a new handshake record if the previous has been
		// exhausted.
		if c.hand.Len() == 0 {
			if err := c.in.err; err != nil {
				return nil, err
			}
			if err := c.readRecord(recordTypeHandshake); err != nil {
				return nil, err
			}
		}

		// Read the next fragment. It must fit entirely within
		// the record.
		s := cryptobyte.String(c.hand.Bytes())
		f, err := readDTLSFragment(&s)
		if err != nil {
			return nil, err
		}
		c.hand.Next(c.hand.Len() - len(s))

		// Check it's a fragment for the right message.
		if f.Sequence != c.recvHandshakeSeq {
			return nil, errors.New("dtls: bad handshake sequence number")
		}

		// Check that the length is consistent.
		if c.handMsg == nil {
			c.handMsgLen = f.TotalLength
			if c.handMsgLen > maxHandshake {
				return nil, c.in.setErrorLocked(c.sendAlert(alertInternalError))
			}
			// Start with the TLS handshake header,
			// without the DTLS bits.
			c.handMsg = []byte{f.Type, byte(f.TotalLength >> 16), byte(f.TotalLength >> 8), byte(f.TotalLength)}
		} else if f.TotalLength != c.handMsgLen {
			return nil, errors.New("dtls: bad handshake length")
		}

		// Add the fragment to the pending message.
		if 4+f.Offset != len(c.handMsg) {
			return nil, errors.New("dtls: bad fragment offset")
		}
		// If the message isn't complete, check that the peer could not have
		// fit more into the record.
		c.handMsg = append(c.handMsg, f.Data...)
		if len(c.handMsg) < 4+c.handMsgLen {
			if c.hand.Len() != 0 {
				return nil, errors.New("dtls: truncated handshake fragment was not last in the record")
			}
			if c.lastRecordInFlight.bytesAvailable > 0 {
				return nil, fmt.Errorf("dtls: handshake fragment was truncated, but record could have fit %d more bytes", c.lastRecordInFlight.bytesAvailable)
			}
		}

		// Sending part of the next flight implicitly ACKs the previous flight.
		// Having triggered this, the shim is expected to clear its ACK buffer.
		c.expectedACK = nil
	}
	c.recvHandshakeSeq++
	ret := c.handMsg
	c.handMsg, c.handMsgLen = nil, 0
	c.receivedFlight = append(c.receivedFlight, DTLSMessage{
		Epoch:    c.in.epoch.epoch,
		Type:     ret[0],
		Sequence: c.recvHandshakeSeq - 1,
		Data:     ret[4:],
	})
	return ret, nil
}

func (c *Conn) checkACK(data []byte) error {
	s := cryptobyte.String(data)
	var child cryptobyte.String
	if !s.ReadUint16LengthPrefixed(&child) || !s.Empty() {
		return fmt.Errorf("tls: could not parse ACK record")
	}

	var acks []DTLSRecordNumber
	for !child.Empty() {
		var num DTLSRecordNumber
		if !child.ReadUint64(&num.Epoch) || !child.ReadUint64(&num.Sequence) {
			return fmt.Errorf("tls: could not parse ACK record")
		}
		acks = append(acks, num)
	}

	// Determine the expected ACKs, if any.
	expected := c.expectedACK
	if len(expected) > shimConfig.MaxACKBuffer {
		expected = expected[len(expected)-shimConfig.MaxACKBuffer:]
	}

	// If we've configured a tighter MTU, the shim might have needed to truncate
	// the list. Tolerate this as long as the shim sent the more recent records
	// and still sent a plausible minimum number of ACKs.
	if c.maxPacketLen != 0 && len(acks) > 10 && len(acks) < len(expected) {
		expected = expected[len(expected)-len(acks):]
	}

	// The shim is expected to sort the record numbers in the ACK.
	expected = slices.Clone(expected)
	slices.SortFunc(expected, func(a, b DTLSRecordNumber) int {
		cmp1 := cmp.Compare(a.Epoch, b.Epoch)
		if cmp1 != 0 {
			return cmp1
		}
		return cmp.Compare(a.Sequence, b.Sequence)
	})

	if !slices.Equal(acks, expected) {
		return fmt.Errorf("tls: got ACKs %+v, but expected %+v", acks, expected)
	}

	return nil
}

// DTLSServer returns a new DTLS server side connection
// using conn as the underlying transport.
// The configuration config must be non-nil and must have
// at least one certificate.
func DTLSServer(conn net.Conn, config *Config) *Conn {
	c := &Conn{config: config, isDTLS: true, conn: conn}
	c.init()
	return c
}

// DTLSClient returns a new DTLS client side connection
// using conn as the underlying transport.
// The config cannot be nil: users must set either ServerHostname or
// InsecureSkipVerify in the config.
func DTLSClient(conn net.Conn, config *Config) *Conn {
	c := &Conn{config: config, isClient: true, isDTLS: true, conn: conn}
	c.init()
	return c
}

type WriteFlightFunc = func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo)
type ACKFlightFunc = func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo)

// A DTLSController is passed to a test callback and allows the callback to
// customize how an individual flight is sent. This is used to test DTLS's
// retransmission logic.
//
// Although DTLS runs over a lossy, reordered channel, runner assumes a
// reliable, ordered channel. When simulating packet loss, runner processes the
// shim's "lost" flight as usual. But, instead of responding, it calls a
// test-provided function type WriteFlightFunc.
//
// WriteFlight will be called next as the flight for the runner to send. prev is
// the previous flight sent by the runner, and received is the most recent
// flight received by the shim. prev and received may be nil if those flights do
// not exist.
//
// WriteFlight should send next to the shim, by calling methods on the
// DTLSController, and then return. The shim will then be expected to progress
// the connection. However, WriteFlight, may send fragments arbitrarily
// reordered or duplicated. It may also simulate packet loss with timeouts or
// retransmitted past fragments, and then test that the shim retransmits.
//
// WriteFlight must return as soon as the shim is expected to progress the
// connection. If WriteFlight expects the shim to send an alert, it must also
// return, at which point the logic to progress the connection will consume the
// alert and report it as a connection failure, to be captured in the test
// expectation.
//
// If unspecified, the default implementation of WriteFlight is:
//
//	func WriteFlight(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
//		c.WriteFlight(next)
//	}
//
// When the shim speaks last in a handshake or post-handshake transaction, there
// is no reply to implicitly acknowledge the flight. The runner will instead
// call a second callback type ACKFlightFunc.
//
// Like WriteFlight, ACKFlight may simulate packet loss with the DTLSController.
// It returns when it is ready to proceed. If not specified, it does nothing in
// DTLS 1.2 and ACKs the final flight in DTLS 1.3.
//
// This test design implicitly assumes the shim will never start a
// post-handshake transaction before the previous one is complete. Otherwise the
// retransmissions will get mixed up with the second transaction.
//
// For convenience, the DTLSController internally tracks whether it has
// encountered an error (e.g. an I/O error with the shim) and, if so, silently
// makes all methods do nothing. The Err method may be used to query if it is in
// this state, if it would otherwise cause an infinite loop.
type DTLSController struct {
	conn *Conn
	err  error
	// retransmitNeeded contains the list of fragments which the shim must
	// retransmit.
	retransmitNeeded    []DTLSFragment
	mergeIntoNextFlight bool
}

func newDTLSController(conn *Conn, received []DTLSMessage) DTLSController {
	var retransmitNeeded []DTLSFragment
	for i := range received {
		msg := &received[i]
		retransmitNeeded = append(retransmitNeeded, msg.Fragment(0, len(msg.Data)))
	}

	return DTLSController{conn: conn, retransmitNeeded: retransmitNeeded}
}

func (c *DTLSController) getOutEpochOrPanic(epochValue uint16) *epochState {
	epoch, ok := c.conn.out.getEpoch(epochValue)
	if !ok {
		panic(fmt.Sprintf("tls: could not find epoch %d", epochValue))
	}
	return epoch
}

func (c *DTLSController) getInEpochOrPanic(epochValue uint16) *epochState {
	epoch, ok := c.conn.in.getEpoch(epochValue)
	if !ok {
		panic(fmt.Sprintf("tls: could not find epoch %d", epochValue))
	}
	return epoch
}

// Err returns whether the controller has stopped due to an error, or nil
// otherwise. If it returns non-nil, other methods will silently do nothing.
func (c *DTLSController) Err() error { return c.err }

// OutEpoch returns the current outgoing epoch.
func (c *DTLSController) OutEpoch() uint16 {
	return c.conn.out.epoch.epoch
}

// InEpoch returns the current incoming epoch.
func (c *DTLSController) InEpoch() uint16 {
	return c.conn.in.epoch.epoch
}

// AdvanceClock advances the shim's clock by duration. It is a test failure if
// the shim sends anything before picking up the command.
func (c *DTLSController) AdvanceClock(duration time.Duration) {
	if c.err != nil {
		return
	}

	c.err = c.conn.dtlsFlushPacket()
	if c.err != nil {
		return
	}

	adaptor := c.conn.config.Bugs.PacketAdaptor
	if adaptor == nil {
		panic("tls: no PacketAdapter set")
	}

	received, err := adaptor.SendReadTimeout(duration)
	if err != nil {
		c.err = err
	} else if len(received) != 0 {
		c.err = fmt.Errorf("tls: received %d unexpected packets while simulating a timeout", len(received))
	}
}

// SetMTU updates the shim's MTU to mtu.
func (c *DTLSController) SetMTU(mtu int) {
	if c.err != nil {
		return
	}

	adaptor := c.conn.config.Bugs.PacketAdaptor
	if adaptor == nil {
		panic("tls: no PacketAdapter set")
	}

	c.conn.maxPacketLen = mtu
	c.err = adaptor.SetPeerMTU(mtu)
}

// WriteFlight writes msgs to the shim, using the default fragmenting logic.
// This may be used when the test is not concerned with fragmentation.
func (c *DTLSController) WriteFlight(msgs []DTLSMessage) {
	config := c.conn.config
	if c.err != nil {
		return
	}

	// Buffer up fragments to reorder them.
	var fragments []DTLSFragment

	// TODO(davidben): All this could also have been implemented in the custom
	// fallbacks. These options date to before we had the callback. Should some
	// of them be moved out?
	for _, msg := range msgs {
		if msg.IsChangeCipherSpec {
			fragments = append(fragments, msg.Fragment(0, len(msg.Data)))
			continue
		}

		maxLen := config.Bugs.MaxHandshakeRecordLength
		if maxLen <= 0 {
			maxLen = 1024
		}

		if config.Bugs.SendEmptyFragments {
			fragments = append(fragments, msg.Fragment(0, 0))
			fragments = append(fragments, msg.Fragment(len(msg.Data), 0))
		}

		firstRun := true
		fragOffset := 0
		for firstRun || fragOffset < len(msg.Data) {
			firstRun = false
			fragLen := min(len(msg.Data)-fragOffset, maxLen)

			fragment := msg.Fragment(fragOffset, fragLen)
			fragments = append(fragments, fragment)
			if config.Bugs.ReorderHandshakeFragments {
				// Don't duplicate Finished to avoid the peer
				// interpreting it as a retransmit request.
				if msg.Type != typeFinished {
					fragments = append(fragments, fragment)
				}

				if fragLen > (maxLen+1)/2 {
					// Overlap each fragment by half.
					fragLen = (maxLen + 1) / 2
				}
			}
			fragOffset += fragLen
		}
		if config.Bugs.MixCompleteMessageWithFragments {
			fragments = append(fragments, msg.Fragment(0, len(msg.Data)))
		}
	}

	// Reorder the fragments, but only within an epoch.
	for start := 0; start < len(fragments); {
		end := start + 1
		for end < len(fragments) && fragments[start].Epoch == fragments[end].Epoch {
			end++
		}
		chunk := fragments[start:end]
		if config.Bugs.ReorderHandshakeFragments {
			rand.Shuffle(len(chunk), func(i, j int) { chunk[i], chunk[j] = chunk[j], chunk[i] })
		}
		start = end
	}

	c.WriteFragments(fragments)
}

// WriteFragments writes the specified handshake fragments to the shim.
func (c *DTLSController) WriteFragments(fragments []DTLSFragment) {
	config := c.conn.config
	if c.err != nil {
		return
	}

	maxRecordLen := config.Bugs.PackHandshakeFragments
	packRecord := func(epoch *epochState, typ recordType, data []byte, anyDiscard bool) error {
		_, num, err := c.conn.dtlsPackRecord(epoch, typ, data, false)
		if err != nil {
			return err
		}
		if !anyDiscard && typ == recordTypeHandshake {
			c.conn.expectedACK = append(c.conn.expectedACK, num)
		}
		return nil
	}

	// Pack handshake fragments into records.
	var record []byte
	var epoch *epochState
	var anyDiscard bool
	flush := func() error {
		if len(record) > 0 {
			if err := packRecord(epoch, recordTypeHandshake, record, anyDiscard); err != nil {
				return err
			}
		}
		record = nil
		anyDiscard = false
		return nil
	}

	for i := range fragments {
		f := &fragments[i]
		if epoch != nil && (f.Epoch != epoch.epoch || f.IsChangeCipherSpec) {
			c.err = flush()
			if c.err != nil {
				return
			}
			epoch = nil
		}

		if epoch == nil {
			epoch = c.getOutEpochOrPanic(f.Epoch)
		}

		if f.IsChangeCipherSpec {
			c.err = packRecord(epoch, recordTypeChangeCipherSpec, f.Bytes(), false)
			if c.err != nil {
				return
			}
			continue
		}

		fBytes := f.Bytes()
		if n := config.Bugs.SplitFragments; n > 0 {
			if len(fBytes) > n {
				c.err = packRecord(epoch, recordTypeHandshake, fBytes[:n], f.ShouldDiscard)
				if c.err != nil {
					return
				}
				c.err = packRecord(epoch, recordTypeHandshake, fBytes[n:], f.ShouldDiscard)
				if c.err != nil {
					return
				}
			} else {
				c.err = packRecord(epoch, recordTypeHandshake, fBytes, f.ShouldDiscard)
				if c.err != nil {
					return
				}
			}
		} else {
			if len(record)+len(fBytes) > maxRecordLen {
				c.err = flush()
				if c.err != nil {
					return
				}
			}
			if f.ShouldDiscard {
				anyDiscard = true
			}
			record = append(record, fBytes...)
		}
	}

	c.err = flush()
}

// WriteACK writes the specified record numbers in an ACK record to the shim,
// and updates shim expectations according to the specified byte ranges. To send
// an ACK which the shim is expected to ignore (e.g. because it should have
// forgotten a packet number), use a DTLSRecordNumberInfo with the
// MessageStartSequence, etc., fields all set to zero.
func (c *DTLSController) WriteACK(epoch uint16, records []DTLSRecordNumberInfo) {
	if c.err != nil {
		return
	}

	// Send the ACK.
	ack := cryptobyte.NewBuilder(make([]byte, 0, 2+8*len(records)))
	ack.AddUint16LengthPrefixed(func(recordNumbers *cryptobyte.Builder) {
		for _, r := range records {
			recordNumbers.AddUint64(r.Epoch)
			recordNumbers.AddUint64(r.Sequence)
		}
	})
	_, _, c.err = c.conn.dtlsPackRecord(c.getOutEpochOrPanic(epoch), recordTypeACK, ack.BytesOrPanic(), false)
	if c.err != nil {
		return
	}

	// Update the list of expectations. This is inefficient, but is fine for
	// test code.
	for _, r := range records {
		if !r.HasACKInformation() {
			continue
		}
		var update []DTLSFragment
		for _, f := range c.retransmitNeeded {
			endOffset := f.Offset + len(f.Data)
			// Compute two, possibly empty, intersections: the fragment with
			// [0, ackStart) and the fragment with [ackStart, infinity).

			// First, the portion of the fragment that is before the ACK:
			if comparePair(f.Sequence, f.Offset, r.MessageStartSequence, r.MessageStartOffset) < 0 {
				// The fragment begins before the ACK.
				if comparePair(f.Sequence, endOffset, r.MessageStartSequence, r.MessageStartOffset) <= 0 {
					// The fragment ends before the ACK.
					update = append(update, f)
				} else {
					// The ACK starts in the middle of the fragment. Retain a
					// prefix of the fragment.
					prefix := f
					prefix.Data = f.Data[:r.MessageStartOffset-f.Offset]
					update = append(update, prefix)
				}
			}

			// Next, the portion of the fragment that is after the ACK:
			if comparePair(r.MessageEndSequence, r.MessageEndOffset, f.Sequence, endOffset) < 0 {
				// The fragment ends after the ACK.
				if comparePair(r.MessageEndSequence, r.MessageEndOffset, f.Sequence, f.Offset) <= 0 {
					// The fragment begins after the ACK.
					update = append(update, f)
				} else {
					// The ACK ends in the middle of the fragment. Retain a
					// suffix of the fragment.
					suffix := f
					suffix.Offset = r.MessageEndOffset
					suffix.Data = f.Data[r.MessageEndOffset-f.Offset:]
					update = append(update, suffix)
				}
			}
		}
		c.retransmitNeeded = update
	}
}

// ReadRetransmit indicates the shim is expected to retransmit its current
// flight and consumes the retransmission. It returns the record numbers of the
// retransmission, for the test to ACK if it chooses.
func (c *DTLSController) ReadRetransmit() []DTLSRecordNumberInfo {
	if c.err != nil {
		return nil
	}

	var ret []DTLSRecordNumberInfo
	ret, c.err = c.doReadRetransmit()
	return ret
}

func (c *DTLSController) doReadRetransmit() ([]DTLSRecordNumberInfo, error) {
	if err := c.conn.dtlsFlushPacket(); err != nil {
		return nil, err
	}

	var records []DTLSRecordNumberInfo
	expected := slices.Clone(c.retransmitNeeded)
	for len(expected) > 0 {
		// Read a record from the expected epoch. The peer should retransmit in
		// order.
		wantTyp := recordTypeHandshake
		if expected[0].IsChangeCipherSpec {
			wantTyp = recordTypeChangeCipherSpec
		}
		epoch := c.getInEpochOrPanic(expected[0].Epoch)
		// Retransmitted ClientHellos predate the shim learning the version.
		// Ideally we would enforce the initial record-layer version, but
		// post-HelloVerifyRequest ClientHellos and post-HelloRetryRequest
		// ClientHellos look the same, but have different expectations.
		c.conn.skipRecordVersionCheck = !expected[0].IsChangeCipherSpec && expected[0].Type == typeClientHello
		typ, data, err := c.conn.dtlsDoReadRecord(epoch, wantTyp)
		c.conn.skipRecordVersionCheck = false
		if err != nil {
			return nil, err
		}
		if typ != wantTyp {
			return nil, fmt.Errorf("tls: got record of type %d in retransmit, but expected %d", typ, wantTyp)
		}
		if typ == recordTypeChangeCipherSpec {
			if len(data) != 1 || data[0] != 1 {
				return nil, errors.New("tls: got invalid ChangeCipherSpec")
			}
			expected = expected[1:]
			continue
		}

		// Consume all the handshake fragments and match them to what we expect.
		s := cryptobyte.String(data)
		if s.Empty() {
			return nil, fmt.Errorf("tls: got empty record in retransmit")
		}
		for !s.Empty() {
			if len(expected) == 0 || expected[0].Epoch != epoch.epoch || expected[0].IsChangeCipherSpec {
				return nil, fmt.Errorf("tls: got excess data at epoch %d in retransmit", epoch.epoch)
			}

			exp := &expected[0]
			var f DTLSFragment
			f, err = readDTLSFragment(&s)
			if f.Type != exp.Type || f.TotalLength != exp.TotalLength || f.Sequence != exp.Sequence || f.Offset != exp.Offset {
				return nil, fmt.Errorf("tls: got offset %d of message %d (type %d, length %d), expected offset %d of message %d (type %d, length %d)", f.Offset, f.Sequence, f.Type, f.TotalLength, exp.Offset, exp.Sequence, exp.Type, exp.TotalLength)
			}
			if len(f.Data) > len(exp.Data) {
				return nil, fmt.Errorf("tls: got %d bytes at offset %d of message %d but only %d bytes were missing", len(f.Data), f.Offset, f.Sequence, len(exp.Data))
			}
			if !bytes.Equal(f.Data, exp.Data[:len(f.Data)]) {
				return nil, fmt.Errorf("tls: got %d bytes at offset %d of message %d but did not match original", len(f.Data), f.Offset, f.Sequence)
			}
			if len(f.Data) == len(exp.Data) {
				expected = expected[1:]
			} else {
				// We only got part of the fragment we wanted.
				exp.Offset += len(f.Data)
				exp.Data = exp.Data[len(f.Data):]
				// Check that the peer could not have fit more into the record.
				if !s.Empty() {
					return nil, errors.New("dtls: truncated handshake fragment was not last in the record")
				}
				if c.conn.lastRecordInFlight.bytesAvailable > 0 {
					return nil, fmt.Errorf("dtls: handshake fragment was truncated, but record could have fit %d more bytes", c.conn.lastRecordInFlight.bytesAvailable)
				}
			}
		}

		record, err := c.conn.makeDTLSRecordNumberInfo(epoch, data)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

// ReadACK indicates the shim is expected to send an ACK at the specified epoch.
// The contents of the ACK are checked against the connection's internal
// simulation of the shim's expected behavior.
func (c *DTLSController) ReadACK(epoch uint16) {
	if c.err != nil {
		return
	}

	c.err = c.conn.dtlsFlushPacket()
	if c.err != nil {
		return
	}

	typ, data, err := c.conn.dtlsDoReadRecord(c.getInEpochOrPanic(epoch), recordTypeACK)
	if err != nil {
		c.err = err
		return
	}
	if typ != recordTypeACK {
		c.err = fmt.Errorf("tls: got record of type %d, but expected ACK", typ)
		return
	}

	c.err = c.conn.checkACK(data)
}

// WriteAppData writes an application data record to the shim. This may be used
// to test that post-handshake retransmits may interleave with application data.
func (c *DTLSController) WriteAppData(epoch uint16, data []byte) {
	if c.err != nil {
		return
	}

	_, _, c.err = c.conn.dtlsPackRecord(c.getOutEpochOrPanic(epoch), recordTypeApplicationData, data, false)
}

// ReadAppData indicates the shim is expected to send the specified application
// data record. This may be used to test that post-handshake retransmits may
// interleave with application data.
func (c *DTLSController) ReadAppData(epoch uint16, expected []byte) {
	if c.err != nil {
		return
	}

	if err := c.conn.dtlsFlushPacket(); err != nil {
		c.err = err
		return
	}

	typ, data, err := c.conn.dtlsDoReadRecord(c.getInEpochOrPanic(epoch), recordTypeApplicationData)
	if err != nil {
		c.err = err
		return
	}
	if typ != recordTypeApplicationData {
		c.err = fmt.Errorf("tls: got record of type %d, but expected application data", typ)
		return
	}
	if !bytes.Equal(data, expected) {
		c.err = fmt.Errorf("tls: got app data record containing %x, but expected %x", data, expected)
		return
	}
}

// ExpectNextTimeout indicates the shim's next timeout should be d from now.
func (c *DTLSController) ExpectNextTimeout(d time.Duration) {
	if c.err != nil {
		return
	}
	if err := c.conn.dtlsFlushPacket(); err != nil {
		c.err = err
		return
	}
	c.err = c.conn.config.Bugs.PacketAdaptor.ExpectNextTimeout(d)
}

// ExpectNoNext indicates the shim should not have a next timeout.
func (c *DTLSController) ExpectNoNextTimeout() {
	if c.err != nil {
		return
	}
	if err := c.conn.dtlsFlushPacket(); err != nil {
		c.err = err
		return
	}
	c.err = c.conn.config.Bugs.PacketAdaptor.ExpectNoNextTimeout()
}

// MergeIntoNextFlight indicates the state from this flight should be merged
// into the next WriteFlight or ACKFlight call. This allows the test to control
// two independent post-handshake messages as a single unit.
func (c *DTLSController) MergeIntoNextFlight() {
	c.mergeIntoNextFlight = true
}
