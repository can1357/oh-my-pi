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

func addTLS13RecordTests() {
	for _, protocol := range []protocol{tls, dtls} {
		testCases = append(testCases, testCase{
			protocol: protocol,
			name:     "TLS13-RecordPadding-" + protocol.String(),
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					RecordPadding: 10,
				},
			},
		})

		testCases = append(testCases, testCase{
			protocol: protocol,
			name:     "TLS13-EmptyRecords-" + protocol.String(),
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					OmitRecordContents: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
		})

		testCases = append(testCases, testCase{
			protocol: protocol,
			name:     "TLS13-OnlyPadding-" + protocol.String(),
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					OmitRecordContents: true,
					RecordPadding:      10,
				},
			},
			shouldFail:    true,
			expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
		})

		if protocol == tls {
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "TLS13-WrongOuterRecord-" + protocol.String(),
				config: Config{
					MaxVersion: VersionTLS13,
					MinVersion: VersionTLS13,
					Bugs: ProtocolBugs{
						OuterRecordType: recordTypeHandshake,
					},
				},
				shouldFail:    true,
				expectedError: ":INVALID_OUTER_RECORD_TYPE:",
			})
		}
	}
}

func addTLS13HandshakeTests() {
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "NegotiatePSKResumption-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NegotiatePSKResumption: true,
			},
		},
		resumeSession: true,
		shouldFail:    true,
		expectedError: ":MISSING_KEY_SHARE:",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "MissingKeyShare-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				MissingKeyShare: true,
			},
		},
		shouldFail:    true,
		expectedError: ":MISSING_KEY_SHARE:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "MissingKeyShare-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				MissingKeyShare: true,
			},
		},
		shouldFail:    true,
		expectedError: ":MISSING_KEY_SHARE:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "DuplicateKeyShares-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				DuplicateKeyShares: true,
			},
		},
		shouldFail:    true,
		expectedError: ":DUPLICATE_KEY_SHARE:",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveP256},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveP256)),
			"-key-shares", strconv.Itoa(int(CurveP256)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-DefaultSupportedGroups-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519},
			},
		},
		flags: []string{
			// Configure key shares without explicitly configuring supported groups.
			"-key-shares", strconv.Itoa(int(CurveX25519)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-Multiple-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519, CurveX25519MLKEM768},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveP256)),
			// Predict the top 2 out of 3 supported curves.
			"-key-shares", strconv.Itoa(int(CurveX25519)),
			"-key-shares", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			"-expect-no-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-MultipleNonContiguous-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519, CurveP256},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveP256)),
			// Predict the first and last of 3 supported curves.
			"-key-shares", strconv.Itoa(int(CurveX25519)),
			"-key-shares", strconv.Itoa(int(CurveP256)),
			"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			"-expect-no-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-NotMostPreferred-HRR-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519MLKEM768, CurveP256},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveP256)),
			// Predict some curves that we support, not including the top one.
			"-key-shares", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-key-shares", strconv.Itoa(int(CurveP256)),
			"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			// Check that we triggered a HelloRetryRequest.
			"-expect-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-PeerSelectedLaterKeyShare-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP256},
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519MLKEM768, CurveP256},
				// Make the server select one of the groups with a key_share, but not
				// the most preferred one.
				SendCurve: CurveP256,
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveP256)),
			"-key-shares", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-key-shares", strconv.Itoa(int(CurveP256)),
			"-expect-curve-id", strconv.Itoa(int(CurveP256)),
			"-expect-no-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-All-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{
					CurveP256,
					CurveP384,
					CurveP521,
					CurveX25519,
					CurveX25519Kyber768,
					CurveX25519MLKEM768,
					CurveMLKEM1024,
				},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveP256)),
			"-curves", strconv.Itoa(int(CurveP384)),
			"-curves", strconv.Itoa(int(CurveP521)),
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519Kyber768)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-key-shares", strconv.Itoa(int(CurveP256)),
			"-key-shares", strconv.Itoa(int(CurveP384)),
			"-key-shares", strconv.Itoa(int(CurveP521)),
			"-key-shares", strconv.Itoa(int(CurveX25519)),
			"-key-shares", strconv.Itoa(int(CurveX25519Kyber768)),
			"-key-shares", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-key-shares", strconv.Itoa(int(CurveMLKEM1024)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CustomKeyShares-Empty-HRR-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{},
			},
		},
		flags: []string{
			"-no-key-shares",
			"-expect-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519MLKEM768, CurveX25519},
			Bugs: ProtocolBugs{
				// The prediction is made based on the client's preference order.
				ExpectedKeyShares: []CurveID{CurveX25519},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveX25519)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-UnrecognizedGroupIgnored-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{bogusCurve, CurveX25519},
			Bugs: ProtocolBugs{
				ExpectedKeyShares: []CurveID{CurveX25519},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-server-supported-groups-hint", strconv.Itoa(int(bogusCurve)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveX25519)),
			"-expect-curve-id", strconv.Itoa(int(CurveX25519)),
			"-expect-no-hrr",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-OverridesExplicitKeyShare-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519MLKEM768, CurveMLKEM1024},
			Bugs: ProtocolBugs{
				// The group predicted from the server hint is used over explicitly
				// configured key shares.
				ExpectedKeyShares: []CurveID{CurveX25519MLKEM768},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-key-shares", strconv.Itoa(int(CurveMLKEM1024)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveMLKEM1024)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-OverridesExplicitEmptyKeyShare-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519MLKEM768, CurveMLKEM1024},
			Bugs: ProtocolBugs{
				// The group predicted from the server hint is used over explicitly
				// configured empty key shares.
				ExpectedKeyShares: []CurveID{CurveX25519MLKEM768},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-no-key-shares",
			"-server-supported-groups-hint", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveMLKEM1024)),
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-FallBackToExplicitKeyShare-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP256},
			Bugs: ProtocolBugs{
				// No group was predicted from the server hint, so the explicitly
				// configured key shares are used.
				ExpectedKeyShares: []CurveID{CurveX25519MLKEM768, CurveX25519},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-key-shares", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-key-shares", strconv.Itoa(int(CurveX25519)),
			"-server-supported-groups-hint", strconv.Itoa(int(CurveP256)),
		},
		shouldFail:    true,
		expectedError: ":HANDSHAKE_FAILURE_ON_CLIENT_HELLO:",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "KeyShareWithServerHint-FallBackToExplicitEmptyKeyShare-TLS13",
		config: Config{
			MinVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveP256},
			Bugs: ProtocolBugs{
				// No group was predicted from the server hint, so the explicitly
				// configured key shares are used (in this case, empty to request HRR).
				ExpectedKeyShares: []CurveID{},
			},
		},
		flags: []string{
			"-curves", strconv.Itoa(int(CurveMLKEM1024)),
			"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
			"-curves", strconv.Itoa(int(CurveX25519)),
			"-no-key-shares",
			"-server-supported-groups-hint", strconv.Itoa(int(CurveP256)),
			"-expect-hrr",
		},
		shouldFail:    true,
		expectedError: ":HANDSHAKE_FAILURE_ON_CLIENT_HELLO:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
			},
		},
	})

	// Test that enabling TLS 1.3 does not interfere with TLS 1.2 session ID
	// resumption.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ResumeTLS12SessionID-TLS13",
		config: Config{
			MaxVersion:             VersionTLS12,
			SessionTicketsDisabled: true,
		},
		flags:         []string{"-max-version", strconv.Itoa(VersionTLS13)},
		resumeSession: true,
	})

	// Test that the client correctly handles a TLS 1.3 ServerHello which echoes
	// a TLS 1.2 session ID.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS12SessionID-TLS13",
		config: Config{
			MaxVersion:             VersionTLS12,
			SessionTicketsDisabled: true,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession:        true,
		expectResumeRejected: true,
	})

	// Test that the server correctly echoes back session IDs of
	// various lengths. The first test additionally asserts that
	// BoringSSL always sends the ChangeCipherSpec messages for
	// compatibility mode, rather than negotiating it based on the
	// ClientHello.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EmptySessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendClientHelloSessionID: []byte{},
			},
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Server-ShortSessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendClientHelloSessionID: make([]byte, 16),
			},
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Server-FullSessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendClientHelloSessionID: make([]byte, 32),
			},
		},
	})

	// The server should reject ClientHellos whose session IDs are too long.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Server-TooLongSessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendClientHelloSessionID: make([]byte, 33),
			},
		},
		shouldFail:         true,
		expectedError:      ":CLIENTHELLO_PARSE_FAILED:",
		expectedLocalError: "remote error: error decoding message",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Server-TooLongSessionID-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendClientHelloSessionID: make([]byte, 33),
			},
		},
		shouldFail:         true,
		expectedError:      ":CLIENTHELLO_PARSE_FAILED:",
		expectedLocalError: "remote error: error decoding message",
	})

	// Test that the client correctly accepts or rejects short session IDs from
	// the server. Our tests use 32 bytes by default, so the boundary condition
	// is already covered.
	testCases = append(testCases, testCase{
		name: "Client-ShortSessionID",
		config: Config{
			MaxVersion:             VersionTLS12,
			SessionTicketsDisabled: true,
			Bugs: ProtocolBugs{
				NewSessionIDLength: 1,
			},
		},
		resumeSession: true,
	})
	testCases = append(testCases, testCase{
		name: "Client-TooLongSessionID",
		config: Config{
			MaxVersion:             VersionTLS12,
			SessionTicketsDisabled: true,
			Bugs: ProtocolBugs{
				NewSessionIDLength: 33,
			},
		},
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: error decoding message",
	})

	// Test that the client sends a fake session ID in TLS 1.3. We cover both
	// normal and resumption handshakes to capture interactions with the
	// session resumption path.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS13SessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectClientHelloSessionID: true,
			},
		},
		resumeSession: true,
	})

	// Test that the client omits the fake session ID when the max version is TLS 1.2 and below.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TLS12NoSessionID-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectNoSessionID: true,
			},
		},
		flags: []string{"-max-version", strconv.Itoa(VersionTLS12)},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-on-initial-expect-early-data-reason", "no_session_offered",
			"-on-resume-expect-early-data-reason", "accept",
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Reject-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AlwaysRejectEarlyData: true,
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-retry-expect-early-data-reason", "peer_declined",
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		messageCount:  2,
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-on-initial-expect-early-data-reason", "no_session_offered",
			"-on-resume-expect-early-data-reason", "accept",
		},
	})

	// The above tests the most recent ticket. Additionally test that 0-RTT
	// works on the first ticket issued by the server.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-FirstTicket-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				UseFirstSessionTicket: true,
			},
		},
		messageCount:  2,
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-on-resume-expect-early-data-reason", "accept",
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-OmitEarlyDataExtension-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
				OmitEarlyDataExtension:  true,
			},
		},
		shouldFail:    true,
		expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-OmitEarlyDataExtension-HelloRetryRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// Require a HelloRetryRequest for every curve.
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
				OmitEarlyDataExtension:  true,
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_RECORD:",
		expectedLocalError: "remote error: unexpected message",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-TooMuchData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 16384 + 1,
			},
		},
		shouldFail:    true,
		expectedError: ":TOO_MUCH_SKIPPED_EARLY_DATA:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-Interleaved-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
				InterleaveEarlyData:     true,
			},
		},
		shouldFail:    true,
		expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-EarlyDataInTLS12-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_RECORD:",
		flags:         []string{"-max-version", strconv.Itoa(VersionTLS12)},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-HRR-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
			},
			DefaultCurves: []CurveID{},
		},
		// Though the session is not resumed and we send HelloRetryRequest,
		// early data being disabled takes priority as the reject reason.
		flags: []string{"-expect-early-data-reason", "disabled"},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-HRR-Interleaved-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 4,
				InterleaveEarlyData:     true,
			},
			DefaultCurves: []CurveID{},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_RECORD:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-HRR-TooMuchData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendFakeEarlyDataLength: 16384 + 1,
			},
			DefaultCurves: []CurveID{},
		},
		shouldFail:    true,
		expectedError: ":TOO_MUCH_SKIPPED_EARLY_DATA:",
	})

	// Test that skipping early data looking for cleartext correctly
	// processes an alert record.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-HRR-FatalAlert-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendEarlyAlert:          true,
				SendFakeEarlyDataLength: 4,
			},
			DefaultCurves: []CurveID{},
		},
		shouldFail:    true,
		expectedError: ":SSLV3_ALERT_HANDSHAKE_FAILURE:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipEarlyData-SecondClientHelloEarlyData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendEarlyDataOnSecondClientHello: true,
			},
			DefaultCurves: []CurveID{},
		},
		shouldFail:         true,
		expectedLocalError: "remote error: bad record MAC",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EmptyEncryptedExtensions-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				EmptyEncryptedExtensions: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "remote error: error decoding message",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EncryptedExtensionsWithKeyShare-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				EncryptedExtensionsWithKeyShare: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "remote error: unsupported extension",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SendHelloRetryRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// Require a HelloRetryRequest for every curve.
			DefaultCurves:    []CurveID{},
			CurvePreferences: []CurveID{CurveX25519},
		},
		expectations: connectionExpectations{
			curveID: CurveX25519,
		},
		flags: []string{"-expect-hrr"},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SendHelloRetryRequest-2-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			DefaultCurves:    []CurveID{CurveP384},
			CurvePreferences: []CurveID{CurveX25519, CurveP384},
		},
		// Although the ClientHello did not predict our preferred curve,
		// we always select it whether it is predicted or not.
		expectations: connectionExpectations{
			curveID: CurveX25519,
		},
		flags: []string{"-expect-hrr"},
	})

	testCases = append(testCases, testCase{
		name: "UnknownCurve-HelloRetryRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCurve: bogusCurve,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-CipherChange-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendCipherSuite:                  TLS_AES_128_GCM_SHA256,
				SendHelloRetryRequestCipherSuite: TLS_CHACHA20_POLY1305_SHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CIPHER_RETURNED:",
	})

	// Test that the client does not offer a PSK in the second ClientHello if the
	// HelloRetryRequest is incompatible with it.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "HelloRetryRequest-NonResumableCipher-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			CipherSuites: []uint16{
				TLS_AES_128_GCM_SHA256,
			},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				ExpectNoTLS13PSKAfterHRR: true,
			},
			CipherSuites: []uint16{
				TLS_AES_256_GCM_SHA384,
			},
		},
		resumeSession:        true,
		expectResumeRejected: true,
	})

	testCases = append(testCases, testCase{
		name: "DisabledCurve-HelloRetryRequest-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
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
		name: "UnnecessaryHelloRetryRequest-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			CurvePreferences: []CurveID{CurveX25519},
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCurve: CurveX25519,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		name: "SecondHelloRetryRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SecondHelloRetryRequest: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-Empty-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AlwaysSendHelloRetryRequest: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":EMPTY_HELLO_RETRY_REQUEST:",
		expectedLocalError: "remote error: illegal parameter",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-DuplicateCurve-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires a HelloRetryRequest against BoringSSL's default
			// configuration. Assert this ExpectMissingKeyShare.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				ExpectMissingKeyShare:                true,
				DuplicateHelloRetryRequestExtensions: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":DUPLICATE_EXTENSION:",
		expectedLocalError: "remote error: illegal parameter",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-Cookie-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte("cookie"),
			},
		},
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-DuplicateCookie-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie:          []byte("cookie"),
				DuplicateHelloRetryRequestExtensions: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":DUPLICATE_EXTENSION:",
		expectedLocalError: "remote error: illegal parameter",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-EmptyCookie-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte{},
			},
		},
		shouldFail:    true,
		expectedError: ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-Cookie-Curve-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte("cookie"),
				ExpectMissingKeyShare:       true,
			},
		},
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequest-Unknown-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				CustomHelloRetryRequestExtension: "extension",
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SecondClientHelloMissingKeyShare-TLS13",
		config: Config{
			MaxVersion:    VersionTLS13,
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				SecondClientHelloMissingKeyShare: true,
			},
		},
		shouldFail:    true,
		expectedError: ":MISSING_KEY_SHARE:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SecondClientHelloWrongCurve-TLS13",
		config: Config{
			MaxVersion:    VersionTLS13,
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				MisinterpretHelloRetryRequestCurve: CurveP521,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequestVersionMismatch-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendServerHelloVersion: 0x0305,
			},
		},
		shouldFail:    true,
		expectedError: ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		name: "HelloRetryRequestCurveMismatch-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				// Send P-384 (correct) in the HelloRetryRequest.
				SendHelloRetryRequestCurve: CurveP384,
				// But send P-256 in the ServerHello.
				SendCurve: CurveP256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	// Test the server selecting a curve that requires a HelloRetryRequest
	// without sending it.
	testCases = append(testCases, testCase{
		name: "SkipHelloRetryRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SkipHelloRetryRequest: true,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CURVE:",
	})

	testCases = append(testCases, testCase{
		name: "SecondServerHelloNoVersion-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				OmitServerSupportedVersionExtension: true,
			},
		},
		shouldFail:    true,
		expectedError: ":SECOND_SERVERHELLO_VERSION_MISMATCH:",
	})
	testCases = append(testCases, testCase{
		name: "SecondServerHelloWrongVersion-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				SendServerSupportedVersionExtension: 0x1234,
			},
		},
		shouldFail:    true,
		expectedError: ":SECOND_SERVERHELLO_VERSION_MISMATCH:",
	})

	testCases = append(testCases, testCase{
		name: "RequestContextInHandshake-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				SendRequestContext: []byte("request context"),
			},
		},
		shimCertificate: &rsaCertificate,
		shouldFail:      true,
		expectedError:   ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		name: "UnknownExtensionInCertificateRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				SendCustomCertificateRequest: 0x1212,
			},
		},
		shimCertificate: &rsaCertificate,
	})

	testCases = append(testCases, testCase{
		name: "MissingSignatureAlgorithmsInCertificateRequest-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				OmitCertificateRequestAlgorithms: true,
			},
		},
		shimCertificate: &rsaCertificate,
		shouldFail:      true,
		expectedError:   ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TrailingKeyShareData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				TrailingKeyShareData: true,
			},
		},
		shouldFail:    true,
		expectedError: ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		name: "AlwaysSelectPSKIdentity-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AlwaysSelectPSKIdentity: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	testCases = append(testCases, testCase{
		name: "InvalidPSKIdentity-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SelectPSKIdentityOnResume: 1,
			},
		},
		resumeSession: true,
		shouldFail:    true,
		expectedError: ":PSK_IDENTITY_NOT_FOUND:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ExtraPSKIdentity-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExtraPSKIdentity:   true,
				SendExtraPSKBinder: true,
			},
		},
		resumeSession: true,
	})

	// Test that unknown NewSessionTicket extensions are tolerated.
	testCases = append(testCases, testCase{
		name: "CustomTicketExtension-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				CustomTicketExtension: "1234",
			},
		},
	})

	// Test the client handles 0-RTT being rejected by a full handshake
	// and correctly reports a certificate change.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-RejectTicket-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &rsaCertificate,
		},
		resumeConfig: &Config{
			MaxVersion:             VersionTLS13,
			Credential:             &ecdsaP256Certificate,
			SessionTicketsDisabled: true,
		},
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-retry-expect-early-data-reason", "session_not_resumed",
			// Test the peer certificate is reported correctly in each of the
			// three logical connections.
			"-on-initial-expect-peer-cert-file", rsaCertificate.ChainPath,
			"-on-resume-expect-peer-cert-file", rsaCertificate.ChainPath,
			"-on-retry-expect-peer-cert-file", ecdsaP256Certificate.ChainPath,
			// Session tickets are disabled, so the runner will not send a ticket.
			"-on-retry-expect-no-session",
		},
	})

	// Test the server rejects 0-RTT if it does not recognize the ticket.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-RejectTicket-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Corrupt the ticket.
				FilterTicket: func(in []byte) ([]byte, error) {
					in[len(in)-1] ^= 1
					return in, nil
				},
			},
		},
		messageCount:            2,
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-resume-expect-early-data-reason", "session_not_resumed",
		},
	})

	// Test the client handles 0-RTT being rejected via a HelloRetryRequest.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-HRR-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte{1, 2, 3, 4},
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-retry-expect-early-data-reason", "hello_retry_request",
		},
	})

	// Test the server rejects 0-RTT if it needs to send a HelloRetryRequest.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-HRR-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			// Require a HelloRetryRequest for every curve.
			DefaultCurves: []CurveID{},
		},
		messageCount:            2,
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-resume-expect-early-data-reason", "hello_retry_request",
		},
	})

	// Test the client handles a 0-RTT reject from both ticket rejection and
	// HelloRetryRequest.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-HRR-RejectTicket-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &rsaCertificate,
		},
		resumeConfig: &Config{
			MaxVersion:             VersionTLS13,
			Credential:             &ecdsaP256Certificate,
			SessionTicketsDisabled: true,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte{1, 2, 3, 4},
			},
		},
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			// The client sees HelloRetryRequest before the resumption result,
			// though neither value is inherently preferable.
			"-on-retry-expect-early-data-reason", "hello_retry_request",
			// Test the peer certificate is reported correctly in each of the
			// three logical connections.
			"-on-initial-expect-peer-cert-file", rsaCertificate.ChainPath,
			"-on-resume-expect-peer-cert-file", rsaCertificate.ChainPath,
			"-on-retry-expect-peer-cert-file", ecdsaP256Certificate.ChainPath,
			// Session tickets are disabled, so the runner will not send a ticket.
			"-on-retry-expect-no-session",
		},
	})

	// Test the server rejects 0-RTT if it needs to send a HelloRetryRequest.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-HRR-RejectTicket-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
			// Require a HelloRetryRequest for every curve.
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				// Corrupt the ticket.
				FilterTicket: func(in []byte) ([]byte, error) {
					in[len(in)-1] ^= 1
					return in, nil
				},
			},
		},
		messageCount:            2,
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			// The server sees the missed resumption before HelloRetryRequest,
			// though neither value is inherently preferable.
			"-on-resume-expect-early-data-reason", "session_not_resumed",
		},
	})

	// The client must check the server does not send the early_data
	// extension while rejecting the session.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataWithoutResume-Client-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			MaxEarlyDataSize: 16384,
		},
		resumeConfig: &Config{
			MaxVersion:             VersionTLS13,
			SessionTicketsDisabled: true,
			Bugs: ProtocolBugs{
				SendEarlyDataExtension: true,
			},
		},
		resumeSession: true,
		earlyData:     true,
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	// The client must fail with a dedicated error code if the server
	// responds with TLS 1.2 when offering 0-RTT.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataVersionDowngrade-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS12,
		},
		resumeSession: true,
		earlyData:     true,
		shouldFail:    true,
		expectedError: ":WRONG_VERSION_ON_EARLY_DATA:",
	})

	// Same as above, but the server also sends a warning alert before the
	// ServerHello. Although the shim predicts TLS 1.3 for 0-RTT, it should
	// still interpret data before ServerHello in a TLS-1.2-compatible way.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataVersionDowngrade-Client-TLS13-WarningAlert",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendSNIWarningAlert: true,
			},
		},
		resumeSession: true,
		earlyData:     true,
		shouldFail:    true,
		expectedError: ":WRONG_VERSION_ON_EARLY_DATA:",
	})

	// Test that the client rejects an (unsolicited) early_data extension if
	// the server sent an HRR.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ServerAcceptsEarlyDataOnHRR-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte{1, 2, 3, 4},
				SendEarlyDataExtension:      true,
			},
		},
		resumeSession: true,
		earlyData:     true,
		// The client will first process an early data reject from the HRR.
		expectEarlyDataRejected: true,
		shouldFail:              true,
		expectedError:           ":UNEXPECTED_EXTENSION:",
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "SkipChangeCipherSpec-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SkipChangeCipherSpec: true,
			},
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SkipChangeCipherSpec-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SkipChangeCipherSpec: true,
			},
		},
	})

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "TooManyChangeCipherSpec-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendExtraChangeCipherSpec: 33,
			},
		},
		shouldFail:    true,
		expectedError: ":TOO_MANY_EMPTY_FRAGMENTS:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TooManyChangeCipherSpec-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendExtraChangeCipherSpec: 33,
			},
		},
		shouldFail:    true,
		expectedError: ":TOO_MANY_EMPTY_FRAGMENTS:",
	})

	testCases = append(testCases, testCase{
		name: "SendPostHandshakeChangeCipherSpec-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendPostHandshakeChangeCipherSpec: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_RECORD:",
		expectedLocalError: "remote error: unexpected message",
	})

	fooString := "foo"
	barString := "bar"

	// Test that the client reports the correct ALPN after a 0-RTT reject
	// that changed it.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-ALPNMismatch-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ALPNProtocol: &fooString,
			},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ALPNProtocol: &barString,
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar",
			// The client does not learn ALPN was the cause.
			"-on-retry-expect-early-data-reason", "peer_declined",
			// In the 0-RTT state, we surface the predicted ALPN. After
			// processing the reject, we surface the real one.
			"-on-initial-expect-alpn", "foo",
			"-on-resume-expect-alpn", "foo",
			"-on-retry-expect-alpn", "bar",
		},
	})

	// Test that the client reports the correct ALPN after a 0-RTT reject if
	// ALPN was omitted from the first connection.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-ALPNOmitted1-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar",
			// The client does not learn ALPN was the cause.
			"-on-retry-expect-early-data-reason", "peer_declined",
			// In the 0-RTT state, we surface the predicted ALPN. After
			// processing the reject, we surface the real one.
			"-on-initial-expect-alpn", "",
			"-on-resume-expect-alpn", "",
			"-on-retry-expect-alpn", "foo",
		},
	})

	// Test that the client reports the correct ALPN after a 0-RTT reject if
	// ALPN was omitted from the second connection.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-ALPNOmitted2-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar",
			// The client does not learn ALPN was the cause.
			"-on-retry-expect-early-data-reason", "peer_declined",
			// In the 0-RTT state, we surface the predicted ALPN. After
			// processing the reject, we surface the real one.
			"-on-initial-expect-alpn", "foo",
			"-on-resume-expect-alpn", "foo",
			"-on-retry-expect-alpn", "",
		},
	})

	// Test that the client enforces ALPN match on 0-RTT accept.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-BadALPNMismatch-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ALPNProtocol: &fooString,
			},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AlwaysAcceptEarlyData: true,
				ALPNProtocol:          &barString,
			},
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar",
			"-on-initial-expect-alpn", "foo",
			"-on-resume-expect-alpn", "foo",
			"-on-retry-expect-alpn", "bar",
		},
		shouldFail:         true,
		expectedError:      ":ALPN_MISMATCH_ON_EARLY_DATA:",
		expectedLocalError: "remote error: illegal parameter",
	})

	// Test that the client does not offer early data if it is incompatible
	// with ALPN preferences.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-ALPNPreferenceChanged-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			MaxEarlyDataSize: 16384,
			NextProtos:       []string{"foo", "bar"},
		},
		resumeSession: true,
		flags: []string{
			"-enable-early-data",
			"-expect-ticket-supports-early-data",
			"-expect-no-offer-early-data",
			// Offer different ALPN values in the initial and resumption.
			"-on-initial-advertise-alpn", "\x03foo",
			"-on-initial-expect-alpn", "foo",
			"-on-resume-advertise-alpn", "\x03bar",
			"-on-resume-expect-alpn", "bar",
			// The ALPN mismatch comes from the client, so it reports it as the
			// reason.
			"-on-resume-expect-early-data-reason", "alpn_mismatch",
		},
	})

	// Test that the client does not offer 0-RTT to servers which never
	// advertise it.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-NonZeroRTTSession-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession: true,
		flags: []string{
			"-enable-early-data",
			"-on-resume-expect-no-offer-early-data",
			// The client declines to offer 0-RTT because of the session.
			"-on-resume-expect-early-data-reason", "unsupported_for_session",
		},
	})

	// Test that the server correctly rejects 0-RTT when the previous
	// session did not allow early data on resumption.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-NonZeroRTTSession-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendEarlyData:           [][]byte{{1, 2, 3, 4}},
				ExpectEarlyDataAccepted: false,
			},
		},
		resumeSession: true,
		// This test configures early data manually instead of the earlyData
		// option, to customize the -enable-early-data flag.
		flags: []string{
			"-on-resume-enable-early-data",
			"-expect-reject-early-data",
			// The server rejects 0-RTT because of the session.
			"-on-resume-expect-early-data-reason", "unsupported_for_session",
		},
	})

	// Test that we reject early data where ALPN is omitted from the first
	// connection, but negotiated in the second.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-ALPNOmitted1-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-initial-select-alpn", "",
			"-on-resume-select-alpn", "foo",
			"-on-resume-expect-early-data-reason", "alpn_mismatch",
		},
	})

	// Test that we reject early data where ALPN is omitted from the second
	// connection, but negotiated in the first.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-ALPNOmitted2-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-initial-select-alpn", "foo",
			"-on-resume-select-alpn", "",
			"-on-resume-expect-early-data-reason", "alpn_mismatch",
		},
	})

	// Test that we reject early data with mismatched ALPN.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-ALPNMismatch-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"bar"},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-initial-select-alpn", "foo",
			"-on-resume-select-alpn", "bar",
			"-on-resume-expect-early-data-reason", "alpn_mismatch",
		},
	})

	// Test that the client offering 0-RTT and Channel ID forbids the server
	// from accepting both.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataChannelID-AcceptBoth-Client-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			RequestChannelID: true,
		},
		resumeSession: true,
		earlyData:     true,
		expectations: connectionExpectations{
			channelID: true,
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION_ON_EARLY_DATA:",
		expectedLocalError: "remote error: illegal parameter",
		flags: []string{
			"-send-channel-id", channelIDKeyPath,
		},
	})

	// Test that the client offering Channel ID and 0-RTT allows the server
	// to decline 0-RTT.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataChannelID-AcceptChannelID-Client-TLS13",
		config: Config{
			MaxVersion:       VersionTLS13,
			RequestChannelID: true,
			Bugs: ProtocolBugs{
				AlwaysRejectEarlyData: true,
			},
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		expectations: connectionExpectations{
			channelID: true,
		},
		flags: []string{
			"-send-channel-id", channelIDKeyPath,
			// The client never learns the reason was Channel ID.
			"-on-retry-expect-early-data-reason", "peer_declined",
		},
	})

	// Test that the client offering Channel ID and 0-RTT allows the server
	// to decline Channel ID.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataChannelID-AcceptEarlyData-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-send-channel-id", channelIDKeyPath,
		},
	})

	// Test that the server supporting Channel ID and 0-RTT declines 0-RTT
	// if it would negotiate Channel ID.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyDataChannelID-OfferBoth-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ChannelID:  &channelIDKey,
		},
		resumeSession:           true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		expectations: connectionExpectations{
			channelID: true,
		},
		flags: []string{
			"-expect-channel-id",
			base64FlagValue(channelIDBytes),
			"-on-resume-expect-early-data-reason", "channel_id",
		},
	})

	// Test that the server supporting Channel ID and 0-RTT accepts 0-RTT
	// if not offered Channel ID.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyDataChannelID-OfferEarlyData-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession: true,
		earlyData:     true,
		expectations: connectionExpectations{
			channelID: false,
		},
		flags: []string{
			"-enable-channel-id",
			"-on-resume-expect-early-data-reason", "accept",
		},
	})

	// Test that the server errors on 0-RTT streams without EndOfEarlyData.
	// The subsequent records should fail to decrypt.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-SkipEndOfEarlyData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SkipEndOfEarlyData: true,
			},
		},
		resumeSession:      true,
		earlyData:          true,
		shouldFail:         true,
		expectedLocalError: "remote error: bad record MAC",
		expectedError:      ":BAD_DECRYPT:",
	})

	// Test that EndOfEarlyData is rejected in QUIC. Since we leave application
	// data to the QUIC implementation, we never accept any data at all in
	// the 0-RTT epoch, so the error is that the encryption level is rejected
	// outright.
	//
	// TODO(crbug.com/381113363): Test this for DTLS 1.3 as well.
	testCases = append(testCases, testCase{
		protocol: quic,
		testType: serverTest,
		name:     "EarlyData-UnexpectedEndOfEarlyData-QUIC",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendEndOfEarlyDataInQUICAndDTLS: true,
			},
		},
		resumeSession: true,
		earlyData:     true,
		shouldFail:    true,
		expectedError: ":WRONG_ENCRYPTION_LEVEL_RECEIVED:",
	})

	// Test that the server errors on 0-RTT streams with a stray handshake
	// message in them.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-UnexpectedHandshake-Server-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendStrayEarlyHandshake: true,
			},
		},
		resumeSession:      true,
		earlyData:          true,
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})

	// Test that the client reports TLS 1.3 as the version while sending
	// early data.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Client-VersionAPI-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-expect-version", strconv.Itoa(VersionTLS13),
			// EMS and RI are always reported as supported when we report
			// TLS 1.3.
			"-expect-extended-master-secret",
			"-expect-secure-renegotiation",
		},
	})

	// Test that client and server both notice handshake errors after data
	// has started flowing.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Client-BadFinished-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				BadFinished: true,
			},
		},
		resumeSession:      true,
		earlyData:          true,
		shouldFail:         true,
		expectedError:      ":DIGEST_CHECK_FAILED:",
		expectedLocalError: "remote error: error decrypting message",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyData-Server-BadFinished-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				BadFinished: true,
			},
		},
		resumeSession:      true,
		earlyData:          true,
		shouldFail:         true,
		expectedError:      ":DIGEST_CHECK_FAILED:",
		expectedLocalError: "remote error: error decrypting message",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Server-NonEmptyEndOfEarlyData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NonEmptyEndOfEarlyData: true,
			},
		},
		resumeSession: true,
		earlyData:     true,
		shouldFail:    true,
		expectedError: ":DECODE_ERROR:",
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerSkipCertificateVerify-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			Credential: &rsaChainCertificate,
			Bugs: ProtocolBugs{
				SkipCertificateVerify: true,
			},
		},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
		shimCertificate: &rsaCertificate,
		flags: []string{
			"-require-any-client-certificate",
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ClientSkipCertificateVerify-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			Credential: &rsaChainCertificate,
			Bugs: ProtocolBugs{
				SkipCertificateVerify: true,
			},
		},
		expectations: connectionExpectations{
			peerCertificate: &rsaCertificate,
		},
		shimCertificate:    &rsaCertificate,
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})

	// PSK/resumption handshakes should not accept CertificateRequest or
	// Certificate messages.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CertificateInResumption-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AlwaysSendCertificate: true,
			},
		},
		resumeSession:      true,
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "CertificateRequestInResumption-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				AlwaysSendCertificateRequest: true,
			},
		},
		shimCertificate:    &rsaCertificate,
		resumeSession:      true,
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})

	// If the client or server has 0-RTT enabled but disabled TLS 1.3, it should
	// report a reason of protocol_version.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyDataEnabled-Client-MaxTLS12",
		expectations: connectionExpectations{
			version: VersionTLS12,
		},
		flags: []string{
			"-enable-early-data",
			"-max-version", strconv.Itoa(VersionTLS12),
			"-expect-early-data-reason", "protocol_version",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyDataEnabled-Server-MaxTLS12",
		expectations: connectionExpectations{
			version: VersionTLS12,
		},
		flags: []string{
			"-enable-early-data",
			"-max-version", strconv.Itoa(VersionTLS12),
			"-expect-early-data-reason", "protocol_version",
		},
	})

	// The server additionally reports protocol_version if it enabled TLS 1.3,
	// but the peer negotiated TLS 1.2. (The corresponding situation does not
	// exist on the client because negotiating TLS 1.2 with a 0-RTT ClientHello
	// is a fatal error.)
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "EarlyDataEnabled-Server-NegotiateTLS12",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		expectations: connectionExpectations{
			version: VersionTLS12,
		},
		flags: []string{
			"-enable-early-data",
			"-expect-early-data-reason", "protocol_version",
		},
	})

	// On 0-RTT reject, the server may end up negotiating a cipher suite with a
	// different PRF hash. Test that the client handles this correctly.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Reject0RTT-DifferentPRF-Client",
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_256_GCM_SHA384},
		},
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-initial-expect-cipher", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			// The client initially reports the old cipher suite while sending
			// early data. After processing the 0-RTT reject, it reports the
			// true cipher suite.
			"-on-resume-expect-cipher", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			"-on-retry-expect-cipher", strconv.Itoa(int(TLS_AES_256_GCM_SHA384)),
		},
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-Reject0RTT-DifferentPRF-HRR-Client",
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_256_GCM_SHA384},
			// P-384 requires a HelloRetryRequest against BoringSSL's default
			// configuration. Assert this with ExpectMissingKeyShare.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				ExpectMissingKeyShare: true,
			},
		},
		resumeSession:           true,
		expectResumeRejected:    true,
		earlyData:               true,
		expectEarlyDataRejected: true,
		flags: []string{
			"-on-initial-expect-cipher", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			// The client initially reports the old cipher suite while sending
			// early data. After processing the 0-RTT reject, it reports the
			// true cipher suite.
			"-on-resume-expect-cipher", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			"-on-retry-expect-cipher", strconv.Itoa(int(TLS_AES_256_GCM_SHA384)),
		},
	})

	// Test that the client enforces cipher suite match on 0-RTT accept.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-CipherMismatch-Client-TLS13",
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_AES_128_GCM_SHA256},
		},
		resumeConfig: &Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256},
			Bugs: ProtocolBugs{
				AlwaysAcceptEarlyData: true,
			},
		},
		resumeSession:      true,
		earlyData:          true,
		shouldFail:         true,
		expectedError:      ":CIPHER_MISMATCH_ON_EARLY_DATA:",
		expectedLocalError: "remote error: illegal parameter",
	})

	// Test that the client can write early data when it has received a partial
	// ServerHello..Finished flight. See https://crbug.com/1208784. Note the
	// EncryptedExtensions test assumes EncryptedExtensions and Finished are in
	// separate records, i.e. that PackHandshakeFlight is disabled.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-WriteAfterServerHello",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Write the server response before expecting early data.
				ExpectEarlyData:     [][]byte{},
				ExpectLateEarlyData: [][]byte{[]byte(shimInitialWrite)},
			},
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-async",
			"-on-resume-early-write-after-message",
			strconv.Itoa(int(typeServerHello)),
		},
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "EarlyData-WriteAfterEncryptedExtensions",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Write the server response before expecting early data.
				ExpectEarlyData:     [][]byte{},
				ExpectLateEarlyData: [][]byte{[]byte(shimInitialWrite)},
			},
		},
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-async",
			"-on-resume-early-write-after-message",
			strconv.Itoa(int(typeEncryptedExtensions)),
		},
	})
}

func addTLS13CipherPreferenceTests() {
	// Test that client preference is honored if the shim has AES hardware
	// and ChaCha20-Poly1305 is preferred otherwise.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-CipherPreference-Server-ChaCha20-AES",
		config: Config{
			MaxVersion: VersionTLS13,
			CipherSuites: []uint16{
				TLS_CHACHA20_POLY1305_SHA256,
				TLS_AES_128_GCM_SHA256,
			},
			CurvePreferences: []CurveID{CurveX25519},
		},
		flags: []string{
			"-expect-cipher-aes", strconv.Itoa(int(TLS_CHACHA20_POLY1305_SHA256)),
			"-expect-cipher-no-aes", strconv.Itoa(int(TLS_CHACHA20_POLY1305_SHA256)),
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-CipherPreference-Server-AES-ChaCha20",
		config: Config{
			MaxVersion: VersionTLS13,
			CipherSuites: []uint16{
				TLS_AES_128_GCM_SHA256,
				TLS_CHACHA20_POLY1305_SHA256,
			},
			CurvePreferences: []CurveID{CurveX25519},
		},
		flags: []string{
			"-expect-cipher-aes", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			"-expect-cipher-no-aes", strconv.Itoa(int(TLS_CHACHA20_POLY1305_SHA256)),
		},
	})

	// Test that the client orders ChaCha20-Poly1305 and AES-GCM based on
	// whether it has AES hardware.
	testCases = append(testCases, testCase{
		name: "TLS13-CipherPreference-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			// Use the client cipher order. (This is the default but
			// is listed to be explicit.)
			PreferServerCipherSuites: false,
		},
		flags: []string{
			"-expect-cipher-aes", strconv.Itoa(int(TLS_AES_128_GCM_SHA256)),
			"-expect-cipher-no-aes", strconv.Itoa(int(TLS_CHACHA20_POLY1305_SHA256)),
		},
	})
}
