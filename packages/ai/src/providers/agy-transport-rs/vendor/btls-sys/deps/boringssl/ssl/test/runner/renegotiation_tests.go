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

func addRenegotiationTests() {
	// Servers cannot renegotiate.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Renegotiate-Server-Forbidden",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate:        1,
		shouldFail:         true,
		expectedError:      ":NO_RENEGOTIATION:",
		expectedLocalError: "remote error: no renegotiation",
	})
	// The server shouldn't echo the renegotiation extension unless
	// requested by the client.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Renegotiate-Server-NoExt",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				NoRenegotiationInfo:      true,
				RequireRenegotiationInfo: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "renegotiation extension missing",
	})
	// The renegotiation SCSV should be sufficient for the server to echo
	// the extension.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Renegotiate-Server-NoExt-SCSV",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				NoRenegotiationInfo:      true,
				SendRenegotiationSCSV:    true,
				RequireRenegotiationInfo: true,
			},
		},
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				FailIfResumeOnRenego: true,
			},
		},
		renegotiate: 1,
		// Test renegotiation after both an initial and resumption
		// handshake.
		resumeSession: true,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
			"-expect-secure-renegotiation",
		},
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				FailIfResumeOnRenego: true,
			},
		},
		renegotiate: 1,
		// Test renegotiation after both an initial and resumption
		// handshake.
		resumeSession: true,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
			"-expect-secure-renegotiation",
		},
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-EmptyExt",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				EmptyRenegotiationInfo: true,
			},
		},
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":RENEGOTIATION_MISMATCH:",
		expectedLocalError: "handshake failure",
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-BadExt",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				BadRenegotiationInfo: true,
			},
		},
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":RENEGOTIATION_MISMATCH:",
		expectedLocalError: "handshake failure",
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-BadExt2",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				BadRenegotiationInfoEnd: true,
			},
		},
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":RENEGOTIATION_MISMATCH:",
		expectedLocalError: "handshake failure",
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-Downgrade",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				NoRenegotiationInfoAfterInitial: true,
			},
		},
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":RENEGOTIATION_MISMATCH:",
		expectedLocalError: "handshake failure",
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-Upgrade",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				NoRenegotiationInfoInInitial: true,
			},
		},
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":RENEGOTIATION_MISMATCH:",
		expectedLocalError: "handshake failure",
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-NoExt-Allowed",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				NoRenegotiationInfo: true,
			},
		},
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
			"-expect-no-secure-renegotiation",
		},
	})

	// Test that the server may switch ciphers on renegotiation without
	// problems.
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-SwitchCiphers",
		renegotiate: 1,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
		},
		renegotiateCiphers: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-Client-SwitchCiphers2",
		renegotiate: 1,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
		},
		renegotiateCiphers: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
	})

	// Test that the server may not switch versions on renegotiation.
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-SwitchVersion",
		config: Config{
			MaxVersion: VersionTLS12,
			// Pick a cipher which exists at both versions.
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
			Bugs: ProtocolBugs{
				NegotiateVersionOnRenego: VersionTLS11,
				// Avoid failing early at the record layer.
				SendRecordVersion: VersionTLS12,
			},
		},
		renegotiate: 1,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
		shouldFail:    true,
		expectedError: ":WRONG_SSL_VERSION:",
	})

	testCases = append(testCases, testCase{
		name:        "Renegotiate-SameClientVersion",
		renegotiate: 1,
		config: Config{
			MaxVersion: VersionTLS10,
			Bugs: ProtocolBugs{
				RequireSameRenegoClientVersion: true,
			},
		},
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
	})
	testCases = append(testCases, testCase{
		name:        "Renegotiate-FalseStart",
		renegotiate: 1,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			NextProtos:   []string{"foo"},
		},
		flags: []string{
			"-false-start",
			"-select-next-proto", "foo",
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
		shimWritesFirst: true,
	})

	// Client-side renegotiation controls.
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Forbidden-1",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate:        1,
		shouldFail:         true,
		expectedError:      ":NO_RENEGOTIATION:",
		expectedLocalError: "remote error: no renegotiation",
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Once-1",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate: 1,
		flags: []string{
			"-renegotiate-once",
			"-expect-total-renegotiations", "1",
		},
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Freely-1",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate: 1,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Once-2",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate:        2,
		flags:              []string{"-renegotiate-once"},
		shouldFail:         true,
		expectedError:      ":NO_RENEGOTIATION:",
		expectedLocalError: "remote error: no renegotiation",
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Freely-2",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate: 2,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "2",
		},
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-NoIgnore",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendHelloRequestBeforeEveryAppDataRecord: true,
			},
		},
		shouldFail:    true,
		expectedError: ":NO_RENEGOTIATION:",
	})
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Ignore",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendHelloRequestBeforeEveryAppDataRecord: true,
			},
		},
		flags: []string{
			"-renegotiate-ignore",
			"-expect-total-renegotiations", "0",
		},
	})

	// Renegotiation may be enabled and then disabled immediately after the
	// handshake.
	testCases = append(testCases, testCase{
		name: "Renegotiate-ForbidAfterHandshake",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate:        1,
		flags:              []string{"-forbid-renegotiation-after-handshake"},
		shouldFail:         true,
		expectedError:      ":NO_RENEGOTIATION:",
		expectedLocalError: "remote error: no renegotiation",
	})

	// Renegotiation is not allowed when there is an unfinished write.
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-UnfinishedWrite",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate:             1,
		readWithUnfinishedWrite: true,
		flags: []string{
			"-async",
			"-renegotiate-freely",
		},
		shouldFail:    true,
		expectedError: ":NO_RENEGOTIATION:",
		// We do not successfully send the no_renegotiation alert in
		// this case. https://crbug.com/boringssl/130
	})

	// We reject stray HelloRequests during the handshake in TLS 1.2.
	testCases = append(testCases, testCase{
		name: "StrayHelloRequest",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendHelloRequestBeforeEveryHandshakeMessage: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})
	testCases = append(testCases, testCase{
		name: "StrayHelloRequest-Packed",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				PackHandshakeFlight:                         true,
				SendHelloRequestBeforeEveryHandshakeMessage: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})

	// Test that HelloRequest is rejected if it comes in the same record as the
	// server Finished.
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-Packed",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				PackHandshakeFlight:          true,
				PackHelloRequestWithFinished: true,
			},
		},
		renegotiate:        1,
		flags:              []string{"-renegotiate-freely"},
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	// Renegotiation is forbidden in TLS 1.3.
	testCases = append(testCases, testCase{
		name: "Renegotiate-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRequestBeforeEveryAppDataRecord: true,
			},
		},
		flags: []string{
			"-renegotiate-freely",
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})

	// Stray HelloRequests during the handshake are forbidden in TLS 1.3.
	testCases = append(testCases, testCase{
		name: "StrayHelloRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRequestBeforeEveryHandshakeMessage: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})

	// The renegotiation_info extension is not sent in TLS 1.3, but TLS 1.3
	// always reads as supporting it, regardless of whether it was
	// negotiated.
	testCases = append(testCases, testCase{
		name: "AlwaysReportRenegotiationInfo-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NoRenegotiationInfo: true,
			},
		},
		flags: []string{
			"-expect-secure-renegotiation",
		},
	})

	// Certificates may not change on renegotiation.
	testCases = append(testCases, testCase{
		name: "Renegotiation-CertificateChange",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: &rsaCertificate,
			Bugs: ProtocolBugs{
				RenegotiationCertificate: &rsaChainCertificate,
			},
		},
		renegotiate:   1,
		flags:         []string{"-renegotiate-freely"},
		shouldFail:    true,
		expectedError: ":SERVER_CERT_CHANGED:",
	})
	testCases = append(testCases, testCase{
		name: "Renegotiation-CertificateChange-2",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: &rsaCertificate,
			Bugs: ProtocolBugs{
				RenegotiationCertificate: &rsa1024Certificate,
			},
		},
		renegotiate:   1,
		flags:         []string{"-renegotiate-freely"},
		shouldFail:    true,
		expectedError: ":SERVER_CERT_CHANGED:",
	})

	// We do not negotiate ALPN after the initial handshake. This is
	// error-prone and only risks bugs in consumers.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "Renegotiation-ForbidALPN",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				// Forcibly negotiate ALPN on both initial and
				// renegotiation handshakes. The test stack will
				// internally check the client does not offer
				// it.
				SendALPN: "foo",
			},
		},
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar\x03baz",
			"-expect-alpn", "foo",
			"-renegotiate-freely",
		},
		renegotiate:   1,
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	// The server may send different stapled OCSP responses or SCT lists on
	// renegotiation, but BoringSSL ignores this and reports the old values.
	// Also test that non-fatal verify results are preserved.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "Renegotiation-ChangeAuthProperties",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: rsaCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
			Bugs: ProtocolBugs{
				SendOCSPResponseOnRenegotiation: testOCSPResponse2,
				SendSCTListOnRenegotiation:      testSCTList2,
			},
		},
		renegotiate: 1,
		flags: []string{
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
			"-enable-ocsp-stapling",
			"-expect-ocsp-response",
			base64FlagValue(testOCSPResponse),
			"-enable-signed-cert-timestamps",
			"-expect-signed-cert-timestamps",
			base64FlagValue(testSCTList),
			"-verify-fail",
			"-expect-verify-result",
		},
	})
}
