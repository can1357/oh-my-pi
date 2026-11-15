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

#include <assert.h>

#include <openssl/digest.h>
#include <openssl/mem.h>


int EVP_BytesToKey(const EVP_CIPHER *type, const EVP_MD *md,
                   const uint8_t salt[8], const uint8_t *data, size_t data_len,
                   unsigned count, uint8_t *key, uint8_t *iv) {
  uint8_t md_buf[EVP_MAX_MD_SIZE];
  unsigned addmd = 0;
  unsigned mds = 0, i;
  int rv = 0;

  unsigned nkey = EVP_CIPHER_key_length(type);
  unsigned niv = EVP_CIPHER_iv_length(type);

  assert(nkey <= EVP_MAX_KEY_LENGTH);
  assert(niv <= EVP_MAX_IV_LENGTH);

  if (data == nullptr) {
    return nkey;
  }

  bssl::ScopedEVP_MD_CTX c;
  for (;;) {
    if (!EVP_DigestInit_ex(c.get(), md, nullptr)) {
      goto err;
    }
    if (addmd++) {
      if (!EVP_DigestUpdate(c.get(), md_buf, mds)) {
        goto err;
      }
    }
    if (!EVP_DigestUpdate(c.get(), data, data_len)) {
      goto err;
    }
    if (salt != nullptr) {
      if (!EVP_DigestUpdate(c.get(), salt, 8)) {
        goto err;
      }
    }
    if (!EVP_DigestFinal_ex(c.get(), md_buf, &mds)) {
      goto err;
    }

    for (i = 1; i < count; i++) {
      if (!EVP_DigestInit_ex(c.get(), md, nullptr) ||
          !EVP_DigestUpdate(c.get(), md_buf, mds) ||
          !EVP_DigestFinal_ex(c.get(), md_buf, &mds)) {
        goto err;
      }
    }

    i = 0;
    if (nkey) {
      for (;;) {
        if (nkey == 0 || i == mds) {
          break;
        }
        if (key != nullptr) {
          *(key++) = md_buf[i];
        }
        nkey--;
        i++;
      }
    }

    if (niv && i != mds) {
      for (;;) {
        if (niv == 0 || i == mds) {
          break;
        }
        if (iv != nullptr) {
          *(iv++) = md_buf[i];
        }
        niv--;
        i++;
      }
    }
    if (nkey == 0 && niv == 0) {
      break;
    }
  }
  rv = EVP_CIPHER_key_length(type);

err:
  OPENSSL_cleanse(md_buf, EVP_MAX_MD_SIZE);
  return rv;
}
