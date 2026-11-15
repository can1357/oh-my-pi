// Copyright 2002-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright (c) 2002, Oracle and/or its affiliates. All rights reserved.
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

#include <openssl/ecdh.h>

#include <limits.h>
#include <string.h>

#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../fipsmodule/ec/internal.h"
#include "../internal.h"


int ECDH_compute_key(void *out, size_t out_len, const EC_POINT *pub_key,
                     const EC_KEY *priv_key,
                     void *(*kdf)(const void *in, size_t inlen, void *out,
                                  size_t *out_len)) {
  if (priv_key->priv_key == nullptr) {
    OPENSSL_PUT_ERROR(ECDH, ECDH_R_NO_PRIVATE_VALUE);
    return -1;
  }
  const EC_SCALAR *const priv = &priv_key->priv_key->scalar;
  const EC_GROUP *const group = EC_KEY_get0_group(priv_key);
  if (EC_GROUP_cmp(group, pub_key->group, nullptr) != 0) {
    OPENSSL_PUT_ERROR(EC, EC_R_INCOMPATIBLE_OBJECTS);
    return -1;
  }

  EC_JACOBIAN shared_point;
  uint8_t buf[EC_MAX_BYTES];
  size_t buf_len;
  if (!ec_point_mul_scalar(group, &shared_point, &pub_key->raw, priv) ||
      !ec_get_x_coordinate_as_bytes(group, buf, &buf_len, sizeof(buf),
                                    &shared_point)) {
    OPENSSL_PUT_ERROR(ECDH, ECDH_R_POINT_ARITHMETIC_FAILURE);
    return -1;
  }

  if (kdf != nullptr) {
    if (kdf(buf, buf_len, out, &out_len) == nullptr) {
      OPENSSL_PUT_ERROR(ECDH, ECDH_R_KDF_FAILED);
      return -1;
    }
  } else {
    // no KDF, just copy as much as we can
    if (buf_len < out_len) {
      out_len = buf_len;
    }
    OPENSSL_memcpy(out, buf, out_len);
  }

  if (out_len > INT_MAX) {
    OPENSSL_PUT_ERROR(ECDH, ERR_R_OVERFLOW);
    return -1;
  }

  return (int)out_len;
}
