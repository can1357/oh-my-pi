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

var testCurves = []struct {
	name string
	id   CurveID
}{
	{"P-256", CurveP256},
	{"P-384", CurveP384},
	{"P-521", CurveP521},
	{"X25519", CurveX25519},
	{"Kyber", CurveX25519Kyber768},
	{"X25519MLKEM768", CurveX25519MLKEM768},
	{"MLKEM1024", CurveMLKEM1024},
}

const bogusCurve = 0x1234

func isPqGroup(r CurveID) bool {
	return r == CurveX25519Kyber768 || isMLKEMGroup(r)
}

func isMLKEMGroup(r CurveID) bool {
	return r == CurveX25519MLKEM768 || r == CurveMLKEM1024
}

func isECDHGroup(r CurveID) bool {
	return r == CurveP256 || r == CurveP384 || r == CurveP521
}

func isX25519Group(r CurveID) bool {
	return r == CurveX25519 || r == CurveX25519Kyber768 || r == CurveX25519MLKEM768
}

func addCurveTests() {
	// A set of cipher suites that ensures some curve-using mode is used.
	// Without this, servers may fall back to RSA key exchange.
	ecdheCiphers := []uint16{
		TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		TLS_AES_256_GCM_SHA384,
	}

	// Not all curves are enabled by default, so these tests explicitly enable
	// the curve under test in the shim.
	for _, curve := range testCurves {
		for _, ver := range tlsVersions {
			if isPqGroup(curve.id) && ver.version < VersionTLS13 {
				continue
			}
			for _, testType := range []testType{clientTest, serverTest} {
				suffix := fmt.Sprintf("%s-%s-%s", testType, curve.name, ver.name)

				testCases = append(testCases, testCase{
					testType: testType,
					name:     "CurveTest-" + suffix,
					config: Config{
						MaxVersion:       ver.version,
						CipherSuites:     ecdheCiphers,
						CurvePreferences: []CurveID{curve.id},
					},
					flags: append(
						[]string{"-expect-curve-id", strconv.Itoa(int(curve.id))},
						flagCurves("-curves", []CurveID{curve.id})...,
					),
					expectations: connectionExpectations{
						curveID: curve.id,
					},
				})

				badKeyShareLocalError := "remote error: illegal parameter"
				if testType == clientTest && ver.version >= VersionTLS13 {
					// If the shim is a TLS 1.3 client and the runner sends a bad
					// key share, the runner never reads the client's cleartext
					// alert because the runner has already started encrypting by
					// the time the client sees it.
					badKeyShareLocalError = "local error: bad record MAC"
				}

				testCases = append(testCases, testCase{
					testType: testType,
					name:     "CurveTest-Invalid-TruncateKeyShare-" + suffix,
					config: Config{
						MaxVersion:       ver.version,
						CipherSuites:     ecdheCiphers,
						CurvePreferences: []CurveID{curve.id},
						Bugs: ProtocolBugs{
							TruncateKeyShare: true,
						},
					},
					flags:              flagCurves("-curves", []CurveID{curve.id}),
					shouldFail:         true,
					expectedError:      ":BAD_ECPOINT:",
					expectedLocalError: badKeyShareLocalError,
				})

				testCases = append(testCases, testCase{
					testType: testType,
					name:     "CurveTest-Invalid-PadKeyShare-" + suffix,
					config: Config{
						MaxVersion:       ver.version,
						CipherSuites:     ecdheCiphers,
						CurvePreferences: []CurveID{curve.id},
						Bugs: ProtocolBugs{
							PadKeyShare: true,
						},
					},
					flags:              flagCurves("-curves", []CurveID{curve.id}),
					shouldFail:         true,
					expectedError:      ":BAD_ECPOINT:",
					expectedLocalError: badKeyShareLocalError,
				})

				if isECDHGroup(curve.id) {
					testCases = append(testCases, testCase{
						testType: testType,
						name:     "CurveTest-Invalid-Compressed-" + suffix,
						config: Config{
							MaxVersion:       ver.version,
							CipherSuites:     ecdheCiphers,
							CurvePreferences: []CurveID{curve.id},
							Bugs: ProtocolBugs{
								SendCompressedCoordinates: true,
							},
						},
						flags:              flagCurves("-curves", []CurveID{curve.id}),
						shouldFail:         true,
						expectedError:      ":BAD_ECPOINT:",
						expectedLocalError: badKeyShareLocalError,
					})
					testCases = append(testCases, testCase{
						testType: testType,
						name:     "CurveTest-Invalid-NotOnCurve-" + suffix,
						config: Config{
							MaxVersion:       ver.version,
							CipherSuites:     ecdheCiphers,
							CurvePreferences: []CurveID{curve.id},
							Bugs: ProtocolBugs{
								ECDHPointNotOnCurve: true,
							},
						},
						flags:              flagCurves("-curves", []CurveID{curve.id}),
						shouldFail:         true,
						expectedError:      ":BAD_ECPOINT:",
						expectedLocalError: badKeyShareLocalError,
					})
				}

				if isX25519Group(curve.id) {
					// Implementations should mask off the high order bit in X25519.
					testCases = append(testCases, testCase{
						testType: testType,
						name:     "CurveTest-SetX25519HighBit-" + suffix,
						config: Config{
							MaxVersion:       ver.version,
							CipherSuites:     ecdheCiphers,
							CurvePreferences: []CurveID{curve.id},
							Bugs: ProtocolBugs{
								SetX25519HighBit: true,
							},
						},
						flags: flagCurves("-curves", []CurveID{curve.id}),
						expectations: connectionExpectations{
							curveID: curve.id,
						},
					})

					// Implementations should reject low order points.
					testCases = append(testCases, testCase{
						testType: testType,
						name:     "CurveTest-Invalid-LowOrderX25519Point-" + suffix,
						config: Config{
							MaxVersion:       ver.version,
							CipherSuites:     ecdheCiphers,
							CurvePreferences: []CurveID{curve.id},
							Bugs: ProtocolBugs{
								LowOrderX25519Point: true,
							},
						},
						flags:              flagCurves("-curves", []CurveID{curve.id}),
						shouldFail:         true,
						expectedError:      ":BAD_ECPOINT:",
						expectedLocalError: badKeyShareLocalError,
					})
				}

				if isMLKEMGroup(curve.id) && testType == serverTest {
					testCases = append(testCases, testCase{
						testType: testType,
						name:     "CurveTest-Invalid-MLKEMEncapKeyNotReduced-" + suffix,
						config: Config{
							MaxVersion:       ver.version,
							CipherSuites:     ecdheCiphers,
							CurvePreferences: []CurveID{curve.id},
							Bugs: ProtocolBugs{
								MLKEMEncapKeyNotReduced: true,
							},
						},
						flags:              flagCurves("-curves", []CurveID{curve.id}),
						shouldFail:         true,
						expectedError:      ":BAD_ECPOINT:",
						expectedLocalError: badKeyShareLocalError,
					})
				}
			}
		}
	}

	// The server must be tolerant to bogus curves.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "UnknownCurve",
		config: Config{
			MaxVersion:       VersionTLS12,
			CipherSuites:     []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			CurvePreferences: []CurveID{bogusCurve, CurveP256},
		},
	})

	// The server must be tolerant to bogus curves.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "UnknownCurve-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{bogusCurve, CurveP256},
		},
	})

	// The server must not consider ECDHE ciphers when there are no
	// supported curves.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoSupportedCurves",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				NoSupportedCurves: true,
			},
		},
		shouldFail:    true,
		expectedError: ":NO_SHARED_CIPHER:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoSupportedCurves-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NoSupportedCurves: true,
			},
		},
		shouldFail:    true,
		expectedError: ":NO_SHARED_GROUP:",
	})

	// The server must fall back to another cipher when there are no
	// supported curves.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NoCommonCurves",
		config: Config{
			MaxVersion: VersionTLS12,
			CipherSuites: []uint16{
				TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				TLS_RSA_WITH_AES_128_GCM_SHA256,
			},
			CurvePreferences: []CurveID{21 /* P-224 */},
		},
		expectations: connectionExpectations{
			cipher: TLS_RSA_WITH_AES_128_GCM_SHA256,
		},
	})

	// The client must reject bogus curves and disabled curves.
	testCases = append(testCases, testCase{
		name: "BadECDHECurve",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				SendCurve: bogusCurve,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})
	testCases = append(testCases, testCase{
		name: "BadECDHECurve-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendCurve: bogusCurve,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		name: "UnsupportedCurve",
		config: Config{
			MaxVersion:       VersionTLS12,
			CipherSuites:     []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			CurvePreferences: []CurveID{CurveP256},
			Bugs: ProtocolBugs{
				IgnorePeerCurvePreferences: true,
			},
		},
		flags:         []string{"-curves", strconv.Itoa(int(CurveP384))},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		// TODO(davidben): Add a TLS 1.3 version where
		// HelloRetryRequest requests an unsupported curve.
		name: "UnsupportedCurve-ServerHello-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendCurve: CurveP256,
			},
		},
		flags:         []string{"-curves", strconv.Itoa(int(CurveP384))},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	// The previous curve ID should be reported on TLS 1.2 resumption.
	testCases = append(testCases, testCase{
		name: "CurveID-Resume-Client",
		config: Config{
			MaxVersion:       VersionTLS12,
			CipherSuites:     []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			CurvePreferences: []CurveID{CurveX25519},
		},
		flags:         []string{"-expect-curve-id", strconv.Itoa(int(CurveX25519))},
		resumeSession: true,
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "CurveID-Resume-Server",
		config: Config{
			MaxVersion:       VersionTLS12,
			CipherSuites:     []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			CurvePreferences: []CurveID{CurveX25519},
		},
		flags:         []string{"-expect-curve-id", strconv.Itoa(int(CurveX25519))},
		resumeSession: true,
	})

	// TLS 1.3 allows resuming at a different curve. If this happens, the new
	// one should be reported.
	testCases = append(testCases, testCase{
		name: "CurveID-Resume-Client-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519},
		},
		resumeConfig: &Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP256},
		},
		flags: []string{
			"-on-initial-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			"-on-resume-expect-curve-id", strconv.Itoa(int(CurveP256)),
		},
		resumeSession: true,
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "CurveID-Resume-Server-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519},
		},
		resumeConfig: &Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP256},
		},
		flags: []string{
			"-on-initial-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			"-on-resume-expect-curve-id", strconv.Itoa(int(CurveP256)),
		},
		resumeSession: true,
	})

	// Server-sent point formats are legal in TLS 1.2, but not in TLS 1.3.
	testCases = append(testCases, testCase{
		name: "PointFormat-ServerHello-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{pointFormatUncompressed},
			},
		},
	})
	testCases = append(testCases, testCase{
		name: "PointFormat-EncryptedExtensions-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{pointFormatUncompressed},
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})

	// Server-sent supported groups/curves are legal in TLS 1.3. They are
	// illegal in TLS 1.2, but some servers send them anyway, so we must
	// tolerate them.
	testCases = append(testCases, testCase{
		name: "SupportedCurves-ServerHello-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendServerSupportedCurves: true,
			},
		},
	})
	testCases = append(testCases, testCase{
		name: "SupportedCurves-EncryptedExtensions-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendServerSupportedCurves: true,
			},
		},
	})

	// Test that we tolerate unknown point formats, as long as
	// pointFormatUncompressed is present. Limit ciphers to ECDHE ciphers to
	// check they are still functional.
	testCases = append(testCases, testCase{
		name: "PointFormat-Client-Tolerance",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{42, pointFormatUncompressed, 99, pointFormatCompressedPrime},
			},
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PointFormat-Server-Tolerance",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{42, pointFormatUncompressed, 99, pointFormatCompressedPrime},
			},
		},
	})

	// Test TLS 1.2 does not require the point format extension to be
	// present.
	testCases = append(testCases, testCase{
		name: "PointFormat-Client-Missing",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{},
			},
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PointFormat-Server-Missing",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{},
			},
		},
	})

	// If the point format extension is present, uncompressed points must be
	// offered. BoringSSL requires this whether or not ECDHE is used.
	testCases = append(testCases, testCase{
		name: "PointFormat-Client-MissingUncompressed",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{pointFormatCompressedPrime},
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PointFormat-Server-MissingUncompressed",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendSupportedPointFormats: []byte{pointFormatCompressedPrime},
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})

	// Post-quantum groups require TLS 1.3.
	for _, curve := range testCurves {
		if !isPqGroup(curve.id) {
			continue
		}

		// Post-quantum groups should not be offered by a TLS 1.2 client.
		testCases = append(testCases, testCase{
			name: "TLS12ClientShouldNotOffer-" + curve.name,
			config: Config{
				Bugs: ProtocolBugs{
					FailIfPostQuantumOffered: true,
				},
			},
			flags: []string{
				"-max-version", strconv.Itoa(VersionTLS12),
				"-curves", strconv.Itoa(int(curve.id)),
				"-curves", strconv.Itoa(int(CurveX25519)),
			},
		})

		// Post-quantum groups should not be selected by a TLS 1.2 server.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "TLS12ServerShouldNotSelect-" + curve.name,
			flags: []string{
				"-max-version", strconv.Itoa(VersionTLS12),
				"-curves", strconv.Itoa(int(curve.id)),
				"-curves", strconv.Itoa(int(CurveX25519)),
			},
			expectations: connectionExpectations{
				curveID: CurveX25519,
			},
		})

		// If a TLS 1.2 server selects a post-quantum group anyway, the client
		// should not accept it.
		testCases = append(testCases, testCase{
			name: "ClientShouldNotAllowInTLS12-" + curve.name,
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendCurve: curve.id,
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(curve.id)),
				"-curves", strconv.Itoa(int(CurveX25519)),
			},
			shouldFail:         true,
			expectedError:      ":WRONG_CURVE:",
			expectedLocalError: "remote error: illegal parameter",
		})
	}

	// ML-KEM and Kyber should not be offered by default as a client.
	testCases = append(testCases, testCase{
		name: "PostQuantumNotEnabledByDefaultInClients",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				FailIfPostQuantumOffered: true,
			},
		},
	})

	for _, curve := range testCurves {
		if !isMLKEMGroup(curve.id) {
			continue
		}

		// If ML-KEM is offered, both X25519 and ML-KEM should have a key-share.
		testCases = append(testCases, testCase{
			name: "NotJustMLKEMKeyShare-" + curve.name,
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectedKeyShares: []CurveID{curve.id, CurveX25519},
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(curve.id)),
				"-curves", strconv.Itoa(int(CurveX25519)),
				"-expect-curve-id", strconv.Itoa(int(curve.id)),
			},
		})

		// ... and the other way around
		testCases = append(testCases, testCase{
			name: "MLKEMKeyShareIncludedSecond-" + curve.name,
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectedKeyShares: []CurveID{CurveX25519, curve.id},
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(CurveX25519)),
				"-curves", strconv.Itoa(int(curve.id)),
				"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			},
		})

		// ... and even if there's another curve in the middle because it's the
		// first classical and first post-quantum "curves" that get key shares
		// included.
		testCases = append(testCases, testCase{
			name: "MLKEMKeyShareIncludedThird-" + curve.name,
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectedKeyShares: []CurveID{CurveX25519, curve.id},
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(CurveX25519)),
				"-curves", strconv.Itoa(int(CurveP256)),
				"-curves", strconv.Itoa(int(curve.id)),
				"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			},
		})

		// If ML-KEM is the only configured curve, the key share is sent.
		testCases = append(testCases, testCase{
			name: "JustConfiguringMLKEMWorks-" + curve.name,
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectedKeyShares: []CurveID{curve.id},
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(curve.id)),
				"-expect-curve-id", strconv.Itoa(int(curve.id)),
			},
		})

		// If both ML-KEM and Kyber are configured, only the preferred one's
		// key share should be sent.
		testCases = append(testCases, testCase{
			name: "BothMLKEMAndKyber-" + curve.name,
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectedKeyShares: []CurveID{curve.id},
				},
			},
			flags: []string{
				"-curves", strconv.Itoa(int(curve.id)),
				"-curves", strconv.Itoa(int(CurveX25519Kyber768)),
				"-expect-curve-id", strconv.Itoa(int(curve.id)),
			},
		})
	}

	// As a server, ML-KEMs and Kyber are not yet supported by default.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PostQuantumNotEnabledByDefaultForAServer",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519MLKEM768, CurveMLKEM1024, CurveX25519Kyber768, CurveX25519},
			DefaultCurves:    []CurveID{CurveX25519MLKEM768, CurveMLKEM1024, CurveX25519Kyber768},
		},
		flags: []string{
			"-server-preference",
			"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
		},
	})

	// If two ML-KEMs are configured, only the preferred one's
	// key share should be sent.
	testCases = append(testCases, testCase{
		name: "TwoMLKEMs",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveMLKEM1024},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-expect-curve-id", strconv.Itoa(int(CurveMLKEM1024)),
		},
	})

	// In TLS 1.2, the curve list is also used to signal ECDSA curves.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "CheckECDSACurve-TLS12",
		config: Config{
			MinVersion:       VersionTLS12,
			MaxVersion:       VersionTLS12,
			CurvePreferences: []CurveID{CurveP384},
		},
		shimCertificate: &ecdsaP256Certificate,
		shouldFail:      true,
		expectedError:   ":WRONG_CURVE:",
	})

	// If the ECDSA certificate is ineligible due to a curve mismatch, the
	// server may still consider a PSK cipher suite.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "CheckECDSACurve-PSK-TLS12",
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
			CipherSuites: []uint16{
				TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
				TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA,
			},
			CurvePreferences:     []CurveID{CurveP384},
			PreSharedKey:         []byte("12345"),
			PreSharedKeyIdentity: "luggage combo",
		},
		shimCertificate: &ecdsaP256Certificate,
		expectations: connectionExpectations{
			cipher: TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA,
		},
		flags: []string{
			"-psk", "12345",
			"-psk-identity", "luggage combo",
		},
	})

	// In TLS 1.3, the curve list only controls ECDH.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "CheckECDSACurve-NotApplicable-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP384},
		},
		shimCertificate: &ecdsaP256Certificate,
	})
}
