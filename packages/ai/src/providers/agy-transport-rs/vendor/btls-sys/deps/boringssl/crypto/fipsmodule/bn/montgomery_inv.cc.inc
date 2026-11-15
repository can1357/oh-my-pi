// Copyright 2016 Brian Smith.
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

#include "internal.h"
#include "../../internal.h"


static uint64_t bn_neg_inv_mod_u64(uint64_t n);

static_assert(BN_MONT_CTX_N0_LIMBS == 1 || BN_MONT_CTX_N0_LIMBS == 2,
              "BN_MONT_CTX_N0_LIMBS value is invalid");
static_assert(sizeof(BN_ULONG) * BN_MONT_CTX_N0_LIMBS == sizeof(uint64_t),
              "uint64_t is insufficient precision for n0");

uint64_t bn_mont_n0(const BIGNUM *n) {
  // These conditions are checked by the caller, |BN_MONT_CTX_set| or
  // |BN_MONT_CTX_new_consttime|.
  assert(!BN_is_zero(n));
  assert(!BN_is_negative(n));
  assert(BN_is_odd(n));

  // r == 2**(BN_MONT_CTX_N0_LIMBS * BN_BITS2) ensures that we can do integer
  // division by |r| by simply ignoring |BN_MONT_CTX_N0_LIMBS| limbs. Similarly,
  // we can calculate values modulo |r| by just looking at the lowest
  // |BN_MONT_CTX_N0_LIMBS| limbs. This is what makes Montgomery multiplication
  // efficient.
  //
  // As shown in Algorithm 1 of "Fast Prime Field Elliptic Curve Cryptography
  // with 256 Bit Primes" by Shay Gueron and Vlad Krasnov, in the loop of a
  // multi-limb Montgomery multiplication of |a * b (mod n)|, given the
  // unreduced product |t == a * b|, we repeatedly calculate:
  //
  //    t1 := t % r         |t1| is |t|'s lowest limb (see previous paragraph).
  //    t2 := t1*n0*n
  //    t3 := t + t2
  //    t := t3 / r         copy all limbs of |t3| except the lowest to |t|.
  //
  // In the last step, it would only make sense to ignore the lowest limb of
  // |t3| if it were zero. The middle steps ensure that this is the case:
  //
  //                            t3 ==  0 (mod r)
  //                        t + t2 ==  0 (mod r)
  //                   t + t1*n0*n ==  0 (mod r)
  //                       t1*n0*n == -t (mod r)
  //                        t*n0*n == -t (mod r)
  //                          n0*n == -1 (mod r)
  //                            n0 == -1/n (mod r)
  //
  // Thus, in each iteration of the loop, we multiply by the constant factor
  // |n0|, the negative inverse of n (mod r).

  // n_mod_r = n % r. As explained above, this is done by taking the lowest
  // |BN_MONT_CTX_N0_LIMBS| limbs of |n|.
  uint64_t n_mod_r = n->d[0];
#if BN_MONT_CTX_N0_LIMBS == 2
  if (n->width > 1) {
    n_mod_r |= (uint64_t)n->d[1] << BN_BITS2;
  }
#endif

  // A 64-bit inverse is enough precision to invert by r. (r is also currently
  // always 2^64.)
  return bn_neg_inv_mod_u64(n_mod_r);
}

// bn_neg_inv_mod_u64 calculates -1/n mod 2^64. |n| must be odd.
static uint64_t bn_neg_inv_mod_u64(uint64_t n) {
  // This is a modified version of the technique described in
  // https://crypto.stackexchange.com/a/47496 and
  // https://bearssl.org/bigint.html#montgomery-reduction-and-multiplication. We
  // modify it to compute the negative inverse directly so that, on 32-bit,
  // negation happens before we go to double-word precision, instead of at the
  // end.
  //
  // If r = -n^-1 (mod m), then r * (r*n + 2) is -n^(-1) (mod m^2). This is
  // because, for some k, r*n = k*m - 1. Then:
  //
  //     r*n * (r*n + 2) = (k*m - 1) * (k*m + 1) = k^2*m^2 - 1 = -1 (mod m^2)
  //
  // We start with the negative inverse mod some small power of 2 and square the
  // modulus up to 2^64. n = n^-1 (mod 8) for all odd n, so r = -n (mod 8). From
  // there, four iterations are enough for 2^32 and five for 2^64.
  assert(n % 2 == 1);
#if defined(OPENSSL_32_BIT)
  // Compute the result mod 2^32 first.
  uint32_t n32 = static_cast<uint32_t>(n);
  uint32_t r = 0u - n32;
  for (int i = 0; i < 4; i++) {
    r *= r * n32 + 2;
  }
  // Run one more double-word iteration to get the result mod 2^64.
  return r * (r * n + 2);
#else
  uint64_t r = 0u - n;
  for (int i = 0; i < 5; i++) {
    r *= r * n + 2;
  }
  return r;
#endif
}

int bn_mont_ctx_set_RR_consttime(BN_MONT_CTX *mont, BN_CTX *ctx) {
  assert(!BN_is_zero(&mont->N));
  assert(!BN_is_negative(&mont->N));
  assert(BN_is_odd(&mont->N));
  assert(bn_minimal_width(&mont->N) == mont->N.width);

  unsigned n_bits = BN_num_bits(&mont->N);
  assert(n_bits != 0);
  if (n_bits == 1) {
    BN_zero(&mont->RR);
    return bn_resize_words(&mont->RR, mont->N.width);
  }

  unsigned lgBigR = mont->N.width * BN_BITS2;
  assert(lgBigR >= n_bits);

  // RR is R, or 2^lgBigR, in the Montgomery domain. We can compute 2 in the
  // Montgomery domain, 2R or 2^(lgBigR+1), and then use Montgomery
  // square-and-multiply to exponentiate.
  //
  // The square steps take 2^n R to (2^n)*(2^n) R = 2^2n R. This is the same as
  // doubling 2^n R, n times (doubling any x, n times, computes 2^n * x). When n
  // is below some threshold, doubling is faster; when above, squaring is
  // faster. From benchmarking various 32-bit and 64-bit architectures, the word
  // count seems to work well as a threshold. (Doubling scales linearly and
  // Montgomery reduction scales quadratically, so the threshold should scale
  // roughly linearly.)
  //
  // The multiply steps take 2^n R to 2*2^n R = 2^(n+1) R. It is faster to
  // double the value instead, so the square-and-multiply exponentiation would
  // become square-and-double. However, when using the word count as the
  // threshold, it turns out that no multiply/double steps will be needed at
  // all, because squaring any x, i times, computes x^(2^i):
  //
  //   (2^threshold)^(2^BN_BITS2_LG) R
  //   (2^mont->N.width)^BN_BITS2 R
  // = 2^(mont->N.width*BN_BITS2) R
  // = 2^lgBigR R
  // = RR
  int threshold = mont->N.width;

  // Calculate 2^threshold R = 2^(threshold + lgBigR) by doubling. The
  // first n_bits - 1 doubles can be skipped because we don't need to reduce.
  if (!BN_set_bit(&mont->RR, n_bits - 1) ||
      !bn_mod_lshift_consttime(&mont->RR, &mont->RR,
                               threshold + (lgBigR - (n_bits - 1)),
                               &mont->N, ctx)) {
    return 0;
  }

  // The above steps are the same regardless of the threshold. The steps below
  // need to be modified if the threshold changes.
  assert(threshold == mont->N.width);
  for (unsigned i = 0; i < BN_BITS2_LG; i++) {
    if (!BN_mod_mul_montgomery(&mont->RR, &mont->RR, &mont->RR, mont, ctx)) {
      return 0;
    }
  }

  return bn_resize_words(&mont->RR, mont->N.width);
}
