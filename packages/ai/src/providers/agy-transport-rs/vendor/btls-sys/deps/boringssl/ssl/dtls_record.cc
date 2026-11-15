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
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>

#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

bool DTLSReplayBitmap::ShouldDiscard(uint64_t seq_num) const {
  const size_t kWindowSize = map_.size();

  if (seq_num > max_seq_num_) {
    return false;
  }
  uint64_t idx = max_seq_num_ - seq_num;
  return idx >= kWindowSize || map_[idx];
}

void DTLSReplayBitmap::Record(uint64_t seq_num) {
  const size_t kWindowSize = map_.size();

  // Shift the window if necessary.
  if (seq_num > max_seq_num_) {
    uint64_t shift = seq_num - max_seq_num_;
    if (shift >= kWindowSize) {
      map_.reset();
    } else {
      map_ <<= shift;
    }
    max_seq_num_ = seq_num;
  }

  uint64_t idx = max_seq_num_ - seq_num;
  if (idx < kWindowSize) {
    map_[idx] = true;
  }
}

static uint16_t dtls_record_version(const SSL *ssl) {
  if (ssl->s3->version == 0) {
    // Before the version is determined, outgoing records use dTLS 1.0 for
    // historical compatibility requirements.
    return DTLS1_VERSION;
  }
  // DTLS 1.3 freezes the record version at DTLS 1.2. Previous ones use the
  // version itself.
  return ssl_protocol_version(ssl) >= TLS1_3_VERSION ? DTLS1_2_VERSION
                                                     : ssl->s3->version;
}

static uint64_t dtls_aead_sequence(const SSL *ssl, DTLSRecordNumber num) {
  // DTLS 1.3 uses the sequence number with the AEAD, while DTLS 1.2 uses the
  // combined value. If the version is not known, the epoch is unencrypted and
  // the value is ignored.
  return (ssl->s3->version != 0 && ssl_protocol_version(ssl) >= TLS1_3_VERSION)
             ? num.sequence()
             : num.combined();
}

// reconstruct_epoch finds the largest epoch that ends with the epoch bits from
// |wire_epoch| that is less than or equal to |current_epoch|, to match the
// epoch reconstruction algorithm described in RFC 9147 section 4.2.2.
static uint16_t reconstruct_epoch(uint8_t wire_epoch, uint16_t current_epoch) {
  uint16_t current_epoch_high = current_epoch & 0xfffc;
  uint16_t epoch = (wire_epoch & 0x3) | current_epoch_high;
  if (epoch > current_epoch && current_epoch_high > 0) {
    epoch -= 0x4;
  }
  return epoch;
}

uint64_t reconstruct_seqnum(uint16_t wire_seq, uint64_t seq_mask,
                            uint64_t max_valid_seqnum) {
  // Although DTLS 1.3 can support sequence numbers up to 2^64-1, we continue to
  // enforce the DTLS 1.2 2^48-1 limit. With a minimal DTLS 1.3 record header (2
  // bytes), no payload, and 16 byte AEAD overhead, sending 2^48 records would
  // require 5 petabytes. This allows us to continue to pack a DTLS record
  // number into an 8-byte structure.
  assert(max_valid_seqnum <= DTLSRecordNumber::kMaxSequence);
  assert(seq_mask == 0xff || seq_mask == 0xffff);

  uint64_t max_seqnum_plus_one = max_valid_seqnum + 1;
  uint64_t diff = (wire_seq - max_seqnum_plus_one) & seq_mask;
  uint64_t step = seq_mask + 1;
  // This addition cannot overflow. It is at most 2^48 + seq_mask. It, however,
  // may exceed 2^48-1.
  uint64_t seqnum = max_seqnum_plus_one + diff;
  bool too_large = seqnum > DTLSRecordNumber::kMaxSequence;
  // If the diff is larger than half the step size, then the closest seqnum
  // to max_seqnum_plus_one (in Z_{2^64}) is seqnum minus step instead of
  // seqnum.
  bool closer_is_less = diff > step / 2;
  // Subtracting step from seqnum will cause underflow if seqnum is too small.
  bool would_underflow = seqnum < step;
  if (too_large || (closer_is_less && !would_underflow)) {
    seqnum -= step;
  }
  assert(seqnum <= DTLSRecordNumber::kMaxSequence);
  return seqnum;
}

DTLSReadEpoch *dtls_get_read_epoch(const SSL *ssl, uint16_t epoch) {
  if (epoch == ssl->d1->read_epoch.epoch) {
    return &ssl->d1->read_epoch;
  }
  if (ssl->d1->next_read_epoch != nullptr &&
      epoch == ssl->d1->next_read_epoch->epoch) {
    return ssl->d1->next_read_epoch.get();
  }
  if (ssl->d1->prev_read_epoch != nullptr &&
      epoch == ssl->d1->prev_read_epoch->epoch.epoch) {
    return &ssl->d1->prev_read_epoch->epoch;
  }
  return nullptr;
}

DTLSWriteEpoch *dtls_get_write_epoch(const SSL *ssl, uint16_t epoch) {
  if (ssl->d1->write_epoch.epoch() == epoch) {
    return &ssl->d1->write_epoch;
  }
  for (const auto &e : ssl->d1->extra_write_epochs) {
    if (e->epoch() == epoch) {
      return e.get();
    }
  }
  return nullptr;
}

static Span<uint8_t> cbs_to_writable_bytes(CBS cbs) {
  return Span(const_cast<uint8_t *>(CBS_data(&cbs)), CBS_len(&cbs));
}

struct ParsedDTLSRecord {
  // read_epoch will be null if the record is for an unrecognized epoch. In that
  // case, |number| may be unset.
  DTLSReadEpoch *read_epoch = nullptr;
  DTLSRecordNumber number;
  CBS header, body;
  uint8_t type = 0;
  uint16_t version = 0;
};

static bool use_dtls13_record_header(const SSL *ssl, uint16_t epoch) {
  // Plaintext records in DTLS 1.3 also use the DTLSPlaintext structure for
  // backwards compatibility.
  return ssl->s3->version != 0 && ssl_protocol_version(ssl) > TLS1_2_VERSION &&
         epoch > 0;
}

static bool parse_dtls13_record(SSL *ssl, CBS *in, ParsedDTLSRecord *out) {
  if (out->type & 0x10) {
    // Connection ID bit set, which we didn't negotiate.
    return false;
  }

  uint16_t max_epoch = ssl->d1->read_epoch.epoch;
  if (ssl->d1->next_read_epoch != nullptr) {
    max_epoch = std::max(max_epoch, ssl->d1->next_read_epoch->epoch);
  }
  uint16_t epoch = reconstruct_epoch(out->type, max_epoch);
  size_t seq_len = (out->type & 0x08) ? 2 : 1;
  CBS seq_bytes;
  if (!CBS_get_bytes(in, &seq_bytes, seq_len)) {
    return false;
  }
  if (out->type & 0x04) {
    // 16-bit length present
    if (!CBS_get_u16_length_prefixed(in, &out->body)) {
      return false;
    }
  } else {
    // No length present - the remaining contents are the whole packet.
    // CBS_get_bytes is used here to advance |in| to the end so that future
    // code that computes the number of consumed bytes functions correctly.
    BSSL_CHECK(CBS_get_bytes(in, &out->body, CBS_len(in)));
  }

  // Drop the previous read epoch if expired.
  if (ssl->d1->prev_read_epoch != nullptr &&
      ssl_ctx_get_current_time(ssl->ctx.get()).tv_sec >
          ssl->d1->prev_read_epoch->expire) {
    ssl->d1->prev_read_epoch = nullptr;
  }

  // Look up the corresponding epoch. This header form only matches encrypted
  // DTLS 1.3 epochs.
  DTLSReadEpoch *read_epoch = dtls_get_read_epoch(ssl, epoch);
  if (read_epoch != nullptr && use_dtls13_record_header(ssl, epoch)) {
    out->read_epoch = read_epoch;

    // Decrypt and reconstruct the sequence number:
    uint8_t mask[2];
    if (!read_epoch->rn_encrypter->GenerateMask(mask, out->body)) {
      // GenerateMask most likely failed because the record body was not long
      // enough.
      return false;
    }
    // Apply the mask to the sequence number in-place. The header (with the
    // decrypted sequence number bytes) is used as the additional data for the
    // AEAD function.
    auto writable_seq = cbs_to_writable_bytes(seq_bytes);
    uint64_t seq = 0;
    for (size_t i = 0; i < writable_seq.size(); i++) {
      writable_seq[i] ^= mask[i];
      seq = (seq << 8) | writable_seq[i];
    }
    uint64_t full_seq = reconstruct_seqnum(seq, (1 << (seq_len * 8)) - 1,
                                           read_epoch->bitmap.max_seq_num());
    out->number = DTLSRecordNumber(epoch, full_seq);
  }

  return true;
}

static bool parse_dtls12_record(SSL *ssl, CBS *in, ParsedDTLSRecord *out) {
  uint64_t epoch_and_seq;
  if (!CBS_get_u16(in, &out->version) ||  //
      !CBS_get_u64(in, &epoch_and_seq) ||
      !CBS_get_u16_length_prefixed(in, &out->body)) {
    return false;
  }
  out->number = DTLSRecordNumber::FromCombined(epoch_and_seq);

  uint16_t epoch = out->number.epoch();
  bool version_ok;
  if (epoch == 0) {
    // Only check the first byte. Enforcing beyond that can prevent decoding
    // version negotiation failure alerts.
    version_ok = (out->version >> 8) == DTLS1_VERSION_MAJOR;
  } else {
    version_ok = out->version == dtls_record_version(ssl);
  }
  if (!version_ok) {
    return false;
  }

  // Look up the corresponding epoch. In DTLS 1.2, we only need to consider one
  // epoch.
  if (epoch == ssl->d1->read_epoch.epoch &&
      !use_dtls13_record_header(ssl, epoch)) {
    out->read_epoch = &ssl->d1->read_epoch;
  }

  return true;
}

static bool parse_dtls_record(SSL *ssl, CBS *cbs, ParsedDTLSRecord *out) {
  CBS copy = *cbs;
  if (!CBS_get_u8(cbs, &out->type)) {
    return false;
  }

  bool ok;
  if ((out->type & 0xe0) == 0x20) {
    ok = parse_dtls13_record(ssl, cbs, out);
  } else {
    ok = parse_dtls12_record(ssl, cbs, out);
  }
  if (!ok) {
    return false;
  }

  if (CBS_len(&out->body) > SSL3_RT_MAX_ENCRYPTED_LENGTH) {
    return false;
  }

  size_t header_len = CBS_data(&out->body) - CBS_data(&copy);
  BSSL_CHECK(CBS_get_bytes(&copy, &out->header, header_len));
  return true;
}

enum ssl_open_record_t dtls_open_record(SSL *ssl, uint8_t *out_type,
                                        DTLSRecordNumber *out_number,
                                        Span<uint8_t> *out,
                                        size_t *out_consumed,
                                        uint8_t *out_alert, Span<uint8_t> in) {
  *out_consumed = 0;
  if (ssl->s3->read_shutdown == ssl_shutdown_close_notify) {
    return ssl_open_record_close_notify;
  }

  if (in.empty()) {
    return ssl_open_record_partial;
  }

  CBS cbs(in);
  ParsedDTLSRecord record;
  if (!parse_dtls_record(ssl, &cbs, &record)) {
    // The record header was incomplete or malformed. Drop the entire packet.
    *out_consumed = in.size();
    return ssl_open_record_discard;
  }

  ssl_do_msg_callback(ssl, 0 /* read */, SSL3_RT_HEADER, record.header);

  if (record.read_epoch == nullptr ||
      record.read_epoch->bitmap.ShouldDiscard(record.number.sequence())) {
    // Drop this record. It's from an unknown epoch or is a replay. Note that if
    // the record is from next epoch, it could be buffered for later. For
    // simplicity, drop it and expect retransmit to handle it later; DTLS must
    // handle packet loss anyway.
    *out_consumed = in.size() - CBS_len(&cbs);
    return ssl_open_record_discard;
  }

  // Decrypt the body in-place.
  if (!record.read_epoch->aead->Open(out, record.type, record.version,
                                     dtls_aead_sequence(ssl, record.number),
                                     record.header,
                                     cbs_to_writable_bytes(record.body))) {
    // Bad packets are silently dropped in DTLS. See section 4.2.1 of RFC 6347.
    // Clear the error queue of any errors decryption may have added. Drop the
    // entire packet as it must not have come from the peer.
    //
    // TODO(davidben): This doesn't distinguish malloc failures from encryption
    // failures.
    ERR_clear_error();
    *out_consumed = in.size() - CBS_len(&cbs);
    return ssl_open_record_discard;
  }
  *out_consumed = in.size() - CBS_len(&cbs);

  // DTLS 1.3 hides the record type inside the encrypted data.
  bool has_padding = !record.read_epoch->aead->is_null_cipher() &&
                     ssl_protocol_version(ssl) >= TLS1_3_VERSION;
  // Check the plaintext length.
  size_t plaintext_limit = SSL3_RT_MAX_PLAIN_LENGTH + (has_padding ? 1 : 0);
  if (out->size() > plaintext_limit) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DATA_LENGTH_TOO_LONG);
    *out_alert = SSL_AD_RECORD_OVERFLOW;
    return ssl_open_record_error;
  }

  if (has_padding) {
    do {
      if (out->empty()) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_DECRYPTION_FAILED_OR_BAD_RECORD_MAC);
        *out_alert = SSL_AD_DECRYPT_ERROR;
        return ssl_open_record_error;
      }
      record.type = out->back();
      *out = out->subspan(0, out->size() - 1);
    } while (record.type == 0);
  }

  record.read_epoch->bitmap.Record(record.number.sequence());

  // Once we receive a record from the next epoch in DTLS 1.3, it becomes the
  // current epoch. Also save the previous epoch. This allows us to handle
  // packet reordering on KeyUpdate, as well as ACK retransmissions of the
  // Finished flight.
  if (record.read_epoch == ssl->d1->next_read_epoch.get()) {
    assert(ssl_protocol_version(ssl) >= TLS1_3_VERSION);
    auto prev = MakeUnique<DTLSPrevReadEpoch>();
    if (prev == nullptr) {
      *out_alert = SSL_AD_INTERNAL_ERROR;
      return ssl_open_record_error;
    }

    // Release the epoch after a timeout.
    prev->expire = ssl_ctx_get_current_time(ssl->ctx.get()).tv_sec;
    if (prev->expire >= UINT64_MAX - DTLS_PREV_READ_EPOCH_EXPIRE_SECONDS) {
      prev->expire = UINT64_MAX;  // Saturate on overflow.
    } else {
      prev->expire += DTLS_PREV_READ_EPOCH_EXPIRE_SECONDS;
    }

    prev->epoch = std::move(ssl->d1->read_epoch);
    ssl->d1->prev_read_epoch = std::move(prev);
    ssl->d1->read_epoch = std::move(*ssl->d1->next_read_epoch);
    ssl->d1->next_read_epoch = nullptr;
  }

  // TODO(davidben): Limit the number of empty records as in TLS? This is only
  // useful if we also limit discarded packets.

  if (record.type == SSL3_RT_ALERT) {
    return ssl_process_alert(ssl, out_alert, *out);
  }

  // Reject application data in epochs that do not allow it.
  if (record.type == SSL3_RT_APPLICATION_DATA) {
    bool app_data_allowed;
    if (ssl->s3->version != 0 && ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
      // Application data is allowed in 0-RTT (epoch 1) and after the handshake
      // (3 and up).
      app_data_allowed =
          record.number.epoch() == 1 || record.number.epoch() >= 3;
    } else {
      // Application data is allowed starting epoch 1.
      app_data_allowed = record.number.epoch() >= 1;
    }
    if (!app_data_allowed) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_RECORD);
      *out_alert = SSL_AD_UNEXPECTED_MESSAGE;
      return ssl_open_record_error;
    }
  }

  ssl->s3->warning_alert_count = 0;

  *out_type = record.type;
  *out_number = record.number;
  return ssl_open_record_success;
}

size_t dtls_record_header_write_len(const SSL *ssl, uint16_t epoch) {
  if (!use_dtls13_record_header(ssl, epoch)) {
    return DTLS_PLAINTEXT_RECORD_HEADER_LENGTH;
  }
  // The DTLS 1.3 has a variable length record header. We never send Connection
  // ID, we always send 16-bit sequence numbers, and we send a length. (Length
  // can be omitted, but only for the last record of a packet. Since we send
  // multiple records in one packet, it's easier to implement always sending the
  // length.)
  return DTLS1_3_RECORD_HEADER_WRITE_LENGTH;
}

size_t dtls_max_seal_overhead(const SSL *ssl, uint16_t epoch) {
  DTLSWriteEpoch *write_epoch = dtls_get_write_epoch(ssl, epoch);
  if (write_epoch == nullptr) {
    return 0;
  }
  size_t ret = dtls_record_header_write_len(ssl, epoch) +
               write_epoch->aead->MaxOverhead();
  if (use_dtls13_record_header(ssl, epoch)) {
    // Add 1 byte for the encrypted record type.
    ret++;
  }
  return ret;
}

size_t dtls_seal_prefix_len(const SSL *ssl, uint16_t epoch) {
  DTLSWriteEpoch *write_epoch = dtls_get_write_epoch(ssl, epoch);
  if (write_epoch == nullptr) {
    return 0;
  }
  return dtls_record_header_write_len(ssl, epoch) +
         write_epoch->aead->ExplicitNonceLen();
}

size_t dtls_seal_max_input_len(const SSL *ssl, uint16_t epoch, size_t max_out) {
  DTLSWriteEpoch *write_epoch = dtls_get_write_epoch(ssl, epoch);
  if (write_epoch == nullptr) {
    return 0;
  }
  size_t header_len = dtls_record_header_write_len(ssl, epoch);
  if (max_out <= header_len) {
    return 0;
  }
  max_out -= header_len;
  max_out = write_epoch->aead->MaxSealInputLen(max_out);
  if (max_out > 0 && use_dtls13_record_header(ssl, epoch)) {
    // Remove 1 byte for the encrypted record type.
    max_out--;
  }
  return max_out;
}

bool dtls_seal_record(SSL *ssl, DTLSRecordNumber *out_number, uint8_t *out,
                      size_t *out_len, size_t max_out, uint8_t type,
                      const uint8_t *in, size_t in_len, uint16_t epoch) {
  const size_t prefix = dtls_seal_prefix_len(ssl, epoch);
  if (buffers_alias(in, in_len, out, max_out) &&
      (max_out < prefix || out + prefix != in)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_OUTPUT_ALIASES_INPUT);
    return false;
  }

  // Determine the parameters for the current epoch.
  DTLSWriteEpoch *write_epoch = dtls_get_write_epoch(ssl, epoch);
  if (write_epoch == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const size_t record_header_len = dtls_record_header_write_len(ssl, epoch);

  // Ensure the sequence number update does not overflow.
  DTLSRecordNumber record_number = write_epoch->next_record;
  if (!record_number.HasNext()) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
    return false;
  }

  bool dtls13_header = use_dtls13_record_header(ssl, epoch);
  uint8_t *extra_in = nullptr;
  size_t extra_in_len = 0;
  if (dtls13_header) {
    extra_in = &type;
    extra_in_len = 1;
  }

  size_t ciphertext_len;
  if (!write_epoch->aead->CiphertextLen(&ciphertext_len, in_len,
                                        extra_in_len)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RECORD_TOO_LARGE);
    return false;
  }
  if (max_out < record_header_len + ciphertext_len) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BUFFER_TOO_SMALL);
    return false;
  }

  uint16_t record_version = dtls_record_version(ssl);
  if (dtls13_header) {
    // The first byte of the DTLS 1.3 record header has the following format:
    // 0 1 2 3 4 5 6 7
    // +-+-+-+-+-+-+-+-+
    // |0|0|1|C|S|L|E E|
    // +-+-+-+-+-+-+-+-+
    //
    // We set C=0 (no Connection ID), S=1 (16-bit sequence number), L=1 (length
    // is present), which is a mask of 0x2c. The E E bits are the low-order two
    // bits of the epoch.
    //
    // +-+-+-+-+-+-+-+-+
    // |0|0|1|0|1|1|E E|
    // +-+-+-+-+-+-+-+-+
    out[0] = 0x2c | (epoch & 0x3);
    // We always use a two-byte sequence number. A one-byte sequence number
    // would require coordinating with the application on ACK feedback to know
    // that the peer is not too far behind.
    CRYPTO_store_u16_be(out + 1, write_epoch->next_record.sequence());
    // TODO(crbug.com/42290594): When we know the record is last in the packet,
    // omit the length.
    CRYPTO_store_u16_be(out + 3, ciphertext_len);
  } else {
    out[0] = type;
    CRYPTO_store_u16_be(out + 1, record_version);
    CRYPTO_store_u64_be(out + 3, record_number.combined());
    CRYPTO_store_u16_be(out + 11, ciphertext_len);
  }
  Span<const uint8_t> header(out, record_header_len);

  if (!write_epoch->aead->SealScatter(
          out + record_header_len, out + prefix, out + prefix + in_len, type,
          record_version, dtls_aead_sequence(ssl, record_number), header, in,
          in_len, extra_in, extra_in_len)) {
    return false;
  }

  // Perform record number encryption (RFC 9147 section 4.2.3).
  if (dtls13_header) {
    // Record number encryption uses bytes from the ciphertext as a sample to
    // generate the mask used for encryption. For simplicity, pass in the whole
    // ciphertext as the sample - GenerateRecordNumberMask will read only what
    // it needs (and error if |sample| is too short).
    Span<const uint8_t> sample(out + record_header_len, ciphertext_len);
    uint8_t mask[2];
    if (!write_epoch->rn_encrypter->GenerateMask(mask, sample)) {
      return false;
    }
    out[1] ^= mask[0];
    out[2] ^= mask[1];
  }

  *out_number = record_number;
  write_epoch->next_record = record_number.Next();
  *out_len = record_header_len + ciphertext_len;
  ssl_do_msg_callback(ssl, 1 /* write */, SSL3_RT_HEADER, header);
  return true;
}

BSSL_NAMESPACE_END
