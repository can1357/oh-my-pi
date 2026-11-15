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

type perMessageTest struct {
	messageType uint8
	test        testCase
}

// makePerMessageTests returns a series of test templates which cover each
// message in the TLS handshake. These may be used with bugs like
// WrongMessageType to fully test a per-message bug.
func makePerMessageTests() []perMessageTest {
	var ret []perMessageTest
	// The following tests are limited to TLS 1.2, so QUIC is not tested.
	for _, protocol := range []protocol{tls, dtls} {
		suffix := "-" + protocol.String()

		ret = append(ret, perMessageTest{
			messageType: typeClientHello,
			test: testCase{
				protocol: protocol,
				testType: serverTest,
				name:     "ClientHello" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		if protocol == dtls {
			ret = append(ret, perMessageTest{
				messageType: typeHelloVerifyRequest,
				test: testCase{
					protocol: protocol,
					name:     "HelloVerifyRequest" + suffix,
					config: Config{
						MaxVersion: VersionTLS12,
					},
				},
			})
		}

		ret = append(ret, perMessageTest{
			messageType: typeServerHello,
			test: testCase{
				protocol: protocol,
				name:     "ServerHello" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificate,
			test: testCase{
				protocol: protocol,
				name:     "ServerCertificate" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateStatus,
			test: testCase{
				protocol: protocol,
				name:     "CertificateStatus" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
					Credential: rsaCertificate.WithOCSP(testOCSPResponse),
				},
				flags: []string{"-enable-ocsp-stapling"},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeServerKeyExchange,
			test: testCase{
				protocol: protocol,
				name:     "ServerKeyExchange" + suffix,
				config: Config{
					MaxVersion:   VersionTLS12,
					CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateRequest,
			test: testCase{
				protocol: protocol,
				name:     "CertificateRequest" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
					ClientAuth: RequireAnyClientCert,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeServerHelloDone,
			test: testCase{
				protocol: protocol,
				name:     "ServerHelloDone" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificate,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "ClientCertificate" + suffix,
				config: Config{
					Credential: &rsaCertificate,
					MaxVersion: VersionTLS12,
				},
				flags: []string{"-require-any-client-certificate"},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateVerify,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "CertificateVerify" + suffix,
				config: Config{
					Credential: &rsaCertificate,
					MaxVersion: VersionTLS12,
				},
				flags: []string{"-require-any-client-certificate"},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeClientKeyExchange,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "ClientKeyExchange" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		if protocol != dtls {
			ret = append(ret, perMessageTest{
				messageType: typeNextProtocol,
				test: testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "NextProtocol" + suffix,
					config: Config{
						MaxVersion: VersionTLS12,
						NextProtos: []string{"bar"},
					},
					flags: []string{"-advertise-npn", "\x03foo\x03bar\x03baz"},
				},
			})

			ret = append(ret, perMessageTest{
				messageType: typeChannelID,
				test: testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "ChannelID" + suffix,
					config: Config{
						MaxVersion: VersionTLS12,
						ChannelID:  &channelIDKey,
					},
					flags: []string{
						"-expect-channel-id",
						base64FlagValue(channelIDBytes),
					},
				},
			})
		}

		ret = append(ret, perMessageTest{
			messageType: typeFinished,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "ClientFinished" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeNewSessionTicket,
			test: testCase{
				protocol: protocol,
				name:     "NewSessionTicket" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeFinished,
			test: testCase{
				protocol: protocol,
				name:     "ServerFinished" + suffix,
				config: Config{
					MaxVersion: VersionTLS12,
				},
			},
		})

	}

	for _, protocol := range []protocol{tls, quic, dtls} {
		suffix := "-" + protocol.String()
		ret = append(ret, perMessageTest{
			messageType: typeClientHello,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "TLS13-ClientHello" + suffix,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeServerHello,
			test: testCase{
				name:     "TLS13-ServerHello" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeEncryptedExtensions,
			test: testCase{
				name:     "TLS13-EncryptedExtensions" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateRequest,
			test: testCase{
				name:     "TLS13-CertificateRequest" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
					ClientAuth: RequireAnyClientCert,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificate,
			test: testCase{
				name:     "TLS13-ServerCertificate" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateVerify,
			test: testCase{
				name:     "TLS13-ServerCertificateVerify" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeFinished,
			test: testCase{
				name:     "TLS13-ServerFinished" + suffix,
				protocol: protocol,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificate,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "TLS13-ClientCertificate" + suffix,
				config: Config{
					Credential: &rsaCertificate,
					MaxVersion: VersionTLS13,
				},
				flags: []string{"-require-any-client-certificate"},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeCertificateVerify,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "TLS13-ClientCertificateVerify" + suffix,
				config: Config{
					Credential: &rsaCertificate,
					MaxVersion: VersionTLS13,
				},
				flags: []string{"-require-any-client-certificate"},
			},
		})

		ret = append(ret, perMessageTest{
			messageType: typeFinished,
			test: testCase{
				testType: serverTest,
				protocol: protocol,
				name:     "TLS13-ClientFinished" + suffix,
				config: Config{
					MaxVersion: VersionTLS13,
				},
			},
		})

		// Only TLS uses EndOfEarlyData.
		if protocol == tls {
			ret = append(ret, perMessageTest{
				messageType: typeEndOfEarlyData,
				test: testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "TLS13-EndOfEarlyData" + suffix,
					config: Config{
						MaxVersion: VersionTLS13,
					},
					resumeSession: true,
					earlyData:     true,
				},
			})
		}
	}

	return ret
}

func addWrongMessageTypeTests() {
	for _, t := range makePerMessageTests() {
		t.test.name = "WrongMessageType-" + t.test.name
		if t.test.resumeConfig != nil {
			t.test.resumeConfig.Bugs.SendWrongMessageType = t.messageType
		} else {
			t.test.config.Bugs.SendWrongMessageType = t.messageType
		}
		t.test.shouldFail = true
		t.test.expectedError = ":UNEXPECTED_MESSAGE:"
		t.test.expectedLocalError = "remote error: unexpected message"

		if t.test.config.MaxVersion >= VersionTLS13 && t.messageType == typeServerHello {
			// In TLS 1.3, if the server believes it has sent ServerHello,
			// but the client cannot process it, the client will send an
			// unencrypted alert while the server expects encryption. This
			// decryption failure is reported differently for each protocol, so
			// leave it unchecked.
			t.test.expectedLocalError = ""
		}

		testCases = append(testCases, t.test)
	}
}

func addTrailingMessageDataTests() {
	for _, t := range makePerMessageTests() {
		t.test.name = "TrailingMessageData-" + t.test.name
		if t.test.resumeConfig != nil {
			t.test.resumeConfig.Bugs.SendTrailingMessageData = t.messageType
		} else {
			t.test.config.Bugs.SendTrailingMessageData = t.messageType
		}
		t.test.shouldFail = true
		t.test.expectedError = ":DECODE_ERROR:"
		t.test.expectedLocalError = "remote error: error decoding message"

		if t.test.config.MaxVersion >= VersionTLS13 && t.messageType == typeServerHello {
			// In TLS 1.3, if the server believes it has sent ServerHello,
			// but the client cannot process it, the client will send an
			// unencrypted alert while the server expects encryption. This
			// decryption failure is reported differently for each protocol, so
			// leave it unchecked.
			t.test.expectedLocalError = ""
		}

		if t.messageType == typeClientHello {
			// We have a different error for ClientHello parsing.
			t.test.expectedError = ":CLIENTHELLO_PARSE_FAILED:"
		}

		if t.messageType == typeFinished {
			// Bad Finished messages read as the verify data having
			// the wrong length.
			t.test.expectedError = ":DIGEST_CHECK_FAILED:"
			t.test.expectedLocalError = "remote error: error decrypting message"
		}

		testCases = append(testCases, t.test)
	}
}
