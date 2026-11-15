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
#include <stdlib.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../../internal.h"
#include "internal.h"


static void bn_mul_normal(BN_ULONG *r, const BN_ULONG *a, size_t na,
                          const BN_ULONG *b, size_t nb) {
  if (na < nb) {
    size_t itmp = na;
    na = nb;
    nb = itmp;
    const BN_ULONG *ltmp = a;
    a = b;
    b = ltmp;
  }
  BN_ULONG *rr = &(r[na]);
  if (nb == 0) {
    OPENSSL_memset(r, 0, na * sizeof(BN_ULONG));
    return;
  }
  rr[0] = bn_mul_words(r, a, na, b[0]);

  for (;;) {
    if (--nb == 0) {
      return;
    }
    rr[1] = bn_mul_add_words(&(r[1]), a, na, b[1]);
    if (--nb == 0) {
      return;
    }
    rr[2] = bn_mul_add_words(&(r[2]), a, na, b[2]);
    if (--nb == 0) {
      return;
    }
    rr[3] = bn_mul_add_words(&(r[3]), a, na, b[3]);
    if (--nb == 0) {
      return;
    }
    rr[4] = bn_mul_add_words(&(r[4]), a, na, b[4]);
    rr += 4;
    r += 4;
    b += 4;
  }
}

// bn_sub_part_words sets |r| to |a| - |b|. It returns the borrow bit, which is
// one if the operation underflowed and zero otherwise. |cl| is the common
// length, that is, the shorter of len(a) or len(b). |dl| is the delta length,
// that is, len(a) - len(b). |r|'s length matches the larger of |a| and |b|, or
// cl + abs(dl).
//
// TODO(davidben): Make this take |size_t|. The |cl| + |dl| calling convention
// is confusing.
static BN_ULONG bn_sub_part_words(BN_ULONG *r, const BN_ULONG *a,
                                  const BN_ULONG *b, int cl, int dl) {
  assert(cl >= 0);
  BN_ULONG borrow = bn_sub_words(r, a, b, cl);
  if (dl == 0) {
    return borrow;
  }

  r += cl;
  a += cl;
  b += cl;

  if (dl < 0) {
    // |a| is shorter than |b|. Complete the subtraction as if the excess words
    // in |a| were zeros.
    dl = -dl;
    for (int i = 0; i < dl; i++) {
      r[i] = CRYPTO_subc_w(0, b[i], borrow, &borrow);
    }
  } else {
    // |b| is shorter than |a|. Complete the subtraction as if the excess words
    // in |b| were zeros.
    for (int i = 0; i < dl; i++) {
      r[i] = CRYPTO_subc_w(a[i], 0, borrow, &borrow);
    }
  }

  return borrow;
}

// bn_abs_sub_part_words computes |r| = |a| - |b|, storing the absolute value
// and returning a mask of all ones if the result was negative and all zeros if
// the result was positive. |cl| and |dl| follow the |bn_sub_part_words| calling
// convention.
//
// TODO(davidben): Make this take |size_t|. The |cl| + |dl| calling convention
// is confusing.
//
// TODO(davidben): This function used to be used as part of a general Karatsuba
// multiplication implementation, which had to account for differently-sized
// inputs. Now it is only used as part of RSA key generation, which does not
// need all this.
static BN_ULONG bn_abs_sub_part_words(BN_ULONG *r, const BN_ULONG *a,
                                      const BN_ULONG *b, int cl, int dl,
                                      BN_ULONG *tmp) {
  BN_ULONG borrow = bn_sub_part_words(tmp, a, b, cl, dl);
  bn_sub_part_words(r, b, a, cl, -dl);
  int r_len = cl + (dl < 0 ? -dl : dl);
  borrow = 0 - borrow;
  bn_select_words(r, borrow, r /* tmp < 0 */, tmp /* tmp >= 0 */, r_len);
  return borrow;
}

int bn_abs_sub_consttime(BIGNUM *r, const BIGNUM *a, const BIGNUM *b,
                         BN_CTX *ctx) {
  int cl = a->width < b->width ? a->width : b->width;
  int dl = a->width - b->width;
  int r_len = a->width < b->width ? b->width : a->width;
  bssl::BN_CTXScope scope(ctx);
  BIGNUM *tmp = BN_CTX_get(ctx);
  if (tmp == nullptr || !bn_wexpand(r, r_len) || !bn_wexpand(tmp, r_len)) {
    return 0;
  }
  bn_abs_sub_part_words(r->d, a->d, b->d, cl, dl, tmp->d);
  r->width = r_len;
  return 1;
}

// bn_mul_impl implements |BN_mul| and |bn_mul_consttime|. Note this function
// breaks |BIGNUM| invariants and may return a negative zero. This is handled by
// the callers.
static int bn_mul_impl(BIGNUM *r, const BIGNUM *a, const BIGNUM *b,
                       BN_CTX *ctx) {
  int al = a->width;
  int bl = b->width;
  if (al == 0 || bl == 0) {
    BN_zero(r);
    return 1;
  }

  int i, top;
  BIGNUM *rr;
  bssl::BN_CTXScope scope(ctx);
  if (r == a || r == b) {
    rr = BN_CTX_get(ctx);
    if (rr == nullptr) {
      return 0;
    }
  } else {
    rr = r;
  }
  rr->neg = a->neg ^ b->neg;

  i = al - bl;
  if (i == 0) {
    if (al == 8) {
      if (!bn_wexpand(rr, 16)) {
        return 0;
      }
      rr->width = 16;
      bn_mul_comba8(rr->d, a->d, b->d);
      goto end;
    }
  }

  top = al + bl;
  if (!bn_wexpand(rr, top)) {
    return 0;
  }
  rr->width = top;
  bn_mul_normal(rr->d, a->d, al, b->d, bl);

end:
  if (r != rr && !BN_copy(r, rr)) {
    return 0;
  }
  return 1;
}

int BN_mul(BIGNUM *r, const BIGNUM *a, const BIGNUM *b, BN_CTX *ctx) {
  if (!bn_mul_impl(r, a, b, ctx)) {
    return 0;
  }

  // This additionally fixes any negative zeros created by |bn_mul_impl|.
  bn_set_minimal_width(r);
  return 1;
}

int bn_mul_consttime(BIGNUM *r, const BIGNUM *a, const BIGNUM *b, BN_CTX *ctx) {
  // Prevent negative zeros.
  if (a->neg || b->neg) {
    OPENSSL_PUT_ERROR(BN, BN_R_NEGATIVE_NUMBER);
    return 0;
  }

  return bn_mul_impl(r, a, b, ctx);
}

void bn_mul_small(BN_ULONG *r, size_t num_r, const BN_ULONG *a, size_t num_a,
                  const BN_ULONG *b, size_t num_b) {
  if (num_r != num_a + num_b) {
    abort();
  }
  // TODO(davidben): Should this call |bn_mul_comba4| too? |BN_mul| does not
  // hit that code.
  if (num_a == 8 && num_b == 8) {
    bn_mul_comba8(r, a, b);
  } else {
    bn_mul_normal(r, a, num_a, b, num_b);
  }
}

static void bn_sqr_normal(BN_ULONG *r, const BN_ULONG *a, size_t n) {
  if (n == 0) {
    return;
  }

  size_t max = n * 2;
  const BN_ULONG *ap = a;
  BN_ULONG *rp = r;
  rp[0] = rp[max - 1] = 0;
  rp++;

  // Compute the contribution of a[i] * a[j] for all i < j.
  if (n > 1) {
    ap++;
    rp[n - 1] = bn_mul_words(rp, ap, n - 1, ap[-1]);
    rp += 2;
  }
  if (n > 2) {
    for (size_t i = n - 2; i > 0; i--) {
      ap++;
      rp[i] = bn_mul_add_words(rp, ap, i, ap[-1]);
      rp += 2;
    }
  }

  // The final result fits in |max| words, so none of the following operations
  // will overflow.

  // Double |r|, giving the contribution of a[i] * a[j] for all i != j.
  bn_add_words(r, r, r, max);

  // Add in the contribution of a[i] * a[i] for all i.
  bn_sqr_add_words(r, a, n);
}

int BN_mul_word(BIGNUM *bn, BN_ULONG w) {
  if (!bn->width) {
    return 1;
  }

  if (w == 0) {
    BN_zero(bn);
    return 1;
  }

  BN_ULONG ll = bn_mul_words(bn->d, bn->d, bn->width, w);
  if (ll) {
    if (!bn_wexpand(bn, bn->width + 1)) {
      return 0;
    }
    bn->d[bn->width++] = ll;
  }

  return 1;
}

int bn_sqr_consttime(BIGNUM *r, const BIGNUM *a, BN_CTX *ctx) {
  int al = a->width;
  if (al <= 0) {
    r->width = 0;
    r->neg = 0;
    return 1;
  }

  bssl::BN_CTXScope scope(ctx);
  BIGNUM *rr = (a != r) ? r : BN_CTX_get(ctx);
  if (!rr) {
    return 0;
  }

  int max = 2 * al;  // Non-zero (from above)
  if (!bn_wexpand(rr, max)) {
    return 0;
  }

  if (al == 4) {
    bn_sqr_comba4(rr->d, a->d);
  } else if (al == 8) {
    bn_sqr_comba8(rr->d, a->d);
  } else {
    bn_sqr_normal(rr->d, a->d, al);
  }

  rr->neg = 0;
  rr->width = max;

  if (rr != r && !BN_copy(r, rr)) {
    return 0;
  }
  return 1;
}

int BN_sqr(BIGNUM *r, const BIGNUM *a, BN_CTX *ctx) {
  if (!bn_sqr_consttime(r, a, ctx)) {
    return 0;
  }

  bn_set_minimal_width(r);
  return 1;
}

void bn_sqr_small(BN_ULONG *r, size_t num_r, const BN_ULONG *a, size_t num_a) {
  assert(r != a);
  if (num_r != 2 * num_a) {
    abort();
  }
  if (num_a == 4) {
    bn_sqr_comba4(r, a);
  } else if (num_a == 8) {
    bn_sqr_comba8(r, a);
  } else {
    bn_sqr_normal(r, a, num_a);
  }
}
