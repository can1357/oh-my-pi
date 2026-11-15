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
	"fmt"
	"strconv"
)

func canBeShimCertificate(c *Credential) bool {
	// Some options can only be set with the credentials API.
	return c.Type == CredentialTypeX509 && !c.MustMatchIssuer && c.TrustAnchorID == nil
}

func addCertificateSelectionTests() {
	// Combinatorially test each selection criteria at different versions,
	// protocols, and with the matching certificate before and after the
	// mismatching one.
	type certSelectTest struct {
		name          string
		testType      testType
		minVersion    uint16
		maxVersion    uint16
		config        Config
		match         *Credential
		mismatch      *Credential
		flags         []string
		expectedError string
	}
	certSelectTests := []certSelectTest{
		// TLS 1.0 through TLS 1.2 servers should incorporate TLS cipher suites
		// into certificate selection.
		{
			name:       "Server-CipherSuite-ECDHE_ECDSA",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},
		{
			name:       "Server-CipherSuite-ECDHE_RSA",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &rsaCertificate,
			mismatch:      &ecdsaP256Certificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},
		{
			name:       "Server-CipherSuite-RSA",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &rsaCertificate,
			mismatch:      &ecdsaP256Certificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},

		// Ed25519 counts as ECDSA for purposes of cipher suite matching.
		{
			name:       "Server-CipherSuite-ECDHE_ECDSA-Ed25519",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &ed25519Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},
		{
			name:       "Server-CipherSuite-ECDHE_RSA-Ed25519",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &rsaCertificate,
			mismatch:      &ed25519Certificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},

		// If there is no ECDHE curve match, ECDHE cipher suites are
		// disqualified in TLS 1.2 and below. This, in turn, impacts the
		// available cipher suites for each credential.
		{
			name:       "Server-CipherSuite-NoECDHE",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CurvePreferences: []CurveID{CurveP256},
			},
			flags:         []string{"-curves", strconv.Itoa(int(CurveX25519))},
			match:         &rsaCertificate,
			mismatch:      &ecdsaP256Certificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},

		// If the client offered a cipher that would allow a certificate, but it
		// wasn't one of the ones we configured, the certificate should be
		// skipped in favor of another one.
		{
			name:       "Server-CipherSuite-Prefs",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CipherSuites: []uint16{
					TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
					TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			flags:         []string{"-cipher", "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA"},
			match:         &rsaCertificate,
			mismatch:      &ecdsaP256Certificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},

		// TLS 1.0 through 1.2 servers should incorporate the curve list into
		// ECDSA certificate selection.
		{
			name:       "Server-Curve",
			testType:   serverTest,
			maxVersion: VersionTLS12,
			config: Config{
				CurvePreferences: []CurveID{CurveP256},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &ecdsaP384Certificate,
			expectedError: ":WRONG_CURVE:",
		},

		// TLS 1.3 servers ignore the curve list. ECDSA certificate selection is
		// solely determined by the signature algorithm list.
		{
			name:       "Server-IgnoreCurve",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				CurvePreferences: []CurveID{CurveP256},
			},
			match: &ecdsaP384Certificate,
		},

		// TLS 1.2 servers also ignore the curve list for Ed25519. The signature
		// algorithm list is sufficient for Ed25519.
		{
			name:       "Server-IgnoreCurveEd25519",
			testType:   serverTest,
			minVersion: VersionTLS12,
			config: Config{
				CurvePreferences: []CurveID{CurveP256},
			},
			match: &ed25519Certificate,
		},

		// Without signature algorithm negotiation, Ed25519 is not usable in TLS
		// 1.1 and below.
		{
			name:       "Server-NoEd25519",
			testType:   serverTest,
			maxVersion: VersionTLS11,
			match:      &rsaCertificate,
			mismatch:   &ed25519Certificate,
		},

		// TLS 1.2 and up should incorporate the signature algorithm list into
		// certificate selection.
		{
			name:       "Server-SignatureAlgorithm",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
				CipherSuites: []uint16{
					TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
					TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":NO_SHARED_CIPHER:",
		},
		{
			name:       "Server-SignatureAlgorithm",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// TLS 1.2's use of the signature algorithm list only disables the
		// signing-based algorithms. If an RSA key exchange cipher suite is
		// eligible, that is fine. (This is not a realistic configuration,
		// however. No one would configure RSA before ECDSA.)
		{
			name:       "Server-SignatureAlgorithmImpactsECDHEOnly",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
				CipherSuites: []uint16{
					TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
					TLS_RSA_WITH_AES_128_CBC_SHA,
				},
			},
			match: &rsaCertificate,
		},

		// TLS 1.3's use of the signature algorithm looks at the ECDSA curve
		// embedded in the signature algorithm.
		{
			name:       "Server-SignatureAlgorithmECDSACurve",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &ecdsaP384Certificate,
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// TLS 1.2's use does not.
		{
			name:       "Server-SignatureAlgorithmECDSACurve",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match: &ecdsaP384Certificate,
		},

		// TLS 1.0 and 1.1 do not look at the signature algorithm.
		{
			name:       "Server-IgnoreSignatureAlgorithm",
			testType:   serverTest,
			maxVersion: VersionTLS11,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match: &rsaCertificate,
		},

		// Signature algorithm matches take preferences on the keys into
		// consideration.
		{
			name:       "Server-SignatureAlgorithmKeyPrefs",
			testType:   serverTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureRSAPSSWithSHA256},
				CipherSuites:              []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			},
			match:         rsaChainCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			mismatch:      rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA384),
			expectedError: ":NO_SHARED_CIPHER:",
		},
		{
			name:       "Server-SignatureAlgorithmKeyPrefs",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureRSAPSSWithSHA256},
			},
			match:         rsaChainCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			mismatch:      rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA384),
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// TLS 1.2 clients and below check the certificate against the old
		// client certificate types field.
		{
			name:       "Client-ClientCertificateTypes-RSA",
			testType:   clientTest,
			maxVersion: VersionTLS12,
			config: Config{
				ClientAuth:             RequestClientCert,
				ClientCertificateTypes: []uint8{CertTypeRSASign},
			},
			match:         &rsaCertificate,
			mismatch:      &ecdsaP256Certificate,
			expectedError: ":UNKNOWN_CERTIFICATE_TYPE:",
		},
		{
			name:       "Client-ClientCertificateTypes-ECDSA",
			testType:   clientTest,
			maxVersion: VersionTLS12,
			config: Config{
				ClientAuth:             RequestClientCert,
				ClientCertificateTypes: []uint8{CertTypeECDSASign},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":UNKNOWN_CERTIFICATE_TYPE:",
		},

		// Ed25519 is considered ECDSA for purposes of client certificate types.
		{
			name:       "Client-ClientCertificateTypes-RSA-Ed25519",
			testType:   clientTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				ClientAuth:             RequestClientCert,
				ClientCertificateTypes: []uint8{CertTypeRSASign},
			},
			match:         &rsaCertificate,
			mismatch:      &ed25519Certificate,
			expectedError: ":UNKNOWN_CERTIFICATE_TYPE:",
		},
		{
			name:       "Client-ClientCertificateTypes-ECDSA-Ed25519",
			testType:   clientTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				ClientAuth:             RequestClientCert,
				ClientCertificateTypes: []uint8{CertTypeECDSASign},
			},
			match:         &ed25519Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":UNKNOWN_CERTIFICATE_TYPE:",
		},

		// TLS 1.2 and up should incorporate the signature algorithm list into
		// certificate selection. (There is no signature algorithm list to look
		// at in TLS 1.0 and 1.1.)
		{
			name:       "Client-SignatureAlgorithm",
			testType:   clientTest,
			minVersion: VersionTLS12,
			config: Config{
				ClientAuth:                RequestClientCert,
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &rsaCertificate,
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// TLS 1.3's use of the signature algorithm looks at the ECDSA curve
		// embedded in the signature algorithm.
		{
			name:       "Client-SignatureAlgorithmECDSACurve",
			testType:   clientTest,
			minVersion: VersionTLS13,
			config: Config{
				ClientAuth:                RequestClientCert,
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match:         &ecdsaP256Certificate,
			mismatch:      &ecdsaP384Certificate,
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// TLS 1.2's use does not. It is not possible to determine what ECDSA
		// curves are allowed by the server.
		{
			name:       "Client-SignatureAlgorithmECDSACurve",
			testType:   clientTest,
			minVersion: VersionTLS12,
			maxVersion: VersionTLS12,
			config: Config{
				ClientAuth:                RequestClientCert,
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureECDSAWithP256AndSHA256},
			},
			match: &ecdsaP384Certificate,
		},

		// Signature algorithm matches take preferences on the keys into
		// consideration.
		{
			name:       "Client-SignatureAlgorithmKeyPrefs",
			testType:   clientTest,
			minVersion: VersionTLS12,
			config: Config{
				ClientAuth:                RequestClientCert,
				VerifySignatureAlgorithms: []signatureAlgorithm{signatureRSAPSSWithSHA256},
			},
			match:         rsaChainCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			mismatch:      rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA384),
			expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
		},

		// By default, certificate selection does not take issuers
		// into account.
		{
			name:     "Client-DontCheckIssuer",
			testType: clientTest,
			config: Config{
				ClientAuth: RequestClientCert,
				ClientCAs:  makeCertPoolFromRoots(&rsaChainCertificate, &ecdsaP384Certificate),
			},
			match: &ecdsaP256Certificate,
		},
		{
			name:     "Server-DontCheckIssuer",
			testType: serverTest,
			config: Config{
				RootCAs:     makeCertPoolFromRoots(&rsaChainCertificate, &ecdsaP384Certificate),
				SendRootCAs: true,
			},
			match: &ecdsaP256Certificate,
		},

		// If requested, certificate selection will match against the
		// requested issuers.
		{
			name:     "Client-CheckIssuer",
			testType: clientTest,
			config: Config{
				ClientAuth: RequestClientCert,
				ClientCAs:  makeCertPoolFromRoots(&rsaChainCertificate, &ecdsaP384Certificate),
			},
			match:         rsaChainCertificate.WithMustMatchIssuer(true),
			mismatch:      ecdsaP256Certificate.WithMustMatchIssuer(true),
			expectedError: ":NO_MATCHING_ISSUER:",
		},
		{
			name:     "Server-CheckIssuer",
			testType: serverTest,
			config: Config{
				RootCAs:     makeCertPoolFromRoots(&rsaChainCertificate, &ecdsaP384Certificate),
				SendRootCAs: true,
			},
			match:         rsaChainCertificate.WithMustMatchIssuer(true),
			mismatch:      ecdsaP256Certificate.WithMustMatchIssuer(true),
			expectedError: ":NO_MATCHING_ISSUER:",
		},

		// Trust anchor IDs can also be used to match issuers.
		// TODO(crbug.com/398275713): Implement this for client certificates.
		{
			name:       "Server-CheckIssuer-TrustAnchorIDs",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				RequestTrustAnchors: [][]byte{{1, 1, 1}},
			},
			match:         rsaChainCertificate.WithTrustAnchorID([]byte{1, 1, 1}),
			mismatch:      ecdsaP256Certificate.WithTrustAnchorID([]byte{2, 2, 2}),
			expectedError: ":NO_MATCHING_ISSUER:",
		},

		// When an issuer-gated credential fails, a normal credential may be
		// selected instead.
		{
			name:     "Client-CheckIssuerFallback",
			testType: clientTest,
			config: Config{
				ClientAuth: RequestClientCert,
				ClientCAs:  makeCertPoolFromRoots(&ecdsaP384Certificate),
			},
			match:         &rsaChainCertificate,
			mismatch:      ecdsaP256Certificate.WithMustMatchIssuer(true),
			expectedError: ":NO_MATCHING_ISSUER:",
		},
		{
			name:     "Server-CheckIssuerFallback",
			testType: serverTest,
			config: Config{
				RootCAs:     makeCertPoolFromRoots(&ecdsaP384Certificate),
				SendRootCAs: true,
			},
			match:         &rsaChainCertificate,
			mismatch:      ecdsaP256Certificate.WithMustMatchIssuer(true),
			expectedError: ":NO_MATCHING_ISSUER:",
		},
		{
			name:       "Server-CheckIssuerFallback-TrustAnchorIDs",
			testType:   serverTest,
			minVersion: VersionTLS13,
			config: Config{
				RequestTrustAnchors: [][]byte{{1, 1, 1}},
			},
			match:         &rsaChainCertificate,
			mismatch:      ecdsaP256Certificate.WithTrustAnchorID([]byte{2, 2, 2}),
			expectedError: ":NO_MATCHING_ISSUER:",
		},
	}

	for _, protocol := range []protocol{tls, dtls} {
		for _, vers := range allVersions(protocol) {
			suffix := fmt.Sprintf("%s-%s", protocol, vers)

			// Test that the credential list is interpreted in preference order,
			// with the default credential, if any, at the end.
			testCases = append(testCases, testCase{
				name:     fmt.Sprintf("CertificateSelection-Client-PreferenceOrder-%s", suffix),
				testType: clientTest,
				protocol: protocol,
				config: Config{
					MinVersion: vers.version,
					MaxVersion: vers.version,
					ClientAuth: RequestClientCert,
				},
				shimCredentials: []*Credential{&ecdsaP256Certificate, &ecdsaP384Certificate},
				shimCertificate: &rsaCertificate,
				flags:           []string{"-expect-selected-credential", "0"},
				expectations:    connectionExpectations{peerCertificate: &ecdsaP256Certificate},
			})
			testCases = append(testCases, testCase{
				name:     fmt.Sprintf("CertificateSelection-Server-PreferenceOrder-%s", suffix),
				testType: serverTest,
				protocol: protocol,
				config: Config{
					MinVersion: vers.version,
					MaxVersion: vers.version,
				},
				shimCredentials: []*Credential{&ecdsaP256Certificate, &ecdsaP384Certificate},
				shimCertificate: &rsaCertificate,
				flags:           []string{"-expect-selected-credential", "0"},
				expectations:    connectionExpectations{peerCertificate: &ecdsaP256Certificate},
			})

			// Test that the selected credential contributes the certificate chain, OCSP response,
			// and SCT list.
			testCases = append(testCases, testCase{
				name:     fmt.Sprintf("CertificateSelection-Server-OCSP-SCT-%s", suffix),
				testType: serverTest,
				protocol: protocol,
				config: Config{
					MinVersion: vers.version,
					MaxVersion: vers.version,
					// Configure enough options so that, at all TLS versions, only an RSA
					// certificate will be accepted.
					CipherSuites: []uint16{
						TLS_AES_128_GCM_SHA256,
						TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
						TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
					},
					VerifySignatureAlgorithms: []signatureAlgorithm{signatureRSAPSSWithSHA256},
				},
				shimCredentials: []*Credential{
					ecdsaP256Certificate.WithOCSP(testOCSPResponse2).WithSCTList(testSCTList2),
					rsaChainCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
				},
				shimCertificate: ecdsaP384Certificate.WithOCSP(testOCSPResponse2).WithSCTList(testSCTList2),
				flags:           []string{"-expect-selected-credential", "1"},
				expectations: connectionExpectations{
					peerCertificate: rsaChainCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
				},
			})

			// Test that the credentials API works asynchronously. This tests both deferring the
			// configuration to the certificate callback, and using a custom, async private key.
			testCases = append(testCases, testCase{
				name:     fmt.Sprintf("CertificateSelection-Client-Async-%s", suffix),
				testType: clientTest,
				protocol: protocol,
				config: Config{
					MinVersion: vers.version,
					MaxVersion: vers.version,
					ClientAuth: RequestClientCert,
				},
				shimCredentials: []*Credential{&ecdsaP256Certificate},
				shimCertificate: &rsaCertificate,
				flags:           []string{"-async", "-expect-selected-credential", "0"},
				expectations:    connectionExpectations{peerCertificate: &ecdsaP256Certificate},
			})
			testCases = append(testCases, testCase{
				name:     fmt.Sprintf("CertificateSelection-Server-Async-%s", suffix),
				testType: serverTest,
				protocol: protocol,
				config: Config{
					MinVersion: vers.version,
					MaxVersion: vers.version,
				},
				shimCredentials: []*Credential{&ecdsaP256Certificate},
				shimCertificate: &rsaCertificate,
				flags:           []string{"-async", "-expect-selected-credential", "0"},
				expectations:    connectionExpectations{peerCertificate: &ecdsaP256Certificate},
			})

			for _, test := range certSelectTests {
				if test.minVersion != 0 && vers.version < test.minVersion {
					continue
				}
				if test.maxVersion != 0 && vers.version > test.maxVersion {
					continue
				}

				config := test.config
				config.MinVersion = vers.version
				config.MaxVersion = vers.version

				// If the mismatch field is omitted, this is a positive test,
				// just to confirm that the selection logic does not block a
				// particular certificate.
				if test.mismatch == nil {
					testCases = append(testCases, testCase{
						name:            fmt.Sprintf("CertificateSelection-%s-%s", test.name, suffix),
						protocol:        protocol,
						testType:        test.testType,
						config:          config,
						shimCredentials: []*Credential{test.match},
						flags:           append([]string{"-expect-selected-credential", "0"}, test.flags...),
						expectations:    connectionExpectations{peerCertificate: test.match},
					})
					continue
				}

				testCases = append(testCases, testCase{
					name:            fmt.Sprintf("CertificateSelection-%s-MatchFirst-%s", test.name, suffix),
					protocol:        protocol,
					testType:        test.testType,
					config:          config,
					shimCredentials: []*Credential{test.match, test.mismatch},
					flags:           append([]string{"-expect-selected-credential", "0"}, test.flags...),
					expectations:    connectionExpectations{peerCertificate: test.match},
				})
				testCases = append(testCases, testCase{
					name:            fmt.Sprintf("CertificateSelection-%s-MatchSecond-%s", test.name, suffix),
					protocol:        protocol,
					testType:        test.testType,
					config:          config,
					shimCredentials: []*Credential{test.mismatch, test.match},
					flags:           append([]string{"-expect-selected-credential", "1"}, test.flags...),
					expectations:    connectionExpectations{peerCertificate: test.match},
				})
				if canBeShimCertificate(test.match) {
					testCases = append(testCases, testCase{
						name:            fmt.Sprintf("CertificateSelection-%s-MatchDefault-%s", test.name, suffix),
						protocol:        protocol,
						testType:        test.testType,
						config:          config,
						shimCredentials: []*Credential{test.mismatch},
						shimCertificate: test.match,
						flags:           append([]string{"-expect-selected-credential", "-1"}, test.flags...),
						expectations:    connectionExpectations{peerCertificate: test.match},
					})
				}
				testCases = append(testCases, testCase{
					name:               fmt.Sprintf("CertificateSelection-%s-MatchNone-%s", test.name, suffix),
					protocol:           protocol,
					testType:           test.testType,
					config:             config,
					shimCredentials:    []*Credential{test.mismatch, test.mismatch, test.mismatch},
					flags:              test.flags,
					shouldFail:         true,
					expectedLocalError: "remote error: handshake failure",
					expectedError:      test.expectedError,
				})
			}
		}
	}
}
