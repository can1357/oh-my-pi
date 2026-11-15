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
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"time"

	"golang.org/x/crypto/cryptobyte"
)

// delegatedCredentialConfig specifies the shape of a delegated credential, not
// including the keys themselves.
type delegatedCredentialConfig struct {
	// lifetime is the amount of time, from the notBefore of the parent
	// certificate, that the delegated credential is valid for. If zero, then 24
	// hours is assumed.
	lifetime time.Duration
	// dcAlgo is the signature scheme that should be used with this delegated
	// credential. If zero, ECDSA with P-256 is assumed.
	dcAlgo signatureAlgorithm
	// algo is the signature algorithm that the delegated credential itself is
	// signed with. Cannot be zero.
	algo signatureAlgorithm
}

func createDelegatedCredential(parent *Credential, config delegatedCredentialConfig) *Credential {
	if parent.Type != CredentialTypeX509 {
		panic("delegated credentials must be issued by X.509 credentials")
	}

	dcAlgo := config.dcAlgo
	if dcAlgo == 0 {
		dcAlgo = signatureECDSAWithP256AndSHA256
	}

	var dcPriv crypto.Signer
	switch dcAlgo {
	case signatureRSAPKCS1WithMD5, signatureRSAPKCS1WithSHA1, signatureRSAPKCS1WithSHA256, signatureRSAPKCS1WithSHA384, signatureRSAPKCS1WithSHA512, signatureRSAPSSWithSHA256, signatureRSAPSSWithSHA384, signatureRSAPSSWithSHA512:
		dcPriv = &rsa2048Key

	case signatureECDSAWithSHA1, signatureECDSAWithP256AndSHA256, signatureECDSAWithP384AndSHA384, signatureECDSAWithP521AndSHA512:
		var curve elliptic.Curve
		switch dcAlgo {
		case signatureECDSAWithSHA1, signatureECDSAWithP256AndSHA256:
			curve = elliptic.P256()
		case signatureECDSAWithP384AndSHA384:
			curve = elliptic.P384()
		case signatureECDSAWithP521AndSHA512:
			curve = elliptic.P521()
		default:
			panic("internal error")
		}

		priv, err := ecdsa.GenerateKey(curve, rand.Reader)
		if err != nil {
			panic(err)
		}
		dcPriv = priv

	default:
		panic(fmt.Errorf("unsupported DC signature algorithm: %x", dcAlgo))
	}

	lifetime := config.lifetime
	if lifetime == 0 {
		lifetime = 24 * time.Hour
	}
	lifetimeSecs := int64(lifetime.Seconds())
	if lifetimeSecs < 0 || lifetimeSecs > 1<<32 {
		panic(fmt.Errorf("lifetime %s is too long to be expressed", lifetime))
	}

	// https://www.rfc-editor.org/rfc/rfc9345.html#section-4
	dc := cryptobyte.NewBuilder(nil)
	dc.AddUint32(uint32(lifetimeSecs))
	dc.AddUint16(uint16(dcAlgo))

	pubBytes, err := x509.MarshalPKIXPublicKey(dcPriv.Public())
	if err != nil {
		panic(err)
	}
	addUint24LengthPrefixedBytes(dc, pubBytes)

	var dummyConfig Config
	msg := delegatedCredentialSignedMessage(dc.BytesOrPanic(), config.algo, parent.Certificate[0])
	parentSignature, err := signMessage(false /* server */, VersionTLS13, parent.PrivateKey, &dummyConfig, config.algo, msg)
	if err != nil {
		panic(err)
	}

	dc.AddUint16(uint16(config.algo))
	addUint16LengthPrefixedBytes(dc, parentSignature)

	dcCred := *parent
	dcCred.Type = CredentialTypeDelegated
	dcCred.DelegatedCredential = dc.BytesOrPanic()
	dcCred.PrivateKey = dcPriv
	dcCred.KeyPath = writeTempKeyFile(dcPriv)
	return &dcCred
}

func addDelegatedCredentialTests() {
	p256DC := createDelegatedCredential(&rsaCertificate, delegatedCredentialConfig{
		dcAlgo: signatureECDSAWithP256AndSHA256,
		algo:   signatureRSAPSSWithSHA256,
	})
	p256DCFromECDSA := createDelegatedCredential(&ecdsaP256Certificate, delegatedCredentialConfig{
		dcAlgo: signatureECDSAWithP256AndSHA256,
		algo:   signatureECDSAWithP256AndSHA256,
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-NoClientSupport",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-Basic",
		config: Config{
			MinVersion:                    VersionTLS13,
			MaxVersion:                    VersionTLS13,
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "0"},
		expectations: connectionExpectations{
			peerCertificate: p256DC,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-ExactAlgorithmMatch",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			// Test that the server doesn't mix up the two signature algorithm
			// fields. These options are a match because the signature_algorithms
			// extension matches against the signature on the delegated
			// credential, while the delegated_credential extension matches
			// against the signature made by the delegated credential.
			VerifySignatureAlgorithms:     []signatureAlgorithm{signatureRSAPSSWithSHA256},
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "0"},
		expectations: connectionExpectations{
			peerCertificate: p256DC,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-SigAlgoMissing",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			// If the client doesn't support the signature in the delegated credential,
			// the server should not use delegated credentials.
			VerifySignatureAlgorithms:     []signatureAlgorithm{signatureRSAPSSWithSHA384},
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-CertVerifySigAlgoMissing",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			// If the client doesn't support the delegated credential's
			// CertificateVerify algorithm, the server should not use delegated
			// credentials.
			VerifySignatureAlgorithms:     []signatureAlgorithm{signatureRSAPSSWithSHA256},
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP384AndSHA384},
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
	})

	// Delegated credentials are not supported at TLS 1.2, even if the client
	// sends the extension.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-TLS12-Forbidden",
		config: Config{
			MinVersion:                    VersionTLS12,
			MaxVersion:                    VersionTLS12,
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
		},
		shimCredentials: []*Credential{p256DC, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
	})

	// Generate another delegated credential, so we can get the keys out of sync.
	dcWrongKey := createDelegatedCredential(&rsaCertificate, delegatedCredentialConfig{
		algo: signatureRSAPSSWithSHA256,
	})
	dcWrongKey.DelegatedCredential = p256DC.DelegatedCredential
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-KeyMismatch",
		// The handshake hints version of the test will, as a side effect, use a
		// custom private key. Custom private keys can't be checked for key
		// mismatches.
		skipHints:       true,
		shimCredentials: []*Credential{dcWrongKey},
		shouldFail:      true,
		expectedError:   ":KEY_VALUES_MISMATCH:",
	})

	// RSA delegated credentials should be rejected at configuration time.
	rsaDC := createDelegatedCredential(&rsaCertificate, delegatedCredentialConfig{
		algo:   signatureRSAPSSWithSHA256,
		dcAlgo: signatureRSAPSSWithSHA256,
	})
	testCases = append(testCases, testCase{
		testType:        serverTest,
		name:            "DelegatedCredentials-NoRSA",
		shimCredentials: []*Credential{rsaDC},
		shouldFail:      true,
		expectedError:   ":INVALID_SIGNATURE_ALGORITHM:",
	})

	// If configured with multiple delegated credentials, the server can cleanly
	// select the first one that works.
	p384DC := createDelegatedCredential(&rsaCertificate, delegatedCredentialConfig{
		dcAlgo: signatureECDSAWithP384AndSHA384,
		algo:   signatureRSAPSSWithSHA256,
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-Multiple",
		config: Config{
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP384AndSHA384},
		},
		shimCredentials: []*Credential{p256DC, p384DC},
		flags:           []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: p384DC,
		},
	})

	// Delegated credentials participate in issuer-based certificate selection.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-MatchIssuer",
		config: Config{
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			// The client requested p256DCFromECDSA's issuer.
			RootCAs:     makeCertPoolFromRoots(p256DCFromECDSA),
			SendRootCAs: true,
		},
		shimCredentials: []*Credential{
			p256DC.WithMustMatchIssuer(true), p256DCFromECDSA.WithMustMatchIssuer(true)},
		flags: []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: p256DCFromECDSA,
		},
	})

	// Delegated credentials participate in trust anchor IDs.
	id1 := []byte{1, 1}
	id2 := []byte{2, 2, 2}
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DelegatedCredentials-TrustAnchorIDs",
		config: Config{
			RequestTrustAnchors:           [][]byte{id2},
			DelegatedCredentialAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			Bugs: ProtocolBugs{
				ExpectPeerAvailableTrustAnchors: [][]byte{id1, id2},
			},
		},
		shimCredentials: []*Credential{
			p256DC.WithTrustAnchorID(id1), p256DCFromECDSA.WithTrustAnchorID(id2)},
		flags: []string{"-expect-selected-credential", "1"},
		expectations: connectionExpectations{
			peerCertificate: p256DCFromECDSA,
		},
	})
}
