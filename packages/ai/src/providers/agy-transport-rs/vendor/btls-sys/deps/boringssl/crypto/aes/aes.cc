// Copyright 2025 The BoringSSL Authors
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

#include <assert.h>

#include <openssl/aes.h>

#include "../fipsmodule/bcm_interface.h"

void AES_encrypt(const uint8_t *in, uint8_t *out, const AES_KEY *key) {
  BCM_aes_encrypt(in, out, key);
}

void AES_decrypt(const uint8_t *in, uint8_t *out, const AES_KEY *key) {
  BCM_aes_decrypt(in, out, key);
}

int AES_set_encrypt_key(const uint8_t *key, unsigned bits, AES_KEY *aeskey) {
  if (bits != 128 && bits != 192 && bits != 256) {
    return -2;
  }
  return bcm_success(BCM_aes_set_encrypt_key(key, bits, aeskey)) ? 0 : -1;
}

int AES_set_decrypt_key(const uint8_t *key, unsigned bits, AES_KEY *aeskey) {
  if (bits != 128 && bits != 192 && bits != 256) {
    return -2;
  }
  return bcm_success(BCM_aes_set_decrypt_key(key, bits, aeskey)) ? 0 : -1;
}
