// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright (c) 2002, Oracle and/or its affiliates. All rights reserved.
// Copyright 2005 Nokia. All rights reserved.
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

#include <algorithm>
#include <iterator>

#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/nid.h>
#include <openssl/rand.h>

#include "../crypto/internal.h"
#include "internal.h"

#if defined(OPENSSL_WINDOWS)
#include <sys/timeb.h>
#else
#include <sys/socket.h>
#include <sys/time.h>
#endif


BSSL_NAMESPACE_BEGIN

static_assert(SSL3_RT_MAX_ENCRYPTED_OVERHEAD >=
                  SSL3_RT_SEND_MAX_ENCRYPTED_OVERHEAD,
              "max overheads are inconsistent");

// |SSL_R_UNKNOWN_PROTOCOL| is no longer emitted, but continue to define it
// to avoid downstream churn.
OPENSSL_DECLARE_ERROR_REASON(SSL, UNKNOWN_PROTOCOL)

// The following errors are no longer emitted, but are used in nginx without
// #ifdefs.
OPENSSL_DECLARE_ERROR_REASON(SSL, BLOCK_CIPHER_PAD_IS_WRONG)
OPENSSL_DECLARE_ERROR_REASON(SSL, NO_CIPHERS_SPECIFIED)

// Some error codes are special. Ensure the make_errors.go script never
// regresses this.
static_assert(SSL_R_TLSV1_ALERT_NO_RENEGOTIATION ==
                  SSL_AD_NO_RENEGOTIATION + SSL_AD_REASON_OFFSET,
              "alert reason code mismatch");

// kMaxHandshakeSize is the maximum size, in bytes, of a handshake message.
static const size_t kMaxHandshakeSize = (1u << 24) - 1;

static CRYPTO_EX_DATA_CLASS g_ex_data_class_ssl =
    CRYPTO_EX_DATA_CLASS_INIT_WITH_APP_DATA;
static CRYPTO_EX_DATA_CLASS g_ex_data_class_ssl_ctx =
    CRYPTO_EX_DATA_CLASS_INIT_WITH_APP_DATA;

bool CBBFinishArray(CBB *cbb, Array<uint8_t> *out) {
  uint8_t *ptr;
  size_t len;
  if (!CBB_finish(cbb, &ptr, &len)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }
  out->Reset(ptr, len);
  return true;
}

void ssl_reset_error_state(SSL *ssl) {
  // Functions which use |SSL_get_error| must reset I/O and error state on
  // entry.
  ssl->s3->rwstate = SSL_ERROR_NONE;
  ERR_clear_error();
  ERR_clear_system_error();
}

void ssl_set_read_error(SSL *ssl) {
  ssl->s3->read_shutdown = ssl_shutdown_error;
  ssl->s3->read_error.reset(ERR_save_state());
}

static bool check_read_error(const SSL *ssl) {
  if (ssl->s3->read_shutdown == ssl_shutdown_error) {
    ERR_restore_state(ssl->s3->read_error.get());
    return false;
  }
  return true;
}

bool ssl_can_write(const SSL *ssl) {
  return !SSL_in_init(ssl) || ssl->s3->hs->can_early_write;
}

bool ssl_can_read(const SSL *ssl) {
  return !SSL_in_init(ssl) || ssl->s3->hs->can_early_read;
}

ssl_open_record_t ssl_open_handshake(SSL *ssl, size_t *out_consumed,
                                     uint8_t *out_alert, Span<uint8_t> in) {
  *out_consumed = 0;
  if (!check_read_error(ssl)) {
    *out_alert = 0;
    return ssl_open_record_error;
  }
  auto ret = ssl->method->open_handshake(ssl, out_consumed, out_alert, in);
  if (ret == ssl_open_record_error) {
    ssl_set_read_error(ssl);
  }
  return ret;
}

ssl_open_record_t ssl_open_change_cipher_spec(SSL *ssl, size_t *out_consumed,
                                              uint8_t *out_alert,
                                              Span<uint8_t> in) {
  *out_consumed = 0;
  if (!check_read_error(ssl)) {
    *out_alert = 0;
    return ssl_open_record_error;
  }
  auto ret =
      ssl->method->open_change_cipher_spec(ssl, out_consumed, out_alert, in);
  if (ret == ssl_open_record_error) {
    ssl_set_read_error(ssl);
  }
  return ret;
}

ssl_open_record_t ssl_open_app_data(SSL *ssl, Span<uint8_t> *out,
                                    size_t *out_consumed, uint8_t *out_alert,
                                    Span<uint8_t> in) {
  *out_consumed = 0;
  if (!check_read_error(ssl)) {
    *out_alert = 0;
    return ssl_open_record_error;
  }
  auto ret = ssl->method->open_app_data(ssl, out, out_consumed, out_alert, in);
  if (ret == ssl_open_record_error) {
    ssl_set_read_error(ssl);
  }
  return ret;
}

static uint8_t hex_char_consttime(uint8_t b) {
  declassify_assert(b < 16);
  return constant_time_select_8(constant_time_lt_8(b, 10), b + '0',
                                b - 10 + 'a');
}

static bool cbb_add_hex_consttime(CBB *cbb, Span<const uint8_t> in) {
  uint8_t *out;
  if (!CBB_add_space(cbb, &out, in.size() * 2)) {
    return false;
  }

  for (uint8_t b : in) {
    *(out++) = hex_char_consttime(b >> 4);
    *(out++) = hex_char_consttime(b & 0xf);
  }

  return true;
}

bool ssl_log_secret(const SSL *ssl, const char *label,
                    Span<const uint8_t> secret) {
  if (ssl->ctx->keylog_callback == nullptr) {
    return true;
  }

  ScopedCBB cbb;
  Array<uint8_t> line;
  auto label_bytes = bssl::StringAsBytes(label);
  if (!CBB_init(cbb.get(), strlen(label) + 1 + SSL3_RANDOM_SIZE * 2 + 1 +
                               secret.size() * 2 + 1) ||
      !CBB_add_bytes(cbb.get(), label_bytes.data(), label_bytes.size()) ||
      !CBB_add_u8(cbb.get(), ' ') ||
      !cbb_add_hex_consttime(cbb.get(), ssl->s3->client_random) ||
      !CBB_add_u8(cbb.get(), ' ') ||
      // Convert to hex in constant time to avoid leaking |secret|. If the
      // callback discards the data, we should not introduce side channels.
      !cbb_add_hex_consttime(cbb.get(), secret) ||
      !CBB_add_u8(cbb.get(), 0 /* NUL */) ||
      !CBBFinishArray(cbb.get(), &line)) {
    return false;
  }

  ssl->ctx->keylog_callback(ssl, reinterpret_cast<const char *>(line.data()));
  return true;
}

void ssl_do_info_callback(const SSL *ssl, int type, int value) {
  void (*cb)(const SSL *ssl, int type, int value) = nullptr;
  if (ssl->info_callback != nullptr) {
    cb = ssl->info_callback;
  } else if (ssl->ctx->info_callback != nullptr) {
    cb = ssl->ctx->info_callback;
  }

  if (cb != nullptr) {
    cb(ssl, type, value);
  }
}

void ssl_do_msg_callback(const SSL *ssl, int is_write, int content_type,
                         Span<const uint8_t> in) {
  if (ssl->msg_callback == nullptr) {
    return;
  }

  // |version| is zero when calling for |SSL3_RT_HEADER| and |SSL2_VERSION| for
  // a V2ClientHello.
  int version;
  switch (content_type) {
    case 0:
      // V2ClientHello
      version = SSL2_VERSION;
      break;
    case SSL3_RT_HEADER:
      version = 0;
      break;
    default:
      version = SSL_version(ssl);
  }

  ssl->msg_callback(is_write, version, content_type, in.data(), in.size(),
                    const_cast<SSL *>(ssl), ssl->msg_callback_arg);
}

OPENSSL_timeval ssl_ctx_get_current_time(const SSL_CTX *ctx) {
  if (ctx->current_time_cb != nullptr) {
    // TODO(davidben): Update current_time_cb to use OPENSSL_timeval. See
    // https://crbug.com/boringssl/155.
    struct timeval clock;
    ctx->current_time_cb(nullptr /* ssl */, &clock);
    if (clock.tv_sec < 0) {
      assert(0);
      return {0, 0};
    } else {
      return {static_cast<uint64_t>(clock.tv_sec),
              static_cast<uint32_t>(clock.tv_usec)};
    }
  }

#if defined(OPENSSL_WINDOWS)
  struct _timeb time;
  _ftime(&time);
  if (time.time < 0) {
    assert(0);
    return {0, 0};
  } else {
    return {static_cast<uint64_t>(time.time),
            static_cast<uint32_t>(time.millitm * 1000)};
  }
#else
  struct timeval clock;
  gettimeofday(&clock, nullptr);
  if (clock.tv_sec < 0) {
    assert(0);
    return {0, 0};
  } else {
    return {static_cast<uint64_t>(clock.tv_sec),
            static_cast<uint32_t>(clock.tv_usec)};
  }
#endif
}

void SSL_CTX_set_handoff_mode(SSL_CTX *ctx, bool on) { ctx->handoff = on; }

static bool ssl_can_renegotiate(const SSL *ssl) {
  if (ssl->server || SSL_is_dtls(ssl)) {
    return false;
  }

  if (ssl->s3->version != 0  //
      && ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return false;
  }

  // The config has already been shed.
  if (!ssl->config) {
    return false;
  }

  switch (ssl->renegotiate_mode) {
    case ssl_renegotiate_ignore:
    case ssl_renegotiate_never:
      return false;

    case ssl_renegotiate_freely:
    case ssl_renegotiate_explicit:
      return true;
    case ssl_renegotiate_once:
      return ssl->s3->total_renegotiations == 0;
  }

  assert(0);
  return false;
}

static void ssl_maybe_shed_handshake_config(SSL *ssl) {
  if (ssl->s3->hs != nullptr ||               //
      ssl->config == nullptr ||               //
      !ssl->config->shed_handshake_config ||  //
      ssl_can_renegotiate(ssl)) {
    return;
  }

  ssl->config.reset();
}

void SSL_set_handoff_mode(SSL *ssl, bool on) {
  if (!ssl->config) {
    return;
  }
  ssl->config->handoff = on;
}

bool SSL_get_traffic_secrets(const SSL *ssl,
                             Span<const uint8_t> *out_read_traffic_secret,
                             Span<const uint8_t> *out_write_traffic_secret) {
  // This API is not well-defined for DTLS, where multiple epochs may be alive
  // at once. Callers should use |SSL_get_dtls_*_traffic_secret| instead. In
  // QUIC, the application is already handed the traffic secret.
  if (SSL_is_dtls(ssl) || SSL_is_quic(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return false;
  }

  if (!ssl->s3->initial_handshake_complete) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_HANDSHAKE_NOT_COMPLETE);
    return false;
  }

  if (SSL_version(ssl) < TLS1_3_VERSION) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_SSL_VERSION);
    return false;
  }

  *out_read_traffic_secret = ssl->s3->read_traffic_secret;
  *out_write_traffic_secret = ssl->s3->write_traffic_secret;
  return true;
}

void SSL_CTX_set_aes_hw_override_for_testing(SSL_CTX *ctx,
                                             bool override_value) {
  ctx->aes_hw_override = true;
  ctx->aes_hw_override_value = override_value;
}

void SSL_set_aes_hw_override_for_testing(SSL *ssl, bool override_value) {
  ssl->config->aes_hw_override = true;
  ssl->config->aes_hw_override_value = override_value;
}

BSSL_NAMESPACE_END

using namespace bssl;

int SSL_library_init(void) { return 1; }

int OPENSSL_init_ssl(uint64_t opts, const OPENSSL_INIT_SETTINGS *settings) {
  return 1;
}

static uint32_t ssl_session_hash(const SSL_SESSION *sess) {
  return ssl_hash_session_id(sess->session_id);
}

static int ssl_session_cmp(const SSL_SESSION *a, const SSL_SESSION *b) {
  return Span(a->session_id) == b->session_id ? 0 : 1;
}

ssl_ctx_st::ssl_ctx_st(const SSL_METHOD *ssl_method)
    : RefCounted(CheckSubClass()),
      method(ssl_method->method),
      x509_method(ssl_method->x509_method),
      retain_only_sha256_of_client_certs(false),
      quiet_shutdown(false),
      ocsp_stapling_enabled(false),
      signed_cert_timestamps_enabled(false),
      channel_id_enabled(false),
      grease_enabled(false),
      permute_extensions(false),
      allow_unknown_alpn_protos(false),
      false_start_allowed_without_alpn(false),
      handoff(false),
      enable_early_data(false),
      aes_hw_override(false),
      aes_hw_override_value(false),
      resumption_across_names_enabled(false) {
  CRYPTO_MUTEX_init(&lock);
  CRYPTO_new_ex_data(&ex_data);
}

ssl_ctx_st::~ssl_ctx_st() {
  // Free the internal session cache. Note that this calls the caller-supplied
  // remove callback, so we must do it before clearing ex_data. (See ticket
  // [openssl.org #212].)
  SSL_CTX_flush_sessions(this, 0);

  CRYPTO_free_ex_data(&g_ex_data_class_ssl_ctx, &ex_data);

  CRYPTO_MUTEX_cleanup(&lock);
  lh_SSL_SESSION_free(sessions);
  x509_method->ssl_ctx_free(this);
}

SSL_CTX *SSL_CTX_new(const SSL_METHOD *method) {
  if (method == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NULL_SSL_METHOD_PASSED);
    return nullptr;
  }

  UniquePtr<SSL_CTX> ret = MakeUnique<SSL_CTX>(method);
  if (!ret) {
    return nullptr;
  }

  ret->cert = MakeUnique<CERT>(method->x509_method);
  ret->sessions = lh_SSL_SESSION_new(ssl_session_hash, ssl_session_cmp);
  ret->client_CA.reset(sk_CRYPTO_BUFFER_new_null());
  ret->CA_names.reset(sk_CRYPTO_BUFFER_new_null());
  if (ret->cert == nullptr ||       //
      !ret->cert->is_valid() ||     //
      ret->sessions == nullptr ||   //
      ret->client_CA == nullptr ||  //
      ret->CA_names == nullptr ||   //
      !ret->x509_method->ssl_ctx_new(ret.get())) {
    return nullptr;
  }

  if (!SSL_CTX_set_strict_cipher_list(ret.get(), SSL_DEFAULT_CIPHER_LIST) ||
      // Lock the SSL_CTX to the specified version, for compatibility with
      // legacy uses of SSL_METHOD.
      !SSL_CTX_set_max_proto_version(ret.get(), method->version) ||
      !SSL_CTX_set_min_proto_version(ret.get(), method->version)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return nullptr;
  }

  if (!ret->supported_group_list.CopyFrom(DefaultSupportedGroupIds())) {
    return nullptr;
  }

  return ret.release();
}

int SSL_CTX_up_ref(SSL_CTX *ctx) {
  ctx->UpRefInternal();
  return 1;
}

void SSL_CTX_free(SSL_CTX *ctx) {
  if (ctx != nullptr) {
    ctx->DecRefInternal();
  }
}

ssl_st::ssl_st(SSL_CTX *ctx_arg)
    : method(ctx_arg->method),
      max_send_fragment(ctx_arg->max_send_fragment),
      msg_callback(ctx_arg->msg_callback),
      msg_callback_arg(ctx_arg->msg_callback_arg),
      ctx(UpRef(ctx_arg)),
      session_ctx(UpRef(ctx_arg)),
      options(ctx->options),
      mode(ctx->mode),
      max_cert_list(ctx->max_cert_list),
      server(false),
      quiet_shutdown(ctx->quiet_shutdown),
      enable_early_data(ctx->enable_early_data),
      resumption_across_names_enabled(ctx->resumption_across_names_enabled) {
  CRYPTO_new_ex_data(&ex_data);
}

ssl_st::~ssl_st() {
  CRYPTO_free_ex_data(&g_ex_data_class_ssl, &ex_data);
  // |config| refers to |this|, so we must release it earlier.
  config.reset();
  if (method != nullptr) {
    method->ssl_free(this);
  }
}

SSL *SSL_new(SSL_CTX *ctx) {
  if (ctx == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NULL_SSL_CTX);
    return nullptr;
  }

  UniquePtr<SSL> ssl = MakeUnique<SSL>(ctx);
  if (ssl == nullptr) {
    return nullptr;
  }

  ssl->config = MakeUnique<SSL_CONFIG>(ssl.get());
  if (ssl->config == nullptr) {
    return nullptr;
  }
  ssl->config->conf_min_version = ctx->conf_min_version;
  ssl->config->conf_max_version = ctx->conf_max_version;

  ssl->config->cert = ssl_cert_dup(ctx->cert.get());
  if (ssl->config->cert == nullptr) {
    return nullptr;
  }

  ssl->config->verify_mode = ctx->verify_mode;
  ssl->config->verify_callback = ctx->default_verify_callback;
  ssl->config->custom_verify_callback = ctx->custom_verify_callback;
  ssl->config->retain_only_sha256_of_client_certs =
      ctx->retain_only_sha256_of_client_certs;
  ssl->config->permute_extensions = ctx->permute_extensions;
  ssl->config->aes_hw_override = ctx->aes_hw_override;
  ssl->config->aes_hw_override_value = ctx->aes_hw_override_value;
  ssl->config->compliance_policy = ctx->compliance_policy;

  if (!ssl->config->supported_group_list.CopyFrom(ctx->supported_group_list) ||
      !ssl->config->alpn_client_proto_list.CopyFrom(
          ctx->alpn_client_proto_list) ||
      !ssl->config->verify_sigalgs.CopyFrom(ctx->verify_sigalgs)) {
    return nullptr;
  }

  if (ctx->requested_trust_anchors) {
    ssl->config->requested_trust_anchors.emplace();
    if (!ssl->config->requested_trust_anchors->CopyFrom(
            *ctx->requested_trust_anchors)) {
      return nullptr;
    }
  }

  if (ctx->psk_identity_hint) {
    ssl->config->psk_identity_hint.reset(
        OPENSSL_strdup(ctx->psk_identity_hint.get()));
    if (ssl->config->psk_identity_hint == nullptr) {
      return nullptr;
    }
  }
  ssl->config->psk_client_callback = ctx->psk_client_callback;
  ssl->config->psk_server_callback = ctx->psk_server_callback;

  ssl->config->channel_id_enabled = ctx->channel_id_enabled;
  ssl->config->channel_id_private = UpRef(ctx->channel_id_private);

  ssl->config->signed_cert_timestamps_enabled =
      ctx->signed_cert_timestamps_enabled;
  ssl->config->ocsp_stapling_enabled = ctx->ocsp_stapling_enabled;
  ssl->config->handoff = ctx->handoff;
  ssl->quic_method = ctx->quic_method;

  if (!ssl->method->ssl_new(ssl.get()) ||
      !ssl->ctx->x509_method->ssl_new(ssl->s3->hs.get())) {
    return nullptr;
  }

  return ssl.release();
}

SSL_CONFIG::SSL_CONFIG(SSL *ssl_arg)
    : ssl(ssl_arg),
      ech_grease_enabled(false),
      signed_cert_timestamps_enabled(false),
      ocsp_stapling_enabled(false),
      channel_id_enabled(false),
      enforce_rsa_key_usage(true),
      retain_only_sha256_of_client_certs(false),
      handoff(false),
      shed_handshake_config(false),
      jdk11_workaround(false),
      quic_use_legacy_codepoint(false),
      permute_extensions(false),
      alps_use_new_codepoint(true) {
  assert(ssl);
}

SSL_CONFIG::~SSL_CONFIG() {
  if (ssl->ctx != nullptr) {
    ssl->ctx->x509_method->ssl_config_free(this);
  }
}

void SSL_free(SSL *ssl) { Delete(ssl); }

void SSL_set_connect_state(SSL *ssl) {
  ssl->server = false;
  ssl->do_handshake = ssl_client_handshake;
}

void SSL_set_accept_state(SSL *ssl) {
  ssl->server = true;
  ssl->do_handshake = ssl_server_handshake;
}

void SSL_set0_rbio(SSL *ssl, BIO *rbio) { ssl->rbio.reset(rbio); }

void SSL_set0_wbio(SSL *ssl, BIO *wbio) { ssl->wbio.reset(wbio); }

void SSL_set_bio(SSL *ssl, BIO *rbio, BIO *wbio) {
  // For historical reasons, this function has many different cases in ownership
  // handling.

  // If nothing has changed, do nothing
  if (rbio == SSL_get_rbio(ssl) && wbio == SSL_get_wbio(ssl)) {
    return;
  }

  // If the two arguments are equal, one fewer reference is granted than
  // taken.
  if (rbio != nullptr && rbio == wbio) {
    BIO_up_ref(rbio);
  }

  // If only the wbio is changed, adopt only one reference.
  if (rbio == SSL_get_rbio(ssl)) {
    SSL_set0_wbio(ssl, wbio);
    return;
  }

  // There is an asymmetry here for historical reasons. If only the rbio is
  // changed AND the rbio and wbio were originally different, then we only adopt
  // one reference.
  if (wbio == SSL_get_wbio(ssl) && SSL_get_rbio(ssl) != SSL_get_wbio(ssl)) {
    SSL_set0_rbio(ssl, rbio);
    return;
  }

  // Otherwise, adopt both references.
  SSL_set0_rbio(ssl, rbio);
  SSL_set0_wbio(ssl, wbio);
}

BIO *SSL_get_rbio(const SSL *ssl) { return ssl->rbio.get(); }

BIO *SSL_get_wbio(const SSL *ssl) { return ssl->wbio.get(); }

size_t SSL_quic_max_handshake_flight_len(const SSL *ssl,
                                         enum ssl_encryption_level_t level) {
  // Limits flights to 16K by default when there are no large
  // (certificate-carrying) messages.
  static const size_t kDefaultLimit = 16384;

  switch (level) {
    case ssl_encryption_initial:
      return kDefaultLimit;
    case ssl_encryption_early_data:
      // QUIC does not send EndOfEarlyData.
      return 0;
    case ssl_encryption_handshake:
      if (ssl->server) {
        // Servers may receive Certificate message if configured to request
        // client certificates.
        if (!!(ssl->config->verify_mode & SSL_VERIFY_PEER) &&
            ssl->max_cert_list > kDefaultLimit) {
          return ssl->max_cert_list;
        }
      } else {
        // Clients may receive both Certificate message and a CertificateRequest
        // message.
        if (2 * ssl->max_cert_list > kDefaultLimit) {
          return 2 * ssl->max_cert_list;
        }
      }
      return kDefaultLimit;
    case ssl_encryption_application:
      // Note there is not actually a bound on the number of NewSessionTickets
      // one may send in a row. This level may need more involved flow
      // control. See https://github.com/quicwg/base-drafts/issues/1834.
      return kDefaultLimit;
  }

  return 0;
}

enum ssl_encryption_level_t SSL_quic_read_level(const SSL *ssl) {
  assert(SSL_is_quic(ssl));
  return ssl->s3->quic_read_level;
}

enum ssl_encryption_level_t SSL_quic_write_level(const SSL *ssl) {
  assert(SSL_is_quic(ssl));
  return ssl->s3->quic_write_level;
}

int SSL_provide_quic_data(SSL *ssl, enum ssl_encryption_level_t level,
                          const uint8_t *data, size_t len) {
  if (!SSL_is_quic(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  if (level != ssl->s3->quic_read_level) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_ENCRYPTION_LEVEL_RECEIVED);
    return 0;
  }

  size_t new_len = (ssl->s3->hs_buf ? ssl->s3->hs_buf->length : 0) + len;
  if (new_len < len ||
      new_len > SSL_quic_max_handshake_flight_len(ssl, level)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_EXCESSIVE_MESSAGE_SIZE);
    return 0;
  }

  return tls_append_handshake_data(ssl, Span(data, len));
}

int SSL_do_handshake(SSL *ssl) {
  ssl_reset_error_state(ssl);

  if (ssl->do_handshake == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CONNECTION_TYPE_NOT_SET);
    return -1;
  }

  if (!SSL_in_init(ssl)) {
    return 1;
  }

  // Run the handshake.
  SSL_HANDSHAKE *hs = ssl->s3->hs.get();

  bool early_return = false;
  int ret = ssl_run_handshake(hs, &early_return);
  ssl_do_info_callback(
      ssl, ssl->server ? SSL_CB_ACCEPT_EXIT : SSL_CB_CONNECT_EXIT, ret);
  if (ret <= 0) {
    return ret;
  }

  // Destroy the handshake object if the handshake has completely finished.
  if (!early_return) {
    ssl->s3->hs.reset();
    ssl_maybe_shed_handshake_config(ssl);
  }

  return 1;
}

int SSL_connect(SSL *ssl) {
  if (ssl->do_handshake == nullptr) {
    // Not properly initialized yet
    SSL_set_connect_state(ssl);
  }

  return SSL_do_handshake(ssl);
}

int SSL_accept(SSL *ssl) {
  if (ssl->do_handshake == nullptr) {
    // Not properly initialized yet
    SSL_set_accept_state(ssl);
  }

  return SSL_do_handshake(ssl);
}

static int ssl_do_post_handshake(SSL *ssl, const SSLMessage &msg) {
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return tls13_post_handshake(ssl, msg);
  }

  // Check for renegotiation on the server before parsing to use the correct
  // error. Renegotiation is triggered by a different message for servers.
  if (ssl->server) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_RENEGOTIATION);
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_NO_RENEGOTIATION);
    return 0;
  }

  if (msg.type != SSL3_MT_HELLO_REQUEST || CBS_len(&msg.body) != 0) {
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_DECODE_ERROR);
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_HELLO_REQUEST);
    return 0;
  }

  if (ssl->renegotiate_mode == ssl_renegotiate_ignore) {
    return 1;  // Ignore the HelloRequest.
  }

  ssl->s3->renegotiate_pending = true;
  if (ssl->renegotiate_mode == ssl_renegotiate_explicit) {
    return 1;  // Handle it later.
  }

  if (!SSL_renegotiate(ssl)) {
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_NO_RENEGOTIATION);
    return 0;
  }

  return 1;
}

int SSL_process_quic_post_handshake(SSL *ssl) {
  ssl_reset_error_state(ssl);

  if (!SSL_is_quic(ssl) || SSL_in_init(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  // Replay post-handshake message errors.
  if (!check_read_error(ssl)) {
    return 0;
  }

  // Process any buffered post-handshake messages.
  SSLMessage msg;
  while (ssl->method->get_message(ssl, &msg)) {
    // Handle the post-handshake message and try again.
    if (!ssl_do_post_handshake(ssl, msg)) {
      ssl_set_read_error(ssl);
      return 0;
    }
    ssl->method->next_message(ssl);
  }

  return 1;
}

static int ssl_read_impl(SSL *ssl) {
  ssl_reset_error_state(ssl);

  if (ssl->do_handshake == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNINITIALIZED);
    return -1;
  }

  // Replay post-handshake message errors.
  if (!check_read_error(ssl)) {
    return -1;
  }

  while (ssl->s3->pending_app_data.empty()) {
    if (ssl->s3->renegotiate_pending) {
      ssl->s3->rwstate = SSL_ERROR_WANT_RENEGOTIATE;
      return -1;
    }

    // If a read triggered a DTLS ACK or retransmit, resolve that before reading
    // more.
    if (SSL_is_dtls(ssl)) {
      int ret = ssl->method->flush(ssl);
      if (ret <= 0) {
        return ret;
      }
    }

    // Complete the current handshake, if any. False Start will cause
    // |SSL_do_handshake| to return mid-handshake, so this may require multiple
    // iterations.
    while (!ssl_can_read(ssl)) {
      int ret = SSL_do_handshake(ssl);
      if (ret < 0) {
        return ret;
      }
      if (ret == 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_SSL_HANDSHAKE_FAILURE);
        return -1;
      }
    }

    // Process any buffered post-handshake messages.
    SSLMessage msg;
    if (ssl->method->get_message(ssl, &msg)) {
      // If we received an interrupt in early read (EndOfEarlyData), loop again
      // for the handshake to process it.
      if (SSL_in_init(ssl)) {
        ssl->s3->hs->can_early_read = false;
        continue;
      }

      // Handle the post-handshake message and try again.
      if (!ssl_do_post_handshake(ssl, msg)) {
        ssl_set_read_error(ssl);
        return -1;
      }
      ssl->method->next_message(ssl);
      continue;  // Loop again. We may have begun a new handshake.
    }

    uint8_t alert = SSL_AD_DECODE_ERROR;
    size_t consumed = 0;
    auto ret = ssl_open_app_data(ssl, &ssl->s3->pending_app_data, &consumed,
                                 &alert, ssl->s3->read_buffer.span());
    bool retry;
    int bio_ret = ssl_handle_open_record(ssl, &retry, ret, consumed, alert);
    if (bio_ret <= 0) {
      return bio_ret;
    }
    if (!retry) {
      assert(!ssl->s3->pending_app_data.empty());
      ssl->s3->key_update_count = 0;
    }
  }

  return 1;
}

int SSL_read(SSL *ssl, void *buf, int num) {
  int ret = SSL_peek(ssl, buf, num);
  if (ret <= 0) {
    return ret;
  }
  // TODO(davidben): In DTLS, should the rest of the record be discarded?  DTLS
  // is not a stream. See https://crbug.com/boringssl/65.
  ssl->s3->pending_app_data =
      ssl->s3->pending_app_data.subspan(static_cast<size_t>(ret));
  if (ssl->s3->pending_app_data.empty()) {
    ssl->s3->read_buffer.DiscardConsumed();
  }
  return ret;
}

int SSL_peek(SSL *ssl, void *buf, int num) {
  if (SSL_is_quic(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return -1;
  }

  int ret = ssl_read_impl(ssl);
  if (ret <= 0) {
    return ret;
  }
  if (num <= 0) {
    return num;
  }
  size_t todo =
      std::min(ssl->s3->pending_app_data.size(), static_cast<size_t>(num));
  OPENSSL_memcpy(buf, ssl->s3->pending_app_data.data(), todo);
  return static_cast<int>(todo);
}

int SSL_write(SSL *ssl, const void *buf, int num) {
  ssl_reset_error_state(ssl);

  if (SSL_is_quic(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return -1;
  }

  if (ssl->do_handshake == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNINITIALIZED);
    return -1;
  }

  int ret = 0;
  size_t bytes_written = 0;
  bool needs_handshake = false;
  do {
    // If necessary, complete the handshake implicitly.
    if (!ssl_can_write(ssl)) {
      ret = SSL_do_handshake(ssl);
      if (ret < 0) {
        return ret;
      }
      if (ret == 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_SSL_HANDSHAKE_FAILURE);
        return -1;
      }
    }

    if (num < 0) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_LENGTH);
      return -1;
    }
    ret = ssl->method->write_app_data(
        ssl, &needs_handshake, &bytes_written,
        Span(static_cast<const uint8_t *>(buf), static_cast<size_t>(num)));
  } while (needs_handshake);
  return ret <= 0 ? ret : static_cast<int>(bytes_written);
}

int SSL_key_update(SSL *ssl, int request_type) {
  ssl_reset_error_state(ssl);

  if (ssl->do_handshake == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNINITIALIZED);
    return 0;
  }

  if (SSL_is_quic(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  if (!ssl->s3->initial_handshake_complete) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_HANDSHAKE_NOT_COMPLETE);
    return 0;
  }

  if (ssl_protocol_version(ssl) < TLS1_3_VERSION) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_SSL_VERSION);
    return 0;
  }

  return tls13_add_key_update(ssl, request_type);
}

int SSL_shutdown(SSL *ssl) {
  ssl_reset_error_state(ssl);

  if (ssl->do_handshake == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNINITIALIZED);
    return -1;
  }

  // If we are in the middle of a handshake, silently succeed. Consumers often
  // call this function before |SSL_free|, whether the handshake succeeded or
  // not. We assume the caller has already handled failed handshakes.
  if (SSL_in_init(ssl)) {
    return 1;
  }

  if (ssl->quiet_shutdown) {
    // Do nothing if configured not to send a close_notify.
    ssl->s3->write_shutdown = ssl_shutdown_close_notify;
    ssl->s3->read_shutdown = ssl_shutdown_close_notify;
    return 1;
  }

  // This function completes in two stages. It sends a close_notify and then it
  // waits for a close_notify to come in. Perform exactly one action and return
  // whether or not it succeeds.

  if (ssl->s3->write_shutdown != ssl_shutdown_close_notify) {
    // Send a close_notify.
    if (ssl_send_alert_impl(ssl, SSL3_AL_WARNING, SSL_AD_CLOSE_NOTIFY) <= 0) {
      return -1;
    }
  } else if (ssl->s3->alert_dispatch) {
    // Finish sending the close_notify.
    if (ssl->method->dispatch_alert(ssl) <= 0) {
      return -1;
    }
  } else if (ssl->s3->read_shutdown != ssl_shutdown_close_notify) {
    if (SSL_is_dtls(ssl)) {
      // Bidirectional shutdown doesn't make sense for an unordered
      // transport. DTLS alerts also aren't delivered reliably, so we may even
      // time out because the peer never received our close_notify. Report to
      // the caller that the channel has fully shut down.
      if (ssl->s3->read_shutdown == ssl_shutdown_error) {
        ERR_restore_state(ssl->s3->read_error.get());
        return -1;
      }
      ssl->s3->read_shutdown = ssl_shutdown_close_notify;
    } else {
      // Process records until an error, close_notify, or application data.
      if (ssl_read_impl(ssl) > 0) {
        // We received some unexpected application data.
        OPENSSL_PUT_ERROR(SSL, SSL_R_APPLICATION_DATA_ON_SHUTDOWN);
        return -1;
      }
      if (ssl->s3->read_shutdown != ssl_shutdown_close_notify) {
        return -1;
      }
    }
  }

  // Return 0 for unidirectional shutdown and 1 for bidirectional shutdown.
  return ssl->s3->read_shutdown == ssl_shutdown_close_notify;
}

int SSL_send_fatal_alert(SSL *ssl, uint8_t alert) {
  if (ssl->s3->alert_dispatch) {
    if (ssl->s3->send_alert[0] != SSL3_AL_FATAL ||
        ssl->s3->send_alert[1] != alert) {
      // We are already attempting to write a different alert.
      OPENSSL_PUT_ERROR(SSL, SSL_R_PROTOCOL_IS_SHUTDOWN);
      return -1;
    }
    return ssl->method->dispatch_alert(ssl);
  }

  return ssl_send_alert_impl(ssl, SSL3_AL_FATAL, alert);
}

int SSL_set_quic_transport_params(SSL *ssl, const uint8_t *params,
                                  size_t params_len) {
  return ssl->config &&
         ssl->config->quic_transport_params.CopyFrom(Span(params, params_len));
}

void SSL_get_peer_quic_transport_params(const SSL *ssl,
                                        const uint8_t **out_params,
                                        size_t *out_params_len) {
  *out_params = ssl->s3->peer_quic_transport_params.data();
  *out_params_len = ssl->s3->peer_quic_transport_params.size();
}

int SSL_set_quic_early_data_context(SSL *ssl, const uint8_t *context,
                                    size_t context_len) {
  return ssl->config && ssl->config->quic_early_data_context.CopyFrom(
                            Span(context, context_len));
}

void SSL_CTX_set_early_data_enabled(SSL_CTX *ctx, int enabled) {
  ctx->enable_early_data = !!enabled;
}

void SSL_set_early_data_enabled(SSL *ssl, int enabled) {
  ssl->enable_early_data = !!enabled;
}

int SSL_in_early_data(const SSL *ssl) {
  if (ssl->s3->hs == nullptr) {
    return 0;
  }
  return ssl->s3->hs->in_early_data;
}

int SSL_early_data_accepted(const SSL *ssl) {
  return ssl->s3->early_data_accepted;
}

void SSL_reset_early_data_reject(SSL *ssl) {
  SSL_HANDSHAKE *hs = ssl->s3->hs.get();
  if (hs == nullptr ||  //
      hs->wait != ssl_hs_early_data_rejected) {
    abort();
  }

  hs->wait = ssl_hs_ok;
  hs->in_early_data = false;
  hs->early_session.reset();

  // Discard any unfinished writes from the perspective of |SSL_write|'s
  // retry. The handshake will transparently flush out the pending record
  // (discarded by the server) to keep the framing correct.
  ssl->s3->pending_write = {};
}

enum ssl_early_data_reason_t SSL_get_early_data_reason(const SSL *ssl) {
  return ssl->s3->early_data_reason;
}

const char *SSL_early_data_reason_string(enum ssl_early_data_reason_t reason) {
  switch (reason) {
    case ssl_early_data_unknown:
      return "unknown";
    case ssl_early_data_disabled:
      return "disabled";
    case ssl_early_data_accepted:
      return "accepted";
    case ssl_early_data_protocol_version:
      return "protocol_version";
    case ssl_early_data_peer_declined:
      return "peer_declined";
    case ssl_early_data_no_session_offered:
      return "no_session_offered";
    case ssl_early_data_session_not_resumed:
      return "session_not_resumed";
    case ssl_early_data_unsupported_for_session:
      return "unsupported_for_session";
    case ssl_early_data_hello_retry_request:
      return "hello_retry_request";
    case ssl_early_data_alpn_mismatch:
      return "alpn_mismatch";
    case ssl_early_data_channel_id:
      return "channel_id";
    case ssl_early_data_ticket_age_skew:
      return "ticket_age_skew";
    case ssl_early_data_quic_parameter_mismatch:
      return "quic_parameter_mismatch";
    case ssl_early_data_alps_mismatch:
      return "alps_mismatch";
  }

  return nullptr;
}

static int bio_retry_reason_to_error(int reason) {
  switch (reason) {
    case BIO_RR_CONNECT:
      return SSL_ERROR_WANT_CONNECT;
    case BIO_RR_ACCEPT:
      return SSL_ERROR_WANT_ACCEPT;
    default:
      return SSL_ERROR_SYSCALL;
  }
}

int SSL_get_error(const SSL *ssl, int ret_code) {
  if (ret_code > 0) {
    return SSL_ERROR_NONE;
  }

  // Make things return SSL_ERROR_SYSCALL when doing SSL_do_handshake etc,
  // where we do encode the error
  uint32_t err = ERR_peek_error();
  if (err != 0) {
    if (ERR_GET_LIB(err) == ERR_LIB_SYS) {
      return SSL_ERROR_SYSCALL;
    }
    return SSL_ERROR_SSL;
  }

  if (ret_code == 0) {
    if (ssl->s3->rwstate == SSL_ERROR_ZERO_RETURN) {
      return SSL_ERROR_ZERO_RETURN;
    }
    // An EOF was observed which violates the protocol, and the underlying
    // transport does not participate in the error queue. Bubble up to the
    // caller.
    return SSL_ERROR_SYSCALL;
  }

  switch (ssl->s3->rwstate) {
    case SSL_ERROR_PENDING_SESSION:
    case SSL_ERROR_PENDING_CERTIFICATE:
    case SSL_ERROR_HANDOFF:
    case SSL_ERROR_HANDBACK:
    case SSL_ERROR_WANT_X509_LOOKUP:
    case SSL_ERROR_WANT_PRIVATE_KEY_OPERATION:
    case SSL_ERROR_PENDING_TICKET:
    case SSL_ERROR_EARLY_DATA_REJECTED:
    case SSL_ERROR_WANT_CERTIFICATE_VERIFY:
    case SSL_ERROR_WANT_RENEGOTIATE:
    case SSL_ERROR_HANDSHAKE_HINTS_READY:
      return ssl->s3->rwstate;

    case SSL_ERROR_WANT_READ: {
      if (SSL_is_quic(ssl)) {
        return SSL_ERROR_WANT_READ;
      }
      BIO *bio = SSL_get_rbio(ssl);
      if (BIO_should_read(bio)) {
        return SSL_ERROR_WANT_READ;
      }

      if (BIO_should_write(bio)) {
        // TODO(davidben): OpenSSL historically checked for writes on the read
        // BIO. Can this be removed?
        return SSL_ERROR_WANT_WRITE;
      }

      if (BIO_should_io_special(bio)) {
        return bio_retry_reason_to_error(BIO_get_retry_reason(bio));
      }

      break;
    }

    case SSL_ERROR_WANT_WRITE: {
      BIO *bio = SSL_get_wbio(ssl);
      if (BIO_should_write(bio)) {
        return SSL_ERROR_WANT_WRITE;
      }

      if (BIO_should_read(bio)) {
        // TODO(davidben): OpenSSL historically checked for reads on the write
        // BIO. Can this be removed?
        return SSL_ERROR_WANT_READ;
      }

      if (BIO_should_io_special(bio)) {
        return bio_retry_reason_to_error(BIO_get_retry_reason(bio));
      }

      break;
    }
  }

  return SSL_ERROR_SYSCALL;
}

const char *SSL_error_description(int err) {
  switch (err) {
    case SSL_ERROR_NONE:
      return "NONE";
    case SSL_ERROR_SSL:
      return "SSL";
    case SSL_ERROR_WANT_READ:
      return "WANT_READ";
    case SSL_ERROR_WANT_WRITE:
      return "WANT_WRITE";
    case SSL_ERROR_WANT_X509_LOOKUP:
      return "WANT_X509_LOOKUP";
    case SSL_ERROR_SYSCALL:
      return "SYSCALL";
    case SSL_ERROR_ZERO_RETURN:
      return "ZERO_RETURN";
    case SSL_ERROR_WANT_CONNECT:
      return "WANT_CONNECT";
    case SSL_ERROR_WANT_ACCEPT:
      return "WANT_ACCEPT";
    case SSL_ERROR_PENDING_SESSION:
      return "PENDING_SESSION";
    case SSL_ERROR_PENDING_CERTIFICATE:
      return "PENDING_CERTIFICATE";
    case SSL_ERROR_WANT_PRIVATE_KEY_OPERATION:
      return "WANT_PRIVATE_KEY_OPERATION";
    case SSL_ERROR_PENDING_TICKET:
      return "PENDING_TICKET";
    case SSL_ERROR_EARLY_DATA_REJECTED:
      return "EARLY_DATA_REJECTED";
    case SSL_ERROR_WANT_CERTIFICATE_VERIFY:
      return "WANT_CERTIFICATE_VERIFY";
    case SSL_ERROR_HANDOFF:
      return "HANDOFF";
    case SSL_ERROR_HANDBACK:
      return "HANDBACK";
    case SSL_ERROR_WANT_RENEGOTIATE:
      return "WANT_RENEGOTIATE";
    case SSL_ERROR_HANDSHAKE_HINTS_READY:
      return "HANDSHAKE_HINTS_READY";
    default:
      return nullptr;
  }
}

uint32_t SSL_CTX_set_options(SSL_CTX *ctx, uint32_t options) {
  ctx->options |= options;
  return ctx->options;
}

uint32_t SSL_CTX_clear_options(SSL_CTX *ctx, uint32_t options) {
  ctx->options &= ~options;
  return ctx->options;
}

uint32_t SSL_CTX_get_options(const SSL_CTX *ctx) { return ctx->options; }

uint32_t SSL_set_options(SSL *ssl, uint32_t options) {
  ssl->options |= options;
  return ssl->options;
}

uint32_t SSL_clear_options(SSL *ssl, uint32_t options) {
  ssl->options &= ~options;
  return ssl->options;
}

uint32_t SSL_get_options(const SSL *ssl) { return ssl->options; }

uint32_t SSL_CTX_set_mode(SSL_CTX *ctx, uint32_t mode) {
  ctx->mode |= mode;
  return ctx->mode;
}

uint32_t SSL_CTX_clear_mode(SSL_CTX *ctx, uint32_t mode) {
  ctx->mode &= ~mode;
  return ctx->mode;
}

uint32_t SSL_CTX_get_mode(const SSL_CTX *ctx) { return ctx->mode; }

uint32_t SSL_set_mode(SSL *ssl, uint32_t mode) {
  ssl->mode |= mode;
  return ssl->mode;
}

uint32_t SSL_clear_mode(SSL *ssl, uint32_t mode) {
  ssl->mode &= ~mode;
  return ssl->mode;
}

uint32_t SSL_get_mode(const SSL *ssl) { return ssl->mode; }

void SSL_CTX_set0_buffer_pool(SSL_CTX *ctx, CRYPTO_BUFFER_POOL *pool) {
  ctx->pool = pool;
}

int SSL_get_tls_unique(const SSL *ssl, uint8_t *out, size_t *out_len,
                       size_t max_out) {
  *out_len = 0;
  OPENSSL_memset(out, 0, max_out);

  // tls-unique is not defined for TLS 1.3.
  if (!ssl->s3->initial_handshake_complete ||
      ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return 0;
  }

  // The tls-unique value is the first Finished message in the handshake, which
  // is the client's in a full handshake and the server's for a resumption. See
  // https://tools.ietf.org/html/rfc5929#section-3.1.
  Span<const uint8_t> finished = ssl->s3->previous_client_finished;
  if (ssl->session != nullptr) {
    // tls-unique is broken for resumed sessions unless EMS is used.
    if (!ssl->session->extended_master_secret) {
      return 0;
    }
    finished = ssl->s3->previous_server_finished;
  }

  *out_len = finished.size();
  if (finished.size() > max_out) {
    *out_len = max_out;
  }

  OPENSSL_memcpy(out, finished.data(), *out_len);
  return 1;
}

static int set_session_id_context(CERT *cert, const uint8_t *sid_ctx,
                                  size_t sid_ctx_len) {
  if (!cert->sid_ctx.TryCopyFrom(Span(sid_ctx, sid_ctx_len))) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_SSL_SESSION_ID_CONTEXT_TOO_LONG);
    return 0;
  }

  return 1;
}

int SSL_CTX_set_session_id_context(SSL_CTX *ctx, const uint8_t *sid_ctx,
                                   size_t sid_ctx_len) {
  return set_session_id_context(ctx->cert.get(), sid_ctx, sid_ctx_len);
}

int SSL_set_session_id_context(SSL *ssl, const uint8_t *sid_ctx,
                               size_t sid_ctx_len) {
  if (!ssl->config) {
    return 0;
  }
  return set_session_id_context(ssl->config->cert.get(), sid_ctx, sid_ctx_len);
}

const uint8_t *SSL_get0_session_id_context(const SSL *ssl, size_t *out_len) {
  if (!ssl->config) {
    assert(ssl->config);
    *out_len = 0;
    return nullptr;
  }
  *out_len = ssl->config->cert->sid_ctx.size();
  return ssl->config->cert->sid_ctx.data();
}

int SSL_get_fd(const SSL *ssl) { return SSL_get_rfd(ssl); }

int SSL_get_rfd(const SSL *ssl) {
  int ret = -1;
  BIO *b = BIO_find_type(SSL_get_rbio(ssl), BIO_TYPE_DESCRIPTOR);
  if (b != nullptr) {
    BIO_get_fd(b, &ret);
  }
  return ret;
}

int SSL_get_wfd(const SSL *ssl) {
  int ret = -1;
  BIO *b = BIO_find_type(SSL_get_wbio(ssl), BIO_TYPE_DESCRIPTOR);
  if (b != nullptr) {
    BIO_get_fd(b, &ret);
  }
  return ret;
}

#if !defined(OPENSSL_NO_SOCK)
int SSL_set_fd(SSL *ssl, int fd) {
  BIO *bio = BIO_new(BIO_s_socket());
  if (bio == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }
  BIO_set_fd(bio, fd, BIO_NOCLOSE);
  SSL_set_bio(ssl, bio, bio);
  return 1;
}

int SSL_set_wfd(SSL *ssl, int fd) {
  BIO *rbio = SSL_get_rbio(ssl);
  if (rbio == nullptr || BIO_method_type(rbio) != BIO_TYPE_SOCKET ||
      BIO_get_fd(rbio, nullptr) != fd) {
    BIO *bio = BIO_new(BIO_s_socket());
    if (bio == nullptr) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
      return 0;
    }
    BIO_set_fd(bio, fd, BIO_NOCLOSE);
    SSL_set0_wbio(ssl, bio);
  } else {
    // Copy the rbio over to the wbio.
    BIO_up_ref(rbio);
    SSL_set0_wbio(ssl, rbio);
  }

  return 1;
}

int SSL_set_rfd(SSL *ssl, int fd) {
  BIO *wbio = SSL_get_wbio(ssl);
  if (wbio == nullptr || BIO_method_type(wbio) != BIO_TYPE_SOCKET ||
      BIO_get_fd(wbio, nullptr) != fd) {
    BIO *bio = BIO_new(BIO_s_socket());
    if (bio == nullptr) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
      return 0;
    }
    BIO_set_fd(bio, fd, BIO_NOCLOSE);
    SSL_set0_rbio(ssl, bio);
  } else {
    // Copy the wbio over to the rbio.
    BIO_up_ref(wbio);
    SSL_set0_rbio(ssl, wbio);
  }
  return 1;
}
#endif  // !OPENSSL_NO_SOCK

static size_t copy_finished(void *out, size_t out_len, Span<const uint8_t> in) {
  if (out_len > in.size()) {
    out_len = in.size();
  }
  OPENSSL_memcpy(out, in.data(), out_len);
  return in.size();
}

size_t SSL_get_finished(const SSL *ssl, void *buf, size_t count) {
  if (!ssl->s3->initial_handshake_complete ||
      ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return 0;
  }

  if (ssl->server) {
    return copy_finished(buf, count, ssl->s3->previous_server_finished);
  }

  return copy_finished(buf, count, ssl->s3->previous_client_finished);
}

size_t SSL_get_peer_finished(const SSL *ssl, void *buf, size_t count) {
  if (!ssl->s3->initial_handshake_complete ||
      ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return 0;
  }

  if (ssl->server) {
    return copy_finished(buf, count, ssl->s3->previous_client_finished);
  }

  return copy_finished(buf, count, ssl->s3->previous_server_finished);
}

int SSL_get_verify_mode(const SSL *ssl) {
  if (!ssl->config) {
    assert(ssl->config);
    return -1;
  }
  return ssl->config->verify_mode;
}

int SSL_get_extms_support(const SSL *ssl) {
  // TLS 1.3 does not require extended master secret and always reports as
  // supporting it.
  if (ssl->s3->version == 0) {
    return 0;
  }
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return 1;
  }

  // If the initial handshake completed, query the established session.
  if (ssl->s3->established_session != nullptr) {
    return ssl->s3->established_session->extended_master_secret;
  }

  // Otherwise, query the in-progress handshake.
  if (ssl->s3->hs != nullptr) {
    return ssl->s3->hs->extended_master_secret;
  }
  assert(0);
  return 0;
}

int SSL_CTX_get_read_ahead(const SSL_CTX *ctx) { return 0; }

int SSL_get_read_ahead(const SSL *ssl) { return 0; }

int SSL_CTX_set_read_ahead(SSL_CTX *ctx, int yes) { return 1; }

int SSL_set_read_ahead(SSL *ssl, int yes) { return 1; }

int SSL_pending(const SSL *ssl) {
  return static_cast<int>(ssl->s3->pending_app_data.size());
}

int SSL_has_pending(const SSL *ssl) {
  return SSL_pending(ssl) != 0 || !ssl->s3->read_buffer.empty();
}

static bool has_cert_and_key(const SSL_CREDENTIAL *cred) {
  // TODO(davidben): If |cred->key_method| is set, that should be fine too.
  if (cred->privkey == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_PRIVATE_KEY_ASSIGNED);
    return false;
  }

  if (cred->chain == nullptr ||
      sk_CRYPTO_BUFFER_value(cred->chain.get(), 0) == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_CERTIFICATE_ASSIGNED);
    return false;
  }

  return true;
}

int SSL_CTX_check_private_key(const SSL_CTX *ctx) {
  // There is no need to actually check consistency because inconsistent values
  // can never be configured.
  return has_cert_and_key(ctx->cert->legacy_credential.get());
}

int SSL_check_private_key(const SSL *ssl) {
  if (!ssl->config) {
    return 0;
  }

  // There is no need to actually check consistency because inconsistent values
  // can never be configured.
  return has_cert_and_key(ssl->config->cert->legacy_credential.get());
}

long SSL_get_default_timeout(const SSL *ssl) {
  return SSL_DEFAULT_SESSION_TIMEOUT;
}

int SSL_renegotiate(SSL *ssl) {
  // Caller-initiated renegotiation is not supported.
  if (!ssl->s3->renegotiate_pending) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  if (!ssl_can_renegotiate(ssl)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_RENEGOTIATION);
    return 0;
  }

  // We should not have told the caller to release the private key.
  assert(!SSL_can_release_private_key(ssl));

  // Renegotiation is only supported at quiescent points in the application
  // protocol, namely in HTTPS, just before reading the HTTP response.
  // Require the record-layer be idle and avoid complexities of sending a
  // handshake record while an application_data record is being written.
  if (!ssl->s3->write_buffer.empty() ||
      ssl->s3->write_shutdown != ssl_shutdown_none) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_RENEGOTIATION);
    return 0;
  }

  // Begin a new handshake.
  if (ssl->s3->hs != nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return 0;
  }
  ssl->s3->hs = ssl_handshake_new(ssl);
  if (ssl->s3->hs == nullptr) {
    return 0;
  }

  ssl->s3->renegotiate_pending = false;
  ssl->s3->total_renegotiations++;
  return 1;
}

int SSL_renegotiate_pending(SSL *ssl) {
  return SSL_in_init(ssl) && ssl->s3->initial_handshake_complete;
}

int SSL_total_renegotiations(const SSL *ssl) {
  return ssl->s3->total_renegotiations;
}

size_t SSL_CTX_get_max_cert_list(const SSL_CTX *ctx) {
  return ctx->max_cert_list;
}

void SSL_CTX_set_max_cert_list(SSL_CTX *ctx, size_t max_cert_list) {
  if (max_cert_list > kMaxHandshakeSize) {
    max_cert_list = kMaxHandshakeSize;
  }
  ctx->max_cert_list = (uint32_t)max_cert_list;
}

size_t SSL_get_max_cert_list(const SSL *ssl) { return ssl->max_cert_list; }

void SSL_set_max_cert_list(SSL *ssl, size_t max_cert_list) {
  if (max_cert_list > kMaxHandshakeSize) {
    max_cert_list = kMaxHandshakeSize;
  }
  ssl->max_cert_list = (uint32_t)max_cert_list;
}

int SSL_CTX_set_max_send_fragment(SSL_CTX *ctx, size_t max_send_fragment) {
  if (max_send_fragment < 512) {
    max_send_fragment = 512;
  }
  if (max_send_fragment > SSL3_RT_MAX_PLAIN_LENGTH) {
    max_send_fragment = SSL3_RT_MAX_PLAIN_LENGTH;
  }
  ctx->max_send_fragment = (uint16_t)max_send_fragment;

  return 1;
}

int SSL_set_max_send_fragment(SSL *ssl, size_t max_send_fragment) {
  if (max_send_fragment < 512) {
    max_send_fragment = 512;
  }
  if (max_send_fragment > SSL3_RT_MAX_PLAIN_LENGTH) {
    max_send_fragment = SSL3_RT_MAX_PLAIN_LENGTH;
  }
  ssl->max_send_fragment = (uint16_t)max_send_fragment;

  return 1;
}

int SSL_set_mtu(SSL *ssl, unsigned mtu) {
  if (!SSL_is_dtls(ssl) || mtu < dtls1_min_mtu()) {
    return 0;
  }
  ssl->d1->mtu = mtu;
  return 1;
}

int SSL_get_secure_renegotiation_support(const SSL *ssl) {
  if (ssl->s3->version == 0) {
    return 0;
  }
  return ssl_protocol_version(ssl) >= TLS1_3_VERSION ||
         ssl->s3->send_connection_binding;
}

size_t SSL_CTX_sess_number(const SSL_CTX *ctx) {
  MutexReadLock lock(const_cast<CRYPTO_MUTEX *>(&ctx->lock));
  return lh_SSL_SESSION_num_items(ctx->sessions);
}

unsigned long SSL_CTX_sess_set_cache_size(SSL_CTX *ctx, unsigned long size) {
  unsigned long ret = ctx->session_cache_size;
  ctx->session_cache_size = size;
  return ret;
}

unsigned long SSL_CTX_sess_get_cache_size(const SSL_CTX *ctx) {
  return ctx->session_cache_size;
}

int SSL_CTX_set_session_cache_mode(SSL_CTX *ctx, int mode) {
  int ret = ctx->session_cache_mode;
  ctx->session_cache_mode = mode;
  return ret;
}

int SSL_CTX_get_session_cache_mode(const SSL_CTX *ctx) {
  return ctx->session_cache_mode;
}


int SSL_CTX_get_tlsext_ticket_keys(SSL_CTX *ctx, void *out, size_t len) {
  if (out == nullptr) {
    return 48;
  }
  if (len != 48) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_TICKET_KEYS_LENGTH);
    return 0;
  }

  // The default ticket keys are initialized lazily. Trigger a key
  // rotation to initialize them.
  if (!ssl_ctx_rotate_ticket_encryption_key(ctx)) {
    return 0;
  }

  uint8_t *out_bytes = reinterpret_cast<uint8_t *>(out);
  MutexReadLock lock(&ctx->lock);
  OPENSSL_memcpy(out_bytes, ctx->ticket_key_current->name, 16);
  OPENSSL_memcpy(out_bytes + 16, ctx->ticket_key_current->hmac_key, 16);
  OPENSSL_memcpy(out_bytes + 32, ctx->ticket_key_current->aes_key, 16);
  return 1;
}

int SSL_CTX_set_tlsext_ticket_keys(SSL_CTX *ctx, const void *in, size_t len) {
  if (in == nullptr) {
    return 48;
  }
  if (len != 48) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_TICKET_KEYS_LENGTH);
    return 0;
  }
  auto key = MakeUnique<TicketKey>();
  if (!key) {
    return 0;
  }
  const uint8_t *in_bytes = reinterpret_cast<const uint8_t *>(in);
  OPENSSL_memcpy(key->name, in_bytes, 16);
  OPENSSL_memcpy(key->hmac_key, in_bytes + 16, 16);
  OPENSSL_memcpy(key->aes_key, in_bytes + 32, 16);
  // Disable automatic key rotation for manually-configured keys. This is now
  // the caller's responsibility.
  key->next_rotation_tv_sec = 0;
  ctx->ticket_key_current = std::move(key);
  ctx->ticket_key_prev.reset();
  return 1;
}

int SSL_CTX_set_tlsext_ticket_key_cb(
    SSL_CTX *ctx,
    int (*callback)(SSL *ssl, uint8_t *key_name, uint8_t *iv,
                    EVP_CIPHER_CTX *ctx, HMAC_CTX *hmac_ctx, int encrypt)) {
  ctx->ticket_key_cb = callback;
  return 1;
}

static bool check_no_duplicates(Span<const uint16_t> list) {
  if (list.size() < 2) {
    return true;
  }
  for (size_t i = 0; i < list.size() - 1; ++i) {
    for (size_t j = i + 1; j < list.size(); ++j) {
      if (list[i] == list[j]) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_DUPLICATE_GROUP);
        return false;
      }
    }
  }
  return true;
}

static bool check_group_ids(Span<const uint16_t> group_ids) {
  for (uint16_t group_id : group_ids) {
    if (ssl_group_id_to_nid(group_id) == NID_undef) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNSUPPORTED_ELLIPTIC_CURVE);
      return false;
    }
  }
  return check_no_duplicates(group_ids);
}

// validate_key_shares returns whether the `requested_key_shares` are free of
// duplicates and are a (correctly ordered) subsequence of the supported
// `groups`.
static bool validate_key_shares(Span<const uint16_t> requested_key_shares,
                                Span<const uint16_t> groups) {
  if (!check_no_duplicates(requested_key_shares)) {
    return false;
  }
  if (requested_key_shares.size() > groups.size()) {
    return false;
  }
  size_t key_shares_idx = 0u, groups_idx = 0u;
  while (key_shares_idx < requested_key_shares.size() &&
         groups_idx < groups.size()) {
    if (requested_key_shares[key_shares_idx] == groups[groups_idx++]) {
      ++key_shares_idx;
    }
  }
  return key_shares_idx == requested_key_shares.size();
}

static void clear_key_shares_if_invalid(SSL_CONFIG *config) {
  if (!config->client_key_share_selections) {
    return;
  }
  if (!validate_key_shares(*(config->client_key_share_selections),
                           config->supported_group_list)) {
    config->client_key_share_selections.reset();
  }
}

int SSL_CTX_set1_group_ids(SSL_CTX *ctx, const uint16_t *group_ids,
                           size_t num_group_ids) {
  auto span = Span(group_ids, num_group_ids);
  if (span.empty()) {
    span = DefaultSupportedGroupIds();
  }
  return check_group_ids(span) && ctx->supported_group_list.CopyFrom(span);
}

int SSL_set1_group_ids(SSL *ssl, const uint16_t *group_ids,
                       size_t num_group_ids) {
  if (!ssl->config) {
    return 0;
  }
  auto span = Span(group_ids, num_group_ids);
  if (span.empty()) {
    span = DefaultSupportedGroupIds();
  }
  if (check_group_ids(span) &&
      ssl->config->supported_group_list.CopyFrom(span)) {
    clear_key_shares_if_invalid(ssl->config.get());
    return 1;
  }
  return 0;
}

static bool ssl_nids_to_group_ids(Array<uint16_t> *out_group_ids,
                                  Span<const int> nids) {
  if (nids.empty()) {
    return out_group_ids->CopyFrom(DefaultSupportedGroupIds());
  }
  Array<uint16_t> group_ids;
  if (!group_ids.InitForOverwrite(nids.size())) {
    return false;
  }

  for (size_t i = 0; i < nids.size(); i++) {
    if (!ssl_nid_to_group_id(&group_ids[i], nids[i])) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNSUPPORTED_ELLIPTIC_CURVE);
      return false;
    }
  }
  if (!check_no_duplicates(group_ids)) {
    return false;
  }

  *out_group_ids = std::move(group_ids);
  return true;
}

int SSL_CTX_set1_groups(SSL_CTX *ctx, const int *groups, size_t num_groups) {
  return ssl_nids_to_group_ids(&ctx->supported_group_list,
                               Span(groups, num_groups));
}

int SSL_set1_groups(SSL *ssl, const int *groups, size_t num_groups) {
  if (!ssl->config) {
    return 0;
  }
  if (ssl_nids_to_group_ids(&ssl->config->supported_group_list,
                            Span(groups, num_groups))) {
    clear_key_shares_if_invalid(ssl->config.get());
    return 1;
  }
  return 0;
}

static bool ssl_str_to_group_ids(Array<uint16_t> *out_group_ids,
                                 const char *str) {
  // Count the number of groups in the list.
  size_t count = 0;
  const char *ptr = str, *col;
  do {
    col = strchr(ptr, ':');
    count++;
    if (col) {
      ptr = col + 1;
    }
  } while (col);

  Array<uint16_t> group_ids;
  if (!group_ids.InitForOverwrite(count)) {
    return false;
  }

  size_t i = 0;
  ptr = str;
  do {
    col = strchr(ptr, ':');
    if (!ssl_name_to_group_id(&group_ids[i++], ptr,
                              col ? (size_t)(col - ptr) : strlen(ptr))) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNSUPPORTED_ELLIPTIC_CURVE);
      return false;
    }
    if (col) {
      ptr = col + 1;
    }
  } while (col);

  assert(i == count);
  if (!check_no_duplicates(group_ids)) {
    return false;
  }
  *out_group_ids = std::move(group_ids);
  return true;
}

int SSL_CTX_set1_groups_list(SSL_CTX *ctx, const char *groups) {
  return ssl_str_to_group_ids(&ctx->supported_group_list, groups);
}

int SSL_set1_groups_list(SSL *ssl, const char *groups) {
  if (!ssl->config) {
    return 0;
  }
  if (ssl_str_to_group_ids(&ssl->config->supported_group_list, groups)) {
    clear_key_shares_if_invalid(ssl->config.get());
    return 1;
  }
  return 0;
}

uint16_t SSL_get_group_id(const SSL *ssl) {
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return 0;
  }

  return session->group_id;
}

int SSL_get_negotiated_group(const SSL *ssl) {
  uint16_t group_id = SSL_get_group_id(ssl);
  if (group_id == 0) {
    return NID_undef;
  }
  return ssl_group_id_to_nid(group_id);
}

int SSL_set1_client_key_shares(SSL *ssl, const uint16_t *group_ids,
                               size_t num_group_ids) {
  if (!ssl->config) {
    return 0;
  }
  auto requested_key_shares = Span(group_ids, num_group_ids);
  if (!validate_key_shares(requested_key_shares,
                           ssl->config->supported_group_list)) {
    return 0;
  }

  assert(requested_key_shares.size() <= kNumNamedGroups);
  ssl->config->client_key_share_selections.emplace();
  ssl->config->client_key_share_selections->CopyFrom(requested_key_shares);
  return 1;
}

int SSL_set1_server_supported_groups_hint(SSL *ssl,
                                          const uint16_t *server_groups,
                                          size_t num_server_groups) {
  if (!ssl->config) {
    return 0;
  }
  auto span = Span(server_groups, num_server_groups);
  return ssl->config->server_supported_groups_hint.CopyFrom(span);
}

int SSL_CTX_set_tmp_dh(SSL_CTX *ctx, const DH *dh) { return 1; }

int SSL_set_tmp_dh(SSL *ssl, const DH *dh) { return 1; }

STACK_OF(SSL_CIPHER) *SSL_CTX_get_ciphers(const SSL_CTX *ctx) {
  return ctx->cipher_list->ciphers.get();
}

int SSL_CTX_cipher_in_group(const SSL_CTX *ctx, size_t i) {
  if (i >= sk_SSL_CIPHER_num(ctx->cipher_list->ciphers.get())) {
    return 0;
  }
  return ctx->cipher_list->in_group_flags[i];
}

STACK_OF(SSL_CIPHER) *SSL_get_ciphers(const SSL *ssl) {
  if (ssl == nullptr) {
    return nullptr;
  }
  if (ssl->config == nullptr) {
    assert(ssl->config);
    return nullptr;
  }

  return ssl->config->cipher_list ? ssl->config->cipher_list->ciphers.get()
                                  : ssl->ctx->cipher_list->ciphers.get();
}

const char *SSL_get_cipher_list(const SSL *ssl, int n) {
  if (ssl == nullptr) {
    return nullptr;
  }

  STACK_OF(SSL_CIPHER) *sk = SSL_get_ciphers(ssl);
  if (sk == nullptr || n < 0 || (size_t)n >= sk_SSL_CIPHER_num(sk)) {
    return nullptr;
  }

  const SSL_CIPHER *c = sk_SSL_CIPHER_value(sk, n);
  if (c == nullptr) {
    return nullptr;
  }

  return c->name;
}

int SSL_CTX_set_cipher_list(SSL_CTX *ctx, const char *str) {
  const bool has_aes_hw = ctx->aes_hw_override ? ctx->aes_hw_override_value
                                               : EVP_has_aes_hardware();
  return ssl_create_cipher_list(&ctx->cipher_list, has_aes_hw, str,
                                false /* not strict */);
}

int SSL_CTX_set_strict_cipher_list(SSL_CTX *ctx, const char *str) {
  const bool has_aes_hw = ctx->aes_hw_override ? ctx->aes_hw_override_value
                                               : EVP_has_aes_hardware();
  return ssl_create_cipher_list(&ctx->cipher_list, has_aes_hw, str,
                                true /* strict */);
}

int SSL_set_cipher_list(SSL *ssl, const char *str) {
  if (!ssl->config) {
    return 0;
  }
  const bool has_aes_hw = ssl->config->aes_hw_override
                              ? ssl->config->aes_hw_override_value
                              : EVP_has_aes_hardware();
  return ssl_create_cipher_list(&ssl->config->cipher_list, has_aes_hw, str,
                                false /* not strict */);
}

int SSL_set_strict_cipher_list(SSL *ssl, const char *str) {
  if (!ssl->config) {
    return 0;
  }
  const bool has_aes_hw = ssl->config->aes_hw_override
                              ? ssl->config->aes_hw_override_value
                              : EVP_has_aes_hardware();
  return ssl_create_cipher_list(&ssl->config->cipher_list, has_aes_hw, str,
                                true /* strict */);
}

const char *SSL_get_servername(const SSL *ssl, const int type) {
  if (type != TLSEXT_NAMETYPE_host_name) {
    return nullptr;
  }

  // Historically, |SSL_get_servername| was also the configuration getter
  // corresponding to |SSL_set_tlsext_host_name|.
  if (ssl->hostname != nullptr) {
    return ssl->hostname.get();
  }

  return ssl->s3->hostname.get();
}

int SSL_get_servername_type(const SSL *ssl) {
  if (SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name) == nullptr) {
    return -1;
  }
  return TLSEXT_NAMETYPE_host_name;
}

void SSL_CTX_set_custom_verify(
    SSL_CTX *ctx, int mode,
    enum ssl_verify_result_t (*callback)(SSL *ssl, uint8_t *out_alert)) {
  ctx->verify_mode = mode;
  ctx->custom_verify_callback = callback;
}

void SSL_set_custom_verify(
    SSL *ssl, int mode,
    enum ssl_verify_result_t (*callback)(SSL *ssl, uint8_t *out_alert)) {
  if (!ssl->config) {
    return;
  }
  ssl->config->verify_mode = mode;
  ssl->config->custom_verify_callback = callback;
}

void SSL_CTX_enable_signed_cert_timestamps(SSL_CTX *ctx) {
  ctx->signed_cert_timestamps_enabled = true;
}

void SSL_enable_signed_cert_timestamps(SSL *ssl) {
  if (!ssl->config) {
    return;
  }
  ssl->config->signed_cert_timestamps_enabled = true;
}

void SSL_CTX_enable_ocsp_stapling(SSL_CTX *ctx) {
  ctx->ocsp_stapling_enabled = true;
}

void SSL_enable_ocsp_stapling(SSL *ssl) {
  if (!ssl->config) {
    return;
  }
  ssl->config->ocsp_stapling_enabled = true;
}

void SSL_get0_signed_cert_timestamp_list(const SSL *ssl, const uint8_t **out,
                                         size_t *out_len) {
  SSL_SESSION *session = SSL_get_session(ssl);
  if (ssl->server || !session || !session->signed_cert_timestamp_list) {
    *out_len = 0;
    *out = nullptr;
    return;
  }

  *out = CRYPTO_BUFFER_data(session->signed_cert_timestamp_list.get());
  *out_len = CRYPTO_BUFFER_len(session->signed_cert_timestamp_list.get());
}

void SSL_get0_ocsp_response(const SSL *ssl, const uint8_t **out,
                            size_t *out_len) {
  SSL_SESSION *session = SSL_get_session(ssl);
  if (ssl->server || !session || !session->ocsp_response) {
    *out_len = 0;
    *out = nullptr;
    return;
  }

  *out = CRYPTO_BUFFER_data(session->ocsp_response.get());
  *out_len = CRYPTO_BUFFER_len(session->ocsp_response.get());
}

int SSL_set_tlsext_host_name(SSL *ssl, const char *name) {
  ssl->hostname.reset();
  if (name == nullptr) {
    return 1;
  }

  size_t len = strlen(name);
  if (len == 0 || len > TLSEXT_MAXLEN_host_name) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_SSL3_EXT_INVALID_SERVERNAME);
    return 0;
  }
  ssl->hostname.reset(OPENSSL_strdup(name));
  if (ssl->hostname == nullptr) {
    return 0;
  }
  return 1;
}

int SSL_CTX_set_tlsext_servername_callback(
    SSL_CTX *ctx, int (*callback)(SSL *ssl, int *out_alert, void *arg)) {
  ctx->servername_callback = callback;
  return 1;
}

int SSL_CTX_set_tlsext_servername_arg(SSL_CTX *ctx, void *arg) {
  ctx->servername_arg = arg;
  return 1;
}

int SSL_select_next_proto(uint8_t **out, uint8_t *out_len, const uint8_t *peer,
                          unsigned peer_len, const uint8_t *supported,
                          unsigned supported_len) {
  *out = nullptr;
  *out_len = 0;

  // Both |peer| and |supported| must be valid protocol lists, but |peer| may be
  // empty in NPN.
  auto peer_span = Span(peer, peer_len);
  auto supported_span = Span(supported, supported_len);
  if ((!peer_span.empty() && !ssl_is_valid_alpn_list(peer_span)) ||
      !ssl_is_valid_alpn_list(supported_span)) {
    return OPENSSL_NPN_NO_OVERLAP;
  }

  // For each protocol in peer preference order, see if we support it.
  CBS cbs = peer_span, proto;
  while (CBS_len(&cbs) != 0) {
    if (!CBS_get_u8_length_prefixed(&cbs, &proto) || CBS_len(&proto) == 0) {
      return OPENSSL_NPN_NO_OVERLAP;
    }

    if (ssl_alpn_list_contains_protocol(Span(supported, supported_len),
                                        proto)) {
      // This function is not const-correct for compatibility with existing
      // callers.
      *out = const_cast<uint8_t *>(CBS_data(&proto));
      // A u8 length prefix will fit in |uint8_t|.
      *out_len = static_cast<uint8_t>(CBS_len(&proto));
      return OPENSSL_NPN_NEGOTIATED;
    }
  }

  // There's no overlap between our protocols and the peer's list. In ALPN, the
  // caller is expected to fail the connection with no_application_protocol. In
  // NPN, the caller is expected to opportunistically select the first protocol.
  // See draft-agl-tls-nextprotoneg-04, section 6.
  cbs = supported_span;
  if (!CBS_get_u8_length_prefixed(&cbs, &proto) || CBS_len(&proto) == 0) {
    return OPENSSL_NPN_NO_OVERLAP;
  }

  // See above.
  *out = const_cast<uint8_t *>(CBS_data(&proto));
  *out_len = static_cast<uint8_t>(CBS_len(&proto));
  return OPENSSL_NPN_NO_OVERLAP;
}

void SSL_get0_next_proto_negotiated(const SSL *ssl, const uint8_t **out_data,
                                    unsigned *out_len) {
  // NPN protocols have one-byte lengths, so they must fit in |unsigned|.
  assert(ssl->s3->next_proto_negotiated.size() <= UINT_MAX);
  *out_data = ssl->s3->next_proto_negotiated.data();
  *out_len = static_cast<unsigned>(ssl->s3->next_proto_negotiated.size());
}

void SSL_CTX_set_next_protos_advertised_cb(
    SSL_CTX *ctx,
    int (*cb)(SSL *ssl, const uint8_t **out, unsigned *out_len, void *arg),
    void *arg) {
  ctx->next_protos_advertised_cb = cb;
  ctx->next_protos_advertised_cb_arg = arg;
}

void SSL_CTX_set_next_proto_select_cb(SSL_CTX *ctx,
                                      int (*cb)(SSL *ssl, uint8_t **out,
                                                uint8_t *out_len,
                                                const uint8_t *in,
                                                unsigned in_len, void *arg),
                                      void *arg) {
  ctx->next_proto_select_cb = cb;
  ctx->next_proto_select_cb_arg = arg;
}

int SSL_CTX_set_alpn_protos(SSL_CTX *ctx, const uint8_t *protos,
                            size_t protos_len) {
  // Note this function's return value is backwards.
  auto span = Span(protos, protos_len);
  if (!span.empty() && !ssl_is_valid_alpn_list(span)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_ALPN_PROTOCOL_LIST);
    return 1;
  }
  return ctx->alpn_client_proto_list.CopyFrom(span) ? 0 : 1;
}

int SSL_set_alpn_protos(SSL *ssl, const uint8_t *protos, size_t protos_len) {
  // Note this function's return value is backwards.
  if (!ssl->config) {
    return 1;
  }
  auto span = Span(protos, protos_len);
  if (!span.empty() && !ssl_is_valid_alpn_list(span)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_ALPN_PROTOCOL_LIST);
    return 1;
  }
  return ssl->config->alpn_client_proto_list.CopyFrom(span) ? 0 : 1;
}

void SSL_CTX_set_alpn_select_cb(SSL_CTX *ctx,
                                int (*cb)(SSL *ssl, const uint8_t **out,
                                          uint8_t *out_len, const uint8_t *in,
                                          unsigned in_len, void *arg),
                                void *arg) {
  ctx->alpn_select_cb = cb;
  ctx->alpn_select_cb_arg = arg;
}

void SSL_get0_alpn_selected(const SSL *ssl, const uint8_t **out_data,
                            unsigned *out_len) {
  Span<const uint8_t> protocol;
  if (SSL_in_early_data(ssl) && !ssl->server) {
    protocol = ssl->s3->hs->early_session->early_alpn;
  } else {
    protocol = ssl->s3->alpn_selected;
  }
  // ALPN protocols have one-byte lengths, so they must fit in |unsigned|.
  assert(protocol.size() < UINT_MAX);
  *out_data = protocol.data();
  *out_len = static_cast<unsigned>(protocol.size());
}

void SSL_CTX_set_allow_unknown_alpn_protos(SSL_CTX *ctx, int enabled) {
  ctx->allow_unknown_alpn_protos = !!enabled;
}

int SSL_add_application_settings(SSL *ssl, const uint8_t *proto,
                                 size_t proto_len, const uint8_t *settings,
                                 size_t settings_len) {
  if (!ssl->config) {
    return 0;
  }
  ALPSConfig config;
  if (!config.protocol.CopyFrom(Span(proto, proto_len)) ||
      !config.settings.CopyFrom(Span(settings, settings_len)) ||
      !ssl->config->alps_configs.Push(std::move(config))) {
    return 0;
  }
  return 1;
}

void SSL_get0_peer_application_settings(const SSL *ssl,
                                        const uint8_t **out_data,
                                        size_t *out_len) {
  const SSL_SESSION *session = SSL_get_session(ssl);
  Span<const uint8_t> settings =
      session ? session->peer_application_settings : Span<const uint8_t>();
  *out_data = settings.data();
  *out_len = settings.size();
}

int SSL_has_application_settings(const SSL *ssl) {
  const SSL_SESSION *session = SSL_get_session(ssl);
  return session && session->has_application_settings;
}

void SSL_set_alps_use_new_codepoint(SSL *ssl, int use_new) {
  if (!ssl->config) {
    return;
  }
  ssl->config->alps_use_new_codepoint = !!use_new;
}

int SSL_CTX_add_cert_compression_alg(SSL_CTX *ctx, uint16_t alg_id,
                                     ssl_cert_compression_func_t compress,
                                     ssl_cert_decompression_func_t decompress) {
  assert(compress != nullptr || decompress != nullptr);

  for (const auto &alg : ctx->cert_compression_algs) {
    if (alg.alg_id == alg_id) {
      return 0;
    }
  }

  CertCompressionAlg alg;
  alg.alg_id = alg_id;
  alg.compress = compress;
  alg.decompress = decompress;
  return ctx->cert_compression_algs.Push(alg);
}

void SSL_CTX_set_tls_channel_id_enabled(SSL_CTX *ctx, int enabled) {
  ctx->channel_id_enabled = !!enabled;
}

int SSL_CTX_enable_tls_channel_id(SSL_CTX *ctx) {
  SSL_CTX_set_tls_channel_id_enabled(ctx, 1);
  return 1;
}

void SSL_set_tls_channel_id_enabled(SSL *ssl, int enabled) {
  if (!ssl->config) {
    return;
  }
  ssl->config->channel_id_enabled = !!enabled;
}

int SSL_enable_tls_channel_id(SSL *ssl) {
  SSL_set_tls_channel_id_enabled(ssl, 1);
  return 1;
}

int SSL_CTX_set1_tls_channel_id(SSL_CTX *ctx, EVP_PKEY *private_key) {
  if (EVP_PKEY_get_ec_curve_nid(private_key) != NID_X9_62_prime256v1) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CHANNEL_ID_NOT_P256);
    return 0;
  }

  ctx->channel_id_private = UpRef(private_key);
  return 1;
}

int SSL_set1_tls_channel_id(SSL *ssl, EVP_PKEY *private_key) {
  if (!ssl->config) {
    return 0;
  }
  if (EVP_PKEY_get_ec_curve_nid(private_key) != NID_X9_62_prime256v1) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CHANNEL_ID_NOT_P256);
    return 0;
  }

  ssl->config->channel_id_private = UpRef(private_key);
  return 1;
}

size_t SSL_get_tls_channel_id(SSL *ssl, uint8_t *out, size_t max_out) {
  if (!ssl->s3->channel_id_valid) {
    return 0;
  }
  OPENSSL_memcpy(out, ssl->s3->channel_id, (max_out < 64) ? max_out : 64);
  return 64;
}

size_t SSL_get0_certificate_types(const SSL *ssl, const uint8_t **out_types) {
  Span<const uint8_t> types;
  if (!ssl->server && ssl->s3->hs != nullptr) {
    types = ssl->s3->hs->certificate_types;
  }
  *out_types = types.data();
  return types.size();
}

size_t SSL_get0_peer_verify_algorithms(const SSL *ssl,
                                       const uint16_t **out_sigalgs) {
  Span<const uint16_t> sigalgs;
  if (ssl->s3->hs != nullptr) {
    sigalgs = ssl->s3->hs->peer_sigalgs;
  }
  *out_sigalgs = sigalgs.data();
  return sigalgs.size();
}

size_t SSL_get0_peer_delegation_algorithms(const SSL *ssl,
                                           const uint16_t **out_sigalgs) {
  Span<const uint16_t> sigalgs;
  if (ssl->s3->hs != nullptr) {
    sigalgs = ssl->s3->hs->peer_delegated_credential_sigalgs;
  }
  *out_sigalgs = sigalgs.data();
  return sigalgs.size();
}

EVP_PKEY *SSL_get_privatekey(const SSL *ssl) {
  if (!ssl->config) {
    assert(ssl->config);
    return nullptr;
  }
  return ssl->config->cert->legacy_credential->privkey.get();
}

EVP_PKEY *SSL_CTX_get0_privatekey(const SSL_CTX *ctx) {
  return ctx->cert->legacy_credential->privkey.get();
}

const SSL_CIPHER *SSL_get_current_cipher(const SSL *ssl) {
  const SSL_SESSION *session = SSL_get_session(ssl);
  return session == nullptr ? nullptr : session->cipher;
}

int SSL_session_reused(const SSL *ssl) {
  return ssl->s3->session_reused || SSL_in_early_data(ssl);
}

const COMP_METHOD *SSL_get_current_compression(SSL *ssl) { return nullptr; }

const COMP_METHOD *SSL_get_current_expansion(SSL *ssl) { return nullptr; }

int SSL_get_server_tmp_key(SSL *ssl, EVP_PKEY **out_key) { return 0; }

void SSL_CTX_set_quiet_shutdown(SSL_CTX *ctx, int mode) {
  ctx->quiet_shutdown = (mode != 0);
}

int SSL_CTX_get_quiet_shutdown(const SSL_CTX *ctx) {
  return ctx->quiet_shutdown;
}

void SSL_set_quiet_shutdown(SSL *ssl, int mode) {
  ssl->quiet_shutdown = (mode != 0);
}

int SSL_get_quiet_shutdown(const SSL *ssl) { return ssl->quiet_shutdown; }

void SSL_set_shutdown(SSL *ssl, int mode) {
  // It is an error to clear any bits that have already been set. (We can't try
  // to get a second close_notify or send two.)
  assert((SSL_get_shutdown(ssl) & mode) == SSL_get_shutdown(ssl));

  if (mode & SSL_RECEIVED_SHUTDOWN &&
      ssl->s3->read_shutdown == ssl_shutdown_none) {
    ssl->s3->read_shutdown = ssl_shutdown_close_notify;
  }

  if (mode & SSL_SENT_SHUTDOWN &&
      ssl->s3->write_shutdown == ssl_shutdown_none) {
    ssl->s3->write_shutdown = ssl_shutdown_close_notify;
  }
}

int SSL_get_shutdown(const SSL *ssl) {
  int ret = 0;
  if (ssl->s3->read_shutdown != ssl_shutdown_none) {
    // Historically, OpenSSL set |SSL_RECEIVED_SHUTDOWN| on both close_notify
    // and fatal alert.
    ret |= SSL_RECEIVED_SHUTDOWN;
  }
  if (ssl->s3->write_shutdown == ssl_shutdown_close_notify) {
    // Historically, OpenSSL set |SSL_SENT_SHUTDOWN| on only close_notify.
    ret |= SSL_SENT_SHUTDOWN;
  }
  return ret;
}

SSL_CTX *SSL_get_SSL_CTX(const SSL *ssl) { return ssl->ctx.get(); }

SSL_CTX *SSL_set_SSL_CTX(SSL *ssl, SSL_CTX *ctx) {
  if (!ssl->config) {
    return nullptr;
  }
  if (ssl->ctx.get() == ctx) {
    return ssl->ctx.get();
  }

  // One cannot change the X.509 callbacks during a connection.
  if (ssl->ctx->x509_method != ctx->x509_method) {
    assert(0);
    return nullptr;
  }

  UniquePtr<CERT> new_cert = ssl_cert_dup(ctx->cert.get());
  if (!new_cert) {
    return nullptr;
  }

  ssl->config->cert = std::move(new_cert);
  ssl->ctx = UpRef(ctx);
  ssl->enable_early_data = ssl->ctx->enable_early_data;

  return ssl->ctx.get();
}

void SSL_set_info_callback(SSL *ssl,
                           void (*cb)(const SSL *ssl, int type, int value)) {
  ssl->info_callback = cb;
}

void (*SSL_get_info_callback(const SSL *ssl))(const SSL *ssl, int type,
                                              int value) {
  return ssl->info_callback;
}

int SSL_state(const SSL *ssl) {
  return SSL_in_init(ssl) ? SSL_ST_INIT : SSL_ST_OK;
}

void SSL_set_state(SSL *ssl, int state) {}

char *SSL_get_shared_ciphers(const SSL *ssl, char *buf, int len) {
  if (len <= 0) {
    return nullptr;
  }
  buf[0] = '\0';
  return buf;
}

int SSL_get_shared_sigalgs(SSL *ssl, int idx, int *psign, int *phash,
                           int *psignandhash, uint8_t *rsig, uint8_t *rhash) {
  return 0;
}

int SSL_CTX_set_quic_method(SSL_CTX *ctx, const SSL_QUIC_METHOD *quic_method) {
  if (ctx->method->is_dtls) {
    return 0;
  }
  ctx->quic_method = quic_method;
  return 1;
}

int SSL_set_quic_method(SSL *ssl, const SSL_QUIC_METHOD *quic_method) {
  if (ssl->method->is_dtls) {
    return 0;
  }
  ssl->quic_method = quic_method;
  return 1;
}

int SSL_get_ex_new_index(long argl, void *argp, CRYPTO_EX_unused *unused,
                         CRYPTO_EX_dup *dup_unused, CRYPTO_EX_free *free_func) {
  return CRYPTO_get_ex_new_index_ex(&g_ex_data_class_ssl, argl, argp,
                                    free_func);
}

int SSL_set_ex_data(SSL *ssl, int idx, void *data) {
  return CRYPTO_set_ex_data(&ssl->ex_data, idx, data);
}

void *SSL_get_ex_data(const SSL *ssl, int idx) {
  return CRYPTO_get_ex_data(&ssl->ex_data, idx);
}

int SSL_CTX_get_ex_new_index(long argl, void *argp, CRYPTO_EX_unused *unused,
                             CRYPTO_EX_dup *dup_unused,
                             CRYPTO_EX_free *free_func) {
  return CRYPTO_get_ex_new_index_ex(&g_ex_data_class_ssl_ctx, argl, argp,
                                    free_func);
}

int SSL_CTX_set_ex_data(SSL_CTX *ctx, int idx, void *data) {
  return CRYPTO_set_ex_data(&ctx->ex_data, idx, data);
}

void *SSL_CTX_get_ex_data(const SSL_CTX *ctx, int idx) {
  return CRYPTO_get_ex_data(&ctx->ex_data, idx);
}

int SSL_want(const SSL *ssl) {
  // Historically, OpenSSL did not track |SSL_ERROR_ZERO_RETURN| as an |rwstate|
  // value. We do, but map it back to |SSL_ERROR_NONE| to preserve the original
  // behavior.
  return ssl->s3->rwstate == SSL_ERROR_ZERO_RETURN ? SSL_ERROR_NONE
                                                   : ssl->s3->rwstate;
}

void SSL_CTX_set_tmp_rsa_callback(SSL_CTX *ctx,
                                  RSA *(*cb)(SSL *ssl, int is_export,
                                             int keylength)) {}

void SSL_set_tmp_rsa_callback(SSL *ssl, RSA *(*cb)(SSL *ssl, int is_export,
                                                   int keylength)) {}

void SSL_CTX_set_tmp_dh_callback(SSL_CTX *ctx,
                                 DH *(*cb)(SSL *ssl, int is_export,
                                           int keylength)) {}

void SSL_set_tmp_dh_callback(SSL *ssl, DH *(*cb)(SSL *ssl, int is_export,
                                                 int keylength)) {}

static int use_psk_identity_hint(UniquePtr<char> *out,
                                 const char *identity_hint) {
  if (identity_hint != nullptr &&
      strlen(identity_hint) > PSK_MAX_IDENTITY_LEN) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DATA_LENGTH_TOO_LONG);
    return 0;
  }

  // Clear currently configured hint, if any.
  out->reset();

  // Treat the empty hint as not supplying one. Plain PSK makes it possible to
  // send either no hint (omit ServerKeyExchange) or an empty hint, while
  // ECDHE_PSK can only spell empty hint. Having different capabilities is odd,
  // so we interpret empty and missing as identical.
  if (identity_hint != nullptr && identity_hint[0] != '\0') {
    out->reset(OPENSSL_strdup(identity_hint));
    if (*out == nullptr) {
      return 0;
    }
  }

  return 1;
}

int SSL_CTX_use_psk_identity_hint(SSL_CTX *ctx, const char *identity_hint) {
  return use_psk_identity_hint(&ctx->psk_identity_hint, identity_hint);
}

int SSL_use_psk_identity_hint(SSL *ssl, const char *identity_hint) {
  if (!ssl->config) {
    return 0;
  }
  return use_psk_identity_hint(&ssl->config->psk_identity_hint, identity_hint);
}

const char *SSL_get_psk_identity_hint(const SSL *ssl) {
  if (ssl == nullptr) {
    return nullptr;
  }
  if (ssl->config == nullptr) {
    assert(ssl->config);
    return nullptr;
  }
  return ssl->config->psk_identity_hint.get();
}

const char *SSL_get_psk_identity(const SSL *ssl) {
  if (ssl == nullptr) {
    return nullptr;
  }
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return nullptr;
  }
  return session->psk_identity.get();
}

void SSL_set_psk_client_callback(
    SSL *ssl, unsigned (*cb)(SSL *ssl, const char *hint, char *identity,
                             unsigned max_identity_len, uint8_t *psk,
                             unsigned max_psk_len)) {
  if (!ssl->config) {
    return;
  }
  ssl->config->psk_client_callback = cb;
}

void SSL_CTX_set_psk_client_callback(
    SSL_CTX *ctx, unsigned (*cb)(SSL *ssl, const char *hint, char *identity,
                                 unsigned max_identity_len, uint8_t *psk,
                                 unsigned max_psk_len)) {
  ctx->psk_client_callback = cb;
}

void SSL_set_psk_server_callback(SSL *ssl,
                                 unsigned (*cb)(SSL *ssl, const char *identity,
                                                uint8_t *psk,
                                                unsigned max_psk_len)) {
  if (!ssl->config) {
    return;
  }
  ssl->config->psk_server_callback = cb;
}

void SSL_CTX_set_psk_server_callback(
    SSL_CTX *ctx, unsigned (*cb)(SSL *ssl, const char *identity, uint8_t *psk,
                                 unsigned max_psk_len)) {
  ctx->psk_server_callback = cb;
}

void SSL_CTX_set_msg_callback(SSL_CTX *ctx,
                              void (*cb)(int write_p, int version,
                                         int content_type, const void *buf,
                                         size_t len, SSL *ssl, void *arg)) {
  ctx->msg_callback = cb;
}

void SSL_CTX_set_msg_callback_arg(SSL_CTX *ctx, void *arg) {
  ctx->msg_callback_arg = arg;
}

void SSL_set_msg_callback(SSL *ssl,
                          void (*cb)(int write_p, int version, int content_type,
                                     const void *buf, size_t len, SSL *ssl,
                                     void *arg)) {
  ssl->msg_callback = cb;
}

void SSL_set_msg_callback_arg(SSL *ssl, void *arg) {
  ssl->msg_callback_arg = arg;
}

void SSL_CTX_set_keylog_callback(SSL_CTX *ctx,
                                 void (*cb)(const SSL *ssl, const char *line)) {
  ctx->keylog_callback = cb;
}

void (*SSL_CTX_get_keylog_callback(const SSL_CTX *ctx))(const SSL *ssl,
                                                        const char *line) {
  return ctx->keylog_callback;
}

void SSL_CTX_set_current_time_cb(SSL_CTX *ctx,
                                 void (*cb)(const SSL *ssl,
                                            struct timeval *out_clock)) {
  ctx->current_time_cb = cb;
}

int SSL_can_release_private_key(const SSL *ssl) {
  if (ssl_can_renegotiate(ssl)) {
    // If the connection can renegotiate (client only), the private key may be
    // used in a future handshake.
    return 0;
  }

  // Otherwise, this is determined by the current handshake.
  return !ssl->s3->hs || ssl->s3->hs->can_release_private_key;
}

int SSL_is_init_finished(const SSL *ssl) { return !SSL_in_init(ssl); }

int SSL_in_init(const SSL *ssl) {
  // This returns false once all the handshake state has been finalized, to
  // allow callbacks and getters based on SSL_in_init to return the correct
  // values.
  SSL_HANDSHAKE *hs = ssl->s3->hs.get();
  return hs != nullptr && !hs->handshake_finalized;
}

int SSL_in_false_start(const SSL *ssl) {
  if (ssl->s3->hs == nullptr) {
    return 0;
  }
  return ssl->s3->hs->in_false_start;
}

int SSL_cutthrough_complete(const SSL *ssl) { return SSL_in_false_start(ssl); }

int SSL_is_server(const SSL *ssl) { return ssl->server; }

int SSL_is_dtls(const SSL *ssl) { return ssl->method->is_dtls; }

int SSL_is_quic(const SSL *ssl) { return ssl->quic_method != nullptr; }

void SSL_CTX_set_select_certificate_cb(
    SSL_CTX *ctx,
    enum ssl_select_cert_result_t (*cb)(const SSL_CLIENT_HELLO *)) {
  ctx->select_certificate_cb = cb;
}

void SSL_CTX_set_dos_protection_cb(SSL_CTX *ctx,
                                   int (*cb)(const SSL_CLIENT_HELLO *)) {
  ctx->dos_protection_cb = cb;
}

void SSL_CTX_set_reverify_on_resume(SSL_CTX *ctx, int enabled) {
  ctx->reverify_on_resume = !!enabled;
}

void SSL_set_enforce_rsa_key_usage(SSL *ssl, int enabled) {
  if (!ssl->config) {
    return;
  }
  ssl->config->enforce_rsa_key_usage = !!enabled;
}

int SSL_was_key_usage_invalid(const SSL *ssl) {
  return ssl->s3->was_key_usage_invalid;
}

void SSL_set_renegotiate_mode(SSL *ssl, enum ssl_renegotiate_mode_t mode) {
  ssl->renegotiate_mode = mode;

  // Check if |ssl_can_renegotiate| has changed and the configuration may now be
  // shed. HTTP clients may initially allow renegotiation for HTTP/1.1, and then
  // disable after the handshake once the ALPN protocol is known to be HTTP/2.
  ssl_maybe_shed_handshake_config(ssl);
}

int SSL_get_ivs(const SSL *ssl, const uint8_t **out_read_iv,
                const uint8_t **out_write_iv, size_t *out_iv_len) {
  // No cipher suites maintain stateful internal IVs in DTLS. It would not be
  // compatible with reordering.
  if (SSL_is_dtls(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  size_t write_iv_len;
  if (!ssl->s3->aead_read_ctx->GetIV(out_read_iv, out_iv_len) ||
      !ssl->s3->aead_write_ctx->GetIV(out_write_iv, &write_iv_len) ||
      *out_iv_len != write_iv_len) {
    return 0;
  }

  return 1;
}

uint64_t SSL_get_read_sequence(const SSL *ssl) {
  if (SSL_is_dtls(ssl)) {
    // TODO(crbug.com/42290608): This API should not be implemented for DTLS or
    // QUIC. In QUIC we do not maintain a sequence number.
    const DTLSReadEpoch *read_epoch = &ssl->d1->read_epoch;
    return DTLSRecordNumber(read_epoch->epoch, read_epoch->bitmap.max_seq_num())
        .combined();
  }
  return ssl->s3->read_sequence;
}

uint64_t SSL_get_write_sequence(const SSL *ssl) {
  // TODO(crbug.com/42290608): This API should not be implemented for DTLS or
  // QUIC. In QUIC we do not maintain a sequence number. In DTLS, this API isn't
  // harmful per se, but the caller already needs to use a DTLS-specific API on
  // the read side.
  if (SSL_is_dtls(ssl)) {
    return ssl->d1->write_epoch.next_record.combined();
  }

  return ssl->s3->write_sequence;
}

int SSL_is_dtls_handshake_idle(const SSL *ssl) {
  BSSL_CHECK(SSL_is_dtls(ssl));

  return !SSL_in_init(ssl) &&
         // No unacknowledged messages in DTLS 1.3. In DTLS 1.2, there no ACKs
         // and we currently never clear |outgoing_messages| on the side that
         // speaks last.
         (ssl_protocol_version(ssl) < TLS1_3_VERSION ||
          ssl->d1->outgoing_messages.empty()) &&
         // No partial or out-of-order messages.
         std::all_of(std::begin(ssl->d1->incoming_messages),
                     std::end(ssl->d1->incoming_messages),
                     [](const auto &msg) { return msg == nullptr; }) &&
         // Not trying to send a KeyUpdate.
         !ssl->s3->key_update_pending &&
         ssl->d1->queued_key_update == bssl::QueuedKeyUpdate::kNone;
}

uint32_t SSL_get_dtls_handshake_read_seq(const SSL *ssl) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  return ssl->d1->handshake_read_overflow
             ? uint32_t{0x10000}
             : uint32_t{ssl->d1->handshake_read_seq};
}

uint32_t SSL_get_dtls_handshake_write_seq(const SSL *ssl) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  return ssl->d1->handshake_write_overflow
             ? uint32_t{0x10000}
             : uint32_t{ssl->d1->handshake_write_seq};
}

uint16_t SSL_get_dtls_read_epoch(const SSL *ssl) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  // Return the highest available epoch.
  return ssl->d1->next_read_epoch ? ssl->d1->next_read_epoch->epoch
                                  : ssl->d1->read_epoch.epoch;
}

uint16_t SSL_get_dtls_write_epoch(const SSL *ssl) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  return ssl->d1->write_epoch.epoch();
}

uint64_t SSL_get_dtls_read_sequence(const SSL *ssl, uint16_t epoch) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  const DTLSReadEpoch *read_epoch = dtls_get_read_epoch(ssl, epoch);
  if (read_epoch == nullptr) {
    return UINT64_MAX;
  }
  uint64_t max_seq_num = read_epoch->bitmap.max_seq_num();
  assert(max_seq_num <= DTLSRecordNumber::kMaxSequence);
  if (read_epoch->bitmap.ShouldDiscard(max_seq_num)) {
    // Increment to get to an available sequence number.
    max_seq_num++;
  } else {
    // If |max_seq_num| was available, the bitmap must have been empty.
    assert(max_seq_num == 0);
  }
  return max_seq_num;
}

uint64_t SSL_get_dtls_write_sequence(const SSL *ssl, uint16_t epoch) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  const DTLSWriteEpoch *write_epoch = dtls_get_write_epoch(ssl, epoch);
  if (write_epoch == nullptr) {
    return UINT64_MAX;
  }
  return write_epoch->next_record.sequence();
}

template <typename EpochState>
static int get_dtls_traffic_secret(
    const SSL *ssl, EpochState *(*get_epoch)(const SSL *, uint16_t),
    const uint8_t **out_data, size_t *out_len, uint16_t epoch) {
  BSSL_CHECK(SSL_is_dtls(ssl));
  // This function only applies to encrypted DTLS 1.3 epochs.
  if (epoch == 0 || ssl->s3->version == 0 ||
      ssl_protocol_version(ssl) < TLS1_3_VERSION) {
    return 0;
  }
  const EpochState *epoch_state = get_epoch(ssl, epoch);
  if (epoch_state == nullptr) {
    return 0;
  }
  assert(!epoch_state->traffic_secret.empty());
  *out_data = epoch_state->traffic_secret.data();
  *out_len = epoch_state->traffic_secret.size();
  return 1;
}

int SSL_get_dtls_read_traffic_secret(const SSL *ssl, const uint8_t **out_data,
                                     size_t *out_len, uint16_t epoch) {
  return get_dtls_traffic_secret(ssl, dtls_get_read_epoch, out_data, out_len,
                                 epoch);
}

int SSL_get_dtls_write_traffic_secret(const SSL *ssl, const uint8_t **out_data,
                                      size_t *out_len, uint16_t epoch) {
  return get_dtls_traffic_secret(ssl, dtls_get_write_epoch, out_data, out_len,
                                 epoch);
}

uint16_t SSL_get_peer_signature_algorithm(const SSL *ssl) {
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return 0;
  }

  return session->peer_signature_algorithm;
}

size_t SSL_get_client_random(const SSL *ssl, uint8_t *out, size_t max_out) {
  if (max_out == 0) {
    return sizeof(ssl->s3->client_random);
  }
  if (max_out > sizeof(ssl->s3->client_random)) {
    max_out = sizeof(ssl->s3->client_random);
  }
  OPENSSL_memcpy(out, ssl->s3->client_random, max_out);
  return max_out;
}

size_t SSL_get_server_random(const SSL *ssl, uint8_t *out, size_t max_out) {
  if (max_out == 0) {
    return sizeof(ssl->s3->server_random);
  }
  if (max_out > sizeof(ssl->s3->server_random)) {
    max_out = sizeof(ssl->s3->server_random);
  }
  OPENSSL_memcpy(out, ssl->s3->server_random, max_out);
  return max_out;
}

const SSL_CIPHER *SSL_get_pending_cipher(const SSL *ssl) {
  SSL_HANDSHAKE *hs = ssl->s3->hs.get();
  if (hs == nullptr) {
    return nullptr;
  }
  return hs->new_cipher;
}

void SSL_set_retain_only_sha256_of_client_certs(SSL *ssl, int enabled) {
  if (!ssl->config) {
    return;
  }
  ssl->config->retain_only_sha256_of_client_certs = !!enabled;
}

void SSL_CTX_set_retain_only_sha256_of_client_certs(SSL_CTX *ctx, int enabled) {
  ctx->retain_only_sha256_of_client_certs = !!enabled;
}

void SSL_CTX_set_grease_enabled(SSL_CTX *ctx, int enabled) {
  ctx->grease_enabled = !!enabled;
}

void SSL_CTX_set_permute_extensions(SSL_CTX *ctx, int enabled) {
  ctx->permute_extensions = !!enabled;
}

void SSL_set_permute_extensions(SSL *ssl, int enabled) {
  if (!ssl->config) {
    return;
  }
  ssl->config->permute_extensions = !!enabled;
}

int32_t SSL_get_ticket_age_skew(const SSL *ssl) {
  return ssl->s3->ticket_age_skew;
}

void SSL_CTX_set_false_start_allowed_without_alpn(SSL_CTX *ctx, int allowed) {
  ctx->false_start_allowed_without_alpn = !!allowed;
}

int SSL_used_hello_retry_request(const SSL *ssl) {
  return ssl->s3->used_hello_retry_request;
}

void SSL_set_shed_handshake_config(SSL *ssl, int enable) {
  if (!ssl->config) {
    return;
  }
  ssl->config->shed_handshake_config = !!enable;
}

void SSL_set_jdk11_workaround(SSL *ssl, int enable) {
  if (!ssl->config) {
    return;
  }
  ssl->config->jdk11_workaround = !!enable;
}

void SSL_set_quic_use_legacy_codepoint(SSL *ssl, int use_legacy) {
  if (!ssl->config) {
    return;
  }
  ssl->config->quic_use_legacy_codepoint = !!use_legacy;
}

int SSL_clear(SSL *ssl) {
  if (!ssl->config) {
    return 0;  // SSL_clear may not be used after shedding config.
  }

  // In OpenSSL, reusing a client |SSL| with |SSL_clear| causes the previously
  // established session to be offered the next time around. wpa_supplicant
  // depends on this behavior, so emulate it.
  UniquePtr<SSL_SESSION> session;
  if (!ssl->server && ssl->s3->established_session != nullptr) {
    session = UpRef(ssl->s3->established_session);
  }

  // The ssl->d1->mtu is simultaneously configuration (preserved across
  // clear) and connection-specific state (gets reset).
  //
  // TODO(davidben): Avoid this.
  unsigned mtu = 0;
  if (ssl->d1 != nullptr) {
    mtu = ssl->d1->mtu;
  }

  ssl->method->ssl_free(ssl);
  if (!ssl->method->ssl_new(ssl)) {
    return 0;
  }

  if (SSL_is_dtls(ssl) && (SSL_get_options(ssl) & SSL_OP_NO_QUERY_MTU)) {
    ssl->d1->mtu = mtu;
  }

  if (session != nullptr) {
    SSL_set_session(ssl, session.get());
  }

  return 1;
}

int SSL_CTX_sess_connect(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_connect_good(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_connect_renegotiate(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_accept(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_accept_renegotiate(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_accept_good(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_hits(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_cb_hits(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_misses(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_timeouts(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_sess_cache_full(const SSL_CTX *ctx) { return 0; }

int SSL_num_renegotiations(const SSL *ssl) {
  return SSL_total_renegotiations(ssl);
}

int SSL_CTX_need_tmp_RSA(const SSL_CTX *ctx) { return 0; }
int SSL_need_tmp_RSA(const SSL *ssl) { return 0; }
int SSL_CTX_set_tmp_rsa(SSL_CTX *ctx, const RSA *rsa) { return 1; }
int SSL_set_tmp_rsa(SSL *ssl, const RSA *rsa) { return 1; }
void ERR_load_SSL_strings(void) {}
void SSL_load_error_strings(void) {}
int SSL_cache_hit(SSL *ssl) { return SSL_session_reused(ssl); }

int SSL_CTX_set_tmp_ecdh(SSL_CTX *ctx, const EC_KEY *ec_key) {
  if (ec_key == nullptr || EC_KEY_get0_group(ec_key) == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  int nid = EC_GROUP_get_curve_name(EC_KEY_get0_group(ec_key));
  return SSL_CTX_set1_groups(ctx, &nid, 1);
}

int SSL_set_tmp_ecdh(SSL *ssl, const EC_KEY *ec_key) {
  if (ec_key == nullptr || EC_KEY_get0_group(ec_key) == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  int nid = EC_GROUP_get_curve_name(EC_KEY_get0_group(ec_key));
  return SSL_set1_groups(ssl, &nid, 1);
}

void SSL_CTX_set_ticket_aead_method(SSL_CTX *ctx,
                                    const SSL_TICKET_AEAD_METHOD *aead_method) {
  ctx->ticket_aead_method = aead_method;
}

SSL_SESSION *SSL_process_tls13_new_session_ticket(SSL *ssl, const uint8_t *buf,
                                                  size_t buf_len) {
  if (SSL_in_init(ssl) ||                             //
      ssl_protocol_version(ssl) != TLS1_3_VERSION ||  //
      ssl->server) {
    // Only TLS 1.3 clients are supported.
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return nullptr;
  }

  CBS cbs, body;
  CBS_init(&cbs, buf, buf_len);
  uint8_t type;
  if (!CBS_get_u8(&cbs, &type) ||                   //
      !CBS_get_u24_length_prefixed(&cbs, &body) ||  //
      CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return nullptr;
  }

  UniquePtr<SSL_SESSION> session = tls13_create_session_with_ticket(ssl, &body);
  if (!session) {
    // |tls13_create_session_with_ticket| puts the correct error.
    return nullptr;
  }
  return session.release();
}

int SSL_CTX_set_num_tickets(SSL_CTX *ctx, size_t num_tickets) {
  num_tickets = std::min(num_tickets, kMaxTickets);
  static_assert(kMaxTickets <= 0xff, "Too many tickets.");
  ctx->num_tickets = static_cast<uint8_t>(num_tickets);
  return 1;
}

size_t SSL_CTX_get_num_tickets(const SSL_CTX *ctx) { return ctx->num_tickets; }

int SSL_set_tlsext_status_type(SSL *ssl, int type) {
  if (!ssl->config) {
    return 0;
  }
  ssl->config->ocsp_stapling_enabled = type == TLSEXT_STATUSTYPE_ocsp;
  return 1;
}

int SSL_get_tlsext_status_type(const SSL *ssl) {
  if (ssl->server) {
    SSL_HANDSHAKE *hs = ssl->s3->hs.get();
    return hs != nullptr && hs->ocsp_stapling_requested
               ? TLSEXT_STATUSTYPE_ocsp
               : TLSEXT_STATUSTYPE_nothing;
  }

  return ssl->config != nullptr && ssl->config->ocsp_stapling_enabled
             ? TLSEXT_STATUSTYPE_ocsp
             : TLSEXT_STATUSTYPE_nothing;
}

int SSL_set_tlsext_status_ocsp_resp(SSL *ssl, uint8_t *resp, size_t resp_len) {
  if (SSL_set_ocsp_response(ssl, resp, resp_len)) {
    OPENSSL_free(resp);
    return 1;
  }
  return 0;
}

size_t SSL_get_tlsext_status_ocsp_resp(const SSL *ssl, const uint8_t **out) {
  size_t ret;
  SSL_get0_ocsp_response(ssl, out, &ret);
  return ret;
}

int SSL_CTX_set_tlsext_status_cb(SSL_CTX *ctx,
                                 int (*callback)(SSL *ssl, void *arg)) {
  ctx->legacy_ocsp_callback = callback;
  return 1;
}

int SSL_CTX_set_tlsext_status_arg(SSL_CTX *ctx, void *arg) {
  ctx->legacy_ocsp_callback_arg = arg;
  return 1;
}

uint16_t SSL_get_curve_id(const SSL *ssl) { return SSL_get_group_id(ssl); }

const char *SSL_get_curve_name(uint16_t curve_id) {
  return SSL_get_group_name(curve_id);
}

size_t SSL_get_all_curve_names(const char **out, size_t max_out) {
  return SSL_get_all_group_names(out, max_out);
}

int SSL_CTX_set1_curves(SSL_CTX *ctx, const int *curves, size_t num_curves) {
  return SSL_CTX_set1_groups(ctx, curves, num_curves);
}

int SSL_set1_curves(SSL *ssl, const int *curves, size_t num_curves) {
  return SSL_set1_groups(ssl, curves, num_curves);
}

int SSL_CTX_set1_curves_list(SSL_CTX *ctx, const char *curves) {
  return SSL_CTX_set1_groups_list(ctx, curves);
}

int SSL_set1_curves_list(SSL *ssl, const char *curves) {
  return SSL_set1_groups_list(ssl, curves);
}

namespace fips202205 {

// (References are to SP 800-52r2):

// Section 3.4.2.2
// "at least one of the NIST-approved curves, P-256 (secp256r1) and P384
// (secp384r1), shall be supported as described in RFC 8422."
//
// Section 3.3.1
// "The server shall be configured to only use cipher suites that are
// composed entirely of NIST approved algorithms"
static const uint16_t kGroups[] = {SSL_GROUP_SECP256R1, SSL_GROUP_SECP384R1};

static const uint16_t kSigAlgs[] = {
    SSL_SIGN_RSA_PKCS1_SHA256,
    SSL_SIGN_RSA_PKCS1_SHA384,
    SSL_SIGN_RSA_PKCS1_SHA512,
    // Table 4.1:
    // "The curve should be P-256 or P-384"
    SSL_SIGN_ECDSA_SECP256R1_SHA256,
    SSL_SIGN_ECDSA_SECP384R1_SHA384,
    SSL_SIGN_RSA_PSS_RSAE_SHA256,
    SSL_SIGN_RSA_PSS_RSAE_SHA384,
    SSL_SIGN_RSA_PSS_RSAE_SHA512,
};

static const char kTLS12Ciphers[] =
    "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:"
    "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:"
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:"
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384";

static int Configure(SSL_CTX *ctx) {
  ctx->compliance_policy = ssl_compliance_policy_fips_202205;

  return
      // Section 3.1:
      // "Servers that support government-only applications shall be
      // configured to use TLS 1.2 and should be configured to use TLS 1.3
      // as well. These servers should not be configured to use TLS 1.1 and
      // shall not use TLS 1.0, SSL 3.0, or SSL 2.0.
      SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION) &&
      SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION) &&
      // Sections 3.3.1.1.1 and 3.3.1.1.2 are ambiguous about whether
      // HMAC-SHA-1 cipher suites are permitted with TLS 1.2. However, later the
      // Encrypt-then-MAC extension is required for all CBC cipher suites and so
      // it's easier to drop them.
      SSL_CTX_set_strict_cipher_list(ctx, kTLS12Ciphers) &&
      SSL_CTX_set1_group_ids(ctx, kGroups, std::size(kGroups)) &&
      SSL_CTX_set_signing_algorithm_prefs(ctx, kSigAlgs, std::size(kSigAlgs)) &&
      SSL_CTX_set_verify_algorithm_prefs(ctx, kSigAlgs, std::size(kSigAlgs));
}

static int Configure(SSL *ssl) {
  ssl->config->compliance_policy = ssl_compliance_policy_fips_202205;

  // See |Configure(SSL_CTX)|, above, for reasoning.
  return SSL_set_min_proto_version(ssl, TLS1_2_VERSION) &&
         SSL_set_max_proto_version(ssl, TLS1_3_VERSION) &&
         SSL_set_strict_cipher_list(ssl, kTLS12Ciphers) &&
         SSL_set1_group_ids(ssl, kGroups, std::size(kGroups)) &&
         SSL_set_signing_algorithm_prefs(ssl, kSigAlgs, std::size(kSigAlgs)) &&
         SSL_set_verify_algorithm_prefs(ssl, kSigAlgs, std::size(kSigAlgs));
}

}  // namespace fips202205

namespace wpa202304 {

// See WPA version 3.1, section 3.5.

static const uint16_t kGroups[] = {SSL_GROUP_SECP384R1};

static const uint16_t kSigAlgs[] = {
    SSL_SIGN_RSA_PKCS1_SHA384,        //
    SSL_SIGN_RSA_PKCS1_SHA512,        //
    SSL_SIGN_ECDSA_SECP384R1_SHA384,  //
    SSL_SIGN_RSA_PSS_RSAE_SHA384,     //
    SSL_SIGN_RSA_PSS_RSAE_SHA512,     //
};

static const char kTLS12Ciphers[] =
    "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:"
    "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384";

static int Configure(SSL_CTX *ctx) {
  ctx->compliance_policy = ssl_compliance_policy_wpa3_192_202304;

  return SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION) &&
         SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION) &&
         SSL_CTX_set_strict_cipher_list(ctx, kTLS12Ciphers) &&
         SSL_CTX_set1_group_ids(ctx, kGroups, std::size(kGroups)) &&
         SSL_CTX_set_signing_algorithm_prefs(ctx, kSigAlgs,
                                             std::size(kSigAlgs)) &&
         SSL_CTX_set_verify_algorithm_prefs(ctx, kSigAlgs, std::size(kSigAlgs));
}

static int Configure(SSL *ssl) {
  ssl->config->compliance_policy = ssl_compliance_policy_wpa3_192_202304;

  return SSL_set_min_proto_version(ssl, TLS1_2_VERSION) &&
         SSL_set_max_proto_version(ssl, TLS1_3_VERSION) &&
         SSL_set_strict_cipher_list(ssl, kTLS12Ciphers) &&
         SSL_set1_group_ids(ssl, kGroups, std::size(kGroups)) &&
         SSL_set_signing_algorithm_prefs(ssl, kSigAlgs, std::size(kSigAlgs)) &&
         SSL_set_verify_algorithm_prefs(ssl, kSigAlgs, std::size(kSigAlgs));
}

}  // namespace wpa202304

namespace cnsa202407 {

static int Configure(SSL_CTX *ctx) {
  ctx->compliance_policy = ssl_compliance_policy_cnsa_202407;
  return 1;
}

static int Configure(SSL *ssl) {
  ssl->config->compliance_policy = ssl_compliance_policy_cnsa_202407;
  return 1;
}

}  // namespace cnsa202407

int SSL_CTX_set_compliance_policy(SSL_CTX *ctx,
                                  enum ssl_compliance_policy_t policy) {
  switch (policy) {
    case ssl_compliance_policy_fips_202205:
      return fips202205::Configure(ctx);
    case ssl_compliance_policy_wpa3_192_202304:
      return wpa202304::Configure(ctx);
    case ssl_compliance_policy_cnsa_202407:
      return cnsa202407::Configure(ctx);
    default:
      return 0;
  }
}

enum ssl_compliance_policy_t SSL_CTX_get_compliance_policy(const SSL_CTX *ctx) {
  return ctx->compliance_policy;
}

int SSL_set_compliance_policy(SSL *ssl, enum ssl_compliance_policy_t policy) {
  switch (policy) {
    case ssl_compliance_policy_fips_202205:
      return fips202205::Configure(ssl);
    case ssl_compliance_policy_wpa3_192_202304:
      return wpa202304::Configure(ssl);
    case ssl_compliance_policy_cnsa_202407:
      return cnsa202407::Configure(ssl);
    default:
      return 0;
  }
}

enum ssl_compliance_policy_t SSL_get_compliance_policy(const SSL *ssl) {
  return ssl->config->compliance_policy;
}

int SSL_peer_matched_trust_anchor(const SSL *ssl) {
  return ssl->s3->hs != nullptr && ssl->s3->hs->peer_matched_trust_anchor;
}

void SSL_get0_peer_available_trust_anchors(const SSL *ssl, const uint8_t **out,
                                           size_t *out_len) {
  Span<const uint8_t> ret;
  if (SSL_HANDSHAKE *hs = ssl->s3->hs.get(); hs != nullptr) {
    ret = hs->peer_available_trust_anchors;
  }
  *out = ret.data();
  *out_len = ret.size();
}

int SSL_CTX_set1_requested_trust_anchors(SSL_CTX *ctx, const uint8_t *ids,
                                         size_t ids_len) {
  auto span = Span(ids, ids_len);
  if (!ssl_is_valid_trust_anchor_list(span)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_TRUST_ANCHOR_LIST);
    return 0;
  }
  Array<uint8_t> copy;
  if (!copy.CopyFrom(span)) {
    return 0;
  }
  ctx->requested_trust_anchors = std::move(copy);
  return 1;
}

int SSL_set1_requested_trust_anchors(SSL *ssl, const uint8_t *ids,
                                     size_t ids_len) {
  if (!ssl->config) {
    return 0;
  }
  auto span = Span(ids, ids_len);
  if (!ssl_is_valid_trust_anchor_list(span)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_TRUST_ANCHOR_LIST);
    return 0;
  }
  Array<uint8_t> copy;
  if (!copy.CopyFrom(span)) {
    return 0;
  }
  ssl->config->requested_trust_anchors = std::move(copy);
  return 1;
}

int SSL_CTX_get_security_level(const SSL_CTX *ctx) { return 0; }
