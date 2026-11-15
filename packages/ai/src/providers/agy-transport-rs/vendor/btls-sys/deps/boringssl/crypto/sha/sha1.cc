// Copyright 2024 The BoringSSL Authors
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

#include <openssl/sha.h>

#include <openssl/mem.h>

#include "../fipsmodule/bcm_interface.h"

int SHA1_Init(SHA_CTX *sha) {
  BCM_sha1_init(sha);
  return 1;
}

int SHA1_Update(SHA_CTX *sha, const void *data, size_t len) {
  BCM_sha1_update(sha, data, len);
  return 1;
}

int SHA1_Final(uint8_t out[SHA_DIGEST_LENGTH], SHA_CTX *sha) {
  BCM_sha1_final(out, sha);
  return 1;
}

uint8_t *SHA1(const uint8_t *data, size_t len, uint8_t out[SHA_DIGEST_LENGTH]) {
  SHA_CTX ctx;
  BCM_sha1_init(&ctx);
  BCM_sha1_update(&ctx, data, len);
  BCM_sha1_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

void SHA1_Transform(SHA_CTX *sha, const uint8_t block[SHA_CBLOCK]) {
  BCM_sha1_transform(sha, block);
}

void CRYPTO_fips_186_2_prf(uint8_t *out, size_t out_len,
                           const uint8_t xkey[SHA_DIGEST_LENGTH]) {
  BCM_fips_186_2_prf(out, out_len, xkey);
}
