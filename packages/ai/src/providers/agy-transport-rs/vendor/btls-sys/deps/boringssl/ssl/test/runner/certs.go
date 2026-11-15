// Copyright 2025 The BoringSSL Authors
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
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"math/bits"
	"os"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

// A custom X.509 certificate generator. This file exists both to give more
// convenient ways to generate X.509 certificates, as well as add support for
// key types that upstream Go does not support. As a result, it does not reuse
// the x509.Certificate encoder.

var (
	oidSHA256WithRSAEncryption = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidECDSAWithSHA256         = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
	oidEd25519                 = asn1.ObjectIdentifier{1, 3, 101, 112}
	oidPSS                     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 10}

	oidSHA256 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}

	oidMGF1 = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 8}

	oidSubjectKeyID     = []int{2, 5, 29, 14}
	oidKeyUsage         = []int{2, 5, 29, 15}
	oidSubjectAltName   = []int{2, 5, 29, 17}
	oidBasicConstraints = []int{2, 5, 29, 19}
	oidAuthorityKeyID   = []int{2, 5, 29, 35}

	lastSerial atomic.Uint64

	tmpDir string
)

type X509SignatureAlgorithm int

const (
	X509SignDefault X509SignatureAlgorithm = iota
	X509SignRSAWithSHA256
	X509SignECDSAWithSHA256
	X509SignEd25519
)

func (alg X509SignatureAlgorithm) Marshal(bb *cryptobyte.Builder) error {
	switch alg {
	case X509SignRSAWithSHA256:
		bb.AddASN1(cbasn1.SEQUENCE, func(algID *cryptobyte.Builder) {
			algID.AddASN1ObjectIdentifier(oidSHA256WithRSAEncryption)
			algID.AddASN1NULL()
		})
	case X509SignECDSAWithSHA256:
		bb.AddASN1(cbasn1.SEQUENCE, func(algID *cryptobyte.Builder) {
			algID.AddASN1ObjectIdentifier(oidECDSAWithSHA256)
		})
	case X509SignEd25519:
		bb.AddASN1(cbasn1.SEQUENCE, func(algID *cryptobyte.Builder) {
			algID.AddASN1ObjectIdentifier(oidEd25519)
		})
	default:
		return errors.New("unknown algorithm")
	}
	return nil
}

func chooseDefaultX509SignatureAlgorithm(signer crypto.Signer) (X509SignatureAlgorithm, error) {
	if _, ok := signer.(*rsa.PrivateKey); ok {
		return X509SignRSAWithSHA256, nil
	}
	if _, ok := signer.(*ecdsa.PrivateKey); ok {
		return X509SignECDSAWithSHA256, nil
	}
	if _, ok := signer.(ed25519.PrivateKey); ok {
		return X509SignEd25519, nil
	}
	return 0, fmt.Errorf("unsupported key type: %T", signer)
}

func signX509(signer crypto.Signer, alg X509SignatureAlgorithm, in []byte) ([]byte, error) {
	var opts crypto.SignerOpts
	if _, ok := signer.(*rsa.PrivateKey); ok {
		switch alg {
		case X509SignRSAWithSHA256:
			opts = crypto.SHA256
		default:
			return nil, errors.New("unknown algorithm")
		}
	} else if _, ok := signer.(*ecdsa.PrivateKey); ok {
		switch alg {
		case X509SignECDSAWithSHA256:
			opts = crypto.SHA256
		default:
			return nil, errors.New("unknown algorithm")
		}
	} else if _, ok := signer.(ed25519.PrivateKey); ok {
		switch alg {
		case X509SignEd25519:
			opts = crypto.Hash(0)
		default:
			return nil, errors.New("unknown algorithm")
		}
	} else {
		return nil, fmt.Errorf("unsupported key type: %T", signer)
	}

	digest := in
	if hash := opts.HashFunc(); hash != crypto.Hash(0) {
		h := hash.New()
		h.Write(in)
		digest = h.Sum(nil)
	}
	return signer.Sign(rand.Reader, digest, opts)
}

func addX509Time(bb *cryptobyte.Builder, t time.Time) {
	t = t.UTC()
	if y := t.Year(); 1950 <= y && y <= 2049 {
		bb.AddASN1UTCTime(t)
	} else {
		bb.AddASN1GeneralizedTime(t)
	}
}

func addASN1ImplicitString(bb *cryptobyte.Builder, tag cbasn1.Tag, b []byte) {
	bb.AddASN1(tag, func(child *cryptobyte.Builder) { child.AddBytes(b) })
}

func addASN1ExplicitTag(bb *cryptobyte.Builder, outerTag, innerTag cbasn1.Tag, cb func(*cryptobyte.Builder)) {
	bb.AddASN1(outerTag.Constructed().ContextSpecific(), func(child *cryptobyte.Builder) {
		child.AddASN1(innerTag, cb)
	})
}

func addRSAPSSSubjectPublicKeyInfo(bb *cryptobyte.Builder, key *rsa.PublicKey) {
	bb.AddASN1(cbasn1.SEQUENCE, func(spki *cryptobyte.Builder) {
		spki.AddASN1(cbasn1.SEQUENCE, func(algID *cryptobyte.Builder) {
			algID.AddASN1ObjectIdentifier(oidPSS)
			algID.AddASN1(cbasn1.SEQUENCE, func(params *cryptobyte.Builder) {
				addASN1ExplicitTag(params, 0, cbasn1.SEQUENCE, func(hash *cryptobyte.Builder) {
					hash.AddASN1ObjectIdentifier(oidSHA256)
					hash.AddASN1NULL()
				})
				addASN1ExplicitTag(params, 1, cbasn1.SEQUENCE, func(mgf *cryptobyte.Builder) {
					mgf.AddASN1ObjectIdentifier(oidMGF1)
					mgf.AddASN1(cbasn1.SEQUENCE, func(hash *cryptobyte.Builder) {
						hash.AddASN1ObjectIdentifier(oidSHA256)
						hash.AddASN1NULL()
					})
				})
				params.AddASN1(cbasn1.Tag(2).Constructed().ContextSpecific(), func(saltLen *cryptobyte.Builder) {
					saltLen.AddASN1Uint64(32)
				})
			})
		})
		spki.AddASN1BitString(x509.MarshalPKCS1PublicKey(key))
	})
}

type X509Info struct {
	PrivateKey         crypto.Signer
	Name               pkix.Name
	DNSNames           []string
	IsCA               bool
	SubjectKeyID       []byte
	KeyUsage           x509.KeyUsage
	SignatureAlgorithm X509SignatureAlgorithm
	// EncodeSPKIAsRSAPSS, if true, causes the subjectPublicKeyInfo field to be
	// encoded as id-RSASSA-PSS with SHA-256 parameters, instead of
	// id-rsaEncryption. This is sufficient for our purposes because we do not
	// need real id-RSASSA-PSS support in the test runner. If we ever to, we
	// can replace this with a real PSSPrivateKey type.
	EncodeSPKIAsRSAPSS bool
}

type X509ChainBuilder struct {
	privateKey   crypto.Signer
	name         pkix.Name
	subjectKeyID []byte
	rootCert     []byte
	rootPath     string
	chain        [][]byte
}

func x509ChainBuilderFromInfo(info X509Info) *X509ChainBuilder {
	return &X509ChainBuilder{
		privateKey:   info.PrivateKey,
		name:         info.Name,
		subjectKeyID: info.SubjectKeyID,
	}
}

func NewX509Root(root X509Info) *X509ChainBuilder {
	ret := x509ChainBuilderFromInfo(root).Issue(root)
	ret.rootCert = ret.chain[0]
	ret.rootPath = writeTempCertFile([][]byte{ret.rootCert})
	ret.chain = nil
	return ret
}

func (issuer *X509ChainBuilder) Issue(subject X509Info) *X509ChainBuilder {
	serial := lastSerial.Add(1)

	sigAlg := subject.SignatureAlgorithm
	if sigAlg == X509SignDefault {
		var err error
		sigAlg, err = chooseDefaultX509SignatureAlgorithm(issuer.privateKey)
		if err != nil {
			panic(err)
		}
	}

	notBefore := time.Now().Add(-time.Hour)
	notAfter := time.Now().Add(time.Hour)

	bb := cryptobyte.NewBuilder(nil)
	bb.AddASN1(cbasn1.SEQUENCE, func(tbs *cryptobyte.Builder) {
		tbs.AddASN1(cbasn1.Tag(0).Constructed().ContextSpecific(), func(vers *cryptobyte.Builder) {
			vers.AddASN1Uint64(2) // v3
		})
		tbs.AddASN1Uint64(serial)
		tbs.AddValue(sigAlg)
		issuerDER, err := asn1.Marshal(issuer.name.ToRDNSequence())
		if err != nil {
			tbs.SetError(err)
			return
		}
		tbs.AddBytes(issuerDER)
		tbs.AddASN1(cbasn1.SEQUENCE, func(val *cryptobyte.Builder) {
			addX509Time(val, notBefore)
			addX509Time(val, notAfter)
		})
		subjectDER, err := asn1.Marshal(subject.Name.ToRDNSequence())
		if err != nil {
			tbs.SetError(err)
			return
		}
		tbs.AddBytes(subjectDER)
		if subject.EncodeSPKIAsRSAPSS {
			addRSAPSSSubjectPublicKeyInfo(tbs, subject.PrivateKey.Public().(*rsa.PublicKey))
		} else {
			spki, err := x509.MarshalPKIXPublicKey(subject.PrivateKey.Public())
			if err != nil {
				tbs.SetError(err)
				return
			}
			tbs.AddBytes(spki)
		}
		addASN1ExplicitTag(tbs, 3, cbasn1.SEQUENCE, func(exts *cryptobyte.Builder) {
			if len(issuer.subjectKeyID) != 0 {
				exts.AddASN1(cbasn1.SEQUENCE, func(ext *cryptobyte.Builder) {
					ext.AddASN1ObjectIdentifier(oidAuthorityKeyID)
					ext.AddASN1(cbasn1.OCTET_STRING, func(extVal *cryptobyte.Builder) {
						extVal.AddASN1(cbasn1.SEQUENCE, func(akid *cryptobyte.Builder) {
							addASN1ImplicitString(akid, cbasn1.Tag(0).ContextSpecific(), issuer.subjectKeyID)
						})
					})
				})
			}

			if subject.KeyUsage != 0 {
				exts.AddASN1(cbasn1.SEQUENCE, func(ext *cryptobyte.Builder) {
					ext.AddASN1ObjectIdentifier(oidKeyUsage)
					ext.AddASN1Boolean(true) // critical
					ext.AddASN1(cbasn1.OCTET_STRING, func(extVal *cryptobyte.Builder) {
						var b [2]byte
						// DER orders the bits from most to least significant.
						b[0] = bits.Reverse8(byte(subject.KeyUsage))
						b[1] = bits.Reverse8(byte(subject.KeyUsage >> 8))
						// If the final byte is all zeros, skip it.
						var ku asn1.BitString
						if b[1] == 0 {
							ku.Bytes = b[:1]
						} else {
							ku.Bytes = b[:]
						}
						ku.BitLength = bits.Len16(uint16(subject.KeyUsage))
						der, err := asn1.Marshal(ku)
						if err != nil {
							extVal.SetError(err)
						} else {
							extVal.AddBytes(der)
						}
					})
				})
			}

			if len(subject.DNSNames) != 0 {
				exts.AddASN1(cbasn1.SEQUENCE, func(ext *cryptobyte.Builder) {
					ext.AddASN1ObjectIdentifier(oidSubjectAltName)
					ext.AddASN1(cbasn1.OCTET_STRING, func(extVal *cryptobyte.Builder) {
						extVal.AddASN1(cbasn1.SEQUENCE, func(names *cryptobyte.Builder) {
							for _, dns := range subject.DNSNames {
								addASN1ImplicitString(names, cbasn1.Tag(2).ContextSpecific(), []byte(dns))
							}
						})
					})
				})
			}

			if subject.IsCA {
				exts.AddASN1(cbasn1.SEQUENCE, func(ext *cryptobyte.Builder) {
					ext.AddASN1ObjectIdentifier(oidBasicConstraints)
					ext.AddASN1Boolean(true) // critical
					ext.AddASN1(cbasn1.OCTET_STRING, func(extVal *cryptobyte.Builder) {
						extVal.AddASN1(cbasn1.SEQUENCE, func(bcons *cryptobyte.Builder) {
							bcons.AddASN1Boolean(true)
						})
					})
				})
			}

			if len(subject.SubjectKeyID) != 0 {
				exts.AddASN1(cbasn1.SEQUENCE, func(ext *cryptobyte.Builder) {
					ext.AddASN1ObjectIdentifier(oidSubjectKeyID)
					ext.AddASN1(cbasn1.OCTET_STRING, func(extVal *cryptobyte.Builder) {
						extVal.AddASN1OctetString(subject.SubjectKeyID)
					})
				})
			}
		})
	})

	tbs := bb.BytesOrPanic()
	sig, err := signX509(issuer.privateKey, sigAlg, tbs)
	if err != nil {
		panic(err)
	}

	bb = cryptobyte.NewBuilder(nil)
	bb.AddASN1(cbasn1.SEQUENCE, func(cert *cryptobyte.Builder) {
		cert.AddBytes(tbs)
		cert.AddValue(sigAlg)
		cert.AddASN1BitString(sig)
	})
	cert := bb.BytesOrPanic()

	ret := x509ChainBuilderFromInfo(subject)
	ret.rootCert = issuer.rootCert
	ret.rootPath = issuer.rootPath
	ret.chain = make([][]byte, len(issuer.chain)+1)
	copy(ret.chain, issuer.chain)
	ret.chain[len(ret.chain)-1] = cert
	return ret
}

func (b *X509ChainBuilder) ToCredential() Credential {
	return Credential{
		Certificate:     b.chain,
		ChainPath:       writeTempCertFile(b.chain),
		PrivateKey:      b.privateKey,
		KeyPath:         writeTempKeyFile(b.privateKey),
		RootCertificate: b.rootCert,
		RootPath:        b.rootPath,
	}
}

func writeTempCertFile(certs [][]byte) string {
	f, err := os.CreateTemp(tmpDir, "test-cert")
	if err != nil {
		panic(fmt.Sprintf("failed to create temp file: %s", err))
	}
	for _, cert := range certs {
		if err := pem.Encode(f, &pem.Block{Type: "CERTIFICATE", Bytes: cert}); err != nil {
			panic(fmt.Sprintf("failed to write test certificate: %s", err))
		}
	}
	tmpCertPath := f.Name()
	if err := f.Close(); err != nil {
		panic(fmt.Sprintf("failed to close test certificate temp file: %s", err))
	}
	return tmpCertPath
}

func writeTempKeyFile(privKey crypto.PrivateKey) string {
	f, err := os.CreateTemp(tmpDir, "test-key")
	if err != nil {
		panic(fmt.Sprintf("failed to create temp file: %s", err))
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(privKey)
	if err != nil {
		panic(fmt.Sprintf("failed to marshal test key: %s", err))
	}
	if err := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}); err != nil {
		panic(fmt.Sprintf("failed to write test key: %s", err))
	}
	tmpKeyPath := f.Name()
	if err := f.Close(); err != nil {
		panic(fmt.Sprintf("failed to close test key temp file: %s", err))
	}
	return tmpKeyPath
}
