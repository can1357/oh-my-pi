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

func addCBCPaddingTests() {
	testCases = append(testCases, testCase{
		name: "MaxCBCPadding",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
			Bugs: ProtocolBugs{
				MaxPadding: true,
			},
		},
		messageLen: 12, // 20 bytes of SHA-1 + 12 == 0 % block size
	})
	testCases = append(testCases, testCase{
		name: "BadCBCPadding",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
			Bugs: ProtocolBugs{
				PaddingFirstByteBad: true,
			},
		},
		shouldFail:    true,
		expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
	})
	// OpenSSL previously had an issue where the first byte of padding in
	// 255 bytes of padding wasn't checked.
	testCases = append(testCases, testCase{
		name: "BadCBCPadding255",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
			Bugs: ProtocolBugs{
				MaxPadding:               true,
				PaddingFirstByteBadIf255: true,
			},
		},
		messageLen:    12, // 20 bytes of SHA-1 + 12 == 0 % block size
		shouldFail:    true,
		expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
	})
}

func addCBCSplittingTests() {
	cbcCiphers := []struct {
		name   string
		cipher uint16
	}{
		{"3DES", TLS_RSA_WITH_3DES_EDE_CBC_SHA},
		{"AES128", TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
		{"AES256", TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA},
	}
	for _, t := range cbcCiphers {
		testCases = append(testCases, testCase{
			name: "CBCRecordSplitting-" + t.name,
			config: Config{
				MaxVersion:   VersionTLS10,
				MinVersion:   VersionTLS10,
				CipherSuites: []uint16{t.cipher},
				Bugs: ProtocolBugs{
					ExpectRecordSplitting: true,
				},
			},
			messageLen:    -1, // read until EOF
			resumeSession: true,
			flags: []string{
				"-async",
				"-write-different-record-sizes",
				"-cbc-record-splitting",
				// BoringSSL disables 3DES by default.
				"-cipher", "ALL:3DES",
			},
		})
		testCases = append(testCases, testCase{
			name: "CBCRecordSplittingPartialWrite-" + t.name,
			config: Config{
				MaxVersion:   VersionTLS10,
				MinVersion:   VersionTLS10,
				CipherSuites: []uint16{t.cipher},
				Bugs: ProtocolBugs{
					ExpectRecordSplitting: true,
				},
			},
			messageLen: -1, // read until EOF
			flags: []string{
				"-async",
				"-write-different-record-sizes",
				"-cbc-record-splitting",
				"-partial-write",
				// BoringSSL disables 3DES by default.
				"-cipher", "ALL:3DES",
			},
		})
	}
}
