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

import "strconv"

func addHintMismatchTests() {
	// Each of these tests skips split handshakes because split handshakes does
	// not handle a mismatch between shim and handshaker. Handshake hints,
	// however, are designed to tolerate the mismatch.
	//
	// Note also these tests do not specify -handshake-hints directly. Instead,
	// we define normal tests, that run even without a handshaker, and rely on
	// convertToSplitHandshakeTests to generate a handshaker hints variant. This
	// avoids repeating the -is-handshaker-supported and -handshaker-path logic.
	// (While not useful, the tests will still pass without a handshaker.)
	for _, protocol := range []protocol{tls, quic} {
		// If the signing payload is different, the handshake still completes
		// successfully. Different ALPN preferences will trigger a mismatch.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-SignatureInput",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				NextProtos: []string{"foo", "bar"},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-select-alpn", "foo",
				"-on-handshaker-select-alpn", "bar",
			},
			expectations: connectionExpectations{
				nextProto:     "foo",
				nextProtoType: alpn,
			},
		})

		// The shim and handshaker may have different curve preferences.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-KeyShare",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				// Send both curves in the key share list, to avoid getting
				// mixed up with HelloRetryRequest.
				DefaultCurves: []CurveID{CurveX25519, CurveP256},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-curves", strconv.Itoa(int(CurveX25519)),
				"-on-handshaker-curves", strconv.Itoa(int(CurveP256)),
			},
			expectations: connectionExpectations{
				curveID: CurveX25519,
			},
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-ECDHE-Group",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion:    VersionTLS12,
					MaxVersion:    VersionTLS12,
					DefaultCurves: []CurveID{CurveX25519, CurveP256},
				},
				flags: []string{
					"-allow-hint-mismatch",
					"-on-shim-curves", strconv.Itoa(int(CurveX25519)),
					"-on-handshaker-curves", strconv.Itoa(int(CurveP256)),
				},
				expectations: connectionExpectations{
					curveID: CurveX25519,
				},
			})
		}

		// If the handshaker does HelloRetryRequest, it will omit most hints.
		// The shim should still work.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-HandshakerHelloRetryRequest",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion:    VersionTLS13,
				MaxVersion:    VersionTLS13,
				DefaultCurves: []CurveID{CurveX25519},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-curves", strconv.Itoa(int(CurveX25519)),
				"-on-handshaker-curves", strconv.Itoa(int(CurveP256)),
			},
			expectations: connectionExpectations{
				curveID: CurveX25519,
			},
		})

		// If the shim does HelloRetryRequest, the hints from the handshaker
		// will be ignored. This is not reported as a mismatch because hints
		// would not have helped the shim anyway.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-ShimHelloRetryRequest",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion:    VersionTLS13,
				MaxVersion:    VersionTLS13,
				DefaultCurves: []CurveID{CurveX25519},
			},
			flags: []string{
				"-on-shim-curves", strconv.Itoa(int(CurveP256)),
				"-on-handshaker-curves", strconv.Itoa(int(CurveX25519)),
			},
			expectations: connectionExpectations{
				curveID: CurveP256,
			},
		})

		// The shim and handshaker may have different signature algorithm
		// preferences.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-SignatureAlgorithm-TLS13",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				VerifySignatureAlgorithms: []signatureAlgorithm{
					signatureRSAPSSWithSHA256,
					signatureRSAPSSWithSHA384,
				},
			},
			shimCertificate:       rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			handshakerCertificate: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA384),
			flags:                 []string{"-allow-hint-mismatch"},
			expectations: connectionExpectations{
				peerSignatureAlgorithm: signatureRSAPSSWithSHA256,
			},
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-SignatureAlgorithm-TLS12",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
					VerifySignatureAlgorithms: []signatureAlgorithm{
						signatureRSAPSSWithSHA256,
						signatureRSAPSSWithSHA384,
					},
				},
				shimCertificate:       rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
				handshakerCertificate: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA384),
				flags:                 []string{"-allow-hint-mismatch"},
				expectations: connectionExpectations{
					peerSignatureAlgorithm: signatureRSAPSSWithSHA256,
				},
			})
		}

		// The shim and handshaker may use different certificates. In TLS 1.3,
		// the signature input includes the certificate, so we do not need to
		// explicitly check for a public key match. In TLS 1.2, it does not.
		ecdsaP256Certificate2 := rootCA.Issue(X509Info{
			PrivateKey: &channelIDKey,
			DNSNames:   []string{"test"},
		}).ToCredential()
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-Certificate-TLS13",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
			},
			shimCertificate:       &ecdsaP256Certificate,
			handshakerCertificate: &ecdsaP256Certificate2,
			flags:                 []string{"-allow-hint-mismatch"},
			expectations: connectionExpectations{
				peerCertificate: &ecdsaP256Certificate,
			},
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-Certificate-TLS12",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				shimCertificate:       &ecdsaP256Certificate,
				handshakerCertificate: &ecdsaP256Certificate2,
				flags:                 []string{"-allow-hint-mismatch"},
				expectations: connectionExpectations{
					peerCertificate: &ecdsaP256Certificate,
				},
			})
		}

		// The shim and handshaker may disagree on whether resumption is allowed.
		// We run the first connection with tickets enabled, so the client is
		// issued a ticket, then disable tickets on the second connection.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-NoTickets1-TLS13",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
			},
			flags: []string{
				"-on-resume-allow-hint-mismatch",
				"-on-shim-on-resume-no-ticket",
			},
			resumeSession:        true,
			expectResumeRejected: true,
		})
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-NoTickets2-TLS13",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
			},
			flags: []string{
				"-on-resume-allow-hint-mismatch",
				"-on-handshaker-on-resume-no-ticket",
			},
			resumeSession: true,
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-NoTickets1-TLS12",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				flags: []string{
					"-on-resume-allow-hint-mismatch",
					"-on-shim-on-resume-no-ticket",
				},
				resumeSession:        true,
				expectResumeRejected: true,
			})
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-NoTickets2-TLS12",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				flags: []string{
					"-on-resume-allow-hint-mismatch",
					"-on-handshaker-on-resume-no-ticket",
				},
				resumeSession: true,
			})
		}

		// The shim and handshaker may disagree on whether to request a client
		// certificate.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-CertificateRequest",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-require-any-client-certificate",
			},
		})

		// The shim and handshaker may negotiate different versions altogether.
		if protocol != quic {
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-Version1",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS13,
				},
				flags: []string{
					"-allow-hint-mismatch",
					"-on-shim-max-version", strconv.Itoa(VersionTLS12),
					"-on-handshaker-max-version", strconv.Itoa(VersionTLS13),
				},
				expectations: connectionExpectations{
					version: VersionTLS12,
				},
			})
			testCases = append(testCases, testCase{
				name:               protocol.String() + "-HintMismatch-Version2",
				testType:           serverTest,
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS13,
				},
				flags: []string{
					"-allow-hint-mismatch",
					"-on-shim-max-version", strconv.Itoa(VersionTLS13),
					"-on-handshaker-max-version", strconv.Itoa(VersionTLS12),
				},
				expectations: connectionExpectations{
					version: VersionTLS13,
				},
			})
		}

		// The shim and handshaker may disagree on the certificate compression
		// algorithm, whether to enable certificate compression, or certificate
		// compression inputs.
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-CertificateCompression-ShimOnly",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: shrinkingCompressionAlgID,
				},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-install-cert-compression-algs",
			},
		})
		testCases = append(testCases, testCase{
			name:               protocol.String() + "-HintMismatch-CertificateCompression-HandshakerOnly",
			testType:           serverTest,
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectUncompressedCert: true,
				},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-handshaker-install-cert-compression-algs",
			},
		})
		testCases = append(testCases, testCase{
			testType:           serverTest,
			name:               protocol.String() + "-HintMismatch-CertificateCompression-AlgorithmMismatch",
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
					expandingCompressionAlgID: expandingCompression,
				},
				Bugs: ProtocolBugs{
					// The shim's preferences should take effect.
					ExpectedCompressedCert: shrinkingCompressionAlgID,
				},
			},
			flags: []string{
				"-allow-hint-mismatch",
				"-on-shim-install-one-cert-compression-alg", strconv.Itoa(shrinkingCompressionAlgID),
				"-on-handshaker-install-one-cert-compression-alg", strconv.Itoa(expandingCompressionAlgID),
			},
		})
		testCases = append(testCases, testCase{
			testType:           serverTest,
			name:               protocol.String() + "-HintMismatch-CertificateCompression-InputMismatch",
			protocol:           protocol,
			skipSplitHandshake: true,
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: shrinkingCompressionAlgID,
				},
			},
			// Configure the shim and handshaker with different OCSP responses,
			// so the compression inputs do not match.
			shimCertificate:       rsaCertificate.WithOCSP(testOCSPResponse),
			handshakerCertificate: rsaCertificate.WithOCSP(testOCSPResponse2),
			flags: []string{
				"-allow-hint-mismatch",
				"-install-cert-compression-algs",
			},
			expectations: connectionExpectations{
				// The shim's configuration should take precedence.
				peerCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			},
		})

		// The shim and handshaker may disagree on cipher suite, to the point
		// that one selects RSA key exchange (no applicable hint) and the other
		// selects ECDHE_RSA (hints are useful).
		if protocol != quic {
			testCases = append(testCases, testCase{
				testType:           serverTest,
				name:               protocol.String() + "-HintMismatch-CipherMismatch1",
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				flags: []string{
					"-allow-hint-mismatch",
					"-on-shim-cipher", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
					"-on-handshaker-cipher", "TLS_RSA_WITH_AES_128_GCM_SHA256",
				},
				expectations: connectionExpectations{
					cipher: TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				},
			})
			testCases = append(testCases, testCase{
				testType:           serverTest,
				name:               protocol.String() + "-HintMismatch-CipherMismatch2",
				protocol:           protocol,
				skipSplitHandshake: true,
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				flags: []string{
					// There is no need to pass -allow-hint-mismatch. The
					// handshaker will unnecessarily generate a signature hints.
					// This is not reported as a mismatch because hints would
					// not have helped the shim anyway.
					"-on-shim-cipher", "TLS_RSA_WITH_AES_128_GCM_SHA256",
					"-on-handshaker-cipher", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
				},
				expectations: connectionExpectations{
					cipher: TLS_RSA_WITH_AES_128_GCM_SHA256,
				},
			})
		}
	}
}
