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
	"strconv"
	"strings"
	"time"

	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/hpke"
)

type echCipher struct {
	name   string
	cipher HPKECipherSuite
}

var echCiphers = []echCipher{
	{
		name:   "HKDF-SHA256-AES-128-GCM",
		cipher: HPKECipherSuite{KDF: hpke.HKDFSHA256, AEAD: hpke.AES128GCM},
	},
	{
		name:   "HKDF-SHA256-AES-256-GCM",
		cipher: HPKECipherSuite{KDF: hpke.HKDFSHA256, AEAD: hpke.AES256GCM},
	},
	{
		name:   "HKDF-SHA256-ChaCha20-Poly1305",
		cipher: HPKECipherSuite{KDF: hpke.HKDFSHA256, AEAD: hpke.ChaCha20Poly1305},
	},
}

// generateServerECHConfig constructs a ServerECHConfig with a fresh X25519
// keypair and using |template| as a template for the ECHConfig. If fields are
// omitted, defaults are used.
func generateServerECHConfig(template *ECHConfig) ServerECHConfig {
	publicKey, secretKey, err := hpke.GenerateKeyPairX25519()
	if err != nil {
		panic(err)
	}
	templateCopy := *template
	if templateCopy.KEM == 0 {
		templateCopy.KEM = hpke.X25519WithHKDFSHA256
	}
	if len(templateCopy.PublicKey) == 0 {
		templateCopy.PublicKey = publicKey
	}
	if len(templateCopy.CipherSuites) == 0 {
		templateCopy.CipherSuites = make([]HPKECipherSuite, len(echCiphers))
		for i, cipher := range echCiphers {
			templateCopy.CipherSuites[i] = cipher.cipher
		}
	}
	if len(templateCopy.PublicName) == 0 {
		templateCopy.PublicName = "public.example"
	}
	if templateCopy.MaxNameLen == 0 {
		templateCopy.MaxNameLen = 64
	}
	return ServerECHConfig{ECHConfig: CreateECHConfig(&templateCopy), Key: secretKey}
}

func addEncryptedClientHelloTests() {
	// echConfig's ConfigID should match the one used in ssl/test/fuzzer.h.
	echConfig := generateServerECHConfig(&ECHConfig{ConfigID: 42})
	echConfig1 := generateServerECHConfig(&ECHConfig{ConfigID: 43})
	echConfig2 := generateServerECHConfig(&ECHConfig{ConfigID: 44})
	echConfig3 := generateServerECHConfig(&ECHConfig{ConfigID: 45})
	echConfigRepeatID := generateServerECHConfig(&ECHConfig{ConfigID: 42})

	echSecretCertificate := rootCA.Issue(X509Info{
		PrivateKey: &rsa2048Key,
		DNSNames:   []string{"secret.example"},
	}).ToCredential()
	echPublicCertificate := rootCA.Issue(X509Info{
		PrivateKey: &rsa2048Key,
		DNSNames:   []string{"public.example"},
	}).ToCredential()
	echLongNameCertificate := rootCA.Issue(X509Info{
		PrivateKey: &ecdsaP256Key,
		DNSNames:   []string{"test0123456789.example"},
	}).ToCredential()

	for _, protocol := range []protocol{tls, quic, dtls} {
		prefix := protocol.String() + "-"

		// There are two ClientHellos, so many of our tests have
		// HelloRetryRequest variations.
		for _, hrr := range []bool{false, true} {
			var suffix string
			var defaultCurves []CurveID
			if hrr {
				suffix = "-HelloRetryRequest"
				// Require a HelloRetryRequest for every curve.
				defaultCurves = []CurveID{}
			}

			// Test the server can accept ECH.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server" + suffix,
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					DefaultCurves:   defaultCurves,
				},
				resumeSession: true,
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test the server can accept ECH with a minimal ClientHelloOuter.
			// This confirms that the server does not unexpectedly pick up
			// fields from the wrong ClientHello.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-MinimalClientHelloOuter" + suffix,
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					DefaultCurves:   defaultCurves,
					Bugs: ProtocolBugs{
						MinimalClientHelloOuter: true,
					},
				},
				resumeSession: true,
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test that the server can decline ECH. In particular, it must send
			// retry configs.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-Decline" + suffix,
				config: Config{
					ServerName:    "secret.example",
					DefaultCurves: defaultCurves,
					// The client uses an ECHConfig that the server does not understand
					// so we can observe which retry configs the server sends back.
					ClientECHConfig: echConfig.ECHConfig,
					Bugs: ProtocolBugs{
						OfferSessionInClientHelloOuter: true,
						ExpectECHRetryConfigs:          CreateECHConfigList(echConfig2.ECHConfig.Raw, echConfig3.ECHConfig.Raw),
					},
				},
				resumeSession: true,
				flags: []string{
					// Configure three ECHConfigs on the shim, only two of which
					// should be sent in retry configs.
					"-ech-server-config", base64FlagValue(echConfig1.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig1.Key),
					"-ech-is-retry-config", "0",
					"-ech-server-config", base64FlagValue(echConfig2.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig2.Key),
					"-ech-is-retry-config", "1",
					"-ech-server-config", base64FlagValue(echConfig3.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig3.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "public.example",
				},
			})

			// Test that the server considers a ClientHelloInner indicating TLS
			// 1.2 to be a fatal error.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-TLS12InInner" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					Bugs: ProtocolBugs{
						AllowTLS12InClientHelloInner: true,
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_CLIENT_HELLO_INNER:",
			})

			// When inner ECH extension is absent from the ClientHelloInner, the
			// server should fail the connection.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-MissingECHInner" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					Bugs: ProtocolBugs{
						OmitECHInner:       !hrr,
						OmitSecondECHInner: hrr,
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_CLIENT_HELLO_INNER:",
			})

			// Test that the server can decode ech_outer_extensions.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionKeyShare,
						extensionSupportedCurves,
						// Include a custom extension, to test that unrecognized
						// extensions are also decoded.
						extensionCustom,
					},
					Bugs: ProtocolBugs{
						CustomExtension:                    "test",
						OnlyCompressSecondClientHelloInner: hrr,
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test that the server allows referenced ClientHelloOuter
			// extensions to be interleaved with other extensions. Only the
			// relative order must match.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions-Interleaved" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionKeyShare,
						extensionSupportedCurves,
						extensionCustom,
					},
					Bugs: ProtocolBugs{
						CustomExtension:                    "test",
						OnlyCompressSecondClientHelloInner: hrr,
						ECHOuterExtensionOrder: []uint16{
							extensionServerName,
							extensionKeyShare,
							extensionSupportedVersions,
							extensionPSKKeyExchangeModes,
							extensionSupportedCurves,
							extensionSignatureAlgorithms,
							extensionCustom,
						},
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test that the server rejects references to extensions in the
			// wrong order.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions-WrongOrder" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionKeyShare,
						extensionSupportedCurves,
					},
					Bugs: ProtocolBugs{
						CustomExtension:                    "test",
						OnlyCompressSecondClientHelloInner: hrr,
						ECHOuterExtensionOrder: []uint16{
							extensionSupportedCurves,
							extensionKeyShare,
						},
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_OUTER_EXTENSION:",
			})

			// Test that the server rejects duplicated values in ech_outer_extensions.
			// Besides causing the server to reconstruct an invalid ClientHelloInner
			// with duplicated extensions, this behavior would be vulnerable to DoS
			// attacks.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions-Duplicate" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionSupportedCurves,
						extensionSupportedCurves,
					},
					Bugs: ProtocolBugs{
						OnlyCompressSecondClientHelloInner: hrr,
						// Don't duplicate the extension in ClientHelloOuter.
						ECHOuterExtensionOrder: []uint16{
							extensionSupportedCurves,
						},
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_OUTER_EXTENSION:",
			})

			// Test that the server rejects references to missing extensions in
			// ech_outer_extensions.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions-Missing" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionCustom,
					},
					Bugs: ProtocolBugs{
						OnlyCompressSecondClientHelloInner: hrr,
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_OUTER_EXTENSION:",
			})

			// Test that the server rejects a references to the ECH extension in
			// ech_outer_extensions. The ECH extension is not authenticated in the
			// AAD and would result in an invalid ClientHelloInner.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-OuterExtensions-SelfReference" + suffix,
				config: Config{
					ServerName:      "secret.example",
					DefaultCurves:   defaultCurves,
					ClientECHConfig: echConfig.ECHConfig,
					ECHOuterExtensions: []uint16{
						extensionEncryptedClientHello,
					},
					Bugs: ProtocolBugs{
						OnlyCompressSecondClientHelloInner: hrr,
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: illegal parameter",
				expectedError:      ":INVALID_OUTER_EXTENSION:",
			})

			// Test the message callback is correctly reported with ECH.
			clientAndServerHello := "read hs 1\nread clienthelloinner\nwrite hs 2\n"
			expectMsgCallback := clientAndServerHello
			if protocol == tls {
				expectMsgCallback += "write ccs\n"
			}
			if hrr {
				expectMsgCallback += clientAndServerHello
			}
			// EncryptedExtensions onwards.
			expectMsgCallback += `write hs 8
write hs 11
write hs 15
write hs 20
read hs 20
write ack
write hs 4
write hs 4
read ack
read ack
`
			if protocol != dtls {
				expectMsgCallback = strings.ReplaceAll(expectMsgCallback, "write ack\n", "")
				expectMsgCallback = strings.ReplaceAll(expectMsgCallback, "read ack\n", "")
			}
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-MessageCallback" + suffix,
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					DefaultCurves:   defaultCurves,
					Bugs: ProtocolBugs{
						NoCloseNotify: true, // Align QUIC and TCP traces.
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-ech-accept",
					"-expect-msg-callback", expectMsgCallback,
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})
		}

		// Test that ECH, which runs before an async early callback, interacts
		// correctly in the state machine.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-AsyncEarlyCallback",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
			},
			flags: []string{
				"-async",
				"-use-early-callback",
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-server-name", "secret.example",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})

		// Test that we successfully rewind the TLS state machine and disable ECH in the
		// case that the select_cert_cb signals that ECH is not possible for the SNI in
		// ClientHelloInner.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-FailCallbackNeedRewind",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
			},
			flags: []string{
				"-async",
				"-fail-early-callback-ech-rewind",
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-server-name", "public.example",
			},
			expectations: connectionExpectations{
				echAccepted: false,
			},
		})

		// Test that we correctly handle falling back to a ClientHelloOuter with
		// no SNI (public name).
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-RewindWithNoPublicName",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					OmitPublicName: true,
				},
			},
			flags: []string{
				"-async",
				"-fail-early-callback-ech-rewind",
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-no-server-name",
			},
			expectations: connectionExpectations{
				echAccepted: false,
			},
		})

		// Test ECH-enabled server with two ECHConfigs can decrypt client's ECH when
		// it uses the second ECHConfig.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-SecondECHConfig",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig1.ECHConfig,
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-ech-server-config", base64FlagValue(echConfig1.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig1.Key),
				"-ech-is-retry-config", "1",
				"-expect-server-name", "secret.example",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})

		// Test ECH-enabled server with two ECHConfigs that have the same config
		// ID can decrypt client's ECH when it uses the second ECHConfig.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-RepeatedConfigID",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfigRepeatID.ECHConfig,
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-ech-server-config", base64FlagValue(echConfigRepeatID.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfigRepeatID.Key),
				"-ech-is-retry-config", "1",
				"-expect-server-name", "secret.example",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})

		// Test all supported ECH cipher suites.
		for i, cipher := range echCiphers {
			otherCipher := echCiphers[(i+1)%len(echCiphers)]

			// Test the ECH server can handle the specified cipher.
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-Cipher-" + cipher.name,
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					ECHCipherSuites: []HPKECipherSuite{cipher.cipher},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test that client can offer the specified cipher and skip over
			// unrecognized ones.
			cipherConfig := generateServerECHConfig(&ECHConfig{
				ConfigID: 42,
				CipherSuites: []HPKECipherSuite{
					{KDF: 0x1111, AEAD: 0x2222},
					{KDF: cipher.cipher.KDF, AEAD: 0x2222},
					{KDF: 0x1111, AEAD: cipher.cipher.AEAD},
					cipher.cipher,
				},
			})
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Cipher-" + cipher.name,
				config: Config{
					ServerECHConfigs: []ServerECHConfig{cipherConfig},
					Credential:       &echSecretCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(cipherConfig.ECHConfig.Raw)),
					"-host-name", "secret.example",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})

			// Test that the ECH server rejects the specified cipher if not
			// listed in its ECHConfig.
			otherCipherConfig := generateServerECHConfig(&ECHConfig{
				ConfigID:     42,
				CipherSuites: []HPKECipherSuite{otherCipher.cipher},
			})
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-DisabledCipher-" + cipher.name,
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					ECHCipherSuites: []HPKECipherSuite{cipher.cipher},
					Bugs: ProtocolBugs{
						ExpectECHRetryConfigs: CreateECHConfigList(otherCipherConfig.ECHConfig.Raw),
					},
				},
				flags: []string{
					"-ech-server-config", base64FlagValue(otherCipherConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(otherCipherConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-server-name", "public.example",
				},
			})
		}

		// Test that the ECH server handles a short enc value by falling back to
		// ClientHelloOuter.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-ShortEnc",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					ExpectECHRetryConfigs: CreateECHConfigList(echConfig.ECHConfig.Raw),
					TruncateClientECHEnc:  true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-server-name", "public.example",
			},
		})

		// Test that the server handles decryption failure by falling back to
		// ClientHelloOuter.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-CorruptEncryptedClientHello",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					ExpectECHRetryConfigs:       CreateECHConfigList(echConfig.ECHConfig.Raw),
					CorruptEncryptedClientHello: true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
			},
		})

		// Test that the server treats decryption failure in the second
		// ClientHello as fatal.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-CorruptSecondEncryptedClientHello",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				// Force a HelloRetryRequest.
				DefaultCurves: []CurveID{},
				Bugs: ProtocolBugs{
					CorruptSecondEncryptedClientHello: true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
			},
			shouldFail:         true,
			expectedError:      ":DECRYPTION_FAILED:",
			expectedLocalError: "remote error: error decrypting message",
		})

		// Test that the server treats a missing second ECH extension as fatal.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-OmitSecondEncryptedClientHello",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				// Force a HelloRetryRequest.
				DefaultCurves: []CurveID{},
				Bugs: ProtocolBugs{
					OmitSecondEncryptedClientHello: true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
			},
			shouldFail:         true,
			expectedError:      ":MISSING_EXTENSION:",
			expectedLocalError: "remote error: missing extension",
		})

		// Test that the server treats a mismatched config ID in the second ClientHello as fatal.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-DifferentConfigIDSecondClientHello",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
				// Force a HelloRetryRequest.
				DefaultCurves: []CurveID{},
				Bugs: ProtocolBugs{
					CorruptSecondEncryptedClientHelloConfigID: true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
			},
			shouldFail:         true,
			expectedError:      ":DECODE_ERROR:",
			expectedLocalError: "remote error: illegal parameter",
		})

		// Test early data works with ECH, in both accept and reject cases.
		// TODO(crbug.com/381113363): Enable these tests for DTLS once we
		// support early data in DTLS 1.3.
		if protocol != dtls {
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-EarlyData",
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
				},
				resumeSession: true,
				earlyData:     true,
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-EarlyDataRejected",
				config: Config{
					ServerName:      "secret.example",
					ClientECHConfig: echConfig.ECHConfig,
					Bugs: ProtocolBugs{
						// Cause the server to reject 0-RTT with a bad ticket age.
						SendTicketAge: 1 * time.Hour,
					},
				},
				resumeSession:           true,
				earlyData:               true,
				expectEarlyDataRejected: true,
				flags: []string{
					"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
					"-ech-server-key", base64FlagValue(echConfig.Key),
					"-ech-is-retry-config", "1",
					"-expect-ech-accept",
				},
				expectations: connectionExpectations{
					echAccepted: true,
				},
			})
		}

		// Test servers with ECH disabled correctly ignore the extension and
		// handshake with the ClientHelloOuter.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-Disabled",
			config: Config{
				ServerName:      "secret.example",
				ClientECHConfig: echConfig.ECHConfig,
			},
			flags: []string{
				"-expect-server-name", "public.example",
			},
		})

		// Test that ECH can be used with client certificates. In particular,
		// the name override logic should not interfere with the server.
		// Test the server can accept ECH.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-ClientAuth",
			config: Config{
				Credential:      &rsaCertificate,
				ClientECHConfig: echConfig.ECHConfig,
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-ech-accept",
				"-require-any-client-certificate",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-Decline-ClientAuth",
			config: Config{
				Credential:      &rsaCertificate,
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					ExpectECHRetryConfigs: CreateECHConfigList(echConfig1.ECHConfig.Raw),
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig1.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig1.Key),
				"-ech-is-retry-config", "1",
				"-require-any-client-certificate",
			},
		})

		// Test that the server accepts padding.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-Padding",
			config: Config{
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					ClientECHPadding: 10,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})

		// Test that the server rejects bad padding.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-BadPadding",
			config: Config{
				ClientECHConfig: echConfig.ECHConfig,
				Bugs: ProtocolBugs{
					ClientECHPadding:    10,
					BadClientECHPadding: true,
				},
			},
			flags: []string{
				"-ech-server-config", base64FlagValue(echConfig.ECHConfig.Raw),
				"-ech-server-key", base64FlagValue(echConfig.Key),
				"-ech-is-retry-config", "1",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
			shouldFail:         true,
			expectedError:      ":DECODE_ERROR",
			expectedLocalError: "remote error: illegal parameter",
		})

		// Test the client's behavior when the server ignores ECH GREASE.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-GREASE-Client-TLS13",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectClientECH: true,
				},
			},
			flags: []string{"-enable-ech-grease"},
		})

		// Test the client's ECH GREASE behavior when responding to server's
		// HelloRetryRequest. This test implicitly checks that the first and second
		// ClientHello messages have identical ECH extensions.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-GREASE-Client-TLS13-HelloRetryRequest",
			config: Config{
				MaxVersion: VersionTLS13,
				MinVersion: VersionTLS13,
				// P-384 requires a HelloRetryRequest against BoringSSL's default
				// configuration. Assert this with ExpectMissingKeyShare.
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					ExpectMissingKeyShare: true,
					ExpectClientECH:       true,
				},
			},
			flags: []string{"-enable-ech-grease", "-expect-hrr"},
		})

		unsupportedVersion := []byte{
			// version
			0xba, 0xdd,
			// length
			0x00, 0x05,
			// contents
			0x05, 0x04, 0x03, 0x02, 0x01,
		}

		// Test that the client accepts a well-formed encrypted_client_hello
		// extension in response to ECH GREASE. The response includes one ECHConfig
		// with a supported version and one with an unsupported version.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-GREASE-Client-TLS13-Retry-Configs",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectClientECH: true,
					// Include an additional well-formed ECHConfig with an
					// unsupported version. This ensures the client can skip
					// unsupported configs.
					SendECHRetryConfigs: CreateECHConfigList(echConfig.ECHConfig.Raw, unsupportedVersion),
				},
			},
			flags: []string{"-enable-ech-grease"},
		})

		// TLS 1.2 ServerHellos cannot contain retry configs.
		if protocol != quic {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-GREASE-Client-TLS12-RejectRetryConfigs",
				config: Config{
					MinVersion:       VersionTLS12,
					MaxVersion:       VersionTLS12,
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectClientECH:           true,
						AlwaysSendECHRetryConfigs: true,
					},
				},
				flags:              []string{"-enable-ech-grease"},
				shouldFail:         true,
				expectedLocalError: "remote error: unsupported extension",
				expectedError:      ":UNEXPECTED_EXTENSION:",
			})
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-TLS12-RejectRetryConfigs",
				config: Config{
					MinVersion:       VersionTLS12,
					MaxVersion:       VersionTLS12,
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectClientECH:           true,
						AlwaysSendECHRetryConfigs: true,
					},
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig1.ECHConfig.Raw)),
				},
				shouldFail:         true,
				expectedLocalError: "remote error: unsupported extension",
				expectedError:      ":UNEXPECTED_EXTENSION:",
			})
		}

		// Retry configs must be rejected when ECH is accepted.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Accept-RejectRetryConfigs",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectClientECH:           true,
					AlwaysSendECHRetryConfigs: true,
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
			},
			shouldFail:         true,
			expectedLocalError: "remote error: unsupported extension",
			expectedError:      ":UNEXPECTED_EXTENSION:",
		})

		// Unsolicited ECH HelloRetryRequest extensions should be rejected.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-UnsolictedHRRExtension",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					AlwaysSendECHHelloRetryRequest: true,
					ExpectMissingKeyShare:          true, // Check we triggered HRR.
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: unsupported extension",
			expectedError:      ":UNEXPECTED_EXTENSION:",
		})

		// GREASE should ignore ECH HelloRetryRequest extensions.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-GREASE-IgnoreHRRExtension",
			config: Config{
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					AlwaysSendECHHelloRetryRequest: true,
					ExpectMissingKeyShare:          true, // Check we triggered HRR.
				},
			},
			flags: []string{"-enable-ech-grease"},
		})

		// Random ECH HelloRetryRequest extensions also signal ECH reject.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-RandomHRRExtension",
			config: Config{
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					AlwaysSendECHHelloRetryRequest: true,
					ExpectMissingKeyShare:          true, // Check we triggered HRR.
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
			},
			shouldFail:         true,
			expectedLocalError: "remote error: ECH required",
			expectedError:      ":ECH_REJECTED:",
		})

		// Test that the client aborts with a decode_error alert when it receives a
		// syntactically-invalid encrypted_client_hello extension from the server.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-GREASE-Client-TLS13-Invalid-Retry-Configs",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					ExpectClientECH:     true,
					SendECHRetryConfigs: []byte{0xba, 0xdd, 0xec, 0xcc},
				},
			},
			flags:              []string{"-enable-ech-grease"},
			shouldFail:         true,
			expectedLocalError: "remote error: error decoding message",
			expectedError:      ":ERROR_PARSING_EXTENSION:",
		})

		// Test that the server responds to an inner ECH extension with the
		// acceptance confirmation.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-ECHInner",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AlwaysSendECHInner: true,
				},
			},
			resumeSession: true,
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-ECHInner-HelloRetryRequest",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				// Force a HelloRetryRequest.
				DefaultCurves: []CurveID{},
				Bugs: ProtocolBugs{
					AlwaysSendECHInner: true,
				},
			},
			resumeSession: true,
		})

		// Test that server fails the handshake when it sees a non-empty
		// inner ECH extension.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     prefix + "ECH-Server-ECHInner-NotEmpty",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Bugs: ProtocolBugs{
					AlwaysSendECHInner:  true,
					SendInvalidECHInner: []byte{42, 42, 42},
				},
			},
			shouldFail:         true,
			expectedLocalError: "remote error: error decoding message",
			expectedError:      ":ERROR_PARSING_EXTENSION:",
		})

		// Test that a TLS 1.3 server that receives an inner ECH extension can
		// negotiate TLS 1.2 without clobbering the downgrade signal.
		if protocol != quic {
			testCases = append(testCases, testCase{
				testType: serverTest,
				protocol: protocol,
				name:     prefix + "ECH-Server-ECHInner-Absent-TLS12",
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS13,
					Bugs: ProtocolBugs{
						// Omit supported_versions extension so the server negotiates
						// TLS 1.2.
						OmitSupportedVersions: true,
						AlwaysSendECHInner:    true,
					},
				},
				// Check that the client sees the TLS 1.3 downgrade signal in
				// ServerHello.random.
				shouldFail:         true,
				expectedLocalError: "tls: downgrade from TLS 1.3 detected",
			})
		}

		// Test the client can negotiate ECH, with and without HelloRetryRequest.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client",
			config: Config{
				MinVersion:       VersionTLS13,
				MaxVersion:       VersionTLS13,
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectServerName:      "secret.example",
					ExpectOuterServerName: "public.example",
				},
				Credential: &echSecretCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				"-expect-ech-accept",
			},
			resumeSession: true,
			expectations:  connectionExpectations{echAccepted: true},
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-HelloRetryRequest",
			config: Config{
				MinVersion:       VersionTLS13,
				MaxVersion:       VersionTLS13,
				CurvePreferences: []CurveID{CurveP384},
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectServerName:      "secret.example",
					ExpectOuterServerName: "public.example",
					ExpectMissingKeyShare: true, // Check we triggered HRR.
				},
				Credential: &echSecretCertificate,
			},
			resumeSession: true,
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				"-expect-ech-accept",
				"-expect-hrr", // Check we triggered HRR.
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Test the client can negotiate ECH with early data.
		// TODO(crbug.com/381113363): Enable these tests for DTLS once we
		// support early data in DTLS 1.3.
		if protocol != dtls {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-EarlyData",
				config: Config{
					MinVersion:       VersionTLS13,
					MaxVersion:       VersionTLS13,
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectServerName: "secret.example",
					},
					Credential: &echSecretCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-host-name", "secret.example",
					"-expect-ech-accept",
				},
				resumeSession: true,
				earlyData:     true,
				expectations:  connectionExpectations{echAccepted: true},
			})
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-EarlyDataRejected",
				config: Config{
					MinVersion:       VersionTLS13,
					MaxVersion:       VersionTLS13,
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectServerName:      "secret.example",
						AlwaysRejectEarlyData: true,
					},
					Credential: &echSecretCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-host-name", "secret.example",
					"-expect-ech-accept",
				},
				resumeSession:           true,
				earlyData:               true,
				expectEarlyDataRejected: true,
				expectations:            connectionExpectations{echAccepted: true},
			})
		}

		if protocol != quic {
			// Test that an ECH client does not offer a TLS 1.2 session.
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-TLS12SessionID",
				config: Config{
					MaxVersion:             VersionTLS12,
					SessionTicketsDisabled: true,
				},
				resumeConfig: &Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectNoTLS12Session: true,
					},
				},
				flags: []string{
					"-on-resume-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-on-resume-expect-ech-accept",
				},
				resumeSession:        true,
				expectResumeRejected: true,
				resumeExpectations:   &connectionExpectations{echAccepted: true},
			})
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-TLS12SessionTicket",
				config: Config{
					MaxVersion: VersionTLS12,
				},
				resumeConfig: &Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectNoTLS12Session: true,
					},
				},
				flags: []string{
					"-on-resume-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-on-resume-expect-ech-accept",
				},
				resumeSession:        true,
				expectResumeRejected: true,
				resumeExpectations:   &connectionExpectations{echAccepted: true},
			})
		}

		// ClientHelloInner should not include NPN, which is a TLS 1.2-only
		// extensions. The Go server will enforce this, so this test only needs
		// to configure the feature on the shim. Other application extensions
		// are sent implicitly.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NoNPN",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				// Enable NPN.
				"-select-next-proto", "foo",
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Test that the client iterates over configurations in the
		// ECHConfigList and selects the first with supported parameters.
		unsupportedKEM := generateServerECHConfig(&ECHConfig{
			KEM:       0x6666,
			PublicKey: []byte{1, 2, 3, 4},
		}).ECHConfig
		unsupportedCipherSuites := generateServerECHConfig(&ECHConfig{
			CipherSuites: []HPKECipherSuite{{0x1111, 0x2222}},
		}).ECHConfig
		unsupportedMandatoryExtension := generateServerECHConfig(&ECHConfig{
			UnsupportedMandatoryExtension: true,
		}).ECHConfig
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-SelectECHConfig",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(
					unsupportedVersion,
					unsupportedKEM.Raw,
					unsupportedCipherSuites.Raw,
					unsupportedMandatoryExtension.Raw,
					echConfig.ECHConfig.Raw,
					// |echConfig1| is also supported, but the client should
					// select the first one.
					echConfig1.ECHConfig.Raw,
				)),
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{
				echAccepted: true,
			},
		})

		// Test that the client skips sending ECH if all ECHConfigs are
		// unsupported.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NoSupportedConfigs",
			config: Config{
				Bugs: ProtocolBugs{
					ExpectNoClientECH: true,
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(
					unsupportedVersion,
					unsupportedKEM.Raw,
					unsupportedCipherSuites.Raw,
					unsupportedMandatoryExtension.Raw,
				)),
			},
		})

		// If ECH GREASE is enabled, the client should send ECH GREASE when no
		// configured ECHConfig is suitable.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NoSupportedConfigs-GREASE",
			config: Config{
				Bugs: ProtocolBugs{
					ExpectClientECH: true,
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(
					unsupportedVersion,
					unsupportedKEM.Raw,
					unsupportedCipherSuites.Raw,
					unsupportedMandatoryExtension.Raw,
				)),
				"-enable-ech-grease",
			},
		})

		// If both ECH GREASE and suitable ECHConfigs are available, the
		// client should send normal ECH.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-GREASE",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
			},
			resumeSession: true,
			expectations:  connectionExpectations{echAccepted: true},
		})

		// Test that GREASE extensions correctly interact with ECH. Both the
		// inner and outer ClientHellos should include GREASE extensions.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-GREASEExtensions",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectGREASE: true,
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				"-enable-grease",
			},
			resumeSession: true,
			expectations:  connectionExpectations{echAccepted: true},
		})

		// Test that the client tolerates unsupported extensions if the
		// mandatory bit is not set.
		unsupportedExtension := generateServerECHConfig(&ECHConfig{UnsupportedExtension: true})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-UnsupportedExtension",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{unsupportedExtension},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(unsupportedExtension.ECHConfig.Raw)),
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Syntax errors in the ECHConfigList should be rejected.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-InvalidECHConfigList",
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw[1:])),
			},
			shouldFail:    true,
			expectedError: ":INVALID_ECH_CONFIG_LIST:",
		})

		// If the ClientHelloInner has no server_name extension, while the
		// ClientHelloOuter has one, the client must check for unsolicited
		// extensions based on the selected ClientHello.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-UnsolicitedInnerServerNameAck",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					// ClientHelloOuter should have a server name.
					ExpectOuterServerName: "public.example",
					// The server will acknowledge the server_name extension.
					// This option runs whether or not the client requested the
					// extension.
					SendServerNameAck: true,
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				// No -host-name flag.
				"-expect-ech-accept",
			},
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_EXTENSION:",
			expectedLocalError: "remote error: unsupported extension",
			expectations:       connectionExpectations{echAccepted: true},
		})

		// Most extensions are the same between ClientHelloInner and
		// ClientHelloOuter and can be compressed.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-ExpectECHOuterExtensions",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				NextProtos:       []string{"proto"},
				Bugs: ProtocolBugs{
					ExpectECHOuterExtensions: []uint16{
						extensionALPN,
						extensionKeyShare,
						extensionPSKKeyExchangeModes,
						extensionSignatureAlgorithms,
						extensionSupportedCurves,
					},
				},
				Credential: &echSecretCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				"-advertise-alpn", "\x05proto",
				"-expect-alpn", "proto",
				"-host-name", "secret.example",
			},
			expectations: connectionExpectations{
				echAccepted: true,
				nextProto:   "proto",
			},
			skipQUICALPNConfig: true,
		})

		// If the server name happens to match the public name, it still should
		// not be compressed. It is not publicly known that they match.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NeverCompressServerName",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				NextProtos:       []string{"proto"},
				Bugs: ProtocolBugs{
					ExpectECHUncompressedExtensions: []uint16{extensionServerName},
					ExpectServerName:                "public.example",
					ExpectOuterServerName:           "public.example",
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				"-host-name", "public.example",
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// If the ClientHelloOuter disables TLS 1.3, e.g. in QUIC, the client
		// should also compress supported_versions.
		tls13Vers := VersionTLS13
		if protocol == dtls {
			tls13Vers = VersionDTLS13
		}
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-CompressSupportedVersions",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectECHOuterExtensions: []uint16{
						extensionSupportedVersions,
					},
				},
				Credential: &echSecretCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				"-expect-ech-accept",
				"-min-version", strconv.Itoa(int(tls13Vers)),
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Test that the client can still offer server names that exceed the
		// maximum name length. It is only a padding hint.
		maxNameLen10 := generateServerECHConfig(&ECHConfig{MaxNameLen: 10})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NameTooLong",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{maxNameLen10},
				Bugs: ProtocolBugs{
					ExpectServerName: "test0123456789.example",
				},
				Credential: &echLongNameCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(maxNameLen10.ECHConfig.Raw)),
				"-host-name", "test0123456789.example",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Test the client can recognize when ECH is rejected.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig2, echConfig3},
				Bugs: ProtocolBugs{
					ExpectServerName: "public.example",
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-retry-configs", base64FlagValue(CreateECHConfigList(echConfig2.ECHConfig.Raw, echConfig3.ECHConfig.Raw)),
			},
			shouldFail:         true,
			expectedLocalError: "remote error: ECH required",
			expectedError:      ":ECH_REJECTED:",
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-HelloRetryRequest",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig2, echConfig3},
				CurvePreferences: []CurveID{CurveP384},
				Bugs: ProtocolBugs{
					ExpectServerName:      "public.example",
					ExpectMissingKeyShare: true, // Check we triggered HRR.
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-retry-configs", base64FlagValue(CreateECHConfigList(echConfig2.ECHConfig.Raw, echConfig3.ECHConfig.Raw)),
				"-expect-hrr", // Check we triggered HRR.
			},
			shouldFail:         true,
			expectedLocalError: "remote error: ECH required",
			expectedError:      ":ECH_REJECTED:",
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-NoRetryConfigs",
			config: Config{
				Bugs: ProtocolBugs{
					ExpectServerName: "public.example",
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-no-ech-retry-configs",
			},
			shouldFail:         true,
			expectedLocalError: "remote error: ECH required",
			expectedError:      ":ECH_REJECTED:",
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-TLS12",
				config: Config{
					MaxVersion: VersionTLS12,
					Bugs: ProtocolBugs{
						ExpectServerName: "public.example",
					},
					Credential: &echPublicCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					// TLS 1.2 cannot provide retry configs.
					"-expect-no-ech-retry-configs",
				},
				shouldFail:         true,
				expectedLocalError: "remote error: ECH required",
				expectedError:      ":ECH_REJECTED:",
			})

			// Test that the client disables False Start when ECH is rejected.
			testCases = append(testCases, testCase{
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-TLS12-NoFalseStart",
				config: Config{
					MaxVersion:   VersionTLS12,
					CipherSuites: []uint16{TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
					NextProtos:   []string{"foo"},
					Bugs: ProtocolBugs{
						// The options below cause the server to, immediately
						// after client Finished, send an alert and try to read
						// application data without sending server Finished.
						ExpectFalseStart:          true,
						AlertBeforeFalseStartTest: alertAccessDenied,
					},
					Credential: &echPublicCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-false-start",
					"-advertise-alpn", "\x03foo",
					"-expect-alpn", "foo",
				},
				shimWritesFirst: true,
				shouldFail:      true,
				// Ensure the client does not send application data at the False
				// Start point. EOF comes from the client closing the connection
				// in response to the alert.
				expectedLocalError: "tls: peer did not false start: EOF",
				// Ensures the client picks up the alert before reporting an
				// authenticated |SSL_R_ECH_REJECTED|.
				expectedError: ":TLSV1_ALERT_ACCESS_DENIED:",
			})
		}

		// Test that unsupported retry configs in a valid ECHConfigList are
		// allowed. They will be skipped when configured in the retry.
		retryConfigs := CreateECHConfigList(
			unsupportedVersion,
			unsupportedKEM.Raw,
			unsupportedCipherSuites.Raw,
			unsupportedMandatoryExtension.Raw,
			echConfig2.ECHConfig.Raw)
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-UnsupportedRetryConfigs",
			config: Config{
				Bugs: ProtocolBugs{
					SendECHRetryConfigs: retryConfigs,
					ExpectServerName:    "public.example",
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-retry-configs", base64FlagValue(retryConfigs),
			},
			shouldFail:         true,
			expectedLocalError: "remote error: ECH required",
			expectedError:      ":ECH_REJECTED:",
		})

		// Test that the client rejects ClientHelloOuter handshakes that attempt
		// to resume the ClientHelloInner's ticket, at TLS 1.2 and TLS 1.3.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-ResumeInnerSession-TLS13",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectServerName: "secret.example",
				},
				Credential: &echSecretCertificate,
			},
			resumeConfig: &Config{
				MaxVersion:       VersionTLS13,
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectServerName:                    "public.example",
					UseInnerSessionWithClientHelloOuter: true,
				},
				Credential: &echPublicCertificate,
			},
			resumeSession: true,
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				"-on-initial-expect-ech-accept",
			},
			shouldFail:         true,
			expectedError:      ":UNEXPECTED_EXTENSION:",
			expectations:       connectionExpectations{echAccepted: true},
			resumeExpectations: &connectionExpectations{echAccepted: false},
		})
		if protocol == tls {
			// This is only syntactically possible with TLS. In DTLS, we don't
			// have middlebox compatibility mode, so the session ID will only
			// filled in if we are offering a DTLS 1.2 session. But a DTLS 1.2
			// would never be offered in ClientHelloInner. Without a session ID,
			// the server syntactically cannot express a resumption at DTLS 1.2.
			// In QUIC, the above is true, and 1.2 does not exist anyway.
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-ResumeInnerSession-TLS12",
				config: Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectServerName: "secret.example",
					},
					Credential: &echSecretCertificate,
				},
				resumeConfig: &Config{
					MinVersion:       VersionTLS12,
					MaxVersion:       VersionTLS12,
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectServerName:                    "public.example",
						UseInnerSessionWithClientHelloOuter: true,
						// The client only ever offers TLS 1.3 sessions in
						// ClientHelloInner. AcceptAnySession allows them to be
						// resumed at TLS 1.2.
						AcceptAnySession: true,
					},
					Credential: &echPublicCertificate,
				},
				resumeSession: true,
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-host-name", "secret.example",
					"-on-initial-expect-ech-accept",
				},
				// From the client's perspective, the server echoed a session ID to
				// signal resumption, but the selected ClientHello had nothing to
				// resume.
				shouldFail:         true,
				expectedError:      ":SERVER_ECHOED_INVALID_SESSION_ID:",
				expectedLocalError: "remote error: illegal parameter",
				expectations:       connectionExpectations{echAccepted: true},
				resumeExpectations: &connectionExpectations{echAccepted: false},
			})
		}

		// Test that the client can process ECH rejects after an early data reject.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-EarlyDataRejected",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectServerName: "secret.example",
				},
				Credential: &echSecretCertificate,
			},
			resumeConfig: &Config{
				ServerECHConfigs: []ServerECHConfig{echConfig2},
				Bugs: ProtocolBugs{
					ExpectServerName: "public.example",
				},
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				// Although the resumption connection does not accept ECH, the
				// API will report ECH was accepted at the 0-RTT point.
				"-expect-ech-accept",
				// -on-retry refers to the retried handshake after 0-RTT reject,
				// while ech-retry-configs refers to the ECHConfigs to use in
				// the next connection attempt.
				"-on-retry-expect-ech-retry-configs", base64FlagValue(CreateECHConfigList(echConfig2.ECHConfig.Raw)),
			},
			resumeSession:           true,
			expectResumeRejected:    true,
			earlyData:               true,
			expectEarlyDataRejected: true,
			expectations:            connectionExpectations{echAccepted: true},
			resumeExpectations:      &connectionExpectations{echAccepted: false},
			shouldFail:              true,
			expectedLocalError:      "remote error: ECH required",
			expectedError:           ":ECH_REJECTED:",
		})
		// TODO(crbug.com/381113363): Enable this test for DTLS once we
		// support early data in DTLS 1.3.
		if protocol != quic && protocol != dtls {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-EarlyDataRejected-TLS12",
				config: Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Bugs: ProtocolBugs{
						ExpectServerName: "secret.example",
					},
					Credential: &echSecretCertificate,
				},
				resumeConfig: &Config{
					MaxVersion: VersionTLS12,
					Bugs: ProtocolBugs{
						ExpectServerName: "public.example",
					},
					Credential: &echPublicCertificate,
				},
				flags: []string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-host-name", "secret.example",
					// Although the resumption connection does not accept ECH, the
					// API will report ECH was accepted at the 0-RTT point.
					"-expect-ech-accept",
				},
				resumeSession:           true,
				expectResumeRejected:    true,
				earlyData:               true,
				expectEarlyDataRejected: true,
				expectations:            connectionExpectations{echAccepted: true},
				resumeExpectations:      &connectionExpectations{echAccepted: false},
				// ClientHellos with early data cannot negotiate TLS 1.2, with
				// or without ECH. The shim should first report
				// |SSL_R_WRONG_VERSION_ON_EARLY_DATA|. The caller will then
				// repair the first error by retrying without early data. That
				// will look like ECH-Client-Reject-TLS12 and select TLS 1.2
				// and ClientHelloOuter. The caller will then trigger a third
				// attempt, which will succeed.
				shouldFail:    true,
				expectedError: ":WRONG_VERSION_ON_EARLY_DATA:",
			})
		}

		// Test that the client ignores ECHConfigs with invalid public names.
		invalidPublicName := generateServerECHConfig(&ECHConfig{PublicName: "dns_names_have_no_underscores.example"})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-SkipInvalidPublicName",
			config: Config{
				Bugs: ProtocolBugs{
					// No ECHConfigs are supported, so the client should fall
					// back to cleartext.
					ExpectNoClientECH: true,
					ExpectServerName:  "secret.example",
				},
				Credential: &echSecretCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(invalidPublicName.ECHConfig.Raw)),
				"-host-name", "secret.example",
			},
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-SkipInvalidPublicName-2",
			config: Config{
				// The client should skip |invalidPublicName| and use |echConfig|.
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectOuterServerName: "public.example",
					ExpectServerName:      "secret.example",
				},
				Credential: &echSecretCertificate,
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(invalidPublicName.ECHConfig.Raw, echConfig.ECHConfig.Raw)),
				"-host-name", "secret.example",
				"-expect-ech-accept",
			},
			expectations: connectionExpectations{echAccepted: true},
		})

		// Test both sync and async mode, to test both with and without the
		// client certificate callback.
		for _, async := range []bool{false, true} {
			var flags []string
			var suffix string
			if async {
				flags = []string{"-async"}
				suffix = "-Async"
			}

			// Test that ECH and client certificates can be used together.
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-ClientCertificate" + suffix,
				config: Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					ClientAuth:       RequireAnyClientCert,
				},
				shimCertificate: &rsaCertificate,
				flags: append([]string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-expect-ech-accept",
				}, flags...),
				expectations: connectionExpectations{echAccepted: true},
			})

			// Test that, when ECH is rejected, the client does not send a client
			// certificate.
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-NoClientCertificate-TLS13" + suffix,
				config: Config{
					MinVersion: VersionTLS13,
					MaxVersion: VersionTLS13,
					ClientAuth: RequireAnyClientCert,
					Credential: &echPublicCertificate,
				},
				shimCertificate: &rsaCertificate,
				flags: append([]string{
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				}, flags...),
				shouldFail:         true,
				expectedLocalError: "tls: client didn't provide a certificate",
			})
			if protocol != quic {
				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     prefix + "ECH-Client-Reject-NoClientCertificate-TLS12" + suffix,
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: VersionTLS12,
						ClientAuth: RequireAnyClientCert,
						Credential: &echPublicCertificate,
					},
					shimCertificate: &rsaCertificate,
					flags: append([]string{
						"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					}, flags...),
					shouldFail:         true,
					expectedLocalError: "tls: client didn't provide a certificate",
				})
			}
		}

		// Test that ECH and Channel ID can be used together. Channel ID does
		// not exist in DTLS.
		if protocol != dtls {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-ChannelID",
				config: Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					RequestChannelID: true,
				},
				flags: []string{
					"-send-channel-id", channelIDKeyPath,
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					"-expect-ech-accept",
				},
				resumeSession: true,
				expectations: connectionExpectations{
					channelID:   true,
					echAccepted: true,
				},
			})

			// Handshakes where ECH is rejected do not offer or accept Channel ID.
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-NoChannelID-TLS13",
				config: Config{
					MinVersion: VersionTLS13,
					MaxVersion: VersionTLS13,
					Bugs: ProtocolBugs{
						AlwaysNegotiateChannelID: true,
					},
					Credential: &echPublicCertificate,
				},
				flags: []string{
					"-send-channel-id", channelIDKeyPath,
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				},
				shouldFail:         true,
				expectedLocalError: "remote error: unsupported extension",
				expectedError:      ":UNEXPECTED_EXTENSION:",
			})
			if protocol != quic {
				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     prefix + "ECH-Client-Reject-NoChannelID-TLS12",
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: VersionTLS12,
						Bugs: ProtocolBugs{
							AlwaysNegotiateChannelID: true,
						},
						Credential: &echPublicCertificate,
					},
					flags: []string{
						"-send-channel-id", channelIDKeyPath,
						"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					},
					shouldFail:         true,
					expectedLocalError: "remote error: unsupported extension",
					expectedError:      ":UNEXPECTED_EXTENSION:",
				})
			}
		}

		// Test that ECH correctly overrides the host name for certificate
		// verification.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-NotOffered-NoOverrideName",
			flags: []string{
				"-verify-peer",
				"-use-custom-verify-callback",
				// When not offering ECH, verify the usual name in both full
				// and resumption handshakes.
				"-reverify-on-resume",
				"-expect-no-ech-name-override",
			},
			resumeSession: true,
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-GREASE-NoOverrideName",
			flags: []string{
				"-verify-peer",
				"-use-custom-verify-callback",
				"-enable-ech-grease",
				// When offering ECH GREASE, verify the usual name in both full
				// and resumption handshakes.
				"-reverify-on-resume",
				"-expect-no-ech-name-override",
			},
			resumeSession: true,
		})
		if protocol != quic {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Rejected-OverrideName-TLS12",
				config: Config{
					MinVersion: VersionTLS12,
					MaxVersion: VersionTLS12,
				},
				flags: []string{
					"-verify-peer",
					"-use-custom-verify-callback",
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					// When ECH is rejected, verify the public name. This can
					// only happen in full handshakes.
					"-expect-ech-name-override", "public.example",
				},
				shouldFail:         true,
				expectedError:      ":ECH_REJECTED:",
				expectedLocalError: "remote error: ECH required",
			})
		}
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Reject-OverrideName-TLS13",
			config: Config{
				MinVersion: VersionTLS13,
				MaxVersion: VersionTLS13,
				Credential: &echPublicCertificate,
			},
			flags: []string{
				"-verify-peer",
				"-use-custom-verify-callback",
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				// When ECH is rejected, verify the public name. This can
				// only happen in full handshakes.
				"-expect-ech-name-override", "public.example",
			},
			shouldFail:         true,
			expectedError:      ":ECH_REJECTED:",
			expectedLocalError: "remote error: ECH required",
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-Accept-NoOverrideName",
			config: Config{
				ServerECHConfigs: []ServerECHConfig{echConfig},
			},
			flags: []string{
				"-verify-peer",
				"-use-custom-verify-callback",
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				// When ECH is accepted, verify the usual name in both full and
				// resumption handshakes.
				"-reverify-on-resume",
				"-expect-no-ech-name-override",
			},
			resumeSession: true,
			expectations:  connectionExpectations{echAccepted: true},
		})
		// TODO(crbug.com/381113363): Enable this test for DTLS once we
		// support early data in DTLS 1.3.
		if protocol != dtls {
			testCases = append(testCases, testCase{
				testType: clientTest,
				protocol: protocol,
				name:     prefix + "ECH-Client-Reject-EarlyDataRejected-OverrideNameOnRetry",
				config: Config{
					ServerECHConfigs: []ServerECHConfig{echConfig},
					Credential:       &echPublicCertificate,
				},
				resumeConfig: &Config{
					Credential: &echPublicCertificate,
				},
				flags: []string{
					"-verify-peer",
					"-use-custom-verify-callback",
					"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
					// Although the resumption connection does not accept ECH, the
					// API will report ECH was accepted at the 0-RTT point.
					"-expect-ech-accept",
					// The resumption connection verifies certificates twice. First,
					// if reverification is enabled, we verify the 0-RTT certificate
					// as if ECH as accepted. There should be no name override.
					// Next, on the post-0-RTT-rejection retry, we verify the new
					// server certificate. This picks up the ECH reject, so it
					// should use public.example.
					"-reverify-on-resume",
					"-on-resume-expect-no-ech-name-override",
					"-on-retry-expect-ech-name-override", "public.example",
				},
				resumeSession:           true,
				expectResumeRejected:    true,
				earlyData:               true,
				expectEarlyDataRejected: true,
				expectations:            connectionExpectations{echAccepted: true},
				resumeExpectations:      &connectionExpectations{echAccepted: false},
				shouldFail:              true,
				expectedError:           ":ECH_REJECTED:",
				expectedLocalError:      "remote error: ECH required",
			})
		}

		// Test that the client checks both HelloRetryRequest and ServerHello
		// for a confirmation signal.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-HelloRetryRequest-MissingServerHelloConfirmation",
			config: Config{
				MinVersion:       VersionTLS13,
				MaxVersion:       VersionTLS13,
				CurvePreferences: []CurveID{CurveP384},
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectMissingKeyShare:          true, // Check we triggered HRR.
					OmitServerHelloECHConfirmation: true,
				},
			},
			resumeSession: true,
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-hrr", // Check we triggered HRR.
			},
			shouldFail:    true,
			expectedError: ":INCONSISTENT_ECH_NEGOTIATION:",
		})

		// Test the message callback is correctly reported, with and without
		// HelloRetryRequest.
		clientAndServerHello := "write clienthelloinner\nwrite hs 1\nread hs 2\n"
		clientAndServerHelloInitial := clientAndServerHello
		if protocol == tls {
			clientAndServerHelloInitial += "write ccs\n"
		}
		// EncryptedExtensions onwards.
		finishHandshake := `read hs 8
read hs 11
read hs 15
read hs 20
write hs 20
read ack
read hs 4
read hs 4
`
		if protocol != dtls {
			finishHandshake = strings.ReplaceAll(finishHandshake, "read ack\n", "")
		}
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-MessageCallback",
			config: Config{
				MinVersion:       VersionTLS13,
				MaxVersion:       VersionTLS13,
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					NoCloseNotify: true, // Align QUIC and TCP traces.
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				"-expect-msg-callback", clientAndServerHelloInitial + finishHandshake,
			},
			expectations: connectionExpectations{echAccepted: true},
		})
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     prefix + "ECH-Client-MessageCallback-HelloRetryRequest",
			config: Config{
				MinVersion:       VersionTLS13,
				MaxVersion:       VersionTLS13,
				CurvePreferences: []CurveID{CurveP384},
				ServerECHConfigs: []ServerECHConfig{echConfig},
				Bugs: ProtocolBugs{
					ExpectMissingKeyShare: true, // Check we triggered HRR.
					NoCloseNotify:         true, // Align QUIC and TCP traces.
				},
			},
			flags: []string{
				"-ech-config-list", base64FlagValue(CreateECHConfigList(echConfig.ECHConfig.Raw)),
				"-expect-ech-accept",
				"-expect-hrr", // Check we triggered HRR.
				"-expect-msg-callback", clientAndServerHelloInitial + clientAndServerHello + finishHandshake,
			},
			expectations: connectionExpectations{echAccepted: true},
		})
	}
}
