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

#include <openssl/dsa.h>

#include <string.h>

#include <openssl/bn.h>
#include <openssl/dh.h>
#include <openssl/digest.h>
#include <openssl/engine.h>
#include <openssl/err.h>
#include <openssl/ex_data.h>
#include <openssl/mem.h>
#include <openssl/rand.h>
#include <openssl/sha2.h>

#include "../fipsmodule/bn/internal.h"
#include "../fipsmodule/dh/internal.h"
#include "../internal.h"
#include "internal.h"


static_assert(OPENSSL_DSA_MAX_MODULUS_BITS <=
                  BN_MONTGOMERY_MAX_WORDS * BN_BITS2,
              "Max DSA size too big for Montgomery arithmetic");

// Primality test according to FIPS PUB 186[-1], Appendix 2.1: 50 rounds of
// Miller-Rabin.
#define DSS_prime_checks 50

static int dsa_sign_setup(const DSA *dsa, BN_CTX *ctx_in, BIGNUM **out_kinv,
                          BIGNUM **out_r);

static CRYPTO_EX_DATA_CLASS g_ex_data_class = CRYPTO_EX_DATA_CLASS_INIT;

DSA *DSA_new(void) {
  DSA *dsa = reinterpret_cast<DSA *>(OPENSSL_zalloc(sizeof(DSA)));
  if (dsa == nullptr) {
    return nullptr;
  }

  dsa->references = 1;
  CRYPTO_MUTEX_init(&dsa->method_mont_lock);
  CRYPTO_new_ex_data(&dsa->ex_data);
  return dsa;
}

void DSA_free(DSA *dsa) {
  if (dsa == nullptr) {
    return;
  }

  if (!CRYPTO_refcount_dec_and_test_zero(&dsa->references)) {
    return;
  }

  CRYPTO_free_ex_data(&g_ex_data_class, &dsa->ex_data);

  BN_clear_free(dsa->p);
  BN_clear_free(dsa->q);
  BN_clear_free(dsa->g);
  BN_clear_free(dsa->pub_key);
  BN_clear_free(dsa->priv_key);
  BN_MONT_CTX_free(dsa->method_mont_p);
  BN_MONT_CTX_free(dsa->method_mont_q);
  CRYPTO_MUTEX_cleanup(&dsa->method_mont_lock);
  OPENSSL_free(dsa);
}

int DSA_up_ref(DSA *dsa) {
  CRYPTO_refcount_inc(&dsa->references);
  return 1;
}

unsigned DSA_bits(const DSA *dsa) { return BN_num_bits(dsa->p); }

const BIGNUM *DSA_get0_pub_key(const DSA *dsa) { return dsa->pub_key; }

const BIGNUM *DSA_get0_priv_key(const DSA *dsa) { return dsa->priv_key; }

const BIGNUM *DSA_get0_p(const DSA *dsa) { return dsa->p; }

const BIGNUM *DSA_get0_q(const DSA *dsa) { return dsa->q; }

const BIGNUM *DSA_get0_g(const DSA *dsa) { return dsa->g; }

void DSA_get0_key(const DSA *dsa, const BIGNUM **out_pub_key,
                  const BIGNUM **out_priv_key) {
  if (out_pub_key != nullptr) {
    *out_pub_key = dsa->pub_key;
  }
  if (out_priv_key != nullptr) {
    *out_priv_key = dsa->priv_key;
  }
}

void DSA_get0_pqg(const DSA *dsa, const BIGNUM **out_p, const BIGNUM **out_q,
                  const BIGNUM **out_g) {
  if (out_p != nullptr) {
    *out_p = dsa->p;
  }
  if (out_q != nullptr) {
    *out_q = dsa->q;
  }
  if (out_g != nullptr) {
    *out_g = dsa->g;
  }
}

int DSA_set0_key(DSA *dsa, BIGNUM *pub_key, BIGNUM *priv_key) {
  if (dsa->pub_key == nullptr && pub_key == nullptr) {
    return 0;
  }

  if (pub_key != nullptr) {
    BN_free(dsa->pub_key);
    dsa->pub_key = pub_key;
  }
  if (priv_key != nullptr) {
    BN_free(dsa->priv_key);
    dsa->priv_key = priv_key;
  }

  return 1;
}

int DSA_set0_pqg(DSA *dsa, BIGNUM *p, BIGNUM *q, BIGNUM *g) {
  if ((dsa->p == nullptr && p == nullptr) ||
      (dsa->q == nullptr && q == nullptr) ||
      (dsa->g == nullptr && g == nullptr)) {
    return 0;
  }

  if (p != nullptr) {
    BN_free(dsa->p);
    dsa->p = p;
  }
  if (q != nullptr) {
    BN_free(dsa->q);
    dsa->q = q;
  }
  if (g != nullptr) {
    BN_free(dsa->g);
    dsa->g = g;
  }

  BN_MONT_CTX_free(dsa->method_mont_p);
  dsa->method_mont_p = nullptr;
  BN_MONT_CTX_free(dsa->method_mont_q);
  dsa->method_mont_q = nullptr;
  return 1;
}

int DSA_generate_parameters_ex(DSA *dsa, unsigned bits, const uint8_t *seed_in,
                               size_t seed_len, int *out_counter,
                               unsigned long *out_h, BN_GENCB *cb) {
  if (bits > OPENSSL_DSA_MAX_MODULUS_BITS) {
    OPENSSL_PUT_ERROR(DSA, DSA_R_INVALID_PARAMETERS);
    return 0;
  }

  unsigned char seed[SHA256_DIGEST_LENGTH];
  unsigned char md[SHA256_DIGEST_LENGTH];
  unsigned char buf[SHA256_DIGEST_LENGTH], buf2[SHA256_DIGEST_LENGTH];
  BIGNUM *r0, *W, *X, *c, *test;
  BIGNUM *g = nullptr, *q = nullptr, *p = nullptr;
  int k, n = 0, m = 0;
  int counter = 0;
  int r = 0;
  unsigned int h = 2;
  const EVP_MD *evpmd;

  evpmd = (bits >= 2048) ? EVP_sha256() : EVP_sha1();
  size_t qsize = EVP_MD_size(evpmd);

  if (bits < 512) {
    bits = 512;
  }

  bits = (bits + 63) / 64 * 64;

  if (seed_in != nullptr) {
    if (seed_len < qsize) {
      return 0;
    }
    if (seed_len > qsize) {
      // Only consume as much seed as is expected.
      seed_len = qsize;
    }
    OPENSSL_memcpy(seed, seed_in, seed_len);
  }

  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  if (ctx == nullptr) {
    return 0;
  }
  bssl::BN_CTXScope scope(ctx.get());

  r0 = BN_CTX_get(ctx.get());
  g = BN_CTX_get(ctx.get());
  W = BN_CTX_get(ctx.get());
  q = BN_CTX_get(ctx.get());
  X = BN_CTX_get(ctx.get());
  c = BN_CTX_get(ctx.get());
  p = BN_CTX_get(ctx.get());
  test = BN_CTX_get(ctx.get());

  if (test == nullptr || !BN_lshift(test, BN_value_one(), bits - 1)) {
    return 0;
  }

  for (;;) {
    // Find q.
    for (;;) {
      // step 1
      if (!BN_GENCB_call(cb, BN_GENCB_GENERATED, m++)) {
        return 0;
      }

      int use_random_seed = (seed_in == nullptr);
      if (use_random_seed) {
        if (!RAND_bytes(seed, qsize)) {
          return 0;
        }
        // DSA parameters are public.
        CONSTTIME_DECLASSIFY(seed, qsize);
      } else {
        // If we come back through, use random seed next time.
        seed_in = nullptr;
      }
      OPENSSL_memcpy(buf, seed, qsize);
      OPENSSL_memcpy(buf2, seed, qsize);
      // precompute "SEED + 1" for step 7:
      for (size_t i = qsize - 1; i < qsize; i--) {
        buf[i]++;
        if (buf[i] != 0) {
          break;
        }
      }

      // step 2
      if (!EVP_Digest(seed, qsize, md, nullptr, evpmd, nullptr) ||
          !EVP_Digest(buf, qsize, buf2, nullptr, evpmd, nullptr)) {
        return 0;
      }
      for (size_t i = 0; i < qsize; i++) {
        md[i] ^= buf2[i];
      }

      // step 3
      md[0] |= 0x80;
      md[qsize - 1] |= 0x01;
      if (!BN_bin2bn(md, qsize, q)) {
        return 0;
      }

      // step 4
      r = BN_is_prime_fasttest_ex(q, DSS_prime_checks, ctx.get(),
                                  use_random_seed, cb);
      if (r > 0) {
        break;
      }
      if (r != 0) {
        return 0;
      }

      // do a callback call
      // step 5
    }

    if (!BN_GENCB_call(cb, 2, 0) || !BN_GENCB_call(cb, 3, 0)) {
      return 0;
    }

    // step 6
    counter = 0;
    // "offset = 2"

    n = (bits - 1) / 160;

    for (;;) {
      if ((counter != 0) && !BN_GENCB_call(cb, BN_GENCB_GENERATED, counter)) {
        return 0;
      }

      // step 7
      BN_zero(W);
      // now 'buf' contains "SEED + offset - 1"
      for (k = 0; k <= n; k++) {
        // obtain "SEED + offset + k" by incrementing:
        for (size_t i = qsize - 1; i < qsize; i--) {
          buf[i]++;
          if (buf[i] != 0) {
            break;
          }
        }

        if (!EVP_Digest(buf, qsize, md, nullptr, evpmd, nullptr)) {
          return 0;
        }

        // step 8
        if (!BN_bin2bn(md, qsize, r0) || !BN_lshift(r0, r0, (qsize << 3) * k) ||
            !BN_add(W, W, r0)) {
          return 0;
        }
      }

      // more of step 8
      if (!BN_mask_bits(W, bits - 1) || !BN_copy(X, W) || !BN_add(X, X, test)) {
        return 0;
      }

      // step 9
      if (!BN_lshift1(r0, q) || !BN_mod(c, X, r0, ctx.get()) ||
          !BN_sub(r0, c, BN_value_one()) || !BN_sub(p, X, r0)) {
        return 0;
      }

      // step 10
      if (BN_cmp(p, test) >= 0) {
        // step 11
        r = BN_is_prime_fasttest_ex(p, DSS_prime_checks, ctx.get(), 1, cb);
        if (r > 0) {
          goto end;  // found it
        }
        if (r != 0) {
          return 0;
        }
      }

      // step 13
      counter++;
      // "offset = offset + n + 1"

      // step 14
      if (counter >= 4096) {
        break;
      }
    }
  }
end:
  if (!BN_GENCB_call(cb, 2, 1)) {
    return 0;
  }

  // We now need to generate g
  // Set r0=(p-1)/q
  if (!BN_sub(test, p, BN_value_one()) ||
      !BN_div(r0, nullptr, test, q, ctx.get())) {
    return 0;
  }

  bssl::UniquePtr<BN_MONT_CTX> mont(BN_MONT_CTX_new_for_modulus(p, ctx.get()));
  if (mont == nullptr || !BN_set_word(test, h)) {
    return 0;
  }

  for (;;) {
    // g=test^r0%p
    if (!BN_mod_exp_mont(g, test, r0, p, ctx.get(), mont.get())) {
      return 0;
    }
    if (!BN_is_one(g)) {
      break;
    }
    if (!BN_add(test, test, BN_value_one())) {
      return 0;
    }
    h++;
  }

  if (!BN_GENCB_call(cb, 3, 1)) {
    return 0;
  }

  BN_free(dsa->p);
  BN_free(dsa->q);
  BN_free(dsa->g);
  dsa->p = BN_dup(p);
  dsa->q = BN_dup(q);
  dsa->g = BN_dup(g);
  if (dsa->p == nullptr || dsa->q == nullptr || dsa->g == nullptr) {
    return 0;
  }
  if (out_counter != nullptr) {
    *out_counter = counter;
  }
  if (out_h != nullptr) {
    *out_h = h;
  }

  return 1;
}

DSA *DSAparams_dup(const DSA *dsa) {
  DSA *ret = DSA_new();
  if (ret == nullptr) {
    return nullptr;
  }
  ret->p = BN_dup(dsa->p);
  ret->q = BN_dup(dsa->q);
  ret->g = BN_dup(dsa->g);
  if (ret->p == nullptr || ret->q == nullptr || ret->g == nullptr) {
    DSA_free(ret);
    return nullptr;
  }
  return ret;
}

int DSA_generate_key(DSA *dsa) {
  if (!dsa_check_key(dsa)) {
    return 0;
  }

  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  if (ctx == nullptr) {
    return 0;
  }

  int ok = 0;
  BIGNUM *pub_key = nullptr;
  BIGNUM *priv_key = dsa->priv_key;
  if (priv_key == nullptr) {
    priv_key = BN_new();
    if (priv_key == nullptr) {
      goto err;
    }
  }

  if (!BN_rand_range_ex(priv_key, 1, dsa->q)) {
    goto err;
  }

  pub_key = dsa->pub_key;
  if (pub_key == nullptr) {
    pub_key = BN_new();
    if (pub_key == nullptr) {
      goto err;
    }
  }

  if (!BN_MONT_CTX_set_locked(&dsa->method_mont_p, &dsa->method_mont_lock,
                              dsa->p, ctx.get()) ||
      !BN_mod_exp_mont_consttime(pub_key, dsa->g, priv_key, dsa->p, ctx.get(),
                                 dsa->method_mont_p)) {
    goto err;
  }

  // The public key is computed from the private key, but is public.
  bn_declassify(pub_key);

  dsa->priv_key = priv_key;
  dsa->pub_key = pub_key;
  ok = 1;

err:
  if (dsa->pub_key == nullptr) {
    BN_free(pub_key);
  }
  if (dsa->priv_key == nullptr) {
    BN_free(priv_key);
  }

  return ok;
}

DSA_SIG *DSA_SIG_new(void) {
  return reinterpret_cast<DSA_SIG *>(OPENSSL_zalloc(sizeof(DSA_SIG)));
}

void DSA_SIG_free(DSA_SIG *sig) {
  if (!sig) {
    return;
  }

  BN_free(sig->r);
  BN_free(sig->s);
  OPENSSL_free(sig);
}

void DSA_SIG_get0(const DSA_SIG *sig, const BIGNUM **out_r,
                  const BIGNUM **out_s) {
  if (out_r != nullptr) {
    *out_r = sig->r;
  }
  if (out_s != nullptr) {
    *out_s = sig->s;
  }
}

int DSA_SIG_set0(DSA_SIG *sig, BIGNUM *r, BIGNUM *s) {
  if (r == nullptr || s == nullptr) {
    return 0;
  }
  BN_free(sig->r);
  BN_free(sig->s);
  sig->r = r;
  sig->s = s;
  return 1;
}

// mod_mul_consttime sets |r| to |a| * |b| modulo |mont->N|, treating |a| and
// |b| as secret. This function internally uses Montgomery reduction, but
// neither inputs nor outputs are in Montgomery form.
static int mod_mul_consttime(BIGNUM *r, const BIGNUM *a, const BIGNUM *b,
                             const BN_MONT_CTX *mont, BN_CTX *ctx) {
  bssl::BN_CTXScope scope(ctx);
  BIGNUM *tmp = BN_CTX_get(ctx);
  // |BN_mod_mul_montgomery| removes a factor of R, so we cancel it with a
  // single |BN_to_montgomery| which adds one factor of R.
  return tmp != nullptr &&  //
         BN_to_montgomery(tmp, a, mont, ctx) &&
         BN_mod_mul_montgomery(r, tmp, b, mont, ctx);
}

DSA_SIG *DSA_do_sign(const uint8_t *digest, size_t digest_len, const DSA *dsa) {
  if (!dsa_check_key(dsa)) {
    return nullptr;
  }

  if (dsa->priv_key == nullptr) {
    OPENSSL_PUT_ERROR(DSA, DSA_R_MISSING_PARAMETERS);
    return nullptr;
  }

  BIGNUM *kinv = nullptr, *r = nullptr, *s = nullptr;
  BIGNUM m;
  BIGNUM xr;
  BN_CTX *ctx = nullptr;
  DSA_SIG *ret = nullptr;

  BN_init(&m);
  BN_init(&xr);
  s = BN_new();
  {
    if (s == nullptr) {
      goto err;
    }
    ctx = BN_CTX_new();
    if (ctx == nullptr) {
      goto err;
    }

    // Cap iterations so that invalid parameters do not infinite loop. This does
    // not impact valid parameters because the probability of requiring even one
    // retry is negligible, let alone 32. Unfortunately, DSA was mis-specified,
    // so invalid parameters are reachable from most callers handling untrusted
    // private keys. (The |dsa_check_key| call above is not sufficient. Checking
    // whether arbitrary parameters form a valid DSA group is expensive.)
    static const int kMaxIterations = 32;
    int iters = 0;
  redo:
    if (!dsa_sign_setup(dsa, ctx, &kinv, &r)) {
      goto err;
    }

    if (digest_len > BN_num_bytes(dsa->q)) {
      // If the digest length is greater than the size of |dsa->q| use the
      // BN_num_bits(dsa->q) leftmost bits of the digest, see FIPS 186-3, 4.2.
      // Note the above check that |dsa->q| is a multiple of 8 bits.
      digest_len = BN_num_bytes(dsa->q);
    }

    if (BN_bin2bn(digest, digest_len, &m) == nullptr) {
      goto err;
    }

    // |m| is bounded by 2^(num_bits(q)), which is slightly looser than q. This
    // violates |bn_mod_add_consttime| and |mod_mul_consttime|'s preconditions.
    // (The underlying algorithms could accept looser bounds, but we reduce for
    // simplicity.)
    size_t q_width = bn_minimal_width(dsa->q);
    if (!bn_resize_words(&m, q_width) || !bn_resize_words(&xr, q_width)) {
      goto err;
    }
    bn_reduce_once_in_place(m.d, 0 /* no carry word */, dsa->q->d,
                            xr.d /* scratch space */, q_width);

    // Compute s = inv(k) (m + xr) mod q. Note |dsa->method_mont_q| is
    // initialized by |dsa_sign_setup|.
    if (!mod_mul_consttime(&xr, dsa->priv_key, r, dsa->method_mont_q, ctx) ||
        !bn_mod_add_consttime(s, &xr, &m, dsa->q, ctx) ||
        !mod_mul_consttime(s, s, kinv, dsa->method_mont_q, ctx)) {
      goto err;
    }

    // The signature is computed from the private key, but is public.
    bn_declassify(r);
    bn_declassify(s);

    // Redo if r or s is zero as required by FIPS 186-3: this is
    // very unlikely.
    if (BN_is_zero(r) || BN_is_zero(s)) {
      iters++;
      if (iters > kMaxIterations) {
        OPENSSL_PUT_ERROR(DSA, DSA_R_TOO_MANY_ITERATIONS);
        goto err;
      }
      goto redo;
    }

    ret = DSA_SIG_new();
    if (ret == nullptr) {
      goto err;
    }
    ret->r = r;
    ret->s = s;
  }

err:
  if (ret == nullptr) {
    OPENSSL_PUT_ERROR(DSA, ERR_R_BN_LIB);
    BN_free(r);
    BN_free(s);
  }
  BN_CTX_free(ctx);
  BN_clear_free(&m);
  BN_clear_free(&xr);
  BN_clear_free(kinv);

  return ret;
}

int DSA_do_verify(const uint8_t *digest, size_t digest_len, const DSA_SIG *sig,
                  const DSA *dsa) {
  int valid;
  if (!DSA_do_check_signature(&valid, digest, digest_len, sig, dsa)) {
    return -1;
  }
  return valid;
}

int DSA_do_check_signature(int *out_valid, const uint8_t *digest,
                           size_t digest_len, const DSA_SIG *sig,
                           const DSA *dsa) {
  *out_valid = 0;
  if (!dsa_check_key(dsa)) {
    return 0;
  }

  if (dsa->pub_key == nullptr) {
    OPENSSL_PUT_ERROR(DSA, DSA_R_MISSING_PARAMETERS);
    return 0;
  }

  int ret = 0;
  BIGNUM u1, u2, t1;
  BN_init(&u1);
  BN_init(&u2);
  BN_init(&t1);
  BN_CTX *ctx = BN_CTX_new();
  {
    if (ctx == nullptr) {
      goto err;
    }

    if (BN_is_zero(sig->r) || BN_is_negative(sig->r) ||
        BN_ucmp(sig->r, dsa->q) >= 0) {
      ret = 1;
      goto err;
    }
    if (BN_is_zero(sig->s) || BN_is_negative(sig->s) ||
        BN_ucmp(sig->s, dsa->q) >= 0) {
      ret = 1;
      goto err;
    }

    if (!BN_MONT_CTX_set_locked((BN_MONT_CTX **)&dsa->method_mont_p,
                                (CRYPTO_MUTEX *)&dsa->method_mont_lock, dsa->p,
                                ctx) ||
        !BN_MONT_CTX_set_locked((BN_MONT_CTX **)&dsa->method_mont_q,
                                (CRYPTO_MUTEX *)&dsa->method_mont_lock, dsa->q,
                                ctx)) {
      goto err;
    }

    // Calculate W = inv(S) mod Q, in the Montgomery domain. This is slightly
    // more efficiently computed as FromMont(s)^-1 = (s * R^-1)^-1 = s^-1 * R,
    // instead of ToMont(s^-1) = s^-1 * R.
    if (!BN_from_montgomery(&u2, sig->s, dsa->method_mont_q, ctx) ||
        !BN_mod_inverse(&u2, &u2, dsa->q, ctx)) {
      goto err;
    }

    // save M in u1
    unsigned q_bits = BN_num_bits(dsa->q);
    if (digest_len > (q_bits >> 3)) {
      // if the digest length is greater than the size of q use the
      // BN_num_bits(dsa->q) leftmost bits of the digest, see
      // fips 186-3, 4.2
      digest_len = (q_bits >> 3);
    }

    if (BN_bin2bn(digest, digest_len, &u1) == nullptr) {
      goto err;
    }

    // u1 = M * w mod q. w was stored in the Montgomery domain while M was not,
    // so the result will already be out of the Montgomery domain.
    if (!BN_mod_mul_montgomery(&u1, &u1, &u2, dsa->method_mont_q, ctx)) {
      goto err;
    }

    // u2 = r * w mod q. w was stored in the Montgomery domain while r was not,
    // so the result will already be out of the Montgomery domain.
    if (!BN_mod_mul_montgomery(&u2, sig->r, &u2, dsa->method_mont_q, ctx)) {
      goto err;
    }

    if (!BN_mod_exp2_mont(&t1, dsa->g, &u1, dsa->pub_key, &u2, dsa->p, ctx,
                          dsa->method_mont_p)) {
      goto err;
    }

    // let u1 = u1 mod q
    if (!BN_mod(&u1, &t1, dsa->q, ctx)) {
      goto err;
    }

    // V is now in u1.  If the signature is correct, it will be
    // equal to R.
    *out_valid = BN_ucmp(&u1, sig->r) == 0;
    ret = 1;
  }

err:
  if (ret != 1) {
    OPENSSL_PUT_ERROR(DSA, ERR_R_BN_LIB);
  }
  BN_CTX_free(ctx);
  BN_free(&u1);
  BN_free(&u2);
  BN_free(&t1);

  return ret;
}

int DSA_sign(int type, const uint8_t *digest, size_t digest_len,
             uint8_t *out_sig, unsigned int *out_siglen, const DSA *dsa) {
  DSA_SIG *s;

  s = DSA_do_sign(digest, digest_len, dsa);
  if (s == nullptr) {
    *out_siglen = 0;
    return 0;
  }

  *out_siglen = i2d_DSA_SIG(s, &out_sig);
  DSA_SIG_free(s);
  return 1;
}

int DSA_verify(int type, const uint8_t *digest, size_t digest_len,
               const uint8_t *sig, size_t sig_len, const DSA *dsa) {
  int valid;
  if (!DSA_check_signature(&valid, digest, digest_len, sig, sig_len, dsa)) {
    return -1;
  }
  return valid;
}

int DSA_check_signature(int *out_valid, const uint8_t *digest,
                        size_t digest_len, const uint8_t *sig, size_t sig_len,
                        const DSA *dsa) {
  DSA_SIG *s = nullptr;
  int ret = 0;
  uint8_t *der = nullptr;

  s = DSA_SIG_new();
  {
    if (s == nullptr) {
      goto err;
    }

    const uint8_t *sigp = sig;
    if (d2i_DSA_SIG(&s, &sigp, sig_len) == nullptr || sigp != sig + sig_len) {
      goto err;
    }

    // Ensure that the signature uses DER and doesn't have trailing garbage.
    int der_len = i2d_DSA_SIG(s, &der);
    if (der_len < 0 || (size_t)der_len != sig_len ||
        OPENSSL_memcmp(sig, der, sig_len)) {
      goto err;
    }

    ret = DSA_do_check_signature(out_valid, digest, digest_len, s, dsa);
  }

err:
  OPENSSL_free(der);
  DSA_SIG_free(s);
  return ret;
}

// der_len_len returns the number of bytes needed to represent a length of |len|
// in DER.
static size_t der_len_len(size_t len) {
  if (len < 0x80) {
    return 1;
  }
  size_t ret = 1;
  while (len > 0) {
    ret++;
    len >>= 8;
  }
  return ret;
}

int DSA_size(const DSA *dsa) {
  if (dsa->q == nullptr) {
    return 0;
  }

  size_t order_len = BN_num_bytes(dsa->q);
  // Compute the maximum length of an |order_len| byte integer. Defensively
  // assume that the leading 0x00 is included.
  size_t integer_len = 1 /* tag */ + der_len_len(order_len + 1) + 1 + order_len;
  if (integer_len < order_len) {
    return 0;
  }
  // A DSA signature is two INTEGERs.
  size_t value_len = 2 * integer_len;
  if (value_len < integer_len) {
    return 0;
  }
  // Add the header.
  size_t ret = 1 /* tag */ + der_len_len(value_len) + value_len;
  if (ret < value_len) {
    return 0;
  }
  return ret;
}

static int dsa_sign_setup(const DSA *dsa, BN_CTX *ctx, BIGNUM **out_kinv,
                          BIGNUM **out_r) {
  int ret = 0;
  BIGNUM k;
  BN_init(&k);
  BIGNUM *r = BN_new();
  BIGNUM *kinv = BN_new();
  if (r == nullptr || kinv == nullptr ||
      // Get random k
      !BN_rand_range_ex(&k, 1, dsa->q) ||
      !BN_MONT_CTX_set_locked((BN_MONT_CTX **)&dsa->method_mont_p,
                              (CRYPTO_MUTEX *)&dsa->method_mont_lock, dsa->p,
                              ctx) ||
      !BN_MONT_CTX_set_locked((BN_MONT_CTX **)&dsa->method_mont_q,
                              (CRYPTO_MUTEX *)&dsa->method_mont_lock, dsa->q,
                              ctx) ||
      // Compute r = (g^k mod p) mod q
      !BN_mod_exp_mont_consttime(r, dsa->g, &k, dsa->p, ctx,
                                 dsa->method_mont_p)) {
    OPENSSL_PUT_ERROR(DSA, ERR_R_BN_LIB);
    goto err;
  }
  // Note |BN_mod| below is not constant-time and may leak information about
  // |r|. |dsa->p| may be significantly larger than |dsa->q|, so this is not
  // easily performed in constant-time with Montgomery reduction.
  //
  // However, |r| at this point is g^k (mod p). It is almost the value of |r|
  // revealed in the signature anyway (g^k (mod p) (mod q)), going from it to
  // |k| would require computing a discrete log.
  bn_declassify(r);
  if (!BN_mod(r, r, dsa->q, ctx) ||
      // Compute part of 's = inv(k) (m + xr) mod q' using Fermat's Little
      // Theorem.
      !bn_mod_inverse_prime(kinv, &k, dsa->q, ctx, dsa->method_mont_q)) {
    OPENSSL_PUT_ERROR(DSA, ERR_R_BN_LIB);
    goto err;
  }

  BN_clear_free(*out_kinv);
  *out_kinv = kinv;
  kinv = nullptr;

  BN_clear_free(*out_r);
  *out_r = r;
  r = nullptr;

  ret = 1;

err:
  BN_clear_free(&k);
  BN_clear_free(r);
  BN_clear_free(kinv);
  return ret;
}

int DSA_get_ex_new_index(long argl, void *argp, CRYPTO_EX_unused *unused,
                         CRYPTO_EX_dup *dup_unused, CRYPTO_EX_free *free_func) {
  return CRYPTO_get_ex_new_index_ex(&g_ex_data_class, argl, argp, free_func);
}

int DSA_set_ex_data(DSA *dsa, int idx, void *arg) {
  return CRYPTO_set_ex_data(&dsa->ex_data, idx, arg);
}

void *DSA_get_ex_data(const DSA *dsa, int idx) {
  return CRYPTO_get_ex_data(&dsa->ex_data, idx);
}

DH *DSA_dup_DH(const DSA *dsa) {
  if (dsa == nullptr) {
    return nullptr;
  }

  bssl::UniquePtr<DH> ret(DH_new());
  if (ret == nullptr) {
    return nullptr;
  }
  if (dsa->q != nullptr) {
    ret->priv_length = BN_num_bits(dsa->q);
    if ((ret->q = BN_dup(dsa->q)) == nullptr) {
      return nullptr;
    }
  }
  if ((dsa->p != nullptr && (ret->p = BN_dup(dsa->p)) == nullptr) ||
      (dsa->g != nullptr && (ret->g = BN_dup(dsa->g)) == nullptr) ||
      (dsa->pub_key != nullptr &&
       (ret->pub_key = BN_dup(dsa->pub_key)) == nullptr) ||
      (dsa->priv_key != nullptr &&
       (ret->priv_key = BN_dup(dsa->priv_key)) == nullptr)) {
    return nullptr;
  }

  return ret.release();
}
