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
	"bytes"
	"fmt"
	"strconv"
)

type stateMachineTestConfig struct {
	protocol          protocol
	async             bool
	splitHandshake    bool
	packHandshake     bool
	implicitHandshake bool
}

// Adds tests that try to cover the range of the handshake state machine, under
// various conditions. Some of these are redundant with other tests, but they
// only cover the synchronous case.
func addAllStateMachineCoverageTests() {
	for _, async := range []bool{false, true} {
		for _, protocol := range []protocol{tls, dtls, quic} {
			addStateMachineCoverageTests(stateMachineTestConfig{
				protocol: protocol,
				async:    async,
			})
			// QUIC doesn't work with the implicit handshake API. Additionally,
			// splitting or packing handshake records is meaningless in QUIC.
			if protocol != quic {
				addStateMachineCoverageTests(stateMachineTestConfig{
					protocol:          protocol,
					async:             async,
					implicitHandshake: true,
				})
				addStateMachineCoverageTests(stateMachineTestConfig{
					protocol:       protocol,
					async:          async,
					splitHandshake: true,
				})
				addStateMachineCoverageTests(stateMachineTestConfig{
					protocol:      protocol,
					async:         async,
					packHandshake: true,
				})
			}
		}
	}
}

func addStateMachineCoverageTests(config stateMachineTestConfig) {
	var tests []testCase

	// Basic handshake, with resumption. Client and server,
	// session ID and session ticket.
	// The following tests have a max version of 1.2, so they are not suitable
	// for use with QUIC.
	if config.protocol != quic {
		tests = append(tests, testCase{
			name: "Basic-Client",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			resumeSession: true,
			// Ensure session tickets are used, not session IDs.
			noSessionCache: true,
			flags:          []string{"-expect-no-hrr"},
		})
		tests = append(tests, testCase{
			name: "Basic-Client-RenewTicket",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					RenewTicketOnResume: true,
				},
			},
			flags:                []string{"-expect-ticket-renewal"},
			resumeSession:        true,
			resumeRenewedSession: true,
		})
		tests = append(tests, testCase{
			name: "Basic-Client-NoTicket",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
			resumeSession: true,
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					RequireSessionTickets: true,
				},
			},
			resumeSession: true,
			flags: []string{
				"-expect-no-session-id",
				"-expect-no-hrr",
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-NoTickets",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
			resumeSession: true,
			flags:         []string{"-expect-session-id"},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-EarlyCallback",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			flags:         []string{"-use-early-callback"},
			resumeSession: true,
		})
	}

	// TLS 1.3 basic handshake shapes.
	tests = append(tests, testCase{
		name: "TLS13-1RTT-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		resumeSession:        true,
		resumeRenewedSession: true,
		// 0-RTT being disabled overrides all other 0-RTT reasons.
		flags: []string{"-expect-early-data-reason", "disabled"},
	})

	tests = append(tests, testCase{
		testType: serverTest,
		name:     "TLS13-1RTT-Server",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		resumeSession:        true,
		resumeRenewedSession: true,
		flags: []string{
			// TLS 1.3 uses tickets, so the session should not be
			// cached statefully.
			"-expect-no-session-id",
			// 0-RTT being disabled overrides all other 0-RTT reasons.
			"-expect-early-data-reason", "disabled",
		},
	})

	tests = append(tests, testCase{
		name: "TLS13-HelloRetryRequest-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			// P-384 requires a HelloRetryRequest against BoringSSL's default
			// configuration. Assert this with ExpectMissingKeyShare.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				ExpectMissingKeyShare: true,
			},
		},
		// Cover HelloRetryRequest during an ECDHE-PSK resumption.
		resumeSession: true,
		flags:         []string{"-expect-hrr"},
	})

	tests = append(tests, testCase{
		testType: serverTest,
		name:     "TLS13-HelloRetryRequest-Server",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			// Require a HelloRetryRequest for every curve.
			DefaultCurves: []CurveID{},
		},
		// Cover HelloRetryRequest during an ECDHE-PSK resumption.
		resumeSession: true,
		flags:         []string{"-expect-hrr"},
	})

	// TLS 1.3 early data tests. DTLS 1.3 doesn't support early data yet.
	// These tests are disabled for QUIC as well because they test features
	// that do not apply to QUIC's use of TLS 1.3.
	//
	// TODO(crbug.com/381113363): Enable these tests for DTLS once we
	// support early data in DTLS 1.3.
	if config.protocol != dtls && config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "TLS13-EarlyData-TooMuchData-Client",
			config: Config{
				MaxVersion:       VersionTLS13,
				MinVersion:       VersionTLS13,
				MaxEarlyDataSize: 2,
			},
			resumeConfig: &Config{
				MaxVersion:       VersionTLS13,
				MinVersion:       VersionTLS13,
				MaxEarlyDataSize: 2,
				Bugs: ProtocolBugs{
					ExpectEarlyData: [][]byte{[]byte(shimInitialWrite[:2])},
				},
			},
			resumeShimPrefix: shimInitialWrite[2:],
			resumeSession:    true,
			earlyData:        true,
		})

		// Unfinished writes can only be tested when operations are async. EarlyData
		// can't be tested as part of an ImplicitHandshake in this case since
		// otherwise the early data will be sent as normal data.
		if config.async && !config.implicitHandshake {
			tests = append(tests, testCase{
				testType: clientTest,
				name:     "TLS13-EarlyData-UnfinishedWrite-Client",
				config: Config{
					MaxVersion: VersionTLS13,
					MinVersion: VersionTLS13,
					Bugs: ProtocolBugs{
						// Write the server response before expecting early data.
						ExpectEarlyData:     [][]byte{},
						ExpectLateEarlyData: [][]byte{[]byte(shimInitialWrite)},
					},
				},
				resumeSession: true,
				earlyData:     true,
				flags:         []string{"-on-resume-read-with-unfinished-write"},
			})

			// Rejected unfinished writes are discarded (from the
			// perspective of the calling application) on 0-RTT
			// reject.
			tests = append(tests, testCase{
				testType: clientTest,
				name:     "TLS13-EarlyData-RejectUnfinishedWrite-Client",
				config: Config{
					MaxVersion: VersionTLS13,
					MinVersion: VersionTLS13,
					Bugs: ProtocolBugs{
						AlwaysRejectEarlyData: true,
					},
				},
				resumeSession:           true,
				earlyData:               true,
				expectEarlyDataRejected: true,
				flags:                   []string{"-on-resume-read-with-unfinished-write"},
			})
		}

		// Early data has no size limit in QUIC.
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "TLS13-MaxEarlyData-Server",
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendEarlyData:           [][]byte{bytes.Repeat([]byte{1}, 14336+1)},
					ExpectEarlyDataAccepted: true,
				},
			},
			messageCount:  2,
			resumeSession: true,
			earlyData:     true,
			shouldFail:    true,
			expectedError: ":TOO_MUCH_READ_EARLY_DATA:",
		})
	}

	// Test that early data is disabled for DTLS 1.3.
	if config.protocol == dtls {
		tests = append(tests, testCase{
			testType: clientTest,
			protocol: dtls,
			name:     "DTLS13-EarlyData",
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
			},
			resumeSession: true,
			earlyData:     true,
		})
	}

	// TLS client auth.
	// The following tests have a max version of 1.2, so they are not suitable
	// for use with QUIC.
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-NoCertificate-Client",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequestClientCert,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ClientAuth-NoCertificate-Server",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			// Setting SSL_VERIFY_PEER allows anonymous clients.
			flags: []string{"-verify-peer"},
		})
	}
	if config.protocol != dtls {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-NoCertificate-Client-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				ClientAuth: RequestClientCert,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ClientAuth-NoCertificate-Server-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			// Setting SSL_VERIFY_PEER allows anonymous clients.
			flags: []string{"-verify-peer"},
		})
	}
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-RSA-Client",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequireAnyClientCert,
			},
			shimCertificate: &rsaCertificate,
		})
	}
	tests = append(tests, testCase{
		testType: clientTest,
		name:     "ClientAuth-RSA-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
		},
		shimCertificate: &rsaCertificate,
	})
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-ECDSA-Client",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequireAnyClientCert,
			},
			shimCertificate: &ecdsaP256Certificate,
		})
	}
	tests = append(tests, testCase{
		testType: clientTest,
		name:     "ClientAuth-ECDSA-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
		},
		shimCertificate: &ecdsaP256Certificate,
	})
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-NoCertificate-OldCallback",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequestClientCert,
			},
			flags: []string{"-use-old-client-cert-callback"},
		})
	}
	tests = append(tests, testCase{
		testType: clientTest,
		name:     "ClientAuth-NoCertificate-OldCallback-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequestClientCert,
		},
		flags: []string{"-use-old-client-cert-callback"},
	})
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientAuth-OldCallback",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequireAnyClientCert,
			},
			shimCertificate: &rsaCertificate,
			flags: []string{
				"-use-old-client-cert-callback",
			},
		})
	}
	tests = append(tests, testCase{
		testType: clientTest,
		name:     "ClientAuth-OldCallback-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
		},
		shimCertificate: &rsaCertificate,
		flags: []string{
			"-use-old-client-cert-callback",
		},
	})
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ClientAuth-Server",
			config: Config{
				MaxVersion: VersionTLS12,
				Credential: &rsaCertificate,
			},
			flags: []string{"-require-any-client-certificate"},
		})
	}
	tests = append(tests, testCase{
		testType: serverTest,
		name:     "ClientAuth-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &rsaCertificate,
		},
		flags: []string{"-require-any-client-certificate"},
	})

	// Test each key exchange on the server side for async keys.
	if config.protocol != quic {
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-RSA",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
			},
			shimCertificate: &rsaCertificate,
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-ECDHE-RSA",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			},
			shimCertificate: &rsaCertificate,
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-ECDHE-ECDSA",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			},
			shimCertificate: &ecdsaP256Certificate,
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "Basic-Server-Ed25519",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			},
			shimCertificate: &ed25519Certificate,
			flags: []string{
				"-verify-prefs", strconv.Itoa(int(signatureEd25519)),
			},
		})

		// No session ticket support; server doesn't send NewSessionTicket.
		tests = append(tests, testCase{
			name: "SessionTicketsDisabled-Client",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "SessionTicketsDisabled-Server",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
		})

		// Skip ServerKeyExchange in PSK key exchange if there's no
		// identity hint.
		tests = append(tests, testCase{
			name: "EmptyPSKHint-Client",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_PSK_WITH_AES_128_CBC_SHA},
				PreSharedKey: []byte("secret"),
			},
			flags: []string{"-psk", "secret"},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "EmptyPSKHint-Server",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_PSK_WITH_AES_128_CBC_SHA},
				PreSharedKey: []byte("secret"),
			},
			flags: []string{"-psk", "secret"},
		})
	}

	// OCSP stapling tests.
	for _, vers := range allVersions(config.protocol) {
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "OCSPStapling-Client-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Credential: rsaCertificate.WithOCSP(testOCSPResponse),
			},
			flags: []string{
				"-enable-ocsp-stapling",
				"-expect-ocsp-response",
				base64FlagValue(testOCSPResponse),
				"-verify-peer",
			},
			resumeSession: true,
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "OCSPStapling-Server-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
			},
			expectations: connectionExpectations{
				peerCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			},
			shimCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			resumeSession:   true,
		})

		// The client OCSP callback is an alternate certificate
		// verification callback.
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientOCSPCallback-Pass-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Credential: rsaCertificate.WithOCSP(testOCSPResponse),
			},
			flags: []string{
				"-enable-ocsp-stapling",
				"-use-ocsp-callback",
			},
		})
		var expectedLocalError string
		if !config.async {
			// TODO(davidben): Asynchronous fatal alerts are never
			// sent. https://crbug.com/boringssl/130.
			expectedLocalError = "remote error: bad certificate status response"
		}
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientOCSPCallback-Fail-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Credential: rsaCertificate.WithOCSP(testOCSPResponse),
			},
			flags: []string{
				"-enable-ocsp-stapling",
				"-use-ocsp-callback",
				"-fail-ocsp-callback",
			},
			shouldFail:         true,
			expectedLocalError: expectedLocalError,
			expectedError:      ":OCSP_CB_ERROR:",
		})
		// The callback still runs if the server does not send an OCSP
		// response.
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "ClientOCSPCallback-FailNoStaple-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-enable-ocsp-stapling",
				"-use-ocsp-callback",
				"-fail-ocsp-callback",
			},
			shouldFail:         true,
			expectedLocalError: expectedLocalError,
			expectedError:      ":OCSP_CB_ERROR:",
		})

		// The server OCSP callback is a legacy mechanism for
		// configuring OCSP, used by unreliable server software.
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ServerOCSPCallback-SetInCallback-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
			},
			shimCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			expectations: connectionExpectations{
				peerCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			},
			flags: []string{
				"-use-ocsp-callback",
				"-set-ocsp-in-callback",
			},
			resumeSession: true,
		})

		// The callback may decline OCSP, in which case  we act as if
		// the client did not support it, even if a response was
		// configured.
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ServerOCSPCallback-Decline-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
			},
			shimCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			expectations: connectionExpectations{
				// There should be no OCSP response from the peer.
				peerCertificate: &rsaCertificate,
			},
			flags: []string{
				"-use-ocsp-callback",
				"-decline-ocsp-callback",
			},
			resumeSession: true,
		})

		// The callback may also signal an internal error.
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ServerOCSPCallback-Fail-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
			},
			shimCertificate: rsaCertificate.WithOCSP(testOCSPResponse),
			flags: []string{
				"-use-ocsp-callback",
				"-fail-ocsp-callback",
			},
			shouldFail:    true,
			expectedError: ":OCSP_CB_ERROR:",
		})
	}

	// Certificate verification tests.
	for _, vers := range allVersions(config.protocol) {
		for _, useCustomCallback := range []bool{false, true} {
			for _, testType := range []testType{clientTest, serverTest} {
				suffix := "-Client"
				if testType == serverTest {
					suffix = "-Server"
				}
				suffix += "-" + vers.name
				if useCustomCallback {
					suffix += "-CustomCallback"
				}

				// The custom callback and legacy callback have different default
				// alerts.
				verifyFailLocalError := "remote error: handshake failure"
				if useCustomCallback {
					verifyFailLocalError = "remote error: unknown certificate"
				}

				// We do not reliably send asynchronous fatal alerts. See
				// https://crbug.com/boringssl/130.
				if config.async {
					verifyFailLocalError = ""
				}

				flags := []string{"-verify-peer"}
				if testType == serverTest {
					flags = append(flags, "-require-any-client-certificate")
				}
				if useCustomCallback {
					flags = append(flags, "-use-custom-verify-callback")
				}

				tests = append(tests, testCase{
					testType: testType,
					name:     "CertificateVerificationSucceed" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Credential: &rsaCertificate,
					},
					flags:         append([]string{"-expect-verify-result"}, flags...),
					resumeSession: true,
				})
				tests = append(tests, testCase{
					testType: testType,
					name:     "CertificateVerificationFail" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Credential: &rsaCertificate,
					},
					flags:              append([]string{"-verify-fail"}, flags...),
					shouldFail:         true,
					expectedError:      ":CERTIFICATE_VERIFY_FAILED:",
					expectedLocalError: verifyFailLocalError,
				})
				// Tests that although the verify callback fails on resumption, by default we don't call it.
				tests = append(tests, testCase{
					testType: testType,
					name:     "CertificateVerificationDoesNotFailOnResume" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Credential: &rsaCertificate,
					},
					flags:         append([]string{"-on-resume-verify-fail"}, flags...),
					resumeSession: true,
				})
				if testType == clientTest && useCustomCallback {
					tests = append(tests, testCase{
						testType: testType,
						name:     "CertificateVerificationFailsOnResume" + suffix,
						config: Config{
							MaxVersion: vers.version,
							Credential: &rsaCertificate,
						},
						flags: append([]string{
							"-on-resume-verify-fail",
							"-reverify-on-resume",
						}, flags...),
						resumeSession:      true,
						shouldFail:         true,
						expectedError:      ":CERTIFICATE_VERIFY_FAILED:",
						expectedLocalError: verifyFailLocalError,
					})
					tests = append(tests, testCase{
						testType: testType,
						name:     "CertificateVerificationPassesOnResume" + suffix,
						config: Config{
							MaxVersion: vers.version,
							Credential: &rsaCertificate,
						},
						flags: append([]string{
							"-reverify-on-resume",
						}, flags...),
						resumeSession: true,
					})
					// TODO(crbug.com/381113363): Support 0-RTT in DTLS 1.3.
					if vers.version >= VersionTLS13 && config.protocol != dtls {
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-RejectTicket-Client-Reverify" + suffix,
							config: Config{
								MaxVersion: vers.version,
							},
							resumeConfig: &Config{
								MaxVersion:             vers.version,
								SessionTicketsDisabled: true,
							},
							resumeSession:           true,
							expectResumeRejected:    true,
							earlyData:               true,
							expectEarlyDataRejected: true,
							flags: append([]string{
								"-reverify-on-resume",
								// Session tickets are disabled, so the runner will not send a ticket.
								"-on-retry-expect-no-session",
							}, flags...),
						})
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-Reject0RTT-Client-Reverify" + suffix,
							config: Config{
								MaxVersion: vers.version,
								Bugs: ProtocolBugs{
									AlwaysRejectEarlyData: true,
								},
							},
							resumeSession:           true,
							expectResumeRejected:    false,
							earlyData:               true,
							expectEarlyDataRejected: true,
							flags: append([]string{
								"-reverify-on-resume",
							}, flags...),
						})
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-RejectTicket-Client-ReverifyFails" + suffix,
							config: Config{
								MaxVersion: vers.version,
							},
							resumeConfig: &Config{
								MaxVersion:             vers.version,
								SessionTicketsDisabled: true,
							},
							resumeSession:           true,
							expectResumeRejected:    true,
							earlyData:               true,
							expectEarlyDataRejected: true,
							shouldFail:              true,
							expectedError:           ":CERTIFICATE_VERIFY_FAILED:",
							flags: append([]string{
								"-reverify-on-resume",
								// Session tickets are disabled, so the runner will not send a ticket.
								"-on-retry-expect-no-session",
								"-on-retry-verify-fail",
							}, flags...),
						})
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-Reject0RTT-Client-ReverifyFails" + suffix,
							config: Config{
								MaxVersion: vers.version,
								Bugs: ProtocolBugs{
									AlwaysRejectEarlyData: true,
								},
							},
							resumeSession:           true,
							expectResumeRejected:    false,
							earlyData:               true,
							expectEarlyDataRejected: true,
							shouldFail:              true,
							expectedError:           ":CERTIFICATE_VERIFY_FAILED:",
							expectedLocalError:      verifyFailLocalError,
							flags: append([]string{
								"-reverify-on-resume",
								"-on-retry-verify-fail",
							}, flags...),
						})
						// This tests that we only call the verify callback once.
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-Accept0RTT-Client-Reverify" + suffix,
							config: Config{
								MaxVersion: vers.version,
							},
							resumeSession: true,
							earlyData:     true,
							flags: append([]string{
								"-reverify-on-resume",
							}, flags...),
						})
						tests = append(tests, testCase{
							testType: testType,
							name:     "EarlyData-Accept0RTT-Client-ReverifyFails" + suffix,
							config: Config{
								MaxVersion: vers.version,
							},
							resumeSession: true,
							earlyData:     true,
							shouldFail:    true,
							expectedError: ":CERTIFICATE_VERIFY_FAILED:",
							// We do not set expectedLocalError here because the shim rejects
							// the connection without an alert.
							flags: append([]string{
								"-reverify-on-resume",
								"-on-resume-verify-fail",
							}, flags...),
						})
					}
				}
			}
		}

		// By default, the client is in a soft fail mode where the peer
		// certificate is verified but failures are non-fatal.
		tests = append(tests, testCase{
			testType: clientTest,
			name:     "CertificateVerificationSoftFail-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-verify-fail",
				"-expect-verify-result",
			},
			resumeSession: true,
		})
	}

	tests = append(tests, testCase{
		name:               "ShimSendAlert",
		flags:              []string{"-send-alert"},
		shimWritesFirst:    true,
		shouldFail:         true,
		expectedLocalError: "remote error: decompression failure",
	})

	if config.protocol == tls {
		tests = append(tests, testCase{
			name: "Renegotiate-Client",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			renegotiate: 1,
			flags: []string{
				"-renegotiate-freely",
				"-expect-total-renegotiations", "1",
			},
		})

		tests = append(tests, testCase{
			name: "Renegotiate-Client-Explicit",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			renegotiate: 1,
			flags: []string{
				"-renegotiate-explicit",
				"-expect-total-renegotiations", "1",
			},
		})

		halfHelloRequestError := ":UNEXPECTED_RECORD:"
		if config.packHandshake {
			// If the HelloRequest is sent in the same record as the server Finished,
			// BoringSSL rejects it before the handshake completes.
			halfHelloRequestError = ":EXCESS_HANDSHAKE_DATA:"
		}
		tests = append(tests, testCase{
			name: "SendHalfHelloRequest",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					PackHelloRequestWithFinished: config.packHandshake,
				},
			},
			sendHalfHelloRequest: true,
			flags:                []string{"-renegotiate-ignore"},
			shouldFail:           true,
			expectedError:        halfHelloRequestError,
		})

		// NPN on client and server; results in post-ChangeCipherSpec message.
		tests = append(tests, testCase{
			name: "NPN-Client",
			config: Config{
				MaxVersion: VersionTLS12,
				NextProtos: []string{"foo"},
			},
			flags:         []string{"-select-next-proto", "foo"},
			resumeSession: true,
			expectations: connectionExpectations{
				nextProto:     "foo",
				nextProtoType: npn,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "NPN-Server",
			config: Config{
				MaxVersion: VersionTLS12,
				NextProtos: []string{"bar"},
			},
			flags: []string{
				"-advertise-npn", "\x03foo\x03bar\x03baz",
				"-expect-next-proto", "bar",
			},
			resumeSession: true,
			expectations: connectionExpectations{
				nextProto:     "bar",
				nextProtoType: npn,
			},
		})

		// The client may select no protocol after seeing the server list.
		tests = append(tests, testCase{
			name: "NPN-Client-ClientSelectEmpty",
			config: Config{
				MaxVersion: VersionTLS12,
				NextProtos: []string{"foo"},
			},
			flags:         []string{"-select-empty-next-proto"},
			resumeSession: true,
			expectations: connectionExpectations{
				noNextProto:   true,
				nextProtoType: npn,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "NPN-Server-ClientSelectEmpty",
			config: Config{
				MaxVersion:          VersionTLS12,
				NextProtos:          []string{"no-match"},
				NoFallbackNextProto: true,
			},
			flags: []string{
				"-advertise-npn", "\x03foo\x03bar\x03baz",
				"-expect-no-next-proto",
			},
			resumeSession: true,
			expectations: connectionExpectations{
				noNextProto:   true,
				nextProtoType: npn,
			},
		})

		// The server may negotiate NPN, despite offering no protocols. In this
		// case, the server must still be prepared for the client to select a
		// fallback protocol.
		tests = append(tests, testCase{
			name: "NPN-Client-ServerAdvertiseEmpty",
			config: Config{
				MaxVersion:               VersionTLS12,
				NegotiateNPNWithNoProtos: true,
			},
			flags:         []string{"-select-next-proto", "foo"},
			resumeSession: true,
			expectations: connectionExpectations{
				nextProto:     "foo",
				nextProtoType: npn,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "NPN-Server-ServerAdvertiseEmpty",
			config: Config{
				MaxVersion: VersionTLS12,
				NextProtos: []string{"foo"},
			},
			flags: []string{
				"-advertise-empty-npn",
				"-expect-next-proto", "foo",
			},
			resumeSession: true,
			expectations: connectionExpectations{
				nextProto:     "foo",
				nextProtoType: npn,
			},
		})

		// Client does False Start and negotiates NPN.
		tests = append(tests, testCase{
			name: "FalseStart",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					ExpectFalseStart: true,
				},
			},
			flags: []string{
				"-false-start",
				"-select-next-proto", "foo",
			},
			shimWritesFirst: true,
			resumeSession:   true,
		})

		// Client does False Start and negotiates ALPN.
		tests = append(tests, testCase{
			name: "FalseStart-ALPN",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					ExpectFalseStart: true,
				},
			},
			flags: []string{
				"-false-start",
				"-advertise-alpn", "\x03foo",
				"-expect-alpn", "foo",
			},
			shimWritesFirst: true,
			resumeSession:   true,
		})

		// False Start without session tickets.
		tests = append(tests, testCase{
			name: "FalseStart-SessionTicketsDisabled",
			config: Config{
				MaxVersion:             VersionTLS12,
				CipherSuites:           []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:             []string{"foo"},
				SessionTicketsDisabled: true,
				Bugs: ProtocolBugs{
					ExpectFalseStart: true,
				},
			},
			flags: []string{
				"-false-start",
				"-select-next-proto", "foo",
			},
			shimWritesFirst: true,
		})

		// Server parses a V2ClientHello. Test different lengths for the
		// challenge field.
		for _, challengeLength := range []int{16, 31, 32, 33, 48} {
			tests = append(tests, testCase{
				testType: serverTest,
				name:     fmt.Sprintf("SendV2ClientHello-%d", challengeLength),
				config: Config{
					// Choose a cipher suite that does not involve
					// elliptic curves, so no extensions are
					// involved.
					MaxVersion:   VersionTLS12,
					CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
					Bugs: ProtocolBugs{
						SendV2ClientHello:            true,
						V2ClientHelloChallengeLength: challengeLength,
					},
				},
				flags: []string{
					"-expect-msg-callback",
					`read v2clienthello
write hs 2
write hs 11
write hs 14
read hs 16
read ccs
read hs 20
write ccs
write hs 20
read alert 1 0
`,
				},
			})
		}

		// Channel ID and NPN at the same time, to ensure their relative
		// ordering is correct.
		tests = append(tests, testCase{
			name: "ChannelID-NPN-Client",
			config: Config{
				MaxVersion:       VersionTLS12,
				RequestChannelID: true,
				NextProtos:       []string{"foo"},
			},
			flags: []string{
				"-send-channel-id", channelIDKeyPath,
				"-select-next-proto", "foo",
			},
			resumeSession: true,
			expectations: connectionExpectations{
				channelID:     true,
				nextProto:     "foo",
				nextProtoType: npn,
			},
		})
		tests = append(tests, testCase{
			testType: serverTest,
			name:     "ChannelID-NPN-Server",
			config: Config{
				MaxVersion: VersionTLS12,
				ChannelID:  &channelIDKey,
				NextProtos: []string{"bar"},
			},
			flags: []string{
				"-expect-channel-id",
				base64FlagValue(channelIDBytes),
				"-advertise-npn", "\x03foo\x03bar\x03baz",
				"-expect-next-proto", "bar",
			},
			resumeSession: true,
			expectations: connectionExpectations{
				channelID:     true,
				nextProto:     "bar",
				nextProtoType: npn,
			},
		})

		// Bidirectional shutdown with the runner initiating.
		tests = append(tests, testCase{
			name: "Shutdown-Runner",
			config: Config{
				Bugs: ProtocolBugs{
					ExpectCloseNotify: true,
				},
			},
			flags: []string{"-check-close-notify"},
		})
	}
	if config.protocol != dtls {
		// Test Channel ID
		for _, ver := range allVersions(config.protocol) {
			if ver.version < VersionTLS10 {
				continue
			}
			// Client sends a Channel ID.
			tests = append(tests, testCase{
				name: "ChannelID-Client-" + ver.name,
				config: Config{
					MaxVersion:       ver.version,
					RequestChannelID: true,
				},
				flags:         []string{"-send-channel-id", channelIDKeyPath},
				resumeSession: true,
				expectations: connectionExpectations{
					channelID: true,
				},
			})

			// Server accepts a Channel ID.
			tests = append(tests, testCase{
				testType: serverTest,
				name:     "ChannelID-Server-" + ver.name,
				config: Config{
					MaxVersion: ver.version,
					ChannelID:  &channelIDKey,
				},
				flags: []string{
					"-expect-channel-id",
					base64FlagValue(channelIDBytes),
				},
				resumeSession: true,
				expectations: connectionExpectations{
					channelID: true,
				},
			})

			tests = append(tests, testCase{
				testType: serverTest,
				name:     "InvalidChannelIDSignature-" + ver.name,
				config: Config{
					MaxVersion: ver.version,
					ChannelID:  &channelIDKey,
					Bugs: ProtocolBugs{
						InvalidChannelIDSignature: true,
					},
				},
				flags:         []string{"-enable-channel-id"},
				shouldFail:    true,
				expectedError: ":CHANNEL_ID_SIGNATURE_INVALID:",
			})

			if ver.version < VersionTLS13 {
				// Channel ID requires ECDHE ciphers.
				tests = append(tests, testCase{
					testType: serverTest,
					name:     "ChannelID-NoECDHE-" + ver.name,
					config: Config{
						MaxVersion:   ver.version,
						CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
						ChannelID:    &channelIDKey,
					},
					expectations: connectionExpectations{
						channelID: false,
					},
					flags: []string{"-enable-channel-id"},
				})

				// Sanity-check setting expectations.channelID false works.
				tests = append(tests, testCase{
					testType: serverTest,
					name:     "ChannelID-ECDHE-" + ver.name,
					config: Config{
						MaxVersion:   ver.version,
						CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
						ChannelID:    &channelIDKey,
					},
					expectations: connectionExpectations{
						channelID: false,
					},
					flags:              []string{"-enable-channel-id"},
					shouldFail:         true,
					expectedLocalError: "channel ID unexpectedly negotiated",
				})
			}
		}

		if !config.implicitHandshake {
			// Bidirectional shutdown with the shim initiating. The runner,
			// in the meantime, sends garbage before the close_notify which
			// the shim must ignore. This test is disabled under implicit
			// handshake tests because the shim never reads or writes.

			// Tests that require checking for a close notify alert don't work with
			// QUIC because alerts are handled outside of the TLS stack in QUIC.
			if config.protocol != quic {
				tests = append(tests, testCase{
					name: "Shutdown-Shim",
					config: Config{
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown:     true,
					sendEmptyRecords:  1,
					sendWarningAlerts: 1,
					flags:             []string{"-check-close-notify"},
				})

				// The shim should reject unexpected application data
				// when shutting down.
				tests = append(tests, testCase{
					name: "Shutdown-Shim-ApplicationData",
					config: Config{
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown:     true,
					messageCount:      1,
					sendEmptyRecords:  1,
					sendWarningAlerts: 1,
					flags:             []string{"-check-close-notify"},
					shouldFail:        true,
					expectedError:     ":APPLICATION_DATA_ON_SHUTDOWN:",
				})

				// Test that SSL_shutdown still processes KeyUpdate.
				tests = append(tests, testCase{
					name: "Shutdown-Shim-KeyUpdate",
					config: Config{
						MinVersion: VersionTLS13,
						MaxVersion: VersionTLS13,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown:    true,
					sendKeyUpdates:   1,
					keyUpdateRequest: keyUpdateRequested,
					flags:            []string{"-check-close-notify"},
				})

				// Test that SSL_shutdown processes HelloRequest
				// correctly.
				tests = append(tests, testCase{
					name: "Shutdown-Shim-HelloRequest-Ignore",
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							SendHelloRequestBeforeEveryAppDataRecord: true,
							ExpectCloseNotify:                        true,
						},
					},
					shimShutsDown: true,
					flags: []string{
						"-renegotiate-ignore",
						"-check-close-notify",
					},
				})
				tests = append(tests, testCase{
					name: "Shutdown-Shim-HelloRequest-Reject",
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown: true,
					renegotiate:   1,
					shouldFail:    true,
					expectedError: ":NO_RENEGOTIATION:",
					flags:         []string{"-check-close-notify"},
				})
				tests = append(tests, testCase{
					name: "Shutdown-Shim-HelloRequest-CannotHandshake",
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown: true,
					renegotiate:   1,
					shouldFail:    true,
					expectedError: ":NO_RENEGOTIATION:",
					flags: []string{
						"-check-close-notify",
						"-renegotiate-freely",
					},
				})

				tests = append(tests, testCase{
					testType: serverTest,
					name:     "Shutdown-Shim-Renegotiate-Server-Forbidden",
					config: Config{
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							ExpectCloseNotify: true,
						},
					},
					shimShutsDown: true,
					renegotiate:   1,
					shouldFail:    true,
					expectedError: ":NO_RENEGOTIATION:",
					flags: []string{
						"-check-close-notify",
					},
				})
			}
		}
	}
	if config.protocol == dtls {
		tests = append(tests, testCase{
			name: "SkipHelloVerifyRequest",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SkipHelloVerifyRequest: true,
				},
			},
		})
		tests = append(tests, testCase{
			name: "DTLS13-HelloVerifyRequest",
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ForceHelloVerifyRequest: true,
				},
			},
			shouldFail:    true,
			expectedError: ":INVALID_MESSAGE:",
		})
		tests = append(tests, testCase{
			name: "DTLS13-HelloVerifyRequestEmptyCookie",
			config: Config{
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ForceHelloVerifyRequest:       true,
					EmptyHelloVerifyRequestCookie: true,
				},
			},
			shouldFail:    true,
			expectedError: ":INVALID_MESSAGE:",
		})
	}

	for _, test := range tests {
		test.protocol = config.protocol
		test.name += "-" + config.protocol.String()
		if config.async {
			test.name += "-Async"
			test.flags = append(test.flags, "-async")
		} else {
			test.name += "-Sync"
		}
		if config.splitHandshake {
			test.name += "-SplitHandshakeRecords"
			test.config.Bugs.MaxHandshakeRecordLength = 1
			if config.protocol == dtls {
				test.config.Bugs.MaxPacketLength = 256
				test.flags = append(test.flags, "-mtu", "256")
			}
		}
		if config.packHandshake {
			test.name += "-PackHandshake"
			if config.protocol == dtls {
				test.config.Bugs.MaxHandshakeRecordLength = 2
				test.config.Bugs.PackHandshakeFragments = 20
				test.config.Bugs.PackHandshakeRecords = 1500
				test.config.Bugs.PackAppDataWithHandshake = true
			} else {
				test.config.Bugs.PackHandshakeFlight = true
			}
		}
		if config.implicitHandshake {
			test.name += "-ImplicitHandshake"
			test.flags = append(test.flags, "-implicit-handshake")
		}
		testCases = append(testCases, test)
	}
}
