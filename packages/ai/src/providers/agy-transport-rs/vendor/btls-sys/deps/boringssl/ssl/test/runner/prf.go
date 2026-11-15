// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"crypto"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding"
	"hash"

	"golang.org/x/crypto/cryptobyte"
)

// copyHash returns a copy of |h|, which must be an instance of |hashType|.
func copyHash(h hash.Hash, hash crypto.Hash) hash.Hash {
	// While hash.Hash is not copyable, the documentation says all standard
	// library hash.Hash implementations implement BinaryMarshaler and
	// BinaryUnmarshaler interfaces.
	m, ok := h.(encoding.BinaryMarshaler)
	if !ok {
		panic("hash did not implement encoding.BinaryMarshaler")
	}
	data, err := m.MarshalBinary()
	if err != nil {
		panic(err)
	}
	ret := hash.New()
	u, ok := ret.(encoding.BinaryUnmarshaler)
	if !ok {
		panic("hash did not implement BinaryUnmarshaler")
	}
	if err := u.UnmarshalBinary(data); err != nil {
		panic(err)
	}
	return ret
}

// Split a premaster secret in two as specified in RFC 4346, section 5.
func splitPreMasterSecret(secret []byte) (s1, s2 []byte) {
	s1 = secret[0 : (len(secret)+1)/2]
	s2 = secret[len(secret)/2:]
	return
}

// pHash implements the P_hash function, as defined in RFC 4346, section 5.
func pHash(result, secret, seed []byte, hash func() hash.Hash) {
	h := hmac.New(hash, secret)
	h.Write(seed)
	a := h.Sum(nil)

	j := 0
	for j < len(result) {
		h.Reset()
		h.Write(a)
		h.Write(seed)
		b := h.Sum(nil)
		todo := len(b)
		if j+todo > len(result) {
			todo = len(result) - j
		}
		copy(result[j:j+todo], b)
		j += todo

		h.Reset()
		h.Write(a)
		a = h.Sum(nil)
	}
}

// prf10 implements the TLS 1.0 pseudo-random function, as defined in RFC 2246, section 5.
func prf10(result, secret, label, seed []byte) {
	hashSHA1 := sha1.New
	hashMD5 := md5.New

	labelAndSeed := make([]byte, len(label)+len(seed))
	copy(labelAndSeed, label)
	copy(labelAndSeed[len(label):], seed)

	s1, s2 := splitPreMasterSecret(secret)
	pHash(result, s1, labelAndSeed, hashMD5)
	result2 := make([]byte, len(result))
	pHash(result2, s2, labelAndSeed, hashSHA1)

	for i, b := range result2 {
		result[i] ^= b
	}
}

// prf12 implements the TLS 1.2 pseudo-random function, as defined in RFC 5246, section 5.
func prf12(hashFunc func() hash.Hash) func(result, secret, label, seed []byte) {
	return func(result, secret, label, seed []byte) {
		labelAndSeed := make([]byte, len(label)+len(seed))
		copy(labelAndSeed, label)
		copy(labelAndSeed[len(label):], seed)

		pHash(result, secret, labelAndSeed, hashFunc)
	}
}

const (
	tlsRandomLength      = 32 // Length of a random nonce in TLS 1.1.
	masterSecretLength   = 48 // Length of a master secret in TLS 1.1.
	finishedVerifyLength = 12 // Length of verify_data in a Finished message.
)

var masterSecretLabel = []byte("master secret")
var extendedMasterSecretLabel = []byte("extended master secret")
var keyExpansionLabel = []byte("key expansion")
var clientFinishedLabel = []byte("client finished")
var serverFinishedLabel = []byte("server finished")
var finishedLabel = []byte("finished")
var channelIDLabel = []byte("TLS Channel ID signature\x00")
var channelIDResumeLabel = []byte("Resumption\x00")

func prfForVersion(version uint16, suite *cipherSuite) func(result, secret, label, seed []byte) {
	switch version {
	case VersionTLS10, VersionTLS11:
		return prf10
	case VersionTLS12:
		return prf12(suite.hash().New)
	}
	panic("unknown version")
}

// masterFromPreMasterSecret generates the master secret from the pre-master
// secret. See http://tools.ietf.org/html/rfc5246#section-8.1
func masterFromPreMasterSecret(version uint16, suite *cipherSuite, preMasterSecret, clientRandom, serverRandom []byte) []byte {
	var seed [tlsRandomLength * 2]byte
	copy(seed[0:len(clientRandom)], clientRandom)
	copy(seed[len(clientRandom):], serverRandom)
	masterSecret := make([]byte, masterSecretLength)
	prfForVersion(version, suite)(masterSecret, preMasterSecret, masterSecretLabel, seed[0:])
	return masterSecret
}

// extendedMasterFromPreMasterSecret generates the master secret from the
// pre-master secret when the Triple Handshake fix is in effect. See
// https://tools.ietf.org/html/rfc7627
func extendedMasterFromPreMasterSecret(version uint16, suite *cipherSuite, preMasterSecret []byte, h finishedHash) []byte {
	masterSecret := make([]byte, masterSecretLength)
	prfForVersion(version, suite)(masterSecret, preMasterSecret, extendedMasterSecretLabel, h.Sum())
	return masterSecret
}

// keysFromMasterSecret generates the connection keys from the master
// secret, given the lengths of the MAC key, cipher key and IV, as defined in
// RFC 2246, section 6.3.
func keysFromMasterSecret(version uint16, suite *cipherSuite, masterSecret, clientRandom, serverRandom []byte, macLen, keyLen, ivLen int) (clientMAC, serverMAC, clientKey, serverKey, clientIV, serverIV []byte) {
	var seed [tlsRandomLength * 2]byte
	copy(seed[0:len(clientRandom)], serverRandom)
	copy(seed[len(serverRandom):], clientRandom)

	n := 2*macLen + 2*keyLen + 2*ivLen
	keyMaterial := make([]byte, n)
	prfForVersion(version, suite)(keyMaterial, masterSecret, keyExpansionLabel, seed[0:])
	clientMAC = keyMaterial[:macLen]
	keyMaterial = keyMaterial[macLen:]
	serverMAC = keyMaterial[:macLen]
	keyMaterial = keyMaterial[macLen:]
	clientKey = keyMaterial[:keyLen]
	keyMaterial = keyMaterial[keyLen:]
	serverKey = keyMaterial[:keyLen]
	keyMaterial = keyMaterial[keyLen:]
	clientIV = keyMaterial[:ivLen]
	keyMaterial = keyMaterial[ivLen:]
	serverIV = keyMaterial[:ivLen]
	return
}

func newFinishedHash(wireVersion uint16, isDTLS bool, cipherSuite *cipherSuite) finishedHash {
	version, ok := wireToVersion(wireVersion, isDTLS)
	if !ok {
		panic("unknown version")
	}

	var ret finishedHash
	if version >= VersionTLS12 {
		ret.hash = cipherSuite.hash().New()

		if version == VersionTLS12 {
			ret.prf = prf12(cipherSuite.hash().New)
		} else {
			ret.secret = make([]byte, ret.hash.Size())
		}
	} else {
		ret.hash = sha1.New()
		ret.md5 = md5.New()

		ret.prf = prf10
	}

	ret.suite = cipherSuite
	ret.buffer = []byte{}
	ret.version = version
	ret.wireVersion = wireVersion
	ret.isDTLS = isDTLS
	return ret
}

// A finishedHash calculates the hash of a set of handshake messages suitable
// for including in a Finished message.
type finishedHash struct {
	suite *cipherSuite

	// hash maintains a running hash of handshake messages. In TLS 1.2 and up,
	// the hash is determined from suite.hash(). In TLS 1.0 and 1.1, this is the
	// SHA-1 half of the MD5/SHA-1 concatenation.
	hash hash.Hash

	// md5 is the MD5 half of the TLS 1.0 and 1.1 MD5/SHA1 concatenation.
	md5 hash.Hash

	// In TLS 1.2, a full buffer is required.
	buffer []byte

	version     uint16
	wireVersion uint16
	isDTLS      bool
	prf         func(result, secret, label, seed []byte)

	// secret, in TLS 1.3, is the running input secret.
	secret []byte
}

func (h *finishedHash) UpdateForHelloRetryRequest() {
	data := cryptobyte.NewBuilder(nil)
	data.AddUint8(typeMessageHash)
	data.AddUint24(uint32(h.hash.Size()))
	data.AddBytes(h.Sum())
	h.hash = h.suite.hash().New()
	if h.buffer != nil {
		h.buffer = []byte{}
	}
	h.Write(data.BytesOrPanic())
}

func (h *finishedHash) Write(msg []byte) (n int, err error) {
	h.hash.Write(msg)

	if h.version < VersionTLS12 {
		h.md5.Write(msg)
	}

	if h.buffer != nil {
		h.buffer = append(h.buffer, msg...)
	}

	return len(msg), nil
}

// WriteHandshake appends |msg| to the hash, which must be a serialized
// handshake message with a TLS header. In DTLS, the header is rewritten to a
// DTLS header with |seqno| as the sequence number.
func (h *finishedHash) WriteHandshake(msg []byte, seqno uint16) {
	if h.isDTLS && h.version <= VersionTLS12 {
		// This is somewhat hacky. DTLS <= 1.2 hashes a slightly different format. (DTLS 1.3 uses the same format as TLS.)
		// First, the TLS header.
		h.Write(msg[:4])
		// Then the sequence number and reassembled fragment offset (always 0).
		h.Write([]byte{byte(seqno >> 8), byte(seqno), 0, 0, 0})
		// Then the reassembled fragment (always equal to the message length).
		h.Write(msg[1:4])
		// And then the message body.
		h.Write(msg[4:])
	} else {
		h.Write(msg)
	}
}

func (h finishedHash) Sum() []byte {
	if h.version >= VersionTLS12 {
		return h.hash.Sum(nil)
	}

	out := make([]byte, 0, md5.Size+sha1.Size)
	out = h.md5.Sum(out)
	return h.hash.Sum(out)
}

// clientSum returns the contents of the verify_data member of a client's
// Finished message.
func (h finishedHash) clientSum(baseKey []byte) []byte {
	if h.version < VersionTLS13 {
		out := make([]byte, finishedVerifyLength)
		h.prf(out, baseKey, clientFinishedLabel, h.Sum())
		return out
	}

	clientFinishedKey := hkdfExpandLabel(h.suite.hash(), baseKey, finishedLabel, nil, h.hash.Size(), h.isDTLS)
	finishedHMAC := hmac.New(h.suite.hash().New, clientFinishedKey)
	finishedHMAC.Write(h.appendContextHashes(nil))
	return finishedHMAC.Sum(nil)
}

// serverSum returns the contents of the verify_data member of a server's
// Finished message.
func (h finishedHash) serverSum(baseKey []byte) []byte {
	if h.version < VersionTLS13 {
		out := make([]byte, finishedVerifyLength)
		h.prf(out, baseKey, serverFinishedLabel, h.Sum())
		return out
	}

	serverFinishedKey := hkdfExpandLabel(h.suite.hash(), baseKey, finishedLabel, nil, h.hash.Size(), h.isDTLS)
	finishedHMAC := hmac.New(h.suite.hash().New, serverFinishedKey)
	finishedHMAC.Write(h.appendContextHashes(nil))
	return finishedHMAC.Sum(nil)
}

// hashForChannelID returns the hash to be signed for TLS Channel
// ID. If a resumption, resumeHash has the previous handshake
// hash. Otherwise, it is nil.
func (h finishedHash) hashForChannelID(resumeHash []byte) []byte {
	hash := sha256.New()
	hash.Write(channelIDLabel)
	if resumeHash != nil {
		hash.Write(channelIDResumeLabel)
		hash.Write(resumeHash)
	}
	hash.Write(h.Sum())
	return hash.Sum(nil)
}

// discardHandshakeBuffer is called when there is no more need to
// buffer the entirety of the handshake messages.
func (h *finishedHash) discardHandshakeBuffer() {
	h.buffer = nil
}

// zeroSecretTLS13 returns the default all zeros secret for TLS 1.3, used when a
// given secret is not available in the handshake. See RFC 8446, section 7.1.
func (h *finishedHash) zeroSecret() []byte {
	return make([]byte, h.hash.Size())
}

// addEntropy incorporates ikm into the running TLS 1.3 secret with HKDF-Expand.
func (h *finishedHash) addEntropy(ikm []byte) {
	var err error
	h.secret, err = hkdf.Extract(h.suite.hash().New, ikm, h.secret)
	if err != nil {
		panic(err)
	}
}

func (h *finishedHash) nextSecret() {
	h.secret = hkdfExpandLabel(h.suite.hash(), h.secret, []byte("derived"), h.suite.hash().New().Sum(nil), h.hash.Size(), h.isDTLS)
}

// hkdfExpandLabel implements TLS 1.3's HKDF-Expand-Label function, as defined
// in section 7.1 of RFC 8446.
func hkdfExpandLabel(hash crypto.Hash, secret, label, hashValue []byte, length int, isDTLS bool) []byte {
	if len(label) > 255 || len(hashValue) > 255 {
		panic("hkdfExpandLabel: label or hashValue too long")
	}

	versionLabel := []byte("tls13 ")
	if isDTLS {
		versionLabel = []byte("dtls13")
	}
	hkdfLabel := make([]byte, 3+len(versionLabel)+len(label)+1+len(hashValue))
	x := hkdfLabel
	x[0] = byte(length >> 8)
	x[1] = byte(length)
	x[2] = byte(len(versionLabel) + len(label))
	x = x[3:]
	copy(x, versionLabel)
	x = x[len(versionLabel):]
	copy(x, label)
	x = x[len(label):]
	x[0] = byte(len(hashValue))
	copy(x[1:], hashValue)
	ret, err := hkdf.Expand(hash.New, secret, string(hkdfLabel), length)
	if err != nil {
		panic(err)
	}
	return ret
}

// appendContextHashes returns the concatenation of the handshake hash and the
// resumption context hash, as used in TLS 1.3.
func (h *finishedHash) appendContextHashes(b []byte) []byte {
	b = h.hash.Sum(b)
	return b
}

var (
	externalPSKBinderLabel        = []byte("ext binder")
	resumptionPSKBinderLabel      = []byte("res binder")
	earlyTrafficLabel             = []byte("c e traffic")
	clientHandshakeTrafficLabel   = []byte("c hs traffic")
	serverHandshakeTrafficLabel   = []byte("s hs traffic")
	clientApplicationTrafficLabel = []byte("c ap traffic")
	serverApplicationTrafficLabel = []byte("s ap traffic")
	applicationTrafficLabel       = []byte("traffic upd")
	earlyExporterLabel            = []byte("e exp master")
	exporterLabel                 = []byte("exp master")
	resumptionLabel               = []byte("res master")

	resumptionPSKLabel = []byte("resumption")

	echAcceptConfirmationLabel    = []byte("ech accept confirmation")
	echAcceptConfirmationHRRLabel = []byte("hrr ech accept confirmation")
)

// deriveSecret implements TLS 1.3's Derive-Secret function, as defined in
// section 7.1 of RFC8446.
func (h *finishedHash) deriveSecret(label []byte) []byte {
	return hkdfExpandLabel(h.suite.hash(), h.secret, label, h.appendContextHashes(nil), h.hash.Size(), h.isDTLS)
}

// echAcceptConfirmation computes the ECH accept confirmation signal, as defined
// in sections 7.2 and 7.2.1 of draft-ietf-tls-esni-13. The transcript hash is
// computed by concatenating |h| with |extraMessages|.
func (h *finishedHash) echAcceptConfirmation(clientRandom, label, extraMessages []byte) []byte {
	secret, err := hkdf.Extract(h.suite.hash().New, clientRandom, h.zeroSecret())
	if err != nil {
		panic(err)
	}
	hashCopy := copyHash(h.hash, h.suite.hash())
	hashCopy.Write(extraMessages)
	return hkdfExpandLabel(h.suite.hash(), secret, label, hashCopy.Sum(nil), echAcceptConfirmationLength, h.isDTLS)
}

// The following are context strings for CertificateVerify in TLS 1.3.
var (
	clientCertificateVerifyContextTLS13 = []byte("TLS 1.3, client CertificateVerify")
	serverCertificateVerifyContextTLS13 = []byte("TLS 1.3, server CertificateVerify")
	channelIDContextTLS13               = []byte("TLS 1.3, Channel ID")
)

// certificateVerifyMessage returns the input to be signed for CertificateVerify
// in TLS 1.3.
func (h *finishedHash) certificateVerifyInput(context []byte) []byte {
	const paddingLen = 64
	b := make([]byte, paddingLen, paddingLen+len(context)+1+2*h.hash.Size())
	for i := 0; i < paddingLen; i++ {
		b[i] = 32
	}
	b = append(b, context...)
	b = append(b, 0)
	b = h.appendContextHashes(b)
	return b
}

type trafficDirection int

const (
	clientWrite trafficDirection = iota
	serverWrite
)

var (
	keyTLS13 = []byte("key")
	ivTLS13  = []byte("iv")
)

// deriveTrafficAEAD derives traffic keys and constructs an AEAD given a traffic
// secret.
func deriveTrafficAEAD(version uint16, suite *cipherSuite, secret []byte, side trafficDirection, isDTLS bool) any {
	key := hkdfExpandLabel(suite.hash(), secret, keyTLS13, nil, suite.keyLen, isDTLS)
	iv := hkdfExpandLabel(suite.hash(), secret, ivTLS13, nil, suite.ivLen(version), isDTLS)

	return suite.aead(version, key, iv)
}

func updateTrafficSecret(hash crypto.Hash, version uint16, secret []byte, isDTLS bool) []byte {
	return hkdfExpandLabel(hash, secret, applicationTrafficLabel, nil, hash.Size(), isDTLS)
}

func computePSKBinder(psk []byte, version uint16, isDTLS bool, label []byte, cipherSuite *cipherSuite, clientHello, helloRetryRequest, truncatedHello []byte) []byte {
	finishedHash := newFinishedHash(version, isDTLS, cipherSuite)
	finishedHash.addEntropy(psk)
	binderKey := finishedHash.deriveSecret(label)
	finishedHash.Write(clientHello)
	if len(helloRetryRequest) != 0 {
		finishedHash.UpdateForHelloRetryRequest()
	}
	finishedHash.Write(helloRetryRequest)
	finishedHash.Write(truncatedHello)
	return finishedHash.clientSum(binderKey)
}

func deriveSessionPSK(suite *cipherSuite, version uint16, masterSecret []byte, nonce []byte, isDTLS bool) []byte {
	hash := suite.hash()
	return hkdfExpandLabel(hash, masterSecret, resumptionPSKLabel, nonce, hash.Size(), isDTLS)
}
