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

#include <openssl/sha2.h>

#include <openssl/mem.h>

#include "../fipsmodule/bcm_interface.h"


int SHA224_Init(SHA256_CTX *sha) {
  BCM_sha224_init(sha);
  return 1;
}

int SHA224_Update(SHA256_CTX *sha, const void *data, size_t len) {
  BCM_sha224_update(sha, data, len);
  return 1;
}

int SHA224_Final(uint8_t out[SHA224_DIGEST_LENGTH], SHA256_CTX *sha) {
  BCM_sha224_final(out, sha);
  return 1;
}

uint8_t *SHA224(const uint8_t *data, size_t len,
                uint8_t out[SHA224_DIGEST_LENGTH]) {
  SHA256_CTX ctx;
  BCM_sha224_init(&ctx);
  BCM_sha224_update(&ctx, data, len);
  BCM_sha224_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

int SHA256_Init(SHA256_CTX *sha) {
  BCM_sha256_init(sha);
  return 1;
}

int SHA256_Update(SHA256_CTX *sha, const void *data, size_t len) {
  BCM_sha256_update(sha, data, len);
  return 1;
}

int SHA256_Final(uint8_t out[SHA256_DIGEST_LENGTH], SHA256_CTX *sha) {
  // TODO(bbe): This overflow check one of the few places a low-level hash
  // 'final' function can fail. SHA-512 does not have a corresponding check.
  // The BCM function is infallible and will abort if this is done incorrectly.
  // we should verify nothing crashes with this removed and eliminate the 0
  // return.
  if (sha->md_len > SHA256_DIGEST_LENGTH) {
    return 0;
  }
  BCM_sha256_final(out, sha);
  return 1;
}

uint8_t *SHA256(const uint8_t *data, size_t len,
                uint8_t out[SHA256_DIGEST_LENGTH]) {
  SHA256_CTX ctx;
  BCM_sha256_init(&ctx);
  BCM_sha256_update(&ctx, data, len);
  BCM_sha256_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

void SHA256_Transform(SHA256_CTX *sha, const uint8_t block[SHA256_CBLOCK]) {
  BCM_sha256_transform(sha, block);
}

void SHA256_TransformBlocks(uint32_t state[8], const uint8_t *data,
                            size_t num_blocks) {
  BCM_sha256_transform_blocks(state, data, num_blocks);
}
