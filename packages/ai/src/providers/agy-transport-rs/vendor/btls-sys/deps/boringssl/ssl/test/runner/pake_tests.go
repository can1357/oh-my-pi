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
	"errors"
	"strconv"
)

func addPAKETests() {
	spakeCredential := Credential{
		Type:         CredentialTypeSPAKE2PlusV1,
		PAKEContext:  []byte("context"),
		PAKEClientID: []byte("client"),
		PAKEServerID: []byte("server"),
		PAKEPassword: []byte("password"),
	}

	spakeWrongClientID := spakeCredential
	spakeWrongClientID.PAKEClientID = []byte("wrong")

	spakeWrongServerID := spakeCredential
	spakeWrongServerID.PAKEServerID = []byte("wrong")

	spakeWrongPassword := spakeCredential
	spakeWrongPassword.PAKEPassword = []byte("wrong")

	spakeWrongRole := spakeCredential
	spakeWrongRole.WrongPAKERole = true

	spakeWrongCodepoint := spakeCredential
	spakeWrongCodepoint.OverridePAKECodepoint = 1234

	testCases = append(testCases, testCase{
		name:     "PAKE-No-Server-Support",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
		},
		shouldFail:    true,
		expectedError: ":MISSING_KEY_SHARE:",
	})
	testCases = append(testCases, testCase{
		name:     "PAKE-Server",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				// We do not currently support resumption with PAKE, so PAKE
				// servers should not issue session tickets.
				ExpectNoNewSessionTicket: true,
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
	})
	testCases = append(testCases, testCase{
		// Send a ClientHello with the wrong PAKE client ID.
		name:     "PAKE-Server-WrongClientID",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeWrongClientID,
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":PEER_PAKE_MISMATCH:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// Send a ClientHello with the wrong PAKE server ID.
		name:     "PAKE-Server-WrongServerID",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeWrongServerID,
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":PEER_PAKE_MISMATCH:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// Send a ClientHello with the wrong PAKE codepoint.
		name:     "PAKE-Server-WrongCodepoint",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeWrongCodepoint,
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":PEER_PAKE_MISMATCH:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// A server configured with a mix of PAKE and non-PAKE
		// credentials will select the first that matches what the
		// client offered. In doing so, it should skip unsupported
		// PAKE algorithms.
		name:     "PAKE-Server-MultiplePAKEs",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				OfferExtraPAKEs: []uint16{1, 2, 3, 4, 5},
			},
		},
		shimCredentials: []*Credential{&spakeWrongClientID, &spakeWrongServerID, &spakeWrongRole, &spakeCredential, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "3"},
	})
	testCases = append(testCases, testCase{
		// A server configured with a certificate credential before a
		// PAKE credential will consider the certificate credential first.
		name:     "PAKE-Server-CertificateBeforePAKE",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Pretend to offer a matching PAKE share, but expect the
				// shim to select the credential first and negotiate a
				// normal handshake.
				OfferExtraPAKEClientID: spakeCredential.PAKEClientID,
				OfferExtraPAKEServerID: spakeCredential.PAKEServerID,
				OfferExtraPAKEs:        []uint16{spakeID},
			},
		},
		shimCredentials: []*Credential{&rsaCertificate, &spakeCredential},
		flags:           []string{"-expect-selected-credential", "0"},
	})
	testCases = append(testCases, testCase{
		// A server configured with just a PAKE credential should reject normal
		// clients.
		name:     "PAKE-Server-NormalClient",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":PEER_PAKE_MISMATCH:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// ... and TLS 1.2 clients.
		name:     "PAKE-Server-NormalTLS12Client",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":NO_SHARED_CIPHER:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// ... but you can configure a server with both PAKE and certificate-based
		// SSL_CREDENTIALs and that works.
		name:     "PAKE-ServerWithCertsToo-NormalClient",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
		},
		shimCredentials: []*Credential{&spakeCredential, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
	})
	testCases = append(testCases, testCase{
		// ... and for older clients.
		name:     "PAKE-ServerWithCertsToo-NormalTLS12Client",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
		},
		shimCredentials: []*Credential{&spakeCredential, &rsaCertificate},
		flags:           []string{"-expect-selected-credential", "1"},
	})
	testCases = append(testCases, testCase{
		name:     "PAKE-Client",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				CheckClientHello: func(c *clientHelloMsg) error {
					// PAKE connections don't use the key_share / supported_groups mechanism.
					if c.hasKeyShares {
						return errors.New("unexpected key_share extension")
					}
					if len(c.supportedCurves) != 0 {
						return errors.New("unexpected supported_groups extension")
					}
					// PAKE connections don't use signature algorithms.
					if len(c.signatureAlgorithms) != 0 {
						return errors.New("unexpected signature_algorithms extension")
					}
					// We don't support resumption with PAKEs.
					if len(c.pskKEModes) != 0 {
						return errors.New("unexpected psk_key_exchange_modes extension")
					}
					return nil
				},
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
	})
	testCases = append(testCases, testCase{
		// Although there is no reason to request new key shares, the PAKE
		// client should handle cookie requests.
		name:     "PAKE-Client-HRRCookie",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				SendHelloRetryRequestCookie: []byte("cookie"),
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
	})
	testCases = append(testCases, testCase{
		// A PAKE client will not offer key shares, even if explicitly configured,
		// and the client should reject a HelloRetryRequest requesting a different
		// key share.
		name:     "PAKE-Client-HRRKeyShare",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				ExpectedKeyShares:          []CurveID{},
				SendHelloRetryRequestCurve: CurveX25519,
			},
		},
		flags: []string{
			"-key-shares", strconv.Itoa(int(CurveP256)),
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_EXTENSION:",
		expectedLocalError: "remote error: unsupported extension",
	})
	testCases = append(testCases, testCase{
		// A server cannot reply with an HRR asking for a PAKE if the client didn't
		// offer a PAKE in the ClientHello.
		name:     "PAKE-NormalClient-PAKEInHRR",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				AlwaysSendHelloRetryRequest: true,
				SendPAKEInHelloRetryRequest: true,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		// A PAKE client should not accept an empty ServerHello.
		name:     "PAKE-Client-EmptyServerHello",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Trigger an empty ServerHello by making a normal server skip
				// the key_share extension.
				MissingKeyShare: true,
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":MISSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		// A PAKE client should not accept a key_share ServerHello.
		name:     "PAKE-Client-KeyShareServerHello",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// Trigger a key_share ServerHello by making a normal server
				// skip the HelloRetryRequest it would otherwise send in
				// response to the shim's key_share-less ClientHello.
				SkipHelloRetryRequest: true,
				// Ignore the client's lack of supported_groups.
				IgnorePeerCurvePreferences: true,
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":UNEXPECTED_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		// A PAKE client should not accept a TLS 1.2 ServerHello.
		name:     "PAKE-Client-TLS12ServerHello",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS12,
			MaxVersion: VersionTLS12,
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":UNSUPPORTED_PROTOCOL:",
	})
	testCases = append(testCases, testCase{
		// A server cannot send the PAKE extension to a non-PAKE client.
		name:     "PAKE-NormalClient-UnsolicitedPAKEInServerHello",
		testType: clientTest,
		config: Config{
			Bugs: ProtocolBugs{
				UnsolicitedPAKE: spakeID,
			},
		},
		shouldFail:    true,
		expectedError: ":UNEXPECTED_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		// A server cannot reply with a PAKE that the client did not offer.
		name:     "PAKE-Client-WrongPAKEInServerHello",
		testType: clientTest,
		config: Config{
			Bugs: ProtocolBugs{
				UnsolicitedPAKE: 1234,
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":DECODE_ERROR:",
	})
	testCases = append(testCases, testCase{
		name:     "PAKE-Extension-Duplicate",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				OfferExtraPAKEClientID: []byte("client"),
				OfferExtraPAKEServerID: []byte("server"),
				OfferExtraPAKEs:        []uint16{1234, 1234},
			},
		},
		shouldFail:    true,
		expectedError: ":ERROR_PARSING_EXTENSION:",
	})
	testCases = append(testCases, testCase{
		// If the client sees a server with a wrong password, it should
		// reject the confirmV value in the ServerHello.
		name:     "PAKE-Client-WrongPassword",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeWrongPassword,
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":DECODE_ERROR:",
	})
	testCases = append(testCases, testCase{
		name:     "PAKE-Client-Truncate",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				TruncatePAKEMessage: true,
			},
		},
		shimCredentials: []*Credential{&spakeCredential},
		shouldFail:      true,
		expectedError:   ":DECODE_ERROR:",
	})
	testCases = append(testCases, testCase{
		name:     "PAKE-Server-Truncate",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				TruncatePAKEMessage: true,
			},
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":DECODE_ERROR:",
		expectedLocalError: "remote error: illegal parameter",
	})
	testCases = append(testCases, testCase{
		// Servers may not send CertificateRequest in a PAKE handshake.
		name:     "PAKE-Client-UnexpectedCertificateRequest",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				AlwaysSendCertificateRequest: true,
			},
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})
	testCases = append(testCases, testCase{
		// Servers may not send Certificate in a PAKE handshake.
		name:     "PAKE-Client-UnexpectedCertificate",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				AlwaysSendCertificate:    true,
				UseCertificateCredential: &rsaCertificate,
				// Ignore the client's lack of signature_algorithms.
				IgnorePeerSignatureAlgorithmPreferences: true,
			},
		},
		shimCredentials:    []*Credential{&spakeCredential},
		shouldFail:         true,
		expectedError:      ":UNEXPECTED_MESSAGE:",
		expectedLocalError: "remote error: unexpected message",
	})
	testCases = append(testCases, testCase{
		// If a server is configured to request client certificates, it should
		// still not do so when negotiating a PAKE.
		name:     "PAKE-Server-DoNotRequestClientCertificate",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
		},
		shimCredentials: []*Credential{&spakeCredential, &rsaCertificate},
		flags:           []string{"-require-any-client-certificate"},
	})
	testCases = append(testCases, testCase{
		// Clients should ignore server PAKE credentials.
		name:     "PAKE-Client-WrongRole",
		testType: clientTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
		},
		shimCredentials: []*Credential{&spakeWrongRole},
		shouldFail:      true,
		// The shim will send a non-PAKE ClientHello.
		expectedLocalError: "tls: client not configured with PAKE",
	})
	testCases = append(testCases, testCase{
		// Servers should ignore client PAKE credentials.
		name:     "PAKE-Server-WrongRole",
		testType: serverTest,
		config: Config{
			MinVersion: VersionTLS13,
			Credential: &spakeCredential,
		},
		shimCredentials: []*Credential{&spakeWrongRole},
		shouldFail:      true,
		// The shim will fail the handshake because it has no usable credentials
		// available.
		expectedError:      ":UNKNOWN_CERTIFICATE_TYPE:",
		expectedLocalError: "remote error: handshake failure",
	})
	testCases = append(testCases, testCase{
		// On the client, we only support a single PAKE credential.
		name:            "PAKE-Client-MultiplePAKEs",
		testType:        clientTest,
		shimCredentials: []*Credential{&spakeCredential, &spakeWrongPassword},
		shouldFail:      true,
		expectedError:   ":UNSUPPORTED_CREDENTIAL_LIST:",
	})
	testCases = append(testCases, testCase{
		// On the client, we only support a single PAKE credential.
		name:            "PAKE-Client-PAKEAndCertificate",
		testType:        clientTest,
		shimCredentials: []*Credential{&spakeCredential, &rsaCertificate},
		shouldFail:      true,
		expectedError:   ":UNSUPPORTED_CREDENTIAL_LIST:",
	})
	testCases = append(testCases, testCase{
		// We currently do not support resumption with PAKE. Even if configured
		// with a session, the client should not offer the session with PAKEs.
		name:     "PAKE-Client-NoResume",
		testType: clientTest,
		// Make two connections. For the first connection, just establish a
		// session without PAKE, to pick up a session.
		config: Config{
			Credential: &rsaCertificate,
		},
		// For the second connection, use SPAKE.
		resumeSession: true,
		resumeConfig: &Config{
			Credential: &spakeCredential,
			Bugs: ProtocolBugs{
				// Check that the ClientHello does not offer a session, even
				// though one was configured.
				ExpectNoTLS13PSK: true,
				// Respond with an unsolicited PSK extension in ServerHello, to
				// check that the client rejects it.
				AlwaysSelectPSKIdentity: true,
			},
		},
		resumeShimCredentials: []*Credential{&spakeCredential},
		shouldFail:            true,
		expectedError:         ":UNEXPECTED_EXTENSION:",
	})
}
