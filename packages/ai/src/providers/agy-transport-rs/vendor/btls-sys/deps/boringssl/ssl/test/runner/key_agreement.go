// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/mlkem"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"slices"

	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/kyber"
)

type keyType int

const (
	keyTypeRSA keyType = iota + 1
	keyTypeECDSA
)

var errClientKeyExchange = errors.New("tls: invalid ClientKeyExchange message")
var errServerKeyExchange = errors.New("tls: invalid ServerKeyExchange message")

// rsaKeyAgreement implements the standard TLS key agreement where the client
// encrypts the pre-master secret to the server's public key.
type rsaKeyAgreement struct {
	version       uint16
	clientVersion uint16
	exportKey     *rsa.PrivateKey
}

func (ka *rsaKeyAgreement) generateServerKeyExchange(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, version uint16) (*serverKeyExchangeMsg, error) {
	// Save the client version for comparison later.
	ka.clientVersion = clientHello.vers

	if !config.Bugs.RSAEphemeralKey {
		return nil, nil
	}

	// Generate an ephemeral RSA key to use instead of the real
	// one, as in RSA_EXPORT.
	key, err := rsa.GenerateKey(config.rand(), 1024)
	if err != nil {
		return nil, err
	}
	ka.exportKey = key

	modulus := key.N.Bytes()
	exponent := big.NewInt(int64(key.E)).Bytes()
	serverRSAParams := make([]byte, 0, 2+len(modulus)+2+len(exponent))
	serverRSAParams = append(serverRSAParams, byte(len(modulus)>>8), byte(len(modulus)))
	serverRSAParams = append(serverRSAParams, modulus...)
	serverRSAParams = append(serverRSAParams, byte(len(exponent)>>8), byte(len(exponent)))
	serverRSAParams = append(serverRSAParams, exponent...)

	var sigAlg signatureAlgorithm
	if ka.version >= VersionTLS12 {
		sigAlg, err = selectSignatureAlgorithm(false /* server */, ka.version, cert, config, clientHello.signatureAlgorithms)
		if err != nil {
			return nil, err
		}
	}

	sig, err := signMessage(false /* server */, ka.version, cert.PrivateKey, config, sigAlg, serverRSAParams)
	if err != nil {
		return nil, errors.New("failed to sign RSA parameters: " + err.Error())
	}

	skx := new(serverKeyExchangeMsg)
	sigAlgsLen := 0
	if ka.version >= VersionTLS12 {
		sigAlgsLen = 2
	}
	skx.key = make([]byte, len(serverRSAParams)+sigAlgsLen+2+len(sig))
	copy(skx.key, serverRSAParams)
	k := skx.key[len(serverRSAParams):]
	if ka.version >= VersionTLS12 {
		k[0] = byte(sigAlg >> 8)
		k[1] = byte(sigAlg)
		k = k[2:]
	}
	k[0] = byte(len(sig) >> 8)
	k[1] = byte(len(sig))
	copy(k[2:], sig)

	return skx, nil
}

func (ka *rsaKeyAgreement) processClientKeyExchange(config *Config, cert *Credential, ckx *clientKeyExchangeMsg, version uint16) ([]byte, error) {
	preMasterSecret := make([]byte, 48)
	_, err := io.ReadFull(config.rand(), preMasterSecret[2:])
	if err != nil {
		return nil, err
	}

	if len(ckx.ciphertext) < 2 {
		return nil, errClientKeyExchange
	}

	ciphertextLen := int(ckx.ciphertext[0])<<8 | int(ckx.ciphertext[1])
	if ciphertextLen != len(ckx.ciphertext)-2 {
		return nil, errClientKeyExchange
	}
	ciphertext := ckx.ciphertext[2:]

	key := cert.PrivateKey.(*rsa.PrivateKey)
	if ka.exportKey != nil {
		key = ka.exportKey
	}
	err = rsa.DecryptPKCS1v15SessionKey(config.rand(), key, ciphertext, preMasterSecret)
	if err != nil {
		return nil, err
	}
	// This check should be done in constant-time, but this is a testing
	// implementation. See the discussion at the end of section 7.4.7.1 of
	// RFC 4346.
	vers := uint16(preMasterSecret[0])<<8 | uint16(preMasterSecret[1])
	if ka.clientVersion != vers {
		return nil, fmt.Errorf("tls: invalid version in RSA premaster (got %04x, wanted %04x)", vers, ka.clientVersion)
	}
	return preMasterSecret, nil
}

func (ka *rsaKeyAgreement) processServerKeyExchange(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, skx *serverKeyExchangeMsg) error {
	return errors.New("tls: unexpected ServerKeyExchange")
}

func rsaSize(pub *rsa.PublicKey) int {
	return (pub.N.BitLen() + 7) / 8
}

func rsaRawEncrypt(pub *rsa.PublicKey, msg []byte) ([]byte, error) {
	k := rsaSize(pub)
	if len(msg) != k {
		return nil, errors.New("tls: bad padded RSA input")
	}
	m := new(big.Int).SetBytes(msg)
	e := big.NewInt(int64(pub.E))
	m.Exp(m, e, pub.N)
	unpadded := m.Bytes()
	ret := make([]byte, k)
	copy(ret[len(ret)-len(unpadded):], unpadded)
	return ret, nil
}

// nonZeroRandomBytes fills the given slice with non-zero random octets.
func nonZeroRandomBytes(s []byte, rand io.Reader) {
	if _, err := io.ReadFull(rand, s); err != nil {
		panic(err)
	}

	for i := range s {
		for s[i] == 0 {
			if _, err := io.ReadFull(rand, s[i:i+1]); err != nil {
				panic(err)
			}
		}
	}
}

func (ka *rsaKeyAgreement) generateClientKeyExchange(config *Config, clientHello *clientHelloMsg, cert *x509.Certificate) ([]byte, *clientKeyExchangeMsg, error) {
	bad := config.Bugs.BadRSAClientKeyExchange
	preMasterSecret := make([]byte, 48)
	vers := clientHello.vers
	if bad == RSABadValueWrongVersion1 {
		vers ^= 1
	} else if bad == RSABadValueWrongVersion2 {
		vers ^= 0x100
	}
	preMasterSecret[0] = byte(vers >> 8)
	preMasterSecret[1] = byte(vers)
	_, err := io.ReadFull(config.rand(), preMasterSecret[2:])
	if err != nil {
		return nil, nil, err
	}

	sentPreMasterSecret := preMasterSecret
	if bad == RSABadValueTooLong {
		sentPreMasterSecret = make([]byte, 1, len(sentPreMasterSecret)+1)
		sentPreMasterSecret = append(sentPreMasterSecret, preMasterSecret...)
	} else if bad == RSABadValueTooShort {
		sentPreMasterSecret = sentPreMasterSecret[:len(sentPreMasterSecret)-1]
	}

	// Pad for PKCS#1 v1.5.
	padded := make([]byte, rsaSize(cert.PublicKey.(*rsa.PublicKey)))
	padded[1] = 2
	nonZeroRandomBytes(padded[2:len(padded)-len(sentPreMasterSecret)-1], config.rand())
	copy(padded[len(padded)-len(sentPreMasterSecret):], sentPreMasterSecret)

	if bad == RSABadValueWrongBlockType {
		padded[1] = 3
	} else if bad == RSABadValueWrongLeadingByte {
		padded[0] = 1
	} else if bad == RSABadValueNoZero {
		for i := 2; i < len(padded); i++ {
			if padded[i] == 0 {
				padded[i]++
			}
		}
	}

	encrypted, err := rsaRawEncrypt(cert.PublicKey.(*rsa.PublicKey), padded)
	if err != nil {
		return nil, nil, err
	}
	if bad == RSABadValueCorrupt {
		encrypted[len(encrypted)-1] ^= 1
		// Clear the high byte to ensure |encrypted| is still below the RSA modulus.
		encrypted[0] = 0
	}
	ckx := new(clientKeyExchangeMsg)
	ckx.ciphertext = make([]byte, len(encrypted)+2)
	ckx.ciphertext[0] = byte(len(encrypted) >> 8)
	ckx.ciphertext[1] = byte(len(encrypted))
	copy(ckx.ciphertext[2:], encrypted)
	return preMasterSecret, ckx, nil
}

func (ka *rsaKeyAgreement) peerSignatureAlgorithm() signatureAlgorithm {
	return 0
}

// A kemImplementation is an instance of KEM-style construction for TLS.
type kemImplementation interface {
	encapsulationKeySize() int
	ciphertextSize() int

	// generate generates a keypair using rand. It returns the encoded public key.
	generate(config *Config) (publicKey []byte, err error)

	// encap generates a symmetric, shared secret, encapsulates it with |peerKey|.
	// It returns the encapsulated shared secret and the secret itself.
	encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error)

	// decap decapsulates |ciphertext| and returns the resulting shared secret.
	decap(config *Config, ciphertext []byte) (secret []byte, err error)
}

func applyBugsToECDHPublicKey(config *Config, publicKey []byte) []byte {
	if config.Bugs.SendCompressedCoordinates {
		l := (len(publicKey) - 1) / 2
		tmp := make([]byte, 1+l)
		// Extract the low-order bit of the y-coordinate.
		tmp[0] = byte(2 | (publicKey[len(publicKey)-1] & 1))
		copy(tmp[1:], publicKey[1:1+l])
		publicKey = tmp
	}
	if config.Bugs.ECDHPointNotOnCurve {
		// Flip a bit, so the point is no longer on the curve. This is
		// guaranteed to be off the curve because we preserve x. That
		// means the only other valid y is y' = p - y, but we've kept
		// y's parity, so we cannot have accidentally reached y'.
		publicKey[len(publicKey)-1] ^= 0x80
	}
	return publicKey
}

// ecdhKEM implements kemImplementation with crypto/ecdh.
type ecdhKEM struct {
	curve      ecdh.Curve
	privateKey *ecdh.PrivateKey
}

func (e *ecdhKEM) encapsulationKeySize() int {
	switch e.curve {
	case ecdh.P256():
		return 1 + 2*32
	case ecdh.P384():
		return 1 + 2*48
	case ecdh.P521():
		return 1 + 2*66
	case ecdh.X25519():
		return 32
	}
	panic(fmt.Sprintf("unknown curve %q", e.curve))
}

func (e *ecdhKEM) ciphertextSize() int {
	return e.encapsulationKeySize()
}

func (e *ecdhKEM) generate(config *Config) (publicKey []byte, err error) {
	if e.curve == ecdh.X25519() && config.Bugs.LowOrderX25519Point {
		publicKey = []byte{0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00}
		return
	}
	e.privateKey, err = e.curve.GenerateKey(config.rand())
	if err != nil {
		return nil, err
	}
	ret := e.privateKey.PublicKey().Bytes()
	if e.curve == ecdh.X25519() {
		if config.Bugs.SetX25519HighBit {
			ret[31] |= 0x80
		}
	} else {
		ret = applyBugsToECDHPublicKey(config, ret)
	}
	return ret, nil
}

func (e *ecdhKEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	ciphertext, err = e.generate(config)
	if err != nil {
		return nil, nil, err
	}
	secret, err = e.decap(config, peerKey)
	if err != nil {
		return nil, nil, err
	}
	return
}

func (e *ecdhKEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	if e.curve == ecdh.X25519() && config.Bugs.LowOrderX25519Point {
		secret = make([]byte, 32)
		return
	}
	peerKey, err := e.curve.NewPublicKey(ciphertext)
	if err != nil {
		return nil, fmt.Errorf("tls: invalid peer ECDH key: %s", err)
	}
	return e.privateKey.ECDH(peerKey)
}

// kyberKEM implements Kyber-768
type kyberKEM struct {
	kyberPrivateKey *kyber.PrivateKey
}

func (e *kyberKEM) encapsulationKeySize() int {
	return kyber.PublicKeySize
}

func (e *kyberKEM) ciphertextSize() int {
	return kyber.CiphertextSize
}

func (e *kyberKEM) generate(config *Config) (publicKey []byte, err error) {
	var kyberEntropy [64]byte
	if _, err := io.ReadFull(config.rand(), kyberEntropy[:]); err != nil {
		return nil, err
	}
	var kyberPublic *[kyber.PublicKeySize]byte
	e.kyberPrivateKey, kyberPublic = kyber.NewPrivateKey(&kyberEntropy)
	return kyberPublic[:], nil
}

func (e *kyberKEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	if len(peerKey) != kyber.PublicKeySize {
		return nil, nil, errors.New("tls: bad length Kyber offer")
	}

	kyberPublicKey, ok := kyber.UnmarshalPublicKey((*[kyber.PublicKeySize]byte)(peerKey))
	if !ok {
		return nil, nil, errors.New("tls: bad Kyber offer")
	}

	var kyberShared, kyberEntropy [32]byte
	if _, err := io.ReadFull(config.rand(), kyberEntropy[:]); err != nil {
		return nil, nil, err
	}
	kyberCiphertext := kyberPublicKey.Encap(kyberShared[:], &kyberEntropy)
	return kyberCiphertext[:], kyberShared[:], nil
}

func (e *kyberKEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	if len(ciphertext) != kyber.CiphertextSize {
		return nil, errors.New("tls: bad length Kyber reply")
	}

	var kyberShared [32]byte
	e.kyberPrivateKey.Decap(kyberShared[:], (*[kyber.CiphertextSize]byte)(ciphertext))
	return kyberShared[:], nil
}

// mlkem768KEM implements ML-KEM-768
type mlkem768KEM struct {
	decapKey *mlkem.DecapsulationKey768
}

func (e *mlkem768KEM) encapsulationKeySize() int {
	return mlkem.EncapsulationKeySize768
}

func (e *mlkem768KEM) ciphertextSize() int {
	return mlkem.CiphertextSize768
}

func (m *mlkem768KEM) generate(config *Config) (publicKey []byte, err error) {
	m.decapKey, err = mlkem.GenerateKey768()
	if err != nil {
		return
	}
	publicKey = m.decapKey.EncapsulationKey().Bytes()
	if config.Bugs.MLKEMEncapKeyNotReduced {
		// Set the first 12 bits so that the first word is definitely
		// not reduced.
		publicKey[0] |= 0xff
		publicKey[1] |= 0xf
	}
	return
}

func (m *mlkem768KEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	key, err := mlkem.NewEncapsulationKey768(peerKey)
	if err != nil {
		return nil, nil, err
	}
	secret, ciphertext = key.Encapsulate()
	return
}

func (m *mlkem768KEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	return m.decapKey.Decapsulate(ciphertext)
}

// mlkem1024KEM implements ML-KEM-1024
type mlkem1024KEM struct {
	decapKey *mlkem.DecapsulationKey1024
}

func (e *mlkem1024KEM) encapsulationKeySize() int {
	return mlkem.EncapsulationKeySize1024
}

func (e *mlkem1024KEM) ciphertextSize() int {
	return mlkem.CiphertextSize1024
}

func (m *mlkem1024KEM) generate(config *Config) (publicKey []byte, err error) {
	m.decapKey, err = mlkem.GenerateKey1024()
	if err != nil {
		return
	}
	publicKey = m.decapKey.EncapsulationKey().Bytes()
	if config.Bugs.MLKEMEncapKeyNotReduced {
		// Set the first 12 bits so that the first word is definitely
		// not reduced.
		publicKey[0] |= 0xff
		publicKey[1] |= 0xf
	}
	return
}

func (m *mlkem1024KEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	key, err := mlkem.NewEncapsulationKey1024(peerKey)
	if err != nil {
		return nil, nil, err
	}
	secret, ciphertext = key.Encapsulate()
	return
}

func (m *mlkem1024KEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	return m.decapKey.Decapsulate(ciphertext)
}

// concatKEM concatenates two kemImplementations.
type concatKEM struct {
	kem1, kem2 kemImplementation
}

func (c *concatKEM) encapsulationKeySize() int {
	return c.kem1.encapsulationKeySize() + c.kem2.encapsulationKeySize()
}

func (c *concatKEM) ciphertextSize() int {
	return c.kem1.ciphertextSize() + c.kem2.ciphertextSize()
}

func (c *concatKEM) generate(config *Config) (publicKey []byte, err error) {
	publicKey1, err := c.kem1.generate(config)
	if err != nil {
		return nil, err
	}
	publicKey2, err := c.kem2.generate(config)
	if err != nil {
		return nil, err
	}
	return slices.Concat(publicKey1, publicKey2), nil
}

func (c *concatKEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	encapKeySize1 := c.kem1.encapsulationKeySize()
	if len(peerKey) < encapKeySize1 {
		return nil, nil, errors.New("tls: invalid peer key")
	}
	peerKey1, peerKey2 := peerKey[:encapKeySize1], peerKey[encapKeySize1:]
	ciphertext1, secret1, err := c.kem1.encap(config, peerKey1)
	if err != nil {
		return nil, nil, err
	}
	ciphertext2, secret2, err := c.kem2.encap(config, peerKey2)
	if err != nil {
		return nil, nil, err
	}
	return slices.Concat(ciphertext1, ciphertext2), slices.Concat(secret1, secret2), nil
}

func (c *concatKEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	ciphertextSize1 := c.kem1.ciphertextSize()
	if len(ciphertext) < ciphertextSize1 {
		return nil, errors.New("tls: invalid ciphertext")
	}
	ciphertext1, ciphertext2 := ciphertext[:ciphertextSize1], ciphertext[ciphertextSize1:]
	secret1, err := c.kem1.decap(config, ciphertext1)
	if err != nil {
		return nil, err
	}
	secret2, err := c.kem2.decap(config, ciphertext2)
	if err != nil {
		return nil, err
	}
	return slices.Concat(secret1, secret2), nil
}

type transformKEM struct {
	kem       kemImplementation
	transform func([]byte) []byte
}

func (t *transformKEM) encapsulationKeySize() int {
	return t.kem.encapsulationKeySize()
}

func (t *transformKEM) ciphertextSize() int {
	return t.kem.ciphertextSize()
}

func (t *transformKEM) generate(config *Config) (publicKey []byte, err error) {
	publicKey, err = t.kem.generate(config)
	if err == nil {
		publicKey = t.transform(publicKey)
	}
	return
}

func (t *transformKEM) encap(config *Config, peerKey []byte) (ciphertext []byte, secret []byte, err error) {
	ciphertext, secret, err = t.kem.encap(config, peerKey)
	if err == nil {
		ciphertext = t.transform(ciphertext)
	}
	return
}

func (t *transformKEM) decap(config *Config, ciphertext []byte) (secret []byte, err error) {
	return t.kem.decap(config, ciphertext)
}

func kemForCurveID(id CurveID, config *Config) (kemImplementation, bool) {
	var kem kemImplementation
	switch id {
	case CurveP256:
		kem = &ecdhKEM{curve: ecdh.P256()}
	case CurveP384:
		kem = &ecdhKEM{curve: ecdh.P384()}
	case CurveP521:
		kem = &ecdhKEM{curve: ecdh.P521()}
	case CurveX25519:
		kem = &ecdhKEM{curve: ecdh.X25519()}
	case CurveX25519Kyber768:
		// draft-tls-westerbaan-xyber768d00-03
		kem = &concatKEM{kem1: &ecdhKEM{curve: ecdh.X25519()}, kem2: &kyberKEM{}}
	case CurveX25519MLKEM768:
		// draft-ietf-tls-ecdhe-mlkem-00
		kem = &concatKEM{kem1: &mlkem768KEM{}, kem2: &ecdhKEM{curve: ecdh.X25519()}}
	case CurveMLKEM1024:
		// draft-ietf-tls-mlkem-04
		kem = &mlkem1024KEM{}
	default:
		return nil, false
	}

	if config.Bugs.TruncateKeyShare {
		kem = &transformKEM{kem: kem, transform: func(b []byte) []byte { return b[:len(b)-1] }}
	}
	if config.Bugs.PadKeyShare {
		kem = &transformKEM{kem: kem, transform: func(b []byte) []byte { return slices.Concat(b, []byte{0}) }}
	}
	return kem, true
}

// keyAgreementAuthentication is a helper interface that specifies how
// to authenticate the ServerKeyExchange parameters.
type keyAgreementAuthentication interface {
	signParameters(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, params []byte) (*serverKeyExchangeMsg, error)
	verifyParameters(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, params []byte, sig []byte) error
}

// nilKeyAgreementAuthentication does not authenticate the key
// agreement parameters.
type nilKeyAgreementAuthentication struct{}

func (ka *nilKeyAgreementAuthentication) signParameters(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, params []byte) (*serverKeyExchangeMsg, error) {
	skx := new(serverKeyExchangeMsg)
	skx.key = params
	return skx, nil
}

func (ka *nilKeyAgreementAuthentication) verifyParameters(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, params []byte, sig []byte) error {
	return nil
}

// signedKeyAgreement signs the ServerKeyExchange parameters with the
// server's private key.
type signedKeyAgreement struct {
	keyType                keyType
	version                uint16
	peerSignatureAlgorithm signatureAlgorithm
}

func (ka *signedKeyAgreement) signParameters(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, params []byte) (*serverKeyExchangeMsg, error) {
	// The message to be signed is prepended by the randoms.
	var msg []byte
	msg = append(msg, clientHello.random...)
	msg = append(msg, hello.random...)
	msg = append(msg, params...)

	var sigAlg signatureAlgorithm
	var err error
	if ka.version >= VersionTLS12 {
		sigAlg, err = selectSignatureAlgorithm(false /* server */, ka.version, cert, config, clientHello.signatureAlgorithms)
		if err != nil {
			return nil, err
		}
	}

	sig, err := signMessage(false /* server */, ka.version, cert.PrivateKey, config, sigAlg, msg)
	if err != nil {
		return nil, err
	}
	if config.Bugs.SendSignatureAlgorithm != 0 {
		sigAlg = config.Bugs.SendSignatureAlgorithm
	}

	skx := new(serverKeyExchangeMsg)
	if config.Bugs.UnauthenticatedECDH {
		skx.key = params
	} else {
		sigAlgsLen := 0
		if ka.version >= VersionTLS12 {
			sigAlgsLen = 2
		}
		skx.key = make([]byte, len(params)+sigAlgsLen+2+len(sig))
		copy(skx.key, params)
		k := skx.key[len(params):]
		if ka.version >= VersionTLS12 {
			k[0] = byte(sigAlg >> 8)
			k[1] = byte(sigAlg)
			k = k[2:]
		}
		k[0] = byte(len(sig) >> 8)
		k[1] = byte(len(sig))
		copy(k[2:], sig)
	}

	return skx, nil
}

func (ka *signedKeyAgreement) verifyParameters(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, publicKey crypto.PublicKey, params []byte, sig []byte) error {
	// The peer's key must match the cipher type.
	switch ka.keyType {
	case keyTypeECDSA:
		_, edsaOk := publicKey.(*ecdsa.PublicKey)
		_, ed25519Ok := publicKey.(ed25519.PublicKey)
		if !edsaOk && !ed25519Ok {
			return errors.New("tls: ECDHE ECDSA requires a ECDSA or Ed25519 server public key")
		}
	case keyTypeRSA:
		_, ok := publicKey.(*rsa.PublicKey)
		if !ok {
			return errors.New("tls: ECDHE RSA requires a RSA server public key")
		}
	default:
		return errors.New("tls: unknown key type")
	}

	// The message to be signed is prepended by the randoms.
	var msg []byte
	msg = append(msg, clientHello.random...)
	msg = append(msg, serverHello.random...)
	msg = append(msg, params...)

	var sigAlg signatureAlgorithm
	if ka.version >= VersionTLS12 {
		if len(sig) < 2 {
			return errServerKeyExchange
		}
		sigAlg = signatureAlgorithm(sig[0])<<8 | signatureAlgorithm(sig[1])
		sig = sig[2:]
		// Stash the signature algorithm to be extracted by the handshake.
		ka.peerSignatureAlgorithm = sigAlg
	}

	if len(sig) < 2 {
		return errServerKeyExchange
	}
	sigLen := int(sig[0])<<8 | int(sig[1])
	if sigLen+2 != len(sig) {
		return errServerKeyExchange
	}
	sig = sig[2:]

	return verifyMessage(true /* client */, ka.version, publicKey, config, sigAlg, msg, sig)
}

// ecdheKeyAgreement implements a TLS key agreement where the server
// generates a ephemeral EC public/private key pair and signs it. The
// pre-master secret is then calculated using ECDH. The signature may
// either be ECDSA or RSA.
type ecdheKeyAgreement struct {
	auth    keyAgreementAuthentication
	kem     kemImplementation
	curveID CurveID
	peerKey []byte
}

func (ka *ecdheKeyAgreement) generateServerKeyExchange(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, version uint16) (*serverKeyExchangeMsg, error) {
	var curveID CurveID
	preferredCurves := config.curvePreferences()
	for _, candidate := range preferredCurves {
		if isPqGroup(candidate) && version < VersionTLS13 {
			// Post-quantum "groups" require TLS 1.3.
			continue
		}

		if slices.Contains(clientHello.supportedCurves, candidate) {
			curveID = candidate
			break
		}
	}

	if curveID == 0 {
		return nil, errors.New("tls: no supported elliptic curves offered")
	}

	var ok bool
	if ka.kem, ok = kemForCurveID(curveID, config); !ok {
		return nil, errors.New("tls: preferredCurves includes unsupported curve")
	}
	ka.curveID = curveID

	publicKey, err := ka.kem.generate(config)
	if err != nil {
		return nil, err
	}

	// http://tools.ietf.org/html/rfc4492#section-5.4
	serverECDHParams := make([]byte, 1+2+1+len(publicKey))
	serverECDHParams[0] = 3 // named curve
	if config.Bugs.SendCurve != 0 {
		curveID = config.Bugs.SendCurve
	}
	serverECDHParams[1] = byte(curveID >> 8)
	serverECDHParams[2] = byte(curveID)
	serverECDHParams[3] = byte(len(publicKey))
	copy(serverECDHParams[4:], publicKey)

	return ka.auth.signParameters(config, cert, clientHello, hello, serverECDHParams)
}

func (ka *ecdheKeyAgreement) processClientKeyExchange(config *Config, cert *Credential, ckx *clientKeyExchangeMsg, version uint16) ([]byte, error) {
	if len(ckx.ciphertext) == 0 || int(ckx.ciphertext[0]) != len(ckx.ciphertext)-1 {
		return nil, errClientKeyExchange
	}
	return ka.kem.decap(config, ckx.ciphertext[1:])
}

func (ka *ecdheKeyAgreement) processServerKeyExchange(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, skx *serverKeyExchangeMsg) error {
	if len(skx.key) < 4 {
		return errServerKeyExchange
	}
	if skx.key[0] != 3 { // named curve
		return errors.New("tls: server selected unsupported curve")
	}
	curveID := CurveID(skx.key[1])<<8 | CurveID(skx.key[2])
	ka.curveID = curveID

	var ok bool
	if ka.kem, ok = kemForCurveID(curveID, config); !ok {
		return errors.New("tls: server selected unsupported curve")
	}

	publicLen := int(skx.key[3])
	if publicLen+4 > len(skx.key) {
		return errServerKeyExchange
	}
	// Save the peer key for later.
	ka.peerKey = skx.key[4 : 4+publicLen]

	// Check the signature.
	serverECDHParams := skx.key[:4+publicLen]
	sig := skx.key[4+publicLen:]
	return ka.auth.verifyParameters(config, clientHello, serverHello, key, serverECDHParams, sig)
}

func (ka *ecdheKeyAgreement) generateClientKeyExchange(config *Config, clientHello *clientHelloMsg, cert *x509.Certificate) ([]byte, *clientKeyExchangeMsg, error) {
	if ka.kem == nil {
		return nil, nil, errors.New("missing ServerKeyExchange message")
	}

	ciphertext, secret, err := ka.kem.encap(config, ka.peerKey)
	if err != nil {
		return nil, nil, err
	}

	ckx := new(clientKeyExchangeMsg)
	ckx.ciphertext = make([]byte, 1+len(ciphertext))
	ckx.ciphertext[0] = byte(len(ciphertext))
	copy(ckx.ciphertext[1:], ciphertext)

	return secret, ckx, nil
}

func (ka *ecdheKeyAgreement) peerSignatureAlgorithm() signatureAlgorithm {
	if auth, ok := ka.auth.(*signedKeyAgreement); ok {
		return auth.peerSignatureAlgorithm
	}
	return 0
}

// nilKeyAgreement is a fake key agreement used to implement the plain PSK key
// exchange.
type nilKeyAgreement struct{}

func (ka *nilKeyAgreement) generateServerKeyExchange(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, version uint16) (*serverKeyExchangeMsg, error) {
	return nil, nil
}

func (ka *nilKeyAgreement) processClientKeyExchange(config *Config, cert *Credential, ckx *clientKeyExchangeMsg, version uint16) ([]byte, error) {
	if len(ckx.ciphertext) != 0 {
		return nil, errClientKeyExchange
	}

	// Although in plain PSK, otherSecret is all zeros, the base key
	// agreement does not access to the length of the pre-shared
	// key. pskKeyAgreement instead interprets nil to mean to use all zeros
	// of the appropriate length.
	return nil, nil
}

func (ka *nilKeyAgreement) processServerKeyExchange(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, skx *serverKeyExchangeMsg) error {
	if len(skx.key) != 0 {
		return errServerKeyExchange
	}
	return nil
}

func (ka *nilKeyAgreement) generateClientKeyExchange(config *Config, clientHello *clientHelloMsg, cert *x509.Certificate) ([]byte, *clientKeyExchangeMsg, error) {
	// Although in plain PSK, otherSecret is all zeros, the base key
	// agreement does not access to the length of the pre-shared
	// key. pskKeyAgreement instead interprets nil to mean to use all zeros
	// of the appropriate length.
	return nil, &clientKeyExchangeMsg{}, nil
}

func (ka *nilKeyAgreement) peerSignatureAlgorithm() signatureAlgorithm {
	return 0
}

// makePSKPremaster formats a PSK pre-master secret based on otherSecret from
// the base key exchange and psk.
func makePSKPremaster(otherSecret, psk []byte) []byte {
	out := make([]byte, 0, 2+len(otherSecret)+2+len(psk))
	out = append(out, byte(len(otherSecret)>>8), byte(len(otherSecret)))
	out = append(out, otherSecret...)
	out = append(out, byte(len(psk)>>8), byte(len(psk)))
	out = append(out, psk...)
	return out
}

// pskKeyAgreement implements the PSK key agreement.
type pskKeyAgreement struct {
	base         keyAgreement
	identityHint string
}

func (ka *pskKeyAgreement) generateServerKeyExchange(config *Config, cert *Credential, clientHello *clientHelloMsg, hello *serverHelloMsg, version uint16) (*serverKeyExchangeMsg, error) {
	// Assemble the identity hint.
	bytes := make([]byte, 2+len(config.PreSharedKeyIdentity))
	bytes[0] = byte(len(config.PreSharedKeyIdentity) >> 8)
	bytes[1] = byte(len(config.PreSharedKeyIdentity))
	copy(bytes[2:], []byte(config.PreSharedKeyIdentity))

	// If there is one, append the base key agreement's
	// ServerKeyExchange.
	baseSkx, err := ka.base.generateServerKeyExchange(config, cert, clientHello, hello, version)
	if err != nil {
		return nil, err
	}

	if baseSkx != nil {
		bytes = append(bytes, baseSkx.key...)
	} else if config.PreSharedKeyIdentity == "" && !config.Bugs.AlwaysSendPreSharedKeyIdentityHint {
		// ServerKeyExchange is optional if the identity hint is empty
		// and there would otherwise be no ServerKeyExchange.
		return nil, nil
	}

	skx := new(serverKeyExchangeMsg)
	skx.key = bytes
	return skx, nil
}

func (ka *pskKeyAgreement) processClientKeyExchange(config *Config, cert *Credential, ckx *clientKeyExchangeMsg, version uint16) ([]byte, error) {
	// First, process the PSK identity.
	if len(ckx.ciphertext) < 2 {
		return nil, errClientKeyExchange
	}
	identityLen := (int(ckx.ciphertext[0]) << 8) | int(ckx.ciphertext[1])
	if 2+identityLen > len(ckx.ciphertext) {
		return nil, errClientKeyExchange
	}
	identity := string(ckx.ciphertext[2 : 2+identityLen])

	if identity != config.PreSharedKeyIdentity {
		return nil, errors.New("tls: unexpected identity")
	}

	if config.PreSharedKey == nil {
		return nil, errors.New("tls: pre-shared key not configured")
	}

	// Process the remainder of the ClientKeyExchange to compute the base
	// pre-master secret.
	newCkx := new(clientKeyExchangeMsg)
	newCkx.ciphertext = ckx.ciphertext[2+identityLen:]
	otherSecret, err := ka.base.processClientKeyExchange(config, cert, newCkx, version)
	if err != nil {
		return nil, err
	}

	if otherSecret == nil {
		// Special-case for the plain PSK key exchanges.
		otherSecret = make([]byte, len(config.PreSharedKey))
	}
	return makePSKPremaster(otherSecret, config.PreSharedKey), nil
}

func (ka *pskKeyAgreement) processServerKeyExchange(config *Config, clientHello *clientHelloMsg, serverHello *serverHelloMsg, key crypto.PublicKey, skx *serverKeyExchangeMsg) error {
	if len(skx.key) < 2 {
		return errServerKeyExchange
	}
	identityLen := (int(skx.key[0]) << 8) | int(skx.key[1])
	if 2+identityLen > len(skx.key) {
		return errServerKeyExchange
	}
	ka.identityHint = string(skx.key[2 : 2+identityLen])

	// Process the remainder of the ServerKeyExchange.
	newSkx := new(serverKeyExchangeMsg)
	newSkx.key = skx.key[2+identityLen:]
	return ka.base.processServerKeyExchange(config, clientHello, serverHello, key, newSkx)
}

func (ka *pskKeyAgreement) generateClientKeyExchange(config *Config, clientHello *clientHelloMsg, cert *x509.Certificate) ([]byte, *clientKeyExchangeMsg, error) {
	// The server only sends an identity hint but, for purposes of
	// test code, the server always sends the hint and it is
	// required to match.
	if ka.identityHint != config.PreSharedKeyIdentity {
		return nil, nil, errors.New("tls: unexpected identity")
	}

	// Serialize the identity.
	bytes := make([]byte, 2+len(config.PreSharedKeyIdentity))
	bytes[0] = byte(len(config.PreSharedKeyIdentity) >> 8)
	bytes[1] = byte(len(config.PreSharedKeyIdentity))
	copy(bytes[2:], []byte(config.PreSharedKeyIdentity))

	// Append the base key exchange's ClientKeyExchange.
	otherSecret, baseCkx, err := ka.base.generateClientKeyExchange(config, clientHello, cert)
	if err != nil {
		return nil, nil, err
	}
	ckx := new(clientKeyExchangeMsg)
	ckx.ciphertext = append(bytes, baseCkx.ciphertext...)

	if config.PreSharedKey == nil {
		return nil, nil, errors.New("tls: pre-shared key not configured")
	}
	if otherSecret == nil {
		otherSecret = make([]byte, len(config.PreSharedKey))
	}
	return makePSKPremaster(otherSecret, config.PreSharedKey), ckx, nil
}

func (ka *pskKeyAgreement) peerSignatureAlgorithm() signatureAlgorithm {
	return 0
}
