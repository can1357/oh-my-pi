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

#include <openssl/bn.h>

#include <openssl/err.h>


int BN_sqrt(BIGNUM *out_sqrt, const BIGNUM *in, BN_CTX *ctx) {
  BIGNUM *estimate, *tmp, *delta, *last_delta, *tmp2;
  int ok = 0, last_delta_valid = 0;

  if (in->neg) {
    OPENSSL_PUT_ERROR(BN, BN_R_NEGATIVE_NUMBER);
    return 0;
  }
  if (BN_is_zero(in)) {
    BN_zero(out_sqrt);
    return 1;
  }

  bssl::BN_CTXScope scope(ctx);
  if (out_sqrt == in) {
    estimate = BN_CTX_get(ctx);
  } else {
    estimate = out_sqrt;
  }
  tmp = BN_CTX_get(ctx);
  last_delta = BN_CTX_get(ctx);
  delta = BN_CTX_get(ctx);
  if (estimate == nullptr || tmp == nullptr || last_delta == nullptr ||
      delta == nullptr) {
    goto err;
  }

  // We estimate that the square root of an n-bit number is 2^{n/2}.
  if (!BN_lshift(estimate, BN_value_one(), BN_num_bits(in)/2)) {
    goto err;
  }

  // This is Newton's method for finding a root of the equation |estimate|^2 -
  // |in| = 0.
  for (;;) {
    // |estimate| = 1/2 * (|estimate| + |in|/|estimate|)
    if (!BN_div(tmp, nullptr, in, estimate, ctx) ||
        !BN_add(tmp, tmp, estimate) || !BN_rshift1(estimate, tmp) ||
        // |tmp| = |estimate|^2
        !BN_sqr(tmp, estimate, ctx) ||
        // |delta| = |in| - |tmp|
        !BN_sub(delta, in, tmp)) {
      OPENSSL_PUT_ERROR(BN, ERR_R_BN_LIB);
      goto err;
    }

    delta->neg = 0;
    // The difference between |in| and |estimate| squared is required to always
    // decrease. This ensures that the loop always terminates, but I don't have
    // a proof that it always finds the square root for a given square.
    if (last_delta_valid && BN_cmp(delta, last_delta) >= 0) {
      break;
    }

    last_delta_valid = 1;

    tmp2 = last_delta;
    last_delta = delta;
    delta = tmp2;
  }

  if (BN_cmp(tmp, in) != 0) {
    OPENSSL_PUT_ERROR(BN, BN_R_NOT_A_SQUARE);
    goto err;
  }

  ok = 1;

err:
  if (ok && out_sqrt == in && !BN_copy(out_sqrt, estimate)) {
    ok = 0;
  }
  return ok;
}
