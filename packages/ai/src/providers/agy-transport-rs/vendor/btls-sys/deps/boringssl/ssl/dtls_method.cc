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

#include <openssl/err.h>

#include "../crypto/internal.h"
#include "internal.h"


using namespace bssl;

static void dtls1_on_handshake_complete(SSL *ssl) {
  if (ssl_protocol_version(ssl) <= TLS1_2_VERSION) {
    // Stop the reply timer left by the last flight we sent. In DTLS 1.2, the
    // retransmission timer ends when the handshake completes. If we sent the
    // final flight, we may still need to retransmit it, but that is driven by
    // messages from the peer.
    dtls1_stop_timer(ssl);
    // If the final flight had a reply, we know the peer has received it. If
    // not, we must leave the flight around for post-handshake retransmission.
    if (ssl->d1->flight_has_reply) {
      dtls_clear_outgoing_messages(ssl);
    }
  }
}

static bool next_epoch(const SSL *ssl, uint16_t *out,
                       ssl_encryption_level_t level, uint16_t prev) {
  switch (level) {
    case ssl_encryption_initial:
    case ssl_encryption_early_data:
    case ssl_encryption_handshake:
      *out = static_cast<uint16_t>(level);
      return true;

    case ssl_encryption_application:
      if (prev < ssl_encryption_application &&
          ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
        *out = static_cast<uint16_t>(level);
        return true;
      }

      if (prev == 0xffff) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_TOO_MANY_KEY_UPDATES);
        return false;
      }
      *out = prev + 1;
      return true;
  }

  assert(0);
  return false;
}

static bool dtls1_set_read_state(SSL *ssl, ssl_encryption_level_t level,
                                 UniquePtr<SSLAEADContext> aead_ctx,
                                 Span<const uint8_t> traffic_secret) {
  // Cipher changes are forbidden if the current epoch has leftover data.
  if (dtls_has_unprocessed_handshake_data(ssl)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_EXCESS_HANDSHAKE_DATA);
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_UNEXPECTED_MESSAGE);
    return false;
  }

  DTLSReadEpoch new_epoch;
  new_epoch.aead = std::move(aead_ctx);
  new_epoch.traffic_secret.CopyFrom(traffic_secret);
  if (!next_epoch(ssl, &new_epoch.epoch, level, ssl->d1->read_epoch.epoch)) {
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_UNEXPECTED_MESSAGE);
    return false;
  }

  if (ssl_protocol_version(ssl) > TLS1_2_VERSION) {
    new_epoch.rn_encrypter =
        RecordNumberEncrypter::Create(new_epoch.aead->cipher(), traffic_secret);
    if (new_epoch.rn_encrypter == nullptr) {
      return false;
    }

    // In DTLS 1.3, new read epochs are not applied immediately. In principle,
    // we could do the same in DTLS 1.2, but we would ignore every record from
    // the previous epoch anyway.
    assert(ssl->d1->next_read_epoch == nullptr);
    ssl->d1->next_read_epoch = MakeUnique<DTLSReadEpoch>(std::move(new_epoch));
    if (ssl->d1->next_read_epoch == nullptr) {
      return false;
    }
  } else {
    ssl->d1->read_epoch = std::move(new_epoch);
    ssl->d1->has_change_cipher_spec = false;
  }
  return true;
}

static bool dtls1_set_write_state(SSL *ssl, ssl_encryption_level_t level,
                                  UniquePtr<SSLAEADContext> aead_ctx,
                                  Span<const uint8_t> traffic_secret) {
  uint16_t epoch;
  if (!next_epoch(ssl, &epoch, level, ssl->d1->write_epoch.epoch())) {
    return false;
  }

  DTLSWriteEpoch new_epoch;
  new_epoch.aead = std::move(aead_ctx);
  new_epoch.next_record = DTLSRecordNumber(epoch, 0);
  new_epoch.traffic_secret.CopyFrom(traffic_secret);
  if (ssl_protocol_version(ssl) > TLS1_2_VERSION) {
    new_epoch.rn_encrypter =
        RecordNumberEncrypter::Create(new_epoch.aead->cipher(), traffic_secret);
    if (new_epoch.rn_encrypter == nullptr) {
      return false;
    }
  }

  auto current = MakeUnique<DTLSWriteEpoch>(std::move(ssl->d1->write_epoch));
  if (current == nullptr) {
    return false;
  }

  ssl->d1->write_epoch = std::move(new_epoch);
  ssl->d1->extra_write_epochs.PushBack(std::move(current));
  dtls_clear_unused_write_epochs(ssl);
  return true;
}

static const SSL_PROTOCOL_METHOD kDTLSProtocolMethod = {
    true /* is_dtls */,
    dtls1_new,
    dtls1_free,
    dtls1_get_message,
    dtls1_next_message,
    dtls_has_unprocessed_handshake_data,
    dtls1_open_handshake,
    dtls1_open_change_cipher_spec,
    dtls1_open_app_data,
    dtls1_write_app_data,
    dtls1_dispatch_alert,
    dtls1_init_message,
    dtls1_finish_message,
    dtls1_add_message,
    dtls1_add_change_cipher_spec,
    dtls1_finish_flight,
    dtls1_schedule_ack,
    dtls1_flush,
    dtls1_on_handshake_complete,
    dtls1_set_read_state,
    dtls1_set_write_state,
};

const SSL_METHOD *DTLS_method(void) {
  static const SSL_METHOD kMethod = {
      0,
      &kDTLSProtocolMethod,
      &ssl_crypto_x509_method,
  };
  return &kMethod;
}

const SSL_METHOD *DTLS_with_buffers_method(void) {
  static const SSL_METHOD kMethod = {
      0,
      &kDTLSProtocolMethod,
      &ssl_noop_x509_method,
  };
  return &kMethod;
}

// Legacy version-locked methods.

const SSL_METHOD *DTLSv1_2_method(void) {
  static const SSL_METHOD kMethod = {
      DTLS1_2_VERSION,
      &kDTLSProtocolMethod,
      &ssl_crypto_x509_method,
  };
  return &kMethod;
}

const SSL_METHOD *DTLSv1_method(void) {
  static const SSL_METHOD kMethod = {
      DTLS1_VERSION,
      &kDTLSProtocolMethod,
      &ssl_crypto_x509_method,
  };
  return &kMethod;
}

// Legacy side-specific methods.

const SSL_METHOD *DTLSv1_2_server_method(void) { return DTLSv1_2_method(); }

const SSL_METHOD *DTLSv1_server_method(void) { return DTLSv1_method(); }

const SSL_METHOD *DTLSv1_2_client_method(void) { return DTLSv1_2_method(); }

const SSL_METHOD *DTLSv1_client_method(void) { return DTLSv1_method(); }

const SSL_METHOD *DTLS_server_method(void) { return DTLS_method(); }

const SSL_METHOD *DTLS_client_method(void) { return DTLS_method(); }
