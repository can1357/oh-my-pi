// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/err.h>
#include <openssl/mem.h>


ASN1_STRING *ASN1_item_pack(void *obj, const ASN1_ITEM *it, ASN1_STRING **out) {
  uint8_t *new_data = nullptr;
  int len = ASN1_item_i2d(reinterpret_cast<ASN1_VALUE *>(obj), &new_data, it);
  if (len <= 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_ENCODE_ERROR);
    return nullptr;
  }

  ASN1_STRING *ret = nullptr;
  if (out == nullptr || *out == nullptr) {
    ret = ASN1_STRING_new();
    if (ret == nullptr) {
      OPENSSL_free(new_data);
      return nullptr;
    }
  } else {
    ret = *out;
  }

  ASN1_STRING_set0(ret, new_data, len);
  if (out != nullptr) {
    *out = ret;
  }
  return ret;
}

void *ASN1_item_unpack(const ASN1_STRING *oct, const ASN1_ITEM *it) {
  const unsigned char *p = oct->data;
  void *ret = ASN1_item_d2i(nullptr, &p, oct->length, it);
  if (ret == nullptr || p != oct->data + oct->length) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    ASN1_item_free(reinterpret_cast<ASN1_VALUE *>(ret), it);
    return nullptr;
  }
  return ret;
}
