// Copyright 2014 The BoringSSL Authors
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

#include <openssl/aead.h>

#include <assert.h>
#include <string.h>

#include <openssl/chacha.h>
#include <openssl/cipher.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/poly1305.h>

#include "internal.h"
#include "../chacha/internal.h"
#include "../fipsmodule/cipher/internal.h"
#include "../internal.h"

struct aead_chacha20_poly1305_ctx {
  uint8_t key[32];
};

static_assert(sizeof(((EVP_AEAD_CTX *)nullptr)->state) >=
                  sizeof(struct aead_chacha20_poly1305_ctx),
              "AEAD state is too small");
static_assert(alignof(union evp_aead_ctx_st_state) >=
                  alignof(struct aead_chacha20_poly1305_ctx),
              "AEAD state has insufficient alignment");

static int aead_chacha20_poly1305_init(EVP_AEAD_CTX *ctx, const uint8_t *key,
                                       size_t key_len, size_t tag_len) {
  struct aead_chacha20_poly1305_ctx *c20_ctx =
      (struct aead_chacha20_poly1305_ctx *)&ctx->state;

  if (tag_len == 0) {
    tag_len = POLY1305_TAG_LEN;
  }

  if (tag_len > POLY1305_TAG_LEN) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_TOO_LARGE);
    return 0;
  }

  if (key_len != sizeof(c20_ctx->key)) {
    return 0;  // internal error - EVP_AEAD_CTX_init should catch this.
  }

  OPENSSL_memcpy(c20_ctx->key, key, key_len);
  ctx->tag_len = tag_len;

  return 1;
}

static void aead_chacha20_poly1305_cleanup(EVP_AEAD_CTX *ctx) {}

static void poly1305_update_length(poly1305_state *poly1305, size_t data_len) {
  uint8_t length_bytes[8];

  for (unsigned i = 0; i < sizeof(length_bytes); i++) {
    length_bytes[i] = data_len;
    data_len >>= 8;
  }

  CRYPTO_poly1305_update(poly1305, length_bytes, sizeof(length_bytes));
}

// calc_tag fills |tag| with the authentication tag for the given inputs.
static void calc_tag(uint8_t tag[POLY1305_TAG_LEN], const uint8_t *key,
                     const uint8_t nonce[12], const uint8_t *ad, size_t ad_len,
                     const uint8_t *ciphertext, size_t ciphertext_len,
                     const uint8_t *ciphertext_extra,
                     size_t ciphertext_extra_len) {
  alignas(16) uint8_t poly1305_key[32];
  OPENSSL_memset(poly1305_key, 0, sizeof(poly1305_key));
  CRYPTO_chacha_20(poly1305_key, poly1305_key, sizeof(poly1305_key), key, nonce,
                   0);

  static const uint8_t padding[16] = { 0 };  // Padding is all zeros.
  poly1305_state ctx;
  CRYPTO_poly1305_init(&ctx, poly1305_key);
  CRYPTO_poly1305_update(&ctx, ad, ad_len);
  if (ad_len % 16 != 0) {
    CRYPTO_poly1305_update(&ctx, padding, sizeof(padding) - (ad_len % 16));
  }
  CRYPTO_poly1305_update(&ctx, ciphertext, ciphertext_len);
  CRYPTO_poly1305_update(&ctx, ciphertext_extra, ciphertext_extra_len);
  const size_t ciphertext_total = ciphertext_len + ciphertext_extra_len;
  if (ciphertext_total % 16 != 0) {
    CRYPTO_poly1305_update(&ctx, padding,
                           sizeof(padding) - (ciphertext_total % 16));
  }
  poly1305_update_length(&ctx, ad_len);
  poly1305_update_length(&ctx, ciphertext_total);
  CRYPTO_poly1305_finish(&ctx, tag);
}

static int chacha20_poly1305_seal_scatter(
    const uint8_t *key, uint8_t *out, uint8_t *out_tag,
    size_t *out_tag_len, size_t max_out_tag_len, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *extra_in,
    size_t extra_in_len, const uint8_t *ad, size_t ad_len, size_t tag_len) {
  if (extra_in_len + tag_len < tag_len) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_TOO_LARGE);
    return 0;
  }
  if (max_out_tag_len < tag_len + extra_in_len) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_BUFFER_TOO_SMALL);
    return 0;
  }
  if (nonce_len != 12) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_UNSUPPORTED_NONCE_SIZE);
    return 0;
  }

  // |CRYPTO_chacha_20| uses a 32-bit block counter. Therefore we disallow
  // individual operations that work on more than 256GB at a time.
  // |in_len_64| is needed because, on 32-bit platforms, size_t is only
  // 32-bits and this produces a warning because it's always false.
  // Casting to uint64_t inside the conditional is not sufficient to stop
  // the warning.
  const uint64_t in_len_64 = in_len;
  if (in_len_64 >= (UINT64_C(1) << 32) * 64 - 64) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_TOO_LARGE);
    return 0;
  }

  if (max_out_tag_len < tag_len) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_BUFFER_TOO_SMALL);
    return 0;
  }

  // The the extra input is given, it is expected to be very short and so is
  // encrypted byte-by-byte first.
  if (extra_in_len) {
    static const size_t kChaChaBlockSize = 64;
    uint32_t block_counter = (uint32_t)(1 + (in_len / kChaChaBlockSize));
    size_t offset = in_len % kChaChaBlockSize;
    uint8_t block[64 /* kChaChaBlockSize */];

    for (size_t done = 0; done < extra_in_len; block_counter++) {
      memset(block, 0, sizeof(block));
      CRYPTO_chacha_20(block, block, sizeof(block), key, nonce,
                       block_counter);
      for (size_t i = offset; i < sizeof(block) && done < extra_in_len;
           i++, done++) {
        out_tag[done] = extra_in[done] ^ block[i];
      }
      offset = 0;
    }
  }

  union chacha20_poly1305_seal_data data;
  if (chacha20_poly1305_asm_capable()) {
    OPENSSL_memcpy(data.in.key, key, 32);
    data.in.counter = 0;
    OPENSSL_memcpy(data.in.nonce, nonce, 12);
    data.in.extra_ciphertext = out_tag;
    data.in.extra_ciphertext_len = extra_in_len;
    chacha20_poly1305_seal(out, in, in_len, ad, ad_len, &data);
  } else {
    CRYPTO_chacha_20(out, in, in_len, key, nonce, 1);
    calc_tag(data.out.tag, key, nonce, ad, ad_len, out, in_len, out_tag,
             extra_in_len);
  }

  OPENSSL_memcpy(out_tag + extra_in_len, data.out.tag, tag_len);
  *out_tag_len = extra_in_len + tag_len;
  return 1;
}

static int aead_chacha20_poly1305_seal_scatter(
    const EVP_AEAD_CTX *ctx, uint8_t *out, uint8_t *out_tag,
    size_t *out_tag_len, size_t max_out_tag_len, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *extra_in,
    size_t extra_in_len, const uint8_t *ad, size_t ad_len) {
  const struct aead_chacha20_poly1305_ctx *c20_ctx =
      (struct aead_chacha20_poly1305_ctx *)&ctx->state;

  return chacha20_poly1305_seal_scatter(
      c20_ctx->key, out, out_tag, out_tag_len, max_out_tag_len, nonce,
      nonce_len, in, in_len, extra_in, extra_in_len, ad, ad_len, ctx->tag_len);
}

static int aead_xchacha20_poly1305_seal_scatter(
    const EVP_AEAD_CTX *ctx, uint8_t *out, uint8_t *out_tag,
    size_t *out_tag_len, size_t max_out_tag_len, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *extra_in,
    size_t extra_in_len, const uint8_t *ad, size_t ad_len) {
  const struct aead_chacha20_poly1305_ctx *c20_ctx =
      (struct aead_chacha20_poly1305_ctx *)&ctx->state;

  if (nonce_len != 24) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_UNSUPPORTED_NONCE_SIZE);
    return 0;
  }

  alignas(4) uint8_t derived_key[32];
  alignas(4) uint8_t derived_nonce[12];
  CRYPTO_hchacha20(derived_key, c20_ctx->key, nonce);
  OPENSSL_memset(derived_nonce, 0, 4);
  OPENSSL_memcpy(&derived_nonce[4], &nonce[16], 8);

  return chacha20_poly1305_seal_scatter(
      derived_key, out, out_tag, out_tag_len, max_out_tag_len,
      derived_nonce, sizeof(derived_nonce), in, in_len, extra_in, extra_in_len,
      ad, ad_len, ctx->tag_len);
}

static int chacha20_poly1305_open_gather(
    const uint8_t *key, uint8_t *out, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *in_tag,
    size_t in_tag_len, const uint8_t *ad, size_t ad_len, size_t tag_len) {
  if (nonce_len != 12) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_UNSUPPORTED_NONCE_SIZE);
    return 0;
  }

  if (in_tag_len != tag_len) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_BAD_DECRYPT);
    return 0;
  }

  // |CRYPTO_chacha_20| uses a 32-bit block counter. Therefore we disallow
  // individual operations that work on more than 256GB at a time.
  // |in_len_64| is needed because, on 32-bit platforms, size_t is only
  // 32-bits and this produces a warning because it's always false.
  // Casting to uint64_t inside the conditional is not sufficient to stop
  // the warning.
  const uint64_t in_len_64 = in_len;
  if (in_len_64 >= (UINT64_C(1) << 32) * 64 - 64) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_TOO_LARGE);
    return 0;
  }

  union chacha20_poly1305_open_data data;
  if (chacha20_poly1305_asm_capable()) {
    OPENSSL_memcpy(data.in.key, key, 32);
    data.in.counter = 0;
    OPENSSL_memcpy(data.in.nonce, nonce, 12);
    chacha20_poly1305_open(out, in, in_len, ad, ad_len, &data);
  } else {
    calc_tag(data.out.tag, key, nonce, ad, ad_len, in, in_len, nullptr, 0);
    CRYPTO_chacha_20(out, in, in_len, key, nonce, 1);
  }

  if (CRYPTO_memcmp(data.out.tag, in_tag, tag_len) != 0) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_BAD_DECRYPT);
    return 0;
  }

  return 1;
}

static int aead_chacha20_poly1305_open_gather(
    const EVP_AEAD_CTX *ctx, uint8_t *out, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *in_tag,
    size_t in_tag_len, const uint8_t *ad, size_t ad_len) {
  const struct aead_chacha20_poly1305_ctx *c20_ctx =
      (struct aead_chacha20_poly1305_ctx *)&ctx->state;

  return chacha20_poly1305_open_gather(c20_ctx->key, out, nonce, nonce_len, in,
                                       in_len, in_tag, in_tag_len, ad, ad_len,
                                       ctx->tag_len);
}

static int aead_xchacha20_poly1305_open_gather(
    const EVP_AEAD_CTX *ctx, uint8_t *out, const uint8_t *nonce,
    size_t nonce_len, const uint8_t *in, size_t in_len, const uint8_t *in_tag,
    size_t in_tag_len, const uint8_t *ad, size_t ad_len) {
  const struct aead_chacha20_poly1305_ctx *c20_ctx =
      (struct aead_chacha20_poly1305_ctx *)&ctx->state;

  if (nonce_len != 24) {
    OPENSSL_PUT_ERROR(CIPHER, CIPHER_R_UNSUPPORTED_NONCE_SIZE);
    return 0;
  }

  alignas(4) uint8_t derived_key[32];
  alignas(4) uint8_t derived_nonce[12];
  CRYPTO_hchacha20(derived_key, c20_ctx->key, nonce);
  OPENSSL_memset(derived_nonce, 0, 4);
  OPENSSL_memcpy(&derived_nonce[4], &nonce[16], 8);

  return chacha20_poly1305_open_gather(
      derived_key, out, derived_nonce, sizeof(derived_nonce), in, in_len,
      in_tag, in_tag_len, ad, ad_len, ctx->tag_len);
}

static const EVP_AEAD aead_chacha20_poly1305 = {
    32,                // key len
    12,                // nonce len
    POLY1305_TAG_LEN,  // overhead
    POLY1305_TAG_LEN,  // max tag length
    1,                 // seal_scatter_supports_extra_in

    aead_chacha20_poly1305_init,
    nullptr,  // init_with_direction
    aead_chacha20_poly1305_cleanup,
    nullptr /* open */,
    aead_chacha20_poly1305_seal_scatter,
    aead_chacha20_poly1305_open_gather,
    nullptr,  // get_iv
    nullptr,  // tag_len
};

static const EVP_AEAD aead_xchacha20_poly1305 = {
    32,                // key len
    24,                // nonce len
    POLY1305_TAG_LEN,  // overhead
    POLY1305_TAG_LEN,  // max tag length
    1,                 // seal_scatter_supports_extra_in

    aead_chacha20_poly1305_init,
    nullptr,  // init_with_direction
    aead_chacha20_poly1305_cleanup,
    nullptr /* open */,
    aead_xchacha20_poly1305_seal_scatter,
    aead_xchacha20_poly1305_open_gather,
    nullptr,  // get_iv
    nullptr,  // tag_len
};

const EVP_AEAD *EVP_aead_chacha20_poly1305(void) {
  return &aead_chacha20_poly1305;
}

const EVP_AEAD *EVP_aead_xchacha20_poly1305(void) {
  return &aead_xchacha20_poly1305;
}
