// Copyright 2011-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/evp.h>

#include <string.h>

#include <openssl/aes.h>
#include <openssl/cipher.h>

#include "../../crypto/fipsmodule/cipher/internal.h"
#include "../../crypto/fipsmodule/aes/internal.h"


typedef struct xts128_context {
  AES_KEY *key1, *key2;
  block128_f block1, block2;
} XTS128_CONTEXT;

static size_t CRYPTO_xts128_encrypt(const XTS128_CONTEXT *ctx,
                                    const uint8_t iv[16], const uint8_t *inp,
                                    uint8_t *out, size_t len, int enc) {
  union {
    uint64_t u[2];
    uint32_t d[4];
    uint8_t c[16];
  } tweak, scratch;
  unsigned int i;

  if (len < 16) {
    return 0;
  }

  OPENSSL_memcpy(tweak.c, iv, 16);

  (*ctx->block2)(tweak.c, tweak.c, ctx->key2);

  if (!enc && (len % 16)) {
    len -= 16;
  }

  while (len >= 16) {
    OPENSSL_memcpy(scratch.c, inp, 16);
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    (*ctx->block1)(scratch.c, scratch.c, ctx->key1);
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    OPENSSL_memcpy(out, scratch.c, 16);
    inp += 16;
    out += 16;
    len -= 16;

    if (len == 0) {
      return 1;
    }

    unsigned int carry, res;

    res = 0x87 & (((int)tweak.d[3]) >> 31);
    carry = (unsigned int)(tweak.u[0] >> 63);
    tweak.u[0] = (tweak.u[0] << 1) ^ res;
    tweak.u[1] = (tweak.u[1] << 1) | carry;
  }
  if (enc) {
    for (i = 0; i < len; ++i) {
      uint8_t c = inp[i];
      out[i] = scratch.c[i];
      scratch.c[i] = c;
    }
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    (*ctx->block1)(scratch.c, scratch.c, ctx->key1);
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    OPENSSL_memcpy(out - 16, scratch.c, 16);
  } else {
    union {
      uint64_t u[2];
      uint8_t c[16];
    } tweak1;

    unsigned int carry, res;

    res = 0x87 & (((int)tweak.d[3]) >> 31);
    carry = (unsigned int)(tweak.u[0] >> 63);
    tweak1.u[0] = (tweak.u[0] << 1) ^ res;
    tweak1.u[1] = (tweak.u[1] << 1) | carry;
    OPENSSL_memcpy(scratch.c, inp, 16);
    scratch.u[0] ^= tweak1.u[0];
    scratch.u[1] ^= tweak1.u[1];
    (*ctx->block1)(scratch.c, scratch.c, ctx->key1);
    scratch.u[0] ^= tweak1.u[0];
    scratch.u[1] ^= tweak1.u[1];

    for (i = 0; i < len; ++i) {
      uint8_t c = inp[16 + i];
      out[16 + i] = scratch.c[i];
      scratch.c[i] = c;
    }
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    (*ctx->block1)(scratch.c, scratch.c, ctx->key1);
    scratch.u[0] ^= tweak.u[0];
    scratch.u[1] ^= tweak.u[1];
    OPENSSL_memcpy(out, scratch.c, 16);
  }

  return 1;
}

typedef struct {
  union {
    double align;
    AES_KEY ks;
  } ks1, ks2;  // AES key schedules to use
  XTS128_CONTEXT xts;
} EVP_AES_XTS_CTX;

static int aes_xts_init_key(EVP_CIPHER_CTX *ctx, const uint8_t *key,
                            const uint8_t *iv, int enc) {
  EVP_AES_XTS_CTX *xctx = reinterpret_cast<EVP_AES_XTS_CTX *>(ctx->cipher_data);
  if (!iv && !key) {
    return 1;
  }

  if (key) {
    // key_len is two AES keys
    if (enc) {
      AES_set_encrypt_key(key, ctx->key_len * 4, &xctx->ks1.ks);
      xctx->xts.block1 = AES_encrypt;
    } else {
      AES_set_decrypt_key(key, ctx->key_len * 4, &xctx->ks1.ks);
      xctx->xts.block1 = AES_decrypt;
    }

    AES_set_encrypt_key(key + ctx->key_len / 2, ctx->key_len * 4,
                        &xctx->ks2.ks);
    xctx->xts.block2 = AES_encrypt;
    xctx->xts.key1 = &xctx->ks1.ks;
  }

  if (iv) {
    xctx->xts.key2 = &xctx->ks2.ks;
    OPENSSL_memcpy(ctx->iv, iv, 16);
  }

  return 1;
}

static int aes_xts_cipher(EVP_CIPHER_CTX *ctx, uint8_t *out, const uint8_t *in,
                          size_t len) {
  EVP_AES_XTS_CTX *xctx = reinterpret_cast<EVP_AES_XTS_CTX *>(ctx->cipher_data);
  if (!xctx->xts.key1 || !xctx->xts.key2 || !out || !in ||
      len < AES_BLOCK_SIZE ||
      !CRYPTO_xts128_encrypt(&xctx->xts, ctx->iv, in, out, len, ctx->encrypt)) {
    return 0;
  }
  return 1;
}

static int aes_xts_ctrl(EVP_CIPHER_CTX *c, int type, int arg, void *ptr) {
  EVP_AES_XTS_CTX *xctx = reinterpret_cast<EVP_AES_XTS_CTX *>(c->cipher_data);
  if (type == EVP_CTRL_COPY) {
    EVP_CIPHER_CTX *out = reinterpret_cast<EVP_CIPHER_CTX *>(ptr);
    EVP_AES_XTS_CTX *xctx_out =
        reinterpret_cast<EVP_AES_XTS_CTX *>(out->cipher_data);
    if (xctx->xts.key1) {
      if (xctx->xts.key1 != &xctx->ks1.ks) {
        return 0;
      }
      xctx_out->xts.key1 = &xctx_out->ks1.ks;
    }
    if (xctx->xts.key2) {
      if (xctx->xts.key2 != &xctx->ks2.ks) {
        return 0;
      }
      xctx_out->xts.key2 = &xctx_out->ks2.ks;
    }
    return 1;
  } else if (type != EVP_CTRL_INIT) {
    return -1;
  }
  // key1 and key2 are used as an indicator both key and IV are set
  xctx->xts.key1 = nullptr;
  xctx->xts.key2 = nullptr;
  return 1;
}

static const EVP_CIPHER aes_256_xts = {
    /* nid= */ NID_aes_256_xts,
    /* block_size= */ 1,
    /* key_len= */ 64 /* 2 AES-256 keys */,
    /* iv_len= */ 16,
    /* ctx_size= */ sizeof(EVP_AES_XTS_CTX),
    /* flags= */ EVP_CIPH_XTS_MODE | EVP_CIPH_CUSTOM_IV |
             EVP_CIPH_ALWAYS_CALL_INIT | EVP_CIPH_CTRL_INIT |
             EVP_CIPH_CUSTOM_COPY,
    /* init= */ aes_xts_init_key,
    /* cipher= */ aes_xts_cipher,
    /* cleanup= */ nullptr,
    /* ctrl= */ aes_xts_ctrl,
};

const EVP_CIPHER *EVP_aes_256_xts(void) { return &aes_256_xts; }
