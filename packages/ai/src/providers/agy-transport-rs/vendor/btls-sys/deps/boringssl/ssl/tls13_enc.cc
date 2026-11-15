// Copyright 2016 The BoringSSL Authors
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

#include <algorithm>
#include <string_view>
#include <utility>

#include <openssl/aead.h>
#include <openssl/aes.h>
#include <openssl/bytestring.h>
#include <openssl/chacha.h>
#include <openssl/digest.h>
#include <openssl/hkdf.h>
#include <openssl/hmac.h>
#include <openssl/mem.h>

#include "../crypto/fipsmodule/tls/internal.h"
#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

static bool init_key_schedule(SSL_HANDSHAKE *hs, SSLTranscript *transcript,
                              uint16_t version, const SSL_CIPHER *cipher) {
  if (!transcript->InitHash(version, cipher)) {
    return false;
  }

  // Initialize the secret to the zero key.
  hs->secret.clear();
  hs->secret.Resize(transcript->DigestLen());
  return true;
}

static bool hkdf_extract_to_secret(SSL_HANDSHAKE *hs,
                                   const SSLTranscript &transcript,
                                   Span<const uint8_t> in) {
  size_t len;
  if (!HKDF_extract(hs->secret.data(), &len, transcript.Digest(), in.data(),
                    in.size(), hs->secret.data(), hs->secret.size())) {
    return false;
  }
  assert(len == hs->secret.size());
  return true;
}

bool tls13_init_key_schedule(SSL_HANDSHAKE *hs, Span<const uint8_t> psk) {
  if (!init_key_schedule(hs, &hs->transcript, ssl_protocol_version(hs->ssl),
                         hs->new_cipher)) {
    return false;
  }

  // Handback includes the whole handshake transcript, so we cannot free the
  // transcript buffer in the handback case.
  if (!hs->handback) {
    hs->transcript.FreeBuffer();
  }
  return hkdf_extract_to_secret(hs, hs->transcript, psk);
}

bool tls13_init_early_key_schedule(SSL_HANDSHAKE *hs,
                                   const SSL_SESSION *session) {
  assert(!hs->ssl->server);
  // When offering ECH, early data is associated with ClientHelloInner, not
  // ClientHelloOuter.
  SSLTranscript *transcript =
      hs->selected_ech_config ? &hs->inner_transcript : &hs->transcript;
  return init_key_schedule(hs, transcript,
                           ssl_session_protocol_version(session),
                           session->cipher) &&
         hkdf_extract_to_secret(hs, *transcript, session->secret);
}

static bool hkdf_expand_label_with_prefix(Span<uint8_t> out,
                                          const EVP_MD *digest,
                                          Span<const uint8_t> secret,
                                          std::string_view label_prefix,
                                          std::string_view label,
                                          Span<const uint8_t> hash) {
  // This is a copy of CRYPTO_tls13_hkdf_expand_label, but modified to take an
  // arbitrary prefix for the label instead of using the hardcoded "tls13 "
  // prefix.
  CBB cbb, child;
  uint8_t *hkdf_label = nullptr;
  size_t hkdf_label_len;
  CBB_zero(&cbb);
  if (!CBB_init(&cbb,
                2 + 1 + label_prefix.size() + label.size() + 1 + hash.size()) ||
      !CBB_add_u16(&cbb, out.size()) ||
      !CBB_add_u8_length_prefixed(&cbb, &child) ||
      !CBB_add_bytes(&child,
                     reinterpret_cast<const uint8_t *>(label_prefix.data()),
                     label_prefix.size()) ||
      !CBB_add_bytes(&child, reinterpret_cast<const uint8_t *>(label.data()),
                     label.size()) ||
      !CBB_add_u8_length_prefixed(&cbb, &child) ||
      !CBB_add_bytes(&child, hash.data(), hash.size()) ||
      !CBB_finish(&cbb, &hkdf_label, &hkdf_label_len)) {
    CBB_cleanup(&cbb);
    return false;
  }

  const int ret = HKDF_expand(out.data(), out.size(), digest, secret.data(),
                              secret.size(), hkdf_label, hkdf_label_len);
  OPENSSL_free(hkdf_label);
  return ret == 1;
}

static bool hkdf_expand_label(Span<uint8_t> out, const EVP_MD *digest,
                              Span<const uint8_t> secret,
                              std::string_view label, Span<const uint8_t> hash,
                              bool is_dtls) {
  if (is_dtls) {
    return hkdf_expand_label_with_prefix(out, digest, secret, "dtls13", label,
                                         hash);
  }
  return CRYPTO_tls13_hkdf_expand_label(
             out.data(), out.size(), digest, secret.data(), secret.size(),
             reinterpret_cast<const uint8_t *>(label.data()), label.size(),
             hash.data(), hash.size()) == 1;
}

static const char kTLS13LabelDerived[] = "derived";

bool tls13_advance_key_schedule(SSL_HANDSHAKE *hs, Span<const uint8_t> in) {
  uint8_t derive_context[EVP_MAX_MD_SIZE];
  unsigned derive_context_len;
  return EVP_Digest(nullptr, 0, derive_context, &derive_context_len,
                    hs->transcript.Digest(), nullptr) &&
         hkdf_expand_label(Span(hs->secret), hs->transcript.Digest(),
                           hs->secret, kTLS13LabelDerived,
                           Span(derive_context, derive_context_len),
                           SSL_is_dtls(hs->ssl)) &&
         hkdf_extract_to_secret(hs, hs->transcript, in);
}

// derive_secret_with_transcript derives a secret of length
// |transcript.DigestLen()| and writes the result in |out| with the given label,
// the current base secret, and the state of |transcript|. It returns true on
// success and false on error.
static bool derive_secret_with_transcript(
    const SSL_HANDSHAKE *hs, InplaceVector<uint8_t, SSL_MAX_MD_SIZE> *out,
    const SSLTranscript &transcript, std::string_view label) {
  uint8_t context_hash[EVP_MAX_MD_SIZE];
  size_t context_hash_len;
  if (!transcript.GetHash(context_hash, &context_hash_len)) {
    return false;
  }

  out->ResizeForOverwrite(transcript.DigestLen());
  return hkdf_expand_label(Span(*out), transcript.Digest(), hs->secret, label,
                           Span(context_hash, context_hash_len),
                           SSL_is_dtls(hs->ssl));
}

static bool derive_secret(SSL_HANDSHAKE *hs,
                          InplaceVector<uint8_t, SSL_MAX_MD_SIZE> *out,
                          std::string_view label) {
  return derive_secret_with_transcript(hs, out, hs->transcript, label);
}

bool tls13_set_traffic_key(SSL *ssl, enum ssl_encryption_level_t level,
                           enum evp_aead_direction_t direction,
                           const SSL_SESSION *session,
                           Span<const uint8_t> traffic_secret) {
  uint16_t version = ssl_session_protocol_version(session);
  const EVP_MD *digest = ssl_session_get_digest(session);
  bool is_dtls = SSL_is_dtls(ssl);
  UniquePtr<SSLAEADContext> traffic_aead;
  if (SSL_is_quic(ssl)) {
    // Install a placeholder SSLAEADContext so that SSL accessors work. The
    // encryption itself will be handled by the SSL_QUIC_METHOD.
    traffic_aead = SSLAEADContext::CreatePlaceholderForQUIC(session->cipher);
  } else {
    // Look up cipher suite properties.
    const EVP_AEAD *aead;
    size_t discard;
    if (!ssl_cipher_get_evp_aead(&aead, &discard, &discard, session->cipher,
                                 version)) {
      return false;
    }

    // Derive the key and IV.
    uint8_t key_buf[EVP_AEAD_MAX_KEY_LENGTH], iv_buf[EVP_AEAD_MAX_NONCE_LENGTH];
    auto key = Span(key_buf).first(EVP_AEAD_key_length(aead));
    auto iv = Span(iv_buf).first(EVP_AEAD_nonce_length(aead));
    if (!hkdf_expand_label(key, digest, traffic_secret, "key", {}, is_dtls) ||
        !hkdf_expand_label(iv, digest, traffic_secret, "iv", {}, is_dtls)) {
      return false;
    }

    traffic_aead = SSLAEADContext::Create(direction, session->ssl_version,
                                          session->cipher, key, {}, iv);
  }

  if (!traffic_aead) {
    return false;
  }

  if (direction == evp_aead_open) {
    if (!ssl->method->set_read_state(ssl, level, std::move(traffic_aead),
                                     traffic_secret)) {
      return false;
    }
    ssl->s3->read_traffic_secret.CopyFrom(traffic_secret);
  } else {
    if (!ssl->method->set_write_state(ssl, level, std::move(traffic_aead),
                                      traffic_secret)) {
      return false;
    }
    ssl->s3->write_traffic_secret.CopyFrom(traffic_secret);
  }

  return true;
}

namespace {

class AESRecordNumberEncrypter : public RecordNumberEncrypter {
 public:
  bool SetKey(Span<const uint8_t> key) override {
    return AES_set_encrypt_key(key.data(), key.size() * 8, &key_) == 0;
  }

  bool GenerateMask(Span<uint8_t> out, Span<const uint8_t> sample) override {
    if (sample.size() < AES_BLOCK_SIZE || out.size() > AES_BLOCK_SIZE) {
      return false;
    }
    uint8_t mask[AES_BLOCK_SIZE];
    AES_encrypt(sample.data(), mask, &key_);
    OPENSSL_memcpy(out.data(), mask, out.size());
    return true;
  }

 private:
  AES_KEY key_;
};

class AES128RecordNumberEncrypter : public AESRecordNumberEncrypter {
 public:
  size_t KeySize() override { return 16; }
};

class AES256RecordNumberEncrypter : public AESRecordNumberEncrypter {
 public:
  size_t KeySize() override { return 32; }
};

class ChaChaRecordNumberEncrypter : public RecordNumberEncrypter {
 public:
  size_t KeySize() override { return kKeySize; }

  bool SetKey(Span<const uint8_t> key) override {
    if (key.size() != kKeySize) {
      return false;
    }
    OPENSSL_memcpy(key_, key.data(), key.size());
    return true;
  }

  bool GenerateMask(Span<uint8_t> out, Span<const uint8_t> sample) override {
    // RFC 9147 section 4.2.3 uses the first 4 bytes of the sample as the
    // counter and the next 12 bytes as the nonce. If we have less than 4+12=16
    // bytes in the sample, then we'll read past the end of the |sample| buffer.
    // The counter is interpreted as little-endian per RFC 8439.
    if (sample.size() < 16) {
      return false;
    }
    uint32_t counter = CRYPTO_load_u32_le(sample.data());
    auto nonce = sample.subspan<4>();
    OPENSSL_memset(out.data(), 0, out.size());
    CRYPTO_chacha_20(out.data(), out.data(), out.size(), key_, nonce.data(),
                     counter);
    return true;
  }

 private:
  static constexpr size_t kKeySize = 32;
  uint8_t key_[kKeySize];
};

class NullRecordNumberEncrypter : public RecordNumberEncrypter {
 public:
  size_t KeySize() override { return 0; }
  bool SetKey(Span<const uint8_t> key) override { return true; }
  bool GenerateMask(Span<uint8_t> out, Span<const uint8_t> sample) override {
    OPENSSL_memset(out.data(), 0, out.size());
    return true;
  }
};

}  // namespace

UniquePtr<RecordNumberEncrypter> RecordNumberEncrypter::Create(
    const SSL_CIPHER *cipher, Span<const uint8_t> traffic_secret) {
  const EVP_MD *digest = ssl_get_handshake_digest(TLS1_3_VERSION, cipher);
  UniquePtr<RecordNumberEncrypter> ret;
  if (CRYPTO_fuzzer_mode_enabled()) {
    ret = MakeUnique<NullRecordNumberEncrypter>();
  } else if (cipher->algorithm_enc == SSL_AES128GCM) {
    ret = MakeUnique<AES128RecordNumberEncrypter>();
  } else if (cipher->algorithm_enc == SSL_AES256GCM) {
    ret = MakeUnique<AES256RecordNumberEncrypter>();
  } else if (cipher->algorithm_enc == SSL_CHACHA20POLY1305) {
    ret = MakeUnique<ChaChaRecordNumberEncrypter>();
  } else {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
  }
  if (ret == nullptr) {
    return nullptr;
  }

  uint8_t rne_key_buf[RecordNumberEncrypter::kMaxKeySize];
  auto rne_key = Span(rne_key_buf).first(ret->KeySize());
  if (!hkdf_expand_label(rne_key, digest, traffic_secret, "sn", {},
                         /*is_dtls=*/true) ||
      !ret->SetKey(rne_key)) {
    return nullptr;
  }
  return ret;
}

static const char kTLS13LabelExporter[] = "exp master";

static const char kTLS13LabelClientEarlyTraffic[] = "c e traffic";
static const char kTLS13LabelClientHandshakeTraffic[] = "c hs traffic";
static const char kTLS13LabelServerHandshakeTraffic[] = "s hs traffic";
static const char kTLS13LabelClientApplicationTraffic[] = "c ap traffic";
static const char kTLS13LabelServerApplicationTraffic[] = "s ap traffic";

bool tls13_derive_early_secret(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  // When offering ECH on the client, early data is associated with
  // ClientHelloInner, not ClientHelloOuter.
  const SSLTranscript &transcript = (!ssl->server && hs->selected_ech_config)
                                        ? hs->inner_transcript
                                        : hs->transcript;
  if (!derive_secret_with_transcript(hs, &hs->early_traffic_secret, transcript,
                                     kTLS13LabelClientEarlyTraffic) ||
      !ssl_log_secret(ssl, "CLIENT_EARLY_TRAFFIC_SECRET",
                      hs->early_traffic_secret)) {
    return false;
  }
  return true;
}

bool tls13_derive_handshake_secrets(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  if (!derive_secret(hs, &hs->client_handshake_secret,
                     kTLS13LabelClientHandshakeTraffic) ||
      !ssl_log_secret(ssl, "CLIENT_HANDSHAKE_TRAFFIC_SECRET",
                      hs->client_handshake_secret) ||
      !derive_secret(hs, &hs->server_handshake_secret,
                     kTLS13LabelServerHandshakeTraffic) ||
      !ssl_log_secret(ssl, "SERVER_HANDSHAKE_TRAFFIC_SECRET",
                      hs->server_handshake_secret)) {
    return false;
  }

  return true;
}

bool tls13_derive_application_secrets(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  if (!derive_secret(hs, &hs->client_traffic_secret_0,
                     kTLS13LabelClientApplicationTraffic) ||
      !ssl_log_secret(ssl, "CLIENT_TRAFFIC_SECRET_0",
                      hs->client_traffic_secret_0) ||
      !derive_secret(hs, &hs->server_traffic_secret_0,
                     kTLS13LabelServerApplicationTraffic) ||
      !ssl_log_secret(ssl, "SERVER_TRAFFIC_SECRET_0",
                      hs->server_traffic_secret_0) ||
      !derive_secret(hs, &ssl->s3->exporter_secret, kTLS13LabelExporter) ||
      !ssl_log_secret(ssl, "EXPORTER_SECRET", ssl->s3->exporter_secret)) {
    return false;
  }

  return true;
}

static const char kTLS13LabelApplicationTraffic[] = "traffic upd";

bool tls13_rotate_traffic_key(SSL *ssl, enum evp_aead_direction_t direction) {
  Span<uint8_t> secret = direction == evp_aead_open
                             ? Span(ssl->s3->read_traffic_secret)
                             : Span(ssl->s3->write_traffic_secret);

  const SSL_SESSION *session = SSL_get_session(ssl);
  const EVP_MD *digest = ssl_session_get_digest(session);
  return hkdf_expand_label(secret, digest, secret,
                           kTLS13LabelApplicationTraffic, {},
                           SSL_is_dtls(ssl)) &&
         tls13_set_traffic_key(ssl, ssl_encryption_application, direction,
                               session, secret);
}

static const char kTLS13LabelResumption[] = "res master";

bool tls13_derive_resumption_secret(SSL_HANDSHAKE *hs) {
  return derive_secret(hs, &hs->new_session->secret, kTLS13LabelResumption);
}

static const char kTLS13LabelFinished[] = "finished";

// tls13_verify_data sets |out| to be the HMAC of |context| using a derived
// Finished key for both Finished messages and the PSK binder. |out| must have
// space available for |EVP_MAX_MD_SIZE| bytes.
static bool tls13_verify_data(uint8_t *out, size_t *out_len,
                              const EVP_MD *digest, uint16_t version,
                              Span<const uint8_t> secret,
                              Span<const uint8_t> context, bool is_dtls) {
  uint8_t key_buf[EVP_MAX_MD_SIZE];
  auto key = Span(key_buf, EVP_MD_size(digest));
  unsigned len;
  if (!hkdf_expand_label(key, digest, secret, kTLS13LabelFinished, {},
                         is_dtls) ||
      HMAC(digest, key.data(), key.size(), context.data(), context.size(), out,
           &len) == nullptr) {
    return false;
  }
  *out_len = len;
  return true;
}

bool tls13_finished_mac(SSL_HANDSHAKE *hs, uint8_t *out, size_t *out_len,
                        bool is_server) {
  Span<const uint8_t> traffic_secret =
      is_server ? hs->server_handshake_secret : hs->client_handshake_secret;

  uint8_t context_hash[EVP_MAX_MD_SIZE];
  size_t context_hash_len;
  if (!hs->transcript.GetHash(context_hash, &context_hash_len) ||
      !tls13_verify_data(out, out_len, hs->transcript.Digest(),
                         hs->ssl->s3->version, traffic_secret,
                         Span(context_hash, context_hash_len),
                         SSL_is_dtls(hs->ssl))) {
    return false;
  }
  return true;
}

static const char kTLS13LabelResumptionPSK[] = "resumption";

bool tls13_derive_session_psk(SSL_SESSION *session, Span<const uint8_t> nonce,
                              bool is_dtls) {
  const EVP_MD *digest = ssl_session_get_digest(session);
  // The session initially stores the resumption_master_secret, which we
  // override with the PSK.
  assert(session->secret.size() == EVP_MD_size(digest));
  return hkdf_expand_label(Span(session->secret), digest, session->secret,
                           kTLS13LabelResumptionPSK, nonce, is_dtls);
}

static const char kTLS13LabelExportKeying[] = "exporter";

bool tls13_export_keying_material(const SSL *ssl, Span<uint8_t> out,
                                  Span<const uint8_t> secret,
                                  std::string_view label,
                                  Span<const uint8_t> context) {
  if (secret.empty()) {
    assert(0);
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const EVP_MD *digest = ssl_session_get_digest(SSL_get_session(ssl));

  uint8_t hash_buf[EVP_MAX_MD_SIZE];
  uint8_t export_context_buf[EVP_MAX_MD_SIZE];
  unsigned hash_len;
  unsigned export_context_len;
  if (!EVP_Digest(context.data(), context.size(), hash_buf, &hash_len, digest,
                  nullptr) ||
      !EVP_Digest(nullptr, 0, export_context_buf, &export_context_len, digest,
                  nullptr)) {
    return false;
  }

  auto hash = Span(hash_buf, hash_len);
  auto export_context = Span(export_context_buf, export_context_len);
  uint8_t derived_secret_buf[EVP_MAX_MD_SIZE];
  auto derived_secret = Span(derived_secret_buf, EVP_MD_size(digest));
  return hkdf_expand_label(derived_secret, digest, secret, label,
                           export_context, SSL_is_dtls(ssl)) &&
         hkdf_expand_label(out, digest, derived_secret, kTLS13LabelExportKeying,
                           hash, SSL_is_dtls(ssl));
}

static const char kTLS13LabelPSKBinder[] = "res binder";

static bool tls13_psk_binder(uint8_t *out, size_t *out_len,
                             const SSL_SESSION *session,
                             const SSLTranscript &transcript,
                             Span<const uint8_t> client_hello,
                             size_t binders_len, bool is_dtls) {
  const EVP_MD *digest = ssl_session_get_digest(session);

  // Compute the binder key.
  //
  // TODO(davidben): Ideally we wouldn't recompute early secret and the binder
  // key each time.
  uint8_t binder_context[EVP_MAX_MD_SIZE];
  unsigned binder_context_len;
  uint8_t early_secret[EVP_MAX_MD_SIZE] = {0};
  size_t early_secret_len;
  uint8_t binder_key_buf[EVP_MAX_MD_SIZE] = {0};
  auto binder_key = Span(binder_key_buf, EVP_MD_size(digest));
  if (!EVP_Digest(nullptr, 0, binder_context, &binder_context_len, digest,
                  nullptr) ||
      !HKDF_extract(early_secret, &early_secret_len, digest,
                    session->secret.data(), session->secret.size(), nullptr,
                    0) ||
      !hkdf_expand_label(binder_key, digest,
                         Span(early_secret, early_secret_len),
                         kTLS13LabelPSKBinder,
                         Span(binder_context, binder_context_len), is_dtls)) {
    return false;
  }

  // Hash the transcript and truncated ClientHello.
  if (client_hello.size() < binders_len) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }
  auto truncated = client_hello.subspan(0, client_hello.size() - binders_len);
  uint8_t context[EVP_MAX_MD_SIZE];
  unsigned context_len;
  ScopedEVP_MD_CTX ctx;
  if (!is_dtls) {
    if (!transcript.CopyToHashContext(ctx.get(), digest) ||
        !EVP_DigestUpdate(ctx.get(), truncated.data(), truncated.size()) ||
        !EVP_DigestFinal_ex(ctx.get(), context, &context_len)) {
      return false;
    }
  } else {
    // In DTLS 1.3, the transcript hash is computed over only the TLS 1.3
    // handshake messages (i.e. only type and length in the header), not the
    // full DTLSHandshake messages that are in |truncated|. This code pulls
    // the header and body out of the truncated ClientHello and writes those
    // to the hash context so the correct binder value is computed.
    if (truncated.size() < DTLS1_HM_HEADER_LENGTH) {
      return false;
    }
    auto header = truncated.first<4>();
    auto body = truncated.subspan<12>();
    if (!transcript.CopyToHashContext(ctx.get(), digest) ||
        !EVP_DigestUpdate(ctx.get(), header.data(), header.size()) ||
        !EVP_DigestUpdate(ctx.get(), body.data(), body.size()) ||
        !EVP_DigestFinal_ex(ctx.get(), context, &context_len)) {
      return false;
    }
  }

  if (!tls13_verify_data(out, out_len, digest, session->ssl_version, binder_key,
                         Span(context, context_len), is_dtls)) {
    return false;
  }

  assert(*out_len == EVP_MD_size(digest));
  return true;
}

bool tls13_write_psk_binder(const SSL_HANDSHAKE *hs,
                            const SSLTranscript &transcript, Span<uint8_t> msg,
                            size_t *out_binder_len) {
  const SSL *const ssl = hs->ssl;
  const EVP_MD *digest = ssl_session_get_digest(ssl->session.get());
  const size_t hash_len = EVP_MD_size(digest);
  // We only offer one PSK, so the binders are a u16 and u8 length
  // prefix, followed by the binder. The caller is assumed to have constructed
  // |msg| with placeholder binders.
  const size_t binders_len = 3 + hash_len;
  uint8_t verify_data[EVP_MAX_MD_SIZE];
  size_t verify_data_len;
  if (!tls13_psk_binder(verify_data, &verify_data_len, ssl->session.get(),
                        transcript, msg, binders_len, SSL_is_dtls(hs->ssl)) ||
      verify_data_len != hash_len) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  auto msg_binder = msg.last(verify_data_len);
  OPENSSL_memcpy(msg_binder.data(), verify_data, verify_data_len);
  if (out_binder_len != nullptr) {
    *out_binder_len = verify_data_len;
  }
  return true;
}

bool tls13_verify_psk_binder(const SSL_HANDSHAKE *hs,
                             const SSL_SESSION *session, const SSLMessage &msg,
                             CBS *binders) {
  uint8_t verify_data[EVP_MAX_MD_SIZE];
  size_t verify_data_len;
  CBS binder;
  // The binders are computed over |msg| with |binders| and its u16 length
  // prefix removed. The caller is assumed to have parsed |msg|, extracted
  // |binders|, and verified the PSK extension is last.
  if (!tls13_psk_binder(verify_data, &verify_data_len, session, hs->transcript,
                        msg.raw, 2 + CBS_len(binders), SSL_is_dtls(hs->ssl)) ||
      // We only consider the first PSK, so compare against the first binder.
      !CBS_get_u8_length_prefixed(binders, &binder)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  bool binder_ok =
      CBS_len(&binder) == verify_data_len &&
      CRYPTO_memcmp(CBS_data(&binder), verify_data, verify_data_len) == 0;
  if (CRYPTO_fuzzer_mode_enabled()) {
    binder_ok = true;
  }
  if (!binder_ok) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DIGEST_CHECK_FAILED);
    return false;
  }

  return true;
}

size_t ssl_ech_confirmation_signal_hello_offset(const SSL *ssl) {
  static_assert(ECH_CONFIRMATION_SIGNAL_LEN < SSL3_RANDOM_SIZE,
                "the confirmation signal is a suffix of the random");
  const size_t header_len =
      SSL_is_dtls(ssl) ? DTLS1_HM_HEADER_LENGTH : SSL3_HM_HEADER_LENGTH;
  return header_len + 2 /* version */ + SSL3_RANDOM_SIZE -
         ECH_CONFIRMATION_SIGNAL_LEN;
}

bool ssl_ech_accept_confirmation(
    const SSL_HANDSHAKE *hs, Span<uint8_t, ECH_CONFIRMATION_SIGNAL_LEN> out,
    Span<const uint8_t, SSL3_RANDOM_SIZE> client_random,
    const SSLTranscript &transcript, bool is_hrr, Span<const uint8_t> msg,
    size_t offset) {
  // See draft-ietf-tls-esni-13, sections 7.2 and 7.2.1.
  static const uint8_t kZeros[EVP_MAX_MD_SIZE] = {0};

  // We hash |msg|, with bytes from |offset| zeroed.
  if (msg.size() < offset + ECH_CONFIRMATION_SIGNAL_LEN) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // We represent DTLS messages with the longer DTLS 1.2 header, but DTLS 1.3
  // removes the extra fields from the transcript.
  //
  // Size bound implied by ECH_CONFIRMATION_SIGNAL_LEN >= SSL3_HM_HEADER_LENGTH.
  auto header = msg.first<SSL3_HM_HEADER_LENGTH>();
  size_t full_header_len =
      SSL_is_dtls(hs->ssl) ? DTLS1_HM_HEADER_LENGTH : SSL3_HM_HEADER_LENGTH;
  auto before_zeros = msg.subspan(full_header_len, offset - full_header_len);
  auto after_zeros = msg.subspan(offset + ECH_CONFIRMATION_SIGNAL_LEN);

  uint8_t context[EVP_MAX_MD_SIZE];
  unsigned context_len;
  ScopedEVP_MD_CTX ctx;
  if (!transcript.CopyToHashContext(ctx.get(), transcript.Digest()) ||
      !EVP_DigestUpdate(ctx.get(), header.data(), header.size()) ||
      !EVP_DigestUpdate(ctx.get(), before_zeros.data(), before_zeros.size()) ||
      !EVP_DigestUpdate(ctx.get(), kZeros, ECH_CONFIRMATION_SIGNAL_LEN) ||
      !EVP_DigestUpdate(ctx.get(), after_zeros.data(), after_zeros.size()) ||
      !EVP_DigestFinal_ex(ctx.get(), context, &context_len)) {
    return false;
  }

  uint8_t secret[EVP_MAX_MD_SIZE];
  size_t secret_len;
  if (!HKDF_extract(secret, &secret_len, transcript.Digest(),
                    client_random.data(), client_random.size(), kZeros,
                    transcript.DigestLen())) {
    return false;
  }

  return hkdf_expand_label(
      out, transcript.Digest(), Span(secret, secret_len),
      is_hrr ? "hrr ech accept confirmation" : "ech accept confirmation",
      Span(context, context_len), SSL_is_dtls(hs->ssl));
}

BSSL_NAMESPACE_END
