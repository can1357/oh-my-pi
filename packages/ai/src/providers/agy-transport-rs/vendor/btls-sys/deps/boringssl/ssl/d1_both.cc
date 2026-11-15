// Copyright 2005-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ssl.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <algorithm>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/rand.h>

#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

// TODO(davidben): 28 comes from the size of IP + UDP header. Is this reasonable
// for these values? Notably, why is kMinMTU a function of the transport
// protocol's overhead rather than, say, what's needed to hold a minimally-sized
// handshake fragment plus protocol overhead.

// kMinMTU is the minimum acceptable MTU value.
static const unsigned int kMinMTU = 256 - 28;

// kDefaultMTU is the default MTU value to use if neither the user nor
// the underlying BIO supplies one.
static const unsigned int kDefaultMTU = 1500 - 28;

// BitRange returns a |uint8_t| with bits |start|, inclusive, to |end|,
// exclusive, set.
static uint8_t BitRange(size_t start, size_t end) {
  assert(start <= end && end <= 8);
  return static_cast<uint8_t>(~((1u << start) - 1) & ((1u << end) - 1));
}

// FirstUnmarkedRangeInByte returns the first unmarked range in bits |b|.
static DTLSMessageBitmap::Range FirstUnmarkedRangeInByte(uint8_t b) {
  size_t start, end;
  for (start = 0; start < 8; start++) {
    if ((b & (1u << start)) == 0) {
      break;
    }
  }
  for (end = start; end < 8; end++) {
    if ((b & (1u << end)) != 0) {
      break;
    }
  }
  return DTLSMessageBitmap::Range{start, end};
}

bool DTLSMessageBitmap::Init(size_t num_bits) {
  if (num_bits + 7 < num_bits) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
    return false;
  }
  size_t num_bytes = (num_bits + 7) / 8;
  size_t bits_rounded = num_bytes * 8;
  if (!bytes_.Init(num_bytes)) {
    return false;
  }
  MarkRange(num_bits, bits_rounded);
  first_unmarked_byte_ = 0;
  return true;
}

void DTLSMessageBitmap::MarkRange(size_t start, size_t end) {
  assert(start <= end);
  // Don't bother touching bytes that have already been marked.
  start = std::max(start, first_unmarked_byte_ << 3);
  // Clamp everything within range.
  start = std::min(start, bytes_.size() << 3);
  end = std::min(end, bytes_.size() << 3);
  if (start >= end) {
    return;
  }

  if ((start >> 3) == (end >> 3)) {
    bytes_[start >> 3] |= BitRange(start & 7, end & 7);
  } else {
    bytes_[start >> 3] |= BitRange(start & 7, 8);
    for (size_t i = (start >> 3) + 1; i < (end >> 3); i++) {
      bytes_[i] = 0xff;
    }
    if ((end & 7) != 0) {
      bytes_[end >> 3] |= BitRange(0, end & 7);
    }
  }

  // Maintain the |first_unmarked_byte_| invariant. This work is amortized
  // across all |MarkRange| calls.
  while (first_unmarked_byte_ < bytes_.size() &&
         bytes_[first_unmarked_byte_] == 0xff) {
    first_unmarked_byte_++;
  }
  // If the whole message is marked, we no longer need to spend memory on the
  // bitmap.
  if (first_unmarked_byte_ >= bytes_.size()) {
    bytes_.Reset();
    first_unmarked_byte_ = 0;
  }
}

DTLSMessageBitmap::Range DTLSMessageBitmap::NextUnmarkedRange(
    size_t start) const {
  // Don't bother looking at bytes that are known to be fully marked.
  start = std::max(start, first_unmarked_byte_ << 3);

  size_t idx = start >> 3;
  if (idx >= bytes_.size()) {
    return Range{0, 0};
  }

  // Look at the bits from |start| up to a byte boundary.
  uint8_t byte = bytes_[idx] | BitRange(0, start & 7);
  if (byte == 0xff) {
    // Nothing unmarked at this byte. Keep searching for an unmarked bit.
    for (idx = idx + 1; idx < bytes_.size(); idx++) {
      if (bytes_[idx] != 0xff) {
        byte = bytes_[idx];
        break;
      }
    }
    if (idx >= bytes_.size()) {
      return Range{0, 0};
    }
  }

  Range range = FirstUnmarkedRangeInByte(byte);
  assert(!range.empty());
  bool should_extend = range.end == 8;
  range.start += idx << 3;
  range.end += idx << 3;
  if (!should_extend) {
    // The range did not end at a byte boundary. We're done.
    return range;
  }

  // Collect all fully unmarked bytes.
  for (idx = idx + 1; idx < bytes_.size(); idx++) {
    if (bytes_[idx] != 0) {
      break;
    }
  }
  range.end = idx << 3;

  // Add any bits from the remaining byte, if any.
  if (idx < bytes_.size()) {
    Range extra = FirstUnmarkedRangeInByte(bytes_[idx]);
    if (extra.start == 0) {
      range.end += extra.end;
    }
  }

  return range;
}

// Receiving handshake messages.

static UniquePtr<DTLSIncomingMessage> dtls_new_incoming_message(
    const struct hm_header_st *msg_hdr) {
  ScopedCBB cbb;
  UniquePtr<DTLSIncomingMessage> frag = MakeUnique<DTLSIncomingMessage>();
  if (!frag) {
    return nullptr;
  }
  frag->type = msg_hdr->type;
  frag->seq = msg_hdr->seq;

  // Allocate space for the reassembled message and fill in the header.
  if (!frag->data.InitForOverwrite(DTLS1_HM_HEADER_LENGTH + msg_hdr->msg_len)) {
    return nullptr;
  }

  if (!CBB_init_fixed(cbb.get(), frag->data.data(), DTLS1_HM_HEADER_LENGTH) ||
      !CBB_add_u8(cbb.get(), msg_hdr->type) ||
      !CBB_add_u24(cbb.get(), msg_hdr->msg_len) ||
      !CBB_add_u16(cbb.get(), msg_hdr->seq) ||
      !CBB_add_u24(cbb.get(), 0 /* frag_off */) ||
      !CBB_add_u24(cbb.get(), msg_hdr->msg_len) ||
      !CBB_finish(cbb.get(), nullptr, nullptr)) {
    return nullptr;
  }

  if (!frag->reassembly.Init(msg_hdr->msg_len)) {
    return nullptr;
  }

  return frag;
}

// dtls1_is_current_message_complete returns whether the current handshake
// message is complete.
static bool dtls1_is_current_message_complete(const SSL *ssl) {
  size_t idx = ssl->d1->handshake_read_seq % SSL_MAX_HANDSHAKE_FLIGHT;
  DTLSIncomingMessage *frag = ssl->d1->incoming_messages[idx].get();
  return frag != nullptr && frag->reassembly.IsComplete();
}

// dtls1_get_incoming_message returns the incoming message corresponding to
// |msg_hdr|. If none exists, it creates a new one and inserts it in the
// queue. Otherwise, it checks |msg_hdr| is consistent with the existing one. It
// returns NULL on failure. The caller does not take ownership of the result.
static DTLSIncomingMessage *dtls1_get_incoming_message(
    SSL *ssl, uint8_t *out_alert, const struct hm_header_st *msg_hdr) {
  if (msg_hdr->seq < ssl->d1->handshake_read_seq ||
      msg_hdr->seq - ssl->d1->handshake_read_seq >= SSL_MAX_HANDSHAKE_FLIGHT) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return nullptr;
  }

  size_t idx = msg_hdr->seq % SSL_MAX_HANDSHAKE_FLIGHT;
  DTLSIncomingMessage *frag = ssl->d1->incoming_messages[idx].get();
  if (frag != nullptr) {
    assert(frag->seq == msg_hdr->seq);
    // The new fragment must be compatible with the previous fragments from this
    // message.
    if (frag->type != msg_hdr->type ||  //
        frag->msg_len() != msg_hdr->msg_len) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_FRAGMENT_MISMATCH);
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      return nullptr;
    }
    return frag;
  }

  // This is the first fragment from this message.
  ssl->d1->incoming_messages[idx] = dtls_new_incoming_message(msg_hdr);
  if (!ssl->d1->incoming_messages[idx]) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return nullptr;
  }
  return ssl->d1->incoming_messages[idx].get();
}

bool dtls1_process_handshake_fragments(SSL *ssl, uint8_t *out_alert,
                                       DTLSRecordNumber record_number,
                                       Span<const uint8_t> record) {
  bool implicit_ack = false;
  bool skipped_fragments = false;
  CBS cbs = record;
  while (CBS_len(&cbs) > 0) {
    // Read a handshake fragment.
    struct hm_header_st msg_hdr;
    CBS body;
    if (!dtls1_parse_fragment(&cbs, &msg_hdr, &body)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_HANDSHAKE_RECORD);
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }

    const size_t frag_off = msg_hdr.frag_off;
    const size_t frag_len = msg_hdr.frag_len;
    const size_t msg_len = msg_hdr.msg_len;
    if (frag_off > msg_len || frag_len > msg_len - frag_off) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_HANDSHAKE_RECORD);
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      return false;
    }

    if (msg_hdr.seq < ssl->d1->handshake_read_seq ||
        ssl->d1->handshake_read_overflow) {
      // Ignore fragments from the past. This is a retransmit of data we already
      // received.
      //
      // TODO(crbug.com/42290594): Use this to drive retransmits.
      continue;
    }

    if (record_number.epoch() != ssl->d1->read_epoch.epoch ||
        ssl->d1->next_read_epoch != nullptr) {
      // New messages can only arrive in the latest epoch. This can fail if the
      // record came from |prev_read_epoch|, or if it came from |read_epoch| but
      // |next_read_epoch| exists. (It cannot come from |next_read_epoch|
      // because |next_read_epoch| becomes |read_epoch| once it receives a
      // record.)
      OPENSSL_PUT_ERROR(SSL, SSL_R_EXCESS_HANDSHAKE_DATA);
      *out_alert = SSL_AD_UNEXPECTED_MESSAGE;
      return false;
    }

    if (msg_len > ssl_max_handshake_message_len(ssl)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_EXCESSIVE_MESSAGE_SIZE);
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      return false;
    }

    if (SSL_in_init(ssl) && ssl_has_final_version(ssl) &&
        ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
      // During the handshake, if we receive any portion of the next flight, the
      // peer must have received our most recent flight. In DTLS 1.3, this is an
      // implicit ACK. See RFC 9147, Section 7.1.
      //
      // This only applies during the handshake. After the handshake, the next
      // message may be part of a post-handshake transaction. It also does not
      // apply immediately after the handshake. As a client, receiving a
      // KeyUpdate or NewSessionTicket does not imply the server has received
      // our Finished. The server may have sent those messages in half-RTT.
      implicit_ack = true;
    }

    if (msg_hdr.seq - ssl->d1->handshake_read_seq > SSL_MAX_HANDSHAKE_FLIGHT) {
      // Ignore fragments too far in the future.
      skipped_fragments = true;
      continue;
    }

    DTLSIncomingMessage *frag =
        dtls1_get_incoming_message(ssl, out_alert, &msg_hdr);
    if (frag == nullptr) {
      return false;
    }
    assert(frag->msg_len() == msg_len);

    if (frag->reassembly.IsComplete()) {
      // The message is already assembled.
      continue;
    }
    assert(msg_len > 0);

    // Copy the body into the fragment.
    Span<uint8_t> dest = frag->msg().subspan(frag_off, CBS_len(&body));
    assert(dest.size() == CBS_len(&body));
    OPENSSL_memcpy(dest.data(), CBS_data(&body), CBS_len(&body));
    frag->reassembly.MarkRange(frag_off, frag_off + frag_len);
  }

  if (implicit_ack) {
    dtls1_stop_timer(ssl);
    dtls_clear_outgoing_messages(ssl);
  }

  if (!skipped_fragments) {
    ssl->d1->records_to_ack.PushBack(record_number);

    if (ssl_has_final_version(ssl) &&
        ssl_protocol_version(ssl) >= TLS1_3_VERSION &&
        !ssl->d1->ack_timer.IsSet() && !ssl->d1->sending_ack) {
      // Schedule sending an ACK. The delay serves several purposes:
      // - If there are more records to come, we send only one ACK.
      // - If there are more records to come and the flight is now complete, we
      //   will send the reply (which implicitly ACKs the previous flight) and
      //   cancel the timer.
      // - If there are more records to come, the flight is now complete, but
      //   generating the response is delayed (e.g. a slow, async private key),
      //   the timer will fire and we send an ACK anyway.
      OPENSSL_timeval now = ssl_ctx_get_current_time(ssl->ctx.get());
      ssl->d1->ack_timer.StartMicroseconds(
          now, uint64_t{ssl->d1->timeout_duration_ms} * 1000 / 4);
    }
  }

  return true;
}

ssl_open_record_t dtls1_open_handshake(SSL *ssl, size_t *out_consumed,
                                       uint8_t *out_alert, Span<uint8_t> in) {
  uint8_t type;
  DTLSRecordNumber record_number;
  Span<uint8_t> record;
  auto ret = dtls_open_record(ssl, &type, &record_number, &record, out_consumed,
                              out_alert, in);
  if (ret != ssl_open_record_success) {
    return ret;
  }

  switch (type) {
    case SSL3_RT_APPLICATION_DATA:
      // In DTLS 1.2, out-of-order application data may be received between
      // ChangeCipherSpec and Finished. Discard it.
      return ssl_open_record_discard;

    case SSL3_RT_CHANGE_CIPHER_SPEC:
      if (record.size() != 1u || record[0] != SSL3_MT_CCS) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_CHANGE_CIPHER_SPEC);
        *out_alert = SSL_AD_ILLEGAL_PARAMETER;
        return ssl_open_record_error;
      }

      // We do not support renegotiation, so encrypted ChangeCipherSpec records
      // are illegal.
      if (record_number.epoch() != 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_RECORD);
        *out_alert = SSL_AD_UNEXPECTED_MESSAGE;
        return ssl_open_record_error;
      }

      // Ignore ChangeCipherSpec from a previous epoch.
      if (record_number.epoch() != ssl->d1->read_epoch.epoch) {
        return ssl_open_record_discard;
      }

      // Flag the ChangeCipherSpec for later.
      // TODO(crbug.com/42290594): Should we reject this in DTLS 1.3?
      ssl->d1->has_change_cipher_spec = true;
      ssl_do_msg_callback(ssl, 0 /* read */, SSL3_RT_CHANGE_CIPHER_SPEC,
                          record);
      return ssl_open_record_success;

    case SSL3_RT_ACK:
      return dtls1_process_ack(ssl, out_alert, record_number, record);

    case SSL3_RT_HANDSHAKE:
      if (!dtls1_process_handshake_fragments(ssl, out_alert, record_number,
                                             record)) {
        return ssl_open_record_error;
      }
      return ssl_open_record_success;

    default:
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_RECORD);
      *out_alert = SSL_AD_UNEXPECTED_MESSAGE;
      return ssl_open_record_error;
  }
}

bool dtls1_get_message(const SSL *ssl, SSLMessage *out) {
  if (!dtls1_is_current_message_complete(ssl)) {
    return false;
  }

  size_t idx = ssl->d1->handshake_read_seq % SSL_MAX_HANDSHAKE_FLIGHT;
  const DTLSIncomingMessage *frag = ssl->d1->incoming_messages[idx].get();
  out->type = frag->type;
  out->raw = CBS(frag->data);
  out->body = CBS(frag->msg());
  out->is_v2_hello = false;
  if (!ssl->s3->has_message) {
    ssl_do_msg_callback(ssl, 0 /* read */, SSL3_RT_HANDSHAKE, out->raw);
    ssl->s3->has_message = true;
  }
  return true;
}

void dtls1_next_message(SSL *ssl) {
  assert(ssl->s3->has_message);
  assert(dtls1_is_current_message_complete(ssl));
  size_t index = ssl->d1->handshake_read_seq % SSL_MAX_HANDSHAKE_FLIGHT;
  ssl->d1->incoming_messages[index].reset();
  ssl->d1->handshake_read_seq++;
  if (ssl->d1->handshake_read_seq == 0) {
    ssl->d1->handshake_read_overflow = true;
  }
  ssl->s3->has_message = false;
  // If we previously sent a flight, mark it as having a reply, so
  // |on_handshake_complete| can manage post-handshake retransmission.
  if (ssl->d1->outgoing_messages_complete) {
    ssl->d1->flight_has_reply = true;
  }
}

bool dtls_has_unprocessed_handshake_data(const SSL *ssl) {
  size_t current = ssl->d1->handshake_read_seq % SSL_MAX_HANDSHAKE_FLIGHT;
  for (size_t i = 0; i < SSL_MAX_HANDSHAKE_FLIGHT; i++) {
    // Skip the current message.
    if (ssl->s3->has_message && i == current) {
      assert(dtls1_is_current_message_complete(ssl));
      continue;
    }
    if (ssl->d1->incoming_messages[i] != nullptr) {
      return true;
    }
  }
  return false;
}

bool dtls1_parse_fragment(CBS *cbs, struct hm_header_st *out_hdr,
                          CBS *out_body) {
  OPENSSL_memset(out_hdr, 0x00, sizeof(struct hm_header_st));

  if (!CBS_get_u8(cbs, &out_hdr->type) ||
      !CBS_get_u24(cbs, &out_hdr->msg_len) ||
      !CBS_get_u16(cbs, &out_hdr->seq) ||
      !CBS_get_u24(cbs, &out_hdr->frag_off) ||
      !CBS_get_u24(cbs, &out_hdr->frag_len) ||
      !CBS_get_bytes(cbs, out_body, out_hdr->frag_len)) {
    return false;
  }

  return true;
}

ssl_open_record_t dtls1_open_change_cipher_spec(SSL *ssl, size_t *out_consumed,
                                                uint8_t *out_alert,
                                                Span<uint8_t> in) {
  if (!ssl->d1->has_change_cipher_spec) {
    // dtls1_open_handshake processes both handshake and ChangeCipherSpec.
    auto ret = dtls1_open_handshake(ssl, out_consumed, out_alert, in);
    if (ret != ssl_open_record_success) {
      return ret;
    }
  }
  if (ssl->d1->has_change_cipher_spec) {
    ssl->d1->has_change_cipher_spec = false;
    return ssl_open_record_success;
  }
  return ssl_open_record_discard;
}


// Sending handshake messages.

void dtls_clear_outgoing_messages(SSL *ssl) {
  ssl->d1->outgoing_messages.clear();
  ssl->d1->sent_records = nullptr;
  ssl->d1->outgoing_written = 0;
  ssl->d1->outgoing_offset = 0;
  ssl->d1->outgoing_messages_complete = false;
  ssl->d1->flight_has_reply = false;
  ssl->d1->sending_flight = false;
  dtls_clear_unused_write_epochs(ssl);
}

void dtls_clear_unused_write_epochs(SSL *ssl) {
  ssl->d1->extra_write_epochs.EraseIf(
      [ssl](const UniquePtr<DTLSWriteEpoch> &write_epoch) -> bool {
        // Non-current epochs may be discarded once there are no incomplete
        // outgoing messages that reference them.
        //
        // TODO(crbug.com/42290594): Epoch 1 (0-RTT) should be retained until
        // epoch 3 (app data) is available.
        for (const auto &msg : ssl->d1->outgoing_messages) {
          if (msg.epoch == write_epoch->epoch() && !msg.IsFullyAcked()) {
            return false;
          }
        }
        return true;
      });
}

bool dtls1_init_message(const SSL *ssl, CBB *cbb, CBB *body, uint8_t type) {
  // Pick a modest size hint to save most of the |realloc| calls.
  if (!CBB_init(cbb, 64) ||                                   //
      !CBB_add_u8(cbb, type) ||                               //
      !CBB_add_u24(cbb, 0 /* length (filled in later) */) ||  //
      !CBB_add_u16(cbb, ssl->d1->handshake_write_seq) ||      //
      !CBB_add_u24(cbb, 0 /* offset */) ||                    //
      !CBB_add_u24_length_prefixed(cbb, body)) {
    return false;
  }

  return true;
}

bool dtls1_finish_message(const SSL *ssl, CBB *cbb, Array<uint8_t> *out_msg) {
  if (!CBBFinishArray(cbb, out_msg) ||
      out_msg->size() < DTLS1_HM_HEADER_LENGTH) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // Fix up the header. Copy the fragment length into the total message
  // length.
  OPENSSL_memcpy(out_msg->data() + 1,
                 out_msg->data() + DTLS1_HM_HEADER_LENGTH - 3, 3);
  return true;
}

// add_outgoing adds a new handshake message or ChangeCipherSpec to the current
// outgoing flight. It returns true on success and false on error.
static bool add_outgoing(SSL *ssl, bool is_ccs, Array<uint8_t> data) {
  if (ssl->d1->outgoing_messages_complete) {
    // If we've begun writing a new flight, we received the peer flight. Discard
    // the timer and the our flight.
    dtls1_stop_timer(ssl);
    dtls_clear_outgoing_messages(ssl);
  }

  if (!is_ccs) {
    if (ssl->d1->handshake_write_overflow) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
      return false;
    }
    // TODO(svaldez): Move this up a layer to fix abstraction for SSLTranscript
    // on hs.
    if (ssl->s3->hs != nullptr && !ssl->s3->hs->transcript.Update(data)) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return false;
    }
    ssl->d1->handshake_write_seq++;
    if (ssl->d1->handshake_write_seq == 0) {
      ssl->d1->handshake_write_overflow = true;
    }
  }

  DTLSOutgoingMessage msg;
  msg.data = std::move(data);
  msg.epoch = ssl->d1->write_epoch.epoch();
  msg.is_ccs = is_ccs;
  // Zero-length messages need 1 bit to track whether the peer has received the
  // message header. (Normally the message header is implicitly received when
  // any fragment of the message is received at all.)
  if (!is_ccs && !msg.acked.Init(std::max(msg.msg_len(), size_t{1}))) {
    return false;
  }

  // This should not fail if |SSL_MAX_HANDSHAKE_FLIGHT| was sized correctly.
  //
  // TODO(crbug.com/42290594): This can currently fail in DTLS 1.3. The caller
  // can configure how many tickets to send, up to kMaxTickets. Additionally, if
  // we send 0.5-RTT tickets in 0-RTT, we may even have tickets queued up with
  // the server flight.
  if (!ssl->d1->outgoing_messages.TryPushBack(std::move(msg))) {
    assert(false);
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  return true;
}

bool dtls1_add_message(SSL *ssl, Array<uint8_t> data) {
  return add_outgoing(ssl, false /* handshake */, std::move(data));
}

bool dtls1_add_change_cipher_spec(SSL *ssl) {
  // DTLS 1.3 disables compatibility mode, which means that DTLS 1.3 never sends
  // a ChangeCipherSpec message.
  if (ssl_protocol_version(ssl) > TLS1_2_VERSION) {
    return true;
  }
  return add_outgoing(ssl, true /* ChangeCipherSpec */, Array<uint8_t>());
}

// dtls1_update_mtu updates the current MTU from the BIO, ensuring it is above
// the minimum.
static void dtls1_update_mtu(SSL *ssl) {
  // TODO(davidben): No consumer implements |BIO_CTRL_DGRAM_SET_MTU| and the
  // only |BIO_CTRL_DGRAM_QUERY_MTU| implementation could use
  // |SSL_set_mtu|. Does this need to be so complex?
  if (ssl->d1->mtu < dtls1_min_mtu() &&
      !(SSL_get_options(ssl) & SSL_OP_NO_QUERY_MTU)) {
    long mtu = BIO_ctrl(ssl->wbio.get(), BIO_CTRL_DGRAM_QUERY_MTU, 0, nullptr);
    if (mtu >= 0 && mtu <= (1 << 30) && (unsigned)mtu >= dtls1_min_mtu()) {
      ssl->d1->mtu = (unsigned)mtu;
    } else {
      ssl->d1->mtu = kDefaultMTU;
      BIO_ctrl(ssl->wbio.get(), BIO_CTRL_DGRAM_SET_MTU, ssl->d1->mtu, nullptr);
    }
  }

  // The MTU should be above the minimum now.
  assert(ssl->d1->mtu >= dtls1_min_mtu());
}

enum seal_result_t {
  seal_error,
  seal_continue,
  seal_flush,
};

// seal_next_record seals one record's worth of messages to |out| and advances
// |ssl|'s internal state past the data that was sealed. If progress was made,
// it returns |seal_flush| or |seal_continue| and sets
// |*out_len| to the number of bytes written.
//
// If the function stopped because the next message could not be combined into
// this record, it returns |seal_continue| and the caller should loop again.
// Otherwise, it returns |seal_flush| and the packet is complete (either because
// there are no more messages or the packet is full).
static seal_result_t seal_next_record(SSL *ssl, Span<uint8_t> out,
                                      size_t *out_len) {
  *out_len = 0;

  // Skip any fully acked messages.
  while (ssl->d1->outgoing_written < ssl->d1->outgoing_messages.size() &&
         ssl->d1->outgoing_messages[ssl->d1->outgoing_written].IsFullyAcked()) {
    ssl->d1->outgoing_offset = 0;
    ssl->d1->outgoing_written++;
  }

  // There was nothing left to write.
  if (ssl->d1->outgoing_written >= ssl->d1->outgoing_messages.size()) {
    return seal_flush;
  }

  const auto &first_msg = ssl->d1->outgoing_messages[ssl->d1->outgoing_written];
  size_t prefix_len = dtls_seal_prefix_len(ssl, first_msg.epoch);
  size_t max_in_len = dtls_seal_max_input_len(ssl, first_msg.epoch, out.size());
  if (max_in_len == 0) {
    // There is no room for a single record.
    return seal_flush;
  }

  if (first_msg.is_ccs) {
    static const uint8_t kChangeCipherSpec[1] = {SSL3_MT_CCS};
    DTLSRecordNumber record_number;
    if (!dtls_seal_record(ssl, &record_number, out.data(), out_len, out.size(),
                          SSL3_RT_CHANGE_CIPHER_SPEC, kChangeCipherSpec,
                          sizeof(kChangeCipherSpec), first_msg.epoch)) {
      return seal_error;
    }

    ssl_do_msg_callback(ssl, /*is_write=*/1, SSL3_RT_CHANGE_CIPHER_SPEC,
                        kChangeCipherSpec);
    ssl->d1->outgoing_offset = 0;
    ssl->d1->outgoing_written++;
    return seal_continue;
  }

  // TODO(crbug.com/374991962): For now, only send one message per record in
  // epoch 0. Sending multiple is allowed and more efficient, but breaks
  // b/378742138.
  const bool allow_multiple_messages = first_msg.epoch != 0;

  // Pack as many handshake fragments into one record as we can. We stage the
  // fragments in the output buffer, to be sealed in-place.
  bool should_continue = false;
  Span<uint8_t> fragments = out.subspan(prefix_len, /* up to */ max_in_len);
  CBB cbb;
  CBB_init_fixed(&cbb, fragments.data(), fragments.size());
  DTLSSentRecord sent_record;
  sent_record.first_msg = ssl->d1->outgoing_written;
  sent_record.first_msg_start = ssl->d1->outgoing_offset;
  while (ssl->d1->outgoing_written < ssl->d1->outgoing_messages.size()) {
    const auto &msg = ssl->d1->outgoing_messages[ssl->d1->outgoing_written];
    if (msg.epoch != first_msg.epoch || msg.is_ccs) {
      // We can only pack messages if the epoch matches. There may be more room
      // in the packet, so tell the caller to keep going.
      should_continue = true;
      break;
    }

    // Decode |msg|'s header.
    CBS cbs(msg.data), body_cbs;
    struct hm_header_st hdr;
    if (!dtls1_parse_fragment(&cbs, &hdr, &body_cbs) ||  //
        hdr.frag_off != 0 ||                             //
        hdr.frag_len != CBS_len(&body_cbs) ||            //
        hdr.msg_len != CBS_len(&body_cbs) ||             //
        CBS_len(&cbs) != 0) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return seal_error;
    }

    // Iterate over every un-acked range in the message, if any.
    Span<const uint8_t> body = body_cbs;
    for (;;) {
      auto range = msg.acked.NextUnmarkedRange(ssl->d1->outgoing_offset);
      if (range.empty()) {
        // Advance to the next message.
        ssl->d1->outgoing_offset = 0;
        ssl->d1->outgoing_written++;
        break;
      }

      // Determine how much progress can be made (minimum one byte of progress).
      size_t capacity = fragments.size() - CBB_len(&cbb);
      if (capacity < DTLS1_HM_HEADER_LENGTH + 1) {
        goto packet_full;
      }
      size_t todo = std::min(range.size(), capacity - DTLS1_HM_HEADER_LENGTH);

      // Empty messages are special-cased in ACK tracking. We act as if they
      // have one byte, but in reality that byte is tracking the header.
      Span<const uint8_t> frag;
      if (!body.empty()) {
        frag = body.subspan(range.start, todo);
      }

      // Assemble the fragment.
      size_t frag_start = CBB_len(&cbb);
      CBB child;
      if (!CBB_add_u8(&cbb, hdr.type) ||                       //
          !CBB_add_u24(&cbb, hdr.msg_len) ||                   //
          !CBB_add_u16(&cbb, hdr.seq) ||                       //
          !CBB_add_u24(&cbb, range.start) ||                   //
          !CBB_add_u24_length_prefixed(&cbb, &child) ||        //
          !CBB_add_bytes(&child, frag.data(), frag.size()) ||  //
          !CBB_flush(&cbb)) {
        OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
        return seal_error;
      }
      size_t frag_end = CBB_len(&cbb);

      // TODO(davidben): It is odd that, on output, we inform the caller of
      // retransmits and individual fragments, but on input we only inform the
      // caller of complete messages.
      ssl_do_msg_callback(ssl, /*is_write=*/1, SSL3_RT_HANDSHAKE,
                          fragments.subspan(frag_start, frag_end - frag_start));

      ssl->d1->outgoing_offset = range.start + todo;
      if (todo < range.size()) {
        // The packet was the limiting factor.
        goto packet_full;
      }
    }

    if (!allow_multiple_messages) {
      should_continue = true;
      break;
    }
  }

packet_full:
  sent_record.last_msg = ssl->d1->outgoing_written;
  sent_record.last_msg_end = ssl->d1->outgoing_offset;

  // We could not fit anything. Don't try to make a record.
  if (CBB_len(&cbb) == 0) {
    assert(!should_continue);
    return seal_flush;
  }

  if (!dtls_seal_record(ssl, &sent_record.number, out.data(), out_len,
                        out.size(), SSL3_RT_HANDSHAKE, CBB_data(&cbb),
                        CBB_len(&cbb), first_msg.epoch)) {
    return seal_error;
  }

  // If DTLS 1.3 (or if the version is not yet known and it may be DTLS 1.3),
  // save the record number to match against ACKs later.
  if (ssl->s3->version == 0 || ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    if (ssl->d1->sent_records == nullptr) {
      ssl->d1->sent_records =
          MakeUnique<MRUQueue<DTLSSentRecord, DTLS_MAX_ACK_BUFFER>>();
      if (ssl->d1->sent_records == nullptr) {
        return seal_error;
      }
    }
    ssl->d1->sent_records->PushBack(sent_record);
  }

  return should_continue ? seal_continue : seal_flush;
}

// seal_next_packet writes as much of the next flight as possible to |out| and
// advances |ssl->d1->outgoing_written| and |ssl->d1->outgoing_offset| as
// appropriate.
static bool seal_next_packet(SSL *ssl, Span<uint8_t> out, size_t *out_len) {
  size_t total = 0;
  for (;;) {
    size_t len;
    seal_result_t ret = seal_next_record(ssl, out, &len);
    switch (ret) {
      case seal_error:
        return false;

      case seal_flush:
      case seal_continue:
        out = out.subspan(len);
        total += len;
        break;
    }

    if (ret == seal_flush) {
      break;
    }
  }

  *out_len = total;
  return true;
}

static int send_flight(SSL *ssl) {
  if (ssl->s3->write_shutdown != ssl_shutdown_none) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PROTOCOL_IS_SHUTDOWN);
    return -1;
  }

  if (ssl->wbio == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BIO_NOT_SET);
    return -1;
  }

  if (ssl->d1->num_timeouts > DTLS1_MAX_TIMEOUTS) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_READ_TIMEOUT_EXPIRED);
    return -1;
  }

  dtls1_update_mtu(ssl);

  Array<uint8_t> packet;
  if (!packet.InitForOverwrite(ssl->d1->mtu)) {
    return -1;
  }

  while (ssl->d1->outgoing_written < ssl->d1->outgoing_messages.size()) {
    uint8_t old_written = ssl->d1->outgoing_written;
    uint32_t old_offset = ssl->d1->outgoing_offset;

    size_t packet_len;
    if (!seal_next_packet(ssl, Span(packet), &packet_len)) {
      return -1;
    }

    if (packet_len == 0 &&
        ssl->d1->outgoing_written < ssl->d1->outgoing_messages.size()) {
      // We made no progress with the packet size available, but did not reach
      // the end.
      OPENSSL_PUT_ERROR(SSL, SSL_R_MTU_TOO_SMALL);
      return false;
    }

    if (packet_len != 0) {
      int bio_ret = BIO_write(ssl->wbio.get(), packet.data(), packet_len);
      if (bio_ret <= 0) {
        // Retry this packet the next time around.
        ssl->d1->outgoing_written = old_written;
        ssl->d1->outgoing_offset = old_offset;
        ssl->s3->rwstate = SSL_ERROR_WANT_WRITE;
        return bio_ret;
      }
    }
  }

  ssl->d1->pending_flush = true;
  return 1;
}

void dtls1_finish_flight(SSL *ssl) {
  if (ssl->d1->outgoing_messages.empty() ||
      ssl->d1->outgoing_messages_complete) {
    return;  // Nothing to do.
  }

  if (ssl->d1->outgoing_messages[0].epoch <= 2) {
    // DTLS 1.3 handshake messages (epoch 2 and below) implicitly ACK the
    // previous flight, so there is no need to ACK previous records. This
    // clears the ACK buffer slightly earlier than the specification suggests.
    // See the discussion in
    // https://mailarchive.ietf.org/arch/msg/tls/kjJnquJOVaWxu5hUCmNzB35eqY0/
    ssl->d1->records_to_ack.Clear();
    ssl->d1->ack_timer.Stop();
    ssl->d1->sending_ack = false;
  }

  ssl->d1->outgoing_messages_complete = true;
  ssl->d1->sending_flight = true;
  // Stop retransmitting the previous flight. In DTLS 1.3, we'll have stopped
  // the timer already, but DTLS 1.2 keeps it running until the next flight is
  // ready.
  dtls1_stop_timer(ssl);
}

void dtls1_schedule_ack(SSL *ssl) {
  ssl->d1->ack_timer.Stop();
  ssl->d1->sending_ack = !ssl->d1->records_to_ack.empty();
}

static int send_ack(SSL *ssl) {
  assert(ssl_protocol_version(ssl) >= TLS1_3_VERSION);

  // Ensure we don't send so many ACKs that we overflow the MTU. There is a
  // 2-byte length prefix and each ACK is 16 bytes.
  dtls1_update_mtu(ssl);
  size_t max_plaintext =
      dtls_seal_max_input_len(ssl, ssl->d1->write_epoch.epoch(), ssl->d1->mtu);
  if (max_plaintext < 2 + 16) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_MTU_TOO_SMALL);  // No room for even one ACK.
    return -1;
  }
  size_t num_acks =
      std::min((max_plaintext - 2) / 16, ssl->d1->records_to_ack.size());

  // Assemble the ACK. RFC 9147 says to sort ACKs numerically. It is unclear if
  // other implementations do this, but go ahead and sort for now. See
  // https://mailarchive.ietf.org/arch/msg/tls/kjJnquJOVaWxu5hUCmNzB35eqY0/.
  // Remove this if rfc9147bis removes this requirement.
  InplaceVector<DTLSRecordNumber, DTLS_MAX_ACK_BUFFER> sorted;
  for (size_t i = ssl->d1->records_to_ack.size() - num_acks;
       i < ssl->d1->records_to_ack.size(); i++) {
    sorted.PushBack(ssl->d1->records_to_ack[i]);
  }
  std::sort(sorted.begin(), sorted.end());

  uint8_t buf[2 + 16 * DTLS_MAX_ACK_BUFFER];
  CBB cbb, child;
  CBB_init_fixed(&cbb, buf, sizeof(buf));
  BSSL_CHECK(CBB_add_u16_length_prefixed(&cbb, &child));
  for (const auto &number : sorted) {
    BSSL_CHECK(CBB_add_u64(&child, number.epoch()));
    BSSL_CHECK(CBB_add_u64(&child, number.sequence()));
  }
  BSSL_CHECK(CBB_flush(&cbb));

  // Encrypt it.
  uint8_t record[DTLS1_3_RECORD_HEADER_WRITE_LENGTH + sizeof(buf) +
                 1 /* record type */ + EVP_AEAD_MAX_OVERHEAD];
  size_t record_len;
  DTLSRecordNumber record_number;
  if (!dtls_seal_record(ssl, &record_number, record, &record_len,
                        sizeof(record), SSL3_RT_ACK, CBB_data(&cbb),
                        CBB_len(&cbb), ssl->d1->write_epoch.epoch())) {
    return -1;
  }

  ssl_do_msg_callback(ssl, /*is_write=*/1, SSL3_RT_ACK,
                      Span(CBB_data(&cbb), CBB_len(&cbb)));

  int bio_ret =
      BIO_write(ssl->wbio.get(), record, static_cast<int>(record_len));
  if (bio_ret <= 0) {
    ssl->s3->rwstate = SSL_ERROR_WANT_WRITE;
    return bio_ret;
  }

  ssl->d1->pending_flush = true;
  return 1;
}

int dtls1_flush(SSL *ssl) {
  // Send the pending ACK, if any.
  if (ssl->d1->sending_ack) {
    int ret = send_ack(ssl);
    if (ret <= 0) {
      return ret;
    }
    ssl->d1->sending_ack = false;
  }

  // Send the pending flight, if any.
  if (ssl->d1->sending_flight) {
    int ret = send_flight(ssl);
    if (ret <= 0) {
      return ret;
    }

    // Reset state for the next send.
    ssl->d1->outgoing_written = 0;
    ssl->d1->outgoing_offset = 0;
    ssl->d1->sending_flight = false;

    // Schedule the next retransmit timer. In DTLS 1.3, we retransmit all
    // flights until ACKed. In DTLS 1.2, the final Finished flight is never
    // ACKed, so we do not keep the timer running after the handshake.
    if (SSL_in_init(ssl) || ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
      if (ssl->d1->num_timeouts == 0) {
        ssl->d1->timeout_duration_ms = ssl->initial_timeout_duration_ms;
      } else {
        ssl->d1->timeout_duration_ms =
            std::min(ssl->d1->timeout_duration_ms * 2, uint32_t{60000});
      }

      OPENSSL_timeval now = ssl_ctx_get_current_time(ssl->ctx.get());
      ssl->d1->retransmit_timer.StartMicroseconds(
          now, uint64_t{ssl->d1->timeout_duration_ms} * 1000);
    }
  }

  if (ssl->d1->pending_flush) {
    if (BIO_flush(ssl->wbio.get()) <= 0) {
      ssl->s3->rwstate = SSL_ERROR_WANT_WRITE;
      return -1;
    }
    ssl->d1->pending_flush = false;
  }

  return 1;
}

unsigned int dtls1_min_mtu(void) { return kMinMTU; }

BSSL_NAMESPACE_END
