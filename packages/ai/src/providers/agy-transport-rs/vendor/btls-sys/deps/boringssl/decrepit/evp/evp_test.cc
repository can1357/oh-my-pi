// Copyright 2021 The BoringSSL Authors
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

#include <gtest/gtest.h>

#include <openssl/cipher.h>
#include <openssl/digest.h>
#include <openssl/evp.h>


// Node.js assumes every cipher in |EVP_CIPHER_do_all_sorted| is accessible via
// |EVP_get_cipherby*|.
TEST(EVPTest, CipherDoAll) {
  EVP_CIPHER_do_all_sorted(
      [](const EVP_CIPHER *cipher, const char *name, const char *unused,
         void *arg) {
        SCOPED_TRACE(name);
        EXPECT_EQ(cipher, EVP_get_cipherbyname(name));
        EXPECT_EQ(cipher, EVP_get_cipherbynid(EVP_CIPHER_nid(cipher)));
      },
      nullptr);
}

// Node.js assumes every digest in |EVP_MD_do_all_sorted| is accessible via
// |EVP_get_digestby*|.
TEST(EVPTest, MDDoAll) {
  EVP_MD_do_all_sorted(
      [](const EVP_MD *md, const char *name, const char *unused, void *arg) {
        SCOPED_TRACE(name);
        EXPECT_EQ(md, EVP_get_digestbyname(name));
        EXPECT_EQ(md, EVP_get_digestbynid(EVP_MD_nid(md)));
      },
      nullptr);
}
