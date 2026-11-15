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

#include <openssl/x509.h>

#include <openssl/asn1.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>

int ASN1_digest(i2d_of_void *i2d, const EVP_MD *type, char *data,
                unsigned char *md, unsigned int *len) {
  int i, ret;
  unsigned char *str, *p;

  i = i2d(data, nullptr);
  if ((str = (unsigned char *)OPENSSL_malloc(i)) == nullptr) {
    return 0;
  }
  p = str;
  i2d(data, &p);

  ret = EVP_Digest(str, i, md, len, type, nullptr);
  OPENSSL_free(str);
  return ret;
}

int ASN1_item_digest(const ASN1_ITEM *it, const EVP_MD *type, void *asn,
                     unsigned char *md, unsigned int *len) {
  int i, ret;
  unsigned char *str = nullptr;

  i = ASN1_item_i2d(reinterpret_cast<ASN1_VALUE *>(asn), &str, it);
  if (!str) {
    return 0;
  }

  ret = EVP_Digest(str, i, md, len, type, nullptr);
  OPENSSL_free(str);
  return ret;
}
