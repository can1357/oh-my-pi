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

func addBasicTests() {
	basicTests := []testCase{
		{
			name: "NoFallbackSCSV",
			config: Config{
				Bugs: ProtocolBugs{
					FailIfNotFallbackSCSV: true,
				},
			},
			shouldFail:         true,
			expectedLocalError: "no fallback SCSV found",
		},
		{
			name: "SendFallbackSCSV",
			config: Config{
				Bugs: ProtocolBugs{
					FailIfNotFallbackSCSV: true,
				},
			},
			flags: []string{"-fallback-scsv"},
		},
		{
			name: "ClientCertificateTypes",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequestClientCert,
				ClientCertificateTypes: []byte{
					CertTypeDSSSign,
					CertTypeRSASign,
					CertTypeECDSASign,
				},
			},
			flags: []string{
				"-expect-certificate-types",
				base64FlagValue([]byte{
					CertTypeDSSSign,
					CertTypeRSASign,
					CertTypeECDSASign,
				}),
			},
		},
		{
			name: "CheckClientCertificateTypes",
			config: Config{
				MaxVersion:             VersionTLS12,
				ClientAuth:             RequestClientCert,
				ClientCertificateTypes: []byte{CertTypeECDSASign},
			},
			shimCertificate: &rsaCertificate,
			shouldFail:      true,
			expectedError:   ":UNKNOWN_CERTIFICATE_TYPE:",
		},
		{
			name: "UnauthenticatedECDH",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					UnauthenticatedECDH: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_MESSAGE:",
		},
		{
			name: "SkipCertificateStatus",
			config: Config{
				MaxVersion:   VersionTLS12,
				Credential:   rsaCertificate.WithOCSP(testOCSPResponse),
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					SkipCertificateStatus: true,
				},
			},
			flags: []string{
				"-enable-ocsp-stapling",
				// This test involves an optional message. Test the message callback
				// trace to ensure we do not miss or double-report any.
				"-expect-msg-callback",
				`write hs 1
read hs 2
read hs 11
read hs 12
read hs 14
write hs 16
write ccs
write hs 20
read hs 4
read ccs
read hs 20
read alert 1 0
`,
			},
		},
		{
			protocol: dtls,
			name:     "SkipCertificateStatus-DTLS",
			config: Config{
				MaxVersion:   VersionTLS12,
				Credential:   rsaCertificate.WithOCSP(testOCSPResponse),
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					SkipCertificateStatus: true,
				},
			},
			flags: []string{
				"-enable-ocsp-stapling",
				// This test involves an optional message. Test the message callback
				// trace to ensure we do not miss or double-report any.
				"-expect-msg-callback",
				`write hs 1
read hs 3
write hs 1
read hs 2
read hs 11
read hs 12
read hs 14
write hs 16
write ccs
write hs 20
read hs 4
read ccs
read hs 20
read alert 1 0
`,
			},
		},
		{
			name: "SkipServerKeyExchange",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					SkipServerKeyExchange: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_MESSAGE:",
		},
		{
			testType: serverTest,
			name:     "ServerSkipCertificateVerify",
			config: Config{
				MaxVersion: VersionTLS12,
				Credential: &rsaCertificate,
				Bugs: ProtocolBugs{
					SkipCertificateVerify: true,
				},
			},
			expectations: connectionExpectations{
				peerCertificate: &rsaCertificate,
			},
			flags: []string{
				"-require-any-client-certificate",
			},
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_RECORD:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			testType: serverTest,
			name:     "Alert",
			config: Config{
				Bugs: ProtocolBugs{
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":TLSV1_ALERT_RECORD_OVERFLOW:",
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "Alert-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":TLSV1_ALERT_RECORD_OVERFLOW:",
		},
		{
			testType: serverTest,
			name:     "FragmentAlert",
			config: Config{
				Bugs: ProtocolBugs{
					FragmentAlert:     true,
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_ALERT:",
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "FragmentAlert-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					FragmentAlert:     true,
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_ALERT:",
		},
		{
			testType: serverTest,
			name:     "DoubleAlert",
			config: Config{
				Bugs: ProtocolBugs{
					DoubleAlert:       true,
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_ALERT:",
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "DoubleAlert-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					DoubleAlert:       true,
					SendSpuriousAlert: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_ALERT:",
		},
		{
			name: "SkipNewSessionTicket",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SkipNewSessionTicket: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			testType: serverTest,
			name:     "FallbackSCSV",
			config: Config{
				MaxVersion: VersionTLS11,
				Bugs: ProtocolBugs{
					SendFallbackSCSV: true,
				},
			},
			shouldFail:         true,
			expectedError:      ":INAPPROPRIATE_FALLBACK:",
			expectedLocalError: "remote error: inappropriate fallback",
		},
		{
			testType: serverTest,
			name:     "FallbackSCSV-VersionMatch-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendFallbackSCSV: true,
				},
			},
		},
		{
			testType: serverTest,
			name:     "FallbackSCSV-VersionMatch-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendFallbackSCSV: true,
				},
			},
			flags: []string{"-max-version", strconv.Itoa(VersionTLS12)},
		},
		// Regression test for CVE-2014-3511. Even when the ClientHello is
		// maximally fragmented, version negotiation works correctly.
		{
			testType: serverTest,
			name:     "FragmentedClientVersion",
			config: Config{
				Bugs: ProtocolBugs{
					MaxHandshakeRecordLength: 1,
				},
			},
			expectations: connectionExpectations{
				version: VersionTLS13,
			},
		},
		{
			testType:      serverTest,
			name:          "HttpGET",
			sendPrefix:    "GET / HTTP/1.0\n",
			shouldFail:    true,
			expectedError: ":HTTP_REQUEST:",
		},
		{
			testType:      serverTest,
			name:          "HttpPOST",
			sendPrefix:    "POST / HTTP/1.0\n",
			shouldFail:    true,
			expectedError: ":HTTP_REQUEST:",
		},
		{
			testType:      serverTest,
			name:          "HttpHEAD",
			sendPrefix:    "HEAD / HTTP/1.0\n",
			shouldFail:    true,
			expectedError: ":HTTP_REQUEST:",
		},
		{
			testType:      serverTest,
			name:          "HttpPUT",
			sendPrefix:    "PUT / HTTP/1.0\n",
			shouldFail:    true,
			expectedError: ":HTTP_REQUEST:",
		},
		{
			testType:      serverTest,
			name:          "HttpCONNECT",
			sendPrefix:    "CONNECT www.google.com:443 HTTP/1.0\n",
			shouldFail:    true,
			expectedError: ":HTTPS_PROXY_REQUEST:",
		},
		{
			testType:      serverTest,
			name:          "Garbage",
			sendPrefix:    "blah",
			shouldFail:    true,
			expectedError: ":WRONG_VERSION_NUMBER:",
		},
		{
			name: "RSAEphemeralKey",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
				Bugs: ProtocolBugs{
					RSAEphemeralKey: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_MESSAGE:",
		},
		{
			name:          "DisableEverything",
			flags:         []string{"-no-tls13", "-no-tls12", "-no-tls11", "-no-tls1"},
			shouldFail:    true,
			expectedError: ":NO_SUPPORTED_VERSIONS_ENABLED:",
		},
		{
			protocol:      dtls,
			name:          "DisableEverything-DTLS",
			flags:         []string{"-no-tls13", "-no-tls12", "-no-tls1"},
			shouldFail:    true,
			expectedError: ":NO_SUPPORTED_VERSIONS_ENABLED:",
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "MTU-DTLS12-AEAD",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					MaxPacketLength: 256,
				},
			},
			flags: []string{"-mtu", "256"},
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "MTU-DTLS12-AES-CBC",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256},
				Bugs: ProtocolBugs{
					MaxPacketLength: 256,
				},
			},
			flags: []string{"-mtu", "256"},
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "MTU-DTLS12-3DES-CBC",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_3DES_EDE_CBC_SHA},
				Bugs: ProtocolBugs{
					MaxPacketLength: 256,
				},
			},
			flags: []string{"-mtu", "256", "-cipher", "TLS_RSA_WITH_3DES_EDE_CBC_SHA"},
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "MTU-DTLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					MaxPacketLength: 256,
				},
			},
			flags: []string{"-mtu", "256"},
		},
		{
			name: "EmptyCertificateList",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					EmptyCertificateList: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DECODE_ERROR:",
		},
		{
			name: "EmptyCertificateList-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					EmptyCertificateList: true,
				},
			},
			shouldFail:    true,
			expectedError: ":PEER_DID_NOT_RETURN_A_CERTIFICATE:",
		},
		{
			name:             "TLSFatalBadPackets",
			damageFirstWrite: true,
			shouldFail:       true,
			expectedError:    ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
		},
		{
			protocol:         dtls,
			name:             "DTLSIgnoreBadPackets",
			damageFirstWrite: true,
		},
		{
			protocol:         dtls,
			name:             "DTLSIgnoreBadPackets-Async",
			damageFirstWrite: true,
			flags:            []string{"-async"},
		},
		{
			name: "AppDataBeforeHandshake",
			config: Config{
				Bugs: ProtocolBugs{
					AppDataBeforeHandshake: []byte("TEST MESSAGE"),
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			name: "AppDataBeforeHandshake-Empty",
			config: Config{
				Bugs: ProtocolBugs{
					AppDataBeforeHandshake: []byte{},
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			protocol: dtls,
			name:     "AppDataBeforeHandshake-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					AppDataBeforeHandshake: []byte("TEST MESSAGE"),
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			protocol: dtls,
			name:     "AppDataBeforeHandshake-DTLS-Empty",
			config: Config{
				Bugs: ProtocolBugs{
					AppDataBeforeHandshake: []byte{},
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			name: "AppDataBeforeTLS13KeyChange",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AppDataBeforeTLS13KeyChange: []byte("TEST MESSAGE"),
				},
			},
			// The shim should fail to decrypt this record.
			shouldFail:         true,
			expectedError:      ":BAD_DECRYPT:",
			expectedLocalError: "remote error: bad record MAC",
		},
		{
			name: "AppDataBeforeTLS13KeyChange-Empty",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AppDataBeforeTLS13KeyChange: []byte{},
				},
			},
			// The shim should fail to decrypt this record.
			shouldFail:         true,
			expectedError:      ":BAD_DECRYPT:",
			expectedLocalError: "remote error: bad record MAC",
		},
		{
			protocol: dtls,
			name:     "AppDataBeforeTLS13KeyChange-DTLS",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AppDataBeforeTLS13KeyChange: []byte("TEST MESSAGE"),
				},
			},
			// The shim will decrypt the record, because it has not
			// yet applied the key change, but it should know to
			// reject the record.
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_RECORD:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "AppDataBeforeTLS13KeyChange-DTLS-Empty",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AppDataBeforeTLS13KeyChange: []byte{},
				},
			},
			// The shim will decrypt the record, because it has not
			// yet applied the key change, but it should know to
			// reject the record.
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_RECORD:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			name: "UnencryptedEncryptedExtensions",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					UnencryptedEncryptedExtensions: true,
				},
			},
			// The shim should fail to decrypt this record.
			shouldFail:         true,
			expectedError:      ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
			expectedLocalError: "remote error: bad record MAC",
		},
		{
			protocol: dtls,
			name:     "UnencryptedEncryptedExtensions-DTLS",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					UnencryptedEncryptedExtensions: true,
				},
			},
			// The shim will decrypt the record, because it has not
			// yet applied the key change, but it should know to
			// reject new handshake data on the previous epoch.
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			name: "AppDataAfterChangeCipherSpec",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AppDataAfterChangeCipherSpec: []byte("TEST MESSAGE"),
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			name: "AppDataAfterChangeCipherSpec-Empty",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AppDataAfterChangeCipherSpec: []byte{},
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			protocol: dtls,
			name:     "AppDataAfterChangeCipherSpec-DTLS",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AppDataAfterChangeCipherSpec: []byte("TEST MESSAGE"),
				},
			},
			// BoringSSL's DTLS implementation will drop the out-of-order
			// application data.
		},
		{
			protocol: dtls,
			name:     "AppDataAfterChangeCipherSpec-DTLS-Empty",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AppDataAfterChangeCipherSpec: []byte{},
				},
			},
			// BoringSSL's DTLS implementation will drop the out-of-order
			// application data.
		},
		{
			name: "AlertAfterChangeCipherSpec",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AlertAfterChangeCipherSpec: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":TLSV1_ALERT_RECORD_OVERFLOW:",
		},
		{
			protocol: dtls,
			name:     "AlertAfterChangeCipherSpec-DTLS",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					AlertAfterChangeCipherSpec: alertRecordOverflow,
				},
			},
			shouldFail:    true,
			expectedError: ":TLSV1_ALERT_RECORD_OVERFLOW:",
		},
		{
			name: "SendInvalidRecordType",
			config: Config{
				Bugs: ProtocolBugs{
					SendInvalidRecordType: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			protocol: dtls,
			name:     "SendInvalidRecordType-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SendInvalidRecordType: true,
				},
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			name: "FalseStart-SkipServerSecondLeg",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					SkipNewSessionTicket: true,
					SkipChangeCipherSpec: true,
					SkipFinished:         true,
					ExpectFalseStart:     true,
				},
			},
			flags: []string{
				"-false-start",
				"-handshake-never-done",
				"-advertise-alpn", "\x03foo",
				"-expect-alpn", "foo",
			},
			shimWritesFirst: true,
			shouldFail:      true,
			expectedError:   ":UNEXPECTED_RECORD:",
		},
		{
			name: "FalseStart-SkipServerSecondLeg-Implicit",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					SkipNewSessionTicket: true,
					SkipChangeCipherSpec: true,
					SkipFinished:         true,
				},
			},
			flags: []string{
				"-implicit-handshake",
				"-false-start",
				"-handshake-never-done",
				"-advertise-alpn", "\x03foo",
			},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_RECORD:",
		},
		{
			testType:           serverTest,
			name:               "FailEarlyCallback",
			flags:              []string{"-fail-early-callback"},
			shouldFail:         true,
			expectedError:      ":CONNECTION_REJECTED:",
			expectedLocalError: "remote error: handshake failure",
		},
		{
			name: "FailCertCallback-Client-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				ClientAuth: RequestClientCert,
			},
			flags:              []string{"-fail-cert-callback"},
			shouldFail:         true,
			expectedError:      ":CERT_CB_ERROR:",
			expectedLocalError: "remote error: internal error",
		},
		{
			testType: serverTest,
			name:     "FailCertCallback-Server-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			flags:              []string{"-fail-cert-callback"},
			shouldFail:         true,
			expectedError:      ":CERT_CB_ERROR:",
			expectedLocalError: "remote error: internal error",
		},
		{
			name: "FailCertCallback-Client-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				ClientAuth: RequestClientCert,
			},
			flags:              []string{"-fail-cert-callback"},
			shouldFail:         true,
			expectedError:      ":CERT_CB_ERROR:",
			expectedLocalError: "remote error: internal error",
		},
		{
			testType: serverTest,
			name:     "FailCertCallback-Server-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			flags:              []string{"-fail-cert-callback"},
			shouldFail:         true,
			expectedError:      ":CERT_CB_ERROR:",
			expectedLocalError: "remote error: internal error",
		},
		{
			protocol: dtls,
			name:     "FragmentMessageTypeMismatch-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
						f1 := next[0].Fragment(0, 1)
						f2 := next[0].Fragment(1, 1)
						f2.Type++
						c.WriteFragments([]DTLSFragment{f1, f2})
					},
				},
			},
			shouldFail:    true,
			expectedError: ":FRAGMENT_MISMATCH:",
		},
		{
			protocol: dtls,
			name:     "FragmentMessageLengthMismatch-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
						f1 := next[0].Fragment(0, 1)
						f2 := next[0].Fragment(1, 1)
						f2.TotalLength++
						c.WriteFragments([]DTLSFragment{f1, f2})
					},
				},
			},
			shouldFail:    true,
			expectedError: ":FRAGMENT_MISMATCH:",
		},
		{
			protocol: dtls,
			name:     "SplitFragments-Header-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SplitFragments: 2,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_HANDSHAKE_RECORD:",
		},
		{
			protocol: dtls,
			name:     "SplitFragments-Boundary-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SplitFragments: dtlsMaxRecordHeaderLen,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_HANDSHAKE_RECORD:",
		},
		{
			protocol: dtls,
			name:     "SplitFragments-Body-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SplitFragments: dtlsMaxRecordHeaderLen + 1,
				},
			},
			shouldFail:    true,
			expectedError: ":BAD_HANDSHAKE_RECORD:",
		},
		{
			protocol: dtls,
			name:     "SendEmptyFragments-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SendEmptyFragments: true,
				},
			},
		},
		{
			testType: serverTest,
			protocol: dtls,
			name:     "SendEmptyFragments-Padded-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					// Test empty fragments for a message with a
					// nice power-of-two length.
					PadClientHello:     64,
					SendEmptyFragments: true,
				},
			},
		},
		{
			name: "BadFinished-Client",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					BadFinished: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DIGEST_CHECK_FAILED:",
		},
		{
			name: "BadFinished-Client-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					BadFinished: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DIGEST_CHECK_FAILED:",
		},
		{
			testType: serverTest,
			name:     "BadFinished-Server",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					BadFinished: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DIGEST_CHECK_FAILED:",
		},
		{
			testType: serverTest,
			name:     "BadFinished-Server-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					BadFinished: true,
				},
			},
			shouldFail:    true,
			expectedError: ":DIGEST_CHECK_FAILED:",
		},
		{
			name: "FalseStart-BadFinished",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					BadFinished:      true,
					ExpectFalseStart: true,
				},
			},
			flags: []string{
				"-false-start",
				"-handshake-never-done",
				"-advertise-alpn", "\x03foo",
				"-expect-alpn", "foo",
			},
			shimWritesFirst: true,
			shouldFail:      true,
			expectedError:   ":DIGEST_CHECK_FAILED:",
		},
		{
			name: "NoFalseStart-NoALPN",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					ExpectFalseStart:          true,
					AlertBeforeFalseStartTest: alertAccessDenied,
				},
			},
			flags: []string{
				"-false-start",
			},
			shimWritesFirst:    true,
			shouldFail:         true,
			expectedError:      ":TLSV1_ALERT_ACCESS_DENIED:",
			expectedLocalError: "tls: peer did not false start: EOF",
		},
		{
			name: "FalseStart-NoALPNAllowed",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
				Bugs: ProtocolBugs{
					ExpectFalseStart: true,
				},
			},
			flags: []string{
				"-false-start",
				"-allow-false-start-without-alpn",
			},
			shimWritesFirst: true,
		},
		{
			name: "NoFalseStart-NoAEAD",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					ExpectFalseStart:          true,
					AlertBeforeFalseStartTest: alertAccessDenied,
				},
			},
			flags: []string{
				"-false-start",
				"-advertise-alpn", "\x03foo",
			},
			shimWritesFirst:    true,
			shouldFail:         true,
			expectedError:      ":TLSV1_ALERT_ACCESS_DENIED:",
			expectedLocalError: "tls: peer did not false start: EOF",
		},
		{
			name: "NoFalseStart-RSA",
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
				NextProtos:   []string{"foo"},
				Bugs: ProtocolBugs{
					ExpectFalseStart:          true,
					AlertBeforeFalseStartTest: alertAccessDenied,
				},
			},
			flags: []string{
				"-false-start",
				"-advertise-alpn", "\x03foo",
			},
			shimWritesFirst:    true,
			shouldFail:         true,
			expectedError:      ":TLSV1_ALERT_ACCESS_DENIED:",
			expectedLocalError: "tls: peer did not false start: EOF",
		},
		{
			protocol: dtls,
			name:     "SendSplitAlert-Sync",
			config: Config{
				Bugs: ProtocolBugs{
					SendSplitAlert: true,
				},
			},
		},
		{
			protocol: dtls,
			name:     "SendSplitAlert-Async",
			config: Config{
				Bugs: ProtocolBugs{
					SendSplitAlert: true,
				},
			},
			flags: []string{"-async"},
		},
		{
			name:             "SendEmptyRecords-Pass",
			sendEmptyRecords: 32,
		},
		{
			name:             "SendEmptyRecords",
			sendEmptyRecords: 33,
			shouldFail:       true,
			expectedError:    ":TOO_MANY_EMPTY_FRAGMENTS:",
		},
		{
			name:             "SendEmptyRecords-Async",
			sendEmptyRecords: 33,
			flags:            []string{"-async"},
			shouldFail:       true,
			expectedError:    ":TOO_MANY_EMPTY_FRAGMENTS:",
		},
		{
			name: "SendWarningAlerts-Pass",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			sendWarningAlerts: 4,
		},
		{
			protocol: dtls,
			name:     "SendWarningAlerts-DTLS-Pass",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			sendWarningAlerts: 4,
		},
		{
			name: "SendWarningAlerts-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			sendWarningAlerts:  4,
			shouldFail:         true,
			expectedError:      ":BAD_ALERT:",
			expectedLocalError: "remote error: error decoding message",
		},
		// Although TLS 1.3 intended to remove warning alerts, it left in
		// user_canceled. JDK11 misuses this alert as a post-handshake
		// full-duplex signal. As a workaround, skip user_canceled as in
		// TLS 1.2, which is consistent with NSS and OpenSSL.
		{
			name: "SendUserCanceledAlerts-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			sendUserCanceledAlerts: 4,
		},
		{
			name: "SendUserCanceledAlerts-TooMany-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			sendUserCanceledAlerts: 5,
			shouldFail:             true,
			expectedError:          ":TOO_MANY_WARNING_ALERTS:",
		},
		{
			name: "SendWarningAlerts-TooMany",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			sendWarningAlerts: 5,
			shouldFail:        true,
			expectedError:     ":TOO_MANY_WARNING_ALERTS:",
		},
		{
			name: "SendWarningAlerts-TooMany-Async",
			config: Config{
				MaxVersion: VersionTLS12,
			},
			sendWarningAlerts: 5,
			flags:             []string{"-async"},
			shouldFail:        true,
			expectedError:     ":TOO_MANY_WARNING_ALERTS:",
		},
		{
			name:               "SendBogusAlertType",
			sendBogusAlertType: true,
			shouldFail:         true,
			expectedError:      ":UNKNOWN_ALERT_TYPE:",
			expectedLocalError: "remote error: illegal parameter",
		},
		{
			protocol:           dtls,
			name:               "SendBogusAlertType-DTLS",
			sendBogusAlertType: true,
			shouldFail:         true,
			expectedError:      ":UNKNOWN_ALERT_TYPE:",
			expectedLocalError: "remote error: illegal parameter",
		},
		{
			name: "TooManyKeyUpdates",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			sendKeyUpdates:   33,
			keyUpdateRequest: keyUpdateNotRequested,
			shouldFail:       true,
			expectedError:    ":TOO_MANY_KEY_UPDATES:",
		},
		{
			name: "EmptySessionID",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
			noSessionCache: true,
			flags:          []string{"-expect-no-session"},
		},
		{
			name: "Unclean-Shutdown",
			config: Config{
				Bugs: ProtocolBugs{
					NoCloseNotify:     true,
					ExpectCloseNotify: true,
				},
			},
			shimShutsDown: true,
			flags:         []string{"-check-close-notify"},
			shouldFail:    true,
			expectedError: "Unexpected SSL_shutdown result: -1 != 1",
		},
		{
			name: "Unclean-Shutdown-Ignored",
			config: Config{
				Bugs: ProtocolBugs{
					NoCloseNotify: true,
				},
			},
			shimShutsDown: true,
		},
		{
			name: "Unclean-Shutdown-Alert",
			config: Config{
				Bugs: ProtocolBugs{
					SendAlertOnShutdown: alertDecompressionFailure,
					ExpectCloseNotify:   true,
				},
			},
			shimShutsDown: true,
			flags:         []string{"-check-close-notify"},
			shouldFail:    true,
			expectedError: ":SSLV3_ALERT_DECOMPRESSION_FAILURE:",
		},
		{
			name: "LargePlaintext",
			config: Config{
				Bugs: ProtocolBugs{
					SendLargeRecords: true,
				},
			},
			messageLen:         maxPlaintext + 1,
			shouldFail:         true,
			expectedError:      ":DATA_LENGTH_TOO_LONG:",
			expectedLocalError: "remote error: record overflow",
		},
		{
			protocol: dtls,
			name:     "LargePlaintext-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SendLargeRecords: true,
				},
			},
			messageLen:         maxPlaintext + 1,
			shouldFail:         true,
			expectedError:      ":DATA_LENGTH_TOO_LONG:",
			expectedLocalError: "remote error: record overflow",
		},
		{
			name: "LargePlaintext-TLS13-Padded-8192-8192",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					RecordPadding:    8192,
					SendLargeRecords: true,
				},
			},
			messageLen: 8192,
		},
		{
			name: "LargePlaintext-TLS13-Padded-8193-8192",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					RecordPadding:    8193,
					SendLargeRecords: true,
				},
			},
			messageLen:         8192,
			shouldFail:         true,
			expectedError:      ":DATA_LENGTH_TOO_LONG:",
			expectedLocalError: "remote error: record overflow",
		},
		{
			name: "LargePlaintext-TLS13-Padded-16383-1",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					RecordPadding:    1,
					SendLargeRecords: true,
				},
			},
			messageLen: 16383,
		},
		{
			name: "LargePlaintext-TLS13-Padded-16384-1",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					RecordPadding:    1,
					SendLargeRecords: true,
				},
			},
			messageLen:         16384,
			shouldFail:         true,
			expectedError:      ":DATA_LENGTH_TOO_LONG:",
			expectedLocalError: "remote error: record overflow",
		},
		{
			name: "LargeCiphertext",
			config: Config{
				Bugs: ProtocolBugs{
					SendLargeRecords: true,
				},
			},
			messageLen:    maxPlaintext * 2,
			shouldFail:    true,
			expectedError: ":ENCRYPTED_LENGTH_TOO_LONG:",
		},
		{
			protocol: dtls,
			name:     "LargeCiphertext-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SendLargeRecords: true,
				},
			},
			messageLen: maxPlaintext * 2,
			// Unlike the other four cases, DTLS drops records which
			// are invalid before authentication, so the connection
			// does not fail.
			expectMessageDropped: true,
		},
		{
			name:        "BadHelloRequest-1",
			renegotiate: 1,
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					BadHelloRequest: []byte{typeHelloRequest, 0, 0, 1, 1},
				},
			},
			flags: []string{
				"-renegotiate-freely",
				"-expect-total-renegotiations", "1",
			},
			shouldFail:    true,
			expectedError: ":BAD_HELLO_REQUEST:",
		},
		{
			name:        "BadHelloRequest-2",
			renegotiate: 1,
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					BadHelloRequest: []byte{typeServerKeyExchange, 0, 0, 0},
				},
			},
			flags: []string{
				"-renegotiate-freely",
				"-expect-total-renegotiations", "1",
			},
			shouldFail:    true,
			expectedError: ":BAD_HELLO_REQUEST:",
		},
		{
			testType: serverTest,
			name:     "SupportTicketsWithSessionID",
			config: Config{
				MaxVersion:             VersionTLS12,
				SessionTicketsDisabled: true,
			},
			resumeConfig: &Config{
				MaxVersion: VersionTLS12,
			},
			resumeSession: true,
		},
		{
			protocol: dtls,
			name:     "DTLS12-SendExtraFinished",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendExtraFinished: true,
				},
			},
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_RECORD:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "DTLS12-SendExtraFinished-Reordered",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					MaxHandshakeRecordLength:  2,
					ReorderHandshakeFragments: true,
					SendExtraFinished:         true,
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "DTLS12-SendExtraFinished-Packed",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendExtraFinished:      true,
					PackHandshakeFragments: 1000,
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "DTLS13-SendExtraFinished",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendExtraFinished: true,
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "DTLS13-SendExtraFinished-Reordered",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					MaxHandshakeRecordLength:  2,
					ReorderHandshakeFragments: true,
					SendExtraFinished:         true,
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			name:     "DTLS13-SendExtraFinished-Packed",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendExtraFinished:      true,
					PackHandshakeFragments: 1000,
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
		},
		{
			protocol: dtls,
			testType: serverTest,
			name:     "DTLS13-SendExtraFinished-AfterAppData",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SkipImplicitACKRead: true,
					WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
						if next[len(next)-1].Type != typeFinished {
							c.WriteFlight(next)
							return
						}

						// Complete the handshake.
						c.WriteFlight(next)
						c.ReadACK(c.InEpoch())

						// Send some application data. The shim is now on epoch 3.
						msg := []byte("hello")
						c.WriteAppData(c.OutEpoch(), msg)
						c.ReadAppData(c.InEpoch(), expectedReply(msg))

						// The shim is still accepting data from epoch 2, so it can
						// ACK a retransmit if needed, but it should not accept new
						// messages at epoch three.
						extraFinished := next[len(next)-1]
						extraFinished.Sequence++
						c.WriteFlight([]DTLSMessage{extraFinished})
					},
				},
			},
			shouldFail:         true,
			expectedError:      ":EXCESS_HANDSHAKE_DATA:",
			expectedLocalError: "remote error: unexpected message",
			// Disable tickets on the shim to avoid NewSessionTicket
			// interfering with the test callback.
			flags: []string{"-no-ticket"},
		},
		{
			testType: serverTest,
			name:     "V2ClientHello-EmptyRecordPrefix",
			config: Config{
				// Choose a cipher suite that does not involve
				// elliptic curves, so no extensions are
				// involved.
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
				Bugs: ProtocolBugs{
					SendV2ClientHello: true,
				},
			},
			sendPrefix: string([]byte{
				byte(recordTypeHandshake),
				3, 1, // version
				0, 0, // length
			}),
			// A no-op empty record may not be sent before V2ClientHello.
			shouldFail:    true,
			expectedError: ":WRONG_VERSION_NUMBER:",
		},
		{
			testType: serverTest,
			name:     "V2ClientHello-WarningAlertPrefix",
			config: Config{
				// Choose a cipher suite that does not involve
				// elliptic curves, so no extensions are
				// involved.
				MaxVersion:   VersionTLS12,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
				Bugs: ProtocolBugs{
					SendV2ClientHello: true,
				},
			},
			sendPrefix: string([]byte{
				byte(recordTypeAlert),
				3, 1, // version
				0, 2, // length
				alertLevelWarning, byte(alertDecompressionFailure),
			}),
			// A no-op warning alert may not be sent before V2ClientHello.
			shouldFail:    true,
			expectedError: ":WRONG_VERSION_NUMBER:",
		},
		{
			name: "SendSNIWarningAlert",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendSNIWarningAlert: true,
				},
			},
		},
		{
			testType: serverTest,
			name:     "ExtraCompressionMethods-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendCompressionMethods: []byte{1, 2, 3, compressionNone, 4, 5, 6},
				},
			},
		},
		{
			testType: serverTest,
			name:     "ExtraCompressionMethods-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendCompressionMethods: []byte{1, 2, 3, compressionNone, 4, 5, 6},
				},
			},
			shouldFail:         true,
			expectedError:      ":INVALID_COMPRESSION_LIST:",
			expectedLocalError: "remote error: illegal parameter",
		},
		{
			testType: serverTest,
			name:     "NoNullCompression-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendCompressionMethods: []byte{1, 2, 3, 4, 5, 6},
				},
			},
			shouldFail:         true,
			expectedError:      ":INVALID_COMPRESSION_LIST:",
			expectedLocalError: "remote error: illegal parameter",
		},
		{
			testType: serverTest,
			name:     "NoNullCompression-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendCompressionMethods: []byte{1, 2, 3, 4, 5, 6},
				},
			},
			shouldFail:         true,
			expectedError:      ":INVALID_COMPRESSION_LIST:",
			expectedLocalError: "remote error: illegal parameter",
		},
		// Test that the client rejects invalid compression methods
		// from the server.
		{
			testType: clientTest,
			name:     "InvalidCompressionMethod",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					SendCompressionMethod: 1,
				},
			},
			shouldFail:         true,
			expectedError:      ":UNSUPPORTED_COMPRESSION_ALGORITHM:",
			expectedLocalError: "remote error: illegal parameter",
		},
		{
			testType: clientTest,
			name:     "TLS13-InvalidCompressionMethod",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					SendCompressionMethod: 1,
				},
			},
			shouldFail:    true,
			expectedError: ":DECODE_ERROR:",
		},
		{
			testType: clientTest,
			name:     "TLS13-HRR-InvalidCompressionMethod",
			config: Config{
				MaxVersion:       VersionTLS13,
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					SendCompressionMethod: 1,
				},
			},
			shouldFail:         true,
			expectedError:      ":DECODE_ERROR:",
			expectedLocalError: "remote error: error decoding message",
		},
		{
			name: "GREASE-Client-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					ExpectGREASE: true,
				},
			},
			flags: []string{"-enable-grease"},
		},
		{
			name: "GREASE-Client-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectGREASE: true,
				},
			},
			flags: []string{"-enable-grease"},
		},
		{
			testType: serverTest,
			name:     "GREASE-Server-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					// TLS 1.3 servers are expected to
					// always enable GREASE. TLS 1.3 is new,
					// so there is no existing ecosystem to
					// worry about.
					ExpectGREASE: true,
				},
			},
		},
		{
			// Test the TLS 1.2 server so there is a large
			// unencrypted certificate as well as application data.
			testType: serverTest,
			name:     "MaxSendFragment-TLS12",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					MaxReceivePlaintext: 512,
				},
			},
			messageLen: 1024,
			flags: []string{
				"-max-send-fragment", "512",
				"-read-size", "1024",
			},
		},
		{
			// Test the TLS 1.2 server so there is a large
			// unencrypted certificate as well as application data.
			testType: serverTest,
			name:     "MaxSendFragment-TLS12-TooLarge",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					// Ensure that some of the records are
					// 512.
					MaxReceivePlaintext: 511,
				},
			},
			messageLen: 1024,
			flags: []string{
				"-max-send-fragment", "512",
				"-read-size", "1024",
			},
			shouldFail:         true,
			expectedLocalError: "local error: record overflow",
		},
		{
			// Test the TLS 1.3 server so there is a large encrypted
			// certificate as well as application data.
			testType: serverTest,
			name:     "MaxSendFragment-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					MaxReceivePlaintext:            512,
					ExpectPackedEncryptedHandshake: 512,
				},
			},
			messageLen: 1024,
			flags: []string{
				"-max-send-fragment", "512",
				"-read-size", "1024",
			},
		},
		{
			// Test the TLS 1.3 server so there is a large encrypted
			// certificate as well as application data.
			testType: serverTest,
			name:     "MaxSendFragment-TLS13-TooLarge",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					// Ensure that some of the records are
					// 512.
					MaxReceivePlaintext: 511,
				},
			},
			messageLen: 1024,
			flags: []string{
				"-max-send-fragment", "512",
				"-read-size", "1024",
			},
			shouldFail:         true,
			expectedLocalError: "local error: record overflow",
		},
		{
			// Test that handshake data is tightly packed in TLS 1.3.
			testType: serverTest,
			name:     "PackedEncryptedHandshake-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectPackedEncryptedHandshake: 16384,
				},
			},
		},
		{
			// Test that DTLS can handle multiple application data
			// records in a single packet.
			protocol: dtls,
			name:     "SplitAndPackAppData-DTLS",
			config: Config{
				Bugs: ProtocolBugs{
					SplitAndPackAppData: true,
				},
			},
		},
		{
			protocol: dtls,
			name:     "SplitAndPackAppData-DTLS-Async",
			config: Config{
				Bugs: ProtocolBugs{
					SplitAndPackAppData: true,
				},
			},
			flags: []string{"-async"},
		},
		{
			// DTLS 1.2 allows up to a 255-byte HelloVerifyRequest cookie, which
			// is the largest encodable value.
			protocol: dtls,
			name:     "DTLS-HelloVerifyRequest-255",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					HelloVerifyRequestCookieLength: 255,
				},
			},
		},
		{
			// DTLS 1.2 allows up to a 0-byte HelloVerifyRequest cookie, which
			// was probably a mistake in the spec but test that it works
			// nonetheless.
			protocol: dtls,
			name:     "DTLS-HelloVerifyRequest-0",
			config: Config{
				MaxVersion: VersionTLS12,
				Bugs: ProtocolBugs{
					EmptyHelloVerifyRequestCookie: true,
				},
			},
		},
	}
	testCases = append(testCases, basicTests...)

	// Test that very large messages can be received.
	cert := rsaCertificate
	for i := 0; i < 50; i++ {
		cert.Certificate = append(cert.Certificate, cert.Certificate[0])
	}
	testCases = append(testCases, testCase{
		name: "LargeMessage",
		config: Config{
			Credential: &cert,
		},
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "LargeMessage-DTLS",
		config: Config{
			Credential: &cert,
		},
	})

	// They are rejected if the maximum certificate chain length is capped.
	testCases = append(testCases, testCase{
		name: "LargeMessage-Reject",
		config: Config{
			Credential: &cert,
		},
		flags:         []string{"-max-cert-list", "16384"},
		shouldFail:    true,
		expectedError: ":EXCESSIVE_MESSAGE_SIZE:",
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "LargeMessage-Reject-DTLS",
		config: Config{
			Credential: &cert,
		},
		flags:         []string{"-max-cert-list", "16384"},
		shouldFail:    true,
		expectedError: ":EXCESSIVE_MESSAGE_SIZE:",
	})

	// Servers echoing the TLS 1.3 compatibility mode session ID should be
	// rejected.
	testCases = append(testCases, testCase{
		name: "EchoTLS13CompatibilitySessionID",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				EchoSessionIDInFullHandshake: true,
			},
		},
		shouldFail:         true,
		expectedError:      ":SERVER_ECHOED_INVALID_SESSION_ID:",
		expectedLocalError: "remote error: illegal parameter",
	})

	// Servers should reject QUIC client hellos that have a legacy
	// session ID.
	testCases = append(testCases, testCase{
		name:     "QUICCompatibilityMode",
		testType: serverTest,
		protocol: quic,
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				CompatModeWithQUIC: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_COMPATIBILITY_MODE:",
	})

	// Clients should reject DTLS 1.3 ServerHellos that echo the legacy
	// session ID.
	testCases = append(testCases, testCase{
		protocol:      dtls,
		name:          "DTLS13CompatibilityMode-EchoSessionID",
		resumeSession: true,
		config: Config{
			MaxVersion: VersionTLS12,
		},
		resumeConfig: &Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				DTLS13EchoSessionID: true,
			},
		},
		shouldFail:    true,
		expectedError: ":DECODE_ERROR:",
	})

	// DTLS 1.3 should work with record headers that don't set the
	// length bit or that use the short sequence number format.
	testCases = append(testCases, testCase{
		testType: clientTest,
		protocol: dtls,
		name:     "DTLS13RecordHeader-NoLength-Client",
		config: Config{
			MinVersion:                 VersionTLS13,
			DTLSRecordHeaderOmitLength: true,
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "DTLS13RecordHeader-NoLength-Server",
		config: Config{
			MinVersion:                 VersionTLS13,
			DTLSRecordHeaderOmitLength: true,
		},
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		protocol: dtls,
		name:     "DTLS13RecordHeader-ShortSeqNums-Client",
		config: Config{
			MinVersion:          VersionTLS13,
			DTLSUseShortSeqNums: true,
		},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "DTLS13RecordHeader-ShortSeqNums-Server",
		config: Config{
			MinVersion:          VersionTLS13,
			DTLSUseShortSeqNums: true,
		},
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "DTLS13RecordHeader-OldHeader",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				DTLSUsePlaintextRecordHeader: true,
			},
		},
		expectMessageDropped: true,
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "DTLS13RecordHeader-CIDBit",
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				DTLS13RecordHeaderSetCIDBit: true,
			},
		},
		expectMessageDropped: true,
	})

	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "DTLS13-MessageCallback-Client",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		flags: []string{
			"-expect-msg-callback",
			`write hs 1
read hs 2
read hs 8
read hs 11
read hs 15
read hs 20
write hs 20
read ack
read hs 4
read hs 4
read alert 1 0
`,
		},
	})

	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "DTLS13-MessageCallback-Server",
		config: Config{
			MaxVersion: VersionTLS13,
			MinVersion: VersionTLS13,
		},
		flags: []string{
			"-expect-msg-callback",
			`read hs 1
write hs 2
write hs 8
write hs 11
write hs 15
write hs 20
read hs 20
write ack
write hs 4
write hs 4
read ack
read ack
read alert 1 0
`,
		},
	})
}
