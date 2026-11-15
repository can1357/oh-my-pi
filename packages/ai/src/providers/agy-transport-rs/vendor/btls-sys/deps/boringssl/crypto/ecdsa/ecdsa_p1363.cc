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

#include <openssl/ecdsa.h>

#include <stddef.h>
#include <stdint.h>

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>

#include "../fipsmodule/ecdsa/internal.h"


int ECDSA_sign_p1363(const uint8_t *digest, size_t digest_len, uint8_t *sig,
                     size_t *out_sig_len, size_t max_sig_len,
                     const EC_KEY *eckey) {
  return ecdsa_sign_fixed(digest, digest_len, sig, out_sig_len, max_sig_len,
                          eckey);
}

int ECDSA_verify_p1363(const uint8_t *digest, size_t digest_len,
                       const uint8_t *sig, size_t sig_len,
                       const EC_KEY *eckey) {
  return ecdsa_verify_fixed(digest, digest_len, sig, sig_len, eckey);
}

size_t ECDSA_size_p1363(const EC_KEY *key) {
  if (key == nullptr) {
    return 0;
  }

  const EC_GROUP *group = EC_KEY_get0_group(key);
  if (group == nullptr) {
    return 0;
  }

  size_t group_order_size = BN_num_bytes(EC_GROUP_get0_order(group));
  return 2 * group_order_size;
}
