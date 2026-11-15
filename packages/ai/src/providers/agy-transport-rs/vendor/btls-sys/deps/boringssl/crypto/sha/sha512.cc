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


int SHA384_Init(SHA512_CTX *sha) {
  BCM_sha384_init(sha);
  return 1;
}

int SHA384_Update(SHA512_CTX *sha, const void *data, size_t len) {
  BCM_sha384_update(sha, data, len);
  return 1;
}

int SHA384_Final(uint8_t out[SHA384_DIGEST_LENGTH], SHA512_CTX *sha) {
  BCM_sha384_final(out, sha);
  return 1;
}

uint8_t *SHA384(const uint8_t *data, size_t len,
                uint8_t out[SHA384_DIGEST_LENGTH]) {
  SHA512_CTX ctx;
  BCM_sha384_init(&ctx);
  BCM_sha384_update(&ctx, data, len);
  BCM_sha384_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

int SHA512_256_Init(SHA512_CTX *sha) {
  BCM_sha512_256_init(sha);
  return 1;
}

int SHA512_256_Update(SHA512_CTX *sha, const void *data, size_t len) {
  BCM_sha512_256_update(sha, data, len);
  return 1;
}

int SHA512_256_Final(uint8_t out[SHA512_256_DIGEST_LENGTH], SHA512_CTX *sha) {
  BCM_sha512_256_final(out, sha);
  return 1;
}

uint8_t *SHA512_256(const uint8_t *data, size_t len,
                uint8_t out[SHA512_256_DIGEST_LENGTH]) {
  SHA512_CTX ctx;
  BCM_sha512_256_init(&ctx);
  BCM_sha512_256_update(&ctx, data, len);
  BCM_sha512_256_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

int SHA512_Init(SHA512_CTX *sha) {
  BCM_sha512_init(sha);
  return 1;
}

int SHA512_Update(SHA512_CTX *sha, const void *data, size_t len) {
  BCM_sha512_update(sha, data, len);
  return 1;
}

int SHA512_Final(uint8_t out[SHA512_DIGEST_LENGTH], SHA512_CTX *sha) {
  // Historically this function returned failure if passed NULL, even though
  // other final functions do not.
  if (out == nullptr) {
    return 0;
  }
  BCM_sha512_final(out, sha);
  return 1;
}

uint8_t *SHA512(const uint8_t *data, size_t len,
                uint8_t out[SHA512_DIGEST_LENGTH]) {
  SHA512_CTX ctx;
  BCM_sha512_init(&ctx);
  BCM_sha512_update(&ctx, data, len);
  BCM_sha512_final(out, &ctx);
  OPENSSL_cleanse(&ctx, sizeof(ctx));
  return out;
}

void SHA512_Transform(SHA512_CTX *sha, const uint8_t block[SHA512_CBLOCK]) {
  BCM_sha512_transform(sha, block);
}
