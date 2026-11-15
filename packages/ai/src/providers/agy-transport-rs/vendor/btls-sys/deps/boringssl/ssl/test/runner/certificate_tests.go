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

import "crypto/x509"

func makeCertPoolFromRoots(creds ...*Credential) *x509.CertPool {
	certPool := x509.NewCertPool()
	for _, cred := range creds {
		cert, err := x509.ParseCertificate(cred.RootCertificate)
		if err != nil {
			panic(err)
		}
		certPool.AddCert(cert)
	}
	return certPool
}

func addClientAuthTests() {
	// Add a dummy cert pool to stress certificate authority parsing.
	certPool := makeCertPoolFromRoots(&rsaCertificate, &rsa1024Certificate)
	caNames := certPool.Subjects()

	for _, ver := range tlsVersions {
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     ver.name + "-Client-ClientAuth-RSA",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				ClientAuth: RequireAnyClientCert,
				ClientCAs:  certPool,
			},
			shimCertificate: &rsaCertificate,
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     ver.name + "-Server-ClientAuth-RSA",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
			},
			flags: []string{"-require-any-client-certificate"},
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     ver.name + "-Server-ClientAuth-ECDSA",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &ecdsaP256Certificate,
			},
			flags: []string{"-require-any-client-certificate"},
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     ver.name + "-Client-ClientAuth-ECDSA",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				ClientAuth: RequireAnyClientCert,
				ClientCAs:  certPool,
			},
			shimCertificate: &ecdsaP256Certificate,
		})

		testCases = append(testCases, testCase{
			name: "NoClientCertificate-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				ClientAuth: RequireAnyClientCert,
			},
			shouldFail:         true,
			expectedLocalError: "client didn't provide a certificate",
		})

		testCases = append(testCases, testCase{
			// Even if not configured to expect a certificate, OpenSSL will
			// return X509_V_OK as the verify_result.
			testType: serverTest,
			name:     "NoClientCertificateRequested-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
			},
			flags: []string{
				"-expect-verify-result",
			},
			resumeSession: true,
		})

		testCases = append(testCases, testCase{
			// If a client certificate is not provided, OpenSSL will still
			// return X509_V_OK as the verify_result.
			testType: serverTest,
			name:     "NoClientCertificate-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
			},
			flags: []string{
				"-expect-verify-result",
				"-verify-peer",
			},
			resumeSession: true,
		})

		certificateRequired := "remote error: certificate required"
		if ver.version < VersionTLS13 {
			// Prior to TLS 1.3, the generic handshake_failure alert
			// was used.
			certificateRequired = "remote error: handshake failure"
		}
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RequireAnyClientCertificate-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
			},
			flags:              []string{"-require-any-client-certificate"},
			shouldFail:         true,
			expectedError:      ":PEER_DID_NOT_RETURN_A_CERTIFICATE:",
			expectedLocalError: certificateRequired,
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "SkipClientCertificate-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Bugs: ProtocolBugs{
					SkipClientCertificate: true,
				},
			},
			// Setting SSL_VERIFY_PEER allows anonymous clients.
			flags:         []string{"-verify-peer"},
			shouldFail:    true,
			expectedError: ":UNEXPECTED_MESSAGE:",
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     ver.name + "-Server-CertReq-CA-List",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
				Bugs: ProtocolBugs{
					ExpectCertificateReqNames: caNames,
				},
			},
			flags: []string{
				"-require-any-client-certificate",
				"-use-client-ca-list", encodeDERValues(caNames),
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     ver.name + "-Client-CertReq-CA-List",
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
				ClientAuth: RequireAnyClientCert,
				ClientCAs:  certPool,
			},
			shimCertificate: &rsaCertificate,
			flags: []string{
				"-expect-client-ca-list", encodeDERValues(caNames),
			},
		})
	}

	// Client auth is only legal in certificate-based ciphers.
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ClientAuth-PSK",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_PSK_WITH_AES_128_CBC_SHA},
			PreSharedKey: []byte("secret"),
			ClientAuth:   RequireAnyClientCert,
		},
		shimCertificate: &rsaCertificate,
		flags: []string{
			"-psk", "secret",
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})
	testCases = append(testCases, testCase{
		testType: clientTest,
		name:     "ClientAuth-ECDHE_PSK",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA},
			PreSharedKey: []byte("secret"),
			ClientAuth:   RequireAnyClientCert,
		},
		shimCertificate: &rsaCertificate,
		flags: []string{
			"-psk", "secret",
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_MESSAGE:",
	})

	// Regression test for a bug where the client CA list, if explicitly
	// set to NULL, was mis-encoded.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "Null-Client-CA-List",
		config: Config{
			MaxVersion: VersionTLS12,
			Credential: &rsaCertificate,
			Bugs: ProtocolBugs{
				ExpectCertificateReqNames: [][]byte{},
			},
		},
		flags: []string{
			"-require-any-client-certificate",
			"-use-client-ca-list", "<NULL>",
		},
	})

	// Test that an empty client CA list doesn't send a CA extension.
	// (This is implicitly tested by the parser. An empty CA extension is
	// a syntax error.)
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "TLS13-Empty-Client-CA-List",
		config: Config{
			MaxVersion: VersionTLS13,
			Credential: &rsaCertificate,
		},
		flags: []string{
			"-require-any-client-certificate",
			"-use-client-ca-list", "<EMPTY>",
		},
	})
}

func addCertificateTests() {
	for _, ver := range tlsVersions {
		// Test that a certificate chain with intermediate may be sent
		// and received as both client and server.
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "SendReceiveIntermediate-Client-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaChainCertificate,
				ClientAuth: RequireAnyClientCert,
			},
			expectations: connectionExpectations{
				peerCertificate: &rsaChainCertificate,
			},
			shimCertificate: &rsaChainCertificate,
			flags: []string{
				"-expect-peer-cert-file", rsaChainCertificate.ChainPath,
			},
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "SendReceiveIntermediate-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaChainCertificate,
			},
			expectations: connectionExpectations{
				peerCertificate: &rsaChainCertificate,
			},
			shimCertificate: &rsaChainCertificate,
			flags: []string{
				"-require-any-client-certificate",
				"-expect-peer-cert-file", rsaChainCertificate.ChainPath,
			},
		})

		// Test that garbage leaf certificates are properly rejected.
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "GarbageCertificate-Client-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &garbageCertificate,
			},
			shouldFail:         true,
			expectedError:      ":CANNOT_PARSE_LEAF_CERT:",
			expectedLocalError: "remote error: error decoding message",
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "GarbageCertificate-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &garbageCertificate,
			},
			flags:              []string{"-require-any-client-certificate"},
			shouldFail:         true,
			expectedError:      ":CANNOT_PARSE_LEAF_CERT:",
			expectedLocalError: "remote error: error decoding message",
		})
	}
}

func addRetainOnlySHA256ClientCertTests() {
	for _, ver := range tlsVersions {
		// Test that enabling
		// SSL_CTX_set_retain_only_sha256_of_client_certs without
		// actually requesting a client certificate is a no-op.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RetainOnlySHA256-NoCert-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
			},
			flags: []string{
				"-on-initial-retain-only-sha256-client-cert",
				"-on-resume-retain-only-sha256-client-cert",
			},
			resumeSession: true,
		})

		// Test that when retaining only a SHA-256 certificate is
		// enabled, the hash appears as expected.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RetainOnlySHA256-Cert-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-verify-peer",
				"-on-initial-retain-only-sha256-client-cert",
				"-on-resume-retain-only-sha256-client-cert",
				"-on-initial-expect-sha256-client-cert",
				"-on-resume-expect-sha256-client-cert",
			},
			resumeSession: true,
		})

		// Test that when the config changes from on to off, a
		// resumption is rejected because the server now wants the full
		// certificate chain.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RetainOnlySHA256-OnOff-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-verify-peer",
				"-on-initial-retain-only-sha256-client-cert",
				"-on-initial-expect-sha256-client-cert",
			},
			resumeSession:        true,
			expectResumeRejected: true,
		})

		// Test that when the config changes from off to on, a
		// resumption is rejected because the server now wants just the
		// hash.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RetainOnlySHA256-OffOn-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &rsaCertificate,
			},
			flags: []string{
				"-verify-peer",
				"-on-resume-retain-only-sha256-client-cert",
				"-on-resume-expect-sha256-client-cert",
			},
			resumeSession:        true,
			expectResumeRejected: true,
		})
	}
}
