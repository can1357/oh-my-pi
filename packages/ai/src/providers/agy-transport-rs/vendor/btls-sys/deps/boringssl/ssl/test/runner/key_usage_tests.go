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
	"crypto/x509"
)

func addECDSAKeyUsageTests() {
	cert := rootCA.Issue(X509Info{
		PrivateKey: &ecdsaP256Key,
		DNSNames:   []string{"test"},
		// An ECC certificate with only the keyAgreement key usage may
		// be used with ECDH, but not ECDSA.
		KeyUsage: x509.KeyUsageKeyAgreement,
	}).ToCredential()

	for _, ver := range tlsVersions {
		if ver.version < VersionTLS12 {
			continue
		}

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "ECDSAKeyUsage-Client-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &cert,
			},
			shouldFail:    true,
			expectedError: ":KEY_USAGE_BIT_INCORRECT:",
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "ECDSAKeyUsage-Server-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &cert,
			},
			flags:         []string{"-require-any-client-certificate"},
			shouldFail:    true,
			expectedError: ":KEY_USAGE_BIT_INCORRECT:",
		})
	}
}

func addRSAKeyUsageTests() {
	dsCert := rootCA.Issue(X509Info{
		PrivateKey: &rsa2048Key,
		DNSNames:   []string{"test"},
		KeyUsage:   x509.KeyUsageDigitalSignature,
	}).ToCredential()
	encCert := rootCA.Issue(X509Info{
		PrivateKey: &rsa2048Key,
		DNSNames:   []string{"test"},
		KeyUsage:   x509.KeyUsageKeyEncipherment,
	}).ToCredential()

	dsSuites := []uint16{
		TLS_AES_128_GCM_SHA256,
		TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
	}
	encSuites := []uint16{
		TLS_RSA_WITH_AES_128_GCM_SHA256,
		TLS_RSA_WITH_AES_128_CBC_SHA,
	}

	for _, ver := range tlsVersions {
		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "RSAKeyUsage-Client-WantSignature-GotEncipherment-" + ver.name,
			config: Config{
				MinVersion:   ver.version,
				MaxVersion:   ver.version,
				Credential:   &encCert,
				CipherSuites: dsSuites,
			},
			shouldFail:    true,
			expectedError: ":KEY_USAGE_BIT_INCORRECT:",
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "RSAKeyUsage-Client-WantSignature-GotSignature-" + ver.name,
			config: Config{
				MinVersion:   ver.version,
				MaxVersion:   ver.version,
				Credential:   &dsCert,
				CipherSuites: dsSuites,
			},
		})

		// TLS 1.3 removes the encipherment suites.
		if ver.version < VersionTLS13 {
			testCases = append(testCases, testCase{
				testType: clientTest,
				name:     "RSAKeyUsage-Client-WantEncipherment-GotEncipherment" + ver.name,
				config: Config{
					MinVersion:   ver.version,
					MaxVersion:   ver.version,
					Credential:   &encCert,
					CipherSuites: encSuites,
				},
			})

			testCases = append(testCases, testCase{
				testType: clientTest,
				name:     "RSAKeyUsage-Client-WantEncipherment-GotSignature-" + ver.name,
				config: Config{
					MinVersion:   ver.version,
					MaxVersion:   ver.version,
					Credential:   &dsCert,
					CipherSuites: encSuites,
				},
				shouldFail:    true,
				expectedError: ":KEY_USAGE_BIT_INCORRECT:",
			})

			// In 1.2 and below, we should not enforce without the enforce-rsa-key-usage flag.
			testCases = append(testCases, testCase{
				testType: clientTest,
				name:     "RSAKeyUsage-Client-WantSignature-GotEncipherment-Unenforced-" + ver.name,
				config: Config{
					MinVersion:   ver.version,
					MaxVersion:   ver.version,
					Credential:   &dsCert,
					CipherSuites: encSuites,
				},
				flags: []string{"-expect-key-usage-invalid", "-ignore-rsa-key-usage"},
			})

			testCases = append(testCases, testCase{
				testType: clientTest,
				name:     "RSAKeyUsage-Client-WantEncipherment-GotSignature-Unenforced-" + ver.name,
				config: Config{
					MinVersion:   ver.version,
					MaxVersion:   ver.version,
					Credential:   &encCert,
					CipherSuites: dsSuites,
				},
				flags: []string{"-expect-key-usage-invalid", "-ignore-rsa-key-usage"},
			})
		}

		if ver.version >= VersionTLS13 {
			// In 1.3 and above, we enforce keyUsage even when disabled.
			testCases = append(testCases, testCase{
				testType: clientTest,
				name:     "RSAKeyUsage-Client-WantSignature-GotEncipherment-AlwaysEnforced-" + ver.name,
				config: Config{
					MinVersion:   ver.version,
					MaxVersion:   ver.version,
					Credential:   &encCert,
					CipherSuites: dsSuites,
				},
				flags:         []string{"-ignore-rsa-key-usage"},
				shouldFail:    true,
				expectedError: ":KEY_USAGE_BIT_INCORRECT:",
			})
		}

		// The server only uses signatures and always enforces it.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RSAKeyUsage-Server-WantSignature-GotEncipherment-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &encCert,
			},
			shouldFail:    true,
			expectedError: ":KEY_USAGE_BIT_INCORRECT:",
			flags:         []string{"-require-any-client-certificate"},
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "RSAKeyUsage-Server-WantSignature-GotSignature-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Credential: &dsCert,
			},
			flags: []string{"-require-any-client-certificate"},
		})

	}
}
