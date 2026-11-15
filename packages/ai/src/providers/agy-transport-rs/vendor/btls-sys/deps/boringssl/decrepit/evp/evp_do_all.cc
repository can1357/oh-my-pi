// Copyright 2016 The BoringSSL Authors
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


void EVP_CIPHER_do_all_sorted(void (*callback)(const EVP_CIPHER *cipher,
                                               const char *name,
                                               const char *unused, void *arg),
                              void *arg) {
  callback(EVP_aes_128_cbc(), "AES-128-CBC", nullptr, arg);
  callback(EVP_aes_192_cbc(), "AES-192-CBC", nullptr, arg);
  callback(EVP_aes_256_cbc(), "AES-256-CBC", nullptr, arg);
  callback(EVP_aes_128_ctr(), "AES-128-CTR", nullptr, arg);
  callback(EVP_aes_192_ctr(), "AES-192-CTR", nullptr, arg);
  callback(EVP_aes_256_ctr(), "AES-256-CTR", nullptr, arg);
  callback(EVP_aes_128_ecb(), "AES-128-ECB", nullptr, arg);
  callback(EVP_aes_192_ecb(), "AES-192-ECB", nullptr, arg);
  callback(EVP_aes_256_ecb(), "AES-256-ECB", nullptr, arg);
  callback(EVP_aes_128_ofb(), "AES-128-OFB", nullptr, arg);
  callback(EVP_aes_192_ofb(), "AES-192-OFB", nullptr, arg);
  callback(EVP_aes_256_ofb(), "AES-256-OFB", nullptr, arg);
  callback(EVP_aes_128_gcm(), "AES-128-GCM", nullptr, arg);
  callback(EVP_aes_192_gcm(), "AES-192-GCM", nullptr, arg);
  callback(EVP_aes_256_gcm(), "AES-256-GCM", nullptr, arg);
  callback(EVP_des_cbc(), "DES-CBC", nullptr, arg);
  callback(EVP_des_ecb(), "DES-ECB", nullptr, arg);
  callback(EVP_des_ede(), "DES-EDE", nullptr, arg);
  callback(EVP_des_ede_cbc(), "DES-EDE-CBC", nullptr, arg);
  callback(EVP_des_ede3_cbc(), "DES-EDE3-CBC", nullptr, arg);
  callback(EVP_rc2_cbc(), "RC2-CBC", nullptr, arg);
  callback(EVP_rc4(), "RC4", nullptr, arg);

  // OpenSSL returns everything twice, the second time in lower case.
  callback(EVP_aes_128_cbc(), "aes-128-cbc", nullptr, arg);
  callback(EVP_aes_192_cbc(), "aes-192-cbc", nullptr, arg);
  callback(EVP_aes_256_cbc(), "aes-256-cbc", nullptr, arg);
  callback(EVP_aes_128_ctr(), "aes-128-ctr", nullptr, arg);
  callback(EVP_aes_192_ctr(), "aes-192-ctr", nullptr, arg);
  callback(EVP_aes_256_ctr(), "aes-256-ctr", nullptr, arg);
  callback(EVP_aes_128_ecb(), "aes-128-ecb", nullptr, arg);
  callback(EVP_aes_192_ecb(), "aes-192-ecb", nullptr, arg);
  callback(EVP_aes_256_ecb(), "aes-256-ecb", nullptr, arg);
  callback(EVP_aes_128_ofb(), "aes-128-ofb", nullptr, arg);
  callback(EVP_aes_192_ofb(), "aes-192-ofb", nullptr, arg);
  callback(EVP_aes_256_ofb(), "aes-256-ofb", nullptr, arg);
  callback(EVP_aes_128_gcm(), "aes-128-gcm", nullptr, arg);
  callback(EVP_aes_192_gcm(), "aes-192-gcm", nullptr, arg);
  callback(EVP_aes_256_gcm(), "aes-256-gcm", nullptr, arg);
  callback(EVP_des_cbc(), "des-cbc", nullptr, arg);
  callback(EVP_des_ecb(), "des-ecb", nullptr, arg);
  callback(EVP_des_ede(), "des-ede", nullptr, arg);
  callback(EVP_des_ede_cbc(), "des-ede-cbc", nullptr, arg);
  callback(EVP_des_ede3_cbc(), "des-ede3-cbc", nullptr, arg);
  callback(EVP_rc2_cbc(), "rc2-cbc", nullptr, arg);
  callback(EVP_rc4(), "rc4", nullptr, arg);
}

void EVP_MD_do_all_sorted(void (*callback)(const EVP_MD *cipher,
                                           const char *name, const char *unused,
                                           void *arg),
                          void *arg) {
  callback(EVP_md4(), "MD4", nullptr, arg);
  callback(EVP_md5(), "MD5", nullptr, arg);
  callback(EVP_sha1(), "SHA1", nullptr, arg);
  callback(EVP_sha224(), "SHA224", nullptr, arg);
  callback(EVP_sha256(), "SHA256", nullptr, arg);
  callback(EVP_sha384(), "SHA384", nullptr, arg);
  callback(EVP_sha512(), "SHA512", nullptr, arg);
  callback(EVP_sha512_256(), "SHA512-256", nullptr, arg);

  callback(EVP_md4(), "md4", nullptr, arg);
  callback(EVP_md5(), "md5", nullptr, arg);
  callback(EVP_sha1(), "sha1", nullptr, arg);
  callback(EVP_sha224(), "sha224", nullptr, arg);
  callback(EVP_sha256(), "sha256", nullptr, arg);
  callback(EVP_sha384(), "sha384", nullptr, arg);
  callback(EVP_sha512(), "sha512", nullptr, arg);
  callback(EVP_sha512_256(), "sha512-256", nullptr, arg);
}

void EVP_MD_do_all(void (*callback)(const EVP_MD *cipher, const char *name,
                                    const char *unused, void *arg),
                   void *arg) {
  EVP_MD_do_all_sorted(callback, arg);
}
