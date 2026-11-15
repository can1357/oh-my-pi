// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/dh.h>

#include <assert.h>
#include <limits.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>

#include "../bytestring/internal.h"
#include "../fipsmodule/dh/internal.h"


static int parse_integer(CBS *cbs, BIGNUM **out) {
  assert(*out == nullptr);
  *out = BN_new();
  if (*out == nullptr) {
    return 0;
  }
  return BN_parse_asn1_unsigned(cbs, *out);
}

static int marshal_integer(CBB *cbb, BIGNUM *bn) {
  if (bn == nullptr) {
    // A DH object may be missing some components.
    OPENSSL_PUT_ERROR(DH, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  return BN_marshal_asn1(cbb, bn);
}

DH *DH_parse_parameters(CBS *cbs) {
  bssl::UniquePtr<DH> ret(DH_new());
  if (ret == nullptr) {
    return nullptr;
  }

  CBS child;
  if (!CBS_get_asn1(cbs, &child, CBS_ASN1_SEQUENCE) ||
      !parse_integer(&child, &ret->p) ||
      !parse_integer(&child, &ret->g)) {
    OPENSSL_PUT_ERROR(DH, DH_R_DECODE_ERROR);
    return nullptr;
  }

  uint64_t priv_length;
  if (CBS_len(&child) != 0) {
    if (!CBS_get_asn1_uint64(&child, &priv_length) ||
        priv_length > UINT_MAX) {
      OPENSSL_PUT_ERROR(DH, DH_R_DECODE_ERROR);
      return nullptr;
    }
    ret->priv_length = (unsigned)priv_length;
  }

  if (CBS_len(&child) != 0) {
    OPENSSL_PUT_ERROR(DH, DH_R_DECODE_ERROR);
    return nullptr;
  }

  if (!dh_check_params_fast(ret.get())) {
    OPENSSL_PUT_ERROR(DH, DH_R_DECODE_ERROR);
    return nullptr;
  }

  return ret.release();
}

int DH_marshal_parameters(CBB *cbb, const DH *dh) {
  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_SEQUENCE) ||
      !marshal_integer(&child, dh->p) ||
      !marshal_integer(&child, dh->g) ||
      (dh->priv_length != 0 &&
       !CBB_add_asn1_uint64(&child, dh->priv_length)) ||
      !CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(DH, DH_R_ENCODE_ERROR);
    return 0;
  }
  return 1;
}

DH *d2i_DHparams(DH **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, DH_parse_parameters);
}

int i2d_DHparams(const DH *in, uint8_t **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/256, outp,
      [&](CBB *cbb) -> bool { return DH_marshal_parameters(cbb, in); });
}
