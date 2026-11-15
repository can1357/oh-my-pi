// Copyright 2014 The BoringSSL Authors
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

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include <gtest/gtest.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>
#include <openssl/obj.h>
#include <openssl/span.h>

#include "../../ec/internal.h"
#include "../../test/file_test.h"
#include "../../test/test_util.h"
#include "../bn/internal.h"
#include "internal.h"


namespace {

// kECKeyWithoutPublic is an ECPrivateKey with the optional publicKey field
// omitted.
static const uint8_t kECKeyWithoutPublic[] = {
    0x30, 0x31, 0x02, 0x01, 0x01, 0x04, 0x20, 0xc6, 0xc1, 0xaa, 0xda,
    0x15, 0xb0, 0x76, 0x61, 0xf8, 0x14, 0x2c, 0x6c, 0xaf, 0x0f, 0xdb,
    0x24, 0x1a, 0xff, 0x2e, 0xfe, 0x46, 0xc0, 0x93, 0x8b, 0x74, 0xf2,
    0xbc, 0xc5, 0x30, 0x52, 0xb0, 0x77, 0xa0, 0x0a, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
};

// kECKeySpecifiedCurve is the above key with P-256's parameters explicitly
// spelled out rather than using a named curve.
static const uint8_t kECKeySpecifiedCurve[] = {
    0x30, 0x82, 0x01, 0x22, 0x02, 0x01, 0x01, 0x04, 0x20, 0xc6, 0xc1, 0xaa,
    0xda, 0x15, 0xb0, 0x76, 0x61, 0xf8, 0x14, 0x2c, 0x6c, 0xaf, 0x0f, 0xdb,
    0x24, 0x1a, 0xff, 0x2e, 0xfe, 0x46, 0xc0, 0x93, 0x8b, 0x74, 0xf2, 0xbc,
    0xc5, 0x30, 0x52, 0xb0, 0x77, 0xa0, 0x81, 0xfa, 0x30, 0x81, 0xf7, 0x02,
    0x01, 0x01, 0x30, 0x2c, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x01,
    0x01, 0x02, 0x21, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x30, 0x5b, 0x04, 0x20, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfc,
    0x04, 0x20, 0x5a, 0xc6, 0x35, 0xd8, 0xaa, 0x3a, 0x93, 0xe7, 0xb3, 0xeb,
    0xbd, 0x55, 0x76, 0x98, 0x86, 0xbc, 0x65, 0x1d, 0x06, 0xb0, 0xcc, 0x53,
    0xb0, 0xf6, 0x3b, 0xce, 0x3c, 0x3e, 0x27, 0xd2, 0x60, 0x4b, 0x03, 0x15,
    0x00, 0xc4, 0x9d, 0x36, 0x08, 0x86, 0xe7, 0x04, 0x93, 0x6a, 0x66, 0x78,
    0xe1, 0x13, 0x9d, 0x26, 0xb7, 0x81, 0x9f, 0x7e, 0x90, 0x04, 0x41, 0x04,
    0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5,
    0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0,
    0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96, 0x4f, 0xe3, 0x42, 0xe2,
    0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16,
    0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68,
    0x37, 0xbf, 0x51, 0xf5, 0x02, 0x21, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xbc,
    0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc,
    0x63, 0x25, 0x51, 0x02, 0x01, 0x01,
};

// kECKeyMissingZeros is an ECPrivateKey containing a degenerate P-256 key where
// the private key is one. The private key is incorrectly encoded without zero
// padding.
static const uint8_t kECKeyMissingZeros[] = {
    0x30, 0x58, 0x02, 0x01, 0x01, 0x04, 0x01, 0x01, 0xa0, 0x0a, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0xa1, 0x44, 0x03, 0x42,
    0x00, 0x04, 0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc,
    0xe6, 0xe5, 0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb,
    0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96, 0x4f, 0xe3,
    0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a, 0x7c, 0x0f,
    0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce, 0xcb, 0xb6,
    0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
};

// kECKeyMissingZeros is an ECPrivateKey containing a degenerate P-256 key where
// the private key is one. The private key is encoded with the required zero
// padding.
static const uint8_t kECKeyWithZeros[] = {
    0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xa0, 0x0a, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0xa1, 0x44, 0x03, 0x42,
    0x00, 0x04, 0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8,
    0xbc, 0xe6, 0xe5, 0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81,
    0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2,
    0x96, 0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7,
    0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b,
    0x31, 0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
};

static const uint8_t kECKeyWithZerosPublic[] = {
    0x04, 0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc,
    0xe6, 0xe5, 0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d,
    0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96,
    0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb,
    0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31,
    0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
};

static const uint8_t kECKeyWithZerosRawPrivate[] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};

// DecodeECPrivateKey decodes |in| as an ECPrivateKey structure and returns the
// result or nullptr on error.
static bssl::UniquePtr<EC_KEY> DecodeECPrivateKey(const uint8_t *in,
                                                  size_t in_len) {
  CBS cbs;
  CBS_init(&cbs, in, in_len);
  bssl::UniquePtr<EC_KEY> ret(EC_KEY_parse_private_key(&cbs, nullptr));
  if (!ret || CBS_len(&cbs) != 0) {
    return nullptr;
  }
  return ret;
}

// EncodeECPrivateKey encodes |key| as an ECPrivateKey structure into |*out|. It
// returns true on success or false on error.
static bool EncodeECPrivateKey(std::vector<uint8_t> *out, const EC_KEY *key) {
  bssl::ScopedCBB cbb;
  uint8_t *der;
  size_t der_len;
  if (!CBB_init(cbb.get(), 0) ||
      !EC_KEY_marshal_private_key(cbb.get(), key, EC_KEY_get_enc_flags(key)) ||
      !CBB_finish(cbb.get(), &der, &der_len)) {
    return false;
  }
  out->assign(der, der + der_len);
  OPENSSL_free(der);
  return true;
}

static bool EncodeECPoint(std::vector<uint8_t> *out, const EC_GROUP *group,
                          const EC_POINT *p, point_conversion_form_t form) {
  size_t len = EC_POINT_point2oct(group, p, form, nullptr, 0, nullptr);
  if (len == 0) {
    return false;
  }

  out->resize(len);
  len = EC_POINT_point2oct(group, p, form, out->data(), out->size(), nullptr);
  if (len != out->size()) {
    return false;
  }

  return true;
}

TEST(ECTest, Encoding) {
  bssl::UniquePtr<EC_KEY> key =
      DecodeECPrivateKey(kECKeyWithoutPublic, sizeof(kECKeyWithoutPublic));
  ASSERT_TRUE(key);

  // Test that the encoding round-trips.
  std::vector<uint8_t> out;
  ASSERT_TRUE(EncodeECPrivateKey(&out, key.get()));
  EXPECT_EQ(Bytes(kECKeyWithoutPublic), Bytes(out.data(), out.size()));

  const EC_POINT *pub_key = EC_KEY_get0_public_key(key.get());
  ASSERT_TRUE(pub_key) << "Public key missing";

  bssl::UniquePtr<BIGNUM> x(BN_new());
  bssl::UniquePtr<BIGNUM> y(BN_new());
  ASSERT_TRUE(x);
  ASSERT_TRUE(y);
  ASSERT_TRUE(EC_POINT_get_affine_coordinates_GFp(
      EC_KEY_get0_group(key.get()), pub_key, x.get(), y.get(), nullptr));
  bssl::UniquePtr<char> x_hex(BN_bn2hex(x.get()));
  bssl::UniquePtr<char> y_hex(BN_bn2hex(y.get()));
  ASSERT_TRUE(x_hex);
  ASSERT_TRUE(y_hex);

  EXPECT_STREQ(
      "c81561ecf2e54edefe6617db1c7a34a70744ddb261f269b83dacfcd2ade5a681",
      x_hex.get());
  EXPECT_STREQ(
      "e0e2afa3f9b6abe4c698ef6495f1be49a3196c5056acb3763fe4507eec596e88",
      y_hex.get());
}

TEST(ECTest, ZeroPadding) {
  // Check that the correct encoding round-trips.
  bssl::UniquePtr<EC_KEY> key =
      DecodeECPrivateKey(kECKeyWithZeros, sizeof(kECKeyWithZeros));
  ASSERT_TRUE(key);
  std::vector<uint8_t> out;
  EXPECT_TRUE(EncodeECPrivateKey(&out, key.get()));
  EXPECT_EQ(Bytes(kECKeyWithZeros), Bytes(out.data(), out.size()));

  // Check the private key encodes correctly, including with the leading zeros.
  EXPECT_EQ(32u, EC_KEY_priv2oct(key.get(), nullptr, 0));
  uint8_t buf[32];
  ASSERT_EQ(32u, EC_KEY_priv2oct(key.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes(buf), Bytes(kECKeyWithZerosRawPrivate));

  // Buffer too small.
  EXPECT_EQ(0u, EC_KEY_priv2oct(key.get(), buf, sizeof(buf) - 1));

  // Extra space in buffer.
  uint8_t large_buf[33];
  ASSERT_EQ(32u, EC_KEY_priv2oct(key.get(), large_buf, sizeof(large_buf)));
  EXPECT_EQ(Bytes(buf), Bytes(kECKeyWithZerosRawPrivate));

  // Allocating API.
  uint8_t *buf_alloc;
  size_t len = EC_KEY_priv2buf(key.get(), &buf_alloc);
  ASSERT_GT(len, 0u);
  bssl::UniquePtr<uint8_t> free_buf_alloc(buf_alloc);
  EXPECT_EQ(Bytes(buf_alloc, len), Bytes(kECKeyWithZerosRawPrivate));

  // Keys without leading zeros also parse, but they encode correctly.
  key = DecodeECPrivateKey(kECKeyMissingZeros, sizeof(kECKeyMissingZeros));
  ASSERT_TRUE(key);
  EXPECT_TRUE(EncodeECPrivateKey(&out, key.get()));
  EXPECT_EQ(Bytes(kECKeyWithZeros), Bytes(out.data(), out.size()));

  // Test the key can be constructed with |EC_KEY_oct2*|.
  key.reset(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_oct2key(key.get(), kECKeyWithZerosPublic,
                             sizeof(kECKeyWithZerosPublic), nullptr));
  ASSERT_TRUE(EC_KEY_oct2priv(key.get(), kECKeyWithZerosRawPrivate,
                              sizeof(kECKeyWithZerosRawPrivate)));
  EXPECT_TRUE(EncodeECPrivateKey(&out, key.get()));
  EXPECT_EQ(Bytes(kECKeyWithZeros), Bytes(out.data(), out.size()));

  // |EC_KEY_oct2priv|'s format is fixed-width and must match the group order.
  key.reset(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  ASSERT_TRUE(key);
  EXPECT_FALSE(EC_KEY_oct2priv(key.get(), kECKeyWithZerosRawPrivate + 1,
                               sizeof(kECKeyWithZerosRawPrivate) - 1));
  uint8_t padded[sizeof(kECKeyWithZerosRawPrivate) + 1] = {0};
  memcpy(padded + 1, kECKeyWithZerosRawPrivate,
         sizeof(kECKeyWithZerosRawPrivate));
  EXPECT_FALSE(EC_KEY_oct2priv(key.get(), padded, sizeof(padded)));
}

TEST(ECTest, SpecifiedCurve) {
  // Test keys with specified curves may be decoded.
  bssl::UniquePtr<EC_KEY> key =
      DecodeECPrivateKey(kECKeySpecifiedCurve, sizeof(kECKeySpecifiedCurve));
  ASSERT_TRUE(key);

  // The group should have been interpreted as P-256.
  EXPECT_EQ(NID_X9_62_prime256v1,
            EC_GROUP_get_curve_name(EC_KEY_get0_group(key.get())));

  // Encoding the key should still use named form.
  std::vector<uint8_t> out;
  EXPECT_TRUE(EncodeECPrivateKey(&out, key.get()));
  EXPECT_EQ(Bytes(kECKeyWithoutPublic), Bytes(out.data(), out.size()));
}

TEST(ECTest, ArbitraryCurve) {
  // Make a P-256 key and extract the affine coordinates.
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  // Make an arbitrary curve which is identical to P-256.
  static const uint8_t kP[] = {
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  };
  static const uint8_t kA[] = {
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfc,
  };
  static const uint8_t kB[] = {
      0x5a, 0xc6, 0x35, 0xd8, 0xaa, 0x3a, 0x93, 0xe7, 0xb3, 0xeb, 0xbd,
      0x55, 0x76, 0x98, 0x86, 0xbc, 0x65, 0x1d, 0x06, 0xb0, 0xcc, 0x53,
      0xb0, 0xf6, 0x3b, 0xce, 0x3c, 0x3e, 0x27, 0xd2, 0x60, 0x4b,
  };
  static const uint8_t kX[] = {
      0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6,
      0xe5, 0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb,
      0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96,
  };
  static const uint8_t kY[] = {
      0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb,
      0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31,
      0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
  };
  static const uint8_t kOrder[] = {
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17,
      0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
  };
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<BIGNUM> p(BN_bin2bn(kP, sizeof(kP), nullptr));
  ASSERT_TRUE(p);
  bssl::UniquePtr<BIGNUM> a(BN_bin2bn(kA, sizeof(kA), nullptr));
  ASSERT_TRUE(a);
  bssl::UniquePtr<BIGNUM> b(BN_bin2bn(kB, sizeof(kB), nullptr));
  ASSERT_TRUE(b);
  bssl::UniquePtr<BIGNUM> gx(BN_bin2bn(kX, sizeof(kX), nullptr));
  ASSERT_TRUE(gx);
  bssl::UniquePtr<BIGNUM> gy(BN_bin2bn(kY, sizeof(kY), nullptr));
  ASSERT_TRUE(gy);
  bssl::UniquePtr<BIGNUM> order(BN_bin2bn(kOrder, sizeof(kOrder), nullptr));
  ASSERT_TRUE(order);

  bssl::UniquePtr<EC_GROUP> group(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), ctx.get()));
  ASSERT_TRUE(group);
  bssl::UniquePtr<EC_POINT> generator(EC_POINT_new(group.get()));
  ASSERT_TRUE(generator);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(
      group.get(), generator.get(), gx.get(), gy.get(), ctx.get()));
  ASSERT_TRUE(EC_GROUP_set_generator(group.get(), generator.get(), order.get(),
                                     BN_value_one()));

  // |group| should not have a curve name.
  EXPECT_EQ(NID_undef, EC_GROUP_get_curve_name(group.get()));

  // Copy |key| to |key2| using |group|.
  bssl::UniquePtr<EC_KEY> key2(EC_KEY_new());
  ASSERT_TRUE(key2);
  bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group.get()));
  ASSERT_TRUE(point);
  bssl::UniquePtr<BIGNUM> x(BN_new()), y(BN_new());
  ASSERT_TRUE(x);
  ASSERT_TRUE(EC_KEY_set_group(key2.get(), group.get()));
  ASSERT_TRUE(
      EC_KEY_set_private_key(key2.get(), EC_KEY_get0_private_key(key.get())));
  ASSERT_TRUE(EC_POINT_get_affine_coordinates_GFp(
      EC_KEY_get0_group(key.get()), EC_KEY_get0_public_key(key.get()), x.get(),
      y.get(), nullptr));
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(group.get(), point.get(),
                                                  x.get(), y.get(), nullptr));
  ASSERT_TRUE(EC_KEY_set_public_key(key2.get(), point.get()));

  // The key must be valid according to the new group too.
  EXPECT_TRUE(EC_KEY_check_key(key2.get()));

  // Make a second instance of |group|.
  bssl::UniquePtr<EC_GROUP> group2(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), ctx.get()));
  ASSERT_TRUE(group2);
  bssl::UniquePtr<EC_POINT> generator2(EC_POINT_new(group2.get()));
  ASSERT_TRUE(generator2);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(
      group2.get(), generator2.get(), gx.get(), gy.get(), ctx.get()));
  ASSERT_TRUE(EC_GROUP_set_generator(group2.get(), generator2.get(),
                                     order.get(), BN_value_one()));

  EXPECT_EQ(0, EC_GROUP_cmp(group.get(), group.get(), nullptr));
  EXPECT_EQ(0, EC_GROUP_cmp(group2.get(), group.get(), nullptr));

  // group3 uses the wrong generator.
  bssl::UniquePtr<EC_GROUP> group3(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), ctx.get()));
  ASSERT_TRUE(group3);
  bssl::UniquePtr<EC_POINT> generator3(EC_POINT_new(group3.get()));
  ASSERT_TRUE(generator3);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(
      group3.get(), generator3.get(), x.get(), y.get(), ctx.get()));
  ASSERT_TRUE(EC_GROUP_set_generator(group3.get(), generator3.get(),
                                     order.get(), BN_value_one()));

  EXPECT_NE(0, EC_GROUP_cmp(group.get(), group3.get(), nullptr));

#if !defined(BORINGSSL_SHARED_LIBRARY)
  // group4 has non-minimal components that do not fit in |EC_SCALAR| and the
  // future |EC_FELEM|.
  ASSERT_TRUE(bn_resize_words(p.get(), 32));
  ASSERT_TRUE(bn_resize_words(a.get(), 32));
  ASSERT_TRUE(bn_resize_words(b.get(), 32));
  ASSERT_TRUE(bn_resize_words(gx.get(), 32));
  ASSERT_TRUE(bn_resize_words(gy.get(), 32));
  ASSERT_TRUE(bn_resize_words(order.get(), 32));

  bssl::UniquePtr<EC_GROUP> group4(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), ctx.get()));
  ASSERT_TRUE(group4);
  bssl::UniquePtr<EC_POINT> generator4(EC_POINT_new(group4.get()));
  ASSERT_TRUE(generator4);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(
      group4.get(), generator4.get(), gx.get(), gy.get(), ctx.get()));
  ASSERT_TRUE(EC_GROUP_set_generator(group4.get(), generator4.get(),
                                     order.get(), BN_value_one()));

  EXPECT_EQ(0, EC_GROUP_cmp(group.get(), group4.get(), nullptr));
#endif

  // group5 is the same group, but the curve coefficients are passed in
  // unreduced and the caller does not pass in a |BN_CTX|.
  ASSERT_TRUE(BN_sub(a.get(), a.get(), p.get()));
  ASSERT_TRUE(BN_add(b.get(), b.get(), p.get()));
  bssl::UniquePtr<EC_GROUP> group5(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), nullptr));
  ASSERT_TRUE(group5);
  bssl::UniquePtr<EC_POINT> generator5(EC_POINT_new(group5.get()));
  ASSERT_TRUE(generator5);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(
      group5.get(), generator5.get(), gx.get(), gy.get(), ctx.get()));
  ASSERT_TRUE(EC_GROUP_set_generator(group5.get(), generator5.get(),
                                     order.get(), BN_value_one()));

  EXPECT_EQ(0, EC_GROUP_cmp(group.get(), group.get(), nullptr));
  EXPECT_EQ(0, EC_GROUP_cmp(group5.get(), group.get(), nullptr));
}

TEST(ECTest, SetKeyWithoutGroup) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  ASSERT_TRUE(key);

  // Private keys may not be configured without a group.
  EXPECT_FALSE(EC_KEY_set_private_key(key.get(), BN_value_one()));

  // Public keys may not be configured without a group.
  EXPECT_FALSE(EC_KEY_set_public_key(key.get(),
                                     EC_GROUP_get0_generator(EC_group_p256())));
}

TEST(ECTest, SetNULLKey) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  ASSERT_TRUE(key);

  EXPECT_TRUE(EC_KEY_set_public_key(
      key.get(), EC_GROUP_get0_generator(EC_KEY_get0_group(key.get()))));
  EXPECT_TRUE(EC_KEY_get0_public_key(key.get()));

  // Setting a NULL public-key should clear the public-key and return zero, in
  // order to match OpenSSL behaviour exactly.
  EXPECT_FALSE(EC_KEY_set_public_key(key.get(), nullptr));
  EXPECT_FALSE(EC_KEY_get0_public_key(key.get()));
}

TEST(ECTest, PointAtInfinity) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  ASSERT_TRUE(key);

  bssl::UniquePtr<EC_POINT> inf(EC_POINT_new(key->group));
  ASSERT_TRUE(inf);
  ASSERT_TRUE(EC_POINT_set_to_infinity(key->group, inf.get()));
  // Configuring a public key with the point at infinity is invalid.
  EXPECT_FALSE(EC_KEY_set_public_key(key.get(), inf.get()));
}

TEST(ECTest, GroupMismatch) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(NID_secp384r1));
  ASSERT_TRUE(key);

  // Changing a key's group is invalid.
  EXPECT_FALSE(EC_KEY_set_group(key.get(), EC_group_p256()));

  // Configuring a public key with the wrong group is invalid.
  EXPECT_FALSE(EC_KEY_set_public_key(key.get(),
                                     EC_GROUP_get0_generator(EC_group_p256())));
}

TEST(ECTest, EmptyKey) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  ASSERT_TRUE(key);
  EXPECT_FALSE(EC_KEY_get0_group(key.get()));
  EXPECT_FALSE(EC_KEY_get0_public_key(key.get()));
  EXPECT_FALSE(EC_KEY_get0_private_key(key.get()));
}

// Test that point arithmetic works with custom curves using an arbitrary |a|,
// rather than -3, as is common (and more efficient).
TEST(ECTest, BrainpoolP256r1) {
  static const char kP[] =
      "a9fb57dba1eea9bc3e660a909d838d726e3bf623d52620282013481d1f6e5377";
  static const char kA[] =
      "7d5a0975fc2c3057eef67530417affe7fb8055c126dc5c6ce94a4b44f330b5d9";
  static const char kB[] =
      "26dc5c6ce94a4b44f330b5d9bbd77cbf958416295cf7e1ce6bccdc18ff8c07b6";
  static const char kX[] =
      "8bd2aeb9cb7e57cb2c4b482ffc81b7afb9de27e1e3bd23c23a4453bd9ace3262";
  static const char kY[] =
      "547ef835c3dac4fd97f8461a14611dc9c27745132ded8e545c1d54c72f046997";
  static const char kN[] =
      "a9fb57dba1eea9bc3e660a909d838d718c397aa3b561a6f7901e0e82974856a7";
  static const char kD[] =
      "0da21d76fed40dd82ac3314cce91abb585b5c4246e902b238a839609ea1e7ce1";
  static const char kQX[] =
      "3a55e0341cab50452fe27b8a87e4775dec7a9daca94b0d84ad1e9f85b53ea513";
  static const char kQY[] =
      "40088146b33bbbe81b092b41146774b35dd478cf056437cfb35ef0df2d269339";

  bssl::UniquePtr<BIGNUM> p = HexToBIGNUM(kP), a = HexToBIGNUM(kA),
                          b = HexToBIGNUM(kB), x = HexToBIGNUM(kX),
                          y = HexToBIGNUM(kY), n = HexToBIGNUM(kN),
                          d = HexToBIGNUM(kD), qx = HexToBIGNUM(kQX),
                          qy = HexToBIGNUM(kQY);
  ASSERT_TRUE(p && a && b && x && y && n && d && qx && qy);

  bssl::UniquePtr<EC_GROUP> group(
      EC_GROUP_new_curve_GFp(p.get(), a.get(), b.get(), nullptr));
  ASSERT_TRUE(group);
  bssl::UniquePtr<EC_POINT> g(EC_POINT_new(group.get()));
  ASSERT_TRUE(g);
  ASSERT_TRUE(EC_POINT_set_affine_coordinates_GFp(group.get(), g.get(), x.get(),
                                                  y.get(), nullptr));
  ASSERT_TRUE(
      EC_GROUP_set_generator(group.get(), g.get(), n.get(), BN_value_one()));

  bssl::UniquePtr<EC_POINT> q(EC_POINT_new(group.get()));
  ASSERT_TRUE(q);
  ASSERT_TRUE(
      EC_POINT_mul(group.get(), q.get(), d.get(), nullptr, nullptr, nullptr));
  ASSERT_TRUE(EC_POINT_get_affine_coordinates_GFp(group.get(), q.get(), x.get(),
                                                  y.get(), nullptr));
  EXPECT_EQ(0, BN_cmp(x.get(), qx.get()));
  EXPECT_EQ(0, BN_cmp(y.get(), qy.get()));
}

class ECCurveTest : public testing::TestWithParam<int> {
 public:
  const EC_GROUP *group() const { return group_; }

  void SetUp() override {
    group_ = EC_GROUP_new_by_curve_name(GetParam());
    ASSERT_TRUE(group_);
  }

 private:
  const EC_GROUP *group_;
};

TEST_P(ECCurveTest, SetAffine) {
  // Generate an EC_KEY.
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  // Get the public key's coordinates.
  bssl::UniquePtr<BIGNUM> x(BN_new());
  ASSERT_TRUE(x);
  bssl::UniquePtr<BIGNUM> y(BN_new());
  ASSERT_TRUE(y);
  bssl::UniquePtr<BIGNUM> p(BN_new());
  ASSERT_TRUE(p);
  EXPECT_TRUE(EC_POINT_get_affine_coordinates_GFp(
      group(), EC_KEY_get0_public_key(key.get()), x.get(), y.get(), nullptr));
  EXPECT_TRUE(
      EC_GROUP_get_curve_GFp(group(), p.get(), nullptr, nullptr, nullptr));

  // Points on the curve should be accepted.
  auto point = bssl::UniquePtr<EC_POINT>(EC_POINT_new(group()));
  ASSERT_TRUE(point);
  EXPECT_TRUE(EC_POINT_set_affine_coordinates_GFp(group(), point.get(), x.get(),
                                                  y.get(), nullptr));

  // Subtract one from |y| to make the point no longer on the curve.
  EXPECT_TRUE(BN_sub(y.get(), y.get(), BN_value_one()));

  // Points not on the curve should be rejected.
  bssl::UniquePtr<EC_POINT> invalid_point(EC_POINT_new(group()));
  ASSERT_TRUE(invalid_point);
  EXPECT_FALSE(EC_POINT_set_affine_coordinates_GFp(group(), invalid_point.get(),
                                                   x.get(), y.get(), nullptr));

  // Coordinates out of range should be rejected.
  EXPECT_TRUE(BN_add(y.get(), y.get(), BN_value_one()));
  EXPECT_TRUE(BN_add(y.get(), y.get(), p.get()));

  EXPECT_FALSE(EC_POINT_set_affine_coordinates_GFp(group(), invalid_point.get(),
                                                   x.get(), y.get(), nullptr));
  EXPECT_FALSE(
      EC_KEY_set_public_key_affine_coordinates(key.get(), x.get(), y.get()));
}

TEST_P(ECCurveTest, IsOnCurve) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  // The generated point is on the curve.
  EXPECT_TRUE(EC_POINT_is_on_curve(group(), EC_KEY_get0_public_key(key.get()),
                                   nullptr));

  bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group()));
  ASSERT_TRUE(p);
  ASSERT_TRUE(EC_POINT_copy(p.get(), EC_KEY_get0_public_key(key.get())));

  // This should never happen outside of a bug, but |EC_POINT_is_on_curve|
  // rejects points not on the curve.
  OPENSSL_memset(&p->raw.X, 0, sizeof(p->raw.X));
  EXPECT_FALSE(EC_POINT_is_on_curve(group(), p.get(), nullptr));

  // The point at infinity is always on the curve.
  ASSERT_TRUE(EC_POINT_copy(p.get(), EC_KEY_get0_public_key(key.get())));
  OPENSSL_memset(&p->raw.Z, 0, sizeof(p->raw.Z));
  EXPECT_TRUE(EC_POINT_is_on_curve(group(), p.get(), nullptr));
}

TEST_P(ECCurveTest, Compare) {
  bssl::UniquePtr<EC_KEY> key1(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key1);
  ASSERT_TRUE(EC_KEY_generate_key(key1.get()));
  const EC_POINT *pub1 = EC_KEY_get0_public_key(key1.get());

  bssl::UniquePtr<EC_KEY> key2(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key2);
  ASSERT_TRUE(EC_KEY_generate_key(key2.get()));
  const EC_POINT *pub2 = EC_KEY_get0_public_key(key2.get());

  // Two different points should not compare as equal.
  EXPECT_EQ(1, EC_POINT_cmp(group(), pub1, pub2, nullptr));

  // Serialize |pub1| and parse it back out. This gives a point in affine
  // coordinates.
  std::vector<uint8_t> serialized;
  ASSERT_TRUE(
      EncodeECPoint(&serialized, group(), pub1, POINT_CONVERSION_UNCOMPRESSED));
  bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group()));
  ASSERT_TRUE(p);
  ASSERT_TRUE(EC_POINT_oct2point(group(), p.get(), serialized.data(),
                                 serialized.size(), nullptr));

  // The points should be equal.
  EXPECT_EQ(0, EC_POINT_cmp(group(), p.get(), pub1, nullptr));

  // Add something to the point. It no longer compares as equal.
  ASSERT_TRUE(EC_POINT_add(group(), p.get(), p.get(), pub2, nullptr));
  EXPECT_EQ(1, EC_POINT_cmp(group(), p.get(), pub1, nullptr));

  // Negate |pub2|. It should no longer compare as equal. This tests that we
  // check both x and y coordinate.
  bssl::UniquePtr<EC_POINT> q(EC_POINT_new(group()));
  ASSERT_TRUE(q);
  ASSERT_TRUE(EC_POINT_copy(q.get(), pub2));
  ASSERT_TRUE(EC_POINT_invert(group(), q.get(), nullptr));
  EXPECT_EQ(1, EC_POINT_cmp(group(), q.get(), pub2, nullptr));

  // Return |p| to the original value. It should be equal to |pub1| again.
  ASSERT_TRUE(EC_POINT_add(group(), p.get(), p.get(), q.get(), nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), p.get(), pub1, nullptr));

  // Infinity compares as equal to itself, but not other points.
  bssl::UniquePtr<EC_POINT> inf1(EC_POINT_new(group())),
      inf2(EC_POINT_new(group()));
  ASSERT_TRUE(inf1);
  ASSERT_TRUE(inf2);
  ASSERT_TRUE(EC_POINT_set_to_infinity(group(), inf1.get()));
  // |q| is currently -|pub2|.
  ASSERT_TRUE(EC_POINT_add(group(), inf2.get(), pub2, q.get(), nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), inf1.get(), inf2.get(), nullptr));
  EXPECT_EQ(1, EC_POINT_cmp(group(), inf1.get(), p.get(), nullptr));
}

TEST_P(ECCurveTest, GenerateFIPS) {
  // Generate an EC_KEY.
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_generate_key_fips(key.get()));
}

TEST_P(ECCurveTest, AddingEqualPoints) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  bssl::UniquePtr<EC_POINT> p1(EC_POINT_new(group()));
  ASSERT_TRUE(p1);
  ASSERT_TRUE(EC_POINT_copy(p1.get(), EC_KEY_get0_public_key(key.get())));

  bssl::UniquePtr<EC_POINT> p2(EC_POINT_new(group()));
  ASSERT_TRUE(p2);
  ASSERT_TRUE(EC_POINT_copy(p2.get(), EC_KEY_get0_public_key(key.get())));

  bssl::UniquePtr<EC_POINT> double_p1(EC_POINT_new(group()));
  ASSERT_TRUE(double_p1);
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  ASSERT_TRUE(ctx);
  ASSERT_TRUE(EC_POINT_dbl(group(), double_p1.get(), p1.get(), ctx.get()));

  bssl::UniquePtr<EC_POINT> p1_plus_p2(EC_POINT_new(group()));
  ASSERT_TRUE(p1_plus_p2);
  ASSERT_TRUE(
      EC_POINT_add(group(), p1_plus_p2.get(), p1.get(), p2.get(), ctx.get()));

  EXPECT_EQ(0,
            EC_POINT_cmp(group(), double_p1.get(), p1_plus_p2.get(), ctx.get()))
      << "A+A != 2A";
}

TEST_P(ECCurveTest, MulZero) {
  bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group()));
  ASSERT_TRUE(point);
  bssl::UniquePtr<BIGNUM> zero(BN_new());
  ASSERT_TRUE(zero);
  BN_zero(zero.get());
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), zero.get(), nullptr, nullptr,
                           nullptr));

  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), point.get()))
      << "g * 0 did not return point at infinity.";

  // Test that zero times an arbitrary point is also infinity. The generator is
  // used as the arbitrary point.
  bssl::UniquePtr<EC_POINT> generator(EC_POINT_new(group()));
  ASSERT_TRUE(generator);
  ASSERT_TRUE(EC_POINT_mul(group(), generator.get(), BN_value_one(), nullptr,
                           nullptr, nullptr));
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), nullptr, generator.get(),
                           zero.get(), nullptr));

  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), point.get()))
      << "p * 0 did not return point at infinity.";
}

// Test that multiplying by the order produces ∞ and, moreover, that callers may
// do so. |EC_POINT_mul| is almost exclusively used with reduced scalars, with
// this exception. This comes from consumers following NIST SP 800-56A section
// 5.6.2.3.2. (Though all our curves have cofactor one, so this check isn't
// useful.)
TEST_P(ECCurveTest, MulOrder) {
  // Test that g × order = ∞.
  bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group()));
  ASSERT_TRUE(point);
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), EC_GROUP_get0_order(group()),
                           nullptr, nullptr, nullptr));

  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), point.get()))
      << "g * order did not return point at infinity.";

  // Test that p × order = ∞, for some arbitrary p.
  bssl::UniquePtr<BIGNUM> forty_two(BN_new());
  ASSERT_TRUE(forty_two);
  ASSERT_TRUE(BN_set_word(forty_two.get(), 42));
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), forty_two.get(), nullptr,
                           nullptr, nullptr));
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), nullptr, point.get(),
                           EC_GROUP_get0_order(group()), nullptr));

  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), point.get()))
      << "p * order did not return point at infinity.";
}

// Test that |EC_POINT_mul| works with out-of-range scalars. The operation will
// not be constant-time, but we'll compute the right answer.
TEST_P(ECCurveTest, MulOutOfRange) {
  bssl::UniquePtr<BIGNUM> n_minus_one(BN_dup(EC_GROUP_get0_order(group())));
  ASSERT_TRUE(n_minus_one);
  ASSERT_TRUE(BN_sub_word(n_minus_one.get(), 1));

  bssl::UniquePtr<BIGNUM> minus_one(BN_new());
  ASSERT_TRUE(minus_one);
  ASSERT_TRUE(BN_one(minus_one.get()));
  BN_set_negative(minus_one.get(), 1);

  bssl::UniquePtr<BIGNUM> seven(BN_new());
  ASSERT_TRUE(seven);
  ASSERT_TRUE(BN_set_word(seven.get(), 7));

  bssl::UniquePtr<BIGNUM> ten_n_plus_seven(
      BN_dup(EC_GROUP_get0_order(group())));
  ASSERT_TRUE(ten_n_plus_seven);
  ASSERT_TRUE(BN_mul_word(ten_n_plus_seven.get(), 10));
  ASSERT_TRUE(BN_add_word(ten_n_plus_seven.get(), 7));

  bssl::UniquePtr<EC_POINT> point1(EC_POINT_new(group())),
      point2(EC_POINT_new(group()));
  ASSERT_TRUE(point1);
  ASSERT_TRUE(point2);

  ASSERT_TRUE(EC_POINT_mul(group(), point1.get(), n_minus_one.get(), nullptr,
                           nullptr, nullptr));
  ASSERT_TRUE(EC_POINT_mul(group(), point2.get(), minus_one.get(), nullptr,
                           nullptr, nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), point1.get(), point2.get(), nullptr))
      << "-1 * G and (n-1) * G did not give the same result";

  ASSERT_TRUE(EC_POINT_mul(group(), point1.get(), seven.get(), nullptr, nullptr,
                           nullptr));
  ASSERT_TRUE(EC_POINT_mul(group(), point2.get(), ten_n_plus_seven.get(),
                           nullptr, nullptr, nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), point1.get(), point2.get(), nullptr))
      << "7 * G and (10n + 7) * G did not give the same result";
}

// Test that 10×∞ + G = G.
TEST_P(ECCurveTest, Mul) {
  bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group()));
  ASSERT_TRUE(p);
  bssl::UniquePtr<EC_POINT> result(EC_POINT_new(group()));
  ASSERT_TRUE(result);
  bssl::UniquePtr<BIGNUM> n(BN_new());
  ASSERT_TRUE(n);
  ASSERT_TRUE(EC_POINT_set_to_infinity(group(), p.get()));
  ASSERT_TRUE(BN_set_word(n.get(), 10));

  // First check that 10×∞ = ∞.
  ASSERT_TRUE(
      EC_POINT_mul(group(), result.get(), nullptr, p.get(), n.get(), nullptr));
  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), result.get()));

  // Now check that 10×∞ + G = G.
  const EC_POINT *generator = EC_GROUP_get0_generator(group());
  ASSERT_TRUE(EC_POINT_mul(group(), result.get(), BN_value_one(), p.get(),
                           n.get(), nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), result.get(), generator, nullptr));
}

TEST_P(ECCurveTest, MulNonMinimal) {
  bssl::UniquePtr<BIGNUM> forty_two(BN_new());
  ASSERT_TRUE(forty_two);
  ASSERT_TRUE(BN_set_word(forty_two.get(), 42));

  // Compute g × 42.
  bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group()));
  ASSERT_TRUE(point);
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), forty_two.get(), nullptr,
                           nullptr, nullptr));

  // Compute it again with a non-minimal 42, much larger than the scalar.
  ASSERT_TRUE(bn_resize_words(forty_two.get(), 64));

  bssl::UniquePtr<EC_POINT> point2(EC_POINT_new(group()));
  ASSERT_TRUE(point2);
  ASSERT_TRUE(EC_POINT_mul(group(), point2.get(), forty_two.get(), nullptr,
                           nullptr, nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), point.get(), point2.get(), nullptr));
}

// Test that EC_KEY_set_private_key rejects invalid values.
TEST_P(ECCurveTest, SetInvalidPrivateKey) {
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(GetParam()));
  ASSERT_TRUE(key);

  bssl::UniquePtr<BIGNUM> bn(BN_dup(BN_value_one()));
  ASSERT_TRUE(bn);
  BN_set_negative(bn.get(), 1);
  EXPECT_FALSE(EC_KEY_set_private_key(key.get(), bn.get()))
      << "Unexpectedly set a key of -1";
  ERR_clear_error();

  ASSERT_TRUE(
      BN_copy(bn.get(), EC_GROUP_get0_order(EC_KEY_get0_group(key.get()))));
  EXPECT_FALSE(EC_KEY_set_private_key(key.get(), bn.get()))
      << "Unexpectedly set a key of the group order.";
  ERR_clear_error();

  BN_zero(bn.get());
  EXPECT_FALSE(EC_KEY_set_private_key(key.get(), bn.get()))
      << "Unexpectedly set a key of 0";
  ERR_clear_error();
}

TEST_P(ECCurveTest, IgnoreOct2PointReturnValue) {
  bssl::UniquePtr<BIGNUM> forty_two(BN_new());
  ASSERT_TRUE(forty_two);
  ASSERT_TRUE(BN_set_word(forty_two.get(), 42));

  // Compute g × 42.
  bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group()));
  ASSERT_TRUE(point);
  ASSERT_TRUE(EC_POINT_mul(group(), point.get(), forty_two.get(), nullptr,
                           nullptr, nullptr));

  // Serialize the point.
  std::vector<uint8_t> serialized;
  ASSERT_TRUE(EncodeECPoint(&serialized, group(), point.get(),
                            POINT_CONVERSION_UNCOMPRESSED));

  // Create a serialized point that is not on the curve.
  serialized[serialized.size() - 1]++;

  ASSERT_FALSE(EC_POINT_oct2point(group(), point.get(), serialized.data(),
                                  serialized.size(), nullptr));
  // After a failure, |point| should have been set to the generator to defend
  // against code that doesn't check the return value.
  ASSERT_EQ(0, EC_POINT_cmp(group(), point.get(),
                            EC_GROUP_get0_generator(group()), nullptr));
}

TEST_P(ECCurveTest, DoubleSpecialCase) {
  const EC_POINT *g = EC_GROUP_get0_generator(group());

  bssl::UniquePtr<EC_POINT> two_g(EC_POINT_new(group()));
  ASSERT_TRUE(two_g);
  ASSERT_TRUE(EC_POINT_dbl(group(), two_g.get(), g, nullptr));

  bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group()));
  ASSERT_TRUE(p);
  ASSERT_TRUE(EC_POINT_mul(group(), p.get(), BN_value_one(), g, BN_value_one(),
                           nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), p.get(), two_g.get(), nullptr));

  EC_SCALAR one;
  ASSERT_TRUE(ec_bignum_to_scalar(group(), &one, BN_value_one()));
  ASSERT_TRUE(
      ec_point_mul_scalar_public(group(), &p->raw, &one, &g->raw, &one));
  EXPECT_EQ(0, EC_POINT_cmp(group(), p.get(), two_g.get(), nullptr));
}

// This a regression test for a P-224 bug, but we may as well run it for all
// curves.
TEST_P(ECCurveTest, P224Bug) {
  // P = -G
  const EC_POINT *g = EC_GROUP_get0_generator(group());
  bssl::UniquePtr<EC_POINT> p(EC_POINT_dup(g, group()));
  ASSERT_TRUE(p);
  ASSERT_TRUE(EC_POINT_invert(group(), p.get(), nullptr));

  // Compute 31 * P + 32 * G = G
  bssl::UniquePtr<EC_POINT> ret(EC_POINT_new(group()));
  ASSERT_TRUE(ret);
  bssl::UniquePtr<BIGNUM> bn31(BN_new()), bn32(BN_new());
  ASSERT_TRUE(bn31);
  ASSERT_TRUE(bn32);
  ASSERT_TRUE(BN_set_word(bn31.get(), 31));
  ASSERT_TRUE(BN_set_word(bn32.get(), 32));
  ASSERT_TRUE(EC_POINT_mul(group(), ret.get(), bn32.get(), p.get(), bn31.get(),
                           nullptr));
  EXPECT_EQ(0, EC_POINT_cmp(group(), ret.get(), g, nullptr));

  // Repeat the computation with |ec_point_mul_scalar_public|, which ties the
  // additions together.
  EC_SCALAR sc31, sc32;
  ASSERT_TRUE(ec_bignum_to_scalar(group(), &sc31, bn31.get()));
  ASSERT_TRUE(ec_bignum_to_scalar(group(), &sc32, bn32.get()));
  ASSERT_TRUE(
      ec_point_mul_scalar_public(group(), &ret->raw, &sc32, &p->raw, &sc31));
  EXPECT_EQ(0, EC_POINT_cmp(group(), ret.get(), g, nullptr));
}

TEST_P(ECCurveTest, GPlusMinusG) {
  const EC_POINT *g = EC_GROUP_get0_generator(group());

  bssl::UniquePtr<EC_POINT> p(EC_POINT_dup(g, group()));
  ASSERT_TRUE(p);
  ASSERT_TRUE(EC_POINT_invert(group(), p.get(), nullptr));

  bssl::UniquePtr<EC_POINT> sum(EC_POINT_new(group()));
  ASSERT_TRUE(sum);
  ASSERT_TRUE(EC_POINT_add(group(), sum.get(), g, p.get(), nullptr));
  EXPECT_TRUE(EC_POINT_is_at_infinity(group(), sum.get()));
}

// Test that we refuse to encode or decode the point at infinity.
TEST_P(ECCurveTest, EncodeInfinity) {
  // The point at infinity is encoded as a single zero byte, but we do not
  // support it.
  static const uint8_t kInfinity[] = {0};
  bssl::UniquePtr<EC_POINT> inf(EC_POINT_new(group()));
  ASSERT_TRUE(inf);
  EXPECT_FALSE(EC_POINT_oct2point(group(), inf.get(), kInfinity,
                                  sizeof(kInfinity), nullptr));

  // Encoding it also fails.
  ASSERT_TRUE(EC_POINT_set_to_infinity(group(), inf.get()));
  uint8_t buf[128];
  EXPECT_EQ(
      0u, EC_POINT_point2oct(group(), inf.get(), POINT_CONVERSION_UNCOMPRESSED,
                             buf, sizeof(buf), nullptr));

  // Measuring the length of the encoding also fails.
  EXPECT_EQ(
      0u, EC_POINT_point2oct(group(), inf.get(), POINT_CONVERSION_UNCOMPRESSED,
                             nullptr, 0, nullptr));
}

static std::vector<int> AllCurves() {
  const size_t num_curves = EC_get_builtin_curves(nullptr, 0);
  std::vector<EC_builtin_curve> curves(num_curves);
  EC_get_builtin_curves(curves.data(), num_curves);
  std::vector<int> nids;
  for (const auto &curve : curves) {
    nids.push_back(curve.nid);
  }
  return nids;
}

static std::string CurveToString(const testing::TestParamInfo<int> &params) {
  return OBJ_nid2sn(params.param);
}

INSTANTIATE_TEST_SUITE_P(All, ECCurveTest, testing::ValuesIn(AllCurves()),
                         CurveToString);

static const EC_GROUP *GetCurve(FileTest *t, const char *key) {
  std::string curve_name;
  if (!t->GetAttribute(&curve_name, key)) {
    return nullptr;
  }

  if (curve_name == "P-224") {
    return EC_group_p224();
  }
  if (curve_name == "P-256") {
    return EC_group_p256();
  }
  if (curve_name == "P-384") {
    return EC_group_p384();
  }
  if (curve_name == "P-521") {
    return EC_group_p521();
  }

  t->PrintLine("Unknown curve '%s'", curve_name.c_str());
  return nullptr;
}

static bssl::UniquePtr<BIGNUM> GetBIGNUM(FileTest *t, const char *key) {
  std::vector<uint8_t> bytes;
  if (!t->GetBytes(&bytes, key)) {
    return nullptr;
  }

  return bssl::UniquePtr<BIGNUM>(
      BN_bin2bn(bytes.data(), bytes.size(), nullptr));
}

TEST(ECTest, ScalarBaseMultVectors) {
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  ASSERT_TRUE(ctx);

  FileTestGTest(
      "crypto/fipsmodule/ec/ec_scalar_base_mult_tests.txt", [&](FileTest *t) {
        const EC_GROUP *group = GetCurve(t, "Curve");
        ASSERT_TRUE(group);
        bssl::UniquePtr<BIGNUM> n = GetBIGNUM(t, "N");
        ASSERT_TRUE(n);
        bssl::UniquePtr<BIGNUM> x = GetBIGNUM(t, "X");
        ASSERT_TRUE(x);
        bssl::UniquePtr<BIGNUM> y = GetBIGNUM(t, "Y");
        ASSERT_TRUE(y);
        bool is_infinity = BN_is_zero(x.get()) && BN_is_zero(y.get());

        bssl::UniquePtr<BIGNUM> px(BN_new());
        ASSERT_TRUE(px);
        bssl::UniquePtr<BIGNUM> py(BN_new());
        ASSERT_TRUE(py);
        auto check_point = [&](const EC_POINT *p) {
          if (is_infinity) {
            EXPECT_TRUE(EC_POINT_is_at_infinity(group, p));
          } else {
            ASSERT_TRUE(EC_POINT_get_affine_coordinates_GFp(
                group, p, px.get(), py.get(), ctx.get()));
            EXPECT_EQ(0, BN_cmp(x.get(), px.get()));
            EXPECT_EQ(0, BN_cmp(y.get(), py.get()));
          }
        };

        const EC_POINT *g = EC_GROUP_get0_generator(group);
        bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group));
        ASSERT_TRUE(p);
        // Test single-point multiplication.
        ASSERT_TRUE(
            EC_POINT_mul(group, p.get(), n.get(), nullptr, nullptr, ctx.get()));
        check_point(p.get());

        ASSERT_TRUE(
            EC_POINT_mul(group, p.get(), nullptr, g, n.get(), ctx.get()));
        check_point(p.get());
      });
}

// These tests take a very long time, but are worth running when we make
// non-trivial changes to the EC code.
TEST(ECTest, DISABLED_ScalarBaseMultVectorsTwoPoint) {
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  ASSERT_TRUE(ctx);

  FileTestGTest(
      "crypto/fipsmodule/ec/ec_scalar_base_mult_tests.txt", [&](FileTest *t) {
        const EC_GROUP *group = GetCurve(t, "Curve");
        ASSERT_TRUE(group);
        bssl::UniquePtr<BIGNUM> n = GetBIGNUM(t, "N");
        ASSERT_TRUE(n);
        bssl::UniquePtr<BIGNUM> x = GetBIGNUM(t, "X");
        ASSERT_TRUE(x);
        bssl::UniquePtr<BIGNUM> y = GetBIGNUM(t, "Y");
        ASSERT_TRUE(y);
        bool is_infinity = BN_is_zero(x.get()) && BN_is_zero(y.get());

        bssl::UniquePtr<BIGNUM> px(BN_new());
        ASSERT_TRUE(px);
        bssl::UniquePtr<BIGNUM> py(BN_new());
        ASSERT_TRUE(py);
        auto check_point = [&](const EC_POINT *p) {
          if (is_infinity) {
            EXPECT_TRUE(EC_POINT_is_at_infinity(group, p));
          } else {
            ASSERT_TRUE(EC_POINT_get_affine_coordinates_GFp(
                group, p, px.get(), py.get(), ctx.get()));
            EXPECT_EQ(0, BN_cmp(x.get(), px.get()));
            EXPECT_EQ(0, BN_cmp(y.get(), py.get()));
          }
        };

        const EC_POINT *g = EC_GROUP_get0_generator(group);
        bssl::UniquePtr<EC_POINT> p(EC_POINT_new(group));
        ASSERT_TRUE(p);
        bssl::UniquePtr<BIGNUM> a(BN_new()), b(BN_new());
        for (int i = -64; i < 64; i++) {
          SCOPED_TRACE(i);
          ASSERT_TRUE(BN_set_word(a.get(), abs(i)));
          if (i < 0) {
            ASSERT_TRUE(BN_sub(a.get(), EC_GROUP_get0_order(group), a.get()));
          }

          ASSERT_TRUE(BN_copy(b.get(), n.get()));
          ASSERT_TRUE(BN_sub(b.get(), b.get(), a.get()));
          if (BN_is_negative(b.get())) {
            ASSERT_TRUE(BN_add(b.get(), b.get(), EC_GROUP_get0_order(group)));
          }

          ASSERT_TRUE(
              EC_POINT_mul(group, p.get(), a.get(), g, b.get(), ctx.get()));
          check_point(p.get());

          EC_SCALAR a_scalar, b_scalar;
          ASSERT_TRUE(ec_bignum_to_scalar(group, &a_scalar, a.get()));
          ASSERT_TRUE(ec_bignum_to_scalar(group, &b_scalar, b.get()));
          ASSERT_TRUE(ec_point_mul_scalar_public(group, &p->raw, &a_scalar,
                                                 &g->raw, &b_scalar));
          check_point(p.get());
        }
      });
}

static std::vector<uint8_t> HexToBytes(const char *str) {
  std::vector<uint8_t> ret;
  if (!DecodeHex(&ret, str)) {
    abort();
  }
  return ret;
}

TEST(ECTest, DeriveFromSecret) {
  struct DeriveTest {
    const EC_GROUP *group;
    std::vector<uint8_t> secret;
    std::vector<uint8_t> expected_priv;
    std::vector<uint8_t> expected_pub;
  };
  const DeriveTest kDeriveTests[] = {
      {EC_group_p256(), HexToBytes(""),
       HexToBytes(
           "b98a86a71efb51ebdac4759937b977e9b0c05224675bb2b6a58ba306e237f4b8"),
       HexToBytes(
           "04fbe6cab439918e00231a2ff073cdc25823998864a9eb36f809095a1a919ece875"
           "a145803fbe89a6cde53936e3c6d9c253ed3d38f5f58cae455c27e95645ceda9")},
      {EC_group_p256(), HexToBytes("123456"),
       HexToBytes(
           "44a72bc62087b88e5ab7126766177ed0d8f1ed09ad066cd746527fc201105a7e"),
       HexToBytes(
           "04ec0555cd76e991fef7f5504343937d0f38696db3360a4854052cb0d84a377a5a0"
           "ff64c352755c28692b4ae085c2b817db9a1eddbd22e9cf39c12751e0870791b")},
      {EC_group_p256(), HexToBytes("00000000000000000000000000000000"),
       HexToBytes(
           "7ca1e2c83e6a5f2c1b3e7d58180226f269930c4b9fbe2a275096079630b7c57d"),
       HexToBytes(
           "0442ef70c8fc0fbe383ed0a0da36f39f9a590f3feebc07863cc858c9a8ef0465731"
           "0408c249bd4d61929c54b71ffe056e6b4fa1eb537039b43d1c175f0ceab0f89")},
      {EC_group_p256(),
       HexToBytes(
           "de9c9b35543aaa0fba039e34e8ca9695da3225c7161c9e3a8c70356cac28c780"),
       HexToBytes(
           "659f5abf3b62b9931c29d6ed0722efd2349fa56f54e708cf3272f620f1bc44d0"),
       HexToBytes(
           "046741f806b593bf3a3d4a9d76bdcb9b0d7874633cbea8f42c05e78561f7e8ec362"
           "b9b6f1913ded796fbdafe7f210cea897ac22a4e580c06a60f2659fd09f1830f")},
      {EC_group_p384(), HexToBytes("123456"),
       HexToBytes("95cd90d548997de090c7622708eccb7edc1b1bd78d2422235ad97406dada"
                  "076555309da200096f6e4b36c46002beee89"),
       HexToBytes(
           "04007b2d026aa7636fa912c3f970d62bb6c10fa81c8f3290ed90b2d701696d1c6b9"
           "5af88ce13e962996a7ac37e16527cb5d69bd081b8641d07634cf84b438600ec9434"
           "15ac6bd7a0236f7ab0ea31ece67df03fa11646ea2b75e73d1b5e45b75c18")},
  };

  for (const auto &test : kDeriveTests) {
    SCOPED_TRACE(Bytes(test.secret));

    bssl::UniquePtr<EC_KEY> key(EC_KEY_derive_from_secret(
        test.group, test.secret.data(), test.secret.size()));
    ASSERT_TRUE(key);

    std::vector<uint8_t> priv(BN_num_bytes(EC_GROUP_get0_order(test.group)));
    ASSERT_TRUE(BN_bn2bin_padded(priv.data(), priv.size(),
                                 EC_KEY_get0_private_key(key.get())));
    EXPECT_EQ(Bytes(priv), Bytes(test.expected_priv));

    uint8_t *pub = nullptr;
    size_t pub_len =
        EC_KEY_key2buf(key.get(), POINT_CONVERSION_UNCOMPRESSED, &pub, nullptr);
    bssl::UniquePtr<uint8_t> free_pub(pub);
    EXPECT_NE(pub_len, 0u);
    EXPECT_EQ(Bytes(pub, pub_len), Bytes(test.expected_pub));
  }
}

TEST(ECTest, HashToCurve) {
  auto hash_to_curve_p384_sha512_draft07 =
      [](const EC_GROUP *group, EC_POINT *out, const uint8_t *dst,
         size_t dst_len, const uint8_t *msg, size_t msg_len) -> int {
    if (EC_GROUP_cmp(group, out->group, nullptr) != 0) {
      return 0;
    }
    return ec_hash_to_curve_p384_xmd_sha512_sswu_draft07(group, &out->raw, dst,
                                                         dst_len, msg, msg_len);
  };

  struct HashToCurveTest {
    int (*hash_to_curve)(const EC_GROUP *group, EC_POINT *out,
                         const uint8_t *dst, size_t dst_len, const uint8_t *msg,
                         size_t msg_len);
    const EC_GROUP *group;
    const char *dst;
    const char *msg;
    const char *x_hex;
    const char *y_hex;
  };
  const HashToCurveTest kTests[] = {
      // See RFC 9380, appendix J.1.1.
      {&EC_hash_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_", "",
       "2c15230b26dbc6fc9a37051158c95b79656e17a1a920b11394ca91"
       "c44247d3e4",
       "8a7a74985cc5c776cdfe4b1f19884970453912e9d31528c060be9a"
       "b5c43e8415"},
      {&EC_hash_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_", "abc",
       "0bb8b87485551aa43ed54f009230450b492fead5f1cc91658775da"
       "c4a3388a0f",
       "5c41b3d0731a27a7b14bc0bf0ccded2d8751f83493404c84a88e71"
       "ffd424212e"},
      {&EC_hash_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_", "abcdef0123456789",
       "65038ac8f2b1def042a5df0b33b1f4eca6bff7cb0f9c6c15268118"
       "64e544ed80",
       "cad44d40a656e7aff4002a8de287abc8ae0482b5ae825822bb870d"
       "6df9b56ca3"},
      {&EC_hash_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_",
       "q128_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqq",
       "4be61ee205094282ba8a2042bcb48d88dfbb609301c49aa8b07853"
       "3dc65a0b5d",
       "98f8df449a072c4721d241a3b1236d3caccba603f916ca680f4539"
       "d2bfb3c29e"},
      {&EC_hash_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "457ae2981f70ca85d8e24c308b14db22f3e3862c5ea0f652ca38b5"
       "e49cd64bc5",
       "ecb9f0eadc9aeed232dabc53235368c1394c78de05dd96893eefa6"
       "2b0f4757dc"},

      // See RFC 9380, appendix J.2.1.
      {&EC_hash_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_RO_", "",
       "eb9fe1b4f4e14e7140803c1d99d0a93cd823d2b024040f9c067a8e"
       "ca1f5a2eeac9ad604973527a356f3fa3aeff0e4d83",
       "0c21708cff382b7f4643c07b105c2eaec2cead93a917d825601e63"
       "c8f21f6abd9abc22c93c2bed6f235954b25048bb1a"},
      {&EC_hash_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_RO_", "abc",
       "e02fc1a5f44a7519419dd314e29863f30df55a514da2d655775a81"
       "d413003c4d4e7fd59af0826dfaad4200ac6f60abe1",
       "01f638d04d98677d65bef99aef1a12a70a4cbb9270ec55248c0453"
       "0d8bc1f8f90f8a6a859a7c1f1ddccedf8f96d675f6"},
      {&EC_hash_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_RO_", "abcdef0123456789",
       "bdecc1c1d870624965f19505be50459d363c71a699a496ab672f9a"
       "5d6b78676400926fbceee6fcd1780fe86e62b2aa89",
       "57cf1f99b5ee00f3c201139b3bfe4dd30a653193778d89a0accc5e"
       "0f47e46e4e4b85a0595da29c9494c1814acafe183c"},
      {&EC_hash_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_RO_",
       "q128_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqq",
       "03c3a9f401b78c6c36a52f07eeee0ec1289f178adf78448f43a385"
       "0e0456f5dd7f7633dd31676d990eda32882ab486c0",
       "cc183d0d7bdfd0a3af05f50e16a3f2de4abbc523215bf57c848d5e"
       "a662482b8c1f43dc453a93b94a8026db58f3f5d878"},
      {&EC_hash_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_RO_",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "7b18d210b1f090ac701f65f606f6ca18fb8d081e3bc6cbd937c560"
       "4325f1cdea4c15c10a54ef303aabf2ea58bd9947a4",
       "ea857285a33abb516732915c353c75c576bf82ccc96adb63c094dd"
       "e580021eddeafd91f8c0bfee6f636528f3d0c47fd2"},

      // See draft-irtf-cfrg-hash-to-curve-07, appendix G.2.1.
      {hash_to_curve_p384_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SSWU_RO_TESTGEN", "",
       "2fc0b9efdd63a8e43b4db88dc12f03c798f6fd91bccac0c9096185"
       "4386e58fdc54fc2a01f0f358759054ce1f9b762025",
       "949b936fabb72cdb02cd7980b86cb6a3adf286658e81301648851d"
       "b8a49d9bec00ccb57698d559fc5960fa5030a8e54b"},
      {hash_to_curve_p384_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SSWU_RO_TESTGEN", "abc",
       "4f3338035391e8ce8ce40c974136f0edc97f392ffd44a643338741"
       "8ed1b8c2603487e1688ec151f048fbc6b2c138c92f",
       "152b90aef6558be328a3168855fb1906452e7167b0f7c8a56ff9d4"
       "fa87d6fb522cdf8e409db54418b2c764fd26260757"},
      {hash_to_curve_p384_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SSWU_RO_TESTGEN", "abcdef0123456789",
       "e9e5d7ac397e123d060ad44301cbc8eb972f6e64ebcff29dcc9b9a"
       "10357902aace2240c580fec85e5b427d98b4e80703",
       "916cb8963521ad75105be43cc4148e5a5bbb4fcf107f1577e4f7fa"
       "3ca58cd786aa76890c8e687d2353393bc16c78ec4d"},
      {hash_to_curve_p384_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SSWU_RO_TESTGEN",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "41941db59a7b8b633bd5bfa462f1e29a9f18e5a341445d90fc6eb9"
       "37f2913224287b9dfb64742851f760eb14ca115ff9",
       "1510e764f1be968d661b7aaecb26a6d38c98e5205ca150f0ae426d"
       "2c3983c68e3a9ffb283c6ae4891d891b5705500475"},

      // See RFC 9380, appendix J.1.2.
      {&EC_encode_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_NU_", "",
       "f871caad25ea3b59c16cf87c1894902f7e7b2c822c3d3f73596c5a"
       "ce8ddd14d1",
       "87b9ae23335bee057b99bac1e68588b18b5691af476234b8971bc4"
       "f011ddc99b"},
      {&EC_encode_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_NU_", "abc",
       "fc3f5d734e8dce41ddac49f47dd2b8a57257522a865c124ed02b92"
       "b5237befa4",
       "fe4d197ecf5a62645b9690599e1d80e82c500b22ac705a0b421fac"
       "7b47157866"},
      {&EC_encode_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_NU_", "abcdef0123456789",
       "f164c6674a02207e414c257ce759d35eddc7f55be6d7f415e2cc17"
       "7e5d8faa84",
       "3aa274881d30db70485368c0467e97da0e73c18c1d00f34775d012"
       "b6fcee7f97"},
      {&EC_encode_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_NU_",
       "q128_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqq",
       "324532006312be4f162614076460315f7a54a6f85544da773dc659"
       "aca0311853",
       "8d8197374bcd52de2acfefc8a54fe2c8d8bebd2a39f16be9b710e4"
       "b1af6ef883"},
      {&EC_encode_to_curve_p256_xmd_sha256_sswu, EC_group_p256(),
       "QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_NU_",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "5c4bad52f81f39c8e8de1260e9a06d72b8b00a0829a8ea004a610b"
       "0691bea5d9",
       "c801e7c0782af1f74f24fc385a8555da0582032a3ce038de637ccd"
       "cb16f7ef7b"},

      // See RFC 9380, appendix J.2.2.
      {&EC_encode_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_NU_", "",
       "de5a893c83061b2d7ce6a0d8b049f0326f2ada4b966dc7e7292725"
       "6b033ef61058029a3bfb13c1c7ececd6641881ae20",
       "63f46da6139785674da315c1947e06e9a0867f5608cf24724eb379"
       "3a1f5b3809ee28eb21a0c64be3be169afc6cdb38ca"},
      {&EC_encode_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_NU_", "abc",
       "1f08108b87e703c86c872ab3eb198a19f2b708237ac4be53d7929f"
       "b4bd5194583f40d052f32df66afe5249c9915d139b",
       "1369dc8d5bf038032336b989994874a2270adadb67a7fcc32f0f88"
       "24bc5118613f0ac8de04a1041d90ff8a5ad555f96c"},
      {&EC_encode_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_NU_", "abcdef0123456789",
       "4dac31ec8a82ee3c02ba2d7c9fa431f1e59ffe65bf977b948c59e1"
       "d813c2d7963c7be81aa6db39e78ff315a10115c0d0",
       "845333cdb5702ad5c525e603f302904d6fc84879f0ef2ee2014a6b"
       "13edd39131bfd66f7bd7cdc2d9ccf778f0c8892c3f"},
      {&EC_encode_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_NU_",
       "q128_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
       "qqqqqqqqqqqqqqqqqqqqqqqqq",
       "13c1f8c52a492183f7c28e379b0475486718a7e3ac1dfef39283b9"
       "ce5fb02b73f70c6c1f3dfe0c286b03e2af1af12d1d",
       "57e101887e73e40eab8963324ed16c177d55eb89f804ec9df06801"
       "579820420b5546b579008df2145fd770f584a1a54c"},
      {&EC_encode_to_curve_p384_xmd_sha384_sswu, EC_group_p384(),
       "QUUX-V01-CS02-with-P384_XMD:SHA-384_SSWU_NU_",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "af129727a4207a8cb9e9dce656d88f79fce25edbcea350499d65e9"
       "bf1204537bdde73c7cefb752a6ed5ebcd44e183302",
       "ce68a3d5e161b2e6a968e4ddaa9e51504ad1516ec170c7eef3ca6b"
       "5327943eca95d90b23b009ba45f58b72906f2a99e2"},
  };

  for (const auto &test : kTests) {
    SCOPED_TRACE(test.dst);
    SCOPED_TRACE(test.msg);

    bssl::UniquePtr<EC_POINT> p(EC_POINT_new(test.group));
    ASSERT_TRUE(p);
    ASSERT_TRUE(test.hash_to_curve(
        test.group, p.get(), reinterpret_cast<const uint8_t *>(test.dst),
        strlen(test.dst), reinterpret_cast<const uint8_t *>(test.msg),
        strlen(test.msg)));

    std::vector<uint8_t> buf;
    ASSERT_TRUE(EncodeECPoint(&buf, test.group, p.get(),
                              POINT_CONVERSION_UNCOMPRESSED));
    size_t field_len = (buf.size() - 1) / 2;
    EXPECT_EQ(test.x_hex, EncodeHex(bssl::Span(buf).subspan(1, field_len)));
    EXPECT_EQ(test.y_hex,
              EncodeHex(bssl::Span(buf).subspan(1 + field_len, field_len)));
  }

  // hash-to-curve functions should check for the wrong group.
  EC_JACOBIAN raw;
  bssl::UniquePtr<EC_POINT> p_p384(EC_POINT_new(EC_group_p384()));
  ASSERT_TRUE(p_p384);
  bssl::UniquePtr<EC_POINT> p_p224(EC_POINT_new(EC_group_p224()));
  ASSERT_TRUE(p_p224);
  static const uint8_t kDST[] = {0, 1, 2, 3};
  static const uint8_t kMessage[] = {4, 5, 6, 7};
  EXPECT_FALSE(ec_hash_to_curve_p384_xmd_sha384_sswu(
      EC_group_p224(), &raw, kDST, sizeof(kDST), kMessage, sizeof(kMessage)));
  EXPECT_FALSE(EC_hash_to_curve_p384_xmd_sha384_sswu(
      EC_group_p224(), p_p224.get(), kDST, sizeof(kDST), kMessage,
      sizeof(kMessage)));
  EXPECT_FALSE(EC_hash_to_curve_p384_xmd_sha384_sswu(
      EC_group_p224(), p_p384.get(), kDST, sizeof(kDST), kMessage,
      sizeof(kMessage)));
  EXPECT_FALSE(EC_hash_to_curve_p384_xmd_sha384_sswu(
      EC_group_p384(), p_p224.get(), kDST, sizeof(kDST), kMessage,
      sizeof(kMessage)));

  // Zero-length DSTs are not allowed.
  EXPECT_FALSE(ec_hash_to_curve_p384_xmd_sha384_sswu(
      EC_group_p384(), &raw, nullptr, 0, kMessage, sizeof(kMessage)));
}

TEST(ECTest, HashToScalar) {
  struct HashToScalarTest {
    int (*hash_to_scalar)(const EC_GROUP *group, EC_SCALAR *out,
                          const uint8_t *dst, size_t dst_len,
                          const uint8_t *msg, size_t msg_len);
    const EC_GROUP *group;
    const char *dst;
    const char *msg;
    const char *result_hex;
  };
  const HashToScalarTest kTests[] = {
      {&ec_hash_to_scalar_p384_xmd_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SCALAR_TEST", "",
       "9687acc2de56c3cf94c0e05b6811a21aa480092254ec0532bdce63"
       "140ecd340f09dc2d45d77e21fb0aa76f7707b8a676"},
      {&ec_hash_to_scalar_p384_xmd_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SCALAR_TEST", "abcdef0123456789",
       "8f8076022a68233cbcecaceae68c2068f132724f001caa78619eff"
       "1ffc58fa871db73fe9034fc9cf853c384ed34b5666"},
      {&ec_hash_to_scalar_p384_xmd_sha512_draft07, EC_group_p384(),
       "P384_XMD:SHA-512_SCALAR_TEST",
       "a512_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "750f2fae7d2b2f41ac737d180c1d4363d85a1504798b4976d40921"
       "1ddb3651c13a5b4daba9975cdfce18336791131915"},
  };

  for (const auto &test : kTests) {
    SCOPED_TRACE(test.dst);
    SCOPED_TRACE(test.msg);

    EC_SCALAR scalar;
    ASSERT_TRUE(test.hash_to_scalar(
        test.group, &scalar, reinterpret_cast<const uint8_t *>(test.dst),
        strlen(test.dst), reinterpret_cast<const uint8_t *>(test.msg),
        strlen(test.msg)));
    uint8_t buf[EC_MAX_BYTES];
    size_t len;
    ec_scalar_to_bytes(test.group, buf, &len, &scalar);
    EXPECT_EQ(test.result_hex, EncodeHex(bssl::Span(buf, len)));
  }

  // hash-to-scalar functions should check for the wrong group.
  EC_SCALAR scalar;
  static const uint8_t kDST[] = {0, 1, 2, 3};
  static const uint8_t kMessage[] = {4, 5, 6, 7};
  EXPECT_FALSE(ec_hash_to_scalar_p384_xmd_sha512_draft07(
      EC_group_p224(), &scalar, kDST, sizeof(kDST), kMessage,
      sizeof(kMessage)));
}

}  // namespace
