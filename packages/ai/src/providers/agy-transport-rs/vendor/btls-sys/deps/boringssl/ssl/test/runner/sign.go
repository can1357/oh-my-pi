// Copyright 2016 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/md5"
	"crypto/rsa"
	"crypto/sha1"
	_ "crypto/sha256"
	_ "crypto/sha512"
	"encoding/asn1"
	"errors"
	"fmt"
	"math/big"
	"slices"
)

type signer interface {
	supportsKey(key crypto.PrivateKey) bool
	signMessage(key crypto.PrivateKey, config *Config, msg []byte) ([]byte, error)
	verifyMessage(key crypto.PublicKey, msg, sig []byte) error
}

func selectSignatureAlgorithm(isClient bool, version uint16, cred *Credential, config *Config, peerSigAlgs []signatureAlgorithm) (signatureAlgorithm, error) {
	// If the client didn't specify any signature_algorithms extension then
	// we can assume that it supports SHA1. See
	// http://tools.ietf.org/html/rfc5246#section-7.4.1.4.1
	if len(peerSigAlgs) == 0 {
		peerSigAlgs = []signatureAlgorithm{signatureRSAPKCS1WithSHA1, signatureECDSAWithSHA1}
	}

	for _, sigAlg := range cred.signatureAlgorithms() {
		if !slices.Contains(peerSigAlgs, sigAlg) {
			continue
		}

		signer, err := getSigner(isClient, version, cred.PrivateKey, config, sigAlg, false)
		if err != nil {
			continue
		}

		if signer.supportsKey(cred.PrivateKey) {
			return sigAlg, nil
		}
	}
	return 0, errors.New("tls: no common signature algorithms")
}

func signMessage(isClient bool, version uint16, key crypto.PrivateKey, config *Config, sigAlg signatureAlgorithm, msg []byte) ([]byte, error) {
	if config.Bugs.InvalidSignature {
		newMsg := make([]byte, len(msg))
		copy(newMsg, msg)
		newMsg[0] ^= 0x80
		msg = newMsg
	}

	signer, err := getSigner(isClient, version, key, config, sigAlg, false)
	if err != nil {
		return nil, err
	}

	return signer.signMessage(key, config, msg)
}

func verifyMessage(isClient bool, version uint16, key crypto.PublicKey, config *Config, sigAlg signatureAlgorithm, msg, sig []byte) error {
	if version >= VersionTLS12 && !slices.Contains(config.verifySignatureAlgorithms(), sigAlg) {
		return errors.New("tls: unsupported signature algorithm")
	}

	signer, err := getSigner(isClient, version, key, config, sigAlg, true)
	if err != nil {
		return err
	}

	return signer.verifyMessage(key, msg, sig)
}

func verifyMessageDC(isClient bool, version uint16, key crypto.PublicKey, config *Config, sigAlg signatureAlgorithm, msg, sig []byte) error {
	if version >= VersionTLS12 && !slices.Contains(config.DelegatedCredentialAlgorithms, sigAlg) {
		return errors.New("tls: unsupported signature algorithm")
	}

	signer, err := getSigner(isClient, version, key, config, sigAlg, true)
	if err != nil {
		return err
	}

	return signer.verifyMessage(key, msg, sig)
}

type rsaPKCS1Signer struct {
	hash crypto.Hash
}

func (r *rsaPKCS1Signer) computeHash(msg []byte) []byte {
	if r.hash == crypto.MD5SHA1 {
		// crypto.MD5SHA1 is not a real hash function.
		hashMD5 := md5.New()
		hashMD5.Write(msg)
		hashSHA1 := sha1.New()
		hashSHA1.Write(msg)
		return hashSHA1.Sum(hashMD5.Sum(nil))
	}

	h := r.hash.New()
	h.Write(msg)
	return h.Sum(nil)
}

func (r *rsaPKCS1Signer) supportsKey(key crypto.PrivateKey) bool {
	_, ok := key.(*rsa.PrivateKey)
	return ok
}

func (r *rsaPKCS1Signer) signMessage(key crypto.PrivateKey, config *Config, msg []byte) ([]byte, error) {
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("invalid key type for RSA-PKCS1")
	}

	return rsa.SignPKCS1v15(config.rand(), rsaKey, r.hash, r.computeHash(msg))
}

func (r *rsaPKCS1Signer) verifyMessage(key crypto.PublicKey, msg, sig []byte) error {
	rsaKey, ok := key.(*rsa.PublicKey)
	if !ok {
		return errors.New("invalid key type for RSA-PKCS1")
	}

	return rsa.VerifyPKCS1v15(rsaKey, r.hash, r.computeHash(msg), sig)
}

type ecdsaSigner struct {
	version uint16
	config  *Config
	curve   elliptic.Curve
	hash    crypto.Hash
}

func (e *ecdsaSigner) isCurveValid(curve elliptic.Curve) bool {
	if e.config.Bugs.SkipECDSACurveCheck {
		return true
	}
	if e.version <= VersionTLS12 {
		return true
	}
	return e.curve != nil && curve == e.curve
}

func (e *ecdsaSigner) supportsKey(key crypto.PrivateKey) bool {
	ecdsaKey, ok := key.(*ecdsa.PrivateKey)
	return ok && e.isCurveValid(ecdsaKey.Curve)
}

func maybeCorruptECDSAValue(n *big.Int, typeOfCorruption BadValue, limit *big.Int) *big.Int {
	switch typeOfCorruption {
	case BadValueNone:
		return n
	case BadValueNegative:
		return new(big.Int).Neg(n)
	case BadValueZero:
		return big.NewInt(0)
	case BadValueLimit:
		return limit
	case BadValueLarge:
		bad := new(big.Int).Set(limit)
		return bad.Lsh(bad, 20)
	default:
		panic("unknown BadValue type")
	}
}

func (e *ecdsaSigner) signMessage(key crypto.PrivateKey, config *Config, msg []byte) ([]byte, error) {
	ecdsaKey, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("invalid key type for ECDSA")
	}
	if !e.isCurveValid(ecdsaKey.Curve) {
		return nil, errors.New("invalid curve for ECDSA")
	}

	h := e.hash.New()
	h.Write(msg)
	digest := h.Sum(nil)

	r, s, err := ecdsa.Sign(config.rand(), ecdsaKey, digest)
	if err != nil {
		return nil, errors.New("failed to sign ECDHE parameters: " + err.Error())
	}
	order := ecdsaKey.Curve.Params().N
	r = maybeCorruptECDSAValue(r, config.Bugs.BadECDSAR, order)
	s = maybeCorruptECDSAValue(s, config.Bugs.BadECDSAS, order)
	return asn1.Marshal(ecdsaSignature{r, s})
}

func (e *ecdsaSigner) verifyMessage(key crypto.PublicKey, msg, sig []byte) error {
	ecdsaKey, ok := key.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("invalid key type for ECDSA")
	}
	if !e.isCurveValid(ecdsaKey.Curve) {
		return errors.New("invalid curve for ECDSA")
	}

	ecdsaSig := new(ecdsaSignature)
	if _, err := asn1.Unmarshal(sig, ecdsaSig); err != nil {
		return err
	}
	if ecdsaSig.R.Sign() <= 0 || ecdsaSig.S.Sign() <= 0 {
		return errors.New("ECDSA signature contained zero or negative values")
	}

	h := e.hash.New()
	h.Write(msg)
	if !ecdsa.Verify(ecdsaKey, h.Sum(nil), ecdsaSig.R, ecdsaSig.S) {
		return errors.New("ECDSA verification failure")
	}
	return nil
}

var pssOptions = rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash}

type rsaPSSSigner struct {
	hash crypto.Hash
}

func (r *rsaPSSSigner) supportsKey(key crypto.PrivateKey) bool {
	_, ok := key.(*rsa.PrivateKey)
	return ok
}

func (r *rsaPSSSigner) signMessage(key crypto.PrivateKey, config *Config, msg []byte) ([]byte, error) {
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("invalid key type for RSA-PSS")
	}

	h := r.hash.New()
	h.Write(msg)
	return rsa.SignPSS(config.rand(), rsaKey, r.hash, h.Sum(nil), &pssOptions)
}

func (r *rsaPSSSigner) verifyMessage(key crypto.PublicKey, msg, sig []byte) error {
	rsaKey, ok := key.(*rsa.PublicKey)
	if !ok {
		return errors.New("invalid key type for RSA-PSS")
	}

	h := r.hash.New()
	h.Write(msg)
	return rsa.VerifyPSS(rsaKey, r.hash, h.Sum(nil), sig, &pssOptions)
}

type ed25519Signer struct{}

func (e *ed25519Signer) supportsKey(key crypto.PrivateKey) bool {
	_, ok := key.(ed25519.PrivateKey)
	return ok
}

func (e *ed25519Signer) signMessage(key crypto.PrivateKey, config *Config, msg []byte) ([]byte, error) {
	privKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("invalid key type for Ed25519")
	}

	return ed25519.Sign(privKey, msg), nil
}

func (e *ed25519Signer) verifyMessage(key crypto.PublicKey, msg, sig []byte) error {
	pubKey, ok := key.(ed25519.PublicKey)
	if !ok {
		return errors.New("invalid key type for Ed25519")
	}

	if !ed25519.Verify(pubKey, msg, sig) {
		return errors.New("invalid Ed25519 signature")
	}

	return nil
}

func getSigner(isClient bool, version uint16, key any, config *Config, sigAlg signatureAlgorithm, isVerify bool) (signer, error) {
	// TLS 1.1 and below use legacy signature algorithms.
	if version < VersionTLS12 || (!isVerify && config.Bugs.AlwaysSignAsLegacyVersion) {
		if config.Bugs.SigningAlgorithmForLegacyVersions == 0 || isVerify {
			switch key.(type) {
			case *rsa.PrivateKey, *rsa.PublicKey:
				return &rsaPKCS1Signer{crypto.MD5SHA1}, nil
			case *ecdsa.PrivateKey, *ecdsa.PublicKey:
				return &ecdsaSigner{version, config, nil, crypto.SHA1}, nil
			default:
				return nil, errors.New("unknown key type")
			}
		}

		// Fall through, forcing a particular algorithm.
		sigAlg = config.Bugs.SigningAlgorithmForLegacyVersions
	}

	isClientSign := isClient != isVerify
	switch sigAlg {
	case signatureRSAPKCS1WithMD5:
		if version < VersionTLS13 || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.MD5}, nil
		}
	case signatureRSAPKCS1WithSHA1:
		if version < VersionTLS13 || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.SHA1}, nil
		}
	case signatureRSAPKCS1WithSHA256:
		if version < VersionTLS13 || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.SHA256}, nil
		}
	case signatureRSAPKCS1WithSHA384:
		if version < VersionTLS13 || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.SHA384}, nil
		}
	case signatureRSAPKCS1WithSHA512:
		if version < VersionTLS13 || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.SHA512}, nil
		}
	case signatureRSAPKCS1WithSHA256Legacy:
		if (isClientSign && version >= VersionTLS13) || config.Bugs.IgnoreSignatureVersionChecks {
			return &rsaPKCS1Signer{crypto.SHA256}, nil
		}
	case signatureECDSAWithSHA1:
		return &ecdsaSigner{version, config, nil, crypto.SHA1}, nil
	case signatureECDSAWithP256AndSHA256:
		return &ecdsaSigner{version, config, elliptic.P256(), crypto.SHA256}, nil
	case signatureECDSAWithP384AndSHA384:
		return &ecdsaSigner{version, config, elliptic.P384(), crypto.SHA384}, nil
	case signatureECDSAWithP521AndSHA512:
		return &ecdsaSigner{version, config, elliptic.P521(), crypto.SHA512}, nil
	case signatureRSAPSSWithSHA256:
		return &rsaPSSSigner{crypto.SHA256}, nil
	case signatureRSAPSSWithSHA384:
		return &rsaPSSSigner{crypto.SHA384}, nil
	case signatureRSAPSSWithSHA512:
		return &rsaPSSSigner{crypto.SHA512}, nil
	case signatureEd25519:
		return &ed25519Signer{}, nil
	}

	return nil, fmt.Errorf("unsupported signature algorithm %04x", sigAlg)
}
