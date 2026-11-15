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
	"time"
)

func addResumptionVersionTests() {
	for _, sessionVers := range tlsVersions {
		for _, resumeVers := range tlsVersions {
			protocols := []protocol{tls}
			if sessionVers.hasDTLS && resumeVers.hasDTLS {
				protocols = append(protocols, dtls)
			}
			if sessionVers.hasQUIC && resumeVers.hasQUIC {
				protocols = append(protocols, quic)
			}
			for _, protocol := range protocols {
				suffix := "-" + sessionVers.name + "-" + resumeVers.name
				suffix += "-" + protocol.String()

				if sessionVers.version == resumeVers.version {
					testCases = append(testCases, testCase{
						protocol:      protocol,
						name:          "Resume-Client" + suffix,
						resumeSession: true,
						config: Config{
							MaxVersion: sessionVers.version,
							Bugs: ProtocolBugs{
								ExpectNoTLS13PSK: sessionVers.version < VersionTLS13,
							},
						},
						expectations: connectionExpectations{
							version: sessionVers.version,
						},
						resumeExpectations: &connectionExpectations{
							version: resumeVers.version,
						},
					})
				} else if protocol != tls && sessionVers.version >= VersionTLS13 && resumeVers.version < VersionTLS13 {
					// In TLS 1.2 and below, the server indicates resumption by echoing
					// the client's session ID, which is impossible if the client did
					// not send a session ID. If the client offers a TLS 1.3 session, it
					// only fills in session ID in TLS (not DTLS or QUIC) for middlebox
					// compatibility mode. So, instead, test that the session ID was
					// empty and it was indeed impossible to hit this path
					testCases = append(testCases, testCase{
						protocol:      protocol,
						name:          "Resume-Client-Impossible" + suffix,
						resumeSession: true,
						config: Config{
							MaxVersion: sessionVers.version,
						},
						expectations: connectionExpectations{
							version: sessionVers.version,
						},
						resumeConfig: &Config{
							MaxVersion: resumeVers.version,
							Bugs: ProtocolBugs{
								ExpectNoSessionID: true,
							},
						},
						resumeExpectations: &connectionExpectations{
							version: resumeVers.version,
						},
						expectResumeRejected: true,
					})
				} else {
					// Test that the client rejects ServerHellos which resume
					// sessions at inconsistent versions.
					expectedError := ":OLD_SESSION_VERSION_NOT_RETURNED:"
					if sessionVers.version < VersionTLS13 && resumeVers.version >= VersionTLS13 {
						// The server will "resume" the session by sending pre_shared_key,
						// but the shim will not have sent pre_shared_key at all. The shim
						// should reject this because the extension was not allowed at all.
						expectedError = ":UNEXPECTED_EXTENSION:"
					}

					testCases = append(testCases, testCase{
						protocol:      protocol,
						name:          "Resume-Client-Mismatch" + suffix,
						resumeSession: true,
						config: Config{
							MaxVersion: sessionVers.version,
						},
						expectations: connectionExpectations{
							version: sessionVers.version,
						},
						resumeConfig: &Config{
							MaxVersion: resumeVers.version,
							Bugs: ProtocolBugs{
								AcceptAnySession: true,
							},
						},
						resumeExpectations: &connectionExpectations{
							version: resumeVers.version,
						},
						shouldFail:    true,
						expectedError: expectedError,
					})
				}

				testCases = append(testCases, testCase{
					protocol:      protocol,
					name:          "Resume-Client-NoResume" + suffix,
					resumeSession: true,
					config: Config{
						MaxVersion: sessionVers.version,
					},
					expectations: connectionExpectations{
						version: sessionVers.version,
					},
					resumeConfig: &Config{
						MaxVersion: resumeVers.version,
					},
					newSessionsOnResume:  true,
					expectResumeRejected: true,
					resumeExpectations: &connectionExpectations{
						version: resumeVers.version,
					},
				})

				testCases = append(testCases, testCase{
					protocol:      protocol,
					testType:      serverTest,
					name:          "Resume-Server" + suffix,
					resumeSession: true,
					config: Config{
						MaxVersion: sessionVers.version,
					},
					expectations: connectionExpectations{
						version: sessionVers.version,
					},
					expectResumeRejected: sessionVers != resumeVers,
					resumeConfig: &Config{
						MaxVersion: resumeVers.version,
						Bugs: ProtocolBugs{
							SendBothTickets: true,
						},
					},
					resumeExpectations: &connectionExpectations{
						version: resumeVers.version,
					},
				})

				// Repeat the test using session IDs, rather than tickets.
				if sessionVers.version < VersionTLS13 && resumeVers.version < VersionTLS13 {
					testCases = append(testCases, testCase{
						protocol:      protocol,
						testType:      serverTest,
						name:          "Resume-Server-NoTickets" + suffix,
						resumeSession: true,
						config: Config{
							MaxVersion:             sessionVers.version,
							SessionTicketsDisabled: true,
						},
						expectations: connectionExpectations{
							version: sessionVers.version,
						},
						expectResumeRejected: sessionVers != resumeVers,
						resumeConfig: &Config{
							MaxVersion:             resumeVers.version,
							SessionTicketsDisabled: true,
						},
						resumeExpectations: &connectionExpectations{
							version: resumeVers.version,
						},
					})
				}
			}
		}
	}

	// Make sure shim ticket mutations are functional.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "ShimTicketRewritable",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				FilterTicket: func(in []byte) ([]byte, error) {
					in, err := SetShimTicketVersion(in, VersionTLS12)
					if err != nil {
						return nil, err
					}
					return SetShimTicketCipherSuite(in, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
	})

	// Resumptions are declined if the version does not match.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-DeclineCrossVersion",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				ExpectNewTicket: true,
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketVersion(in, VersionTLS13)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		expectResumeRejected: true,
	})

	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-DeclineCrossVersion-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketVersion(in, VersionTLS12)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		expectResumeRejected: true,
	})

	// Resumptions are declined if the cipher is invalid or disabled.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-DeclineBadCipher",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				ExpectNewTicket: true,
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketCipherSuite(in, TLS_AES_128_GCM_SHA256)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		expectResumeRejected: true,
	})

	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-DeclineBadCipher-2",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				ExpectNewTicket: true,
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketCipherSuite(in, TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384)
				},
			},
		},
		flags: []string{
			"-cipher", "AES128",
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		expectResumeRejected: true,
	})

	// Sessions are not resumed if they do not use the preferred cipher.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-CipherNotPreferred",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				ExpectNewTicket: true,
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketCipherSuite(in, TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		shouldFail:           false,
		expectResumeRejected: true,
	})

	// TLS 1.3 allows sessions to be resumed at a different cipher if their
	// PRF hashes match, but BoringSSL will always decline such resumptions.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-CipherNotPreferred-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				FilterTicket: func(in []byte) ([]byte, error) {
					// If the client (runner) offers ChaCha20-Poly1305 first, the
					// server (shim) always prefers it. Switch it to AES-GCM.
					return SetShimTicketCipherSuite(in, TLS_AES_128_GCM_SHA256)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		shouldFail:           false,
		expectResumeRejected: true,
	})

	// Sessions may not be resumed if they contain another version's cipher.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-DeclineBadCipher-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				FilterTicket: func(in []byte) ([]byte, error) {
					return SetShimTicketCipherSuite(in, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)
				},
			},
		},
		flags: []string{
			"-ticket-key",
			base64FlagValue(TestShimTicketKey),
		},
		expectResumeRejected: true,
	})

	// If the client does not offer the cipher from the session, decline to
	// resume. Clients are forbidden from doing this, but BoringSSL selects
	// the cipher first, so we only decline.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-UnofferedCipher",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				SendCipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			},
		},
		expectResumeRejected: true,
	})

	// In TLS 1.3, clients may advertise a cipher list which does not
	// include the selected cipher. Test that we tolerate this. Servers may
	// resume at another cipher if the PRF matches and are not doing 0-RTT, but
	// BoringSSL will always decline.
	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-UnofferedCipher-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				SendCipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
			},
		},
		expectResumeRejected: true,
	})

	// Sessions may not be resumed at a different cipher.
	testCases = append(testCases, testCase{
		name:          "Resume-Client-CipherMismatch",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				SendCipherSuite: TLS_RSA_WITH_AES_128_CBC_SHA,
			},
		},
		shouldFail:    true,
		expectedError: ":OLD_SESSION_CIPHER_NOT_RETURNED:",
	})

	// Session resumption in TLS 1.3 may change the cipher suite if the PRF
	// matches.
	testCases = append(testCases, testCase{
		name:          "Resume-Client-CipherMismatch-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256},
		},
	})

	// Session resumption in TLS 1.3 is forbidden if the PRF does not match.
	testCases = append(testCases, testCase{
		name:          "Resume-Client-PRFMismatch-TLS13",
		resumeSession: true,
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				SendCipherSuite: TLS_AES_256_GCM_SHA384,
			},
		},
		shouldFail:    true,
		expectedError: ":OLD_SESSION_PRF_HASH_MISMATCH:",
	})

	for _, secondBinder := range []bool{false, true} {
		var suffix string
		var defaultCurves []CurveID
		if secondBinder {
			suffix = "-SecondBinder"
			// Force a HelloRetryRequest by predicting an empty curve list.
			defaultCurves = []CurveID{}
		}

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-BinderWrongLength" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					SendShortPSKBinder:         true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: error decrypting message",
			expectedError:      ":DIGEST_CHECK_FAILED:",
		})

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-NoPSKBinder" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					SendNoPSKBinder:            true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: error decoding message",
			expectedError:      ":DECODE_ERROR:",
		})

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-ExtraPSKBinder" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					SendExtraPSKBinder:         true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: illegal parameter",
			expectedError:      ":PSK_IDENTITY_BINDER_COUNT_MISMATCH:",
		})

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-ExtraIdentityNoBinder" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					ExtraPSKIdentity:           true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: illegal parameter",
			expectedError:      ":PSK_IDENTITY_BINDER_COUNT_MISMATCH:",
		})

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-InvalidPSKBinder" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					SendInvalidPSKBinder:       true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: error decrypting message",
			expectedError:      ":DIGEST_CHECK_FAILED:",
		})

		testCases = append(testCases, testCase{
			testType:      serverTest,
			name:          "Resume-Server-PSKBinderFirstExtension" + suffix,
			resumeSession: true,
			config: Config{
				MaxVersion:    VersionTLS13,
				DefaultCurves: defaultCurves,
				Bugs: ProtocolBugs{
					PSKBinderFirst:             true,
					OnlyCorruptSecondPSKBinder: secondBinder,
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: illegal parameter",
			expectedError:      ":PRE_SHARED_KEY_MUST_BE_LAST:",
		})
	}

	testCases = append(testCases, testCase{
		testType:      serverTest,
		name:          "Resume-Server-OmitPSKsOnSecondClientHello",
		resumeSession: true,
		config: Config{
			MaxVersion:    VersionTLS13,
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				OmitPSKsOnSecondClientHello: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "remote error: illegal parameter",
		expectedError:      ":INCONSISTENT_CLIENT_HELLO:",
	})
}

func addSessionTicketTests() {
	testCases = append(testCases, testCase{
		// In TLS 1.2 and below, empty NewSessionTicket messages
		// mean the server changed its mind on sending a ticket.
		name: "SendEmptySessionTicket-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendEmptySessionTicket: true,
			},
		},
		flags: []string{"-expect-no-session"},
	})

	testCases = append(testCases, testCase{
		// In TLS 1.3, empty NewSessionTicket messages are not
		// allowed.
		name: "SendEmptySessionTicket-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendEmptySessionTicket: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: error decoding message",
	})

	// Test that the server ignores unknown PSK modes.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-SendUnknownModeSessionTicket-Server",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendPSKKeyExchangeModes: []byte{0x1a, pskDHEKEMode, 0x2a},
			},
		},
		resumeSession: true,
		expectations: connectionExpectations{
			version: VersionTLS13,
		},
	})

	// Test that the server does not send session tickets with no matching key exchange mode.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-ExpectNoSessionTicketOnBadKEMode-Server",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendPSKKeyExchangeModes:  []byte{0x1a},
				ExpectNoNewSessionTicket: true,
			},
		},
	})

	// Test that the server does not accept a session with no matching key exchange mode.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-SendBadKEModeSessionTicket-Server",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendPSKKeyExchangeModes: []byte{0x1a},
			},
		},
		resumeSession:        true,
		expectResumeRejected: true,
	})

	// Test that the server rejects ClientHellos with pre_shared_key but without
	// psk_key_exchange_modes.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-SendNoKEMModesWithPSK-Server",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendPSKKeyExchangeModes: []byte{},
			},
		},
		resumeSession:      true,
		shouldFail:         true,
		expectedLocalError: "remote error: missing extension",
		expectedError:      ":MISSING_EXTENSION:",
	})

	// Test that the client ticket age is sent correctly.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-TestValidTicketAge-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectTicketAge: 10 * time.Second,
			},
		},
		resumeSession: true,
		flags: []string{
			"-resumption-delay", "10",
		},
	})

	// Test that the client ticket age is enforced.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-TestBadTicketAge-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectTicketAge: 1000 * time.Second,
			},
		},
		resumeSession:      true,
		shouldFail:         true,
		expectedLocalError: "tls: invalid ticket age",
	})

	// Test that the server's ticket age skew reporting works.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Forward",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 15 * time.Second,
			},
		},
		resumeSession:        true,
		resumeRenewedSession: true,
		flags: []string{
			"-resumption-delay", "10",
			"-expect-ticket-age-skew", "5",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Backward",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 5 * time.Second,
			},
		},
		resumeSession:        true,
		resumeRenewedSession: true,
		flags: []string{
			"-resumption-delay", "10",
			"-expect-ticket-age-skew", "-5",
		},
	})

	// Test that ticket age skew up to 60 seconds in either direction is accepted.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Forward-60-Accept",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 70 * time.Second,
			},
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-resumption-delay", "10",
			"-expect-ticket-age-skew", "60",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Backward-60-Accept",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 10 * time.Second,
			},
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-resumption-delay", "70",
			"-expect-ticket-age-skew", "-60",
		},
	})

	// Test that ticket age skew beyond 60 seconds in either direction is rejected.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Forward-61-Reject",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 71 * time.Second,
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-resumption-delay", "10",
			"-expect-ticket-age-skew", "61",
			"-on-resume-expect-early-data-reason", "ticket_age_skew",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-TicketAgeSkew-Backward-61-Reject",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketAge: 10 * time.Second,
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-resumption-delay", "71",
			"-expect-ticket-age-skew", "-61",
			"-on-resume-expect-early-data-reason", "ticket_age_skew",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-SendTicketEarlyDataSupport",
		config: Config{
			MaxVersion:       VersionTLS13,
			MaxEarlyDataSize: 16384,
		},
		flags: []string{
			"-enable-early-data",
			"-expect-ticket-supports-early-data",
		},
	})

	// Test that 0-RTT tickets are still recorded as such when early data is disabled overall.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-SendTicketEarlyDataSupport-Disabled",
		config: Config{
			MaxVersion:       VersionTLS13,
			MaxEarlyDataSize: 16384,
		},
		flags: []string{
			"-expect-ticket-supports-early-data",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-DuplicateTicketEarlyDataSupport",
		config: Config{
			MaxVersion:       VersionTLS13,
			MaxEarlyDataSize: 16384,
			Bugs: ProtocolBugs{
				DuplicateTicketEarlyData: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":DUPLICATE_EXTENSION:",
		expectedLocalError: "remote error: illegal parameter",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-ExpectTicketEarlyDataSupport",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectTicketEarlyData: true,
			},
		},
		flags: []string{
			"-enable-early-data",
		},
	})

	// Test that, in TLS 1.3, the server-offered NewSessionTicket lifetime
	// is honored.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-HonorServerSessionTicketLifetime",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketLifetime: 20 * time.Second,
			},
		},
		flags: []string{
			"-resumption-delay", "19",
		},
		resumeSession: true,
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13-HonorServerSessionTicketLifetime-2",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendTicketLifetime: 20 * time.Second,
				// The client should not offer the expired session.
				ExpectNoTLS13PSK: true,
			},
		},
		flags: []string{
			"-resumption-delay", "21",
		},
		resumeSession:        true,
		expectResumeRejected: true,
	})

	for _, ver := range tlsVersions {
		// Prior to TLS 1.3, disabling session tickets enables session IDs.
		useStatefulResumption := ver.version < VersionTLS13

		// SSL_OP_NO_TICKET implies the server must not mint any tickets.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     ver.name + "-NoTicket-NoMint",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Bugs: ProtocolBugs{
					ExpectNoNewSessionTicket: true,
					RequireSessionIDs:        useStatefulResumption,
				},
			},
			resumeSession: useStatefulResumption,
			flags:         []string{"-no-ticket"},
		})

		// SSL_OP_NO_TICKET implies the server must not accept any tickets.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     ver.name + "-NoTicket-NoAccept",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
			},
			resumeSession:        true,
			expectResumeRejected: true,
			// Set SSL_OP_NO_TICKET on the second connection, after the first
			// has established tickets.
			flags: []string{"-on-resume-no-ticket"},
		})

		// SSL_OP_NO_TICKET implies the client must not offer ticket-based
		// sessions. The client not only should not send the session ticket
		// extension, but if the server echos the session ID, the client should
		// reject this.
		if ver.version < VersionTLS13 {
			testCases = append(testCases, testCase{
				name: ver.name + "-NoTicket-NoOffer",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
				},
				resumeConfig: &Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectNoTLS12TicketSupport: true,
						// Pretend to accept the session, even though the client
						// did not offer it. The client should reject this as
						// invalid. A buggy client will still fail because it
						// expects resumption, but with a different error.
						// Ideally, we would test this by actually resuming the
						// previous session, even though the client did not
						// provide a ticket.
						EchoSessionIDInFullHandshake: true,
					},
				},
				resumeSession:        true,
				expectResumeRejected: true,
				// Set SSL_OP_NO_TICKET on the second connection, after the first
				// has established tickets.
				flags:              []string{"-on-resume-no-ticket"},
				shouldFail:         true,
				expectedError:      ":SERVER_ECHOED_INVALID_SESSION_ID:",
				expectedLocalError: "remote error: illegal parameter",
			})
		}

		// Test ticket flags.
		if ver.version >= VersionTLS13 {
			// The client should parse and ignore unknown ticket flags. 2039
			// is the highest possible flag number (8*255 flags total).
			for i, flags := range [][]uint{{1}, {31}, {100}, {2039}, {1, 31, 100, 2039}} {
				testCases = append(testCases, testCase{
					name: fmt.Sprintf("%s-Client-UnknownTicketFlags-%d", ver.name, i),
					config: Config{
						MinVersion: ver.version,
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							SendTicketFlags: flags,
						},
					},
				})
				testCases = append(testCases, testCase{
					name: fmt.Sprintf("%s-Client-KnownAndUnknownTicketFlags-%d", ver.name, i),
					config: Config{
						MinVersion:            ver.version,
						MaxVersion:            ver.version,
						ResumptionAcrossNames: true,
						Bugs: ProtocolBugs{
							SendTicketFlags: flags,
						},
					},
					flags: []string{"-expect-resumable-across-names"},
				})
			}

			// The client should reject invalid ticket flag extensions.
			testCases = append(testCases, testCase{
				name: ver.name + "-Client-NonminimalTicketFlags",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						SendTicketFlags:   []uint{1},
						TicketFlagPadding: 1,
					},
				},
				shouldFail:         true,
				expectedError:      ":DECODE_ERROR:",
				expectedLocalError: "remote error: illegal parameter",
			})
			testCases = append(testCases, testCase{
				name: ver.name + "-Client-EmptyTicketFlags",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						AlwaysSendTicketFlags: true,
					},
				},
				shouldFail:         true,
				expectedError:      ":DECODE_ERROR:",
				expectedLocalError: "remote error: error decoding message",
			})

			// The client should parse the resumption_across_names flag.
			testCases = append(testCases, testCase{
				name: ver.name + "-Client-NoResumptionAcrossNames",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
				},
				flags: []string{"-expect-not-resumable-across-names"},
			})
			testCases = append(testCases, testCase{
				name: ver.name + "-Client-ResumptionAcrossNames",
				config: Config{
					MinVersion:            ver.version,
					MaxVersion:            ver.version,
					ResumptionAcrossNames: true,
				},
				flags: []string{"-expect-resumable-across-names"},
			})

			// The server should offer resumption_across_names as configured.
			testCases = append(testCases, testCase{
				testType: serverTest,
				name:     ver.name + "-Server-NoResumptionAcrossNames",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectResumptionAcrossNames: ptrTo(false),
					},
				},
			})
			testCases = append(testCases, testCase{
				testType: serverTest,
				name:     ver.name + "-Server-ResumptionAcrossNames",
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectResumptionAcrossNames: ptrTo(true),
					},
				},
				flags: []string{"-resumption-across-names-enabled"},
			})
		}
	}
}
