// Copyright 2017 The BoringSSL Authors
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

#include <openssl/cipher.h>

#include <string.h>

#include <openssl/aes.h>
#include <openssl/obj.h>

#include "../../crypto/fipsmodule/cipher/internal.h"
#include "../../crypto/internal.h"

typedef struct {
  AES_KEY ks;
} EVP_CFB_CTX;

static int aes_cfb_init_key(EVP_CIPHER_CTX *ctx, const uint8_t *key,
                            const uint8_t *iv, int enc) {
  if (key) {
    EVP_CFB_CTX *cfb_ctx = reinterpret_cast<EVP_CFB_CTX *>(ctx->cipher_data);
    AES_set_encrypt_key(key, ctx->key_len * 8, &cfb_ctx->ks);
  }

  return 1;
}

static int aes_cfb128_cipher(EVP_CIPHER_CTX *ctx, uint8_t *out,
                             const uint8_t *in, size_t len) {
  if (!out || !in) {
    return 0;
  }

  EVP_CFB_CTX *cfb_ctx = reinterpret_cast<EVP_CFB_CTX *>(ctx->cipher_data);
  int num = ctx->num;
  AES_cfb128_encrypt(in, out, len, &cfb_ctx->ks, ctx->iv, &num,
                     ctx->encrypt ? AES_ENCRYPT : AES_DECRYPT);
  ctx->num = num;

  return 1;
}

static const EVP_CIPHER aes_128_cfb128 = {
    /* nid= */ NID_aes_128_cfb128,
    /* block_size= */ 1,
    /* key_len= */ 16,
    /* iv_len= */ 16,
    /* ctx_size= */ sizeof(EVP_CFB_CTX),
    /* flags= */ EVP_CIPH_CFB_MODE,
    /* init= */ aes_cfb_init_key,
    /* cipher= */ aes_cfb128_cipher,
    /* cleanup= */ nullptr,
    /* ctrl= */ nullptr,
};

static const EVP_CIPHER aes_192_cfb128 = {
    /* nid= */ NID_aes_192_cfb128,
    /* block_size= */ 1,
    /* key_len= */ 24,
    /* iv_len= */ 16,
    /* ctx_size= */ sizeof(EVP_CFB_CTX),
    /* flags= */ EVP_CIPH_CFB_MODE,
    /* init= */ aes_cfb_init_key,
    /* cipher= */ aes_cfb128_cipher,
    /* cleanup= */ nullptr,
    /* ctrl= */ nullptr,
};

static const EVP_CIPHER aes_256_cfb128 = {
    /* nid= */ NID_aes_256_cfb128,
    /* block_size= */ 1,
    /* key_len= */ 32,
    /* iv_len= */ 16,
    /* ctx_size= */ sizeof(EVP_CFB_CTX),
    /* flags= */ EVP_CIPH_CFB_MODE,
    /* init= */ aes_cfb_init_key,
    /* cipher= */ aes_cfb128_cipher,
    /* cleanup= */ nullptr,
    /* ctrl= */ nullptr,
};

const EVP_CIPHER *EVP_aes_128_cfb128(void) { return &aes_128_cfb128; }
const EVP_CIPHER *EVP_aes_128_cfb(void) { return &aes_128_cfb128; }
const EVP_CIPHER *EVP_aes_192_cfb128(void) { return &aes_192_cfb128; }
const EVP_CIPHER *EVP_aes_192_cfb(void) { return &aes_192_cfb128; }
const EVP_CIPHER *EVP_aes_256_cfb128(void) { return &aes_256_cfb128; }
const EVP_CIPHER *EVP_aes_256_cfb(void) { return &aes_256_cfb128; }
