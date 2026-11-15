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
#include <openssl/span.h>

#define CHECK(expr)                 \
  do {                              \
    if (!(expr)) {                  \
      printf("%s failed\n", #expr); \
      abort();                      \
    }                               \
  } while (false)

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  CBS cbs, child0, child1;
  uint8_t sign0, sign1;
  CBS_init(&cbs, buf, len);
  if (!CBS_get_u16_length_prefixed(&cbs, &child0) ||
      !CBS_get_u8(&child0, &sign0) ||
      CBS_len(&child0) == 0 ||
      !CBS_get_u16_length_prefixed(&cbs, &child1) ||
      !CBS_get_u8(&child1, &sign1) ||
      CBS_len(&child1) == 0) {
    return 0;
  }

  bssl::UniquePtr<BIGNUM> numerator(
      BN_bin2bn(CBS_data(&child0), CBS_len(&child0), nullptr));
  BN_set_negative(numerator.get(), sign0 % 2);
  bssl::UniquePtr<BIGNUM> divisor(
      BN_bin2bn(CBS_data(&child1), CBS_len(&child1), nullptr));
  BN_set_negative(divisor.get(), sign1 % 2);

  if (BN_is_zero(divisor.get())) {
    return 0;
  }

  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  bssl::UniquePtr<BIGNUM> result(BN_new());
  bssl::UniquePtr<BIGNUM> remainder(BN_new());
  CHECK(ctx);
  CHECK(result);
  CHECK(remainder);


  CHECK(BN_div(result.get(), remainder.get(), numerator.get(), divisor.get(),
               ctx.get()));
  CHECK(BN_ucmp(remainder.get(), divisor.get()) < 0);

  // Check that result*divisor+remainder = numerator.
  CHECK(BN_mul(result.get(), result.get(), divisor.get(), ctx.get()));
  CHECK(BN_add(result.get(), result.get(), remainder.get()));
  CHECK(BN_cmp(result.get(), numerator.get()) == 0);

  return 0;
}
