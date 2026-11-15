// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"hash"
	"slices"

	"golang.org/x/crypto/chacha20poly1305"
)

// a keyAgreement implements the client and server side of a TLS key agreement
// protocol by generating and processing key exchange messages.
type keyAgreement interface {
	// On the server side, the first two methods are called in order.

	// In the case that the key agreement protocol doesn't use a
	// ServerKeyExchange message, generateServerKeyExchange can return nil,
	// nil.
	generateServerKeyExchange(*Config, *Credential, *clientHelloMsg, *serverHelloMsg, uint16) (*serverKeyExchangeMsg, error)
	processClientKeyExchange(*Config, *Credential, *clientKeyExchangeMsg, uint16) ([]byte, error)

	// On the client side, the next two methods are called in order.

	// This method may not be called if the server doesn't send a
	// ServerKeyExchange message.
	processServerKeyExchange(*Config, *clientHelloMsg, *serverHelloMsg, crypto.PublicKey, *serverKeyExchangeMsg) error
	generateClientKeyExchange(*Config, *clientHelloMsg, *x509.Certificate) ([]byte, *clientKeyExchangeMsg, error)

	// peerSignatureAlgorithm returns the signature algorithm used by the
	// peer, or zero if not applicable.
	peerSignatureAlgorithm() signatureAlgorithm
}

const (
	// suiteECDH indicates that the cipher suite involves elliptic curve
	// Diffie-Hellman. This means that it should only be selected when the
	// client indicates that it supports ECC with a curve and point format
	// that we're happy with.
	suiteECDHE = 1 << iota
	// suiteECDSA indicates that the cipher suite involves an ECDSA
	// signature and therefore may only be selected when the server's
	// certificate is ECDSA. If this is not set then the cipher suite is
	// RSA based.
	suiteECDSA
	// suiteTLS12 indicates that the cipher suite should only be advertised
	// and accepted when using TLS 1.2 or greater.
	suiteTLS12
	// suiteTLS13 indicates that the cipher suite can be used with TLS 1.3.
	// Cipher suites lacking this flag may not be used with TLS 1.3.
	suiteTLS13
	// suiteSHA384 indicates that the cipher suite uses SHA384 as the
	// handshake hash.
	suiteSHA384
	// suitePSK indicates that the cipher suite authenticates with
	// a pre-shared key rather than a server private key.
	suitePSK
)

type tlsAead struct {
	cipher.AEAD
	explicitNonce bool
}

// A cipherSuite is a specific combination of key agreement, cipher and MAC
// function. All cipher suites currently assume RSA key agreement.
type cipherSuite struct {
	id uint16
	// the lengths, in bytes, of the key material needed for each component.
	keyLen int
	macLen int
	ivLen  func(version uint16) int
	ka     func(version uint16) keyAgreement
	// flags is a bitmask of the suite* values, above.
	flags  int
	cipher func(key, iv []byte, isRead bool) any
	mac    func(version uint16, macKey []byte) macFunction
	aead   func(version uint16, key, fixedNonce []byte) *tlsAead
}

func (cs cipherSuite) hash() crypto.Hash {
	if cs.flags&suiteSHA384 != 0 {
		return crypto.SHA384
	}
	return crypto.SHA256
}

var cipherSuites = []*cipherSuite{
	{TLS_CHACHA20_POLY1305_SHA256, 32, 0, ivLenChaCha20Poly1305, nil, suiteTLS13, nil, nil, aeadCHACHA20POLY1305},
	{TLS_AES_128_GCM_SHA256, 16, 0, ivLenAESGCM, nil, suiteTLS13, nil, nil, aeadAESGCM},
	{TLS_AES_256_GCM_SHA384, 32, 0, ivLenAESGCM, nil, suiteTLS13 | suiteSHA384, nil, nil, aeadAESGCM},
	{TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 32, 0, ivLenChaCha20Poly1305, ecdheECDSAKA, suiteECDHE | suiteECDSA | suiteTLS12, nil, nil, aeadCHACHA20POLY1305},
	{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 32, 0, ivLenChaCha20Poly1305, ecdheRSAKA, suiteECDHE | suiteTLS12, nil, nil, aeadCHACHA20POLY1305},
	{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 16, 0, ivLenAESGCM, ecdheRSAKA, suiteECDHE | suiteTLS12, nil, nil, aeadAESGCM},
	{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 16, 0, ivLenAESGCM, ecdheECDSAKA, suiteECDHE | suiteECDSA | suiteTLS12, nil, nil, aeadAESGCM},
	{TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, 32, 0, ivLenAESGCM, ecdheRSAKA, suiteECDHE | suiteTLS12 | suiteSHA384, nil, nil, aeadAESGCM},
	{TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, 32, 0, ivLenAESGCM, ecdheECDSAKA, suiteECDHE | suiteECDSA | suiteTLS12 | suiteSHA384, nil, nil, aeadAESGCM},
	{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256, 16, 32, ivLenAES, ecdheRSAKA, suiteECDHE | suiteTLS12, cipherAES, macSHA256, nil},
	{TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256, 16, 32, ivLenAES, ecdheECDSAKA, suiteECDHE | suiteECDSA | suiteTLS12, cipherAES, macSHA256, nil},
	{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA, 16, 20, ivLenAES, ecdheRSAKA, suiteECDHE, cipherAES, macSHA1, nil},
	{TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, 16, 20, ivLenAES, ecdheECDSAKA, suiteECDHE | suiteECDSA, cipherAES, macSHA1, nil},
	{TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384, 32, 48, ivLenAES, ecdheRSAKA, suiteECDHE | suiteTLS12 | suiteSHA384, cipherAES, macSHA384, nil},
	{TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384, 32, 48, ivLenAES, ecdheECDSAKA, suiteECDHE | suiteECDSA | suiteTLS12 | suiteSHA384, cipherAES, macSHA384, nil},
	{TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA, 32, 20, ivLenAES, ecdheRSAKA, suiteECDHE, cipherAES, macSHA1, nil},
	{TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, 32, 20, ivLenAES, ecdheECDSAKA, suiteECDHE | suiteECDSA, cipherAES, macSHA1, nil},
	{TLS_RSA_WITH_AES_128_GCM_SHA256, 16, 0, ivLenAESGCM, rsaKA, suiteTLS12, nil, nil, aeadAESGCM},
	{TLS_RSA_WITH_AES_256_GCM_SHA384, 32, 0, ivLenAESGCM, rsaKA, suiteTLS12 | suiteSHA384, nil, nil, aeadAESGCM},
	{TLS_RSA_WITH_AES_128_CBC_SHA256, 16, 32, ivLenAES, rsaKA, suiteTLS12, cipherAES, macSHA256, nil},
	{TLS_RSA_WITH_AES_256_CBC_SHA256, 32, 32, ivLenAES, rsaKA, suiteTLS12, cipherAES, macSHA256, nil},
	{TLS_RSA_WITH_AES_128_CBC_SHA, 16, 20, ivLenAES, rsaKA, 0, cipherAES, macSHA1, nil},
	{TLS_RSA_WITH_AES_256_CBC_SHA, 32, 20, ivLenAES, rsaKA, 0, cipherAES, macSHA1, nil},
	{TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA, 24, 20, ivLen3DES, ecdheRSAKA, suiteECDHE, cipher3DES, macSHA1, nil},
	{TLS_RSA_WITH_3DES_EDE_CBC_SHA, 24, 20, ivLen3DES, rsaKA, 0, cipher3DES, macSHA1, nil},
	{TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256, 32, 0, ivLenChaCha20Poly1305, ecdhePSKKA, suiteECDHE | suitePSK | suiteTLS12, nil, nil, aeadCHACHA20POLY1305},
	{TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA, 16, 20, ivLenAES, ecdhePSKKA, suiteECDHE | suitePSK, cipherAES, macSHA1, nil},
	{TLS_ECDHE_PSK_WITH_AES_256_CBC_SHA, 32, 20, ivLenAES, ecdhePSKKA, suiteECDHE | suitePSK, cipherAES, macSHA1, nil},
	{TLS_PSK_WITH_AES_128_CBC_SHA, 16, 20, ivLenAES, pskKA, suitePSK, cipherAES, macSHA1, nil},
	{TLS_PSK_WITH_AES_256_CBC_SHA, 32, 20, ivLenAES, pskKA, suitePSK, cipherAES, macSHA1, nil},
}

func ivLenChaCha20Poly1305(vers uint16) int {
	return 12
}

func ivLenAESGCM(vers uint16) int {
	if vers >= VersionTLS13 {
		return 12
	}
	return 4
}

func ivLenAES(vers uint16) int {
	return 16
}

func ivLen3DES(vers uint16) int {
	return 8
}

type nullCipher struct{}

func cipherNull(key, iv []byte, isRead bool) any {
	return nullCipher{}
}

type cbcMode struct {
	cipher.BlockMode
	new func(iv []byte) cipher.BlockMode
}

func (c *cbcMode) SetIV(iv []byte) {
	c.BlockMode = c.new(iv)
}

func cipher3DES(key, iv []byte, isRead bool) any {
	c := &cbcMode{}
	block, _ := des.NewTripleDESCipher(key)
	if isRead {
		c.new = func(iv []byte) cipher.BlockMode { return cipher.NewCBCDecrypter(block, iv) }
	} else {
		c.new = func(iv []byte) cipher.BlockMode { return cipher.NewCBCEncrypter(block, iv) }
	}
	c.SetIV(iv)
	return c
}

func cipherAES(key, iv []byte, isRead bool) any {
	c := &cbcMode{}
	block, _ := aes.NewCipher(key)
	if isRead {
		c.new = func(iv []byte) cipher.BlockMode { return cipher.NewCBCDecrypter(block, iv) }
	} else {
		c.new = func(iv []byte) cipher.BlockMode { return cipher.NewCBCEncrypter(block, iv) }
	}
	c.SetIV(iv)
	return c
}

// macSHA1 returns a macFunction for the given protocol version.
func macSHA1(version uint16, key []byte) macFunction {
	return tls10MAC{hmac.New(sha1.New, key)}
}

func macMD5(version uint16, key []byte) macFunction {
	return tls10MAC{hmac.New(md5.New, key)}
}

func macSHA256(version uint16, key []byte) macFunction {
	return tls10MAC{hmac.New(sha256.New, key)}
}

func macSHA384(version uint16, key []byte) macFunction {
	return tls10MAC{hmac.New(sha512.New384, key)}
}

type macFunction interface {
	Size() int
	MAC(digestBuf, seq, header, length, data []byte) []byte
}

// fixedNonceAEAD wraps an AEAD and prefixes a fixed portion of the nonce to
// each call.
type fixedNonceAEAD struct {
	// sealNonce and openNonce are buffers where the larger nonce will be
	// constructed. Since a seal and open operation may be running
	// concurrently, there is a separate buffer for each.
	sealNonce, openNonce []byte
	aead                 cipher.AEAD
}

func (f *fixedNonceAEAD) NonceSize() int { return 8 }
func (f *fixedNonceAEAD) Overhead() int  { return f.aead.Overhead() }

func (f *fixedNonceAEAD) Seal(out, nonce, plaintext, additionalData []byte) []byte {
	copy(f.sealNonce[len(f.sealNonce)-8:], nonce)
	return f.aead.Seal(out, f.sealNonce, plaintext, additionalData)
}

func (f *fixedNonceAEAD) Open(out, nonce, plaintext, additionalData []byte) ([]byte, error) {
	copy(f.openNonce[len(f.openNonce)-8:], nonce)
	return f.aead.Open(out, f.openNonce, plaintext, additionalData)
}

func aeadAESGCM(version uint16, key, fixedNonce []byte) *tlsAead {
	aes, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(aes)
	if err != nil {
		panic(err)
	}

	nonce1, nonce2 := make([]byte, 12), make([]byte, 12)
	copy(nonce1, fixedNonce)
	copy(nonce2, fixedNonce)

	if version >= VersionTLS13 {
		return &tlsAead{&xorNonceAEAD{nonce1, nonce2, aead}, false}
	}

	return &tlsAead{&fixedNonceAEAD{nonce1, nonce2, aead}, true}
}

func xorSlice(out, in []byte) {
	for i := range out {
		out[i] ^= in[i]
	}
}

// xorNonceAEAD wraps an AEAD and XORs a fixed portion of the nonce, left-padded
// if necessary, each call.
type xorNonceAEAD struct {
	// sealNonce and openNonce are buffers where the larger nonce will be
	// constructed. Since a seal and open operation may be running
	// concurrently, there is a separate buffer for each.
	sealNonce, openNonce []byte
	aead                 cipher.AEAD
}

func (x *xorNonceAEAD) NonceSize() int { return 8 }
func (x *xorNonceAEAD) Overhead() int  { return x.aead.Overhead() }

func (x *xorNonceAEAD) Seal(out, nonce, plaintext, additionalData []byte) []byte {
	xorSlice(x.sealNonce[len(x.sealNonce)-len(nonce):], nonce)
	ret := x.aead.Seal(out, x.sealNonce, plaintext, additionalData)
	xorSlice(x.sealNonce[len(x.sealNonce)-len(nonce):], nonce)
	return ret
}

func (x *xorNonceAEAD) Open(out, nonce, plaintext, additionalData []byte) ([]byte, error) {
	xorSlice(x.openNonce[len(x.openNonce)-len(nonce):], nonce)
	ret, err := x.aead.Open(out, x.openNonce, plaintext, additionalData)
	xorSlice(x.openNonce[len(x.openNonce)-len(nonce):], nonce)
	return ret, err
}

func aeadCHACHA20POLY1305(version uint16, key, fixedNonce []byte) *tlsAead {
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		panic(err)
	}

	nonce1, nonce2 := make([]byte, len(fixedNonce)), make([]byte, len(fixedNonce))
	copy(nonce1, fixedNonce)
	copy(nonce2, fixedNonce)

	return &tlsAead{&xorNonceAEAD{nonce1, nonce2, aead}, false}
}

// tls10MAC implements the TLS 1.0 MAC function. RFC 2246, section 6.2.3.
type tls10MAC struct {
	h hash.Hash
}

func (s tls10MAC) Size() int {
	return s.h.Size()
}

func (s tls10MAC) MAC(digestBuf, seq, header, length, data []byte) []byte {
	s.h.Reset()
	s.h.Write(seq)
	s.h.Write(header)
	s.h.Write(length)
	s.h.Write(data)
	return s.h.Sum(digestBuf[:0])
}

func rsaKA(version uint16) keyAgreement {
	return &rsaKeyAgreement{version: version}
}

func ecdheECDSAKA(version uint16) keyAgreement {
	return &ecdheKeyAgreement{
		auth: &signedKeyAgreement{
			keyType: keyTypeECDSA,
			version: version,
		},
	}
}

func ecdheRSAKA(version uint16) keyAgreement {
	return &ecdheKeyAgreement{
		auth: &signedKeyAgreement{
			keyType: keyTypeRSA,
			version: version,
		},
	}
}

func pskKA(version uint16) keyAgreement {
	return &pskKeyAgreement{
		base: &nilKeyAgreement{},
	}
}

func ecdhePSKKA(version uint16) keyAgreement {
	return &pskKeyAgreement{
		base: &ecdheKeyAgreement{
			auth: &nilKeyAgreementAuthentication{},
		},
	}
}

// mutualCipherSuite returns a cipherSuite given a list of supported
// ciphersuites and the id requested by the peer.
func mutualCipherSuite(have []uint16, id uint16) *cipherSuite {
	if slices.Contains(have, id) {
		return cipherSuiteFromID(id)
	}
	return nil
}

func cipherSuiteFromID(id uint16) *cipherSuite {
	for _, suite := range cipherSuites {
		if suite.id == id {
			return suite
		}
	}
	return nil
}

// A list of the possible cipher suite ids. Taken from
// http://www.iana.org/assignments/tls-parameters/tls-parameters.xml
const (
	TLS_RSA_WITH_3DES_EDE_CBC_SHA                 uint16 = 0x000a
	TLS_RSA_WITH_AES_128_CBC_SHA                  uint16 = 0x002f
	TLS_RSA_WITH_AES_256_CBC_SHA                  uint16 = 0x0035
	TLS_RSA_WITH_AES_128_CBC_SHA256               uint16 = 0x003c
	TLS_RSA_WITH_AES_256_CBC_SHA256               uint16 = 0x003d
	TLS_PSK_WITH_AES_128_CBC_SHA                  uint16 = 0x008c
	TLS_PSK_WITH_AES_256_CBC_SHA                  uint16 = 0x008d
	TLS_RSA_WITH_AES_128_GCM_SHA256               uint16 = 0x009c
	TLS_RSA_WITH_AES_256_GCM_SHA384               uint16 = 0x009d
	TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA          uint16 = 0xc009
	TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA          uint16 = 0xc00a
	TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA           uint16 = 0xc012
	TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA            uint16 = 0xc013
	TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA            uint16 = 0xc014
	TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256       uint16 = 0xc023
	TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384       uint16 = 0xc024
	TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256         uint16 = 0xc027
	TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384         uint16 = 0xc028
	TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256       uint16 = 0xc02b
	TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384       uint16 = 0xc02c
	TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256         uint16 = 0xc02f
	TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384         uint16 = 0xc030
	TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA            uint16 = 0xc035
	TLS_ECDHE_PSK_WITH_AES_256_CBC_SHA            uint16 = 0xc036
	TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256   uint16 = 0xcca8
	TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256 uint16 = 0xcca9
	TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256   uint16 = 0xccac
	renegotiationSCSV                             uint16 = 0x00ff
	fallbackSCSV                                  uint16 = 0x5600
)

// Additional cipher suite IDs, not IANA-assigned.
const (
	TLS_AES_128_GCM_SHA256       uint16 = 0x1301
	TLS_AES_256_GCM_SHA384       uint16 = 0x1302
	TLS_CHACHA20_POLY1305_SHA256 uint16 = 0x1303
)
