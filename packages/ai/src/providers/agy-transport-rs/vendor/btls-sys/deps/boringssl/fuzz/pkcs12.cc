// Copyright 2018 The BoringSSL Authors
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

#include <openssl/bytestring.h>
#include <openssl/evp.h>
#include <openssl/pkcs8.h>
#include <openssl/x509.h>


extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  bssl::UniquePtr<STACK_OF(X509)> certs(sk_X509_new_null());
  EVP_PKEY *key = nullptr;
  CBS cbs;
  CBS_init(&cbs, buf, len);
  PKCS12_get_key_and_certs(&key, certs.get(), &cbs, "foo");
  EVP_PKEY_free(key);
  return 0;
}
