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

#include <openssl/bn.h>

#include <assert.h>

#include <openssl/err.h>

#include "../fipsmodule/bn/internal.h"


int BN_exp(BIGNUM *r, const BIGNUM *a, const BIGNUM *p, BN_CTX *ctx) {
  bssl::BN_CTXScope scope(ctx);
  BIGNUM *rr;
  if (r == a || r == p) {
    rr = BN_CTX_get(ctx);
  } else {
    rr = r;
  }

  BIGNUM *v = BN_CTX_get(ctx);
  if (rr == nullptr || v == nullptr) {
    return 0;
  }

  if (BN_copy(v, a) == nullptr) {
    return 0;
  }
  int bits = BN_num_bits(p);

  if (BN_is_odd(p)) {
    if (BN_copy(rr, a) == nullptr) {
      return 0;
    }
  } else {
    if (!BN_one(rr)) {
      return 0;
    }
  }

  for (int i = 1; i < bits; i++) {
    if (!BN_sqr(v, v, ctx)) {
      return 0;
    }
    if (BN_is_bit_set(p, i)) {
      if (!BN_mul(rr, rr, v, ctx)) {
        return 0;
      }
    }
  }

  if (r != rr && !BN_copy(r, rr)) {
    return 0;
  }
  return 1;
}

static int mod_exp_even(BIGNUM *r, const BIGNUM *a, const BIGNUM *p,
                        const BIGNUM *m, BN_CTX *ctx) {
  // No cryptographic operations require modular exponentiation with an even
  // modulus. We support it for backwards compatibility with any applications
  // that may have relied on the operation, but optimize for simplicity over
  // performance with straightforward square-and-multiply routine.
  int bits = BN_num_bits(p);
  if (bits == 0) {
    return BN_one(r);
  }

  // Make a copy of |a|, in case it aliases |r|.
  bssl::BN_CTXScope scope(ctx);
  BIGNUM *tmp = BN_CTX_get(ctx);
  if (tmp == nullptr || !BN_copy(tmp, a)) {
    return 0;
  }

  assert(BN_is_bit_set(p, bits - 1));
  if (!BN_copy(r, tmp)) {
    return 0;
  }

  for (int i = bits - 2; i >= 0; i--) {
    if (!BN_mod_sqr(r, r, m, ctx) ||
        (BN_is_bit_set(p, i) && !BN_mod_mul(r, r, tmp, m, ctx))) {
      return 0;
    }
  }

  return 1;
}

int BN_mod_exp(BIGNUM *r, const BIGNUM *a, const BIGNUM *p, const BIGNUM *m,
               BN_CTX *ctx) {
  if (m->neg) {
    OPENSSL_PUT_ERROR(BN, BN_R_NEGATIVE_NUMBER);
    return 0;
  }
  if (a->neg || BN_ucmp(a, m) >= 0) {
    if (!BN_nnmod(r, a, m, ctx)) {
      return 0;
    }
    a = r;
  }

  if (BN_is_odd(m)) {
    return BN_mod_exp_mont(r, a, p, m, ctx, nullptr);
  }

  return mod_exp_even(r, a, p, m, ctx);
}

int BN_mod_exp_mont_word(BIGNUM *rr, BN_ULONG a, const BIGNUM *p,
                         const BIGNUM *m, BN_CTX *ctx,
                         const BN_MONT_CTX *mont) {
  // BN_mod_exp_mont requires reduced inputs.
  if (bn_minimal_width(m) == 1) {
    a %= m->d[0];
  }

  bssl::UniquePtr<BIGNUM> a_bignum(BN_new());
  if (a_bignum == nullptr || !BN_set_word(a_bignum.get(), a)) {
    OPENSSL_PUT_ERROR(BN, ERR_R_INTERNAL_ERROR);
    return 0;
  }

  return BN_mod_exp_mont(rr, a_bignum.get(), p, m, ctx, mont);
}

int BN_mod_exp2_mont(BIGNUM *rr, const BIGNUM *a1, const BIGNUM *p1,
                     const BIGNUM *a2, const BIGNUM *p2, const BIGNUM *m,
                     BN_CTX *ctx, const BN_MONT_CTX *mont) {
  // Allocate a montgomery context if it was not supplied by the caller.
  bssl::UniquePtr<BN_MONT_CTX> new_mont;
  if (mont == nullptr) {
    new_mont.reset(BN_MONT_CTX_new_for_modulus(m, ctx));
    if (new_mont == nullptr) {
      return 0;
    }
    mont = new_mont.get();
  }

  // BN_mod_mul_montgomery removes one Montgomery factor, so passing one
  // Montgomery-encoded and one non-Montgomery-encoded value gives a
  // non-Montgomery-encoded result.
  bssl::UniquePtr<BIGNUM> tmp(BN_new());
  if (tmp == nullptr ||  //
      !BN_mod_exp_mont(rr, a1, p1, m, ctx, mont) ||
      !BN_mod_exp_mont(tmp.get(), a2, p2, m, ctx, mont) ||
      !BN_to_montgomery(rr, rr, mont, ctx) ||
      !BN_mod_mul_montgomery(rr, rr, tmp.get(), mont, ctx)) {
    return 0;
  }

  return 1;
}
