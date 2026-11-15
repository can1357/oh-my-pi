// Copyright 2017 The BoringSSL Authors
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
#include <openssl/bytestring.h>
#include <openssl/mem.h>

#define CHECK(expr)                 \
  do {                              \
    if (!(expr)) {                  \
      printf("%s failed\n", #expr); \
      abort();                      \
    }                               \
  } while (false)

// Basic implementation of mod_exp using square and multiple method.
int mod_exp(BIGNUM *r, const BIGNUM *a, const BIGNUM *p, const BIGNUM *m,
            BN_CTX *ctx) {
  if (BN_is_one(m)) {
    BN_zero(r);
    return 1;
  }

  bssl::UniquePtr<BIGNUM> exp(BN_dup(p));
  bssl::UniquePtr<BIGNUM> base(BN_new());
  if (!exp || !base) {
    return 0;
  }
  if (!BN_one(r) || !BN_nnmod(base.get(), a, m, ctx)) {
    return 0;
  }

  while (!BN_is_zero(exp.get())) {
    if (BN_is_odd(exp.get())) {
      if (!BN_mul(r, r, base.get(), ctx) || !BN_nnmod(r, r, m, ctx)) {
        return 0;
      }
    }
    if (!BN_rshift1(exp.get(), exp.get()) ||
        !BN_mul(base.get(), base.get(), base.get(), ctx) ||
        !BN_nnmod(base.get(), base.get(), m, ctx)) {
      return 0;
    }
  }

  return 1;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  CBS cbs, child0, child1, child2;
  uint8_t sign;
  CBS_init(&cbs, buf, len);
  if (!CBS_get_u16_length_prefixed(&cbs, &child0) ||
      !CBS_get_u8(&child0, &sign) ||
      CBS_len(&child0) == 0 ||
      !CBS_get_u16_length_prefixed(&cbs, &child1) ||
      CBS_len(&child1) == 0 ||
      !CBS_get_u16_length_prefixed(&cbs, &child2) ||
      CBS_len(&child2) == 0) {
    return 0;
  }

  // Don't fuzz inputs larger than 512 bytes (4096 bits). This isn't ideal, but
  // the naive |mod_exp| above is somewhat slow, so this otherwise causes the
  // fuzzers to spend a lot of time exploring timeouts.
  if (CBS_len(&child0) > 512 ||
      CBS_len(&child1) > 512 ||
      CBS_len(&child2) > 512) {
    return 0;
  }

  bssl::UniquePtr<BIGNUM> base(
      BN_bin2bn(CBS_data(&child0), CBS_len(&child0), nullptr));
  BN_set_negative(base.get(), sign % 2);
  bssl::UniquePtr<BIGNUM> power(
      BN_bin2bn(CBS_data(&child1), CBS_len(&child1), nullptr));
  bssl::UniquePtr<BIGNUM> modulus(
      BN_bin2bn(CBS_data(&child2), CBS_len(&child2), nullptr));

  if (BN_is_zero(modulus.get())) {
    return 0;
  }

  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  bssl::UniquePtr<BIGNUM> result(BN_new());
  bssl::UniquePtr<BIGNUM> expected(BN_new());
  CHECK(ctx);
  CHECK(result);
  CHECK(expected);

  CHECK(mod_exp(expected.get(), base.get(), power.get(), modulus.get(),
                ctx.get()));
  CHECK(BN_mod_exp(result.get(), base.get(), power.get(), modulus.get(),
                   ctx.get()));
  CHECK(BN_cmp(result.get(), expected.get()) == 0);

  if (BN_is_odd(modulus.get())) {
    bssl::UniquePtr<BN_MONT_CTX> mont(
        BN_MONT_CTX_new_for_modulus(modulus.get(), ctx.get()));
    CHECK(mont);
    // |BN_mod_exp_mont| and |BN_mod_exp_mont_consttime| require reduced inputs.
    CHECK(BN_nnmod(base.get(), base.get(), modulus.get(), ctx.get()));
    CHECK(BN_mod_exp_mont(result.get(), base.get(), power.get(), modulus.get(),
                          ctx.get(), mont.get()));
    CHECK(BN_cmp(result.get(), expected.get()) == 0);
    CHECK(BN_mod_exp_mont_consttime(result.get(), base.get(), power.get(),
                                    modulus.get(), ctx.get(), mont.get()));
    CHECK(BN_cmp(result.get(), expected.get()) == 0);
  }

  uint8_t *data = (uint8_t *)OPENSSL_malloc(BN_num_bytes(result.get()));
  BN_bn2bin(result.get(), data);
  OPENSSL_free(data);

  return 0;
}
