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

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/mem.h>


int ASN1_item_i2d_fp(const ASN1_ITEM *it, FILE *out, const void *x) {
  BIO *b = BIO_new_fp(out, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_BUF_LIB);
    return 0;
  }
  int ret = ASN1_item_i2d_bio(it, b, x);
  BIO_free(b);
  return ret;
}

int ASN1_item_i2d_bio(const ASN1_ITEM *it, BIO *out, const void *x) {
  unsigned char *b = nullptr;
  int n = ASN1_item_i2d(reinterpret_cast<ASN1_VALUE *>(const_cast<void *>(x)),
                        &b, it);
  if (b == nullptr) {
    return 0;
  }

  int ret = BIO_write_all(out, b, n);
  OPENSSL_free(b);
  return ret;
}
