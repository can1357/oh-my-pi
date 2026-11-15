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
	"slices"
	"strconv"
	"time"
)

func addDTLSReplayTests() {
	for _, vers := range allVersions(dtls) {
		// Test that sequence number replays are detected.
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "DTLS-Replay-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
			},
			messageCount: 200,
			replayWrites: true,
		})

		// Test the incoming sequence number skipping by values larger
		// than the retransmit window.
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "DTLS-Replay-LargeGaps-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Bugs: ProtocolBugs{
					SequenceNumberMapping: func(in uint64) uint64 {
						return in * 1023
					},
				},
			},
			messageCount: 200,
			replayWrites: true,
		})

		// Test the incoming sequence number changing non-monotonically.
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "DTLS-Replay-NonMonotonic-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Bugs: ProtocolBugs{
					SequenceNumberMapping: func(in uint64) uint64 {
						// This mapping has numbers counting backwards in groups
						// of 256, and then jumping forwards 511 numbers.
						return in ^ 255
					},
				},
			},
			// This messageCount is large enough to make sure that the SequenceNumberMapping
			// will reach the point where it jumps forwards after stepping backwards.
			messageCount: 500,
			replayWrites: true,
		})
	}
}

// timeouts is the default retransmit schedule for BoringSSL. It doubles and
// caps at 60 seconds. On the 13th timeout, it gives up.
var timeouts = []time.Duration{
	400 * time.Millisecond,
	800 * time.Millisecond,
	1600 * time.Millisecond,
	3200 * time.Millisecond,
	6400 * time.Millisecond,
	12800 * time.Millisecond,
	25600 * time.Millisecond,
	51200 * time.Millisecond,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
}

// shortTimeouts is an alternate set of timeouts which would occur if the
// initial timeout duration was set to 250ms.
var shortTimeouts = []time.Duration{
	250 * time.Millisecond,
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
	4 * time.Second,
	8 * time.Second,
	16 * time.Second,
	32 * time.Second,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
	60 * time.Second,
}

// dtlsPrevEpochExpiration is how long before the shim releases old epochs. Add
// an extra second to allow the shim to be less precise.
const dtlsPrevEpochExpiration = 4*time.Minute + 1*time.Second

func addDTLSRetransmitTests() {
	for _, shortTimeout := range []bool{false, true} {
		for _, vers := range allVersions(dtls) {
			suffix := "-" + vers.name
			flags := []string{"-async"} // Retransmit tests require async.
			useTimeouts := timeouts
			if shortTimeout {
				suffix += "-Short"
				flags = append(flags, "-initial-timeout-duration-ms", "250")
				useTimeouts = shortTimeouts
			}

			// Testing NewSessionTicket is tricky. First, BoringSSL sends two
			// tickets in a row. These are conceptually separate flights, but we
			// test them as one flight. Second, these tickets are sent
			// concurrently with the runner's first test message. The shim's
			// reply will come in before any retransmit challenges.
			// handleNewSessionTicket corrects for both effects.
			handleNewSessionTicket := func(f ACKFlightFunc) ACKFlightFunc {
				if vers.version < VersionTLS13 {
					return f
				}
				return func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
					// BoringSSL sends two NewSessionTickets in a row.
					if received[0].Type == typeNewSessionTicket && len(received) < 2 {
						c.MergeIntoNextFlight()
						return
					}
					// NewSessionTicket is sent in parallel with the runner's
					// first application data. Consume the shim's reply.
					testMessage := makeTestMessage(0, 32)
					if received[0].Type == typeNewSessionTicket {
						c.ReadAppData(c.InEpoch(), expectedReply(testMessage))
					}
					// Run the test, without any stray messages in the way.
					f(c, prev, received, records)
					// The test loop is expecting a reply to the first message.
					// Prime the shim to send it again.
					if received[0].Type == typeNewSessionTicket {
						c.WriteAppData(c.OutEpoch(), testMessage)
					}
				}
			}

			// In all versions, the sender will retransmit the whole flight if
			// it times out and hears nothing.
			writeFlightBasic := func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
				if len(received) > 0 {
					// Exercise every timeout but the last one (which would fail the
					// connection).
					for _, t := range useTimeouts[:len(useTimeouts)-1] {
						c.ExpectNextTimeout(t)
						c.AdvanceClock(t)
						c.ReadRetransmit()
					}
					c.ExpectNextTimeout(useTimeouts[len(useTimeouts)-1])
				}
				// Finally release the whole flight to the shim.
				c.WriteFlight(next)
			}
			ackFlightBasic := handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
				if vers.version >= VersionTLS13 {
					// In DTLS 1.3, final flights (either handshake or post-handshake)
					// are retransmitted until ACKed. Exercise every timeout but
					// the last one (which would fail the connection).
					for _, t := range useTimeouts[:len(useTimeouts)-1] {
						c.ExpectNextTimeout(t)
						c.AdvanceClock(t)
						c.ReadRetransmit()
					}
					c.ExpectNextTimeout(useTimeouts[len(useTimeouts)-1])
					// Finally ACK the flight.
					c.WriteACK(c.OutEpoch(), records)
					return
				}
				// In DTLS 1.2, the final flight is retransmitted on receipt of
				// the previous flight. Test the peer is willing to retransmit
				// it several times.
				for i := 0; i < 5; i++ {
					c.WriteFlight(prev)
					c.ReadRetransmit()
				}
			})
			testCases = append(testCases, testCase{
				protocol: dtls,
				name:     "DTLS-Retransmit-Client-Basic" + suffix,
				config: Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						WriteFlightDTLS: writeFlightBasic,
						ACKFlightDTLS:   ackFlightBasic,
					},
				},
				resumeSession: true,
				flags:         flags,
			})
			testCases = append(testCases, testCase{
				protocol: dtls,
				testType: serverTest,
				name:     "DTLS-Retransmit-Server-Basic" + suffix,
				config: Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						WriteFlightDTLS: writeFlightBasic,
						ACKFlightDTLS:   ackFlightBasic,
					},
				},
				resumeSession: true,
				flags:         flags,
			})

			if vers.version <= VersionTLS12 {
				// In DTLS 1.2, receiving a part of the next flight should not stop
				// the retransmission timer.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-PartialProgress" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								// Send a portion of the first message. The rest was lost.
								msg := next[0]
								split := len(msg.Data) / 2
								c.WriteFragments([]DTLSFragment{msg.Fragment(0, split)})
								// If we time out, the shim should still retransmit. It knows
								// we received the whole flight, but the shim should use a
								// retransmit to request the runner try again.
								c.AdvanceClock(useTimeouts[0])
								c.ReadRetransmit()
								// "Retransmit" the rest of the flight. The shim should remember
								// the portion that was already sent.
								rest := []DTLSFragment{msg.Fragment(split, len(msg.Data)-split)}
								for _, m := range next[1:] {
									rest = append(rest, m.Fragment(0, len(m.Data)))
								}
								c.WriteFragments(rest)
							},
						},
					},
					flags: flags,
				})
			} else {
				// In DTLS 1.3, receiving a part of the next flight implicitly ACKs
				// the previous flight.
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: dtls,
					name:     "DTLS-Retransmit-PartialProgress-Server" + suffix,
					config: Config{
						MaxVersion:    vers.version,
						DefaultCurves: []CurveID{}, // Force HelloRetryRequest.
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) == 0 && next[0].Type == typeClientHello {
									// Send the initial ClientHello as-is.
									c.WriteFlight(next)
									return
								}

								// Send a portion of the first message. The rest was lost.
								msg := next[0]
								split := len(msg.Data) / 2
								c.WriteFragments([]DTLSFragment{msg.Fragment(0, split)})
								// After waiting the current timeout, the shim should ACK
								// the partial flight.
								c.ExpectNextTimeout(useTimeouts[0] / 4)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())
								// The partial flight is enough to ACK the previous flight.
								// The shim should stop retransmitting and even stop the
								// retransmit timer.
								c.ExpectNoNextTimeout()
								for _, t := range useTimeouts {
									c.AdvanceClock(t)
								}
								// "Retransmit" the rest of the flight. The shim should remember
								// the portion that was already sent.
								rest := []DTLSFragment{msg.Fragment(split, len(msg.Data)-split)}
								for _, m := range next[1:] {
									rest = append(rest, m.Fragment(0, len(m.Data)))
								}
								c.WriteFragments(rest)
							},
						},
					},
					flags: flags,
				})

				// When the shim is a client, receiving fragments before the version is
				// known does not trigger this behavior.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-PartialProgress-Client" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								msg := next[0]
								if msg.Type != typeServerHello {
									// Post-handshake is tested separately.
									c.WriteFlight(next)
									return
								}
								// Send a portion of the ServerHello. The rest was lost.
								split := len(msg.Data) / 2
								c.WriteFragments([]DTLSFragment{msg.Fragment(0, split)})

								// The shim did not know this was DTLS 1.3, so it still
								// retransmits ClientHello.
								c.ExpectNextTimeout(useTimeouts[0])
								c.AdvanceClock(useTimeouts[0])
								c.ReadRetransmit()

								// Finish the ServerHello. The version is still not known,
								// at the time the ServerHello fragment is processed, This
								// is not as efficient as we could be; we could go back and
								// implicitly ACK once the version is known. But the last
								// byte of ServerHello will almost certainly be in the same
								// packet as EncryptedExtensions, which will trigger the case
								// below.
								c.WriteFragments([]DTLSFragment{msg.Fragment(split, len(msg.Data)-split)})
								c.ExpectNextTimeout(useTimeouts[1])
								c.AdvanceClock(useTimeouts[1])
								c.ReadRetransmit()

								// Send EncryptedExtensions. The shim now knows the version.
								c.WriteFragments([]DTLSFragment{next[1].Fragment(0, len(next[1].Data))})

								// The shim should ACK the partial flight. The shim hasn't
								// gotten to epoch 3 yet, so the ACK will come in epoch 2.
								c.AdvanceClock(useTimeouts[2] / 4)
								c.ReadACK(uint16(encryptionHandshake))

								// This is enough to ACK the previous flight. The shim
								// should stop retransmitting and even stop the timer.
								c.ExpectNoNextTimeout()
								for _, t := range useTimeouts[2:] {
									c.AdvanceClock(t)
								}

								// "Retransmit" the rest of the flight. The shim should remember
								// the portion that was already sent.
								var rest []DTLSFragment
								for _, m := range next[2:] {
									rest = append(rest, m.Fragment(0, len(m.Data)))
								}
								c.WriteFragments(rest)
							},
						},
					},
					flags: flags,
				})
			}

			// Test that exceeding the timeout schedule hits a read
			// timeout.
			testCases = append(testCases, testCase{
				protocol: dtls,
				name:     "DTLS-Retransmit-Timeout" + suffix,
				config: Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
							for _, t := range useTimeouts[:len(useTimeouts)-1] {
								c.ExpectNextTimeout(t)
								c.AdvanceClock(t)
								c.ReadRetransmit()
							}
							c.ExpectNextTimeout(useTimeouts[len(useTimeouts)-1])
							c.AdvanceClock(useTimeouts[len(useTimeouts)-1])
							// The shim should give up at this point.
						},
					},
				},
				resumeSession: true,
				flags:         flags,
				shouldFail:    true,
				expectedError: ":READ_TIMEOUT_EXPIRED:",
			})

			// Test that timeout handling has a fudge factor, due to API
			// problems.
			testCases = append(testCases, testCase{
				protocol: dtls,
				name:     "DTLS-Retransmit-Fudge" + suffix,
				config: Config{
					MaxVersion: vers.version,
					Bugs: ProtocolBugs{
						WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
							if len(received) > 0 {
								c.ExpectNextTimeout(useTimeouts[0])
								c.AdvanceClock(useTimeouts[0] - 10*time.Millisecond)
								c.ReadRetransmit()
							}
							c.WriteFlight(next)
						},
					},
				},
				resumeSession: true,
				flags:         flags,
			})

			// Test that the shim can retransmit at different MTUs.
			testCases = append(testCases, testCase{
				protocol: dtls,
				name:     "DTLS-Retransmit-ChangeMTU" + suffix,
				config: Config{
					MaxVersion: vers.version,
					// Request a client certificate, so the shim has more to send.
					ClientAuth: RequireAnyClientCert,
					Bugs: ProtocolBugs{
						WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
							for i, mtu := range []int{300, 301, 302, 303, 299, 298, 297} {
								c.SetMTU(mtu)
								c.AdvanceClock(useTimeouts[i])
								c.ReadRetransmit()
							}
							c.WriteFlight(next)
						},
					},
				},
				shimCertificate: &rsaChainCertificate,
				flags:           flags,
			})

			// DTLS 1.3 uses explicit ACKs.
			if vers.version >= VersionTLS13 {
				// The two server flights (HelloRetryRequest and ServerHello..Finished)
				// happen after the shim has learned the version, so they are more
				// straightforward. In these tests, we trigger HelloRetryRequest,
				// and also use ML-KEM with rsaChainCertificate and a limited MTU,
				// to increase the number of records and exercise more complex
				// ACK patterns.

				// After ACKing everything, the shim should stop retransmitting.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKEverything" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						Credential:       &rsaChainCertificate,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						DefaultCurves:    []CurveID{}, // Force HelloRetryRequest.
						Bugs: ProtocolBugs{
							// Send smaller packets to exercise more ACK cases.
							MaxPacketLength:          512,
							MaxHandshakeRecordLength: 512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									c.ExpectNextTimeout(useTimeouts[0])
									c.WriteACK(ackEpoch, records)
									// After everything is ACKed, the shim should stop the timer
									// and wait for the next flight.
									c.ExpectNoNextTimeout()
									for _, t := range useTimeouts {
										c.AdvanceClock(t)
									}
								}
								c.WriteFlight(next)
							},
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								ackEpoch := received[len(received)-1].Epoch
								c.ExpectNextTimeout(useTimeouts[0])
								c.WriteACK(ackEpoch, records)
								// After everything is ACKed, the shim should stop the timer.
								c.ExpectNoNextTimeout()
								for _, t := range useTimeouts {
									c.AdvanceClock(t)
								}
							}),
							SequenceNumberMapping: func(in uint64) uint64 {
								// Perturb sequence numbers to test that ACKs are sorted.
								return in ^ 63
							},
						},
					},
					shimCertificate: &rsaChainCertificate,
					flags: slices.Concat(flags, []string{
						"-mtu", "512",
						"-curves", strconv.Itoa(int(CurveX25519MLKEM768)),
						// Request a client certificate so the client final flight is
						// larger.
						"-require-any-client-certificate",
					}),
				})

				// ACK packets one by one, in reverse.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKReverse" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						DefaultCurves:    []CurveID{}, // Force HelloRetryRequest.
						Bugs: ProtocolBugs{
							MaxPacketLength: 512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									for _, t := range useTimeouts[:len(useTimeouts)-1] {
										if len(records) > 0 {
											c.WriteACK(ackEpoch, []DTLSRecordNumberInfo{records[len(records)-1]})
										}
										c.AdvanceClock(t)
										records = c.ReadRetransmit()
									}
								}
								c.WriteFlight(next)
							},
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								ackEpoch := received[len(received)-1].Epoch
								for _, t := range useTimeouts[:len(useTimeouts)-1] {
									if len(records) > 0 {
										c.WriteACK(ackEpoch, []DTLSRecordNumberInfo{records[len(records)-1]})
									}
									c.AdvanceClock(t)
									records = c.ReadRetransmit()
								}
							}),
						},
					},
					shimCertificate: &rsaChainCertificate,
					flags:           slices.Concat(flags, []string{"-mtu", "512", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// ACK packets one by one, forwards.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKForwards" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						DefaultCurves:    []CurveID{}, // Force HelloRetryRequest.
						Bugs: ProtocolBugs{
							MaxPacketLength: 512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									for _, t := range useTimeouts[:len(useTimeouts)-1] {
										if len(records) > 0 {
											c.WriteACK(ackEpoch, []DTLSRecordNumberInfo{records[0]})
										}
										c.AdvanceClock(t)
										records = c.ReadRetransmit()
									}
								}
								c.WriteFlight(next)
							},
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								ackEpoch := received[len(received)-1].Epoch
								for _, t := range useTimeouts[:len(useTimeouts)-1] {
									if len(records) > 0 {
										c.WriteACK(ackEpoch, []DTLSRecordNumberInfo{records[0]})
									}
									c.AdvanceClock(t)
									records = c.ReadRetransmit()
								}
							}),
						},
					},
					shimCertificate: &rsaChainCertificate,
					flags:           slices.Concat(flags, []string{"-mtu", "512", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// ACK 1/3 the packets each time.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKIterate" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						DefaultCurves:    []CurveID{}, // Force HelloRetryRequest.
						Bugs: ProtocolBugs{
							MaxPacketLength: 512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									for i, t := range useTimeouts[:len(useTimeouts)-1] {
										if len(records) > 0 {
											ack := make([]DTLSRecordNumberInfo, 0, (len(records)+2)/3)
											for i := 0; i < len(records); i += 3 {
												ack = append(ack, records[i])
											}
											c.WriteACK(ackEpoch, ack)
										}
										// Change the MTU every iteration, to make the fragment
										// patterns more complex.
										c.SetMTU(512 + i)
										c.AdvanceClock(t)
										records = c.ReadRetransmit()
									}
								}
								c.WriteFlight(next)
							},
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								ackEpoch := received[len(received)-1].Epoch
								for _, t := range useTimeouts[:len(useTimeouts)-1] {
									if len(records) > 0 {
										c.WriteACK(ackEpoch, []DTLSRecordNumberInfo{records[0]})
									}
									c.AdvanceClock(t)
									records = c.ReadRetransmit()
								}
							}),
						},
					},
					shimCertificate: &rsaChainCertificate,
					flags:           slices.Concat(flags, []string{"-mtu", "512", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// ACKing packets that have already been ACKed is a no-op.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKDuplicate" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							SendHelloRetryRequestCookie: []byte("cookie"),
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									// Keep ACKing the same record over and over.
									c.WriteACK(ackEpoch, records[:1])
									c.AdvanceClock(useTimeouts[0])
									c.ReadRetransmit()
									c.WriteACK(ackEpoch, records[:1])
									c.AdvanceClock(useTimeouts[1])
									c.ReadRetransmit()
								}
								c.WriteFlight(next)
							},
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								ackEpoch := received[len(received)-1].Epoch
								// Keep ACKing the same record over and over.
								c.WriteACK(ackEpoch, records[:1])
								c.AdvanceClock(useTimeouts[0])
								c.ReadRetransmit()
								c.WriteACK(ackEpoch, records[:1])
								c.AdvanceClock(useTimeouts[1])
								c.ReadRetransmit()
								// ACK everything to clear the timer.
								c.WriteACK(ackEpoch, records)
							}),
						},
					},
					flags: flags,
				})

				// When ACKing ServerHello..Finished, the ServerHello might be
				// ACKed at epoch 0 or epoch 2, depending on how far the client
				// received. Test that epoch 0 is allowed by ACKing each packet
				// at the record it was received.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKMatchingEpoch" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									for _, t := range useTimeouts[:len(useTimeouts)-1] {
										if len(records) > 0 {
											c.WriteACK(uint16(records[0].Epoch), []DTLSRecordNumberInfo{records[0]})
										}
										c.AdvanceClock(t)
										records = c.ReadRetransmit()
									}
								}
								c.WriteFlight(next)
							},
						},
					},
					flags: flags,
				})

				// However, records in the handshake may not be ACKed at lower
				// epoch than they were received.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKBadEpoch" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) == 0 {
									// Send the ClientHello.
									c.WriteFlight(next)
								} else {
									// Try to ACK ServerHello..Finished at epoch 0. The shim should reject this.
									c.WriteACK(0, records)
								}
							},
						},
					},
					flags:         flags,
					shouldFail:    true,
					expectedError: ":DECODE_ERROR:",
				})

				// The bad epoch check should notice when the epoch number
				// would overflow 2^16.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKEpochOverflow" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) == 0 {
									// Send the ClientHello.
									c.WriteFlight(next)
								} else {
									r := records[0]
									r.Epoch += 1 << 63
									c.WriteACK(0, []DTLSRecordNumberInfo{r})
								}
							},
						},
					},
					flags:         flags,
					shouldFail:    true,
					expectedError: ":DECODE_ERROR:",
				})

				// ACK some records from the first transmission, trigger a
				// retransmit, but then ACK the rest of the first transmission.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKOldRecords" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						Bugs: ProtocolBugs{
							MaxPacketLength: 512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									ackEpoch := received[len(received)-1].Epoch
									c.WriteACK(ackEpoch, records[len(records)/2:])
									c.AdvanceClock(useTimeouts[0])
									c.ReadRetransmit()
									c.WriteACK(ackEpoch, records[:len(records)/2])
									// Everything should be ACKed now. The shim should not
									// retransmit anything.
									c.AdvanceClock(useTimeouts[1])
									c.AdvanceClock(useTimeouts[2])
									c.AdvanceClock(useTimeouts[3])
								}
								c.WriteFlight(next)
							},
						},
					},
					flags: slices.Concat(flags, []string{"-mtu", "512", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// If the shim sends too many records, it will eventually forget them.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKForgottenRecords" + suffix,
					config: Config{
						MaxVersion:       vers.version,
						CurvePreferences: []CurveID{CurveX25519MLKEM768},
						Bugs: ProtocolBugs{
							MaxPacketLength: 256,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) > 0 {
									// Make the peer retransmit many times, with a small MTU.
									for _, t := range useTimeouts[:len(useTimeouts)-2] {
										c.AdvanceClock(t)
										c.ReadRetransmit()
									}
									// ACK the first record the shim ever sent. It will have
									// fallen off the queue by now, so it is expected to not
									// impact the shim's retransmissions.
									c.WriteACK(c.OutEpoch(), []DTLSRecordNumberInfo{{DTLSRecordNumber: records[0].DTLSRecordNumber}})
									c.AdvanceClock(useTimeouts[len(useTimeouts)-2])
									c.ReadRetransmit()
								}
								c.WriteFlight(next)
							},
						},
					},
					flags: slices.Concat(flags, []string{"-mtu", "256", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// The shim should ignore ACKs for a previous flight, and not get its
				// internal state confused.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKPreviousFlight" + suffix,
					config: Config{
						MaxVersion:    vers.version,
						DefaultCurves: []CurveID{}, // Force a HelloRetryRequest.
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[len(next)-1].Type == typeFinished {
									// We are now sending client Finished, in response
									// to the shim's ServerHello. ACK the shim's first
									// record, which would have been part of
									// HelloRetryRequest. This should not impact retransmit.
									c.WriteACK(c.OutEpoch(), []DTLSRecordNumberInfo{{DTLSRecordNumber: DTLSRecordNumber{Epoch: 0, Sequence: 0}}})
									c.AdvanceClock(useTimeouts[0])
									c.ReadRetransmit()
								}
								c.WriteFlight(next)
							},
						},
					},
					flags: flags,
				})

				// Records that contain a mix of discarded and processed fragments should
				// not be ACKed.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-DoNotACKDiscardedFragments" + suffix,
					config: Config{
						MaxVersion:    vers.version,
						DefaultCurves: []CurveID{}, // Force a HelloRetryRequest.
						Bugs: ProtocolBugs{
							PackHandshakeFragments: 4096,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								// Send the flight, but combine every fragment with a far future
								// fragment, which the shim will discard. During the handshake,
								// the shim has enough information to reject this entirely, but
								// that would require coordinating with the handshake state
								// machine. Instead, BoringSSL discards the fragment and skips
								// ACKing the packet.
								//
								// runner implicitly tests that the shim ACKs the Finished flight
								// (or, in case, that it is does not), so this exercises the final
								// ACK.
								for _, msg := range next {
									shouldDiscard := DTLSFragment{Epoch: msg.Epoch, Sequence: 1000, ShouldDiscard: true}
									c.WriteFragments([]DTLSFragment{shouldDiscard, msg.Fragment(0, len(msg.Data))})
									// The shim has nothing to ACK and thus no ACK timer (which
									// would be 1/4 of this value).
									c.ExpectNextTimeout(useTimeouts[0])
								}
							},
						},
					},
					flags: flags,
				})

				// The server must continue to ACK the Finished flight even after
				// receiving application data from the client.
				testCases = append(testCases, testCase{
					protocol: dtls,
					testType: serverTest,
					name:     "DTLS-Retransmit-Server-ACKFinishedAfterAppData" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							// WriteFlightDTLS will handle consuming ACKs.
							SkipImplicitACKRead: true,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[len(next)-1].Type != typeFinished {
									c.WriteFlight(next)
									return
								}

								// Write Finished. The shim should ACK it immediately.
								c.WriteFlight(next)
								c.ReadACK(c.InEpoch())

								// Exchange some application data.
								msg := []byte("hello")
								c.WriteAppData(c.OutEpoch(), msg)
								c.ReadAppData(c.InEpoch(), expectedReply(msg))

								// Act as if the ACK was dropped and retransmit Finished.
								// The shim should process the retransmit from epoch 2 and
								// ACK, although it has already received data at epoch 3.
								c.WriteFlight(next)
								ackTimeout := useTimeouts[0] / 4
								c.AdvanceClock(ackTimeout)
								c.ReadACK(c.InEpoch())

								// Partially retransmit Finished. The shim should continue
								// to ACK.
								c.WriteFragments([]DTLSFragment{next[0].Fragment(0, 1)})
								c.WriteFragments([]DTLSFragment{next[0].Fragment(1, 1)})
								c.AdvanceClock(ackTimeout)
								c.ReadACK(c.InEpoch())

								// Eventually, the shim assumes we have received the ACK
								// and drops epoch 2. Retransmits now go unanswered.
								c.AdvanceClock(dtlsPrevEpochExpiration)
								c.WriteFlight(next)
							},
						},
					},
					// Disable tickets on the shim to avoid NewSessionTicket
					// interfering with the test callback.
					flags: slices.Concat(flags, []string{"-no-ticket"}),
				})

				// As a client, the shim must tolerate ACKs in response to its
				// initial ClientHello, but it will not process them because the
				// version is not yet known. The second ClientHello, in response
				// to HelloRetryRequest, however, is ACKed.
				//
				// The shim must additionally process ACKs and retransmit its
				// Finished flight, possibly interleaved with application data.
				// (The server may send half-RTT data without Finished.)
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-Client" + suffix,
					config: Config{
						MaxVersion: vers.version,
						// Require a client certificate, so the Finished flight
						// is large.
						ClientAuth: RequireAnyClientCert,
						Bugs: ProtocolBugs{
							SendHelloRetryRequestCookie: []byte("cookie"), // Send HelloRetryRequest
							MaxPacketLength:             512,
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if len(received) == 0 || received[0].Type != typeClientHello {
									// We test post-handshake flights separately.
									c.WriteFlight(next)
									return
								}

								// This is either HelloRetryRequest in response to ClientHello1,
								// or ServerHello..Finished in response to ClientHello2.
								first := records[0]
								if len(prev) == 0 {
									// This is HelloRetryRequest in response to ClientHello1. The client
									// will accept the ACK, but it will ignore it. Do not expect
									// retransmits to be impacted.
									first.MessageStartSequence = 0
									first.MessageStartOffset = 0
									first.MessageEndSequence = 0
									first.MessageEndOffset = 0
								}
								c.WriteACK(0, []DTLSRecordNumberInfo{first})
								c.AdvanceClock(useTimeouts[0])
								c.ReadRetransmit()
								c.WriteFlight(next)
							},
							ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								// The shim will process application data without an ACK.
								msg := []byte("hello")
								c.WriteAppData(c.OutEpoch(), msg)
								c.ReadAppData(c.InEpoch(), expectedReply(msg))

								// After a timeout, the shim will retransmit Finished.
								c.AdvanceClock(useTimeouts[0])
								c.ReadRetransmit()

								// Application data still flows.
								c.WriteAppData(c.OutEpoch(), msg)
								c.ReadAppData(c.InEpoch(), expectedReply(msg))

								// ACK part of the flight and check that retransmits
								// are updated.
								c.WriteACK(c.OutEpoch(), records[len(records)/3:2*len(records)/3])
								c.AdvanceClock(useTimeouts[1])
								records = c.ReadRetransmit()

								// ACK the rest. Retransmits should stop.
								c.WriteACK(c.OutEpoch(), records)
								for _, t := range useTimeouts[2:] {
									c.AdvanceClock(t)
								}
							},
						},
					},
					shimCertificate: &rsaChainCertificate,
					flags:           slices.Concat(flags, []string{"-mtu", "512", "-curves", strconv.Itoa(int(CurveX25519MLKEM768))}),
				})

				// If the client never receives an ACK for the Finished flight, it
				// is eventually fatal.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-Client-FinishedTimeout" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								for _, t := range useTimeouts[:len(useTimeouts)-1] {
									c.AdvanceClock(t)
									c.ReadRetransmit()
								}
								c.AdvanceClock(useTimeouts[len(useTimeouts)-1])
							},
						},
					},
					flags:         flags,
					shouldFail:    true,
					expectedError: ":READ_TIMEOUT_EXPIRED:",
				})

				// Neither post-handshake messages nor application data implicitly
				// ACK the Finished flight. The server may have sent either in
				// half-RTT data. Test that the client continues to retransmit
				// despite this.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-Client-NoImplictACKFinished" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								// Merge the Finished flight into the NewSessionTicket.
								c.MergeIntoNextFlight()
							},
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[0].Type != typeNewSessionTicket {
									c.WriteFlight(next)
									return
								}
								if len(received) == 0 || received[0].Type != typeFinished {
									panic("Finished should be merged with NewSessionTicket")
								}
								// Merge NewSessionTicket into the KeyUpdate.
								if next[len(next)-1].Type != typeKeyUpdate {
									c.MergeIntoNextFlight()
									return
								}

								// Write NewSessionTicket and the KeyUpdate and
								// read the ACK.
								c.WriteFlight(next)
								ackTimeout := useTimeouts[0] / 4
								c.AdvanceClock(ackTimeout)
								c.ReadACK(c.InEpoch())

								// The retransmit timer is still running.
								c.AdvanceClock(useTimeouts[0] - ackTimeout)
								c.ReadRetransmit()

								// Application data can flow at the old epoch.
								msg := []byte("test")
								c.WriteAppData(c.OutEpoch()-1, msg)
								c.ReadAppData(c.InEpoch(), expectedReply(msg))

								// The retransmit timer is still running.
								c.AdvanceClock(useTimeouts[1])
								c.ReadRetransmit()

								// Advance the shim to the next epoch.
								c.WriteAppData(c.OutEpoch(), msg)
								c.ReadAppData(c.InEpoch(), expectedReply(msg))

								// The retransmit timer is still running. The shim
								// actually could implicitly ACK at this point, but
								// RFC 9147 does not list this as an implicit ACK.
								c.AdvanceClock(useTimeouts[2])
								c.ReadRetransmit()

								// Finally ACK the final flight. Now the shim will
								// stop the timer.
								c.WriteACK(c.OutEpoch(), records)
								c.ExpectNoNextTimeout()
							},
						},
					},
					sendKeyUpdates:   1,
					keyUpdateRequest: keyUpdateNotRequested,
					flags:            flags,
				})

				// If the server never receives an ACK for NewSessionTicket, it
				// is eventually fatal.
				testCases = append(testCases, testCase{
					testType: serverTest,
					protocol: dtls,
					name:     "DTLS-Retransmit-Server-NewSessionTicketTimeout" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							ACKFlightDTLS: handleNewSessionTicket(func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
								if received[0].Type != typeNewSessionTicket {
									c.WriteACK(c.OutEpoch(), records)
									return
								}
								// Time the peer out.
								for _, t := range useTimeouts[:len(useTimeouts)-1] {
									c.AdvanceClock(t)
									c.ReadRetransmit()
								}
								c.AdvanceClock(useTimeouts[len(useTimeouts)-1])
							}),
						},
					},
					flags:         flags,
					shouldFail:    true,
					expectedError: ":READ_TIMEOUT_EXPIRED:",
				})

				// If generating the reply to a flight takes time (generating a
				// CertificateVerify for a client certificate), the shim should
				// send an ACK.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-SlowReplyGeneration" + suffix,
					config: Config{
						MaxVersion: vers.version,
						ClientAuth: RequireAnyClientCert,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								c.WriteFlight(next)
								if next[0].Type == typeServerHello {
									// The shim will reply with Certificate..Finished, but
									// take time to do so. In that time, it should schedule
									// an ACK so the runner knows not to retransmit.
									c.ReadACK(c.InEpoch())
								}
							},
						},
					},
					shimCertificate: &rsaCertificate,
					// Simulate it taking time to generate the reply.
					flags: slices.Concat(flags, []string{"-private-key-delay-ms", strconv.Itoa(int(useTimeouts[0].Milliseconds()))}),
				})

				// BoringSSL's ACK policy may schedule both retransmit and ACK
				// timers in parallel.
				//
				// TODO(crbug.com/42290594): This is only possible during the
				// handshake because we're willing to ACK old flights without
				// trying to distinguish these cases. However, post-handshake
				// messages will exercise this, so that may be a better version
				// of this test. In-handshake, it's kind of a waste to ACK this,
				// so maybe we should stop.
				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-BothTimers" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							// Arrange for there to be two server flights.
							SendHelloRetryRequestCookie: []byte("cookie"),
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[0].Sequence == 0 || next[0].Type != typeServerHello {
									// Send the first flight (HelloRetryRequest) as-is,
									// as well as any post-handshake flights.
									c.WriteFlight(next)
									return
								}

								// The shim just send the ClientHello2 and is
								// waiting for ServerHello..Finished. If it hears
								// nothing, it will retransmit ClientHello2 on the
								// assumption the packet was lost.
								c.ExpectNextTimeout(useTimeouts[0])

								// Retransmit a portion of HelloRetryRequest.
								c.WriteFragments([]DTLSFragment{prev[0].Fragment(0, 1)})

								// The shim does not actually need to ACK this,
								// but BoringSSL does. Now both timers are active.
								// Fire the first...
								c.ExpectNextTimeout(useTimeouts[0] / 4)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(0)

								// ...followed by the second.
								c.ExpectNextTimeout(3 * useTimeouts[0] / 4)
								c.AdvanceClock(3 * useTimeouts[0] / 4)
								c.ReadRetransmit()

								// The shim is now set for the next retransmit.
								c.ExpectNextTimeout(useTimeouts[1])

								// Start the ACK timer again.
								c.WriteFragments([]DTLSFragment{prev[0].Fragment(0, 1)})
								c.ExpectNextTimeout(useTimeouts[1] / 4)

								// Expire both timers at once.
								c.AdvanceClock(useTimeouts[1])
								c.ReadACK(0)
								c.ReadRetransmit()

								c.WriteFlight(next)
							},
						},
					},
					flags: flags,
				})

				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-Client-ACKPostHandshake" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[0].Type != typeNewSessionTicket {
									c.WriteFlight(next)
									return
								}

								// The test should try to send two NewSessionTickets in a row.
								if len(next) != 2 {
									panic("unexpected message count")
								}

								// Send part of first ticket post-handshake message.
								first0, second0 := next[0].Split(len(next[0].Data) / 2)
								first1, second1 := next[1].Split(len(next[1].Data) / 2)
								c.WriteFragments([]DTLSFragment{first0})

								// The shim should ACK on a timer.
								c.ExpectNextTimeout(useTimeouts[0] / 4)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())

								// The shim is just waiting for us to retransmit.
								c.ExpectNoNextTimeout()

								// Send some more fragments.
								c.WriteFragments([]DTLSFragment{first0, second1})

								// The shim should ACK, again on a timer.
								c.ExpectNextTimeout(useTimeouts[0] / 4)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())
								c.ExpectNoNextTimeout()

								// Finish up both messages. We implicitly test if shim
								// processed these messages by checking that it returned a new
								// session.
								c.WriteFragments([]DTLSFragment{first1, second0})

								// The shim should ACK again, once the timer expires.
								//
								// TODO(crbug.com/42290594): Should the shim ACK immediately?
								// Otherwise KeyUpdates are delayed, which will complicated
								// downstream testing.
								c.ExpectNextTimeout(useTimeouts[0] / 4)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())
								c.ExpectNoNextTimeout()
							},
						},
					},
					flags: flags,
				})

				testCases = append(testCases, testCase{
					protocol: dtls,
					name:     "DTLS-Retransmit-Client-ACKPostHandshakeTwice" + suffix,
					config: Config{
						MaxVersion: vers.version,
						Bugs: ProtocolBugs{
							WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
								if next[0].Type != typeNewSessionTicket {
									c.WriteFlight(next)
									return
								}

								// The test should try to send two NewSessionTickets in a row.
								if len(next) != 2 {
									panic("unexpected message count")
								}

								// Send the flight. The shim should ACK it.
								c.WriteFlight(next)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())
								c.ExpectNoNextTimeout()

								// Retransmit the flight, as if we lost the ACK. The shim should
								// ACK again.
								c.WriteFlight(next)
								c.AdvanceClock(useTimeouts[0] / 4)
								c.ReadACK(c.InEpoch())
								c.ExpectNoNextTimeout()
							},
						},
					},
					flags: flags,
				})
			}
		}
	}

	// Test that the final Finished retransmitting isn't
	// duplicated if the peer badly fragments everything.
	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "DTLS-RetransmitFinished-Fragmented",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				MaxHandshakeRecordLength: 2,
				ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
					c.WriteFlight(prev)
					c.ReadRetransmit()
				},
			},
		},
		flags: []string{"-async"},
	})

	// If the shim sends the last Finished (server full or client resume
	// handshakes), it must retransmit that Finished when it sees a
	// post-handshake penultimate Finished from the runner. The above tests
	// cover this. Conversely, if the shim sends the penultimate Finished
	// (client full or server resume), test that it does not retransmit.
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: clientTest,
		name:     "DTLS-StrayRetransmitFinished-ClientFull",
		config: Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					c.WriteFlight(next)
					for _, msg := range next {
						if msg.Type == typeFinished {
							c.WriteFlight([]DTLSMessage{msg})
						}
					}
				},
			},
		},
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: serverTest,
		name:     "DTLS-StrayRetransmitFinished-ServerResume",
		config: Config{
			MaxVersion: VersionTLS12,
		},
		resumeConfig: &Config{
			MaxVersion: VersionTLS12,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					c.WriteFlight(next)
					for _, msg := range next {
						if msg.Type == typeFinished {
							c.WriteFlight([]DTLSMessage{msg})
						}
					}
				},
			},
		},
		resumeSession: true,
	})
}

func addDTLSReorderTests() {
	for _, vers := range allVersions(dtls) {
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "ReorderHandshakeFragments-Small-DTLS-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Bugs: ProtocolBugs{
					ReorderHandshakeFragments: true,
					// Small enough that every handshake message is
					// fragmented.
					MaxHandshakeRecordLength: 2,
				},
			},
		})
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "ReorderHandshakeFragments-Large-DTLS-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Bugs: ProtocolBugs{
					ReorderHandshakeFragments: true,
					// Large enough that no handshake message is
					// fragmented.
					MaxHandshakeRecordLength: 2048,
				},
			},
		})
		testCases = append(testCases, testCase{
			protocol: dtls,
			name:     "MixCompleteMessageWithFragments-DTLS-" + vers.name,
			config: Config{
				MaxVersion: vers.version,
				Bugs: ProtocolBugs{
					ReorderHandshakeFragments:       true,
					MixCompleteMessageWithFragments: true,
					MaxHandshakeRecordLength:        2,
				},
			},
		})
	}
}
