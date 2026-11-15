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

import "fmt"

func addExportKeyingMaterialTests() {
	for _, protocol := range []protocol{tls, dtls, quic} {
		for _, vers := range allVersions(protocol) {
			suffix := fmt.Sprintf("%s-%s", protocol, vers)
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "ExportKeyingMaterial-" + suffix,
				config: Config{
					MaxVersion: vers.version,
				},
				// Test the exporter in both initial and resumption
				// handshakes.
				resumeSession:        true,
				exportKeyingMaterial: 1024,
				exportLabel:          "label",
				exportContext:        "context",
				useExportContext:     true,
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "ExportKeyingMaterial-NoContext-" + suffix,
				config: Config{
					MaxVersion: vers.version,
				},
				exportKeyingMaterial: 1024,
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "ExportKeyingMaterial-EmptyContext-" + suffix,
				config: Config{
					MaxVersion: vers.version,
				},
				exportKeyingMaterial: 1024,
				useExportContext:     true,
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "ExportKeyingMaterial-Small-" + suffix,
				config: Config{
					MaxVersion: vers.version,
				},
				exportKeyingMaterial: 1,
				exportLabel:          "label",
				exportContext:        "context",
				useExportContext:     true,
			})

			// TODO(crbug.com/381113363): Support 0-RTT in DTLS 1.3.
			if vers.version >= VersionTLS13 && protocol != dtls {
				// Test the exporters do not work while the client is
				// sending 0-RTT data.
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "NoEarlyKeyingMaterial-Client-InEarlyData-" + suffix,
					config: Config{
						MaxVersion: vers.version,
					},
					resumeSession: true,
					earlyData:     true,
					flags: []string{
						"-on-resume-export-keying-material", "1024",
						"-on-resume-export-label", "label",
						"-on-resume-export-context", "context",
					},
					shouldFail:    true,
					expectedError: ":HANDSHAKE_NOT_COMPLETE:",
				})

				// Test the normal exporter on the server in half-RTT.
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "ExportKeyingMaterial-Server-HalfRTT-" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							// The shim writes exported data immediately after
							// the handshake returns, so disable the built-in
							// early data test.
							SendEarlyData:     [][]byte{},
							ExpectHalfRTTData: [][]byte{},
						},
					},
					resumeSession:        true,
					earlyData:            true,
					exportKeyingMaterial: 1024,
					exportLabel:          "label",
					exportContext:        "context",
					useExportContext:     true,
				})
			}
		}
	}

	// Exporters work during a False Start.
	testCases = append(testCases, testCase{
		name: "ExportKeyingMaterial-FalseStart",
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
		shimWritesFirst:      true,
		exportKeyingMaterial: 1024,
		exportLabel:          "label",
		exportContext:        "context",
		useExportContext:     true,
	})

	// Exporters do not work in the middle of a renegotiation. Test this by
	// triggering the exporter after every SSL_read call and configuring the
	// shim to run asynchronously.
	testCases = append(testCases, testCase{
		name: "ExportKeyingMaterial-Renegotiate",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		renegotiate: 1,
		flags: []string{
			"-async",
			"-use-exporter-between-reads",
			"-renegotiate-freely",
			"-expect-total-renegotiations", "1",
		},
		shouldFail:    true,
		expectedError: "failed to export keying material",
	})
}

func addExportTrafficSecretsTests() {
	for _, cipherSuite := range []testCipherSuite{
		// Test a SHA-256 and SHA-384 based cipher suite.
		{"AEAD-AES128-GCM-SHA256", TLS_AES_128_GCM_SHA256},
		{"AEAD-AES256-GCM-SHA384", TLS_AES_256_GCM_SHA384},
	} {
		testCases = append(testCases, testCase{
			name: "ExportTrafficSecrets-" + cipherSuite.name,
			config: Config{
				MinVersion:   VersionTLS13,
				CipherSuites: []uint16{cipherSuite.id},
			},
			exportTrafficSecrets: true,
		})
	}
}

func addTLSUniqueTests() {
	for _, isClient := range []bool{false, true} {
		for _, isResumption := range []bool{false, true} {
			for _, hasEMS := range []bool{false, true} {
				var suffix string
				if isResumption {
					suffix = "Resume-"
				} else {
					suffix = "Full-"
				}

				if hasEMS {
					suffix += "EMS-"
				} else {
					suffix += "NoEMS-"
				}

				if isClient {
					suffix += "Client"
				} else {
					suffix += "Server"
				}

				test := testCase{
					name:          "TLSUnique-" + suffix,
					testTLSUnique: true,
					config: Config{
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							NoExtendedMasterSecret: !hasEMS,
						},
					},
				}

				if isResumption {
					test.resumeSession = true
					test.resumeConfig = &Config{
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							NoExtendedMasterSecret: !hasEMS,
						},
					}
				}

				if isResumption && !hasEMS {
					test.shouldFail = true
					test.expectedError = "failed to get tls-unique"
				}

				testCases = append(testCases, test)
			}
		}
	}
}
