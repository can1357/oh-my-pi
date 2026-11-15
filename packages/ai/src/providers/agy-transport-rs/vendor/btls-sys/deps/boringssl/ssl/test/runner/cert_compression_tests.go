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
	"bytes"
	"crypto/rand"
	"fmt"
	"strconv"
)

const (
	shrinkingCompressionAlgID = 0xff01
	expandingCompressionAlgID = 0xff02
	randomCompressionAlgID    = 0xff03
)

var (
	// shrinkingPrefix is the first two bytes of a Certificate message.
	shrinkingPrefix = []byte{0, 0}
	// expandingPrefix is just some arbitrary byte string. This has to match the
	// value in the shim.
	expandingPrefix = []byte{1, 2, 3, 4}
)

var shrinkingCompression = CertCompressionAlg{
	Compress: func(uncompressed []byte) []byte {
		if !bytes.HasPrefix(uncompressed, shrinkingPrefix) {
			panic(fmt.Sprintf("cannot compress certificate message %x", uncompressed))
		}
		return uncompressed[len(shrinkingPrefix):]
	},
	Decompress: func(out []byte, compressed []byte) bool {
		if len(out) != len(shrinkingPrefix)+len(compressed) {
			return false
		}

		copy(out, shrinkingPrefix)
		copy(out[len(shrinkingPrefix):], compressed)
		return true
	},
}

var expandingCompression = CertCompressionAlg{
	Compress: func(uncompressed []byte) []byte {
		ret := make([]byte, 0, len(expandingPrefix)+len(uncompressed))
		ret = append(ret, expandingPrefix...)
		return append(ret, uncompressed...)
	},
	Decompress: func(out []byte, compressed []byte) bool {
		if !bytes.HasPrefix(compressed, expandingPrefix) {
			return false
		}
		copy(out, compressed[len(expandingPrefix):])
		return true
	},
}

var randomCompression = CertCompressionAlg{
	Compress: func(uncompressed []byte) []byte {
		ret := make([]byte, 1+len(uncompressed))
		if _, err := rand.Read(ret[:1]); err != nil {
			panic(err)
		}
		copy(ret[1:], uncompressed)
		return ret
	},
	Decompress: func(out []byte, compressed []byte) bool {
		if len(compressed) != 1+len(out) {
			return false
		}
		copy(out, compressed[1:])
		return true
	},
}

func addCertCompressionTests() {
	for _, ver := range tlsVersions {
		if ver.version < VersionTLS12 {
			continue
		}

		// Duplicate compression algorithms is an error, even if nothing is
		// configured.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "DuplicateCertCompressionExt-" + ver.name,
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Bugs: ProtocolBugs{
					DuplicateCompressedCertAlgs: true,
				},
			},
			shouldFail:    true,
			expectedError: ":ERROR_PARSING_EXTENSION:",
		})

		// With compression algorithms configured, an duplicate values should still
		// be an error.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "DuplicateCertCompressionExt2-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				Bugs: ProtocolBugs{
					DuplicateCompressedCertAlgs: true,
				},
			},
			shouldFail:    true,
			expectedError: ":ERROR_PARSING_EXTENSION:",
		})

		if ver.version < VersionTLS13 {
			testCases = append(testCases, testCase{
				testType: serverTest,
				name:     "CertCompressionIgnoredBefore13-" + ver.name,
				flags:    []string{"-install-cert-compression-algs"},
				config: Config{
					MinVersion: ver.version,
					MaxVersion: ver.version,
					CertCompressionAlgs: map[uint16]CertCompressionAlg{
						expandingCompressionAlgID: expandingCompression,
					},
				},
			})

			continue
		}

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CertCompressionExpands-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					expandingCompressionAlgID: expandingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: expandingCompressionAlgID,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CertCompressionShrinks-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: shrinkingCompressionAlgID,
				},
			},
		})

		// Test that the shim behaves consistently if the compression function
		// is non-deterministic. This is intended to model version differences
		// between the shim and handshaker with handshake hints, but it is also
		// useful in confirming we only call the callbacks once.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CertCompressionRandom-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					randomCompressionAlgID: randomCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: randomCompressionAlgID,
				},
			},
		})

		// With both algorithms configured, the server should pick its most
		// preferable. (Which is expandingCompressionAlgID.)
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CertCompressionPriority-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
					expandingCompressionAlgID: expandingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: expandingCompressionAlgID,
				},
			},
		})

		// With no common algorithms configured, the server should decline
		// compression.
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "CertCompressionNoCommonAlgs-" + ver.name,
			flags:    []string{"-install-one-cert-compression-alg", strconv.Itoa(shrinkingCompressionAlgID)},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					expandingCompressionAlgID: expandingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectUncompressedCert: true,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "CertCompressionExpandsClient-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					expandingCompressionAlgID: expandingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: expandingCompressionAlgID,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "CertCompressionShrinksClient-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert: shrinkingCompressionAlgID,
				},
			},
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "CertCompressionBadAlgIDClient-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert:   shrinkingCompressionAlgID,
					SendCertCompressionAlgID: 1234,
				},
			},
			shouldFail:    true,
			expectedError: ":UNKNOWN_CERT_COMPRESSION_ALG:",
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "CertCompressionTooSmallClient-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert:     shrinkingCompressionAlgID,
					SendCertUncompressedLength: 12,
				},
			},
			shouldFail:    true,
			expectedError: ":CERT_DECOMPRESSION_FAILED:",
		})

		testCases = append(testCases, testCase{
			testType: clientTest,
			name:     "CertCompressionTooLargeClient-" + ver.name,
			flags:    []string{"-install-cert-compression-algs"},
			config: Config{
				MinVersion: ver.version,
				MaxVersion: ver.version,
				CertCompressionAlgs: map[uint16]CertCompressionAlg{
					shrinkingCompressionAlgID: shrinkingCompression,
				},
				Bugs: ProtocolBugs{
					ExpectedCompressedCert:     shrinkingCompressionAlgID,
					SendCertUncompressedLength: 1 << 20,
				},
			},
			shouldFail:    true,
			expectedError: ":UNCOMPRESSED_CERT_TOO_LARGE:",
		})
	}
}
