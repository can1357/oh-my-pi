// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/nid.h>

#include "../fipsmodule/cipher/internal.h"
#include "../internal.h"


static int null_init_key(EVP_CIPHER_CTX *ctx, const uint8_t *key,
                         const uint8_t *iv, int enc) {
  return 1;
}

static int null_cipher(EVP_CIPHER_CTX *ctx, uint8_t *out, const uint8_t *in,
                       size_t in_len) {
  if (in != out) {
    OPENSSL_memcpy(out, in, in_len);
  }
  return 1;
}

static const EVP_CIPHER n_cipher = {
    /*nid=*/NID_undef,
    /*block_size=*/1,
    /*key_len=*/0,
    /*iv_len=*/0,
    /*ctx_size=*/0,
    /*flags=*/0,
    /*init=*/null_init_key,
    /*cipher=*/null_cipher,
    /*cleanup=*/nullptr,
    /*ctrl=*/nullptr,
};

const EVP_CIPHER *EVP_enc_null(void) { return &n_cipher; }
