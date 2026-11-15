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

#include <openssl/err.h>

#include "../fipsmodule/bn/internal.h"
#include "../internal.h"


int BN_mod_pow2(BIGNUM *r, const BIGNUM *a, size_t e) {
  if (e == 0 || a->width == 0) {
    BN_zero(r);
    return 1;
  }

  size_t num_words = 1 + ((e - 1) / BN_BITS2);

  // If |a| definitely has less than |e| bits, just BN_copy.
  if ((size_t)a->width < num_words) {
    return BN_copy(r, a) != nullptr;
  }

  // Otherwise, first make sure we have enough space in |r|.
  // Note that this will fail if num_words > INT_MAX.
  if (!bn_wexpand(r, num_words)) {
    return 0;
  }

  // Copy the content of |a| into |r|.
  OPENSSL_memcpy(r->d, a->d, num_words * sizeof(BN_ULONG));

  // If |e| isn't word-aligned, we have to mask off some of our bits.
  size_t top_word_exponent = e % (sizeof(BN_ULONG) * 8);
  if (top_word_exponent != 0) {
    r->d[num_words - 1] &= (((BN_ULONG)1) << top_word_exponent) - 1;
  }

  // Fill in the remaining fields of |r|.
  r->neg = a->neg;
  r->width = (int)num_words;
  bn_set_minimal_width(r);
  return 1;
}

int BN_nnmod_pow2(BIGNUM *r, const BIGNUM *a, size_t e) {
  if (!BN_mod_pow2(r, a, e)) {
    return 0;
  }

  // If the returned value was non-negative, we're done.
  if (BN_is_zero(r) || !r->neg) {
    return 1;
  }

  size_t num_words = 1 + (e - 1) / BN_BITS2;

  // Expand |r| to the size of our modulus.
  if (!bn_wexpand(r, num_words)) {
    return 0;
  }

  // Clear the upper words of |r|.
  OPENSSL_memset(&r->d[r->width], 0, (num_words - r->width) * BN_BYTES);

  // Set parameters of |r|.
  r->neg = 0;
  r->width = (int)num_words;

  // Now, invert every word. The idea here is that we want to compute 2^e-|x|,
  // which is actually equivalent to the twos-complement representation of |x|
  // in |e| bits, which is -x = ~x + 1.
  for (int i = 0; i < r->width; i++) {
    r->d[i] = ~r->d[i];
  }

  // If our exponent doesn't span the top word, we have to mask the rest.
  size_t top_word_exponent = e % BN_BITS2;
  if (top_word_exponent != 0) {
    r->d[r->width - 1] &= (((BN_ULONG)1) << top_word_exponent) - 1;
  }

  // Keep the minimal-width invariant for |BIGNUM|.
  bn_set_minimal_width(r);

  // Finally, add one, for the reason described above.
  return BN_add(r, r, BN_value_one());
}
