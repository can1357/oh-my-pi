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

// addEndOfFlightTests adds tests where the runner adds extra data in the final
// record of each handshake flight. Depending on the implementation strategy,
// this data may be carried over to the next flight (assuming no key change) or
// may be rejected. To avoid differences with split handshakes and generally
// reject misbehavior, BoringSSL treats this as an error. When possible, these
// tests pull the extra data from the subsequent flight to distinguish the data
// being carried over from a general syntax error.
//
// These tests are similar to tests in |addChangeCipherSpecTests| that send
// extra data at key changes. Not all key changes are at the end of a flight and
// not all flights end at a key change.
func addEndOfFlightTests() {
	// TLS 1.3 client handshakes.
	//
	// Data following the second TLS 1.3 ClientHello is covered by
	// PartialClientFinishedWithClientHello,
	// PartialClientFinishedWithSecondClientHello, and
	// PartialEndOfEarlyDataWithClientHello in |addChangeCipherSpecTests|.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PartialSecondClientHelloAfterFirst",
		config: Config{
			MaxVersion: VersionTLS13,
			// Trigger a curve-based HelloRetryRequest.
			DefaultCurves: []CurveID{},
			Bugs: ProtocolBugs{
				PartialSecondClientHelloAfterFirst: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	// TLS 1.3 server handshakes.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "PartialServerHelloWithHelloRetryRequest",
		config: Config{
			MaxVersion: VersionTLS13,
			// P-384 requires HelloRetryRequest in BoringSSL.
			CurvePreferences: []CurveID{CurveP384},
			Bugs: ProtocolBugs{
				PartialServerHelloWithHelloRetryRequest: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	// TLS 1.2 client handshakes.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "PartialClientKeyExchangeWithClientHello",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				PartialClientKeyExchangeWithClientHello: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	// TLS 1.2 server handshakes.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "PartialNewSessionTicketWithServerHelloDone",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				PartialNewSessionTicketWithServerHelloDone: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	for _, vers := range tlsVersions {
		for _, testType := range []testType{clientTest, serverTest} {
			suffix := "-Client"
			if testType == serverTest {
				suffix = "-Server"
			}
			suffix += "-" + vers.name

			testCases = append(testCases, testCase{
				testType: testType,
				name:     "TrailingDataWithFinished" + suffix,
				config: Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						TrailingDataWithFinished: true,
					},
				},
				shouldFail:         true,
				expectedError:      ":EXCESS_HANDSHAKE_DATA:",
				expectedLocalError: "remote error: unexpected message",
			})
			testCases = append(testCases, testCase{
				testType: testType,
				name:     "TrailingDataWithFinished-Resume" + suffix,
				config: Config{
					MaxVersion: vers.version,
				},
				resumeConfig: &Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						TrailingDataWithFinished: true,
					},
				},
				resumeSession:      true,
				shouldFail:         true,
				expectedError:      ":EXCESS_HANDSHAKE_DATA:",
				expectedLocalError: "remote error: unexpected message",
			})
		}
	}
}
