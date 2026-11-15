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

func addExtraHandshakeTests() {
	// An extra SSL_do_handshake is normally a no-op. These tests use -async
	// to ensure there is no transport I/O.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ExtraHandshake-Client-TLS12",
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
		},
		flags: []string{
			"-async",
			"-no-op-extra-handshake",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ExtraHandshake-Server-TLS12",
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
		},
		flags: []string{
			"-async",
			"-no-op-extra-handshake",
		},
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ExtraHandshake-Client-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
		},
		flags: []string{
			"-async",
			"-no-op-extra-handshake",
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ExtraHandshake-Server-TLS13",
		config: Config{
			MinVersion: VersionTLS13,
			MaxVersion: VersionTLS13,
		},
		flags: []string{
			"-async",
			"-no-op-extra-handshake",
		},
	})

	// An extra SSL_do_handshake is a no-op in server 0-RTT.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ExtraHandshake-Server-EarlyData-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		messageCount:  2,
		resumeSession: true,
		earlyData:     true,
		flags: []string{
			"-async",
			"-no-op-extra-handshake",
		},
	})

	// An extra SSL_do_handshake drives the handshake to completion in False
	// Start. We test this by handshaking twice and asserting the False
	// Start does not appear to happen. See AlertBeforeFalseStartTest for
	// how the test works.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ExtraHandshake-FalseStart",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			NextProtos:   []string{"foo"},
			Bugs: ProtocolBugs{
				ExpectFalseStart:          true,
				AlertBeforeFalseStartTest: alertAccessDenied,
			},
		},
		flags: []string{
			"-handshake-twice",
			"-false-start",
			"-advertise-alpn", "\x03foo",
			"-expect-alpn", "foo",
		},
		shimWritesFirst:    true,
		shouldFail:         true,
		expectedError:      ":TLSV1_ALERT_ACCESS_DENIED:",
		expectedLocalError: "tls: peer did not false start: EOF",
	})
}
