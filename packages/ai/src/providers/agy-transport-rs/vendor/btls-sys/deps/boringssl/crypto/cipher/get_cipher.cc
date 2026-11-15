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
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>

#include "internal.h"
#include "../internal.h"


static const struct {
  int nid;
  const char *name;
  const EVP_CIPHER *(*func)(void);
} kCiphers[] = {
    {NID_aes_128_cbc, "aes-128-cbc", EVP_aes_128_cbc},
    {NID_aes_128_ctr, "aes-128-ctr", EVP_aes_128_ctr},
    {NID_aes_128_ecb, "aes-128-ecb", EVP_aes_128_ecb},
    {NID_aes_128_gcm, "aes-128-gcm", EVP_aes_128_gcm},
    {NID_aes_128_ofb128, "aes-128-ofb", EVP_aes_128_ofb},
    {NID_aes_192_cbc, "aes-192-cbc", EVP_aes_192_cbc},
    {NID_aes_192_ctr, "aes-192-ctr", EVP_aes_192_ctr},
    {NID_aes_192_ecb, "aes-192-ecb", EVP_aes_192_ecb},
    {NID_aes_192_gcm, "aes-192-gcm", EVP_aes_192_gcm},
    {NID_aes_192_ofb128, "aes-192-ofb", EVP_aes_192_ofb},
    {NID_aes_256_cbc, "aes-256-cbc", EVP_aes_256_cbc},
    {NID_aes_256_ctr, "aes-256-ctr", EVP_aes_256_ctr},
    {NID_aes_256_ecb, "aes-256-ecb", EVP_aes_256_ecb},
    {NID_aes_256_gcm, "aes-256-gcm", EVP_aes_256_gcm},
    {NID_aes_256_ofb128, "aes-256-ofb", EVP_aes_256_ofb},
    {NID_des_cbc, "des-cbc", EVP_des_cbc},
    {NID_des_ecb, "des-ecb", EVP_des_ecb},
    {NID_des_ede_cbc, "des-ede-cbc", EVP_des_ede_cbc},
    {NID_des_ede_ecb, "des-ede", EVP_des_ede},
    {NID_des_ede3_cbc, "des-ede3-cbc", EVP_des_ede3_cbc},
    {NID_rc2_cbc, "rc2-cbc", EVP_rc2_cbc},
    {NID_rc4, "rc4", EVP_rc4},
};

const EVP_CIPHER *EVP_get_cipherbynid(int nid) {
  for (const auto &cipher : kCiphers) {
    if (cipher.nid == nid) {
      return cipher.func();
    }
  }
  return nullptr;
}

const EVP_CIPHER *EVP_get_cipherbyname(const char *name) {
  if (name == nullptr) {
    return nullptr;
  }

  // This is not a name used by OpenSSL, but tcpdump registers it with
  // |EVP_add_cipher_alias|. Our |EVP_add_cipher_alias| is a no-op, so we
  // support the name here.
  if (OPENSSL_strcasecmp(name, "3des") == 0) {
    name = "des-ede3-cbc";
  }

  for (const auto &cipher : kCiphers) {
    if (OPENSSL_strcasecmp(cipher.name, name) == 0) {
      return cipher.func();
    }
  }

  return nullptr;
}
