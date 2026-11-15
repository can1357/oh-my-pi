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

#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  CBS cbs;
  CBS_init(&cbs, buf, len);
  bssl::UniquePtr<EVP_PKEY> pkey(EVP_parse_public_key(&cbs));
  if (pkey == nullptr) {
    ERR_clear_error();
    return 0;
  }

  // Every parsed public key should be serializable.
  bssl::ScopedCBB cbb;
  BSSL_CHECK(CBB_init(cbb.get(), 0));
  BSSL_CHECK(EVP_marshal_public_key(cbb.get(), pkey.get()));

  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_mem()));
  EVP_PKEY_print_params(bio.get(), pkey.get(), 0, nullptr);
  EVP_PKEY_print_public(bio.get(), pkey.get(), 0, nullptr);

  ERR_clear_error();
  return 0;
}
