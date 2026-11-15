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

var testSignatureAlgorithms = []struct {
	name     string
	id       signatureAlgorithm
	baseCert *Credential
	// If non-zero, the curve that must be supported in TLS 1.2 for cert to be
	// accepted.
	curve CurveID
}{
	{"RSA_PKCS1_SHA1", signatureRSAPKCS1WithSHA1, &rsaCertificate, 0},
	{"RSA_PKCS1_SHA256", signatureRSAPKCS1WithSHA256, &rsaCertificate, 0},
	{"RSA_PKCS1_SHA256_LEGACY", signatureRSAPKCS1WithSHA256Legacy, &rsaCertificate, 0},
	{"RSA_PKCS1_SHA384", signatureRSAPKCS1WithSHA384, &rsaCertificate, 0},
	{"RSA_PKCS1_SHA512", signatureRSAPKCS1WithSHA512, &rsaCertificate, 0},
	{"ECDSA_SHA1", signatureECDSAWithSHA1, &ecdsaP256Certificate, CurveP256},
	{"ECDSA_P256_SHA256", signatureECDSAWithP256AndSHA256, &ecdsaP256Certificate, CurveP256},
	{"ECDSA_P384_SHA384", signatureECDSAWithP384AndSHA384, &ecdsaP384Certificate, CurveP384},
	{"ECDSA_P521_SHA512", signatureECDSAWithP521AndSHA512, &ecdsaP521Certificate, CurveP521},
	{"RSA_PSS_SHA256", signatureRSAPSSWithSHA256, &rsaCertificate, 0},
	{"RSA_PSS_SHA384", signatureRSAPSSWithSHA384, &rsaCertificate, 0},
	{"RSA_PSS_SHA512", signatureRSAPSSWithSHA512, &rsaCertificate, 0},
	{"Ed25519", signatureEd25519, &ed25519Certificate, 0},
	// Tests for key types prior to TLS 1.2.
	{"RSA", 0, &rsaCertificate, 0},
	{"ECDSA", 0, &ecdsaP256Certificate, CurveP256},
}

const (
	fakeSigAlg1 signatureAlgorithm = 0x2a01
	fakeSigAlg2 signatureAlgorithm = 0xff01
)

func addSignatureAlgorithmTests() {
	// Not all ciphers involve a signature. Advertise a list which gives all
	// versions a signing cipher.
	signingCiphers := []uint16{
		TLS_AES_256_GCM_SHA384,
		TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
		TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
	}

	var allAlgorithms []signatureAlgorithm
	for _, alg := range testSignatureAlgorithms {
		if alg.id != 0 {
			allAlgorithms = append(allAlgorithms, alg.id)
		}
	}

	// Make sure each signature algorithm works. Include some fake values in
	// the list and ensure they're ignored.
	for _, alg := range testSignatureAlgorithms {
		// Make a version of the certificate that will not sign any other algorithm.
		cert := alg.baseCert
		if alg.id != 0 {
			cert = cert.WithSignatureAlgorithms(alg.id)
		}

		for _, ver := range tlsVersions {
			if (ver.version < VersionTLS12) != (alg.id == 0) {
				continue
			}

			suffix := "-" + alg.name + "-" + ver.name
			for _, signTestType := range []testType{clientTest, serverTest} {
				signPrefix := "Client-"
				verifyPrefix := "Server-"
				verifyTestType := serverTest
				if signTestType == serverTest {
					verifyTestType = clientTest
					signPrefix, verifyPrefix = verifyPrefix, signPrefix
				}

				var shouldFail bool
				isTLS12PKCS1 := hasComponent(alg.name, "PKCS1") && !hasComponent(alg.name, "LEGACY")
				isTLS13PKCS1 := hasComponent(alg.name, "PKCS1") && hasComponent(alg.name, "LEGACY")

				// TLS 1.3 removes a number of signature algorithms.
				if ver.version >= VersionTLS13 && (alg.id == signatureECDSAWithSHA1 || isTLS12PKCS1) {
					shouldFail = true
				}

				// The backported RSA-PKCS1 code points only exist for TLS 1.3
				// client certificates.
				if (ver.version < VersionTLS13 || signTestType == serverTest) && isTLS13PKCS1 {
					shouldFail = true
				}

				// By default, BoringSSL does not sign with these algorithms.
				signDefault := !shouldFail
				if isTLS13PKCS1 {
					signDefault = false
				}

				// By default, BoringSSL does not accept these algorithms.
				verifyDefault := !shouldFail
				if alg.id == signatureECDSAWithSHA1 || alg.id == signatureECDSAWithP521AndSHA512 || alg.id == signatureEd25519 || isTLS13PKCS1 {
					verifyDefault = false
				}

				var curveFlags []string
				var runnerCurves []CurveID
				if alg.curve != 0 && ver.version <= VersionTLS12 {
					// In TLS 1.2, the ECDH curve list also constrains ECDSA keys. Ensure the
					// corresponding curve is enabled. Also include X25519 to ensure the shim
					// and runner have something in common for ECDH.
					curveFlags = flagInts("-curves", []int{int(CurveX25519), int(alg.curve)})
					runnerCurves = []CurveID{CurveX25519, alg.curve}
				}

				signError := func(shouldFail bool) string {
					if !shouldFail {
						return ""
					}
					// In TLS 1.3, the shim should report no common signature algorithms if
					// it cannot generate a signature. In TLS 1.2 servers, signature
					// algorithm and cipher selection are integrated, so it is reported as
					// no shared cipher.
					if ver.version <= VersionTLS12 && signTestType == serverTest {
						return ":NO_SHARED_CIPHER:"
					}
					return ":NO_COMMON_SIGNATURE_ALGORITHMS:"
				}
				signLocalError := func(shouldFail bool) string {
					if !shouldFail {
						return ""
					}
					// The shim should send handshake_failure when it cannot
					// negotiate parameters.
					return "remote error: handshake failure"
				}
				verifyError := func(shouldFail bool) string {
					if !shouldFail {
						return ""
					}
					// If the shim rejects the signature algorithm, but the
					// runner forcibly selects it anyway, the shim should notice.
					return ":WRONG_SIGNATURE_TYPE:"
				}
				verifyLocalError := func(shouldFail bool) string {
					if !shouldFail {
						return ""
					}
					// The shim should send an illegal_parameter alert if the runner
					// uses a signature algorithm it isn't allowed to use.
					return "remote error: illegal parameter"
				}

				// Test the shim using the algorithm for signing.
				signTest := testCase{
					testType: signTestType,
					name:     signPrefix + "Sign" + suffix,
					config: Config{
						MaxVersion:       ver.version,
						CurvePreferences: runnerCurves,
						VerifySignatureAlgorithms: []signatureAlgorithm{
							fakeSigAlg1,
							alg.id,
							fakeSigAlg2,
						},
					},
					shimCertificate:    cert,
					flags:              curveFlags,
					shouldFail:         shouldFail,
					expectedError:      signError(shouldFail),
					expectedLocalError: signLocalError(shouldFail),
					expectations: connectionExpectations{
						peerSignatureAlgorithm: alg.id,
					},
				}

				// Test whether the shim enables the algorithm by default.
				signDefaultTest := testCase{
					testType: signTestType,
					name:     signPrefix + "SignDefault" + suffix,
					config: Config{
						MaxVersion:       ver.version,
						CurvePreferences: runnerCurves,
						VerifySignatureAlgorithms: []signatureAlgorithm{
							fakeSigAlg1,
							alg.id,
							fakeSigAlg2,
						},
					},
					// cert has been configured with the specified algorithm,
					// while alg.baseCert uses the defaults.
					shimCertificate:    alg.baseCert,
					flags:              curveFlags,
					shouldFail:         !signDefault,
					expectedError:      signError(!signDefault),
					expectedLocalError: signLocalError(!signDefault),
					expectations: connectionExpectations{
						peerSignatureAlgorithm: alg.id,
					},
				}

				// Test that the shim will select the algorithm when configured to only
				// support it.
				negotiateTest := testCase{
					testType: signTestType,
					name:     signPrefix + "Sign-Negotiate" + suffix,
					config: Config{
						MaxVersion:                ver.version,
						CurvePreferences:          runnerCurves,
						VerifySignatureAlgorithms: allAlgorithms,
					},
					shimCertificate: cert,
					flags:           curveFlags,
					expectations: connectionExpectations{
						peerSignatureAlgorithm: alg.id,
					},
				}

				if signTestType == serverTest {
					// TLS 1.2 servers only sign on some cipher suites.
					signTest.config.CipherSuites = signingCiphers
					signDefaultTest.config.CipherSuites = signingCiphers
					negotiateTest.config.CipherSuites = signingCiphers
				} else {
					// TLS 1.2 clients only sign when the server requests certificates.
					signTest.config.ClientAuth = RequireAnyClientCert
					signDefaultTest.config.ClientAuth = RequireAnyClientCert
					negotiateTest.config.ClientAuth = RequireAnyClientCert
				}
				testCases = append(testCases, signTest, signDefaultTest)
				if ver.version >= VersionTLS12 && !shouldFail {
					testCases = append(testCases, negotiateTest)
				}

				// Test the shim using the algorithm for verifying.
				verifyTest := testCase{
					testType: verifyTestType,
					name:     verifyPrefix + "Verify" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Credential: cert,
						Bugs: ProtocolBugs{
							SkipECDSACurveCheck:          shouldFail,
							IgnoreSignatureVersionChecks: shouldFail,
							// Some signature algorithms may not be advertised.
							IgnorePeerSignatureAlgorithmPreferences: shouldFail,
						},
					},
					flags: curveFlags,
					// Resume the session to assert the peer signature
					// algorithm is reported on both handshakes.
					resumeSession:      !shouldFail,
					shouldFail:         shouldFail,
					expectedError:      verifyError(shouldFail),
					expectedLocalError: verifyLocalError(shouldFail),
				}
				if alg.id != 0 {
					verifyTest.flags = append(verifyTest.flags, "-expect-peer-signature-algorithm", strconv.Itoa(int(alg.id)))
					// The algorithm may be disabled by default, so explicitly enable it.
					verifyTest.flags = append(verifyTest.flags, "-verify-prefs", strconv.Itoa(int(alg.id)))
				}

				// Test whether the shim expects the algorithm enabled by default.
				defaultTest := testCase{
					testType: verifyTestType,
					name:     verifyPrefix + "VerifyDefault" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Credential: cert,
						Bugs: ProtocolBugs{
							SkipECDSACurveCheck:          !verifyDefault,
							IgnoreSignatureVersionChecks: !verifyDefault,
							// Some signature algorithms may not be advertised.
							IgnorePeerSignatureAlgorithmPreferences: !verifyDefault,
						},
					},
					flags: append(
						[]string{"-expect-peer-signature-algorithm", strconv.Itoa(int(alg.id))},
						curveFlags...,
					),
					// Resume the session to assert the peer signature
					// algorithm is reported on both handshakes.
					resumeSession:      verifyDefault,
					shouldFail:         !verifyDefault,
					expectedError:      verifyError(!verifyDefault),
					expectedLocalError: verifyLocalError(!verifyDefault),
				}

				// Test whether the shim handles invalid signatures for this algorithm.
				invalidTest := testCase{
					testType: verifyTestType,
					name:     verifyPrefix + "InvalidSignature" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Credential: cert,
						Bugs: ProtocolBugs{
							InvalidSignature: true,
						},
					},
					flags:         curveFlags,
					shouldFail:    true,
					expectedError: ":BAD_SIGNATURE:",
				}
				if alg.id != 0 {
					// The algorithm may be disabled by default, so explicitly enable it.
					invalidTest.flags = append(invalidTest.flags, "-verify-prefs", strconv.Itoa(int(alg.id)))
				}

				if verifyTestType == serverTest {
					// TLS 1.2 servers only verify when they request client certificates.
					verifyTest.flags = append(verifyTest.flags, "-require-any-client-certificate")
					defaultTest.flags = append(defaultTest.flags, "-require-any-client-certificate")
					invalidTest.flags = append(invalidTest.flags, "-require-any-client-certificate")
				} else {
					// TLS 1.2 clients only verify on some cipher suites.
					verifyTest.config.CipherSuites = signingCiphers
					defaultTest.config.CipherSuites = signingCiphers
					invalidTest.config.CipherSuites = signingCiphers
				}
				testCases = append(testCases, verifyTest, defaultTest)
				if !shouldFail {
					testCases = append(testCases, invalidTest)
				}
			}
		}
	}

	// Test the peer's verify preferences are available.
	for _, ver := range tlsVersions {
		if ver.version < VersionTLS12 {
			continue
		}
		testCases = append(testCases, testCase{
			name: "ClientAuth-PeerVerifyPrefs-" + ver.name,
			config: Config{
				MaxVersion: ver.version,
				ClientAuth: RequireAnyClientCert,
				VerifySignatureAlgorithms: []signatureAlgorithm{
					signatureRSAPSSWithSHA256,
					signatureEd25519,
					signatureECDSAWithP256AndSHA256,
				},
			},
			shimCertificate: &rsaCertificate,
			flags: []string{
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureRSAPSSWithSHA256)),
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureEd25519)),
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureECDSAWithP256AndSHA256)),
			},
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "ServerAuth-PeerVerifyPrefs-" + ver.name,
			config: Config{
				MaxVersion: ver.version,
				VerifySignatureAlgorithms: []signatureAlgorithm{
					signatureRSAPSSWithSHA256,
					signatureEd25519,
					signatureECDSAWithP256AndSHA256,
				},
			},
			shimCertificate: &rsaCertificate,
			flags: []string{
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureRSAPSSWithSHA256)),
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureEd25519)),
				"-expect-peer-verify-pref", strconv.Itoa(int(signatureECDSAWithP256AndSHA256)),
			},
		})

	}

	// Test that algorithm selection takes the key type into account.
	testCases = append(testCases, testCase{
		name: "ClientAuth-SignatureType",
		config: Config{
			ClientAuth: RequireAnyClientCert,
			MaxVersion: VersionTLS12,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP521AndSHA512,
				signatureRSAPKCS1WithSHA384,
				signatureECDSAWithSHA1,
			},
		},
		shimCertificate: &rsaCertificate,
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA384,
		},
	})

	testCases = append(testCases, testCase{
		name: "ClientAuth-SignatureType-TLS13",
		config: Config{
			ClientAuth: RequireAnyClientCert,
			MaxVersion: VersionTLS13,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP521AndSHA512,
				signatureRSAPKCS1WithSHA384,
				signatureRSAPSSWithSHA384,
				signatureECDSAWithSHA1,
			},
		},
		shimCertificate: &rsaCertificate,
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPSSWithSHA384,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerAuth-SignatureType",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP521AndSHA512,
				signatureRSAPKCS1WithSHA384,
				signatureECDSAWithSHA1,
			},
		},
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA384,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerAuth-SignatureType-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP521AndSHA512,
				signatureRSAPKCS1WithSHA384,
				signatureRSAPSSWithSHA384,
				signatureECDSAWithSHA1,
			},
		},
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPSSWithSHA384,
		},
	})

	// Test that signature verification takes the key type into account.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Verify-ClientAuth-SignatureType",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithSHA256),
			Bugs: ProtocolBugs{
				SendSignatureAlgorithm: signatureECDSAWithP256AndSHA256,
			},
		},
		flags: []string{
			"-require-any-client-certificate",
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Verify-ClientAuth-SignatureType-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			Bugs: ProtocolBugs{
				SendSignatureAlgorithm: signatureECDSAWithP256AndSHA256,
			},
		},
		flags: []string{
			"-require-any-client-certificate",
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	testCases = append(testCases, testCase{
		name: "Verify-ServerAuth-SignatureType",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Credential:   rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithSHA256),
			Bugs: ProtocolBugs{
				SendSignatureAlgorithm: signatureECDSAWithP256AndSHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	testCases = append(testCases, testCase{
		name: "Verify-ServerAuth-SignatureType-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
			Bugs: ProtocolBugs{
				SendSignatureAlgorithm: signatureECDSAWithP256AndSHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	// Test that, if the ClientHello list is missing, the server falls back
	// to SHA-1 in TLS 1.2, but not TLS 1.3.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerAuth-SHA1-Fallback-RSA",
		config: Config{
			MaxVersion: VersionTLS12,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shimCertificate: &rsaCertificate,
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerAuth-SHA1-Fallback-ECDSA",
		config: Config{
			MaxVersion: VersionTLS12,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shimCertificate: &ecdsaP256Certificate,
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerAuth-NoFallback-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shouldFail:    true,
		expectedError: ":NO_COMMON_SIGNATURE_ALGORITHMS:",
	})

	// The CertificateRequest list, however, may never be omitted. It is a
	// syntax error for it to be empty.
	testCases = append(testCases, testCase{
		name: "ClientAuth-NoFallback-RSA",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shimCertificate:    &rsaCertificate,
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: error decoding message",
	})

	testCases = append(testCases, testCase{
		name: "ClientAuth-NoFallback-ECDSA",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shimCertificate:    &ecdsaP256Certificate,
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: error decoding message",
	})

	testCases = append(testCases, testCase{
		name: "ClientAuth-NoFallback-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
			},
			Bugs: ProtocolBugs{
				NoSignatureAlgorithms: true,
			},
		},
		shimCertificate:    &rsaCertificate,
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: error decoding message",
	})

	// Test that signature preferences are enforced. BoringSSL does not
	// implement MD5 signatures.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ClientAuth-Enforced",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithMD5),
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
			},
		},
		flags:         []string{"-require-any-client-certificate"},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	testCases = append(testCases, testCase{
		name: "ServerAuth-Enforced",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Credential:   rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithMD5),
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ClientAuth-Enforced-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithMD5),
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
				IgnoreSignatureVersionChecks:            true,
			},
		},
		flags:         []string{"-require-any-client-certificate"},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	testCases = append(testCases, testCase{
		name: "ServerAuth-Enforced-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithMD5),
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
				IgnoreSignatureVersionChecks:            true,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	// Test that the negotiated signature algorithm respects the client and
	// server preferences.
	testCases = append(testCases, testCase{
		name: "NoCommonAlgorithms",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA512,
				signatureRSAPKCS1WithSHA1,
			},
		},
		shimCertificate: rsaCertificate.WithSignatureAlgorithms(signatureRSAPKCS1WithSHA256),
		shouldFail:      true,
		expectedError:   ":NO_COMMON_SIGNATURE_ALGORITHMS:",
	})
	testCases = append(testCases, testCase{
		name: "NoCommonAlgorithms-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPSSWithSHA512,
				signatureRSAPSSWithSHA384,
			},
		},
		shimCertificate: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
		shouldFail:      true,
		expectedError:   ":NO_COMMON_SIGNATURE_ALGORITHMS:",
	})
	testCases = append(testCases, testCase{
		name: "Agree-Digest-SHA256",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
				signatureRSAPKCS1WithSHA256,
			},
		},
		shimCertificate: rsaCertificate.WithSignatureAlgorithms(
			signatureRSAPKCS1WithSHA256,
			signatureRSAPKCS1WithSHA1,
		),
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA256,
		},
	})
	testCases = append(testCases, testCase{
		name: "Agree-Digest-SHA1",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA1,
			},
		},
		shimCertificate: rsaCertificate.WithSignatureAlgorithms(
			signatureRSAPKCS1WithSHA512,
			signatureRSAPKCS1WithSHA256,
			signatureRSAPKCS1WithSHA1,
		),
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA1,
		},
	})
	testCases = append(testCases, testCase{
		name: "Agree-Digest-Default",
		config: Config{
			MaxVersion: VersionTLS12,
			ClientAuth: RequireAnyClientCert,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA256,
				signatureECDSAWithP256AndSHA256,
				signatureRSAPKCS1WithSHA1,
				signatureECDSAWithSHA1,
			},
		},
		shimCertificate: &rsaCertificate,
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA256,
		},
	})

	// Test that the signing preference list may include extra algorithms
	// without negotiation problems.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "FilterExtraAlgorithms",
		config: Config{
			MaxVersion: VersionTLS12,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPKCS1WithSHA256,
			},
		},
		shimCertificate: rsaCertificate.WithSignatureAlgorithms(
			signatureECDSAWithP256AndSHA256,
			signatureRSAPKCS1WithSHA256,
		),
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureRSAPKCS1WithSHA256,
		},
	})

	// In TLS 1.2 and below, ECDSA uses the curve list rather than the
	// signature algorithms.
	testCases = append(testCases, testCase{
		name: "CheckLeafCurve",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			Credential:   &ecdsaP256Certificate,
		},
		flags:         []string{"-curves", strconv.Itoa(int(CurveP384))},
		shouldFail:    true,
		expectedError: ":BAD_ECC_CERT:",
	})

	// In TLS 1.3, ECDSA does not use the ECDHE curve list.
	testCases = append(testCases, testCase{
		name: "CheckLeafCurve-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &ecdsaP256Certificate,
		},
		flags: []string{"-curves", strconv.Itoa(int(CurveP384))},
	})

	// In TLS 1.2, the ECDSA curve is not in the signature algorithm, so the
	// shim should accept P-256 with SHA-384.
	testCases = append(testCases, testCase{
		name: "ECDSACurveMismatch-Verify-TLS12",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			Credential:   ecdsaP256Certificate.WithSignatureAlgorithms(signatureECDSAWithP384AndSHA384),
		},
	})

	// In TLS 1.3, the ECDSA curve comes from the signature algorithm, so the
	// shim should reject P-256 with SHA-384.
	testCases = append(testCases, testCase{
		name: "ECDSACurveMismatch-Verify-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: ecdsaP256Certificate.WithSignatureAlgorithms(signatureECDSAWithP384AndSHA384),
			Bugs: ProtocolBugs{
				SkipECDSACurveCheck: true,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_SIGNATURE_TYPE:",
	})

	// Signature algorithm selection in TLS 1.3 should take the curve into
	// account.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ECDSACurveMismatch-Sign-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP384AndSHA384,
				signatureECDSAWithP256AndSHA256,
			},
		},
		shimCertificate: &ecdsaP256Certificate,
		expectations: connectionExpectations{
			peerSignatureAlgorithm: signatureECDSAWithP256AndSHA256,
		},
	})

	// RSASSA-PSS with SHA-512 is too large for 1024-bit RSA. Test that the
	// server does not attempt to sign in that case.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "RSA-PSS-Large",
		config: Config{
			MaxVersion: VersionTLS13,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPSSWithSHA512,
			},
		},
		shimCertificate: &rsa1024Certificate,
		shouldFail:      true,
		expectedError:   ":NO_COMMON_SIGNATURE_ALGORITHMS:",
	})

	// Test that RSA-PSS is enabled by default for TLS 1.2.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "RSA-PSS-Default-Verify",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: rsaCertificate.WithSignatureAlgorithms(signatureRSAPSSWithSHA256),
		},
		flags: []string{"-max-version", strconv.Itoa(VersionTLS12)},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "RSA-PSS-Default-Sign",
		config: Config{
			MaxVersion: VersionTLS12,
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureRSAPSSWithSHA256,
			},
		},
		flags: []string{"-max-version", strconv.Itoa(VersionTLS12)},
	})

	// TLS 1.1 and below has no way to advertise support for or negotiate
	// Ed25519's signature algorithm.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "NoEd25519-TLS11-ServerAuth-Verify",
		config: Config{
			MaxVersion: VersionTLS11,
			Credential: &ed25519Certificate,
			Bugs: ProtocolBugs{
				// Sign with Ed25519 even though it is TLS 1.1.
				SigningAlgorithmForLegacyVersions: signatureEd25519,
			},
		},
		flags:         []string{"-verify-prefs", strconv.Itoa(int(signatureEd25519))},
		shouldFail:    true,
		expectedError: ":PEER_ERROR_UNSUPPORTED_CERTIFICATE_TYPE:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoEd25519-TLS11-ServerAuth-Sign",
		config: Config{
			MaxVersion: VersionTLS11,
		},
		shimCertificate: &ed25519Certificate,
		shouldFail:      true,
		expectedError:   ":NO_SHARED_CIPHER:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoEd25519-TLS11-ClientAuth-Verify",
		config: Config{
			MaxVersion: VersionTLS11,
			Credential: &ed25519Certificate,
			Bugs: ProtocolBugs{
				// Sign with Ed25519 even though it is TLS 1.1.
				SigningAlgorithmForLegacyVersions: signatureEd25519,
			},
		},
		flags: []string{
			"-verify-prefs", strconv.Itoa(int(signatureEd25519)),
			"-require-any-client-certificate",
		},
		shouldFail:    true,
		expectedError: ":PEER_ERROR_UNSUPPORTED_CERTIFICATE_TYPE:",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "NoEd25519-TLS11-ClientAuth-Sign",
		config: Config{
			MaxVersion: VersionTLS11,
			ClientAuth: RequireAnyClientCert,
		},
		shimCertificate: &ed25519Certificate,
		shouldFail:      true,
		expectedError:   ":NO_COMMON_SIGNATURE_ALGORITHMS:",
	})

	// Test Ed25519 is not advertised by default.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "Ed25519DefaultDisable-NoAdvertise",
		config: Config{
			Credential: &ed25519Certificate,
		},
		shouldFail:         true,
		expectedLocalError: "tls: no common signature algorithms",
	})

	// Test Ed25519, when disabled, is not accepted if the peer ignores our
	// preferences.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "Ed25519DefaultDisable-NoAccept",
		config: Config{
			Credential: &ed25519Certificate,
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "remote error: illegal parameter",
		expectedError:      ":WRONG_SIGNATURE_TYPE:",
	})

	// Test that configuring verify preferences changes what the client
	// advertises.
	testCases = append(testCases, testCase{
		name: "VerifyPreferences-Advertised",
		config: Config{
			Credential: rsaCertificate.WithSignatureAlgorithms(
				signatureRSAPSSWithSHA256,
				signatureRSAPSSWithSHA384,
				signatureRSAPSSWithSHA512,
			),
		},
		flags: []string{
			"-verify-prefs", strconv.Itoa(int(signatureRSAPSSWithSHA384)),
			"-expect-peer-signature-algorithm", strconv.Itoa(int(signatureRSAPSSWithSHA384)),
		},
	})

	// Test that the client advertises a set which the runner can find
	// nothing in common with.
	testCases = append(testCases, testCase{
		name: "VerifyPreferences-NoCommonAlgorithms",
		config: Config{
			Credential: rsaCertificate.WithSignatureAlgorithms(
				signatureRSAPSSWithSHA256,
				signatureRSAPSSWithSHA512,
			),
		},
		flags: []string{
			"-verify-prefs", strconv.Itoa(int(signatureRSAPSSWithSHA384)),
		},
		shouldFail:         true,
		expectedLocalError: "tls: no common signature algorithms",
	})

	// Test that the client enforces its preferences when configured.
	testCases = append(testCases, testCase{
		name: "VerifyPreferences-Enforced",
		config: Config{
			Credential: rsaCertificate.WithSignatureAlgorithms(
				signatureRSAPSSWithSHA256,
				signatureRSAPSSWithSHA512,
			),
			Bugs: ProtocolBugs{
				IgnorePeerSignatureAlgorithmPreferences: true,
			},
		},
		flags: []string{
			"-verify-prefs", strconv.Itoa(int(signatureRSAPSSWithSHA384)),
		},
		shouldFail:         true,
		expectedLocalError: "remote error: illegal parameter",
		expectedError:      ":WRONG_SIGNATURE_TYPE:",
	})

	// Test that explicitly configuring Ed25519 is as good as changing the
	// boolean toggle.
	testCases = append(testCases, testCase{
		name: "VerifyPreferences-Ed25519",
		config: Config{
			Credential: &ed25519Certificate,
		},
		flags: []string{
			"-verify-prefs", strconv.Itoa(int(signatureEd25519)),
		},
	})

	for _, testType := range []testType{clientTest, serverTest} {
		for _, ver := range tlsVersions {
			if ver.version < VersionTLS12 {
				continue
			}

			prefix := "Client-" + ver.name + "-"
			noCommonAlgorithmsError := ":NO_COMMON_SIGNATURE_ALGORITHMS:"
			if testType == serverTest {
				prefix = "Server-" + ver.name + "-"
				// In TLS 1.2 servers, cipher selection and algorithm
				// selection are linked.
				if ver.version <= VersionTLS12 {
					noCommonAlgorithmsError = ":NO_SHARED_CIPHER:"
				}
			}

			// Test that the shim will not sign MD5/SHA1 with RSA at TLS 1.2,
			// even if specified in signing preferences.
			testCases = append(testCases, testCase{
				testType: testType,
				name:     prefix + "NoSign-RSA_PKCS1_MD5_SHA1",
				config: Config{
					MaxVersion:                ver.version,
					CipherSuites:              signingCiphers,
					ClientAuth:                RequireAnyClientCert,
					VerifySignatureAlgorithms: []signatureAlgorithm{signatureRSAPKCS1WithMD5AndSHA1},
				},
				shimCertificate: rsaCertificate.WithSignatureAlgorithms(
					signatureRSAPKCS1WithMD5AndSHA1,
					// Include a valid algorithm as well, to avoid an empty list
					// if filtered out.
					signatureRSAPKCS1WithSHA256,
				),
				shouldFail:    true,
				expectedError: noCommonAlgorithmsError,
			})

			// Test that the shim will not accept MD5/SHA1 with RSA at TLS 1.2,
			// even if specified in verify preferences.
			testCases = append(testCases, testCase{
				testType: testType,
				name:     prefix + "NoVerify-RSA_PKCS1_MD5_SHA1",
				config: Config{
					MaxVersion: ver.version,
					Credential: &rsaCertificate,
					Bugs: ProtocolBugs{
						IgnorePeerSignatureAlgorithmPreferences: true,
						AlwaysSignAsLegacyVersion:               true,
						SendSignatureAlgorithm:                  signatureRSAPKCS1WithMD5AndSHA1,
					},
				},
				shimCertificate: &rsaCertificate,
				flags: []string{
					"-verify-prefs", strconv.Itoa(int(signatureRSAPKCS1WithMD5AndSHA1)),
					// Include a valid algorithm as well, to avoid an empty list
					// if filtered out.
					"-verify-prefs", strconv.Itoa(int(signatureRSAPKCS1WithSHA256)),
					"-require-any-client-certificate",
				},
				shouldFail:    true,
				expectedError: ":WRONG_SIGNATURE_TYPE:",
			})
		}
	}

	// Test that, when there are no signature algorithms in common in TLS
	// 1.2, the server will still consider the legacy RSA key exchange.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoCommonSignatureAlgorithms-TLS12-Fallback",
		config: Config{
			MaxVersion: VersionTLS12,
			CipherSuites: []uint16{
				TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				TLS_RSA_WITH_AES_128_GCM_SHA256,
			},
			VerifySignatureAlgorithms: []signatureAlgorithm{
				signatureECDSAWithP256AndSHA256,
			},
		},
		expectations: connectionExpectations{
			cipher: TLS_RSA_WITH_AES_128_GCM_SHA256,
		},
	})

	// id-RSASSA-PSS certificates are not accepted for use with rsa_pss_rsae_*
	// algorithms. There are separate codepoints, which we do not support, for
	// id-RSASSA-PSS.
	for _, ver := range tlsVersions {
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "RejectPSSKeyType-Client-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: pssCertificate.WithSignatureAlgorithms(
					signatureRSAPSSWithSHA256,
				),
			},
			shouldFail:    true,
			expectedError: ":UNSUPPORTED_ALGORITHM:",
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RejectPSSKeyType-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: pssCertificate.WithSignatureAlgorithms(
					signatureRSAPSSWithSHA256,
				),
			},
			flags:         []string{"-require-any-client-certificate"},
			shouldFail:    true,
			expectedError: ":UNSUPPORTED_ALGORITHM:",
		})
	}
}

func addBadECDSASignatureTests() {
	for badR := BadValue(1); badR < NumBadValues; badR++ {
		for badS := BadValue(1); badS < NumBadValues; badS++ {
			testCases = append(testCases, testCase{
				name: fmt.Sprintf("BadECDSA-%d-%d", badR, badS),
				config: Config{
					MaxVersion:   VersionTLS12,
					CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
					Credential:   &ecdsaP256Certificate,
					Bugs: ProtocolBugs{
						BadECDSAR: badR,
						BadECDSAS: badS,
					},
				},
				shouldFail:    true,
				expectedError: ":BAD_SIGNATURE:",
			})
			testCases = append(testCases, testCase{
				name: fmt.Sprintf("BadECDSA-%d-%d-TLS13", badR, badS),
				config: Config{
					MaxVersion: VersionTLS13,
					Credential: &ecdsaP256Certificate,
					Bugs: ProtocolBugs{
						BadECDSAR: badR,
						BadECDSAS: badS,
					},
				},
				shouldFail:    true,
				expectedError: ":BAD_SIGNATURE:",
			})
		}
	}
}
