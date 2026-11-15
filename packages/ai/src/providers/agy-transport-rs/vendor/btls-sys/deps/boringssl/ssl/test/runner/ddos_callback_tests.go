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

func addDDoSCallbackTests() {
	// DDoS callback.
	for _, resume := range []bool{false, true} {
		suffix := "Resume"
		if resume {
			suffix = "No" + suffix
		}

		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "Server-DDoS-OK-" + suffix,
			config: Config{
				MaxVersion: VersionTLS12,
			},
			flags:         []string{"-install-ddos-callback"},
			resumeSession: resume,
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "Server-DDoS-OK-" + suffix + "-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			flags:         []string{"-install-ddos-callback"},
			resumeSession: resume,
		})

		failFlag := "-fail-ddos-callback"
		if resume {
			failFlag = "-on-resume-fail-ddos-callback"
		}
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "Server-DDoS-Reject-" + suffix,
			config: Config{
				MaxVersion: VersionTLS12,
			},
			flags:              []string{"-install-ddos-callback", failFlag},
			resumeSession:      resume,
			shouldFail:         true,
			expectedError:      ":CONNECTION_REJECTED:",
			expectedLocalError: "remote error: internal error",
		})
		testCases = append(testCases, testCase{
			testType: serverTest,
			name:     "Server-DDoS-Reject-" + suffix + "-TLS13",
			config: Config{
				MaxVersion: VersionTLS13,
			},
			flags:              []string{"-install-ddos-callback", failFlag},
			resumeSession:      resume,
			shouldFail:         true,
			expectedError:      ":CONNECTION_REJECTED:",
			expectedLocalError: "remote error: internal error",
		})
	}
}
