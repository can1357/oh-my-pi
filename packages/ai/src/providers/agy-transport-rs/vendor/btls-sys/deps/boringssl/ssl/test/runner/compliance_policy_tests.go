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

func addCompliancePolicyTests() {
	for _, protocol := range []protocol{tls, quic} {
		for _, suite := range testCipherSuites {
			var isFIPSCipherSuite bool
			switch suite.id {
			case TLS_AES_128_GCM_SHA256,
				TLS_AES_256_GCM_SHA384,
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:
				isFIPSCipherSuite = true
			}

			var isWPACipherSuite bool
			switch suite.id {
			case TLS_AES_256_GCM_SHA384,
				TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:
				isWPACipherSuite = true
			}

			var cert Credential
			if hasComponent(suite.name, "ECDSA") {
				cert = ecdsaP384Certificate
			} else {
				cert = rsaCertificate
			}

			maxVersion := uint16(VersionTLS13)
			if !isTLS13Suite(suite.name) {
				if protocol == quic {
					continue
				}
				maxVersion = VersionTLS12
			}

			policies := []struct {
				flag          string
				cipherSuiteOk bool
			}{
				{"-fips-202205", isFIPSCipherSuite},
				{"-wpa-202304", isWPACipherSuite},
			}

			for _, policy := range policies {
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Server-" + suite.name,
					config: Config{
						MinVersion:   VersionTLS12,
						MaxVersion:   maxVersion,
						CipherSuites: []uint16{suite.id},
					},
					shimCertificate: &cert,
					flags: []string{
						policy.flag,
					},
					shouldFail: !policy.cipherSuiteOk,
				})

				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Client-" + suite.name,
					config: Config{
						MinVersion:   VersionTLS12,
						MaxVersion:   maxVersion,
						CipherSuites: []uint16{suite.id},
						Credential:   &cert,
					},
					flags: []string{
						policy.flag,
					},
					shouldFail: !policy.cipherSuiteOk,
				})
			}
		}

		// Check that a TLS 1.3 client won't accept ChaCha20 even if the server
		// picks it without it being in the client's cipher list.
		testCases = append(testCases, testCase{
			testType: clientTest,
			protocol: protocol,
			name:     "Compliance-fips202205-" + protocol.String() + "-Client-ReallyWontAcceptChaCha",
			config: Config{
				MinVersion: VersionTLS12,
				MaxVersion: maxVersion,
				Bugs: ProtocolBugs{
					SendCipherSuite: TLS_CHACHA20_POLY1305_SHA256,
				},
			},
			flags: []string{
				"-fips-202205",
			},
			shouldFail:    true,
			expectedError: ":WRONG_CIPHER_RETURNED:",
		})

		for _, curve := range testCurves {
			var isFIPSCurve bool
			switch curve.id {
			case CurveP256, CurveP384:
				isFIPSCurve = true
			}

			var isWPACurve bool
			switch curve.id {
			case CurveP384:
				isWPACurve = true
			}

			policies := []struct {
				flag    string
				curveOk bool
			}{
				{"-fips-202205", isFIPSCurve},
				{"-wpa-202304", isWPACurve},
			}

			for _, policy := range policies {
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Server-" + curve.name,
					config: Config{
						MinVersion:       VersionTLS12,
						MaxVersion:       VersionTLS13,
						CurvePreferences: []CurveID{curve.id},
					},
					flags: []string{
						policy.flag,
					},
					shouldFail: !policy.curveOk,
				})

				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Client-" + curve.name,
					config: Config{
						MinVersion:       VersionTLS12,
						MaxVersion:       VersionTLS13,
						CurvePreferences: []CurveID{curve.id},
					},
					flags: []string{
						policy.flag,
					},
					shouldFail: !policy.curveOk,
				})
			}
		}

		for _, sigalg := range testSignatureAlgorithms {
			// The TLS 1.0 and TLS 1.1 default signature algorithm does not
			// apply to these tests.
			if sigalg.id == 0 {
				continue
			}

			var isFIPSSigAlg bool
			switch sigalg.id {
			case signatureRSAPKCS1WithSHA256,
				signatureRSAPKCS1WithSHA384,
				signatureRSAPKCS1WithSHA512,
				signatureECDSAWithP256AndSHA256,
				signatureECDSAWithP384AndSHA384,
				signatureRSAPSSWithSHA256,
				signatureRSAPSSWithSHA384,
				signatureRSAPSSWithSHA512:
				isFIPSSigAlg = true
			}

			var isWPASigAlg bool
			switch sigalg.id {
			case signatureRSAPKCS1WithSHA384,
				signatureRSAPKCS1WithSHA512,
				signatureECDSAWithP384AndSHA384,
				signatureRSAPSSWithSHA384,
				signatureRSAPSSWithSHA512:
				isWPASigAlg = true
			}

			maxVersion := uint16(VersionTLS13)
			if hasComponent(sigalg.name, "PKCS1") {
				if protocol == quic {
					continue
				}
				maxVersion = VersionTLS12
			}

			policies := []struct {
				flag     string
				sigAlgOk bool
			}{
				{"-fips-202205", isFIPSSigAlg},
				{"-wpa-202304", isWPASigAlg},
			}

			cert := sigalg.baseCert.WithSignatureAlgorithms(sigalg.id)
			for _, policy := range policies {
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Server-" + sigalg.name,
					config: Config{
						MinVersion:                VersionTLS12,
						MaxVersion:                maxVersion,
						VerifySignatureAlgorithms: []signatureAlgorithm{sigalg.id},
					},
					// Use the base certificate. We wish to pick up the signature algorithm
					// preferences from the FIPS policy.
					shimCertificate: sigalg.baseCert,
					flags:           []string{policy.flag},
					shouldFail:      !policy.sigAlgOk,
				})

				testCases = append(testCases, testCase{
					testType: clientTest,
					protocol: protocol,
					name:     "Compliance" + policy.flag + "-" + protocol.String() + "-Client-" + sigalg.name,
					config: Config{
						MinVersion: VersionTLS12,
						MaxVersion: maxVersion,
						Credential: cert,
					},
					flags: []string{
						policy.flag,
					},
					shouldFail: !policy.sigAlgOk,
				})
			}
		}

		// AES-256-GCM is the most preferred.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     "Compliance-cnsa202407-" + protocol.String() + "-AES-256-preferred",
			config: Config{
				MinVersion:   VersionTLS13,
				MaxVersion:   VersionTLS13,
				CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384},
			},
			flags: []string{
				"-cnsa-202407",
			},
			expectations: connectionExpectations{cipher: TLS_AES_256_GCM_SHA384},
		})

		// AES-128-GCM is preferred over ChaCha20-Poly1305.
		testCases = append(testCases, testCase{
			testType: serverTest,
			protocol: protocol,
			name:     "Compliance-cnsa202407-" + protocol.String() + "-AES-128-preferred",
			config: Config{
				MinVersion:   VersionTLS13,
				MaxVersion:   VersionTLS13,
				CipherSuites: []uint16{TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256},
			},
			flags: []string{
				"-cnsa-202407",
			},
			expectations: connectionExpectations{cipher: TLS_AES_128_GCM_SHA256},
		})
	}
}
