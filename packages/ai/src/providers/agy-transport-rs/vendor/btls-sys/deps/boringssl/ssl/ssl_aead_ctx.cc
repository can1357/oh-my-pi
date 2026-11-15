// Copyright 2015 The BoringSSL Authors
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

#include <openssl/aead.h>
#include <openssl/err.h>
#include <openssl/rand.h>

#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

SSLAEADContext::SSLAEADContext(const SSL_CIPHER *cipher_arg)
    : cipher_(cipher_arg),
      variable_nonce_included_in_record_(false),
      random_variable_nonce_(false),
      xor_fixed_nonce_(false),
      omit_length_in_ad_(false),
      ad_is_header_(false) {}

SSLAEADContext::~SSLAEADContext() {}

UniquePtr<SSLAEADContext> SSLAEADContext::CreateNullCipher() {
  return MakeUnique<SSLAEADContext>(/*cipher=*/nullptr);
}

UniquePtr<SSLAEADContext> SSLAEADContext::Create(
    enum evp_aead_direction_t direction, uint16_t version,
    const SSL_CIPHER *cipher, Span<const uint8_t> enc_key,
    Span<const uint8_t> mac_key, Span<const uint8_t> fixed_iv) {
  const EVP_AEAD *aead;
  uint16_t protocol_version;
  size_t expected_mac_key_len, expected_fixed_iv_len;
  if (!ssl_protocol_version_from_wire(&protocol_version, version) ||
      !ssl_cipher_get_evp_aead(&aead, &expected_mac_key_len,
                               &expected_fixed_iv_len, cipher,
                               protocol_version) ||
      // Ensure the caller returned correct key sizes.
      expected_fixed_iv_len != fixed_iv.size() ||
      expected_mac_key_len != mac_key.size()) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return nullptr;
  }

  UniquePtr<SSLAEADContext> aead_ctx = MakeUnique<SSLAEADContext>(cipher);
  if (!aead_ctx) {
    return nullptr;
  }

  uint8_t merged_key[EVP_AEAD_MAX_KEY_LENGTH];
  assert(EVP_AEAD_nonce_length(aead) <= EVP_AEAD_MAX_NONCE_LENGTH);
  static_assert(EVP_AEAD_MAX_NONCE_LENGTH < 256,
                "variable_nonce_len doesn't fit in uint8_t");
  aead_ctx->variable_nonce_len_ = (uint8_t)EVP_AEAD_nonce_length(aead);
  if (mac_key.empty()) {
    // This is an actual AEAD.
    aead_ctx->fixed_nonce_.CopyFrom(fixed_iv);

    if (protocol_version >= TLS1_3_VERSION ||
        cipher->algorithm_enc & SSL_CHACHA20POLY1305) {
      // TLS 1.3, and TLS 1.2 ChaCha20-Poly1305, XOR the fixed IV with the
      // sequence number to form the nonce.
      aead_ctx->xor_fixed_nonce_ = true;
      aead_ctx->variable_nonce_len_ = 8;
      assert(fixed_iv.size() >= aead_ctx->variable_nonce_len_);
    } else {
      // TLS 1.2 AES-GCM prepends the fixed IV to an explicit nonce.
      assert(fixed_iv.size() <= aead_ctx->variable_nonce_len_);
      assert(cipher->algorithm_enc & (SSL_AES128GCM | SSL_AES256GCM));
      aead_ctx->variable_nonce_len_ -= fixed_iv.size();
      aead_ctx->variable_nonce_included_in_record_ = true;
    }

    // Starting TLS 1.3, the AAD is the whole record header.
    if (protocol_version >= TLS1_3_VERSION) {
      aead_ctx->ad_is_header_ = true;
    }
  } else {
    // This is a CBC cipher suite that implements the |EVP_AEAD| interface. The
    // |EVP_AEAD| takes the MAC key, encryption key, and fixed IV concatenated
    // as its input key.
    assert(protocol_version < TLS1_3_VERSION);
    BSSL_CHECK(mac_key.size() + enc_key.size() + fixed_iv.size() <=
               sizeof(merged_key));
    OPENSSL_memcpy(merged_key, mac_key.data(), mac_key.size());
    OPENSSL_memcpy(merged_key + mac_key.size(), enc_key.data(), enc_key.size());
    OPENSSL_memcpy(merged_key + mac_key.size() + enc_key.size(),
                   fixed_iv.data(), fixed_iv.size());
    enc_key =
        Span(merged_key, enc_key.size() + mac_key.size() + fixed_iv.size());

    // The |EVP_AEAD|'s per-encryption nonce, if any, is actually the CBC IV. It
    // must be generated randomly and prepended to the record.
    aead_ctx->variable_nonce_included_in_record_ = true;
    aead_ctx->random_variable_nonce_ = true;
    aead_ctx->omit_length_in_ad_ = true;
  }

  if (!EVP_AEAD_CTX_init_with_direction(
          aead_ctx->ctx_.get(), aead, enc_key.data(), enc_key.size(),
          EVP_AEAD_DEFAULT_TAG_LENGTH, direction)) {
    return nullptr;
  }

  return aead_ctx;
}

UniquePtr<SSLAEADContext> SSLAEADContext::CreatePlaceholderForQUIC(
    const SSL_CIPHER *cipher) {
  return MakeUnique<SSLAEADContext>(cipher);
}

size_t SSLAEADContext::ExplicitNonceLen() const {
  if (!CRYPTO_fuzzer_mode_enabled() && variable_nonce_included_in_record_) {
    return variable_nonce_len_;
  }
  return 0;
}

bool SSLAEADContext::SuffixLen(size_t *out_suffix_len, const size_t in_len,
                               const size_t extra_in_len) const {
  if (is_null_cipher() || CRYPTO_fuzzer_mode_enabled()) {
    *out_suffix_len = extra_in_len;
    return true;
  }
  return !!EVP_AEAD_CTX_tag_len(ctx_.get(), out_suffix_len, in_len,
                                extra_in_len);
}

bool SSLAEADContext::CiphertextLen(size_t *out_len, const size_t in_len,
                                   const size_t extra_in_len) const {
  size_t len;
  if (!SuffixLen(&len, in_len, extra_in_len)) {
    return false;
  }
  len += ExplicitNonceLen();
  len += in_len;
  if (len < in_len || len >= 0xffff) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
    return false;
  }
  *out_len = len;
  return true;
}

size_t SSLAEADContext::MaxOverhead() const {
  return ExplicitNonceLen() +
         (is_null_cipher() || CRYPTO_fuzzer_mode_enabled()
              ? 0
              : EVP_AEAD_max_overhead(EVP_AEAD_CTX_aead(ctx_.get())));
}

size_t SSLAEADContext::MaxSealInputLen(size_t max_out) const {
  size_t explicit_nonce_len = ExplicitNonceLen();
  if (max_out <= explicit_nonce_len) {
    return 0;
  }
  max_out -= explicit_nonce_len;
  if (is_null_cipher() || CRYPTO_fuzzer_mode_enabled()) {
    return max_out;
  }
  // TODO(crbug.com/42290602): This should be part of |EVP_AEAD_CTX|.
  size_t overhead = EVP_AEAD_max_overhead(EVP_AEAD_CTX_aead(ctx_.get()));
  if (SSL_CIPHER_is_block_cipher(cipher())) {
    size_t block_size;
    switch (cipher()->algorithm_enc) {
      case SSL_AES128:
      case SSL_AES256:
        block_size = 16;
        break;
      case SSL_3DES:
        block_size = 8;
        break;
      default:
        abort();
    }

    // The output for a CBC cipher is always a whole number of blocks. Round the
    // remaining capacity down.
    max_out &= ~(block_size - 1);
    // The maximum overhead is a full block of padding and the MAC, but the
    // minimum overhead is one byte of padding, once we know the output is
    // rounded down.
    assert(overhead > block_size);
    overhead -= block_size - 1;
  }
  return max_out <= overhead ? 0 : max_out - overhead;
}

Span<const uint8_t> SSLAEADContext::GetAdditionalData(
    uint8_t storage[13], uint8_t type, uint16_t record_version, uint64_t seqnum,
    size_t plaintext_len, Span<const uint8_t> header) {
  if (ad_is_header_) {
    return header;
  }

  CRYPTO_store_u64_be(storage, seqnum);
  size_t len = 8;
  storage[len++] = type;
  storage[len++] = static_cast<uint8_t>((record_version >> 8));
  storage[len++] = static_cast<uint8_t>(record_version);
  if (!omit_length_in_ad_) {
    storage[len++] = static_cast<uint8_t>((plaintext_len >> 8));
    storage[len++] = static_cast<uint8_t>(plaintext_len);
  }
  return Span(storage, len);
}

bool SSLAEADContext::Open(Span<uint8_t> *out, uint8_t type,
                          uint16_t record_version, uint64_t seqnum,
                          Span<const uint8_t> header, Span<uint8_t> in) {
  if (is_null_cipher() || CRYPTO_fuzzer_mode_enabled()) {
    // Handle the initial NULL cipher.
    *out = in;
    return true;
  }

  // TLS 1.2 AEADs include the length in the AD and are assumed to have fixed
  // overhead. Otherwise the parameter is unused.
  size_t plaintext_len = 0;
  if (!omit_length_in_ad_) {
    size_t overhead = MaxOverhead();
    if (in.size() < overhead) {
      // Publicly invalid.
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_PACKET_LENGTH);
      return false;
    }
    plaintext_len = in.size() - overhead;
  }

  uint8_t ad_storage[13];
  Span<const uint8_t> ad = GetAdditionalData(ad_storage, type, record_version,
                                             seqnum, plaintext_len, header);

  // Assemble the nonce.
  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH];
  size_t nonce_len = 0;

  // Prepend the fixed nonce, or left-pad with zeros if XORing.
  if (xor_fixed_nonce_) {
    nonce_len = fixed_nonce_.size() - variable_nonce_len_;
    OPENSSL_memset(nonce, 0, nonce_len);
  } else {
    OPENSSL_memcpy(nonce, fixed_nonce_.data(), fixed_nonce_.size());
    nonce_len += fixed_nonce_.size();
  }

  // Add the variable nonce.
  if (variable_nonce_included_in_record_) {
    if (in.size() < variable_nonce_len_) {
      // Publicly invalid.
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_PACKET_LENGTH);
      return false;
    }
    OPENSSL_memcpy(nonce + nonce_len, in.data(), variable_nonce_len_);
    in = in.subspan(variable_nonce_len_);
  } else {
    assert(variable_nonce_len_ == 8);
    CRYPTO_store_u64_be(nonce + nonce_len, seqnum);
  }
  nonce_len += variable_nonce_len_;

  // XOR the fixed nonce, if necessary.
  if (xor_fixed_nonce_) {
    assert(nonce_len == fixed_nonce_.size());
    for (size_t i = 0; i < fixed_nonce_.size(); i++) {
      nonce[i] ^= fixed_nonce_[i];
    }
  }

  // Decrypt in-place.
  size_t len;
  if (!EVP_AEAD_CTX_open(ctx_.get(), in.data(), &len, in.size(), nonce,
                         nonce_len, in.data(), in.size(), ad.data(),
                         ad.size())) {
    return false;
  }
  *out = in.subspan(0, len);
  return true;
}

bool SSLAEADContext::SealScatter(uint8_t *out_prefix, uint8_t *out,
                                 uint8_t *out_suffix, uint8_t type,
                                 uint16_t record_version, uint64_t seqnum,
                                 Span<const uint8_t> header, const uint8_t *in,
                                 size_t in_len, const uint8_t *extra_in,
                                 size_t extra_in_len) {
  const size_t prefix_len = ExplicitNonceLen();
  size_t suffix_len;
  if (!SuffixLen(&suffix_len, in_len, extra_in_len)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RECORD_TOO_LARGE);
    return false;
  }
  if ((in != out && buffers_alias(in, in_len, out, in_len)) ||
      buffers_alias(in, in_len, out_prefix, prefix_len) ||
      buffers_alias(in, in_len, out_suffix, suffix_len)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_OUTPUT_ALIASES_INPUT);
    return false;
  }

  if (is_null_cipher() || CRYPTO_fuzzer_mode_enabled()) {
    // Handle the initial NULL cipher.
    OPENSSL_memmove(out, in, in_len);
    OPENSSL_memmove(out_suffix, extra_in, extra_in_len);
    return true;
  }

  uint8_t ad_storage[13];
  Span<const uint8_t> ad = GetAdditionalData(ad_storage, type, record_version,
                                             seqnum, in_len, header);

  // Assemble the nonce.
  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH];
  size_t nonce_len = 0;

  // Prepend the fixed nonce, or left-pad with zeros if XORing.
  if (xor_fixed_nonce_) {
    nonce_len = fixed_nonce_.size() - variable_nonce_len_;
    OPENSSL_memset(nonce, 0, nonce_len);
  } else {
    OPENSSL_memcpy(nonce, fixed_nonce_.data(), fixed_nonce_.size());
    nonce_len += fixed_nonce_.size();
  }

  // Select the variable nonce.
  if (random_variable_nonce_) {
    assert(variable_nonce_included_in_record_);
    if (!RAND_bytes(nonce + nonce_len, variable_nonce_len_)) {
      return false;
    }
  } else {
    // When sending we use the sequence number as the variable part of the
    // nonce.
    assert(variable_nonce_len_ == 8);
    CRYPTO_store_u64_be(nonce + nonce_len, seqnum);
  }
  nonce_len += variable_nonce_len_;

  // Emit the variable nonce if included in the record.
  if (variable_nonce_included_in_record_) {
    assert(!xor_fixed_nonce_);
    if (buffers_alias(in, in_len, out_prefix, variable_nonce_len_)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_OUTPUT_ALIASES_INPUT);
      return false;
    }
    OPENSSL_memcpy(out_prefix, nonce + fixed_nonce_.size(),
                   variable_nonce_len_);
  }

  // XOR the fixed nonce, if necessary.
  if (xor_fixed_nonce_) {
    assert(nonce_len == fixed_nonce_.size());
    for (size_t i = 0; i < fixed_nonce_.size(); i++) {
      nonce[i] ^= fixed_nonce_[i];
    }
  }

  size_t written_suffix_len;
  bool result = !!EVP_AEAD_CTX_seal_scatter(
      ctx_.get(), out, out_suffix, &written_suffix_len, suffix_len, nonce,
      nonce_len, in, in_len, extra_in, extra_in_len, ad.data(), ad.size());
  assert(!result || written_suffix_len == suffix_len);
  return result;
}

bool SSLAEADContext::Seal(uint8_t *out, size_t *out_len, size_t max_out_len,
                          uint8_t type, uint16_t record_version,
                          uint64_t seqnum, Span<const uint8_t> header,
                          const uint8_t *in, size_t in_len) {
  const size_t prefix_len = ExplicitNonceLen();
  size_t suffix_len;
  if (!SuffixLen(&suffix_len, in_len, 0)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RECORD_TOO_LARGE);
    return false;
  }
  if (in_len + prefix_len < in_len ||
      in_len + prefix_len + suffix_len < in_len + prefix_len) {
    OPENSSL_PUT_ERROR(CIPHER, SSL_R_RECORD_TOO_LARGE);
    return false;
  }
  if (in_len + prefix_len + suffix_len > max_out_len) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BUFFER_TOO_SMALL);
    return false;
  }

  if (!SealScatter(out, out + prefix_len, out + prefix_len + in_len, type,
                   record_version, seqnum, header, in, in_len, nullptr, 0)) {
    return false;
  }
  *out_len = prefix_len + in_len + suffix_len;
  return true;
}

bool SSLAEADContext::GetIV(const uint8_t **out_iv, size_t *out_iv_len) const {
  return !is_null_cipher() &&
         EVP_AEAD_CTX_get_iv(ctx_.get(), out_iv, out_iv_len);
}

BSSL_NAMESPACE_END
