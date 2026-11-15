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

import "slices"

func addKeyUpdateTests() {
	// TLS tests.
	testCases = append(testCases, testCase{
		name: "KeyUpdate-ToClient",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		sendKeyUpdates:   10,
		keyUpdateRequest: keyUpdateNotRequested,
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "KeyUpdate-ToServer",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		sendKeyUpdates:   10,
		keyUpdateRequest: keyUpdateNotRequested,
	})
	testCases = append(testCases, testCase{
		name: "KeyUpdate-FromClient",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		expectUnsolicitedKeyUpdate: true,
		flags:                      []string{"-key-update"},
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		name:     "KeyUpdate-FromServer",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		expectUnsolicitedKeyUpdate: true,
		flags:                      []string{"-key-update"},
	})
	testCases = append(testCases, testCase{
		name: "KeyUpdate-InvalidRequestMode",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		sendKeyUpdates:   1,
		keyUpdateRequest: 42,
		shouldFail:       true,
		expectedError:    ":DECODE_ERROR:",
	})
	testCases = append(testCases, testCase{
		// Test that shim responds to KeyUpdate requests.
		name: "KeyUpdate-Requested",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				RejectUnsolicitedKeyUpdate: true,
			},
		},
		// Test the shim receiving many KeyUpdates in a row.
		sendKeyUpdates:   5,
		messageCount:     5,
		keyUpdateRequest: keyUpdateRequested,
	})
	testCases = append(testCases, testCase{
		// Test that shim responds to KeyUpdate requests if peer's KeyUpdate is
		// discovered while a write is pending.
		name: "KeyUpdate-Requested-UnfinishedWrite",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				RejectUnsolicitedKeyUpdate: true,
			},
		},
		// Test the shim receiving many KeyUpdates in a row.
		sendKeyUpdates:          5,
		messageCount:            5,
		keyUpdateRequest:        keyUpdateRequested,
		readWithUnfinishedWrite: true,
		flags:                   []string{"-async"},
	})

	// DTLS tests.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ToClient-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		// Send many KeyUpdates to make sure record reassembly can handle it.
		sendKeyUpdates:   10,
		keyUpdateRequest: keyUpdateNotRequested,
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: serverTest,
		name:     "KeyUpdate-ToServer-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		sendKeyUpdates:   10,
		keyUpdateRequest: keyUpdateNotRequested,
	})

	// Test that the shim accounts for packet loss when processing KeyUpdate.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ToClient-PacketLoss-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					if next[0].Type != typeKeyUpdate {
						c.WriteFlight(next)
						return
					}

					// Send the KeyUpdate. The shim should ACK it.
					c.WriteFlight(next)
					ackTimeout := timeouts[0] / 4
					c.AdvanceClock(ackTimeout)
					c.ReadACK(c.InEpoch())

					// The shim should continue reading data at the old epoch.
					// The ACK may not have come through.
					msg := []byte("test")
					c.WriteAppData(c.OutEpoch()-1, msg)
					c.ReadAppData(c.InEpoch(), expectedReply(msg))

					// Re-send KeyUpdate. The shim should ACK it again. The ACK
					// may not have come through.
					c.WriteFlight(next)
					c.AdvanceClock(ackTimeout)
					c.ReadACK(c.InEpoch())

					// The shim should be able to read data at the new epoch.
					c.WriteAppData(c.OutEpoch(), msg)
					c.ReadAppData(c.InEpoch(), expectedReply(msg))

					// The shim continues to accept application data at the old
					// epoch, for a period of time.
					c.WriteAppData(c.OutEpoch()-1, msg)
					c.ReadAppData(c.InEpoch(), expectedReply(msg))

					// It will even ACK the retransmission, though it knows the
					// shim has seen the ACK.
					c.WriteFlight(next)
					c.AdvanceClock(ackTimeout)
					c.ReadACK(c.InEpoch())

					// After some time has passed, the shim will discard the old
					// epoch. The following writes should be ignored.
					c.AdvanceClock(dtlsPrevEpochExpiration)
					f := next[0].Fragment(0, len(next[0].Data))
					f.ShouldDiscard = true
					c.WriteFragments([]DTLSFragment{f})
					c.WriteAppData(c.OutEpoch()-1, msg)
				},
			},
		},
		sendKeyUpdates:   10,
		keyUpdateRequest: keyUpdateNotRequested,
		flags:            []string{"-async"},
	})

	// In DTLS, we KeyUpdate before read, rather than write, because the
	// KeyUpdate will not be applied before the shim reads the ACK.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-FromClient-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		shimSendsKeyUpdateBeforeRead: true,
		// Perform several message exchanges to update keys several times.
		messageCount: 10,
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: serverTest,
		name:     "KeyUpdate-FromServer-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		shimSendsKeyUpdateBeforeRead: true,
		// Perform several message exchanges to update keys several times.
		messageCount: 10,
		// Avoid NewSessionTicket messages getting in the way of ReadKeyUpdate.
		flags: []string{"-no-ticket"},
	})

	// If the shim has a pending unACKed flight, it defers sending KeyUpdate.
	// BoringSSL does not support multiple outgoing flights at once.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-DeferredSend-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			// Request a client certificate, so the shim has more to send.
			ClientAuth: RequireAnyClientCert,
			Bugs: ProtocolBugs{
				MaxPacketLength: 512,
				ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
					if received[len(received)-1].Type != typeFinished {
						c.WriteACK(c.OutEpoch(), records)
						return
					}

					// This test relies on the Finished flight being multiple
					// records.
					if len(records) <= 1 {
						panic("shim sent Finished flight in one record")
					}

					// Before ACKing Finished, do some rounds of exchanging
					// application data. Although the shim has already scheduled
					// KeyUpdate, it should not send the KeyUpdate until it gets
					// an ACK. (If it sent KeyUpdate, ReadAppData would report
					// an unexpected record.)
					msg := []byte("test")
					for i := 0; i < 10; i++ {
						c.WriteAppData(c.OutEpoch(), msg)
						c.ReadAppData(c.InEpoch(), expectedReply(msg))
					}

					// ACK some of the Finished flight, but not all of it.
					c.WriteACK(c.OutEpoch(), records[:1])

					// The shim continues to defer KeyUpdate.
					for i := 0; i < 10; i++ {
						c.WriteAppData(c.OutEpoch(), msg)
						c.ReadAppData(c.InEpoch(), expectedReply(msg))
					}

					// ACK the remainder.
					c.WriteACK(c.OutEpoch(), records[1:])

					// The shim should now send KeyUpdate. Return to the test
					// harness, which will look for it.
				},
			},
		},
		shimCertificate:              &rsaChainCertificate,
		shimSendsKeyUpdateBeforeRead: true,
		flags:                        []string{"-mtu", "512"},
	})

	// The shim should not switch keys until it receives an ACK.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-WaitForACK-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				MaxPacketLength: 512,
				ACKFlightDTLS: func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
					if received[0].Type != typeKeyUpdate {
						c.WriteACK(c.OutEpoch(), records)
						return
					}

					// Make the shim send application data. We have not yet
					// ACKed KeyUpdate, so the shim should send at the previous
					// epoch. Through each of these rounds, the shim will also
					// try to KeyUpdate again. These calls will be suppressed
					// because there is still an outstanding KeyUpdate.
					msg := []byte("test")
					for i := 0; i < 10; i++ {
						c.WriteAppData(c.OutEpoch(), msg)
						c.ReadAppData(c.InEpoch()-1, expectedReply(msg))
					}

					// ACK the KeyUpdate. Ideally we'd test a partial ACK, but
					// BoringSSL's minimum MTU is such that KeyUpdate always
					// fits in one record.
					c.WriteACK(c.OutEpoch(), records)

					// The shim should now send at the new epoch. Return to the
					// test harness, which will enforce this.
				},
			},
		},
		shimSendsKeyUpdateBeforeRead: true,
	})

	// Test that shim responds to KeyUpdate requests.
	fixKeyUpdateReply := func(c *DTLSController, prev, received []DTLSMessage, records []DTLSRecordNumberInfo) {
		c.WriteACK(c.OutEpoch(), records)
		if received[0].Type != typeKeyUpdate {
			return
		}
		// This works around an awkward testing mismatch. The test
		// harness expects the shim to immediately change keys, but
		// the shim writes app data before seeing the ACK. The app
		// data will be sent at the previous epoch. Consume this and
		// prime the shim to resend its reply at the new epoch.
		msg := makeTestMessage(int(received[0].Sequence)-2, 32)
		c.ReadAppData(c.InEpoch()-1, expectedReply(msg))
		c.WriteAppData(c.OutEpoch(), msg)
	}
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-Requested-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				RejectUnsolicitedKeyUpdate: true,
				ACKFlightDTLS:              fixKeyUpdateReply,
			},
		},
		// Test the shim receiving many KeyUpdates in a row. They will be
		// combined into one reply KeyUpdate.
		sendKeyUpdates:   5,
		messageLen:       32,
		messageCount:     5,
		keyUpdateRequest: keyUpdateRequested,
	})

	mergeNewSessionTicketAndKeyUpdate := func(f WriteFlightFunc) WriteFlightFunc {
		return func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
			// Send NewSessionTicket and the first KeyUpdate all together.
			if next[0].Type == typeKeyUpdate {
				panic("key update should have been merged into NewSessionTicket")
			}
			if next[0].Type != typeNewSessionTicket {
				c.WriteFlight(next)
				return
			}
			if next[0].Type == typeNewSessionTicket && next[len(next)-1].Type != typeKeyUpdate {
				c.MergeIntoNextFlight()
				return
			}

			f(c, prev, received, next, records)
		}
	}

	// Test that the shim does not process KeyUpdate until it has processed all
	// preceding messages.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ProcessInOrder-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: mergeNewSessionTicketAndKeyUpdate(func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					// Write the KeyUpdate. The shim should buffer and ACK it.
					keyUpdate := next[len(next)-1]
					c.WriteFlight([]DTLSMessage{keyUpdate})
					ackTimeout := timeouts[0] / 4
					c.AdvanceClock(ackTimeout)
					c.ReadACK(c.InEpoch())

					// The shim should not process KeyUpdate yet. It should not
					// read from the new epoch.
					msg1, msg2 := []byte("aaaa"), []byte("bbbb")
					c.WriteAppData(c.OutEpoch(), msg1)
					c.AdvanceClock(0) // Check there are no messages.

					// It can read from the old epoch, however.
					c.WriteAppData(c.OutEpoch()-1, msg2)
					c.ReadAppData(c.InEpoch(), expectedReply(msg2))

					// Write the rest of the flight.
					c.WriteFlight(next[:len(next)-1])
					c.AdvanceClock(ackTimeout)
					c.ReadACK(c.InEpoch())

					// Now the new epoch is functional.
					c.WriteAppData(c.OutEpoch(), msg1)
					c.ReadAppData(c.InEpoch(), expectedReply(msg1))
				}),
			},
		},
		sendKeyUpdates:   1,
		keyUpdateRequest: keyUpdateNotRequested,
		flags:            []string{"-async"},
	})

	// Messages after a KeyUpdate are not allowed.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ExtraMessage-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: mergeNewSessionTicketAndKeyUpdate(func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					extra := next[0]
					extra.Sequence = next[len(next)-1].Sequence + 1
					next = append(slices.Clip(next), extra)
					c.WriteFlight(next)
				}),
			},
		},
		sendKeyUpdates:     1,
		keyUpdateRequest:   keyUpdateNotRequested,
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ExtraMessageBuffered-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				WriteFlightDTLS: mergeNewSessionTicketAndKeyUpdate(func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					// Send the extra message first. The shim should accept and
					// buffer it.
					extra := next[0]
					extra.Sequence = next[len(next)-1].Sequence + 1
					c.WriteFlight([]DTLSMessage{extra})

					// Now send the flight, including a KeyUpdate. The shim
					// should now notice the extra message and reject.
					c.WriteFlight(next)
				}),
			},
		},
		sendKeyUpdates:     1,
		keyUpdateRequest:   keyUpdateNotRequested,
		shouldFail:         true,
		expectedError:      ":EXCESS_HANDSHAKE_DATA:",
		expectedLocalError: "remote error: unexpected message",
	})

	// Test KeyUpdate overflow conditions. Both the epoch number and the message
	// number may overflow, in either the read or write direction.

	// When the sender is the client, the first KeyUpdate is message 2 at epoch
	// 3, so the epoch number overflows first.
	const maxClientKeyUpdates = 0xffff - 3

	// Test that the shim, as a server, rejects KeyUpdates at epoch 0xffff. RFC
	// 9147 does not prescribe this limit, but we enforce it. See
	// https://mailarchive.ietf.org/arch/msg/tls/6y8wTv8Q_IPM-PCcbCAmDOYg6bM/
	// and https://www.rfc-editor.org/errata/eid8050
	writeFlightKeyUpdate := func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
		if next[0].Type == typeKeyUpdate {
			// Exchange some data to avoid tripping KeyUpdate DoS limits.
			msg := []byte("test")
			c.WriteAppData(c.OutEpoch()-1, msg)
			c.ReadAppData(c.InEpoch(), expectedReply(msg))
		}
		c.WriteFlight(next)
	}
	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "KeyUpdate-MaxReadEpoch-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AllowEpochOverflow: true,
				WriteFlightDTLS:    writeFlightKeyUpdate,
			},
		},
		// Avoid the NewSessionTicket messages interfering with the callback.
		flags:            []string{"-no-ticket"},
		sendKeyUpdates:   maxClientKeyUpdates,
		keyUpdateRequest: keyUpdateNotRequested,
	})
	testCases = append(testCases, testCase{
		testType: serverTest,
		protocol: dtls,
		name:     "KeyUpdate-ReadEpochOverflow-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				AllowEpochOverflow: true,
				WriteFlightDTLS:    writeFlightKeyUpdate,
			},
		},
		// Avoid the NewSessionTicket messages interfering with the callback.
		flags:              []string{"-no-ticket"},
		sendKeyUpdates:     maxClientKeyUpdates + 1,
		keyUpdateRequest:   keyUpdateNotRequested,
		shouldFail:         true,
		expectedError:      ":TOO_MANY_KEY_UPDATES:",
		expectedLocalError: "remote error: unexpected message",
	})

	// Test that the shim, as a client, notices its epoch overflow condition
	// when asked to send too many KeyUpdates. The shim sends KeyUpdate before
	// every read, including reading connection close, so the number of
	// KeyUpdates is one more than the message count.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-MaxWriteEpoch-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		shimSendsKeyUpdateBeforeRead: true,
		messageCount:                 maxClientKeyUpdates - 1,
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-WriteEpochOverflow-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
			Bugs: ProtocolBugs{
				// The shim does not notice the overflow until immediately after
				// sending KeyUpdate, so tolerate the overflow on the runner.
				AllowEpochOverflow: true,
			},
		},
		shimSendsKeyUpdateBeforeRead: true,
		messageCount:                 maxClientKeyUpdates,
		shouldFail:                   true,
		expectedError:                ":TOO_MANY_KEY_UPDATES:",
	})

	// When the sender is a server that doesn't send tickets, the first
	// KeyUpdate is message 5 (SH, EE, C, CV, Fin) at epoch 3, so the message
	// number overflows first.
	const maxServerKeyUpdates = 0xffff - 5

	// Test that the shim, as a client, does not allow the value to wraparound.
	testCases = append(testCases, testCase{
		protocol: dtls,
		name:     "KeyUpdate-ReadMessageOverflow-DTLS",
		config: Config{
			MaxVersion:             VersionTLS13,
			SessionTicketsDisabled: true,
			Bugs: ProtocolBugs{
				AllowEpochOverflow: true,
				WriteFlightDTLS: func(c *DTLSController, prev, received, next []DTLSMessage, records []DTLSRecordNumberInfo) {
					writeFlightKeyUpdate(c, prev, received, next, records)
					if next[0].Type == typeKeyUpdate && next[0].Sequence == 0xffff {
						// At this point, the shim has accepted message 0xffff.
						// Check the shim does not now accept message 0 as the
						// current message. Test this by sending a garbage
						// message 0. A shim that overflows and processes the
						// message will notice the syntax error. A shim that
						// correctly interprets this as an old message will drop
						// the record and simply ACK it.
						//
						// We do this rather than send a valid KeyUpdate because
						// the shim will keep the old epoch active and drop
						// decryption failures. Looking for the lack of an error
						// is more straightforward.
						c.WriteFlight([]DTLSMessage{{Epoch: c.OutEpoch(), Sequence: 0, Type: typeKeyUpdate, Data: []byte("INVALID")}})
						c.ExpectNextTimeout(timeouts[0] / 4)
						c.AdvanceClock(timeouts[0] / 4)
						c.ReadACK(c.InEpoch())
					}
				},
			},
		},
		sendKeyUpdates:   maxServerKeyUpdates + 1,
		keyUpdateRequest: keyUpdateNotRequested,
		flags:            []string{"-async", "-expect-no-session"},
	})

	// Test that the shim, as a server, notices its message overflow condition,
	// when asked to send too many KeyUpdates.
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: serverTest,
		name:     "KeyUpdate-MaxWriteMessage-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		shimSendsKeyUpdateBeforeRead: true,
		messageCount:                 maxServerKeyUpdates,
		// Avoid NewSessionTicket messages getting in the way of ReadKeyUpdate.
		flags: []string{"-no-ticket"},
	})
	testCases = append(testCases, testCase{
		protocol: dtls,
		testType: serverTest,
		name:     "KeyUpdate-WriteMessageOverflow-DTLS",
		config: Config{
			MaxVersion: VersionTLS13,
		},
		shimSendsKeyUpdateBeforeRead: true,
		messageCount:                 maxServerKeyUpdates + 1,
		shouldFail:                   true,
		expectedError:                ":overflow:",
		// Avoid NewSessionTicket messages getting in the way of ReadKeyUpdate.
		flags: []string{"-no-ticket"},
	})
}
