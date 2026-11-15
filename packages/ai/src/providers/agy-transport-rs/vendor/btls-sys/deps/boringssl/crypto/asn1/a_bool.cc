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

#include <openssl/bytestring.h>
#include <openssl/err.h>

#include "../bytestring/internal.h"


int i2d_ASN1_BOOLEAN(ASN1_BOOLEAN a, unsigned char **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/3, outp, [&](CBB *cbb) -> bool {
        return CBB_add_asn1_bool(cbb, a != ASN1_BOOLEAN_FALSE);
      });
}

ASN1_BOOLEAN d2i_ASN1_BOOLEAN(ASN1_BOOLEAN *out, const unsigned char **inp,
                              long len) {
  if (len < 0) {
    return ASN1_BOOLEAN_NONE;
  }

  CBS cbs;
  CBS_init(&cbs, *inp, (size_t)len);
  int val;
  if (!CBS_get_asn1_bool(&cbs, &val)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return ASN1_BOOLEAN_NONE;
  }

  ASN1_BOOLEAN ret = val ? ASN1_BOOLEAN_TRUE : ASN1_BOOLEAN_FALSE;
  if (out != nullptr) {
    *out = ret;
  }
  *inp = CBS_data(&cbs);
  return ret;
}
