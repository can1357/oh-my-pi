// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
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

#include <gtest/gtest.h>

#include <openssl/aead.h>
#include <openssl/aes.h>
#include <openssl/bn.h>
#include <openssl/cipher.h>
#include <openssl/cmac.h>
#include <openssl/crypto.h>
#include <openssl/ctrdrbg.h>
#include <openssl/dh.h>
#include <openssl/digest.h>
#include <openssl/ec.h>
#include <openssl/ecdh.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/md4.h>
#include <openssl/md5.h>
#include <openssl/rand.h>  // TODO(bbe): only for RAND_bytes call below, replace with BCM call
#include <openssl/rsa.h>
#include <openssl/sha.h>

#include "../../test/abi_test.h"
#include "../../test/test_util.h"
#include "../bcm_interface.h"
#include "../bn/internal.h"
#include "../rand/internal.h"
#include "../tls/internal.h"
#include "internal.h"


namespace {

// CALL_SERVICE_AND_CHECK_APPROVED runs |func| and sets |approved| to one of the
// |FIPSStatus*| values, above, depending on whether |func| invoked an
// approved service. The result of |func| becomes the result of this macro.
#define CALL_SERVICE_AND_CHECK_APPROVED(approved, func)   \
  [&] {                                                   \
    FIPSIndicatorHelper fips_indicator_helper(&approved); \
    return func;                                          \
  }()

enum class FIPSStatus {
  NOT_APPROVED = 0,
  APPROVED = 1,
};

// FIPSIndicatorHelper records whether the service indicator counter advanced
// during its lifetime.
class FIPSIndicatorHelper {
 public:
  FIPSIndicatorHelper(FIPSStatus *result)
      : result_(result), before_(FIPS_service_indicator_before_call()) {
    *result_ = FIPSStatus::NOT_APPROVED;
  }

  ~FIPSIndicatorHelper() {
    uint64_t after = FIPS_service_indicator_after_call();
    if (after != before_) {
      *result_ = FIPSStatus::APPROVED;
    }
  }

  FIPSIndicatorHelper(const FIPSIndicatorHelper &) = delete;
  FIPSIndicatorHelper &operator=(const FIPSIndicatorHelper &) = delete;

 private:
  FIPSStatus *const result_;
  const uint64_t before_;
};

static const uint8_t kAESKey[16] = {'A', 'W', 'S', '-', 'L', 'C', 'C', 'r',
                                    'y', 'p', 't', 'o', ' ', 'K', 'e', 'y'};

static const uint8_t kPlaintext[64] = {
    'A', 'W', 'S', '-', 'L', 'C', 'C', 'r', 'y', 'p', 't', 'o', 'M',
    'o', 'd', 'u', 'l', 'e', ' ', 'F', 'I', 'P', 'S', ' ', 'K', 'A',
    'T', ' ', 'E', 'n', 'c', 'r', 'y', 'p', 't', 'i', 'o', 'n', ' ',
    'a', 'n', 'd', ' ', 'D', 'e', 'c', 'r', 'y', 'p', 't', 'i', 'o',
    'n', ' ', 'P', 'l', 'a', 'i', 'n', 't', 'e', 'x', 't', '!'};

#if defined(BORINGSSL_FIPS)

// kEVPKeyGenShouldCallFIPSFunctions determines whether |EVP_PKEY_keygen_*|
// functions should call the FIPS versions of the key-generation functions.
static const bool kEVPKeyGenShouldCallFIPSFunctions = false;

// kCurveSecp256k1Supported determines whether secp256k1 tests should be run.
static const bool kCurveSecp256k1Supported = false;

// kEVPDeriveSetsServiceIndicator is true if `EVP_PKEY_derive` should set the
// service indicator for some algorithms.
static const bool kEVPDeriveSetsServiceIndicator = false;

template <typename T>
class TestWithNoErrors : public testing::TestWithParam<T> {
  void TearDown() override {
    if (ERR_peek_error() != 0) {
      auto f = [](const char *str, size_t len, void *unused) -> int {
        fprintf(stderr, "%s\n", str);
        return 1;
      };
      ERR_print_errors_cb(f, nullptr);
      ADD_FAILURE();
    }
  }
};

static const uint8_t kAESKey_192[24] = {'A', 'W', 'S', '-', 'L', 'C', 'C', 'r',
                                        'y', 'p', 't', 'o', ' ', '1', '9', '2',
                                        '-', 'b', 'i', 't', ' ', 'K', 'e', 'y'};

static const uint8_t kAESKey_256[32] = {'A', 'W', 'S', '-', 'L', 'C', 'C', 'r',
                                        'y', 'p', 't', 'o', ' ', '2', '5', '6',
                                        '-', 'b', 'i', 't', ' ', 'L', 'o', 'n',
                                        'g', ' ', 'K', 'e', 'y', '!', '!', '!'};

static const uint8_t kAESIV[AES_BLOCK_SIZE] = {0};

static bssl::UniquePtr<DH> GetDH() {
  // kFFDHE2048PrivateKeyData is a 225-bit value. (225 because that's the
  // minimum private key size in
  // https://tools.ietf.org/html/rfc7919#appendix-A.1.)
  static const uint8_t kFFDHE2048PrivateKey[] = {
      0x01, 0x91, 0x17, 0x3f, 0x2a, 0x05, 0x70, 0x18, 0x7e, 0xc4,
      0x22, 0xee, 0xb7, 0x0a, 0x15, 0x2f, 0x39, 0x64, 0x58, 0xf3,
      0xb8, 0x18, 0x7b, 0xe3, 0x6b, 0xd3, 0x8a, 0x4f, 0xa1};
  bssl::UniquePtr<BIGNUM> priv(
      BN_bin2bn(kFFDHE2048PrivateKey, sizeof(kFFDHE2048PrivateKey), nullptr));
  if (!priv) {
    return nullptr;
  }
  bssl::UniquePtr<DH> dh(DH_get_rfc7919_2048());
  if (!dh || !DH_set0_key(dh.get(), nullptr, priv.get())) {
    return nullptr;
  }
  priv.release();  // |DH_set0_key| takes ownership on success.
  return dh;
}

static void DoCipherFinal(EVP_CIPHER_CTX *ctx, std::vector<uint8_t> *out,
                          bssl::Span<const uint8_t> in,
                          FIPSStatus expect_approved) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  size_t max_out = in.size();
  if (EVP_CIPHER_CTX_encrypting(ctx)) {
    unsigned block_size = EVP_CIPHER_CTX_block_size(ctx);
    max_out += block_size - (max_out % block_size);
  }
  out->resize(max_out);

  size_t total = 0;
  int len;
  ASSERT_TRUE(EVP_CipherUpdate(ctx, out->data(), &len, in.data(), in.size()));
  total += static_cast<size_t>(len);
  // Check if the overall service is approved by checking |EVP_CipherFinal_ex|,
  // which should be the last part of the service.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_CipherFinal_ex(ctx, out->data() + total, &len)));
  total += static_cast<size_t>(len);
  ASSERT_LE(total, max_out);
  out->resize(total);

  EXPECT_EQ(approved, expect_approved);
}

static const uint8_t kTDES_EDE3_CipherText[64] = {
    0x2a, 0x17, 0x79, 0x5a, 0x9b, 0x1d, 0xd8, 0x72, 0x06, 0xc6, 0xe7,
    0x55, 0x14, 0xaa, 0x7b, 0x2a, 0x6e, 0xfc, 0x71, 0x29, 0xff, 0x9b,
    0x67, 0x73, 0x7c, 0x9e, 0x15, 0x74, 0x80, 0xc8, 0x2f, 0xca, 0x93,
    0xaa, 0x8e, 0xba, 0x2c, 0x48, 0x88, 0x51, 0xc7, 0xa4, 0xf4, 0xe3,
    0x2b, 0x33, 0xe5, 0xa1, 0x58, 0x0a, 0x08, 0x3c, 0xb9, 0xf6, 0xf1,
    0x20, 0x67, 0x02, 0x49, 0xa0, 0x92, 0x18, 0xde, 0x2b};

static const uint8_t kTDES_EDE3_CBCCipherText[64] = {
    0x2a, 0x17, 0x79, 0x5a, 0x9b, 0x1d, 0xd8, 0x72, 0xbf, 0x3f, 0xfd,
    0xe4, 0x0d, 0x66, 0x33, 0x49, 0x3b, 0x8c, 0xa6, 0xd0, 0x0a, 0x66,
    0xae, 0xf1, 0xd9, 0xa7, 0xd6, 0xfb, 0xa2, 0x39, 0x6f, 0xf6, 0x1b,
    0x8f, 0x67, 0xe1, 0x2b, 0x58, 0x1c, 0xb6, 0xa2, 0xec, 0xb3, 0xc2,
    0xe6, 0xd1, 0xcc, 0x11, 0x05, 0xdd, 0xee, 0x9d, 0x87, 0x95, 0xe9,
    0x58, 0xc7, 0xef, 0xa4, 0x6d, 0x5e, 0xd6, 0x57, 0x01};

// AES-OFB is not an approved service, and is only used to test we are not
// validating un-approved services correctly.
static const uint8_t kAESOFBCiphertext[64] = {
    0x49, 0xf5, 0x6a, 0x7d, 0x3e, 0xd7, 0xb2, 0x47, 0x35, 0xca, 0x54,
    0xf5, 0xf1, 0xb8, 0xd1, 0x48, 0x8e, 0x47, 0x09, 0x95, 0xd5, 0xa0,
    0xc6, 0xa3, 0xe4, 0x94, 0xaf, 0xd4, 0x1b, 0x64, 0x25, 0x65, 0x28,
    0x9e, 0x82, 0xba, 0x92, 0xca, 0x75, 0xb3, 0xf3, 0x78, 0x44, 0x87,
    0xd6, 0x11, 0xf9, 0x22, 0xa3, 0xf3, 0xc6, 0x1d, 0x30, 0x00, 0x5b,
    0x77, 0x18, 0x38, 0x39, 0x08, 0x5e, 0x0a, 0x56, 0x6b};

static const uint8_t kAESECBCiphertext[64] = {
    0xa4, 0xc1, 0x5c, 0x51, 0x2a, 0x2e, 0x2a, 0xda, 0xd9, 0x02, 0x23,
    0xe7, 0xa9, 0x34, 0x9d, 0xd8, 0x15, 0xc5, 0xf5, 0x55, 0x8e, 0xb0,
    0x29, 0x95, 0x48, 0x6c, 0x7f, 0xa9, 0x47, 0x19, 0x0b, 0x54, 0xe5,
    0x0f, 0x05, 0x76, 0xbb, 0xd0, 0x1a, 0x6c, 0xab, 0xe9, 0xfd, 0x5b,
    0xd8, 0x0b, 0x0a, 0xbd, 0x7f, 0xea, 0xda, 0x52, 0x07, 0x65, 0x13,
    0x6c, 0xbe, 0xfc, 0x36, 0x82, 0x4b, 0x6a, 0xc3, 0xd5};

static const uint8_t kAESECBCiphertext_192[64] = {
    0x1d, 0xc8, 0xaa, 0xa7, 0x29, 0x01, 0x17, 0x09, 0x72, 0xc6, 0xe9,
    0x63, 0x02, 0x9d, 0xeb, 0x01, 0xeb, 0xc0, 0xda, 0x82, 0x6c, 0x30,
    0x7d, 0x60, 0x1b, 0x3e, 0xc7, 0x7b, 0xe3, 0x18, 0xa2, 0x43, 0x59,
    0x15, 0x4a, 0xe4, 0x8a, 0x84, 0xda, 0x16, 0x90, 0x7b, 0xfa, 0x64,
    0x37, 0x62, 0x19, 0xf1, 0x95, 0x11, 0x61, 0x84, 0xb0, 0x70, 0x49,
    0x72, 0x9f, 0xe7, 0x3a, 0x18, 0x99, 0x01, 0xba, 0xb0};

static const uint8_t kAESECBCiphertext_256[64] = {
    0x6f, 0x2d, 0x6d, 0x7a, 0xc1, 0x8f, 0x00, 0x9f, 0x2d, 0xcf, 0xba,
    0xe6, 0x4f, 0xdd, 0xe0, 0x09, 0x5b, 0xf3, 0xa4, 0xaf, 0xce, 0x45,
    0x49, 0x6e, 0x28, 0x7b, 0x48, 0x57, 0xb5, 0xf5, 0xd8, 0x05, 0x16,
    0x0f, 0xea, 0x21, 0x0c, 0x39, 0x78, 0xee, 0x9e, 0x57, 0x3c, 0x40,
    0x11, 0x9c, 0xd9, 0x34, 0x97, 0xb9, 0xa6, 0x06, 0x40, 0x60, 0xa2,
    0x0c, 0x01, 0xe3, 0x9c, 0xda, 0x3e, 0xad, 0x99, 0x3d};

static const uint8_t kAESCBCCiphertext[64] = {
    0xa4, 0xc1, 0x5c, 0x51, 0x2a, 0x2e, 0x2a, 0xda, 0xd9, 0x02, 0x23,
    0xe7, 0xa9, 0x34, 0x9d, 0xd8, 0x5c, 0xb3, 0x65, 0x54, 0x72, 0xc8,
    0x06, 0xf1, 0x36, 0xc3, 0x97, 0x73, 0x87, 0xca, 0x44, 0x99, 0x21,
    0xb8, 0xdb, 0x93, 0x22, 0x00, 0x89, 0x7c, 0x1c, 0xea, 0x36, 0x23,
    0x18, 0xdb, 0xc1, 0x52, 0x8c, 0x23, 0x66, 0x11, 0x0d, 0xa8, 0xe9,
    0xb8, 0x08, 0x8b, 0xaa, 0x81, 0x47, 0x01, 0xa4, 0x4f};

static const uint8_t kAESCBCCiphertext_192[64] = {
    0x1d, 0xc8, 0xaa, 0xa7, 0x29, 0x01, 0x17, 0x09, 0x72, 0xc6, 0xe9,
    0x63, 0x02, 0x9d, 0xeb, 0x01, 0xb4, 0x48, 0xa8, 0x00, 0x94, 0x46,
    0x7f, 0xe3, 0xc1, 0x24, 0xea, 0x41, 0xa0, 0x2b, 0x47, 0x2f, 0xae,
    0x19, 0xce, 0x0d, 0xfa, 0x90, 0x45, 0x85, 0xce, 0xc4, 0x21, 0x0c,
    0x74, 0x38, 0x13, 0xfd, 0x64, 0xba, 0x58, 0x10, 0x37, 0x53, 0x48,
    0x66, 0x02, 0x76, 0xfb, 0xb1, 0x3a, 0x19, 0xce, 0x61};

static const uint8_t kAESCBCCiphertext_256[64] = {
    0x6f, 0x2d, 0x6d, 0x7a, 0xc1, 0x8f, 0x00, 0x9f, 0x2d, 0xcf, 0xba,
    0xe6, 0x4f, 0xdd, 0xe0, 0x09, 0x9e, 0xa8, 0x28, 0xdc, 0x27, 0xde,
    0x89, 0x26, 0xc7, 0x94, 0x6a, 0xbf, 0xb6, 0x94, 0x05, 0x08, 0x6c,
    0x39, 0x07, 0x52, 0xfa, 0x7b, 0xca, 0x7d, 0x9b, 0xbf, 0xb2, 0x43,
    0x2b, 0x69, 0xee, 0xc5, 0x68, 0x4c, 0xdd, 0x62, 0xae, 0x8d, 0x7e,
    0x71, 0x0c, 0x8f, 0x11, 0xce, 0x1d, 0x8b, 0xee, 0x94};

static const uint8_t kAESCTRCiphertext[64] = {
    0x49, 0xf5, 0x6a, 0x7d, 0x3e, 0xd7, 0xb2, 0x47, 0x35, 0xca, 0x54,
    0xf5, 0xf1, 0xb8, 0xd1, 0x48, 0xb0, 0x18, 0xc4, 0x5e, 0xeb, 0x42,
    0xfd, 0x10, 0x49, 0x1f, 0x2b, 0x11, 0xe9, 0xb0, 0x07, 0xa4, 0x00,
    0x56, 0xec, 0x25, 0x53, 0x4d, 0x70, 0x98, 0x38, 0x85, 0x5d, 0x54,
    0xab, 0x2c, 0x19, 0x13, 0x6d, 0xf3, 0x0e, 0x6f, 0x48, 0x2f, 0xab,
    0xe1, 0x82, 0xd4, 0x30, 0xa9, 0x16, 0x73, 0x93, 0xc3};

static const uint8_t kAESCTRCiphertext_192[64] = {
    0x72, 0x7d, 0xbb, 0xd4, 0x8b, 0x16, 0x8b, 0x19, 0xa4, 0xeb, 0xa6,
    0xfa, 0xa0, 0xd0, 0x2b, 0xbb, 0x9b, 0x1f, 0xbf, 0x4d, 0x67, 0xfb,
    0xea, 0x89, 0x16, 0xd7, 0xa4, 0xb6, 0xbe, 0x1a, 0x78, 0x1c, 0x3d,
    0x44, 0x49, 0xa0, 0xf2, 0xb2, 0xb3, 0x82, 0x0f, 0xdd, 0xac, 0xd6,
    0xea, 0x6e, 0x1f, 0x09, 0x8d, 0xa5, 0xdb, 0x4f, 0x3f, 0x97, 0x90,
    0x26, 0xed, 0xf6, 0xbb, 0x62, 0xb3, 0x6f, 0x52, 0x67};

static const uint8_t kAESCTRCiphertext_256[64] = {
    0x4a, 0x87, 0x44, 0x09, 0xf4, 0x1d, 0x80, 0x94, 0x51, 0x9a, 0xe4,
    0x89, 0x49, 0xcb, 0x98, 0x0d, 0x27, 0xc5, 0xba, 0x20, 0x00, 0x45,
    0xbb, 0x29, 0x75, 0xc0, 0xb7, 0x23, 0x0d, 0x81, 0x9f, 0x43, 0xaa,
    0x78, 0x89, 0xc0, 0xc4, 0x6d, 0x99, 0x0d, 0xb8, 0x9b, 0xc3, 0x25,
    0xa6, 0xd1, 0x7c, 0x98, 0x3e, 0xff, 0x06, 0x59, 0x41, 0xcf, 0xb2,
    0xd5, 0x2f, 0x95, 0xea, 0x83, 0xb1, 0x42, 0xb8, 0xb2};

static const uint8_t kAESCFBCiphertext[64] = {
    0x49, 0xf5, 0x6a, 0x7d, 0x3e, 0xd7, 0xb2, 0x47, 0x35, 0xca, 0x54,
    0xf5, 0xf1, 0xb8, 0xd1, 0x48, 0x01, 0xdc, 0xba, 0x43, 0x3a, 0x7b,
    0xbf, 0x84, 0x91, 0x49, 0xc5, 0xc9, 0xd6, 0xcf, 0x6a, 0x2c, 0x3a,
    0x66, 0x99, 0x68, 0xe3, 0xd0, 0x56, 0x05, 0xe7, 0x99, 0x7f, 0xc3,
    0xbc, 0x09, 0x13, 0xa6, 0xf0, 0xde, 0x17, 0xf4, 0x85, 0x9a, 0xee,
    0x29, 0xc3, 0x77, 0xab, 0xc4, 0xf6, 0xdb, 0xae, 0x24};

static const uint8_t kAESCCMCiphertext[64 + 4] = {
    0x7a, 0x02, 0x5d, 0x48, 0x02, 0x44, 0x78, 0x7f, 0xb4, 0x71, 0x74, 0x7b,
    0xec, 0x4d, 0x90, 0x29, 0x7b, 0xa7, 0x65, 0xbb, 0x3e, 0x80, 0x41, 0x7e,
    0xab, 0xb4, 0x58, 0x22, 0x4f, 0x86, 0xcd, 0xcc, 0xc2, 0x12, 0xeb, 0x36,
    0x39, 0x89, 0xe3, 0x66, 0x2a, 0xbf, 0xe3, 0x6c, 0x95, 0x60, 0x13, 0x9e,
    0x93, 0xcc, 0xb4, 0x06, 0xbe, 0xaf, 0x3f, 0xba, 0x13, 0x73, 0x09, 0x92,
    0xd1, 0x80, 0x73, 0xb3, 0xc3, 0xa3, 0xa4, 0x8b,
};

static const uint8_t kAESKWCiphertext[72] = {
    0x44, 0xec, 0x7d, 0x92, 0x2c, 0x9f, 0xf3, 0xe8, 0xac, 0xb1, 0xea, 0x3d,
    0x0a, 0xc7, 0x51, 0x27, 0xe8, 0x03, 0x11, 0x78, 0xe5, 0xaf, 0x8d, 0xb1,
    0x70, 0x96, 0x2e, 0xfa, 0x05, 0x48, 0x48, 0x99, 0x1a, 0x58, 0xcc, 0xfe,
    0x11, 0x36, 0x5d, 0x49, 0x98, 0x1e, 0xbb, 0xd6, 0x0b, 0xf5, 0xb9, 0x64,
    0xa4, 0x30, 0x3e, 0x60, 0xf6, 0xc5, 0xff, 0x82, 0x30, 0x9a, 0xa7, 0x48,
    0x82, 0xe2, 0x00, 0xc1, 0xe9, 0xc2, 0x73, 0x6f, 0xbc, 0x89, 0x66, 0x9d};

static const uint8_t kAESKWPCiphertext[72] = {
    0x29, 0x5e, 0xb9, 0xea, 0x96, 0xa7, 0xa5, 0xca, 0xfa, 0xeb, 0xda, 0x78,
    0x13, 0xea, 0x83, 0xca, 0x41, 0xdb, 0x4d, 0x36, 0x7d, 0x39, 0x8a, 0xd6,
    0xef, 0xd3, 0xd2, 0x2d, 0x3a, 0xc8, 0x55, 0xc8, 0x73, 0xd7, 0x79, 0x55,
    0xad, 0xc0, 0xce, 0xad, 0x12, 0x54, 0x51, 0xf0, 0x70, 0x76, 0xff, 0xe7,
    0x0c, 0xb2, 0x8e, 0xdd, 0xb6, 0x9a, 0x27, 0x74, 0x98, 0x28, 0xe0, 0xfa,
    0x11, 0xe6, 0x3f, 0x86, 0x93, 0x23, 0xf8, 0x0d, 0xcb, 0xaf, 0x2b, 0xb7};

static const uint8_t kAESCMACOutput[16] = {0xe7, 0x32, 0x43, 0xb4, 0xae, 0x79,
                                           0x08, 0x86, 0xe7, 0x9f, 0x0d, 0x3f,
                                           0x88, 0x3f, 0x1a, 0xfd};

const uint8_t kDHOutput[2048 / 8] = {
    0x83, 0xf0, 0xd8, 0x4f, 0xdb, 0xe7, 0x65, 0xb6, 0x80, 0x6f, 0xa3, 0x22,
    0x9b, 0x33, 0x1c, 0x87, 0x89, 0xc8, 0x1d, 0x2c, 0xa1, 0xba, 0xa3, 0xb8,
    0xdf, 0xad, 0x42, 0xea, 0x9a, 0x75, 0xfe, 0xbf, 0xc1, 0xa8, 0xf6, 0xda,
    0xec, 0xdf, 0x48, 0x61, 0x7d, 0x7f, 0x3d, 0xab, 0xbd, 0xda, 0xd1, 0xd3,
    0xd8, 0xaf, 0x44, 0x4a, 0xba, 0x3f, 0x0e, 0x99, 0x8d, 0x11, 0xdc, 0x63,
    0xb1, 0xe0, 0x65, 0xf2, 0xb9, 0x82, 0x81, 0x8c, 0x88, 0x75, 0x8f, 0xa0,
    0x94, 0x52, 0x2a, 0x2f, 0x2d, 0x10, 0xb1, 0xf4, 0xd2, 0xdd, 0x0f, 0x8a,
    0x7e, 0x49, 0x7b, 0x1e, 0xfd, 0x8c, 0x78, 0xf9, 0x11, 0xdf, 0x80, 0x8b,
    0x2e, 0x86, 0x34, 0xbf, 0x4b, 0xca, 0x13, 0x3e, 0x85, 0x63, 0xeb, 0xe4,
    0xff, 0xec, 0xb0, 0xe8, 0x83, 0xf6, 0x2c, 0x45, 0x21, 0x90, 0x34, 0x9c,
    0x9d, 0x9d, 0xfe, 0x1a, 0x48, 0x53, 0xef, 0x97, 0xd5, 0xea, 0x6a, 0x65,
    0xf5, 0xe9, 0x9f, 0x91, 0x4f, 0xb4, 0x43, 0xe7, 0x1f, 0x0a, 0x2e, 0xdb,
    0xe6, 0x84, 0x30, 0xdb, 0xad, 0xe4, 0xaf, 0x2c, 0xf9, 0x93, 0xe8, 0x0a,
    0xab, 0x7f, 0x1c, 0xde, 0xb3, 0x80, 0xb6, 0x02, 0x42, 0xba, 0x18, 0x0d,
    0x0f, 0xc2, 0x1d, 0xa4, 0x4b, 0x2b, 0x84, 0x74, 0x10, 0x97, 0x6d, 0xdc,
    0xfa, 0x99, 0xdc, 0xba, 0xf2, 0xcb, 0x1b, 0xe8, 0x1a, 0xba, 0x0c, 0x67,
    0x60, 0x07, 0x87, 0xcc, 0xc6, 0x0d, 0xef, 0x56, 0x07, 0x80, 0x55, 0xae,
    0x03, 0xa3, 0x62, 0x31, 0x4c, 0x50, 0xf7, 0xf6, 0x87, 0xb3, 0x8d, 0xe2,
    0x11, 0x86, 0xe7, 0x9d, 0x98, 0x3c, 0x2a, 0x6c, 0x8a, 0xf0, 0xa7, 0x73,
    0x33, 0x07, 0x4e, 0x70, 0xee, 0x14, 0x4b, 0xa3, 0xf7, 0x4f, 0x8f, 0x1a,
    0xa2, 0xf6, 0xd1, 0xeb, 0x4d, 0x04, 0xf9, 0x4c, 0x07, 0x36, 0xb1, 0x46,
    0x53, 0x55, 0xb1, 0x23};

static const uint8_t kOutput_md4[MD4_DIGEST_LENGTH] = {
    0xab, 0x6b, 0xda, 0x84, 0xc0, 0x6b, 0xd0, 0x1d,
    0x19, 0xc0, 0x08, 0x11, 0x07, 0x8d, 0xce, 0x0e};

static const uint8_t kOutput_md5[MD5_DIGEST_LENGTH] = {
    0xe9, 0x70, 0xa2, 0xf7, 0x9c, 0x55, 0x57, 0xac,
    0x4e, 0x7f, 0x6b, 0xbc, 0xa3, 0xb9, 0xb7, 0xdb};

static const uint8_t kOutput_sha1[SHA_DIGEST_LENGTH] = {
    0xaa, 0x18, 0x71, 0x34, 0x00, 0x71, 0x67, 0x9f, 0xa1, 0x6d,
    0x20, 0x82, 0x91, 0x0f, 0x53, 0x0a, 0xcd, 0x6e, 0xa4, 0x34};

static const uint8_t kOutput_sha224[SHA224_DIGEST_LENGTH] = {
    0x5f, 0x1a, 0x9e, 0x68, 0x4c, 0xb7, 0x42, 0x68, 0xa0, 0x8b,
    0x87, 0xd7, 0x96, 0xb6, 0xcf, 0x1e, 0x4f, 0x85, 0x1c, 0x47,
    0xe9, 0x29, 0xb3, 0xb2, 0x73, 0x72, 0xd2, 0x69};

static const uint8_t kOutput_sha256[SHA256_DIGEST_LENGTH] = {
    0xe7, 0x63, 0x1c, 0xbb, 0x12, 0xb5, 0xbf, 0x4f, 0x99, 0x05, 0x9d,
    0x40, 0x15, 0x55, 0x34, 0x9c, 0x26, 0x36, 0xd2, 0xfe, 0x6a, 0xd6,
    0x26, 0xb4, 0x9d, 0x33, 0x07, 0xf5, 0xe6, 0x29, 0x13, 0x92};

static const uint8_t kOutput_sha384[SHA384_DIGEST_LENGTH] = {
    0x15, 0x81, 0x48, 0x8d, 0x95, 0xf2, 0x66, 0x84, 0x65, 0x94, 0x3e, 0xb9,
    0x8c, 0xda, 0x36, 0x30, 0x2a, 0x85, 0xc0, 0xcd, 0xec, 0x38, 0xa0, 0x1f,
    0x72, 0xe2, 0x68, 0xfe, 0x4e, 0xdb, 0x27, 0x8b, 0x50, 0x15, 0xe0, 0x24,
    0xc3, 0x65, 0xd1, 0x66, 0x2a, 0x3e, 0xe7, 0x00, 0x16, 0x51, 0xf5, 0x18};

static const uint8_t kOutput_sha512[SHA512_DIGEST_LENGTH] = {
    0x71, 0xcc, 0xec, 0x03, 0xf8, 0x76, 0xf4, 0x0b, 0xf1, 0x1b, 0x89,
    0x27, 0x83, 0xa1, 0x70, 0x02, 0x00, 0x2b, 0xe9, 0x3c, 0x3c, 0x65,
    0x12, 0xb9, 0xa8, 0x8c, 0xc5, 0x9d, 0xae, 0x3c, 0x73, 0x43, 0x76,
    0x4d, 0x98, 0xed, 0xd0, 0xbe, 0xb4, 0xf9, 0x0b, 0x5c, 0x5d, 0x34,
    0x46, 0x30, 0x18, 0xc2, 0x05, 0x88, 0x8a, 0x3c, 0x25, 0xcc, 0x06,
    0xf8, 0x73, 0xb9, 0xe4, 0x18, 0xa8, 0xc2, 0xf0, 0xe5};

static const uint8_t kOutput_sha512_256[SHA512_256_DIGEST_LENGTH] = {
    0x1a, 0x78, 0x68, 0x6b, 0x69, 0x6d, 0x28, 0x14, 0x6b, 0x37, 0x11,
    0x2d, 0xfb, 0x72, 0x35, 0xfa, 0xc1, 0xc4, 0x5f, 0x5c, 0x49, 0x91,
    0x08, 0x95, 0x0b, 0x0f, 0xc9, 0x88, 0x44, 0x12, 0x01, 0x6a};

static const uint8_t kHMACOutput_sha1[SHA_DIGEST_LENGTH] = {
    0x34, 0xac, 0x50, 0x9b, 0xa9, 0x4c, 0x39, 0xef, 0x45, 0xa0,
    0x6b, 0xdc, 0xfc, 0xbd, 0x3d, 0x42, 0xe8, 0x0a, 0x97, 0x86};

static const uint8_t kHMACOutput_sha224[SHA224_DIGEST_LENGTH] = {
    0x30, 0x62, 0x97, 0x45, 0x9e, 0xea, 0x62, 0xe4, 0x5d, 0xbb,
    0x7d, 0x25, 0x3f, 0x77, 0x0f, 0x9d, 0xa4, 0xbd, 0x17, 0x96,
    0x23, 0x53, 0xe1, 0x76, 0xf3, 0xf8, 0x9b, 0x74};

static const uint8_t kHMACOutput_sha256[SHA256_DIGEST_LENGTH] = {
    0x68, 0x33, 0x3e, 0x74, 0x9a, 0x49, 0xab, 0x77, 0xb4, 0x1a, 0x40,
    0xd8, 0x55, 0x07, 0xa7, 0xb6, 0x48, 0xa1, 0xa5, 0xa9, 0xd1, 0x7b,
    0x85, 0xe9, 0x33, 0x09, 0x16, 0x79, 0xcc, 0xe9, 0x29, 0x97};

static const uint8_t kHMACOutput_sha384[SHA384_DIGEST_LENGTH] = {
    0xcc, 0x39, 0x22, 0x0e, 0x9f, 0x2e, 0x26, 0x4a, 0xb5, 0xf8, 0x4a, 0x0f,
    0x73, 0x51, 0x26, 0x1a, 0xf2, 0xef, 0x15, 0xf3, 0x5f, 0x77, 0xce, 0xbb,
    0x4c, 0x69, 0x86, 0x0e, 0x1f, 0x5c, 0x4d, 0xc9, 0x96, 0xd9, 0xed, 0x74,
    0x6c, 0x45, 0x05, 0x7a, 0x0e, 0x3f, 0x36, 0x8a, 0xda, 0x2a, 0x35, 0xf9};

static const uint8_t kHMACOutput_sha512[SHA512_DIGEST_LENGTH] = {
    0x4c, 0x09, 0x46, 0x50, 0x7c, 0xb3, 0xa1, 0xfa, 0xbc, 0xf2, 0xc4,
    0x4f, 0x1e, 0x3d, 0xa9, 0x0b, 0x29, 0x4e, 0x12, 0x09, 0x09, 0x32,
    0xde, 0x82, 0xa0, 0xab, 0xf6, 0x5e, 0x66, 0x19, 0xd0, 0x86, 0x9a,
    0x92, 0xe3, 0xf9, 0x13, 0xa7, 0xe6, 0xfc, 0x1a, 0x2e, 0x50, 0xda,
    0xf6, 0x8f, 0xb2, 0xd5, 0xb2, 0x6e, 0x97, 0x82, 0x25, 0x5a, 0x1e,
    0xbf, 0x9b, 0x99, 0x8c, 0xf0, 0x37, 0xe6, 0x3d, 0x40};

static const uint8_t kHMACOutput_sha512_256[SHA512_256_DIGEST_LENGTH] = {
    0x9c, 0x95, 0x9c, 0x03, 0xc9, 0x8c, 0x90, 0xee, 0x7a, 0xff, 0xed,
    0x26, 0xba, 0x75, 0x90, 0xd0, 0xb9, 0xd4, 0x09, 0xf5, 0x22, 0xd6,
    0xb6, 0xab, 0xa8, 0xb9, 0xae, 0x01, 0x06, 0x37, 0x8f, 0xd1};

static const uint8_t kDRBGEntropy[CTR_DRBG_MIN_ENTROPY_LEN] = {
    'B', 'C', 'M', ' ', 'K', 'n', 'o', 'w', 'n', ' ', 'A',
    'n', 's', 'w', 'e', 'r', ' ', 'T', 'e', 's', 't', ' ',
    'D', 'B', 'R', 'G', ' ', 'I', 'n', 'i', 't', 'i'};
static const uint8_t kDRBGNonce[CTR_DRBG_NONCE_LEN] = {
    'a', 'l', ' ', 'E', 'n', 't', 'r', 'o',
    'p', 'y', ' ', ' ', ' ', ' ', ' ', ' '};

static const uint8_t kDRBGPersonalization[18] = {'B', 'C', 'M', 'P', 'e', 'r',
                                                 's', 'o', 'n', 'a', 'l', 'i',
                                                 'z', 'a', 't', 'i', 'o', 'n'};

static const uint8_t kDRBGAD[16] = {'B', 'C', 'M', ' ', 'D', 'R', 'B', 'G',
                                    ' ', 'K', 'A', 'T', ' ', 'A', 'D', ' '};

const uint8_t kDRBGOutput[64] = {
    0x34, 0xa6, 0xa1, 0x4a, 0xc2, 0x42, 0xb4, 0x9a, 0xac, 0x50, 0xf3,
    0x2c, 0xfb, 0x2d, 0x93, 0x25, 0x85, 0x31, 0xc2, 0xe7, 0xd1, 0xa6,
    0x2c, 0xe4, 0xa1, 0xd2, 0x13, 0xc0, 0x91, 0xf8, 0xdf, 0x59, 0x2a,
    0x01, 0xaf, 0x3a, 0x5b, 0xd0, 0x95, 0xfe, 0x1e, 0xf6, 0xfa, 0x60,
    0x03, 0xf4, 0x70, 0xf5, 0x52, 0x9b, 0x58, 0x11, 0xdb, 0xae, 0x22,
    0xe2, 0x3b, 0x7d, 0x52, 0x40, 0xad, 0xda, 0x7e, 0x40,
};

static const uint8_t kDRBGEntropy2[48] = {
    'B', 'C', 'M', ' ', 'K', 'n', 'o', 'w', 'n', ' ', 'A', 'n',
    's', 'w', 'e', 'r', ' ', 'T', 'e', 's', 't', ' ', 'D', 'B',
    'R', 'G', ' ', 'R', 'e', 's', 'e', 'e', 'd', ' ', 'E', 'n',
    't', 'r', 'o', 'p', 'y', ' ', ' ', ' ', ' ', ' ', ' ', ' '};

static const uint8_t kDRBGReseedOutput[64] = {
    0x1c, 0x8d, 0xc4, 0x6e, 0xb0, 0x2d, 0xb7, 0x9a, 0x7c, 0x75, 0xa6,
    0x83, 0xd2, 0xf9, 0x9d, 0x1c, 0x78, 0x00, 0x64, 0x0f, 0x20, 0x68,
    0x15, 0x89, 0x51, 0x73, 0xca, 0x74, 0x02, 0xb7, 0x23, 0x87, 0x1b,
    0x9d, 0x86, 0x29, 0x1b, 0x38, 0x76, 0xfa, 0x6c, 0x81, 0xe2, 0xb7,
    0xa0, 0xe0, 0xb9, 0x06, 0x67, 0x99, 0xf9, 0xf9, 0x47, 0x82, 0xb3,
    0xe2, 0x15, 0x3c, 0xe7, 0xce, 0x54, 0x37, 0xda, 0x52,
};

static const uint8_t kTLSSecret[32] = {
    0xbf, 0xe4, 0xb7, 0xe0, 0x26, 0x55, 0x5f, 0x6a, 0xdf, 0x5d, 0x27,
    0xd6, 0x89, 0x99, 0x2a, 0xd6, 0xf7, 0x65, 0x66, 0x07, 0x4b, 0x55,
    0x5f, 0x64, 0x55, 0xcd, 0xd5, 0x77, 0xa4, 0xc7, 0x09, 0x61,
};
static const char kTLSLabel[] = "FIPS self test";
static const uint8_t kTLSSeed1[16] = {
    0x8f, 0x0d, 0xe8, 0xb6, 0x90, 0x8f, 0xb1, 0xd2,
    0x6d, 0x51, 0xf4, 0x79, 0x18, 0x63, 0x51, 0x65,
};
static const uint8_t kTLSSeed2[16] = {
    0x7d, 0x24, 0x1a, 0x9d, 0x3c, 0x59, 0xbf, 0x3c,
    0x31, 0x1e, 0x2b, 0x21, 0x41, 0x8d, 0x32, 0x81,
};

static const uint8_t kTLSOutput_md5_sha1[32] = {
    0x36, 0xa9, 0x31, 0xb0, 0x43, 0xe3, 0x64, 0x72, 0xb9, 0x47, 0x54,
    0x0d, 0x8a, 0xfc, 0xe3, 0x5c, 0x1c, 0x15, 0x67, 0x7e, 0xa3, 0x5d,
    0xf2, 0x3a, 0x57, 0xfd, 0x50, 0x16, 0xe1, 0xa4, 0xa6, 0x37,
};

static const uint8_t kTLSOutput_sha224[32] = {
    0xdd, 0xaf, 0x6f, 0xaa, 0xd9, 0x2b, 0x3d, 0xb9, 0x46, 0x4c, 0x55,
    0x8a, 0xf7, 0xa6, 0x9b, 0x0b, 0x35, 0xcc, 0x07, 0xa7, 0x55, 0x5b,
    0x5e, 0x39, 0x12, 0xc0, 0xd4, 0x30, 0xdf, 0x0c, 0xdf, 0x6b,
};

static const uint8_t kTLSOutput_sha256[32] = {
    0x67, 0x85, 0xde, 0x60, 0xfc, 0x0a, 0x83, 0xe9, 0xa2, 0x2a, 0xb3,
    0xf0, 0x27, 0x0c, 0xba, 0xf7, 0xfa, 0x82, 0x3d, 0x14, 0x77, 0x1d,
    0x86, 0x29, 0x79, 0x39, 0x77, 0x8a, 0xd5, 0x0e, 0x9d, 0x32,
};

static const uint8_t kTLSOutput_sha384[32] = {
    0x75, 0x15, 0x3f, 0x44, 0x7a, 0xfd, 0x34, 0xed, 0x2b, 0x67, 0xbc,
    0xd8, 0x57, 0x96, 0xab, 0xff, 0xf4, 0x0c, 0x05, 0x94, 0x02, 0x23,
    0x81, 0xbf, 0x0e, 0xd2, 0xec, 0x7c, 0xe0, 0xa7, 0xc3, 0x7d,
};

static const uint8_t kTLSOutput_sha512[32] = {
    0x68, 0xb9, 0xc8, 0x4c, 0xf5, 0x51, 0xfc, 0x7a, 0x1f, 0x6c, 0xe5,
    0x43, 0x73, 0x80, 0x53, 0x7c, 0xae, 0x76, 0x55, 0x67, 0xe0, 0x79,
    0xbf, 0x3a, 0x53, 0x71, 0xb7, 0x9c, 0xb5, 0x03, 0x15, 0x3f,
};

static const uint8_t kAESGCMCiphertext_128[64 + 16] = {
    0x38, 0x71, 0xcb, 0x61, 0x70, 0x60, 0x13, 0x8b, 0x2f, 0x91, 0x09, 0x7f,
    0x83, 0x20, 0x0f, 0x1f, 0x71, 0xe2, 0x47, 0x46, 0x6f, 0x5f, 0xa8, 0xad,
    0xa8, 0xfc, 0x0a, 0xfd, 0x36, 0x65, 0x84, 0x90, 0x28, 0x2b, 0xcb, 0x4f,
    0x68, 0xae, 0x09, 0xba, 0xae, 0xdd, 0xdb, 0x91, 0xcc, 0x38, 0xb3, 0xad,
    0x10, 0x84, 0xb8, 0x45, 0x36, 0xf3, 0x96, 0xb4, 0xef, 0xba, 0xda, 0x10,
    0xf8, 0x8b, 0xf3, 0xda, 0x91, 0x1f, 0x8c, 0xd8, 0x39, 0x7b, 0x1c, 0xfd,
    0xe7, 0x99, 0x7d, 0xb7, 0x22, 0x69, 0x67, 0xbd,
};

static const uint8_t kAESGCMCiphertext_192[64 + 16] = {
    0x05, 0x63, 0x6e, 0xe4, 0xd1, 0x9f, 0xd0, 0x91, 0x18, 0xc9, 0xf8, 0xfd,
    0xc2, 0x62, 0x09, 0x05, 0x91, 0xb4, 0x92, 0x66, 0x18, 0xe7, 0x93, 0x6a,
    0xc7, 0xde, 0x81, 0x36, 0x93, 0x79, 0x45, 0x34, 0xc0, 0x6d, 0x14, 0x94,
    0x93, 0x39, 0x2b, 0x7f, 0x4f, 0x10, 0x1c, 0xa5, 0xfe, 0x3b, 0x37, 0xd7,
    0x0a, 0x98, 0xd7, 0xb5, 0xe0, 0xdc, 0xe4, 0x9f, 0x36, 0x40, 0xad, 0x03,
    0xbf, 0x53, 0xe0, 0x7c, 0x3f, 0x57, 0x4f, 0x80, 0x99, 0xe6, 0x90, 0x4e,
    0x59, 0x2e, 0xe0, 0x76, 0x53, 0x09, 0xc3, 0xd3,
};

static const uint8_t kAESGCMCiphertext_256[64 + 16] = {
    0x92, 0x5f, 0xae, 0x84, 0xe7, 0x40, 0xfa, 0x1e, 0xaf, 0x8f, 0x97, 0x0e,
    0x8e, 0xdd, 0x6a, 0x94, 0x22, 0xee, 0x4f, 0x70, 0x66, 0xbf, 0xb1, 0x99,
    0x05, 0xbd, 0xd0, 0xd7, 0x91, 0x54, 0xaf, 0xe1, 0x52, 0xc9, 0x4e, 0x55,
    0xa5, 0x23, 0x62, 0x8b, 0x23, 0x40, 0x90, 0x56, 0xe0, 0x68, 0x63, 0xe5,
    0x7e, 0x5b, 0xbe, 0x96, 0x7b, 0xc4, 0x16, 0xf9, 0xbe, 0x18, 0x06, 0x79,
    0x8f, 0x99, 0x35, 0xe3, 0x2a, 0x82, 0xb5, 0x5e, 0x8a, 0x06, 0xbe, 0x99,
    0x57, 0xb1, 0x76, 0xe1, 0xc5, 0xaa, 0x82, 0xe7,
};

static const struct AEADTestVector {
  const char *name;
  const EVP_AEAD *aead;
  const uint8_t *key;
  const int key_length;
  const uint8_t *expected_ciphertext;
  const int cipher_text_length;
  const FIPSStatus expect_approved;
  const bool test_repeat_nonce;
} kAEADTestVectors[] = {
    // Internal IV usage of AES-GCM is approved.
    {
        "AES-GCM 128-bit key internal iv test",
        EVP_aead_aes_128_gcm_randnonce(),
        kAESKey,
        sizeof(kAESKey),
        nullptr,
        0,
        FIPSStatus::APPROVED,
        false,
    },
    {
        "AES-GCM 256-bit key internal iv test",
        EVP_aead_aes_256_gcm_randnonce(),
        kAESKey_256,
        sizeof(kAESKey_256),
        nullptr,
        0,
        FIPSStatus::APPROVED,
        false,
    },
    // External IV usage of AES-GCM is not approved unless used within a TLS
    // context.
    {
        "Generic AES-GCM 128-bit key external iv test",
        EVP_aead_aes_128_gcm(),
        kAESKey,
        sizeof(kAESKey),
        kAESGCMCiphertext_128,
        sizeof(kAESGCMCiphertext_128),
        FIPSStatus::NOT_APPROVED,
        false,
    },
    {
        "Generic AES-GCM 192-bit key external iv test",
        EVP_aead_aes_192_gcm(),
        kAESKey_192,
        24,
        kAESGCMCiphertext_192,
        sizeof(kAESGCMCiphertext_192),
        FIPSStatus::NOT_APPROVED,
        false,
    },
    {
        "Generic AES-GCM 256-bit key external iv test",
        EVP_aead_aes_256_gcm(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESGCMCiphertext_256,
        sizeof(kAESGCMCiphertext_256),
        FIPSStatus::NOT_APPROVED,
        false,
    },
    // External IV usage of AEAD AES-GCM APIs specific for TLS is approved.
    {
        "TLS1.2 AES-GCM 128-bit key external iv test",
        EVP_aead_aes_128_gcm_tls12(),
        kAESKey,
        sizeof(kAESKey),
        kAESGCMCiphertext_128,
        sizeof(kAESGCMCiphertext_128),
        FIPSStatus::APPROVED,
        true,
    },
    {
        "TLS1.2 AES-GCM 256-bit key external iv test",
        EVP_aead_aes_256_gcm_tls12(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESGCMCiphertext_256,
        sizeof(kAESGCMCiphertext_256),
        FIPSStatus::APPROVED,
        true,
    },
    {
        "TLS1.3 AES-GCM 128-bit key external iv test",
        EVP_aead_aes_128_gcm_tls13(),
        kAESKey,
        sizeof(kAESKey),
        kAESGCMCiphertext_128,
        sizeof(kAESGCMCiphertext_128),
        FIPSStatus::APPROVED,
        true,
    },
    {
        "TLS1.3 AES-GCM 256-bit key external iv test",
        EVP_aead_aes_256_gcm_tls13(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESGCMCiphertext_256,
        sizeof(kAESGCMCiphertext_256),
        FIPSStatus::APPROVED,
        true,
    },
    // 128 bit keys with 32 bit tag lengths are approved for AES-CCM.
    {
        "AES-CCM 128-bit key test",
        EVP_aead_aes_128_ccm_bluetooth(),
        kAESKey,
        sizeof(kAESKey),
        kAESCCMCiphertext,
        sizeof(kAESCCMCiphertext),
        FIPSStatus::APPROVED,
        false,
    },
};

class AEADServiceIndicatorTest : public TestWithNoErrors<AEADTestVector> {};

INSTANTIATE_TEST_SUITE_P(All, AEADServiceIndicatorTest,
                         testing::ValuesIn(kAEADTestVectors));

TEST_P(AEADServiceIndicatorTest, EVP_AEAD) {
  const AEADTestVector &test = GetParam();
  SCOPED_TRACE(test.name);

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  bssl::ScopedEVP_AEAD_CTX aead_ctx;
  std::vector<uint8_t> nonce(EVP_AEAD_nonce_length(test.aead), 0);
  std::vector<uint8_t> encrypt_output(256);
  std::vector<uint8_t> decrypt_output(256);
  size_t out_len;

  // Test running the EVP_AEAD_CTX interfaces one by one directly, and check
  // |EVP_AEAD_CTX_seal| and |EVP_AEAD_CTX_open| for approval at the end.
  // |EVP_AEAD_CTX_init| should not be approved because the function does not
  // indicate that a service has been fully completed yet.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_AEAD_CTX_init(aead_ctx.get(), test.aead, test.key,
                                  test.key_length, 0, nullptr)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_AEAD_CTX_seal(aead_ctx.get(), encrypt_output.data(),
                                  &out_len, encrypt_output.size(), nonce.data(),
                                  EVP_AEAD_nonce_length(test.aead), kPlaintext,
                                  sizeof(kPlaintext), nullptr, 0)));
  EXPECT_EQ(approved, test.expect_approved);
  encrypt_output.resize(out_len);
  if (test.expected_ciphertext) {
    EXPECT_EQ(Bytes(test.expected_ciphertext, test.cipher_text_length),
              Bytes(encrypt_output));
  }

  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_AEAD_CTX_open(aead_ctx.get(), decrypt_output.data(), &out_len,
                        decrypt_output.size(), nonce.data(), nonce.size(),
                        encrypt_output.data(), out_len, nullptr, 0)));
  // Decryption doesn't have nonce uniqueness requirements and so is always
  // approved for approved key lengths.
  EXPECT_EQ(approved, test.key_length != 24 ? FIPSStatus::APPROVED
                                            : FIPSStatus::NOT_APPROVED);
  decrypt_output.resize(out_len);
  EXPECT_EQ(Bytes(kPlaintext), Bytes(decrypt_output));

  // Second call when encrypting using the same nonce for AES-GCM TLS specific
  // functions should fail and return |FIPSStatus::NOT_APPROVED|.
  if (test.test_repeat_nonce) {
    ASSERT_FALSE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        EVP_AEAD_CTX_seal(aead_ctx.get(), encrypt_output.data(), &out_len,
                          encrypt_output.size(), nonce.data(), nonce.size(),
                          kPlaintext, sizeof(kPlaintext), nullptr, 0)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
    EXPECT_TRUE(
        ErrorEquals(ERR_get_error(), ERR_LIB_CIPHER, CIPHER_R_INVALID_NONCE));
  }
}

static const struct CipherTestVector {
  const EVP_CIPHER *cipher;
  const uint8_t *key;
  const int key_length;
  const uint8_t *expected_ciphertext;
  const int cipher_text_length;
  const bool has_iv;
  const FIPSStatus expect_approved;
} kTestVectors[] = {
    {
        EVP_aes_128_ecb(),
        kAESKey,
        sizeof(kAESKey),
        kAESECBCiphertext,
        sizeof(kAESECBCiphertext),
        false,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_192_ecb(),
        kAESKey_192,
        sizeof(kAESKey_192),
        kAESECBCiphertext_192,
        sizeof(kAESECBCiphertext_192),
        false,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_256_ecb(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESECBCiphertext_256,
        sizeof(kAESECBCiphertext_256),
        false,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_128_cbc(),
        kAESKey,
        sizeof(kAESKey),
        kAESCBCCiphertext,
        sizeof(kAESCBCCiphertext),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_192_cbc(),
        kAESKey_192,
        sizeof(kAESKey_192),
        kAESCBCCiphertext_192,
        sizeof(kAESCBCCiphertext_192),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_256_cbc(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESCBCCiphertext_256,
        sizeof(kAESCBCCiphertext_256),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_128_ctr(),
        kAESKey,
        sizeof(kAESKey),
        kAESCTRCiphertext,
        sizeof(kAESCTRCiphertext),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_192_ctr(),
        kAESKey_192,
        sizeof(kAESKey_192),
        kAESCTRCiphertext_192,
        sizeof(kAESCTRCiphertext_192),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_256_ctr(),
        kAESKey_256,
        sizeof(kAESKey_256),
        kAESCTRCiphertext_256,
        sizeof(kAESCTRCiphertext_256),
        true,
        FIPSStatus::APPROVED,
    },
    {
        EVP_aes_128_ofb(),
        kAESKey,
        sizeof(kAESKey),
        kAESOFBCiphertext,
        sizeof(kAESOFBCiphertext),
        true,
        FIPSStatus::NOT_APPROVED,
    },
    {
        EVP_des_ede3(),
        kAESKey_192,
        sizeof(kAESKey_192),
        kTDES_EDE3_CipherText,
        sizeof(kTDES_EDE3_CipherText),
        false,
        FIPSStatus::NOT_APPROVED,
    },
    {
        EVP_des_ede3_cbc(),
        kAESKey_192,
        sizeof(kAESKey_192),
        kTDES_EDE3_CBCCipherText,
        sizeof(kTDES_EDE3_CBCCipherText),
        false,
        FIPSStatus::NOT_APPROVED,
    },
};

class EVPServiceIndicatorTest : public TestWithNoErrors<CipherTestVector> {};

static void TestOperation(const EVP_CIPHER *cipher, bool encrypt,
                          const bssl::Span<const uint8_t> key,
                          const bssl::Span<const uint8_t> plaintext,
                          const bssl::Span<const uint8_t> ciphertext,
                          FIPSStatus expect_approved) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  bssl::Span<const uint8_t> in, out;
  if (encrypt) {
    in = plaintext;
    out = ciphertext;
  } else {
    in = ciphertext;
    out = plaintext;
  }

  bssl::ScopedEVP_CIPHER_CTX ctx;
  // Test running the EVP_Cipher interfaces one by one directly, and check
  // |EVP_EncryptFinal_ex| and |EVP_DecryptFinal_ex| for approval at the end.
  ASSERT_TRUE(EVP_CipherInit_ex(ctx.get(), cipher, nullptr, nullptr, nullptr,
                                encrypt ? 1 : 0));
  ASSERT_LE(EVP_CIPHER_CTX_iv_length(ctx.get()), sizeof(kAESIV));

  ASSERT_TRUE(EVP_CIPHER_CTX_set_key_length(ctx.get(), key.size()));
  ASSERT_TRUE(EVP_CipherInit_ex(ctx.get(), cipher, nullptr, key.data(), kAESIV,
                                encrypt ? 1 : 0));
  ASSERT_TRUE(EVP_CIPHER_CTX_set_padding(ctx.get(), 0));
  std::vector<uint8_t> encrypt_result;
  DoCipherFinal(ctx.get(), &encrypt_result, in, expect_approved);
  EXPECT_EQ(Bytes(out), Bytes(encrypt_result));

  // Test using the one-shot |EVP_Cipher| function for approval.
  bssl::ScopedEVP_CIPHER_CTX ctx2;
  uint8_t output[256];
  ASSERT_TRUE(EVP_CipherInit_ex(ctx2.get(), cipher, nullptr, key.data(), kAESIV,
                                encrypt ? 1 : 0));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_Cipher(ctx2.get(), output, in.data(), in.size()));
  EXPECT_EQ(approved, expect_approved);
  EXPECT_EQ(Bytes(out), Bytes(output, in.size()));
}

INSTANTIATE_TEST_SUITE_P(All, EVPServiceIndicatorTest,
                         testing::ValuesIn(kTestVectors));

TEST_P(EVPServiceIndicatorTest, EVP_Ciphers) {
  const CipherTestVector &test = GetParam();

  const EVP_CIPHER *cipher = test.cipher;
  std::vector<uint8_t> key(test.key, test.key + test.key_length);
  std::vector<uint8_t> plaintext(kPlaintext, kPlaintext + sizeof(kPlaintext));
  std::vector<uint8_t> ciphertext(
      test.expected_ciphertext,
      test.expected_ciphertext + test.cipher_text_length);

  TestOperation(cipher, true /* encrypt */, key, plaintext, ciphertext,
                test.expect_approved);
  TestOperation(cipher, false /* decrypt */, key, plaintext, ciphertext,
                test.expect_approved);
}

static const struct DigestTestVector {
  // name is the name of the digest test.
  const char *name;
  // length of digest.
  const int length;
  // func is the digest to test.
  const EVP_MD *(*func)();
  // one_shot_func is the convenience one-shot version of the digest.
  uint8_t *(*one_shot_func)(const uint8_t *, size_t, uint8_t *);
  // expected_digest is the expected digest.
  const uint8_t *expected_digest;
  // expected to be approved or not.
  const FIPSStatus expect_approved;
} kDigestTestVectors[] = {
    {
        "MD4",
        MD4_DIGEST_LENGTH,
        &EVP_md4,
        &MD4,
        kOutput_md4,
        FIPSStatus::NOT_APPROVED,
    },
    {
        "MD5",
        MD5_DIGEST_LENGTH,
        &EVP_md5,
        &MD5,
        kOutput_md5,
        FIPSStatus::NOT_APPROVED,
    },
    {
        "SHA-1",
        SHA_DIGEST_LENGTH,
        &EVP_sha1,
        &SHA1,
        kOutput_sha1,
        FIPSStatus::APPROVED,
    },
    {
        "SHA-224",
        SHA224_DIGEST_LENGTH,
        &EVP_sha224,
        &SHA224,
        kOutput_sha224,
        FIPSStatus::APPROVED,
    },
    {
        "SHA-256",
        SHA256_DIGEST_LENGTH,
        &EVP_sha256,
        &SHA256,
        kOutput_sha256,
        FIPSStatus::APPROVED,
    },
    {
        "SHA-384",
        SHA384_DIGEST_LENGTH,
        &EVP_sha384,
        &SHA384,
        kOutput_sha384,
        FIPSStatus::APPROVED,
    },
    {
        "SHA-512",
        SHA512_DIGEST_LENGTH,
        &EVP_sha512,
        &SHA512,
        kOutput_sha512,
        FIPSStatus::APPROVED,
    },
    {
        "SHA-512/256",
        SHA512_256_DIGEST_LENGTH,
        &EVP_sha512_256,
        &SHA512_256,
        kOutput_sha512_256,
        FIPSStatus::APPROVED,
    },
};

class EVPMDServiceIndicatorTest : public TestWithNoErrors<DigestTestVector> {};

INSTANTIATE_TEST_SUITE_P(All, EVPMDServiceIndicatorTest,
                         testing::ValuesIn(kDigestTestVectors));

TEST_P(EVPMDServiceIndicatorTest, EVP_Digests) {
  const DigestTestVector &test = GetParam();
  SCOPED_TRACE(test.name);

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  bssl::ScopedEVP_MD_CTX ctx;
  std::vector<uint8_t> digest(test.length);
  unsigned digest_len;

  // Test running the EVP_Digest interfaces one by one directly, and check
  // |EVP_DigestFinal_ex| for approval at the end. |EVP_DigestInit_ex| and
  // |EVP_DigestUpdate| should not be approved, because the functions do not
  // indicate that a service has been fully completed yet.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestInit_ex(ctx.get(), test.func(), nullptr)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestUpdate(ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestFinal_ex(ctx.get(), digest.data(), &digest_len)));
  EXPECT_EQ(approved, test.expect_approved);
  EXPECT_EQ(Bytes(test.expected_digest, digest_len), Bytes(digest));

  // Test using the one-shot |EVP_Digest| function for approval.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_Digest(kPlaintext, sizeof(kPlaintext), digest.data(),
                           &digest_len, test.func(), nullptr)));
  EXPECT_EQ(approved, test.expect_approved);
  EXPECT_EQ(Bytes(test.expected_digest, test.length), Bytes(digest));

  // Test using the one-shot API for approval.
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      test.one_shot_func(kPlaintext, sizeof(kPlaintext), digest.data()));
  EXPECT_EQ(approved, test.expect_approved);
  EXPECT_EQ(Bytes(test.expected_digest, test.length), Bytes(digest));
}

static const struct HMACTestVector {
  // func is the hash function for HMAC to test.
  const EVP_MD *(*func)(void);
  // expected_digest is the expected digest.
  const uint8_t *expected_digest;
  // expected to be approved or not.
  const FIPSStatus expect_approved;
} kHMACTestVectors[] = {
    {EVP_sha1, kHMACOutput_sha1, FIPSStatus::APPROVED},
    {EVP_sha224, kHMACOutput_sha224, FIPSStatus::APPROVED},
    {EVP_sha256, kHMACOutput_sha256, FIPSStatus::APPROVED},
    {EVP_sha384, kHMACOutput_sha384, FIPSStatus::APPROVED},
    {EVP_sha512, kHMACOutput_sha512, FIPSStatus::APPROVED},
    {EVP_sha512_256, kHMACOutput_sha512_256, FIPSStatus::APPROVED},
};

class HMACServiceIndicatorTest : public TestWithNoErrors<HMACTestVector> {};

INSTANTIATE_TEST_SUITE_P(All, HMACServiceIndicatorTest,
                         testing::ValuesIn(kHMACTestVectors));

TEST_P(HMACServiceIndicatorTest, HMACTest) {
  const HMACTestVector &test = GetParam();

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  // The key is deliberately long in order to trigger digesting it down to a
  // block size. This tests that doing so does not cause the indicator to be
  // mistakenly set in |HMAC_Init_ex|.
  const uint8_t kHMACKey[512] = {0};
  const EVP_MD *const digest = test.func();
  const unsigned expected_mac_len = EVP_MD_size(digest);
  std::vector<uint8_t> mac(expected_mac_len);

  // Test running the HMAC interfaces one by one directly, and check
  // |HMAC_Final| for approval at the end. |HMAC_Init_ex| and |HMAC_Update|
  // should not be approved, because the functions do not indicate that a
  // service has been fully completed yet.
  unsigned mac_len;
  bssl::ScopedHMAC_CTX ctx;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      HMAC_Init_ex(ctx.get(), kHMACKey, sizeof(kHMACKey), digest, nullptr)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, HMAC_Update(ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, HMAC_Final(ctx.get(), mac.data(), &mac_len)));
  EXPECT_EQ(approved, test.expect_approved);
  EXPECT_EQ(Bytes(test.expected_digest, expected_mac_len),
            Bytes(mac.data(), mac_len));

  // Test using the one-shot API for approval.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, HMAC(digest, kHMACKey, sizeof(kHMACKey), kPlaintext,
                     sizeof(kPlaintext), mac.data(), &mac_len)));
  EXPECT_EQ(approved, test.expect_approved);
  EXPECT_EQ(Bytes(test.expected_digest, expected_mac_len),
            Bytes(mac.data(), mac_len));
}

// RSA tests are not parameterized with the |kRSATestVectors| as key
// generation for RSA is time consuming.
TEST(ServiceIndicatorTest, RSAKeyGen) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  bssl::UniquePtr<RSA> rsa(RSA_new());
  ASSERT_TRUE(rsa);

  // |RSA_generate_key_fips| may only be used for 2048-, 3072-, and 4096-bit
  // keys.
  for (const size_t bits : {512, 1024, 3071, 4095}) {
    SCOPED_TRACE(bits);

    rsa.reset(RSA_new());
    EXPECT_FALSE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, RSA_generate_key_fips(rsa.get(), bits, nullptr)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  }

  // Test that we can generate keys of the supported lengths:
  for (const size_t bits : {2048, 3072, 4096}) {
    SCOPED_TRACE(bits);

    rsa.reset(RSA_new());
    EXPECT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, RSA_generate_key_fips(rsa.get(), bits, nullptr)));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
    EXPECT_EQ(bits, RSA_bits(rsa.get()));
  }

  // Test running the EVP_PKEY_keygen interfaces one by one directly, and check
  // |EVP_PKEY_keygen| for approval at the end. |EVP_PKEY_keygen_init| should
  // not be approved because it does not indicate an entire service has been
  // completed.
  bssl::UniquePtr<EVP_PKEY_CTX> ctx(EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr));
  EVP_PKEY *raw = nullptr;
  bssl::UniquePtr<EVP_PKEY> pkey(raw);
  ASSERT_TRUE(ctx);

  if (kEVPKeyGenShouldCallFIPSFunctions) {
    // Test unapproved key sizes of RSA.
    for (const size_t bits : {512, 1024, 3071, 4095}) {
      SCOPED_TRACE(bits);
      ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
          approved, EVP_PKEY_keygen_init(ctx.get())));
      EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
      ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_keygen_bits(ctx.get(), bits));
      ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
          approved, EVP_PKEY_keygen(ctx.get(), &raw)));
      EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
      pkey.reset(raw);
      raw = nullptr;
    }

    // Test approved key sizes of RSA.
    for (const size_t bits : {2048, 3072, 4096}) {
      SCOPED_TRACE(bits);
      ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
          approved, EVP_PKEY_keygen_init(ctx.get())));
      EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
      ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_keygen_bits(ctx.get(), bits));
      ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
          approved, EVP_PKEY_keygen(ctx.get(), &raw)));
      EXPECT_EQ(approved, FIPSStatus::APPROVED);
      pkey.reset(raw);
      raw = nullptr;
    }
  }
}

struct RSATestVector {
  // key_size is the input rsa key size.
  int key_size;
  // md_func is the digest to test.
  const EVP_MD *(*func)();
  // whether to use pss testing or not.
  bool use_pss;
  // expected to be approved or not for signature generation.
  FIPSStatus sig_gen_expect_approved;
  // expected to be approved or not for signature verification.
  FIPSStatus sig_ver_expect_approved;
};

static const struct RSATestVector kRSATestVectors[] = {
    // RSA test cases that are not approved in any case.
    {512, &EVP_sha1, false, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    // PSS with hashLen == saltLen is not possible for 512-bit modulus.
    {1024, &EVP_md5, false, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {1536, &EVP_sha256, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {1536, &EVP_sha512, true, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {2048, &EVP_md5, false, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {3071, &EVP_md5, true, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {3071, &EVP_sha256, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {3071, &EVP_sha512, true, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {4096, &EVP_md5, false, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},

    // RSA 1024 is not approved under FIPS 186-5.
    {1024, &EVP_sha1, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {1024, &EVP_sha256, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {1024, &EVP_sha512, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {1024, &EVP_sha1, true, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {1024, &EVP_sha256, true, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    // PSS with hashLen == saltLen is not possible for 1024-bit modulus and
    // SHA-512.

    {2048, &EVP_sha1, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {2048, &EVP_sha224, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha256, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha384, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha512, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha1, true, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {2048, &EVP_sha224, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha256, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha384, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {2048, &EVP_sha512, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},

    {3072, &EVP_sha1, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {3072, &EVP_sha224, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha256, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha384, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha512, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha1, true, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {3072, &EVP_sha224, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha256, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha384, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {3072, &EVP_sha512, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},

    {4096, &EVP_sha1, false, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {4096, &EVP_sha224, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha256, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha384, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha512, false, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha1, true, FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {4096, &EVP_sha224, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha256, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha384, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {4096, &EVP_sha512, true, FIPSStatus::APPROVED, FIPSStatus::APPROVED},
};

class RSAServiceIndicatorTest : public TestWithNoErrors<RSATestVector> {};

INSTANTIATE_TEST_SUITE_P(All, RSAServiceIndicatorTest,
                         testing::ValuesIn(kRSATestVectors));

static std::map<unsigned, bssl::UniquePtr<RSA>> &CachedRSAKeys() {
  static std::map<unsigned, bssl::UniquePtr<RSA>> keys;
  return keys;
}

static RSA *GetRSAKey(unsigned bits) {
  auto it = CachedRSAKeys().find(bits);
  if (it != CachedRSAKeys().end()) {
    return it->second.get();
  }

  bssl::UniquePtr<BIGNUM> e(BN_new());
  if (!e || !BN_set_word(e.get(), RSA_F4)) {
    abort();
  }

  bssl::UniquePtr<RSA> key(RSA_new());
  if (!key || !RSA_generate_key_ex(key.get(), bits, e.get(), nullptr)) {
    abort();
  }

  RSA *const ret = key.get();
  CachedRSAKeys().emplace(static_cast<unsigned>(bits), std::move(key));

  return ret;
}

TEST_P(RSAServiceIndicatorTest, RSASigGen) {
  const RSATestVector &test = GetParam();
  SCOPED_TRACE(test.key_size);

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  ASSERT_TRUE(pkey);

  RSA *const rsa = GetRSAKey(test.key_size);
  ASSERT_TRUE(EVP_PKEY_set1_RSA(pkey.get(), rsa));

  // Test running the EVP_DigestSign interfaces one by one directly, and check
  // |EVP_DigestSignFinal| for approval at the end. |EVP_DigestSignInit|, and
  // |EVP_DigestSignUpdate| should not be approved because they do not indicate
  // an entire service has been completed.
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  bssl::ScopedEVP_MD_CTX md_ctx;
  EVP_PKEY_CTX *pctx = nullptr;
  size_t sig_len;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                   pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  if (test.use_pss) {
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  }
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestSignUpdate(md_ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  // Determine the size of the signature. The first call of
  // |EVP_DigestSignFinal| should not return an approval check because no crypto
  // is being done when |nullptr| is inputted in the |*out_sig| field.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignFinal(md_ctx.get(), nullptr, &sig_len)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  std::vector<uint8_t> signature(sig_len);
  // The second call performs the actual operation.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignFinal(md_ctx.get(), signature.data(), &sig_len)));
  EXPECT_EQ(approved, test.sig_gen_expect_approved);

  // Test using the one-shot |EVP_DigestSign| function for approval.
  md_ctx.Reset();
  std::vector<uint8_t> oneshot_output(sig_len);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                   pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  if (test.use_pss) {
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  }
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSign(md_ctx.get(), oneshot_output.data(), &sig_len,
                               kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, test.sig_gen_expect_approved);

  if (test.use_pss) {
    // Odd configurations of PSS, for example where the salt length is not equal
    // to the hash length, are not approved.
    md_ctx.Reset();
    ASSERT_TRUE(EVP_DigestSignInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                   pkey.get()));
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING));
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, 10));
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_DigestSign(md_ctx.get(), oneshot_output.data(), &sig_len,
                                 kPlaintext, sizeof(kPlaintext))));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  }
}

TEST_P(RSAServiceIndicatorTest, RSASigVer) {
  const RSATestVector &test = GetParam();

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  RSA *const rsa = GetRSAKey(test.key_size);

  ASSERT_TRUE(pkey);
  ASSERT_TRUE(EVP_PKEY_set1_RSA(pkey.get(), rsa));

  std::vector<uint8_t> signature;
  size_t sig_len;
  bssl::ScopedEVP_MD_CTX md_ctx;
  EVP_PKEY_CTX *pctx = nullptr;
  ASSERT_TRUE(EVP_DigestSignInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                 pkey.get()));
  if (test.use_pss) {
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING));
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST));
  }
  ASSERT_TRUE(EVP_DigestSign(md_ctx.get(), nullptr, &sig_len, nullptr, 0));
  signature.resize(sig_len);
  ASSERT_TRUE(EVP_DigestSign(md_ctx.get(), signature.data(), &sig_len,
                             kPlaintext, sizeof(kPlaintext)));
  signature.resize(sig_len);

  // Service Indicator approval checks for RSA signature verification.

  // Test running the EVP_DigestVerify interfaces one by one directly, and check
  // |EVP_DigestVerifyFinal| for approval at the end. |EVP_DigestVerifyInit|,
  // |EVP_DigestVerifyUpdate| should not be approved because they do not
  // indicate an entire service has been done.
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  md_ctx.Reset();
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestVerifyInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                     pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  if (test.use_pss) {
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST));
  }
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerifyUpdate(md_ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerifyFinal(md_ctx.get(), signature.data(), signature.size())));
  EXPECT_EQ(approved, test.sig_ver_expect_approved);

  // Test using the one-shot |EVP_DigestVerify| function for approval.
  md_ctx.Reset();
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestVerifyInit(md_ctx.get(), &pctx, test.func(), nullptr,
                                     pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  if (test.use_pss) {
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING)));
    EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST));
  }
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerify(md_ctx.get(), signature.data(), signature.size(),
                       kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, test.sig_ver_expect_approved);
}

struct ECDSATestVector {
  // nid is the input curve nid.
  int nid;
  // md_func is the digest to test.
  const EVP_MD *(*func)();
  // expected to be approved or not for key generation.
  FIPSStatus key_check_expect_approved;
  // expected to be approved or not for signature generation.
  FIPSStatus sig_gen_expect_approved;
  // expected to be approved or not for signature verification.
  FIPSStatus sig_ver_expect_approved;
};

static const struct ECDSATestVector kECDSATestVectors[] = {
    // Only the following NIDs for |EC_GROUP| are creatable with
    // |EC_GROUP_new_by_curve_name|, and |NID_secp256k1| will only work if
    // |kCurveSecp256k1Supported| is true.
    {NID_secp224r1, &EVP_sha1, FIPSStatus::APPROVED, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {NID_secp224r1, &EVP_sha224, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp224r1, &EVP_sha256, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp224r1, &EVP_sha384, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp224r1, &EVP_sha512, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},

    {NID_X9_62_prime256v1, &EVP_sha1, FIPSStatus::APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {NID_X9_62_prime256v1, &EVP_sha224, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, &EVP_sha256, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, &EVP_sha384, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, &EVP_sha512, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED, FIPSStatus::APPROVED},

    {NID_secp384r1, &EVP_sha1, FIPSStatus::APPROVED, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {NID_secp384r1, &EVP_sha224, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp384r1, &EVP_sha256, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp384r1, &EVP_sha384, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp384r1, &EVP_sha512, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},

    {NID_secp521r1, &EVP_sha1, FIPSStatus::APPROVED, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED},
    {NID_secp521r1, &EVP_sha224, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp521r1, &EVP_sha256, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp521r1, &EVP_sha384, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},
    {NID_secp521r1, &EVP_sha512, FIPSStatus::APPROVED, FIPSStatus::APPROVED,
     FIPSStatus::APPROVED},

    {NID_secp256k1, &EVP_sha1, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, &EVP_sha224, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, &EVP_sha256, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, &EVP_sha384, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, &EVP_sha512, FIPSStatus::NOT_APPROVED,
     FIPSStatus::NOT_APPROVED, FIPSStatus::NOT_APPROVED},
};

class ECDSAServiceIndicatorTest : public TestWithNoErrors<ECDSATestVector> {};

INSTANTIATE_TEST_SUITE_P(All, ECDSAServiceIndicatorTest,
                         testing::ValuesIn(kECDSATestVectors));

TEST_P(ECDSAServiceIndicatorTest, ECDSAKeyCheck) {
  const ECDSATestVector &test = GetParam();
  if (test.nid == NID_secp256k1 && !kCurveSecp256k1Supported) {
    GTEST_SKIP();
  }

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  // Test service indicator approval for |EC_KEY_generate_key_fips| and
  // |EC_KEY_check_fips|.
  bssl::UniquePtr<EC_KEY> key(EC_KEY_new_by_curve_name(test.nid));
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EC_KEY_generate_key_fips(key.get())));
  EXPECT_EQ(approved, test.key_check_expect_approved);
  ASSERT_TRUE(
      CALL_SERVICE_AND_CHECK_APPROVED(approved, EC_KEY_check_fips(key.get())));
  EXPECT_EQ(approved, test.key_check_expect_approved);

  // See if |EC_KEY_check_fips| still returns approval with only the public
  // component.
  bssl::UniquePtr<EC_KEY> key_only_public(EC_KEY_new_by_curve_name(test.nid));
  ASSERT_TRUE(EC_KEY_set_public_key(key_only_public.get(),
                                    EC_KEY_get0_public_key(key.get())));
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EC_KEY_check_fips(key_only_public.get())));
  EXPECT_EQ(approved, test.key_check_expect_approved);

  if (kEVPKeyGenShouldCallFIPSFunctions) {
    // Test running the EVP_PKEY_keygen interfaces one by one directly, and
    // check |EVP_PKEY_keygen| for approval at the end. |EVP_PKEY_keygen_init|
    // should not be approved because it does not indicate that an entire
    // service has been completed.
    bssl::UniquePtr<EVP_PKEY_CTX> ctx(
        EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr));
    EVP_PKEY *raw = nullptr;
    ASSERT_TRUE(ctx);
    ASSERT_TRUE(EVP_PKEY_keygen_init(ctx.get()));
    ASSERT_TRUE(EVP_PKEY_CTX_set_ec_paramgen_curve_nid(ctx.get(), test.nid));
    ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
        approved, EVP_PKEY_keygen(ctx.get(), &raw)));
    EXPECT_EQ(approved, test.key_check_expect_approved);

    EVP_PKEY_free(raw);
  }
}

TEST_P(ECDSAServiceIndicatorTest, ECDSASigGen) {
  const ECDSATestVector &test = GetParam();
  if (test.nid == NID_secp256k1 && !kCurveSecp256k1Supported) {
    GTEST_SKIP();
  }

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  const EC_GROUP *group = EC_GROUP_new_by_curve_name(test.nid);
  bssl::UniquePtr<EC_KEY> eckey(EC_KEY_new());
  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  bssl::ScopedEVP_MD_CTX md_ctx;
  ASSERT_TRUE(eckey);
  ASSERT_TRUE(EC_KEY_set_group(eckey.get(), group));

  // Generate a generic EC key.
  ASSERT_TRUE(EC_KEY_generate_key(eckey.get()));
  ASSERT_TRUE(EVP_PKEY_set1_EC_KEY(pkey.get(), eckey.get()));

  // Test running the EVP_DigestSign interfaces one by one directly, and check
  // |EVP_DigestSignFinal| for approval at the end. |EVP_DigestSignInit|,
  // |EVP_DigestSignUpdate| should not be approved because they do not indicate
  // an entire service has been done.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignInit(md_ctx.get(), nullptr, test.func(), nullptr,
                                   pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestSignUpdate(md_ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  // Determine the size of the signature. The first call of
  // |EVP_DigestSignFinal| should not return an approval check because no crypto
  // is being done when |nullptr| is given as the |out_sig| field.
  size_t max_sig_len;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignFinal(md_ctx.get(), nullptr, &max_sig_len)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  std::vector<uint8_t> signature(max_sig_len);
  // The second call performs the actual operation.
  size_t sig_len = max_sig_len;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignFinal(md_ctx.get(), signature.data(), &sig_len)));
  ASSERT_LE(sig_len, signature.size());
  EXPECT_EQ(approved, test.sig_gen_expect_approved);

  // Test using the one-shot |EVP_DigestSign| function for approval.
  md_ctx.Reset();
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSignInit(md_ctx.get(), nullptr, test.func(), nullptr,
                                   pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  sig_len = max_sig_len;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestSign(md_ctx.get(), signature.data(), &sig_len,
                               kPlaintext, sizeof(kPlaintext))));
  ASSERT_LE(sig_len, signature.size());
  EXPECT_EQ(approved, test.sig_gen_expect_approved);
}

TEST_P(ECDSAServiceIndicatorTest, ECDSASigVer) {
  const ECDSATestVector &test = GetParam();
  if (test.nid == NID_secp256k1 && !kCurveSecp256k1Supported) {
    GTEST_SKIP();
  }

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  const EC_GROUP *group = EC_GROUP_new_by_curve_name(test.nid);
  bssl::UniquePtr<EC_KEY> eckey(EC_KEY_new());
  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  bssl::ScopedEVP_MD_CTX md_ctx;
  ASSERT_TRUE(eckey);
  ASSERT_TRUE(EC_KEY_set_group(eckey.get(), group));

  // Generate ECDSA signatures for ECDSA verification.
  ASSERT_TRUE(EC_KEY_generate_key(eckey.get()));
  ASSERT_TRUE(EVP_PKEY_set1_EC_KEY(pkey.get(), eckey.get()));
  std::vector<uint8_t> signature;
  size_t sig_len = 0;
  ASSERT_TRUE(EVP_DigestSignInit(md_ctx.get(), nullptr, test.func(), nullptr,
                                 pkey.get()));
  ASSERT_TRUE(EVP_DigestSignFinal(md_ctx.get(), nullptr, &sig_len));
  signature.resize(sig_len);
  ASSERT_TRUE(EVP_DigestSign(md_ctx.get(), signature.data(), &sig_len,
                             kPlaintext, sizeof(kPlaintext)));
  signature.resize(sig_len);

  // Service Indicator approval checks for ECDSA signature verification.

  // Test running the EVP_DigestVerify interfaces one by one directly, and check
  // |EVP_DigestVerifyFinal| for approval at the end. |EVP_DigestVerifyInit|,
  // |EVP_DigestVerifyUpdate| should not be approved because they do not
  // indicate an entire service has been done.
  md_ctx.Reset();
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestVerifyInit(md_ctx.get(), nullptr, test.func(),
                                     nullptr, pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerifyUpdate(md_ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerifyFinal(md_ctx.get(), signature.data(), signature.size())));
  EXPECT_EQ(approved, test.sig_ver_expect_approved);

  // Test using the one-shot |EVP_DigestVerify| function for approval.
  md_ctx.Reset();
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_DigestVerifyInit(md_ctx.get(), nullptr, test.func(),
                                     nullptr, pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_DigestVerify(md_ctx.get(), signature.data(), signature.size(),
                       kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, test.sig_ver_expect_approved);
}

#if defined(AWSLC_FIPS)

// Test that |EVP_DigestSignFinal| and |EVP_DigestSignVerify| are approved with
// manually constructing using the context setting functions.
TEST_P(ECDSAServiceIndicatorTest, ManualECDSASignVerify) {
  const ECDSATestVector &test = GetParam();

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  bssl::ScopedEVP_MD_CTX ctx;
  ASSERT_TRUE(EVP_DigestInit(ctx.get(), test.func()));
  ASSERT_TRUE(EVP_DigestUpdate(ctx.get(), kPlaintext, sizeof(kPlaintext)));

  const EC_GROUP *group = EC_GROUP_new_by_curve_name(test.nid);
  bssl::UniquePtr<EC_KEY> eckey(EC_KEY_new());
  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  bssl::ScopedEVP_MD_CTX md_ctx;
  ASSERT_TRUE(eckey);
  ASSERT_TRUE(EC_KEY_set_group(eckey.get(), group));

  // Generate a generic ec key.
  EC_KEY_generate_key(eckey.get());
  ASSERT_TRUE(EVP_PKEY_set1_EC_KEY(pkey.get(), eckey.get()));

  // Manual construction for signing.
  bssl::UniquePtr<EVP_PKEY_CTX> pctx(EVP_PKEY_CTX_new(pkey.get(), nullptr));
  ASSERT_TRUE(EVP_PKEY_sign_init(pctx.get()));
  ASSERT_TRUE(EVP_PKEY_CTX_set_signature_md(pctx.get(), test.func()));
  EVP_MD_CTX_set_pkey_ctx(ctx.get(), pctx.get());
  // Determine the size of the signature.
  size_t sig_len = 0;
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, ASSERT_TRUE(EVP_DigestSignFinal(ctx.get(), nullptr, &sig_len)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  std::vector<uint8_t> sig;
  sig.resize(sig_len);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      ASSERT_TRUE(EVP_DigestSignFinal(ctx.get(), sig.data(), &sig_len)));
  EXPECT_EQ(approved, test.sig_gen_expect_approved);
  sig.resize(sig_len);

  // Manual construction for verification.
  ASSERT_TRUE(EVP_PKEY_verify_init(pctx.get()));
  ASSERT_TRUE(EVP_PKEY_CTX_set_signature_md(pctx.get(), test.func()));
  EVP_MD_CTX_set_pkey_ctx(ctx.get(), pctx.get());

  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      ASSERT_TRUE(EVP_DigestVerifyFinal(ctx.get(), sig.data(), sig_len)));
  EXPECT_EQ(approved, test.sig_ver_expect_approved);
}

#endif  // AWSLC_FIPS

struct ECDHTestVector {
  // nid is the input curve nid.
  const int nid;
  // digest_length is the length of the hash output to test with.
  const int digest_length;
  // expect_approved to be approved or not.
  const FIPSStatus expect_approved;
};

static const struct ECDHTestVector kECDHTestVectors[] = {
    // Only the following NIDs for |EC_GROUP| are creatable with
    // |EC_GROUP_new_by_curve_name|.
    // |ECDH_compute_key_fips| fails directly when an invalid hash length is
    // inputted.
    {NID_secp224r1, SHA224_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp224r1, SHA256_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp224r1, SHA384_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp224r1, SHA512_DIGEST_LENGTH, FIPSStatus::APPROVED},

    {NID_X9_62_prime256v1, SHA224_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, SHA256_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, SHA384_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_X9_62_prime256v1, SHA512_DIGEST_LENGTH, FIPSStatus::APPROVED},

    {NID_secp384r1, SHA224_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp384r1, SHA256_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp384r1, SHA384_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp384r1, SHA512_DIGEST_LENGTH, FIPSStatus::APPROVED},

    {NID_secp521r1, SHA224_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp521r1, SHA256_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp521r1, SHA384_DIGEST_LENGTH, FIPSStatus::APPROVED},
    {NID_secp521r1, SHA512_DIGEST_LENGTH, FIPSStatus::APPROVED},

    {NID_secp256k1, SHA224_DIGEST_LENGTH, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, SHA256_DIGEST_LENGTH, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, SHA384_DIGEST_LENGTH, FIPSStatus::NOT_APPROVED},
    {NID_secp256k1, SHA512_DIGEST_LENGTH, FIPSStatus::NOT_APPROVED},
};

class ECDH_ServiceIndicatorTest : public TestWithNoErrors<ECDHTestVector> {};

INSTANTIATE_TEST_SUITE_P(All, ECDH_ServiceIndicatorTest,
                         testing::ValuesIn(kECDHTestVectors));

TEST_P(ECDH_ServiceIndicatorTest, ECDH) {
  const ECDHTestVector &test = GetParam();
  if (test.nid == NID_secp256k1 && !kCurveSecp256k1Supported) {
    GTEST_SKIP();
  }

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  const EC_GROUP *group = EC_GROUP_new_by_curve_name(test.nid);
  bssl::UniquePtr<EC_KEY> our_key(EC_KEY_new());
  bssl::UniquePtr<EC_KEY> peer_key(EC_KEY_new());
  bssl::ScopedEVP_MD_CTX md_ctx;
  ASSERT_TRUE(our_key);
  ASSERT_TRUE(peer_key);

  // Generate two generic ec key pairs.
  ASSERT_TRUE(EC_KEY_set_group(our_key.get(), group));
  ASSERT_TRUE(EC_KEY_generate_key(our_key.get()));
  ASSERT_TRUE(EC_KEY_check_key(our_key.get()));

  ASSERT_TRUE(EC_KEY_set_group(peer_key.get(), group));
  ASSERT_TRUE(EC_KEY_generate_key(peer_key.get()));
  ASSERT_TRUE(EC_KEY_check_key(peer_key.get()));

  // Test that |ECDH_compute_key_fips| has service indicator approval as
  // expected.
  std::vector<uint8_t> digest(test.digest_length);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, ECDH_compute_key_fips(digest.data(), digest.size(),
                                      EC_KEY_get0_public_key(peer_key.get()),
                                      our_key.get())));
  EXPECT_EQ(approved, test.expect_approved);

  // Test running the EVP_PKEY_derive interfaces one by one directly, and check
  // |EVP_PKEY_derive| for approval at the end. |EVP_PKEY_derive_init| and
  // |EVP_PKEY_derive_set_peer| should not be approved because they do not
  // indicate an entire service has been done.
  bssl::UniquePtr<EVP_PKEY> our_pkey(EVP_PKEY_new());
  ASSERT_TRUE(EVP_PKEY_set1_EC_KEY(our_pkey.get(), our_key.get()));
  bssl::UniquePtr<EVP_PKEY_CTX> our_ctx(
      EVP_PKEY_CTX_new(our_pkey.get(), nullptr));
  bssl::UniquePtr<EVP_PKEY> peer_pkey(EVP_PKEY_new());
  ASSERT_TRUE(EVP_PKEY_set1_EC_KEY(peer_pkey.get(), peer_key.get()));

  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_PKEY_derive_init(our_ctx.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_PKEY_derive_set_peer(our_ctx.get(), peer_pkey.get())));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  // Determine the size of the output key. The first call of |EVP_PKEY_derive|
  // should not return an approval check because no crypto is being done when
  // |nullptr| is inputted in the |*key| field
  size_t out_len = 0;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_PKEY_derive(our_ctx.get(), nullptr, &out_len)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  std::vector<uint8_t> derive_output(out_len);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_PKEY_derive(our_ctx.get(), derive_output.data(), &out_len)));
  EXPECT_EQ(approved, kEVPDeriveSetsServiceIndicator
                          ? test.expect_approved
                          : FIPSStatus::NOT_APPROVED);
}

static const struct KDFTestVector {
  // func is the hash function for KDF to test.
  const EVP_MD *(*func)();
  const uint8_t *expected_output;
  const FIPSStatus expect_approved;
} kKDFTestVectors[] = {
    // TLS 1.0 and 1.1 are no longer an approved part of fips
    {EVP_md5_sha1, kTLSOutput_md5_sha1, FIPSStatus::NOT_APPROVED},
    {EVP_sha224, kTLSOutput_sha224, FIPSStatus::NOT_APPROVED},
    {EVP_sha256, kTLSOutput_sha256, FIPSStatus::APPROVED},
    {EVP_sha384, kTLSOutput_sha384, FIPSStatus::APPROVED},
    {EVP_sha512, kTLSOutput_sha512, FIPSStatus::APPROVED},
};

class KDF_ServiceIndicatorTest : public TestWithNoErrors<KDFTestVector> {};

INSTANTIATE_TEST_SUITE_P(All, KDF_ServiceIndicatorTest,
                         testing::ValuesIn(kKDFTestVectors));

TEST_P(KDF_ServiceIndicatorTest, TLSKDF) {
  const KDFTestVector &test = GetParam();

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  uint8_t output[32];
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CRYPTO_tls1_prf(test.func(), output, sizeof(output), kTLSSecret,
                                sizeof(kTLSSecret), kTLSLabel,
                                sizeof(kTLSLabel), kTLSSeed1, sizeof(kTLSSeed1),
                                kTLSSeed2, sizeof(kTLSSeed2))));
  EXPECT_EQ(Bytes(test.expected_output, sizeof(output)),
            Bytes(output, sizeof(output)));
  EXPECT_EQ(approved, test.expect_approved);
}

TEST_P(KDF_ServiceIndicatorTest, TLS13KDF) {
  const KDFTestVector &test = GetParam();

  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  uint8_t output[32];
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CRYPTO_tls13_hkdf_expand_label(
                    output, sizeof(output), test.func(), kTLSSecret,
                    sizeof(kTLSSecret), /*label=*/kTLSSeed1, sizeof(kTLSSeed1),
                    /*hash=*/kTLSSeed2, sizeof(kTLSSeed2))));

  EXPECT_EQ(approved, test.expect_approved);
}

TEST(ServiceIndicatorTest, CMAC) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  bssl::UniquePtr<CMAC_CTX> ctx(CMAC_CTX_new());
  ASSERT_TRUE(ctx);

  // Test running the CMAC interfaces one by one directly, and check
  // |CMAC_Final| for approval at the end. |CMAC_Init| and |CMAC_Update|
  // should not be approved, because the functions do not indicate that a
  // service has been fully completed yet.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CMAC_Init(ctx.get(), kAESKey, sizeof(kAESKey),
                          EVP_aes_128_cbc(), nullptr)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CMAC_Update(ctx.get(), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  uint8_t mac[16];
  size_t out_len;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CMAC_Final(ctx.get(), mac, &out_len)));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
  EXPECT_EQ(Bytes(kAESCMACOutput), Bytes(mac));

  // Test using the one-shot API for approval.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_CMAC(mac, kAESKey, sizeof(kAESKey), kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(Bytes(kAESCMACOutput), Bytes(mac));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, BasicTest) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  bssl::ScopedEVP_AEAD_CTX aead_ctx;
  ASSERT_TRUE(EVP_AEAD_CTX_init(aead_ctx.get(),
                                EVP_aead_aes_128_gcm_randnonce(), kAESKey,
                                sizeof(kAESKey), 0, nullptr));
  // This test ensures that the counter gets incremented once, i.e. it was
  // locked through the internal calls.
  const int counter_before = FIPS_service_indicator_after_call();
  size_t out_len;
  uint8_t output[256];
  EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len, sizeof(output), nullptr,
                    0, kPlaintext, sizeof(kPlaintext), nullptr, 0);
  const int counter_after = FIPS_service_indicator_after_call();
  EXPECT_EQ(counter_after, counter_before + 1);

  // Call an approved service.
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len,
                                  sizeof(output), nullptr, 0, kPlaintext,
                                  sizeof(kPlaintext), nullptr, 0));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // Fail an approved service on purpose.
  ASSERT_FALSE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len, 0, nullptr, 0,
                        kPlaintext, sizeof(kPlaintext), nullptr, 0)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  // Call a non-approved service.
  uint8_t aes_iv[sizeof(kAESIV)];
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  AES_KEY aes_key;
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  int num = 0;
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ofb128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, &num));
  EXPECT_EQ(Bytes(kAESOFBCiphertext), Bytes(output, sizeof(kAESOFBCiphertext)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
}

// Test the SHA interfaces one by one and check that only |*_Final| does the
// approval at the end.
TEST(ServiceIndicatorTest, SHA) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  std::vector<uint8_t> digest;

  // MD4 is no longer part of FIPS - this is retained for now to ensure that
  // MD4 continues to report itself as not approved.
  digest.resize(MD4_DIGEST_LENGTH);
  MD4_CTX md4_ctx;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(approved, MD4_Init(&md4_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, MD4_Update(&md4_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, MD4_Final(digest.data(), &md4_ctx)));
  EXPECT_EQ(Bytes(kOutput_md4), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  // MD5 is no longer part of FIPS - this is retained for now to ensure that
  // MD5 continues to report itself as not approved.
  digest.resize(MD5_DIGEST_LENGTH);
  MD5_CTX md5_ctx;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(approved, MD5_Init(&md5_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, MD5_Update(&md5_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, MD5_Final(digest.data(), &md5_ctx)));
  EXPECT_EQ(Bytes(kOutput_md5), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  digest.resize(SHA_DIGEST_LENGTH);
  SHA_CTX sha_ctx;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(approved, SHA1_Init(&sha_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA1_Update(&sha_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA1_Final(digest.data(), &sha_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha1), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  digest.resize(SHA224_DIGEST_LENGTH);
  SHA256_CTX sha224_ctx;
  ASSERT_TRUE(
      CALL_SERVICE_AND_CHECK_APPROVED(approved, SHA224_Init(&sha224_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA224_Update(&sha224_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA224_Final(digest.data(), &sha224_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha224), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  digest.resize(SHA256_DIGEST_LENGTH);
  SHA256_CTX sha256_ctx;
  ASSERT_TRUE(
      CALL_SERVICE_AND_CHECK_APPROVED(approved, SHA256_Init(&sha256_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA256_Update(&sha256_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA256_Final(digest.data(), &sha256_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha256), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  digest.resize(SHA384_DIGEST_LENGTH);
  SHA512_CTX sha384_ctx;
  ASSERT_TRUE(
      CALL_SERVICE_AND_CHECK_APPROVED(approved, SHA384_Init(&sha384_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA384_Update(&sha384_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA384_Final(digest.data(), &sha384_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha384), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  digest.resize(SHA512_DIGEST_LENGTH);
  SHA512_CTX sha512_ctx;
  ASSERT_TRUE(
      CALL_SERVICE_AND_CHECK_APPROVED(approved, SHA512_Init(&sha512_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA512_Update(&sha512_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA512_Final(digest.data(), &sha512_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha512), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  digest.resize(SHA512_256_DIGEST_LENGTH);
  SHA512_CTX sha512_256_ctx;
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA512_256_Init(&sha512_256_ctx)));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      SHA512_256_Update(&sha512_256_ctx, kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, SHA512_256_Final(digest.data(), &sha512_256_ctx)));
  EXPECT_EQ(Bytes(kOutput_sha512_256), Bytes(digest));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, AESECB) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t output[256];

  // AES-ECB Encryption KAT for 128 bit key.
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  // AES_ecb_encrypt encrypts (or decrypts) a single, 16 byte block from in to
  // out.
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kPlaintext[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_ENCRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kAESECBCiphertext), Bytes(output, sizeof(kAESECBCiphertext)));

  // AES-ECB Decryption KAT for 128 bit key.
  ASSERT_TRUE(AES_set_decrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kAESECBCiphertext[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_DECRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output, sizeof(kPlaintext)));

  // AES-ECB Encryption KAT for 192 bit key.
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_192, 8 * sizeof(kAESKey_192), &aes_key) == 0);
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kPlaintext[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_ENCRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kAESECBCiphertext_192),
            Bytes(output, sizeof(kAESECBCiphertext_192)));

  // AES-ECB Decryption KAT for 192 bit key.
  ASSERT_TRUE(
      AES_set_decrypt_key(kAESKey_192, 8 * sizeof(kAESKey_192), &aes_key) == 0);
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kAESECBCiphertext_192[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_DECRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output, sizeof(kPlaintext)));

  // AES-ECB Encryption KAT for 256 bit key.
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_256, 8 * sizeof(kAESKey_256), &aes_key) == 0);
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kPlaintext[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_ENCRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kAESECBCiphertext_256),
            Bytes(output, sizeof(kAESECBCiphertext_256)));

  // AES-ECB Decryption KAT for 256 bit key.
  ASSERT_TRUE(
      AES_set_decrypt_key(kAESKey_256, 8 * sizeof(kAESKey_256), &aes_key) == 0);
  for (size_t i = 0; i < sizeof(kPlaintext) / AES_BLOCK_SIZE; i++) {
    CALL_SERVICE_AND_CHECK_APPROVED(
        approved,
        AES_ecb_encrypt(&kAESECBCiphertext_256[i * AES_BLOCK_SIZE],
                        &output[i * AES_BLOCK_SIZE], &aes_key, AES_DECRYPT));
    EXPECT_EQ(approved, FIPSStatus::APPROVED);
  }
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output, sizeof(kPlaintext)));
}

TEST(ServiceIndicatorTest, AESCBC) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t aes_iv[sizeof(kAESIV)];
  uint8_t output[sizeof(kPlaintext)];

  // AES-CBC Encryption KAT for 128 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cbc_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                &aes_key, aes_iv, AES_ENCRYPT));
  EXPECT_EQ(Bytes(kAESCBCCiphertext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CBC Decryption KAT for 128 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(AES_set_decrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_cbc_encrypt(kAESCBCCiphertext, output, sizeof(kAESCBCCiphertext),
                      &aes_key, aes_iv, AES_DECRYPT));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CBC Encryption KAT for 192 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_192, 8 * sizeof(kAESKey_192), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cbc_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                &aes_key, aes_iv, AES_ENCRYPT));
  EXPECT_EQ(Bytes(kAESCBCCiphertext_192), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CBC Decryption KAT for 192 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_decrypt_key(kAESKey_192, 8 * sizeof(kAESKey_192), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cbc_encrypt(kAESCBCCiphertext_192, output,
                                sizeof(kAESCBCCiphertext_192), &aes_key, aes_iv,
                                AES_DECRYPT));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CBC Encryption KAT for 256 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_256, 8 * sizeof(kAESKey_256), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cbc_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                &aes_key, aes_iv, AES_ENCRYPT));
  EXPECT_EQ(Bytes(kAESCBCCiphertext_256), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CBC Decryption KAT for 256 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_decrypt_key(kAESKey_256, 8 * sizeof(kAESKey_256), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cbc_encrypt(kAESCBCCiphertext_256, output,
                                sizeof(kAESCBCCiphertext_256), &aes_key, aes_iv,
                                AES_DECRYPT));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, AESCTR) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t aes_iv[sizeof(kAESIV)];
  uint8_t output[sizeof(kPlaintext)];
  unsigned num = 0;
  uint8_t ecount_buf[AES_BLOCK_SIZE];

  // AES-CTR Encryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ctr128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kAESCTRCiphertext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CTR Decryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_ctr128_encrypt(kAESCTRCiphertext, output, sizeof(kAESCTRCiphertext),
                         &aes_key, aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CTR Encryption KAT for 192 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_192, 8 * sizeof(kAESKey_192), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ctr128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kAESCTRCiphertext_192), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CTR Decryption KAT for 192 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ctr128_encrypt(kAESCTRCiphertext_192, output,
                                   sizeof(kAESCTRCiphertext_192), &aes_key,
                                   aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CTR Encryption KAT for 256 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(
      AES_set_encrypt_key(kAESKey_256, 8 * sizeof(kAESKey_256), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ctr128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kAESCTRCiphertext_256), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-CTR Decryption KAT for 256 bit key.
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ctr128_encrypt(kAESCTRCiphertext_256, output,
                                   sizeof(kAESCTRCiphertext_256), &aes_key,
                                   aes_iv, ecount_buf, &num));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, AESOFB) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t aes_iv[sizeof(kAESIV)];
  uint8_t output[sizeof(kPlaintext)];
  int num = 0;

  // AES-OFB Encryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_ofb128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, &num));
  EXPECT_EQ(Bytes(kAESOFBCiphertext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  // AES-OFB Decryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_ofb128_encrypt(kAESOFBCiphertext, output, sizeof(kAESOFBCiphertext),
                         &aes_key, aes_iv, &num));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
}

TEST(ServiceIndicatorTest, AESCFB) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t aes_iv[sizeof(kAESIV)];
  uint8_t output[sizeof(kPlaintext)];
  int num = 0;

  // AES-CFB Encryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_cfb128_encrypt(kPlaintext, output, sizeof(kPlaintext),
                                   &aes_key, aes_iv, &num, AES_ENCRYPT));
  EXPECT_EQ(Bytes(kAESCFBCiphertext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);

  // AES-CFB Decryption KAT
  memcpy(aes_iv, kAESIV, sizeof(aes_iv));
  CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_cfb128_encrypt(kAESCFBCiphertext, output, sizeof(kAESCFBCiphertext),
                         &aes_key, aes_iv, &num, AES_DECRYPT));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
}

TEST(ServiceIndicatorTest, AESKW) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t output[sizeof(kPlaintext) + 8];
  size_t outlen;

  // AES-KW Encryption KAT
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  outlen = CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_wrap_key(&aes_key, nullptr, output, kPlaintext, sizeof(kPlaintext)));
  ASSERT_EQ(outlen, sizeof(kAESKWCiphertext));
  EXPECT_EQ(Bytes(kAESKWCiphertext), Bytes(output));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-KW Decryption KAT
  ASSERT_TRUE(AES_set_decrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  outlen = CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_unwrap_key(&aes_key, nullptr, output, kAESKWCiphertext,
                               sizeof(kAESKWCiphertext)));
  ASSERT_EQ(outlen, sizeof(kPlaintext));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output, sizeof(kPlaintext)));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, AESKWP) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  AES_KEY aes_key;
  uint8_t output[sizeof(kPlaintext) + 15];
  size_t outlen;

  // AES-KWP Encryption KAT
  ASSERT_TRUE(AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, AES_wrap_key_padded(&aes_key, output, &outlen, sizeof(output),
                                    kPlaintext, sizeof(kPlaintext))));
  EXPECT_EQ(Bytes(kAESKWPCiphertext), Bytes(output, outlen));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // AES-KWP Decryption KAT
  ASSERT_TRUE(AES_set_decrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) == 0);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      AES_unwrap_key_padded(&aes_key, output, &outlen, sizeof(output),
                            kAESKWPCiphertext, sizeof(kAESKWPCiphertext))));
  EXPECT_EQ(Bytes(kPlaintext), Bytes(output, outlen));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

TEST(ServiceIndicatorTest, FFDH) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;

  // |DH_compute_key_padded| should be a non-approved service.
  bssl::UniquePtr<DH> dh(GetDH());
  uint8_t dh_out[sizeof(kDHOutput)];
  ASSERT_EQ(DH_size(dh.get()), static_cast<int>(sizeof(dh_out)));
  ASSERT_EQ(CALL_SERVICE_AND_CHECK_APPROVED(
                approved, DH_compute_key_padded(
                              dh_out, DH_get0_priv_key(dh.get()), dh.get())),
            static_cast<int>(sizeof(dh_out)));
  EXPECT_EQ(Bytes(kDHOutput), Bytes(dh_out));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
}

TEST(ServiceIndicatorTest, DRBG) {
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  CTR_DRBG_STATE drbg;
  uint8_t output[sizeof(kDRBGOutput)];

  // Test running the DRBG interfaces and check |CTR_DRBG_generate| for approval
  // at the end since it indicates a service is being done. |CTR_DRBG_init| and
  // |CTR_DRBG_reseed| should not be approved, because the functions do not
  // indicate that a service has been fully completed yet.
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      CTR_DRBG_init(&drbg, /*df=*/true, kDRBGEntropy, sizeof(kDRBGEntropy),
                    kDRBGNonce, kDRBGPersonalization,
                    sizeof(kDRBGPersonalization))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CTR_DRBG_generate(&drbg, output, sizeof(kDRBGOutput), kDRBGAD,
                                  sizeof(kDRBGAD))));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
  EXPECT_EQ(Bytes(kDRBGOutput), Bytes(output));

  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CTR_DRBG_reseed_ex(&drbg, kDRBGEntropy2, sizeof(kDRBGEntropy2),
                                   kDRBGAD, sizeof(kDRBGAD))));
  EXPECT_EQ(approved, FIPSStatus::NOT_APPROVED);
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, CTR_DRBG_generate(&drbg, output, sizeof(kDRBGReseedOutput),
                                  kDRBGAD, sizeof(kDRBGAD))));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
  EXPECT_EQ(Bytes(kDRBGReseedOutput), Bytes(output));

  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, RAND_bytes(output, sizeof(output))));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

#else  // !BORINGSSL_FIPS

// Service indicator calls should not be used in non-FIPS builds. However, if
// used, the macro |CALL_SERVICE_AND_CHECK_APPROVED| will return
// |FIPSStatus::APPROVED|, but the direct calls to
// |FIPS_service_indicator_xxx| will not indicate an approved state.
TEST(ServiceIndicatorTest, BasicTest) {
  // Reset and check the initial state and counter.
  FIPSStatus approved = FIPSStatus::NOT_APPROVED;
  uint64_t before = FIPS_service_indicator_before_call();
  ASSERT_EQ(before, (uint64_t)0);

  // Call an approved service.
  bssl::ScopedEVP_AEAD_CTX aead_ctx;
  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH] = {0};
  uint8_t output[256];
  size_t out_len;
  ASSERT_TRUE(EVP_AEAD_CTX_init(aead_ctx.get(),
                                EVP_aead_aes_128_gcm_randnonce(), kAESKey,
                                sizeof(kAESKey), 0, nullptr));
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved, EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len,
                                  sizeof(output), nullptr, 0, kPlaintext,
                                  sizeof(kPlaintext), nullptr, 0)));
  // Macro should return true, to ensure FIPS/non-FIPS compatibility.
  EXPECT_EQ(approved, FIPSStatus::APPROVED);

  // Call a non-approved service.
  ASSERT_TRUE(EVP_AEAD_CTX_init(aead_ctx.get(), EVP_aead_aes_128_gcm(), kAESKey,
                                sizeof(kAESKey), 0, nullptr));
  ASSERT_TRUE(CALL_SERVICE_AND_CHECK_APPROVED(
      approved,
      EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len, sizeof(output), nonce,
                        EVP_AEAD_nonce_length(EVP_aead_aes_128_gcm()),
                        kPlaintext, sizeof(kPlaintext), nullptr, 0)));
  EXPECT_EQ(approved, FIPSStatus::APPROVED);
}

#endif  // BORINGSSL_FIPS

}  // namespace
