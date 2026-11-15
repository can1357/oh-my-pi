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
	"strconv"
	"strings"
)

type testCipherSuite struct {
	name string
	id   uint16
}

var testCipherSuites = []testCipherSuite{
	{"RSA_WITH_3DES_EDE_CBC_SHA", TLS_RSA_WITH_3DES_EDE_CBC_SHA},
	{"RSA_WITH_AES_128_GCM_SHA256", TLS_RSA_WITH_AES_128_GCM_SHA256},
	{"RSA_WITH_AES_128_CBC_SHA", TLS_RSA_WITH_AES_128_CBC_SHA},
	{"RSA_WITH_AES_256_GCM_SHA384", TLS_RSA_WITH_AES_256_GCM_SHA384},
	{"RSA_WITH_AES_256_CBC_SHA", TLS_RSA_WITH_AES_256_CBC_SHA},
	{"ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
	{"ECDHE_ECDSA_WITH_AES_128_CBC_SHA", TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA},
	{"ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384},
	{"ECDHE_ECDSA_WITH_AES_256_CBC_SHA", TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA},
	{"ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256},
	{"ECDHE_RSA_WITH_AES_128_GCM_SHA256", TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
	{"ECDHE_RSA_WITH_AES_128_CBC_SHA", TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
	{"ECDHE_RSA_WITH_AES_128_CBC_SHA256", TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256},
	{"ECDHE_RSA_WITH_AES_256_GCM_SHA384", TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384},
	{"ECDHE_RSA_WITH_AES_256_CBC_SHA", TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA},
	{"ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
	{"PSK_WITH_AES_128_CBC_SHA", TLS_PSK_WITH_AES_128_CBC_SHA},
	{"PSK_WITH_AES_256_CBC_SHA", TLS_PSK_WITH_AES_256_CBC_SHA},
	{"ECDHE_PSK_WITH_AES_128_CBC_SHA", TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA},
	{"ECDHE_PSK_WITH_AES_256_CBC_SHA", TLS_ECDHE_PSK_WITH_AES_256_CBC_SHA},
	{"ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256", TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256},
	{"CHACHA20_POLY1305_SHA256", TLS_CHACHA20_POLY1305_SHA256},
	{"AES_128_GCM_SHA256", TLS_AES_128_GCM_SHA256},
	{"AES_256_GCM_SHA384", TLS_AES_256_GCM_SHA384},
}

func hasComponent(suiteName, component string) bool {
	return strings.Contains("_"+suiteName+"_", "_"+component+"_")
}

func isTLS12Only(suiteName string) bool {
	return hasComponent(suiteName, "GCM") ||
		hasComponent(suiteName, "SHA256") ||
		hasComponent(suiteName, "SHA384") ||
		hasComponent(suiteName, "POLY1305")
}

func isTLS13Suite(suiteName string) bool {
	return !hasComponent(suiteName, "WITH")
}

func addTestForCipherSuite(suite testCipherSuite, ver tlsVersion, protocol protocol) {
	const psk = "12345"
	const pskIdentity = "luggage combo"

	if !ver.supportsProtocol(protocol) {
		return
	}
	prefix := protocol.String() + "-"

	var cert *Credential
	if isTLS13Suite(suite.name) {
		cert = &rsaCertificate
	} else if hasComponent(suite.name, "ECDSA") {
		cert = &ecdsaP256Certificate
	} else if hasComponent(suite.name, "RSA") {
		cert = &rsaCertificate
	}

	var flags []string
	if hasComponent(suite.name, "PSK") {
		flags = append(flags,
			"-psk", psk,
			"-psk-identity", pskIdentity)
	}

	if hasComponent(suite.name, "3DES") {
		// BoringSSL disables 3DES ciphers by default.
		flags = append(flags, "-cipher", "3DES")
	}

	var shouldFail bool
	if isTLS12Only(suite.name) && ver.version < VersionTLS12 {
		shouldFail = true
	}
	if !isTLS13Suite(suite.name) && ver.version >= VersionTLS13 {
		shouldFail = true
	}
	if isTLS13Suite(suite.name) && ver.version < VersionTLS13 {
		shouldFail = true
	}

	var sendCipherSuite uint16
	var expectedServerError, expectedClientError string
	serverCipherSuites := []uint16{suite.id}
	if shouldFail {
		expectedServerError = ":NO_SHARED_CIPHER:"
		if ver.version >= VersionTLS13 && cert == nil {
			// TLS 1.2 PSK ciphers won't configure a server certificate, but we
			// require one in TLS 1.3.
			expectedServerError = ":NO_CERTIFICATE_SET:"
		}
		expectedClientError = ":WRONG_CIPHER_RETURNED:"
		// Configure the server to select ciphers as normal but
		// select an incompatible cipher in ServerHello.
		serverCipherSuites = nil
		sendCipherSuite = suite.id
	}

	// Verify exporters interoperate.
	exportKeyingMaterial := 1024

	if ver.version != VersionTLS13 || !ver.hasDTLS {
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + ver.name + "-" + suite.name + "-server",
			config: Config{
				MinVersion:           ver.version,
				MaxVersion:           ver.version,
				CipherSuites:         []uint16{suite.id},
				Credential:           cert,
				PreSharedKey:         []byte(psk),
				PreSharedKeyIdentity: pskIdentity,
				Bugs: ProtocolBugs{
					AdvertiseAllConfiguredCiphers: true,
				},
			},
			shimCertificate:      cert,
			flags:                flags,
			resumeSession:        true,
			shouldFail:           shouldFail,
			expectedError:        expectedServerError,
			exportKeyingMaterial: exportKeyingMaterial,
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + ver.name + "-" + suite.name + "-client",
			config: Config{
				MinVersion:           ver.version,
				MaxVersion:           ver.version,
				CipherSuites:         serverCipherSuites,
				Credential:           cert,
				PreSharedKey:         []byte(psk),
				PreSharedKeyIdentity: pskIdentity,
				Bugs: ProtocolBugs{
					IgnorePeerCipherPreferences: shouldFail,
					SendCipherSuite:             sendCipherSuite,
				},
			},
			flags:                flags,
			resumeSession:        true,
			shouldFail:           shouldFail,
			expectedError:        expectedClientError,
			exportKeyingMaterial: exportKeyingMaterial,
		})
	}

	if shouldFail {
		return
	}

	// Ensure the maximum record size is accepted.
	testCases = append(testCases, testCase{
		protocol: protocol,
		name:     prefix + ver.name + "-" + suite.name + "-LargeRecord",
		config: Config{
			MinVersion:           ver.version,
			MaxVersion:           ver.version,
			CipherSuites:         []uint16{suite.id},
			Credential:           cert,
			PreSharedKey:         []byte(psk),
			PreSharedKeyIdentity: pskIdentity,
		},
		flags:      flags,
		messageLen: maxPlaintext,
	})

	// Test bad records for all ciphers. Bad records are fatal in TLS
	// and ignored in DTLS.
	shouldFail = protocol == tls
	var expectedError string
	if shouldFail {
		expectedError = ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:"
	}

	// When QUIC is used, the QUIC stack handles record encryption/decryption.
	// Thus it is not possible for the TLS stack in QUIC mode to receive a
	// bad record (i.e. one that fails to decrypt).
	if protocol != quic {
		testCases = append(testCases, testCase{
			protocol: protocol,
			name:     prefix + ver.name + "-" + suite.name + "-BadRecord",
			config: Config{
				MinVersion:           ver.version,
				MaxVersion:           ver.version,
				CipherSuites:         []uint16{suite.id},
				Credential:           cert,
				PreSharedKey:         []byte(psk),
				PreSharedKeyIdentity: pskIdentity,
			},
			flags:            flags,
			damageFirstWrite: true,
			messageLen:       maxPlaintext,
			shouldFail:       shouldFail,
			expectedError:    expectedError,
		})
	}
}

func addCipherSuiteTests() {
	const bogusCipher = 0xfe00

	for _, suite := range testCipherSuites {
		for _, ver := range tlsVersions {
			for _, protocol := range []protocol{tls, dtls, quic} {
				addTestForCipherSuite(suite, ver, protocol)
			}
		}
	}

	testCases = append(testCases, testCase{
		name: "NoSharedCipher",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{},
		},
		shouldFail:    true,
		expectedError: ":HANDSHAKE_FAILURE_ON_CLIENT_HELLO:",
	})

	testCases = append(testCases, testCase{
		name: "NoSharedCipher-TLS13",
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{},
		},
		shouldFail:    true,
		expectedError: ":HANDSHAKE_FAILURE_ON_CLIENT_HELLO:",
	})

	testCases = append(testCases, testCase{
		name: "UnsupportedCipherSuite",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
			Bugs: ProtocolBugs{
				IgnorePeerCipherPreferences: true,
			},
		},
		flags:         []string{"-cipher", "DEFAULT:!AES"},
		shouldFail:    true,
		expectedError: ":WRONG_CIPHER_RETURNED:",
	})

	testCases = append(testCases, testCase{
		name: "ServerHelloBogusCipher",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				SendCipherSuite: bogusCipher,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CIPHER_RETURNED:",
	})
	testCases = append(testCases, testCase{
		name: "ServerHelloBogusCipher-TLS13",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				SendCipherSuite: bogusCipher,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CIPHER_RETURNED:",
	})

	// The server must be tolerant to bogus ciphers.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "UnknownCipher",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{bogusCipher, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				AdvertiseAllConfiguredCiphers: true,
			},
		},
	})

	// The server must be tolerant to bogus ciphers.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "UnknownCipher-TLS13",
		config: Config{
			MaxVersion:   VersionTLS13,
			CipherSuites: []uint16{bogusCipher, TLS_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				AdvertiseAllConfiguredCiphers: true,
			},
		},
	})

	// Test empty ECDHE_PSK identity hints work as expected.
	testCases = append(testCases, testCase{
		name: "EmptyECDHEPSKHint",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA},
			PreSharedKey: []byte("secret"),
		},
		flags: []string{"-psk", "secret"},
	})

	// Test empty PSK identity hints work as expected, even if an explicit
	// ServerKeyExchange is sent.
	testCases = append(testCases, testCase{
		name: "ExplicitEmptyPSKHint",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_PSK_WITH_AES_128_CBC_SHA},
			PreSharedKey: []byte("secret"),
			Bugs: ProtocolBugs{
				AlwaysSendPreSharedKeyIdentityHint: true,
			},
		},
		flags: []string{"-psk", "secret"},
	})

	// Test that clients enforce that the server-sent certificate and cipher
	// suite match in TLS 1.2.
	testCases = append(testCases, testCase{
		name: "CertificateCipherMismatch-RSA",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
			Credential:   &rsaCertificate,
			Bugs: ProtocolBugs{
				SendCipherSuite: TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CERTIFICATE_TYPE:",
	})
	testCases = append(testCases, testCase{
		name: "CertificateCipherMismatch-ECDSA",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			Credential:   &ecdsaP256Certificate,
			Bugs: ProtocolBugs{
				SendCipherSuite: TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CERTIFICATE_TYPE:",
	})
	testCases = append(testCases, testCase{
		name: "CertificateCipherMismatch-Ed25519",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
			Credential:   &ed25519Certificate,
			Bugs: ProtocolBugs{
				SendCipherSuite: TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			},
		},
		shouldFail:    true,
		expectedError: ":WRONG_CERTIFICATE_TYPE:",
	})

	// id-RSASSA-PSS keys should not match RSA decryption cipher suites.
	testCases = append(testCases, testCase{
		name: "CertificateCipherMismatch-PSS",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
			Credential:   &pssCertificate,
		},
		shouldFail:    true,
		expectedError: ":UNSUPPORTED_ALGORITHM:",
	})

	// Test that servers decline to select a cipher suite which is
	// inconsistent with their configured certificate.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerCipherFilter-RSA",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
		},
		shimCertificate: &rsaCertificate,
		shouldFail:      true,
		expectedError:   ":NO_SHARED_CIPHER:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerCipherFilter-ECDSA",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
		},
		shimCertificate: &ecdsaP256Certificate,
		shouldFail:      true,
		expectedError:   ":NO_SHARED_CIPHER:",
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "ServerCipherFilter-Ed25519",
		config: Config{
			MaxVersion:   VersionTLS12,
			CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
		},
		shimCertificate: &ed25519Certificate,
		shouldFail:      true,
		expectedError:   ":NO_SHARED_CIPHER:",
	})

	// Test cipher suite negotiation works as expected. Configure a
	// complicated cipher suite configuration.
	const negotiationTestCiphers = "" +
		"TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:" +
		"[TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384|TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256|TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA]:" +
		"TLS_RSA_WITH_AES_128_GCM_SHA256:" +
		"TLS_RSA_WITH_AES_128_CBC_SHA:" +
		"[TLS_RSA_WITH_AES_256_GCM_SHA384|TLS_RSA_WITH_AES_256_CBC_SHA]"
	negotiationTests := []struct {
		ciphers  []uint16
		expected uint16
	}{
		// Server preferences are honored, including when
		// equipreference groups are involved.
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_128_CBC_SHA,
				TLS_RSA_WITH_AES_128_GCM_SHA256,
				TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
				TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			},
			TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		},
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_128_CBC_SHA,
				TLS_RSA_WITH_AES_128_GCM_SHA256,
				TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			},
			TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		},
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_128_CBC_SHA,
				TLS_RSA_WITH_AES_128_GCM_SHA256,
			},
			TLS_RSA_WITH_AES_128_GCM_SHA256,
		},
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_128_CBC_SHA,
			},
			TLS_RSA_WITH_AES_128_CBC_SHA,
		},
		// Equipreference groups use the client preference.
		{
			[]uint16{
				TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
				TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			},
			TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		},
		{
			[]uint16{
				TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			},
			TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		{
			[]uint16{
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			},
			TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		},
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_256_CBC_SHA,
			},
			TLS_RSA_WITH_AES_256_GCM_SHA384,
		},
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_CBC_SHA,
				TLS_RSA_WITH_AES_256_GCM_SHA384,
			},
			TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		// If there are two equipreference groups, the preferred one
		// takes precedence.
		{
			[]uint16{
				TLS_RSA_WITH_AES_256_GCM_SHA384,
				TLS_RSA_WITH_AES_256_CBC_SHA,
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			},
			TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		},
	}
	for i, t := range negotiationTests {
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CipherNegotiation-" + strconv.Itoa(i),
			config: Config{
				MaxVersion:   VersionTLS12,
				CipherSuites: t.ciphers,
			},
			flags: []string{"-cipher", negotiationTestCiphers},
			expectations: connectionExpectations{
				cipher: t.expected,
			},
		})
	}
}

func addRSAClientKeyExchangeTests() {
	for bad := RSABadValue(1); bad < NumRSABadValues; bad++ {
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     fmt.Sprintf("BadRSAClientKeyExchange-%d", bad),
			config: Config{
				// Ensure the ClientHello version and final
				// version are different, to detect if the
				// server uses the wrong one.
				MaxVersion:   VersionTLS11,
				CipherSuites: []uint16{TLS_RSA_WITH_AES_128_CBC_SHA},
				Bugs: ProtocolBugs{
					BadRSAClientKeyExchange: bad,
				},
			},
			shouldFail:    true,
			expectedError: ":DECRYPTION_FAILED_OR_BAD_RECORD_MAC:",
		})
	}

	// The server must compare whatever was in ClientHello.version for the
	// RSA premaster.
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "SendClientVersion-RSA",
		config: Config{
			CipherSuites: []uint16{TLS_RSA_WITH_AES_128_GCM_SHA256},
			Bugs: ProtocolBugs{
				SendClientVersion: 0x1234,
			},
		},
		flags: []string{"-max-version", strconv.Itoa(VersionTLS12)},
	})
}
