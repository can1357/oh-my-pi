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
)

func addExtensionTests() {
	exampleCertificate := rootCA.Issue(X509Info{
		PrivateKey: &ecdsaP256Key,
		DNSNames:   []string{"example.com"},
	}).ToCredential()

	// Repeat extensions tests at all versions.
	for _, protocol := range []protocol{tls, dtls, quic} {
		for _, ver := range allVersions(protocol) {
			suffix := fmt.Sprintf("%s-%s", protocol.String(), ver.name)

			// Test that duplicate extensions are rejected.
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "DuplicateExtensionClient-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						DuplicateExtension: true,
					},
				},
				shouldFail:         true,
				expectedLocalError: "remote error: error decoding message",
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "DuplicateExtensionServer-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						DuplicateExtension: true,
					},
				},
				shouldFail:         true,
				expectedLocalError: "remote error: error decoding message",
			})

			// Test SNI.
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "ServerNameExtensionClient-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectServerName: "example.com",
					},
					Credential: &exampleCertificate,
				},
				flags: []string{"-host-name", "example.com"},
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "ServerNameExtensionClientMismatch-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectServerName: "mismatch.com",
					},
				},
				flags:              []string{"-host-name", "example.com"},
				shouldFail:         true,
				expectedLocalError: "tls: unexpected server name",
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "ServerNameExtensionClientMissing-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						ExpectServerName: "missing.com",
					},
				},
				shouldFail:         true,
				expectedLocalError: "tls: unexpected server name",
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "TolerateServerNameAck-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						SendServerNameAck: true,
					},
					Credential: &exampleCertificate,
				},
				flags:         []string{"-host-name", "example.com"},
				resumeSession: true,
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "UnsolicitedServerNameAck-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						SendServerNameAck: true,
					},
				},
				shouldFail:         true,
				expectedError:      ":UNEXPECTED_EXTENSION:",
				expectedLocalError: "remote error: unsupported extension",
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "ServerNameExtensionServer-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					ServerName: "example.com",
				},
				flags:         []string{"-expect-server-name", "example.com"},
				resumeSession: true,
				expectations: connectionExpectations{
					serverNameAck: ptrTo(true),
				},
			})
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "ServerNameExtensionServer-NoACK-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					ServerName: "example.com",
				},
				flags: []string{
					"-expect-server-name", "example.com",
					"-no-server-name-ack",
				},
				resumeSession: true,
				expectations: connectionExpectations{
					serverNameAck: ptrTo(false),
				},
			})

			// Test ALPN.
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           clientTest,
				skipQUICALPNConfig: true,
				name:               "ALPNClient-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo"},
				},
				flags: []string{
					"-advertise-alpn", "\x03foo\x03bar\x03baz",
					"-expect-alpn", "foo",
				},
				expectations: connectionExpectations{
					nextProto:     "foo",
					nextProtoType: alpn,
				},
				resumeSession: true,
			})
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           clientTest,
				skipQUICALPNConfig: true,
				name:               "ALPNClient-RejectUnknown-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						SendALPN: "baz",
					},
				},
				flags: []string{
					"-advertise-alpn", "\x03foo\x03bar",
				},
				shouldFail:         true,
				expectedError:      ":INVALID_ALPN_PROTOCOL:",
				expectedLocalError: "remote error: illegal parameter",
			})
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           clientTest,
				skipQUICALPNConfig: true,
				name:               "ALPNClient-AllowUnknown-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						SendALPN: "baz",
					},
				},
				flags: []string{
					"-advertise-alpn", "\x03foo\x03bar",
					"-allow-unknown-alpn-protos",
					"-expect-alpn", "baz",
				},
			})
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo", "bar", "baz"},
				},
				flags: []string{
					"-expect-advertised-alpn", "\x03foo\x03bar\x03baz",
					"-select-alpn", "foo",
				},
				expectations: connectionExpectations{
					nextProto:     "foo",
					nextProtoType: alpn,
				},
				resumeSession: true,
			})

			var shouldDeclineALPNFail bool
			var declineALPNError, declineALPNLocalError string
			if protocol == quic {
				// ALPN is mandatory in QUIC.
				shouldDeclineALPNFail = true
				declineALPNError = ":NO_APPLICATION_PROTOCOL:"
				declineALPNLocalError = "remote error: no application protocol"
			}
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-Decline-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo", "bar", "baz"},
				},
				flags: []string{"-decline-alpn"},
				expectations: connectionExpectations{
					noNextProto: true,
				},
				resumeSession:      true,
				shouldFail:         shouldDeclineALPNFail,
				expectedError:      declineALPNError,
				expectedLocalError: declineALPNLocalError,
			})

			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-Reject-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo", "bar", "baz"},
				},
				flags:              []string{"-reject-alpn"},
				shouldFail:         true,
				expectedError:      ":NO_APPLICATION_PROTOCOL:",
				expectedLocalError: "remote error: no application protocol",
			})

			// Test that the server implementation catches itself if the
			// callback tries to return an invalid empty ALPN protocol.
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-SelectEmpty-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo", "bar", "baz"},
				},
				flags: []string{
					"-expect-advertised-alpn", "\x03foo\x03bar\x03baz",
					"-select-empty-alpn",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: internal error",
				expectedError:      ":INVALID_ALPN_PROTOCOL:",
			})

			// Test ALPN in async mode as well to ensure that extensions callbacks are only
			// called once.
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-Async-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{"foo", "bar", "baz"},
					// Prior to TLS 1.3, exercise the asynchronous session callback.
					SessionTicketsDisabled: ver.version < VersionTLS13,
				},
				flags: []string{
					"-expect-advertised-alpn", "\x03foo\x03bar\x03baz",
					"-select-alpn", "foo",
					"-async",
				},
				expectations: connectionExpectations{
					nextProto:     "foo",
					nextProtoType: alpn,
				},
				resumeSession: true,
			})

			var emptyString string
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           clientTest,
				skipQUICALPNConfig: true,
				name:               "ALPNClient-EmptyProtocolName-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					NextProtos: []string{""},
					Bugs: ProtocolBugs{
						// A server returning an empty ALPN protocol
						// should be rejected.
						ALPNProtocol: &emptyString,
					},
				},
				flags: []string{
					"-advertise-alpn", "\x03foo",
				},
				shouldFail:    true,
				expectedError: ":PARSE_TLSEXT:",
			})
			testCases = append(testCases, testCase{
				protocol:           protocol,
				testType:           serverTest,
				skipQUICALPNConfig: true,
				name:               "ALPNServer-EmptyProtocolName-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					// A ClientHello containing an empty ALPN protocol
					// should be rejected.
					NextProtos: []string{"foo", "", "baz"},
				},
				flags: []string{
					"-select-alpn", "foo",
				},
				shouldFail:    true,
				expectedError: ":PARSE_TLSEXT:",
			})

			// Test NPN and the interaction with ALPN.
			if ver.version < VersionTLS13 && protocol == tls {
				// Test that the server prefers ALPN over NPN.
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "ALPNServer-Preferred-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						NextProtos: []string{"foo", "bar", "baz"},
					},
					flags: []string{
						"-expect-advertised-alpn", "\x03foo\x03bar\x03baz",
						"-select-alpn", "foo",
						"-advertise-npn", "\x03foo\x03bar\x03baz",
					},
					expectations: connectionExpectations{
						nextProto:     "foo",
						nextProtoType: alpn,
					},
					resumeSession: true,
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "ALPNServer-Preferred-Swapped-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						NextProtos: []string{"foo", "bar", "baz"},
						Bugs: ProtocolBugs{
							SwapNPNAndALPN: true,
						},
					},
					flags: []string{
						"-expect-advertised-alpn", "\x03foo\x03bar\x03baz",
						"-select-alpn", "foo",
						"-advertise-npn", "\x03foo\x03bar\x03baz",
					},
					expectations: connectionExpectations{
						nextProto:     "foo",
						nextProtoType: alpn,
					},
					resumeSession: true,
				})

				// Test that negotiating both NPN and ALPN is forbidden.
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "NegotiateALPNAndNPN-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						NextProtos: []string{"foo", "bar", "baz"},
						Bugs: ProtocolBugs{
							NegotiateALPNAndNPN: true,
						},
					},
					flags: []string{
						"-advertise-alpn", "\x03foo",
						"-select-next-proto", "foo",
					},
					shouldFail:    true,
					expectedError: ":NEGOTIATED_BOTH_NPN_AND_ALPN:",
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "NegotiateALPNAndNPN-Swapped-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						NextProtos: []string{"foo", "bar", "baz"},
						Bugs: ProtocolBugs{
							NegotiateALPNAndNPN: true,
							SwapNPNAndALPN:      true,
						},
					},
					flags: []string{
						"-advertise-alpn", "\x03foo",
						"-select-next-proto", "foo",
					},
					shouldFail:    true,
					expectedError: ":NEGOTIATED_BOTH_NPN_AND_ALPN:",
				})
			}

			// Test missing ALPN in QUIC
			if protocol == quic {
				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     "Client-ALPNMissingFromConfig-" + suffix,
					config: Config{
						MinVersion: ver.version,
						MaxVersion: ver.version,
					},
					skipQUICALPNConfig: true,
					shouldFail:         true,
					expectedError:      ":NO_APPLICATION_PROTOCOL:",
				})
				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     "Client-ALPNMissing-" + suffix,
					config: Config{
						MinVersion: ver.version,
						MaxVersion: ver.version,
					},
					flags: []string{
						"-advertise-alpn", "\x03foo",
					},
					skipQUICALPNConfig: true,
					shouldFail:         true,
					expectedError:      ":NO_APPLICATION_PROTOCOL:",
					expectedLocalError: "remote error: no application protocol",
				})
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "Server-ALPNMissing-" + suffix,
					config: Config{
						MinVersion: ver.version,
						MaxVersion: ver.version,
					},
					skipQUICALPNConfig: true,
					shouldFail:         true,
					expectedError:      ":NO_APPLICATION_PROTOCOL:",
					expectedLocalError: "remote error: no application protocol",
				})
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "Server-ALPNMismatch-" + suffix,
					config: Config{
						MinVersion: ver.version,
						MaxVersion: ver.version,
						NextProtos: []string{"foo"},
					},
					flags: []string{
						"-decline-alpn",
					},
					skipQUICALPNConfig: true,
					shouldFail:         true,
					expectedError:      ":NO_APPLICATION_PROTOCOL:",
					expectedLocalError: "remote error: no application protocol",
				})
			}

			// Test ALPS.
			if ver.version >= VersionTLS13 {
				// Test basic client with different ALPS codepoint.
				for _, alpsCodePoint := range []ALPSUseCodepoint{ALPSUseCodepointNew, ALPSUseCodepointOld} {
					useAlpsCodepointFlag := "0"
					if alpsCodePoint == ALPSUseCodepointNew {
						useAlpsCodepointFlag = "1"
					}

					flags := []string{"-alps-use-new-codepoint", useAlpsCodepointFlag}
					expectations := connectionExpectations{
						peerApplicationSettingsOld: []byte("shim1"),
					}
					resumeExpectations := &connectionExpectations{
						peerApplicationSettingsOld: []byte("shim2"),
					}

					if alpsCodePoint == ALPSUseCodepointNew {
						expectations = connectionExpectations{
							peerApplicationSettings: []byte("shim1"),
						}
						resumeExpectations = &connectionExpectations{
							peerApplicationSettings: []byte("shim2"),
						}
					}

					flags = append(flags,
						"-advertise-alpn", "\x05proto",
						"-expect-alpn", "proto",
						"-on-initial-application-settings", "proto,shim1",
						"-on-initial-expect-peer-application-settings", "runner1",
						"-on-resume-application-settings", "proto,shim2",
						"-on-resume-expect-peer-application-settings", "runner2")

					// Test that server can negotiate ALPS, including different values
					// on resumption.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           clientTest,
						name:               fmt.Sprintf("ALPS-Basic-Client-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner1")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeConfig: &Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner2")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession:      true,
						expectations:       expectations,
						resumeExpectations: resumeExpectations,
						flags:              flags,
					})

					// Test basic server with different ALPS codepoint.
					flags = []string{"-alps-use-new-codepoint", useAlpsCodepointFlag}
					expectations = connectionExpectations{
						peerApplicationSettingsOld: []byte("shim1"),
					}
					resumeExpectations = &connectionExpectations{
						peerApplicationSettingsOld: []byte("shim2"),
					}

					if alpsCodePoint == ALPSUseCodepointNew {
						expectations = connectionExpectations{
							peerApplicationSettings: []byte("shim1"),
						}
						resumeExpectations = &connectionExpectations{
							peerApplicationSettings: []byte("shim2"),
						}
					}

					flags = append(flags,
						"-select-alpn", "proto",
						"-on-initial-application-settings", "proto,shim1",
						"-on-initial-expect-peer-application-settings", "runner1",
						"-on-resume-application-settings", "proto,shim2",
						"-on-resume-expect-peer-application-settings", "runner2")

					// Test that server can negotiate ALPS, including different values
					// on resumption.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-Basic-Server-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner1")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeConfig: &Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner2")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession:      true,
						expectations:       expectations,
						resumeExpectations: resumeExpectations,
						flags:              flags,
					})

					// Try different ALPS codepoint for all the existing tests.
					alpsFlags := []string{"-alps-use-new-codepoint", useAlpsCodepointFlag}
					expectations = connectionExpectations{
						peerApplicationSettingsOld: []byte("shim1"),
					}
					resumeExpectations = &connectionExpectations{
						peerApplicationSettingsOld: []byte("shim2"),
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						expectations = connectionExpectations{
							peerApplicationSettings: []byte("shim1"),
						}
						resumeExpectations = &connectionExpectations{
							peerApplicationSettings: []byte("shim2"),
						}
					}

					// Test that the server can defer its ALPS configuration to the ALPN
					// selection callback.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-Basic-Server-Defer-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner1")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeConfig: &Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner2")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession:      true,
						expectations:       expectations,
						resumeExpectations: resumeExpectations,
						flags: append([]string{
							"-select-alpn", "proto",
							"-defer-alps",
							"-on-initial-application-settings", "proto,shim1",
							"-on-initial-expect-peer-application-settings", "runner1",
							"-on-resume-application-settings", "proto,shim2",
							"-on-resume-expect-peer-application-settings", "runner2",
						}, alpsFlags...),
					})

					expectations = connectionExpectations{
						peerApplicationSettingsOld: []byte{},
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						expectations = connectionExpectations{
							peerApplicationSettings: []byte{},
						}
					}
					// Test the client and server correctly handle empty settings.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           clientTest,
						name:               fmt.Sprintf("ALPS-Empty-Client-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": {}},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession: true,
						expectations:  expectations,
						flags: append([]string{
							"-advertise-alpn", "\x05proto",
							"-expect-alpn", "proto",
							"-application-settings", "proto,",
							"-expect-peer-application-settings", "",
						}, alpsFlags...),
					})
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-Empty-Server-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": {}},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession: true,
						expectations:  expectations,
						flags: append([]string{
							"-select-alpn", "proto",
							"-application-settings", "proto,",
							"-expect-peer-application-settings", "",
						}, alpsFlags...),
					})

					bugs := ProtocolBugs{
						AlwaysNegotiateApplicationSettingsOld: true,
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						bugs = ProtocolBugs{
							AlwaysNegotiateApplicationSettingsNew: true,
						}
					}
					// Test the client rejects application settings from the server on
					// protocols it doesn't have them.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           clientTest,
						name:               fmt.Sprintf("ALPS-UnsupportedProtocol-Client-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto1"},
							ApplicationSettings: map[string][]byte{"proto1": []byte("runner")},
							Bugs:                bugs,
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						// The client supports ALPS with "proto2", but not "proto1".
						flags: append([]string{
							"-advertise-alpn", "\x06proto1\x06proto2",
							"-application-settings", "proto2,shim",
							"-expect-alpn", "proto1",
						}, alpsFlags...),
						// The server sends ALPS with "proto1", which is invalid.
						shouldFail:         true,
						expectedError:      ":INVALID_ALPN_PROTOCOL:",
						expectedLocalError: "remote error: illegal parameter",
					})

					// Test client rejects application settings from the server when
					// server sends the wrong ALPS codepoint.
					bugs = ProtocolBugs{
						AlwaysNegotiateApplicationSettingsOld: true,
					}
					if alpsCodePoint == ALPSUseCodepointOld {
						bugs = ProtocolBugs{
							AlwaysNegotiateApplicationSettingsNew: true,
						}
					}

					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           clientTest,
						name:               fmt.Sprintf("ALPS-WrongServerCodepoint-Client-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": {}},
							Bugs:                bugs,
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags: append([]string{
							"-advertise-alpn", "\x05proto",
							"-expect-alpn", "proto",
							"-application-settings", "proto,",
							"-expect-peer-application-settings", "",
						}, alpsFlags...),
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_EXTENSION:",
						expectedLocalError: "remote error: unsupported extension",
					})

					// Test server ignore wrong codepoint from client.
					clientSends := ALPSUseCodepointNew
					if alpsCodePoint == ALPSUseCodepointNew {
						clientSends = ALPSUseCodepointOld
					}

					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-IgnoreClientWrongCodepoint-Server-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner1")},
							ALPSUseNewCodepoint: clientSends,
						},
						resumeConfig: &Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner2")},
							ALPSUseNewCodepoint: clientSends,
						},
						resumeSession: true,
						flags: append([]string{
							"-select-alpn", "proto",
							"-on-initial-application-settings", "proto,shim1",
							"-on-resume-application-settings", "proto,shim2",
						}, alpsFlags...),
					})

					// Test the server declines ALPS if it doesn't support it for the
					// specified protocol.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-UnsupportedProtocol-Server-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto1"},
							ApplicationSettings: map[string][]byte{"proto1": []byte("runner")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						// The server supports ALPS with "proto2", but not "proto1".
						flags: append([]string{
							"-select-alpn", "proto1",
							"-application-settings", "proto2,shim",
						}, alpsFlags...),
					})

					// Test the client rejects application settings from the server when
					// it always negotiate both codepoint.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           clientTest,
						name:               fmt.Sprintf("ALPS-UnsupportedProtocol-Client-ServerBoth-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto1"},
							ApplicationSettings: map[string][]byte{"proto1": []byte("runner")},
							Bugs: ProtocolBugs{
								AlwaysNegotiateApplicationSettingsBoth: true,
							},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags: append([]string{
							"-advertise-alpn", "\x06proto1\x06proto2",
							"-application-settings", "proto1,shim",
							"-expect-alpn", "proto1",
						}, alpsFlags...),
						// The server sends ALPS with both application settings, which is invalid.
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_EXTENSION:",
						expectedLocalError: "remote error: unsupported extension",
					})

					expectations = connectionExpectations{
						peerApplicationSettingsOld: []byte("shim"),
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						expectations = connectionExpectations{
							peerApplicationSettings: []byte("shim"),
						}
					}

					// Test that the server rejects a missing application_settings extension.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-OmitClientApplicationSettings-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner")},
							Bugs: ProtocolBugs{
								OmitClientApplicationSettings: true,
							},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags: append([]string{
							"-select-alpn", "proto",
							"-application-settings", "proto,shim",
						}, alpsFlags...),
						// The runner is a client, so it only processes the shim's alert
						// after checking connection state.
						expectations:       expectations,
						shouldFail:         true,
						expectedError:      ":MISSING_EXTENSION:",
						expectedLocalError: "remote error: missing extension",
					})

					// Test that the server rejects a missing EncryptedExtensions message.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ALPS-OmitClientEncryptedExtensions-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner")},
							Bugs: ProtocolBugs{
								OmitClientEncryptedExtensions: true,
							},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags: append([]string{
							"-select-alpn", "proto",
							"-application-settings", "proto,shim",
						}, alpsFlags...),
						// The runner is a client, so it only processes the shim's alert
						// after checking connection state.
						expectations:       expectations,
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_MESSAGE:",
						expectedLocalError: "remote error: unexpected message",
					})

					// Test that the server rejects an unexpected EncryptedExtensions message.
					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: serverTest,
						name:     fmt.Sprintf("UnexpectedClientEncryptedExtensions-%s-%s", alpsCodePoint, suffix),
						config: Config{
							MaxVersion: ver.version,
							Bugs: ProtocolBugs{
								AlwaysSendClientEncryptedExtensions: true,
							},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_MESSAGE:",
						expectedLocalError: "remote error: unexpected message",
					})

					// Test that the server rejects an unexpected extension in an
					// expected EncryptedExtensions message.
					testCases = append(testCases, testCase{
						protocol:           protocol,
						testType:           serverTest,
						name:               fmt.Sprintf("ExtraClientEncryptedExtension-%s-%s", alpsCodePoint, suffix),
						skipQUICALPNConfig: true,
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"proto"},
							ApplicationSettings: map[string][]byte{"proto": []byte("runner")},
							Bugs: ProtocolBugs{
								SendExtraClientEncryptedExtension: true,
							},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags: append([]string{
							"-select-alpn", "proto",
							"-application-settings", "proto,shim",
						}, alpsFlags...),
						// The runner is a client, so it only processes the shim's alert
						// after checking connection state.
						expectations:       expectations,
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_EXTENSION:",
						expectedLocalError: "remote error: unsupported extension",
					})

					// Test that ALPS is carried over on 0-RTT.
					// TODO(crbug.com/381113363): Support 0-RTT in DTLS 1.3.
					if protocol != dtls {
						for _, empty := range []bool{false, true} {
							maybeEmpty := ""
							runnerSettings := "runner"
							shimSettings := "shim"
							if empty {
								maybeEmpty = "Empty-"
								runnerSettings = ""
								shimSettings = ""
							}

							expectations = connectionExpectations{
								peerApplicationSettingsOld: []byte(shimSettings),
							}
							if alpsCodePoint == ALPSUseCodepointNew {
								expectations = connectionExpectations{
									peerApplicationSettings: []byte(shimSettings),
								}
							}
							testCases = append(testCases, testCase{
								protocol:           protocol,
								testType:           clientTest,
								name:               fmt.Sprintf("ALPS-EarlyData-Client-%s-%s-%s", alpsCodePoint, maybeEmpty, suffix),
								skipQUICALPNConfig: true,
								config: Config{
									MaxVersion:          ver.version,
									NextProtos:          []string{"proto"},
									ApplicationSettings: map[string][]byte{"proto": []byte(runnerSettings)},
									ALPSUseNewCodepoint: alpsCodePoint,
								},
								resumeSession: true,
								earlyData:     true,
								flags: append([]string{
									"-advertise-alpn", "\x05proto",
									"-expect-alpn", "proto",
									"-application-settings", "proto," + shimSettings,
									"-expect-peer-application-settings", runnerSettings,
								}, alpsFlags...),
								expectations: expectations,
							})
							testCases = append(testCases, testCase{
								protocol:           protocol,
								testType:           serverTest,
								name:               fmt.Sprintf("ALPS-EarlyData-Server-%s-%s-%s", alpsCodePoint, maybeEmpty, suffix),
								skipQUICALPNConfig: true,
								config: Config{
									MaxVersion:          ver.version,
									NextProtos:          []string{"proto"},
									ApplicationSettings: map[string][]byte{"proto": []byte(runnerSettings)},
									ALPSUseNewCodepoint: alpsCodePoint,
								},
								resumeSession: true,
								earlyData:     true,
								flags: append([]string{
									"-select-alpn", "proto",
									"-application-settings", "proto," + shimSettings,
									"-expect-peer-application-settings", runnerSettings,
								}, alpsFlags...),
								expectations: expectations,
							})

							// Sending application settings in 0-RTT handshakes is forbidden.
							testCases = append(testCases, testCase{
								protocol:           protocol,
								testType:           clientTest,
								name:               fmt.Sprintf("ALPS-EarlyData-SendApplicationSettingsWithEarlyData-Client-%s-%s-%s", alpsCodePoint, maybeEmpty, suffix),
								skipQUICALPNConfig: true,
								config: Config{
									MaxVersion:          ver.version,
									NextProtos:          []string{"proto"},
									ApplicationSettings: map[string][]byte{"proto": []byte(runnerSettings)},
									Bugs: ProtocolBugs{
										SendApplicationSettingsWithEarlyData: true,
									},
									ALPSUseNewCodepoint: alpsCodePoint,
								},
								resumeSession: true,
								earlyData:     true,
								flags: append([]string{
									"-advertise-alpn", "\x05proto",
									"-expect-alpn", "proto",
									"-application-settings", "proto," + shimSettings,
									"-expect-peer-application-settings", runnerSettings,
								}, alpsFlags...),
								expectations:       expectations,
								shouldFail:         true,
								expectedError:      ":UNEXPECTED_EXTENSION_ON_EARLY_DATA:",
								expectedLocalError: "remote error: illegal parameter",
							})
							testCases = append(testCases, testCase{
								protocol:           protocol,
								testType:           serverTest,
								name:               fmt.Sprintf("ALPS-EarlyData-SendApplicationSettingsWithEarlyData-Server-%s-%s-%s", alpsCodePoint, maybeEmpty, suffix),
								skipQUICALPNConfig: true,
								config: Config{
									MaxVersion:          ver.version,
									NextProtos:          []string{"proto"},
									ApplicationSettings: map[string][]byte{"proto": []byte(runnerSettings)},
									Bugs: ProtocolBugs{
										SendApplicationSettingsWithEarlyData: true,
									},
									ALPSUseNewCodepoint: alpsCodePoint,
								},
								resumeSession: true,
								earlyData:     true,
								flags: append([]string{
									"-select-alpn", "proto",
									"-application-settings", "proto," + shimSettings,
									"-expect-peer-application-settings", runnerSettings,
								}, alpsFlags...),
								expectations:       expectations,
								shouldFail:         true,
								expectedError:      ":UNEXPECTED_MESSAGE:",
								expectedLocalError: "remote error: unexpected message",
							})
						}

						// Test that the client and server each decline early data if local
						// ALPS preferences has changed for the current connection.
						alpsMismatchTests := []struct {
							name                            string
							initialSettings, resumeSettings []byte
						}{
							{"DifferentValues", []byte("settings1"), []byte("settings2")},
							{"OnOff", []byte("settings"), nil},
							{"OffOn", nil, []byte("settings")},
							// The empty settings value should not be mistaken for ALPS not
							// being negotiated.
							{"OnEmpty", []byte("settings"), []byte{}},
							{"EmptyOn", []byte{}, []byte("settings")},
							{"EmptyOff", []byte{}, nil},
							{"OffEmpty", nil, []byte{}},
						}
						for _, test := range alpsMismatchTests {
							flags := []string{"-on-resume-expect-early-data-reason", "alps_mismatch"}
							flags = append(flags, alpsFlags...)
							if test.initialSettings != nil {
								flags = append(flags, "-on-initial-application-settings", "proto,"+string(test.initialSettings))
								flags = append(flags, "-on-initial-expect-peer-application-settings", "runner")
							}
							if test.resumeSettings != nil {
								flags = append(flags, "-on-resume-application-settings", "proto,"+string(test.resumeSettings))
								flags = append(flags, "-on-resume-expect-peer-application-settings", "runner")
							}

							expectations = connectionExpectations{
								peerApplicationSettingsOld: test.initialSettings,
							}
							resumeExpectations = &connectionExpectations{
								peerApplicationSettingsOld: test.resumeSettings,
							}
							if alpsCodePoint == ALPSUseCodepointNew {
								expectations = connectionExpectations{
									peerApplicationSettings: test.initialSettings,
								}
								resumeExpectations = &connectionExpectations{
									peerApplicationSettings: test.resumeSettings,
								}
							}
							// The client should not offer early data if the session is
							// inconsistent with the new configuration. Note that if
							// the session did not negotiate ALPS (test.initialSettings
							// is nil), the client always offers early data.
							if test.initialSettings != nil {
								testCases = append(testCases, testCase{
									protocol:           protocol,
									testType:           clientTest,
									name:               fmt.Sprintf("ALPS-EarlyData-Mismatch-%s-Client-%s-%s", test.name, alpsCodePoint, suffix),
									skipQUICALPNConfig: true,
									config: Config{
										MaxVersion:          ver.version,
										MaxEarlyDataSize:    16384,
										NextProtos:          []string{"proto"},
										ApplicationSettings: map[string][]byte{"proto": []byte("runner")},
										ALPSUseNewCodepoint: alpsCodePoint,
									},
									resumeSession: true,
									flags: append([]string{
										"-enable-early-data",
										"-expect-ticket-supports-early-data",
										"-expect-no-offer-early-data",
										"-advertise-alpn", "\x05proto",
										"-expect-alpn", "proto",
									}, flags...),
									expectations:       expectations,
									resumeExpectations: resumeExpectations,
								})
							}

							// The server should reject early data if the session is
							// inconsistent with the new selection.
							testCases = append(testCases, testCase{
								protocol:           protocol,
								testType:           serverTest,
								name:               fmt.Sprintf("ALPS-EarlyData-Mismatch-%s-Server-%s-%s", test.name, alpsCodePoint, suffix),
								skipQUICALPNConfig: true,
								config: Config{
									MaxVersion:          ver.version,
									NextProtos:          []string{"proto"},
									ApplicationSettings: map[string][]byte{"proto": []byte("runner")},
									ALPSUseNewCodepoint: alpsCodePoint,
								},
								resumeSession:           true,
								earlyData:               true,
								expectEarlyDataRejected: true,
								flags: append([]string{
									"-select-alpn", "proto",
								}, flags...),
								expectations:       expectations,
								resumeExpectations: resumeExpectations,
							})
						}

						// Test that 0-RTT continues working when the shim configures
						// ALPS but the peer does not.
						testCases = append(testCases, testCase{
							protocol:           protocol,
							testType:           clientTest,
							name:               fmt.Sprintf("ALPS-EarlyData-Client-ServerDecline-%s-%s", alpsCodePoint, suffix),
							skipQUICALPNConfig: true,
							config: Config{
								MaxVersion:          ver.version,
								NextProtos:          []string{"proto"},
								ALPSUseNewCodepoint: alpsCodePoint,
							},
							resumeSession: true,
							earlyData:     true,
							flags: append([]string{
								"-advertise-alpn", "\x05proto",
								"-expect-alpn", "proto",
								"-application-settings", "proto,shim",
							}, alpsFlags...),
						})
						testCases = append(testCases, testCase{
							protocol:           protocol,
							testType:           serverTest,
							name:               fmt.Sprintf("ALPS-EarlyData-Server-ClientNoOffe-%s-%s", alpsCodePoint, suffix),
							skipQUICALPNConfig: true,
							config: Config{
								MaxVersion:          ver.version,
								NextProtos:          []string{"proto"},
								ALPSUseNewCodepoint: alpsCodePoint,
							},
							resumeSession: true,
							earlyData:     true,
							flags: append([]string{
								"-select-alpn", "proto",
								"-application-settings", "proto,shim",
							}, alpsFlags...),
						})
					}
				}
			} else {
				// Test the client rejects the ALPS extension if the server
				// negotiated TLS 1.2 or below.
				for _, alpsCodePoint := range []ALPSUseCodepoint{ALPSUseCodepointNew, ALPSUseCodepointOld} {
					useAlpsCodepointFlag := "0"
					if alpsCodePoint == ALPSUseCodepointNew {
						useAlpsCodepointFlag = "1"
					}

					flags := []string{
						"-advertise-alpn", "\x03foo",
						"-expect-alpn", "foo",
						"-application-settings", "foo,shim",
						"-alps-use-new-codepoint", useAlpsCodepointFlag,
					}
					bugs := ProtocolBugs{
						AlwaysNegotiateApplicationSettingsOld: true,
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						bugs = ProtocolBugs{
							AlwaysNegotiateApplicationSettingsNew: true,
						}
					}
					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: clientTest,
						name:     fmt.Sprintf("ALPS-Reject-Client-%s-%s", alpsCodePoint, suffix),
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"foo"},
							ApplicationSettings: map[string][]byte{"foo": []byte("runner")},
							Bugs:                bugs,
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						flags:              flags,
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_EXTENSION:",
						expectedLocalError: "remote error: unsupported extension",
					})

					flags = []string{
						"-on-resume-advertise-alpn", "\x03foo",
						"-on-resume-expect-alpn", "foo",
						"-on-resume-application-settings", "foo,shim",
						"-alps-use-new-codepoint", useAlpsCodepointFlag,
					}
					bugs = ProtocolBugs{
						AlwaysNegotiateApplicationSettingsOld: true,
					}
					if alpsCodePoint == ALPSUseCodepointNew {
						bugs = ProtocolBugs{
							AlwaysNegotiateApplicationSettingsNew: true,
						}
					}
					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: clientTest,
						name:     fmt.Sprintf("ALPS-Reject-Client-Resume-%s-%s", alpsCodePoint, suffix),
						config: Config{
							MaxVersion: ver.version,
						},
						resumeConfig: &Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"foo"},
							ApplicationSettings: map[string][]byte{"foo": []byte("runner")},
							Bugs:                bugs,
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						resumeSession:      true,
						flags:              flags,
						shouldFail:         true,
						expectedError:      ":UNEXPECTED_EXTENSION:",
						expectedLocalError: "remote error: unsupported extension",
					})

					// Test the server declines ALPS if it negotiates TLS 1.2 or below.
					flags = []string{
						"-select-alpn", "foo",
						"-application-settings", "foo,shim",
						"-alps-use-new-codepoint", useAlpsCodepointFlag,
					}

					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: serverTest,
						name:     fmt.Sprintf("ALPS-Decline-Server-%s-%s", alpsCodePoint, suffix),
						config: Config{
							MaxVersion:          ver.version,
							NextProtos:          []string{"foo"},
							ApplicationSettings: map[string][]byte{"foo": []byte("runner")},
							ALPSUseNewCodepoint: alpsCodePoint,
						},
						// Test both TLS 1.2 full and resumption handshakes.
						resumeSession: true,
						flags:         flags,
						// If not specified, runner and shim both implicitly expect ALPS
						// is not negotiated.
					})
				}
			}

			// Test QUIC transport params
			if protocol == quic {
				// Client sends params
				for _, clientConfig := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy} {
					for _, serverSends := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy, QUICUseCodepointBoth, QUICUseCodepointNeither} {
						useCodepointFlag := "0"
						if clientConfig == QUICUseCodepointLegacy {
							useCodepointFlag = "1"
						}
						flags := []string{
							"-quic-transport-params",
							base64FlagValue([]byte{1, 2}),
							"-quic-use-legacy-codepoint", useCodepointFlag,
						}
						expectations := connectionExpectations{
							quicTransportParams: []byte{1, 2},
						}
						shouldFail := false
						expectedError := ""
						expectedLocalError := ""
						if clientConfig == QUICUseCodepointLegacy {
							expectations = connectionExpectations{
								quicTransportParamsLegacy: []byte{1, 2},
							}
						}
						if serverSends != clientConfig {
							expectations = connectionExpectations{}
							shouldFail = true
							if serverSends == QUICUseCodepointNeither {
								expectedError = ":MISSING_EXTENSION:"
							} else {
								expectedLocalError = "remote error: unsupported extension"
							}
						} else {
							flags = append(flags,
								"-expect-quic-transport-params",
								base64FlagValue([]byte{3, 4}))
						}
						testCases = append(testCases, testCase{
							testType: clientTest,
							protocol: protocol,
							name:     fmt.Sprintf("QUICTransportParams-Client-Client%s-Server%s-%s", clientConfig, serverSends, suffix),
							config: Config{
								MinVersion:                            ver.version,
								MaxVersion:                            ver.version,
								QUICTransportParams:                   []byte{3, 4},
								QUICTransportParamsUseLegacyCodepoint: serverSends,
							},
							flags:                     flags,
							expectations:              expectations,
							shouldFail:                shouldFail,
							expectedError:             expectedError,
							expectedLocalError:        expectedLocalError,
							skipTransportParamsConfig: true,
						})
					}
				}
				// Server sends params
				for _, clientSends := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy, QUICUseCodepointBoth, QUICUseCodepointNeither} {
					for _, serverConfig := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy} {
						expectations := connectionExpectations{
							quicTransportParams: []byte{3, 4},
						}
						shouldFail := false
						expectedError := ""
						useCodepointFlag := "0"
						if serverConfig == QUICUseCodepointLegacy {
							useCodepointFlag = "1"
							expectations = connectionExpectations{
								quicTransportParamsLegacy: []byte{3, 4},
							}
						}
						flags := []string{
							"-quic-transport-params",
							base64FlagValue([]byte{3, 4}),
							"-quic-use-legacy-codepoint", useCodepointFlag,
						}
						if clientSends != QUICUseCodepointBoth && clientSends != serverConfig {
							expectations = connectionExpectations{}
							shouldFail = true
							expectedError = ":MISSING_EXTENSION:"
						} else {
							flags = append(flags,
								"-expect-quic-transport-params",
								base64FlagValue([]byte{1, 2}),
							)
						}
						testCases = append(testCases, testCase{
							testType: serverTest,
							protocol: protocol,
							name:     fmt.Sprintf("QUICTransportParams-Server-Client%s-Server%s-%s", clientSends, serverConfig, suffix),
							config: Config{
								MinVersion:                            ver.version,
								MaxVersion:                            ver.version,
								QUICTransportParams:                   []byte{1, 2},
								QUICTransportParamsUseLegacyCodepoint: clientSends,
							},
							flags:                     flags,
							expectations:              expectations,
							shouldFail:                shouldFail,
							expectedError:             expectedError,
							skipTransportParamsConfig: true,
						})
					}
				}
			} else {
				// Ensure non-QUIC client doesn't send QUIC transport parameters.
				for _, clientConfig := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy} {
					useCodepointFlag := "0"
					if clientConfig == QUICUseCodepointLegacy {
						useCodepointFlag = "1"
					}
					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: clientTest,
						name:     fmt.Sprintf("QUICTransportParams-Client-NotSentInNonQUIC-%s-%s", clientConfig, suffix),
						config: Config{
							MinVersion:                            ver.version,
							MaxVersion:                            ver.version,
							QUICTransportParamsUseLegacyCodepoint: clientConfig,
						},
						flags: []string{
							"-max-version",
							ver.shimFlag(protocol),
							"-quic-transport-params",
							base64FlagValue([]byte{3, 4}),
							"-quic-use-legacy-codepoint", useCodepointFlag,
						},
						shouldFail:                true,
						expectedError:             ":QUIC_TRANSPORT_PARAMETERS_MISCONFIGURED:",
						skipTransportParamsConfig: true,
					})
				}
				// Ensure non-QUIC server rejects codepoint 57 but ignores legacy 0xffa5.
				for _, clientSends := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy, QUICUseCodepointBoth, QUICUseCodepointNeither} {
					for _, serverConfig := range []QUICUseCodepoint{QUICUseCodepointStandard, QUICUseCodepointLegacy} {
						shouldFail := false
						expectedLocalError := ""
						useCodepointFlag := "0"
						if serverConfig == QUICUseCodepointLegacy {
							useCodepointFlag = "1"
						}
						if clientSends == QUICUseCodepointStandard || clientSends == QUICUseCodepointBoth {
							shouldFail = true
							expectedLocalError = "remote error: unsupported extension"
						}
						testCases = append(testCases, testCase{
							protocol: protocol,
							testType: serverTest,
							name:     fmt.Sprintf("QUICTransportParams-NonQUICServer-Client%s-Server%s-%s", clientSends, serverConfig, suffix),
							config: Config{
								MinVersion:                            ver.version,
								MaxVersion:                            ver.version,
								QUICTransportParams:                   []byte{1, 2},
								QUICTransportParamsUseLegacyCodepoint: clientSends,
							},
							flags: []string{
								"-quic-use-legacy-codepoint", useCodepointFlag,
							},
							shouldFail:                shouldFail,
							expectedLocalError:        expectedLocalError,
							skipTransportParamsConfig: true,
						})
					}
				}

			}

			// Test ticket behavior.

			// Resume with a corrupt ticket.
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "CorruptTicket-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						FilterTicket: func(in []byte) ([]byte, error) {
							in[len(in)-1] ^= 1
							return in, nil
						},
					},
				},
				resumeSession:        true,
				expectResumeRejected: true,
			})
			// Test the ticket callbacks.
			for _, aeadCallback := range []bool{false, true} {
				flag := "-use-ticket-callback"
				callbackSuffix := suffix
				if aeadCallback {
					flag = "-use-ticket-aead-callback"
					callbackSuffix += "-AEAD"
				}
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketCallback-" + callbackSuffix,
					config: Config{
						MaxVersion: ver.version,
					},
					resumeSession: true,
					flags:         []string{flag},
				})
				// Only the old callback supports renewal.
				if !aeadCallback {
					testCases = append(testCases, testCase{
						protocol: protocol,
						testType: serverTest,
						name:     "TicketCallback-Renew-" + callbackSuffix,
						config: Config{
							MaxVersion: ver.version,
							Bugs: ProtocolBugs{
								ExpectNewTicket: true,
							},
						},
						flags:         []string{flag, "-renew-ticket"},
						resumeSession: true,
					})
				}
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketCallback-Skip-" + callbackSuffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							ExpectNoNonEmptyNewSessionTicket: true,
						},
					},
					flags: []string{flag, "-skip-ticket"},
				})

				// Test that the ticket callback is only called once when everything before
				// it in the ClientHello is asynchronous. This corrupts the ticket so
				// certificate selection callbacks run.
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketCallback-SingleCall-" + callbackSuffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							FilterTicket: func(in []byte) ([]byte, error) {
								in[len(in)-1] ^= 1
								return in, nil
							},
						},
					},
					resumeSession:        true,
					expectResumeRejected: true,
					flags: []string{
						flag,
						"-async",
					},
				})
			}

			// Resume with various lengths of ticket session id.
			if ver.version < VersionTLS13 {
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketSessionIDLength-0-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							EmptyTicketSessionID: true,
						},
					},
					resumeSession: true,
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketSessionIDLength-16-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							TicketSessionIDLength: 16,
						},
					},
					resumeSession: true,
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketSessionIDLength-32-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							TicketSessionIDLength: 32,
						},
					},
					resumeSession: true,
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "TicketSessionIDLength-33-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							TicketSessionIDLength: 33,
						},
					},
					resumeSession: true,
					shouldFail:    true,
					// The maximum session ID length is 32.
					expectedError: ":CLIENTHELLO_PARSE_FAILED:",
				})
			}

			// Basic DTLS-SRTP tests. Include fake profiles to ensure they
			// are ignored.
			if protocol == dtls {
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "SRTP-Client-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{40, SRTP_AES128_CM_HMAC_SHA1_80, 42},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: SRTP_AES128_CM_HMAC_SHA1_80,
					},
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "SRTP-Server-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{40, SRTP_AES128_CM_HMAC_SHA1_80, 42},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: SRTP_AES128_CM_HMAC_SHA1_80,
					},
				})
				// Test that the MKI is ignored.
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "SRTP-Server-IgnoreMKI-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{SRTP_AES128_CM_HMAC_SHA1_80},
						Bugs: ProtocolBugs{
							SRTPMasterKeyIdentifier: "bogus",
						},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: SRTP_AES128_CM_HMAC_SHA1_80,
					},
				})
				// Test that SRTP isn't negotiated on the server if there were
				// no matching profiles.
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "SRTP-Server-NoMatch-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{100, 101, 102},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: 0,
					},
				})
				// Test that the server returning an invalid SRTP profile is
				// flagged as an error by the client.
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "SRTP-Client-NoMatch-" + suffix,
					config: Config{
						MaxVersion: ver.version,
						Bugs: ProtocolBugs{
							SendSRTPProtectionProfile: SRTP_AES128_CM_HMAC_SHA1_32,
						},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80",
					},
					shouldFail:    true,
					expectedError: ":BAD_SRTP_PROTECTION_PROFILE_LIST:",
				})
			} else {
				// DTLS-SRTP is not defined for other protocols. Configuring it
				// on the client and server should ignore the extension.
				testCases = append(testCases, testCase{
					protocol: protocol,
					name:     "SRTP-Client-Ignore-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{40, SRTP_AES128_CM_HMAC_SHA1_80, 42},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: 0,
					},
				})
				testCases = append(testCases, testCase{
					protocol: protocol,
					testType: serverTest,
					name:     "SRTP-Server-Ignore-" + suffix,
					config: Config{
						MaxVersion:             ver.version,
						SRTPProtectionProfiles: []uint16{40, SRTP_AES128_CM_HMAC_SHA1_80, 42},
					},
					flags: []string{
						"-srtp-profiles",
						"SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
					},
					expectations: connectionExpectations{
						srtpProtectionProfile: 0,
					},
				})
			}

			// Test SCT list.
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "SignedCertificateTimestampList-Client-" + suffix,
				testType: clientTest,
				config: Config{
					MaxVersion: ver.version,
					Credential: rsaCertificate.WithSCTList(testSCTList),
				},
				flags: []string{
					"-enable-signed-cert-timestamps",
					"-expect-signed-cert-timestamps",
					base64FlagValue(testSCTList),
				},
				resumeSession: true,
			})

			var differentSCTList []byte
			differentSCTList = append(differentSCTList, testSCTList...)
			differentSCTList[len(differentSCTList)-1] ^= 1

			// The SCT extension did not specify that it must only be sent on the initial handshake as it
			// should have, so test that we tolerate but ignore it. This is only an issue pre-1.3, since
			// SCTs are sent in the CertificateEntry message in 1.3, whereas they were previously sent
			// in an extension in the ServerHello pre-1.3.
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "SendSCTListOnResume-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Credential: rsaCertificate.WithSCTList(testSCTList),
					Bugs: ProtocolBugs{
						SendSCTListOnResume: differentSCTList,
					},
				},
				flags: []string{
					"-enable-signed-cert-timestamps",
					"-expect-signed-cert-timestamps",
					base64FlagValue(testSCTList),
				},
				resumeSession: true,
			})

			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "SignedCertificateTimestampList-Server-" + suffix,
				testType: serverTest,
				config: Config{
					MaxVersion: ver.version,
				},
				shimCertificate: rsaCertificate.WithSCTList(testSCTList),
				expectations: connectionExpectations{
					peerCertificate: rsaCertificate.WithSCTList(testSCTList),
				},
				resumeSession: true,
			})

			// Test empty SCT list.
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "SignedCertificateTimestampListEmpty-Client-" + suffix,
				testType: clientTest,
				config: Config{
					MaxVersion: ver.version,
					Credential: rsaCertificate.WithSCTList([]byte{0, 0}),
				},
				flags: []string{
					"-enable-signed-cert-timestamps",
				},
				shouldFail:    true,
				expectedError: ":ERROR_PARSING_EXTENSION:",
			})

			// Test empty SCT in non-empty list.
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     "SignedCertificateTimestampListEmptySCT-Client-" + suffix,
				testType: clientTest,
				config: Config{
					MaxVersion: ver.version,
					Credential: rsaCertificate.WithSCTList([]byte{0, 6, 0, 2, 1, 2, 0, 0}),
				},
				flags: []string{
					"-enable-signed-cert-timestamps",
				},
				shouldFail:    true,
				expectedError: ":ERROR_PARSING_EXTENSION:",
			})

			// Test that certificate-related extensions are not sent unsolicited.
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "UnsolicitedCertificateExtensions-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Bugs: ProtocolBugs{
						NoOCSPStapling:                true,
						NoSignedCertificateTimestamps: true,
					},
				},
				shimCertificate: rsaCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
			})

			// The client should reject empty OCSP responses from the server. A server
			// with no OCSP response should not send the status_request extension.
			testCases = append(testCases, testCase{
				protocol: protocol,
				testType: clientTest,
				name:     "RejectEmptyOCSPResponse-" + suffix,
				config: Config{
					MaxVersion: ver.version,
					Credential: rsaCertificate.WithOCSP([]byte{}),
				},
				flags:              []string{"-enable-ocsp-stapling"},
				shouldFail:         true,
				expectedError:      ":DECODE_ERROR:",
				expectedLocalError: "remote error: error decoding message",
			})

			// Extension permutation should interact correctly with other extensions,
			// HelloVerifyRequest, HelloRetryRequest, and ECH. SSLTest.PermuteExtensions
			// in ssl_test.cc tests that the extensions are actually permuted. This
			// tests the handshake still works.
			//
			// This test also tests that all our extensions interact with each other.
			for _, ech := range []bool{false, true} {
				if ech && ver.version < VersionTLS13 {
					continue
				}

				test := testCase{
					protocol:           protocol,
					name:               "AllExtensions-Client-Permute",
					skipQUICALPNConfig: true,
					config: Config{
						MinVersion:          ver.version,
						MaxVersion:          ver.version,
						Credential:          rsaCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
						NextProtos:          []string{"proto"},
						ApplicationSettings: map[string][]byte{"proto": []byte("runner1")},
						Bugs: ProtocolBugs{
							SendServerNameAck: true,
							ExpectServerName:  "example.com",
							ExpectGREASE:      true,
						},
					},
					resumeSession: true,
					flags: []string{
						"-permute-extensions",
						"-enable-grease",
						"-enable-ocsp-stapling",
						"-enable-signed-cert-timestamps",
						"-advertise-alpn", "\x05proto",
						"-expect-alpn", "proto",
						"-host-name", "example.com",
					},
				}

				if ech {
					test.name += "-ECH"
					echConfig := generateServerECHConfig(&ECHConfig{ConfigID: 42})
					test.config.ServerECHConfigs = []ServerECHConfig{echConfig}
					test.flags = append(test.flags,
						"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
						"-expect-ech-accept",
					)
					test.expectations.echAccepted = true
				}

				if ver.version >= VersionTLS13 {
					// Trigger a HelloRetryRequest to test both ClientHellos. Note
					// our DTLS tests always enable HelloVerifyRequest.
					test.name += "-HelloRetryRequest"

					// ALPS is only available on TLS 1.3.
					test.config.ApplicationSettings = map[string][]byte{"proto": []byte("runner")}
					test.flags = append(test.flags,
						"-application-settings", "proto,shim",
						"-alps-use-new-codepoint", "1",
						"-expect-peer-application-settings", "runner")
					test.expectations.peerApplicationSettings = []byte("shim")
				}

				if protocol == dtls {
					test.config.SRTPProtectionProfiles = []uint16{SRTP_AES128_CM_HMAC_SHA1_80}
					test.flags = append(test.flags, "-srtp-profiles", "SRTP_AES128_CM_SHA1_80")
					test.expectations.srtpProtectionProfile = SRTP_AES128_CM_HMAC_SHA1_80
				}

				test.name += "-" + suffix
				testCases = append(testCases, test)
			}
		}
	}

	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ClientHelloPadding",
		config: Config{
			Bugs: ProtocolBugs{
				RequireClientHelloSize: 512,
			},
		},
		// This hostname just needs to be long enough to push the
		// ClientHello into F5's danger zone between 256 and 511 bytes
		// long.
		flags: []string{"-host-name", "01234567890123456789012345678901234567890123456789012345678901234567890123456789.com"},
	})

	// Test that illegal extensions in TLS 1.3 are rejected by the client if
	// in ServerHello.
	testCases = append(testCases, testCase{
		name: "NPN-Forbidden-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"foo"},
			Bugs: ProtocolBugs{
				NegotiateNPNAtAllVersions: true,
			},
		},
		flags:         []string{"-select-next-proto", "foo"},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		name: "EMS-Forbidden-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NegotiateEMSAtAllVersions: true,
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		name: "RenegotiationInfo-Forbidden-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				NegotiateRenegotiationInfoAtAllVersions: true,
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		name: "Ticket-Forbidden-TLS13",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AdvertiseTicketExtension: true,
			},
		},
		resumeSession: true,
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})

	// Test that illegal extensions in TLS 1.3 are declined by the server if
	// offered in ClientHello. The runner's server will fail if this occurs,
	// so we exercise the offering path. (EMS and Renegotiation Info are
	// implicit in every test.)
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "NPN-Declined-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			NextProtos: []string{"bar"},
		},
		flags: []string{"-advertise-npn", "\x03foo\x03bar\x03baz"},
	})

	// OpenSSL sends the status_request extension on resumption in TLS 1.2. Test that this is
	// tolerated.
	testCases = append(testCases, testCase{
		name: "SendOCSPResponseOnResume-TLS12",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: rsaCertificate.WithOCSP(testOCSPResponse),
			Bugs: ProtocolBugs{
				SendOCSPResponseOnResume: []byte("bogus"),
			},
		},
		flags: []string{
			"-enable-ocsp-stapling",
			"-expect-ocsp-response",
			base64FlagValue(testOCSPResponse),
		},
		resumeSession: true,
	})

	testCases = append(testCases, testCase{
		name: "SendUnsolicitedOCSPOnCertificate-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendExtensionOnCertificate: testOCSPExtension,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	testCases = append(testCases, testCase{
		name: "SendUnsolicitedSCTOnCertificate-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendExtensionOnCertificate: testSCTExtension,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	// Test that extensions on client certificates are never accepted.
	testCases = append(testCases, testCase{
		name:     "SendExtensionOnClientCertificate-TLS13",
		testType: serverTest,
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &rsaCertificate,
			Bugs: ProtocolBugs{
				SendExtensionOnCertificate: testOCSPExtension,
			},
		},
		flags: []string{
			"-enable-ocsp-stapling",
			"-require-any-client-certificate",
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	testCases = append(testCases, testCase{
		name: "SendUnknownExtensionOnCertificate-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendExtensionOnCertificate: []byte{0x00, 0x7f, 0, 0},
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})

	// Test that extensions on intermediates are allowed but ignored.
	testCases = append(testCases, testCase{
		name: "IgnoreExtensionsOnIntermediates-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaChainCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
			Bugs: ProtocolBugs{
				// Send different values on the intermediate. This tests
				// the intermediate's extensions do not override the
				// leaf's.
				SendOCSPOnIntermediates: testOCSPResponse2,
				SendSCTOnIntermediates:  testSCTList2,
			},
		},
		flags: []string{
			"-enable-ocsp-stapling",
			"-expect-ocsp-response",
			base64FlagValue(testOCSPResponse),
			"-enable-signed-cert-timestamps",
			"-expect-signed-cert-timestamps",
			base64FlagValue(testSCTList),
		},
		resumeSession: true,
	})

	// Test that extensions are not sent on intermediates when configured
	// only for a leaf.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SendNoExtensionsOnIntermediate-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				ExpectNoExtensionsOnIntermediate: true,
			},
		},
		shimCertificate: rsaChainCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
	})

	// Test that extensions are not sent on client certificates.
	testCases = append(testCases, testCase{
		name: "SendNoClientCertificateExtensions-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			ClientAuth: RequireAnyClientCert,
		},
		shimCertificate: rsaChainCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
	})

	testCases = append(testCases, testCase{
		name: "SendDuplicateExtensionsOnCerts-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: rsaCertificate.WithOCSP(testOCSPResponse).WithSCTList(testSCTList),
			Bugs: ProtocolBugs{
				SendDuplicateCertExtensions: true,
			},
		},
		flags: []string{
			"-enable-ocsp-stapling",
			"-enable-signed-cert-timestamps",
		},
		resumeSession: true,
		shouldFail:    true,
		expectedError: ":DUPLICATE_EXTENSION:",
	})

	testCases = append(testCases, testCase{
		name:            "SignedCertificateTimestampListInvalid-Server",
		testType:        serverTest,
		shimCertificate: rsaCertificate.WithSCTList([]byte{0, 0}),
		shouldFail:      true,
		expectedError:   ":INVALID_SCT_LIST:",
	})
}

func addUnknownExtensionTests() {
	// Test an unknown extension from the server.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnknownExtension-Client",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				CustomExtension: "custom extension",
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnknownExtension-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				CustomExtension: "custom extension",
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnknownUnencryptedExtension-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				CustomUnencryptedExtension: "custom extension",
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
		// The shim must send an alert, but alerts at this point do not
		// get successfully decrypted by the runner.
		expectedLocalError: "local error: bad record MAC",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnexpectedUnencryptedExtension-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendUnencryptedALPN: "foo",
			},
		},
		flags: []string{
			"-advertise-alpn", "\x03foo\x03bar",
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
		// The shim must send an alert, but alerts at this point do not
		// get successfully decrypted by the runner.
		expectedLocalError: "local error: bad record MAC",
	})

	// Test a known but unoffered extension from the server.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnofferedExtension-Client",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendALPN: "alpn",
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "UnofferedExtension-Client-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendALPN: "alpn",
			},
		},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})
}

// Test that omitted and empty extensions blocks are tolerated.
func addOmitExtensionsTests() {
	// Check the ExpectOmitExtensions setting works.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ExpectOmitExtensions",
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				ExpectOmitExtensions: true,
			},
		},
		shouldFail:         true,
		expectedLocalError: "tls: ServerHello did not omit extensions",
	})

	for _, ver := range tlsVersions {
		if ver.version > VersionTLS12 {
			continue
		}

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "OmitExtensions-ClientHello-" + ver.name,
			config: Config{
				MinVersion:             ver.version,
				MaxVersion:             ver.version,
				SessionTicketsDisabled: true,
				Bugs: ProtocolBugs{
					OmitExtensions: true,
					// With no client extensions, the ServerHello must not have
					// extensions. It should then omit the extensions field.
					ExpectOmitExtensions: true,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "EmptyExtensions-ClientHello-" + ver.name,
			config: Config{
				MinVersion:             ver.version,
				MaxVersion:             ver.version,
				SessionTicketsDisabled: true,
				Bugs: ProtocolBugs{
					EmptyExtensions: true,
					// With no client extensions, the ServerHello must not have
					// extensions. It should then omit the extensions field.
					ExpectOmitExtensions: true,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "OmitExtensions-ServerHello-" + ver.name,
			config: Config{
				MinVersion:             ver.version,
				MaxVersion:             ver.version,
				SessionTicketsDisabled: true,
				Bugs: ProtocolBugs{
					OmitExtensions: true,
					// Disable all ServerHello extensions so
					// OmitExtensions works.
					NoExtendedMasterSecret:        true,
					NoRenegotiationInfo:           true,
					NoOCSPStapling:                true,
					NoSignedCertificateTimestamps: true,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "EmptyExtensions-ServerHello-" + ver.name,
			config: Config{
				MinVersion:             ver.version,
				MaxVersion:             ver.version,
				SessionTicketsDisabled: true,
				Bugs: ProtocolBugs{
					EmptyExtensions: true,
					// Disable all ServerHello extensions so
					// EmptyExtensions works.
					NoExtendedMasterSecret:        true,
					NoRenegotiationInfo:           true,
					NoOCSPStapling:                true,
					NoSignedCertificateTimestamps: true,
				},
			},
		})
	}
}
