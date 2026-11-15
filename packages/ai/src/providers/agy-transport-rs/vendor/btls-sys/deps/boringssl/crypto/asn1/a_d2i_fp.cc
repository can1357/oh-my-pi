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

#include <openssl/asn1.h>

#include <limits.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/mem.h>


void *ASN1_item_d2i_bio(const ASN1_ITEM *it, BIO *in, void *x) {
  uint8_t *data;
  size_t len;
  // Historically, this function did not impose a limit in OpenSSL and is used
  // to read CRLs, so we leave this without an external bound.
  if (!BIO_read_asn1(in, &data, &len, INT_MAX)) {
    return nullptr;
  }
  const uint8_t *ptr = data;
  void *ret = ASN1_item_d2i(reinterpret_cast<ASN1_VALUE **>(x), &ptr, len, it);
  OPENSSL_free(data);
  return ret;
}

void *ASN1_item_d2i_fp(const ASN1_ITEM *it, FILE *in, void *x) {
  BIO *b = BIO_new_fp(in, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_BUF_LIB);
    return nullptr;
  }
  void *ret = ASN1_item_d2i_bio(it, b, x);
  BIO_free(b);
  return ret;
}
