// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/hmac.h>

#include "../internal.h"


int PKCS5_PBKDF2_HMAC(const char *password, size_t password_len,
                      const uint8_t *salt, size_t salt_len, uint32_t iterations,
                      const EVP_MD *digest, size_t key_len, uint8_t *out_key) {
  // See RFC 8018, section 5.2.
  bssl::ScopedHMAC_CTX hctx;
  if (!HMAC_Init_ex(hctx.get(), password, password_len, digest, nullptr)) {
    return 0;
  }

  uint32_t i = 1;
  size_t md_len = EVP_MD_size(digest);
  while (key_len > 0) {
    size_t todo = md_len;
    if (todo > key_len) {
      todo = key_len;
    }

    uint8_t i_buf[4];
    i_buf[0] = (uint8_t)((i >> 24) & 0xff);
    i_buf[1] = (uint8_t)((i >> 16) & 0xff);
    i_buf[2] = (uint8_t)((i >> 8) & 0xff);
    i_buf[3] = (uint8_t)(i & 0xff);

    // Compute U_1.
    uint8_t digest_tmp[EVP_MAX_MD_SIZE];
    if (!HMAC_Init_ex(hctx.get(), nullptr, 0, nullptr, nullptr) ||
        !HMAC_Update(hctx.get(), salt, salt_len) ||
        !HMAC_Update(hctx.get(), i_buf, 4) ||
        !HMAC_Final(hctx.get(), digest_tmp, nullptr)) {
      return 0;
    }

    OPENSSL_memcpy(out_key, digest_tmp, todo);
    for (uint32_t j = 1; j < iterations; j++) {
      // Compute the remaining U_* values and XOR.
      if (!HMAC_Init_ex(hctx.get(), nullptr, 0, nullptr, nullptr) ||
          !HMAC_Update(hctx.get(), digest_tmp, md_len) ||
          !HMAC_Final(hctx.get(), digest_tmp, nullptr)) {
        return 0;
      }
      for (size_t k = 0; k < todo; k++) {
        out_key[k] ^= digest_tmp[k];
      }
    }

    key_len -= todo;
    out_key += todo;
    i++;
  }

  // RFC 8018 describes iterations (c) as being a "positive integer", so a
  // value of 0 is an error.
  //
  // Unfortunately not all consumers of PKCS5_PBKDF2_HMAC() check their return
  // value, expecting it to succeed and unconditionally using |out_key|.  As a
  // precaution for such callsites in external code, the old behavior of
  // iterations < 1 being treated as iterations == 1 is preserved, but
  // additionally an error result is returned.
  //
  // TODO(eroman): Figure out how to remove this compatibility hack, or change
  // the default to something more sensible like 2048.
  if (iterations == 0) {
    return 0;
  }

  return 1;
}

int PKCS5_PBKDF2_HMAC_SHA1(const char *password, size_t password_len,
                           const uint8_t *salt, size_t salt_len,
                           uint32_t iterations, size_t key_len,
                           uint8_t *out_key) {
  return PKCS5_PBKDF2_HMAC(password, password_len, salt, salt_len, iterations,
                           EVP_sha1(), key_len, out_key);
}
