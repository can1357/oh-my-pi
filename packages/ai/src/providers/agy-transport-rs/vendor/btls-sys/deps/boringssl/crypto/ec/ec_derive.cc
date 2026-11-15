// Copyright 2019 The BoringSSL Authors
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

#include <openssl/ec_key.h>

#include <string.h>

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/digest.h>
#include <openssl/hkdf.h>
#include <openssl/mem.h>

#include "../fipsmodule/ec/internal.h"


EC_KEY *EC_KEY_derive_from_secret(const EC_GROUP *group, const uint8_t *secret,
                                  size_t secret_len) {
#define EC_KEY_DERIVE_MAX_NAME_LEN 16
  const char *name = EC_curve_nid2nist(EC_GROUP_get_curve_name(group));
  if (name == nullptr || strlen(name) > EC_KEY_DERIVE_MAX_NAME_LEN) {
    OPENSSL_PUT_ERROR(EC, EC_R_UNKNOWN_GROUP);
    return nullptr;
  }

  // Assemble a label string to provide some key separation in case |secret| is
  // misused, but ultimately it's on the caller to ensure |secret| is suitably
  // separated.
  static const char kLabel[] = "derive EC key ";
  char info[sizeof(kLabel) + EC_KEY_DERIVE_MAX_NAME_LEN];
  OPENSSL_strlcpy(info, kLabel, sizeof(info));
  OPENSSL_strlcat(info, name, sizeof(info));

  // Generate 128 bits beyond the group order so the bias is at most 2^-128.
#define EC_KEY_DERIVE_EXTRA_BITS 128
#define EC_KEY_DERIVE_EXTRA_BYTES (EC_KEY_DERIVE_EXTRA_BITS / 8)

  if (EC_GROUP_order_bits(group) <= EC_KEY_DERIVE_EXTRA_BITS + 8) {
    // The reduction strategy below requires the group order be large enough.
    // (The actual bound is a bit tighter, but our curves are much larger than
    // 128-bit.)
    OPENSSL_PUT_ERROR(EC, ERR_R_INTERNAL_ERROR);
    return nullptr;
  }

  uint8_t derived[EC_KEY_DERIVE_EXTRA_BYTES + EC_MAX_BYTES];
  size_t derived_len =
      BN_num_bytes(EC_GROUP_get0_order(group)) + EC_KEY_DERIVE_EXTRA_BYTES;
  assert(derived_len <= sizeof(derived));
  if (!HKDF(derived, derived_len, EVP_sha256(), secret, secret_len,
            /*salt=*/nullptr, /*salt_len=*/0, (const uint8_t *)info,
            strlen(info))) {
    return nullptr;
  }

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  bssl::UniquePtr<BIGNUM> priv(BN_bin2bn(derived, derived_len, nullptr));
  bssl::UniquePtr<EC_POINT> pub(EC_POINT_new(group));
  if (key == nullptr || ctx == nullptr || priv == nullptr || pub == nullptr ||
      // Reduce |priv| with Montgomery reduction. First, convert "from"
      // Montgomery form to compute |priv| * R^-1 mod |order|. This requires
      // |priv| be under order * R, which is true if the group order is large
      // enough. 2^(num_bytes(order)) < 2^8 * order, so:
      //
      //    priv < 2^8 * order * 2^128 < order * order < order * R
      !BN_from_montgomery(priv.get(), priv.get(), &group->order, ctx.get()) ||
      // Multiply by R^2 and do another Montgomery reduction to compute
      // priv * R^-1 * R^2 * R^-1 = priv mod order.
      !BN_to_montgomery(priv.get(), priv.get(), &group->order, ctx.get()) ||
      !EC_POINT_mul(group, pub.get(), priv.get(), nullptr, nullptr,
                    ctx.get()) ||
      !EC_KEY_set_group(key.get(), group) ||
      !EC_KEY_set_public_key(key.get(), pub.get()) ||
      !EC_KEY_set_private_key(key.get(), priv.get())) {
    OPENSSL_cleanse(derived, sizeof(derived));
    return nullptr;
  }

  OPENSSL_cleanse(derived, sizeof(derived));
  return key.release();
}
