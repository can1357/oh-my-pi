// Copyright 1995-2017 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/des.h>
#include <openssl/span.h>

#include "../../crypto/test/test_util.h"


// DES-CFB tests from OpenSSL. OpenSSL has no test vectors for 3DES-CFB at all.
// Instead, we repurpose those tests to cover 3DES-CFB by running the inputs
// through three times.
static const DES_cblock cfb_key = {
    {0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
static const DES_cblock cfb_iv = {
    {0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef}};
static const uint8_t plain[24] = {
    0x4e, 0x6f, 0x77, 0x20, 0x69, 0x73, 0x20, 0x74, 0x68, 0x65, 0x20, 0x74,
    0x69, 0x6d, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x20, 0x61, 0x6c, 0x6c, 0x20};
static const uint8_t cfb_cipher8[24] = {
    0xf3, 0x1f, 0xda, 0x07, 0x01, 0x14, 0x62, 0xee, 0x18, 0x7f, 0x43, 0xd8,
    0x0a, 0x7c, 0xd9, 0xb5, 0xb0, 0xd2, 0x90, 0xda, 0x6e, 0x5b, 0x9a, 0x87};
static const uint8_t cfb_cipher16[24] = {
    0xf3, 0x09, 0x87, 0x87, 0x7f, 0x57, 0xf7, 0x3c, 0x36, 0xb6, 0xdb, 0x70,
    0xd8, 0xd5, 0x34, 0x19, 0xd3, 0x86, 0xb2, 0x23, 0xb7, 0xb2, 0xad, 0x1b};
static const uint8_t cfb_cipher32[24] = {
    0xf3, 0x09, 0x62, 0x49, 0xa4, 0xdf, 0xa4, 0x9f, 0x33, 0xdc, 0x7b, 0xad,
    0x4c, 0xc8, 0x9f, 0x64, 0xe4, 0x53, 0xe5, 0xec, 0x67, 0x20, 0xda, 0xb6};
static const uint8_t cfb_cipher48[24] = {
    0xf3, 0x09, 0x62, 0x49, 0xc7, 0xf4, 0x30, 0xb5, 0x15, 0xec, 0xbb, 0x85,
    0x97, 0x5a, 0x13, 0x8c, 0x68, 0x60, 0xe2, 0x38, 0x34, 0x3c, 0xdc, 0x1f};
static const uint8_t cfb_cipher64[24] = {
    0xf3, 0x09, 0x62, 0x49, 0xc7, 0xf4, 0x6e, 0x51, 0xa6, 0x9e, 0x83, 0x9b,
    0x1a, 0x92, 0xf7, 0x84, 0x03, 0x46, 0x71, 0x33, 0x89, 0x8e, 0xa6, 0x22};

// Unlike the above test vectors, this test vector was computed by running the
// existing implementation and saving the output. OpenSSL lacks tests for this
// function, but also implements an incorrect construction in its low-level
// APIs. As a result, importing a standard test vector would only test 1/8 of
// the output. See discussion in the test.
static const uint8_t cfb_cipher1[24] = {
    0xf3, 0x27, 0xff, 0x2d, 0x80, 0xee, 0x12, 0xbe, 0xb6, 0x74, 0xa3, 0xb4,
    0xd6, 0xfb, 0x5d, 0x0d, 0x49, 0x18, 0x84, 0xed, 0xfe, 0xca, 0x17, 0x5f};

TEST(DESTest, CFB) {
  DES_key_schedule ks;
  DES_set_key(&cfb_key, &ks);

  struct {
    int numbits;
    const uint8_t (&ciphertext)[24];
  } kTests[] = {
      {1, cfb_cipher1},   {8, cfb_cipher8},   {16, cfb_cipher16},
      {32, cfb_cipher32}, {48, cfb_cipher48}, {64, cfb_cipher64},
  };
  for (const auto &t : kTests) {
    SCOPED_TRACE(t.numbits);

    // |DES_ede3_cfb_encrypt| only supports streaming at segment boundaries.
    // Segments, however, are measured in bits, not bytes. When the segment is
    // not a whole number of bytes, OpenSSL's low-level functions do not
    // implement CFB correctly. CFB-n ultimately computes a sequence of E(I_i)
    // blocks, extracts n bits from each block to XOR into the next n bits of
    // plaintext. OpenSSL computes the correct sequence of blocks, but then
    // rounds n up to a byte boundary when consuming input.
    //
    // It essentially interprets CFB-1 as a funny CFB-8, with the wrong amount
    // of cipher feedback. To get the real CFB-1 out of OpenSSL's CFB-1, you put
    // each plaintext bit as into its byte, with bit at the MSB, then mask off
    // all but the MSB of each ciphertext byte. OpenSSL's |EVP_des_ede3_cfb1|
    // does this transformation internally, to work around this bug.
    //
    // In case anyone is relying on the remaining bits, we test all the output
    // bits of the OpenSSL version. However, for such callers, it is unclear if
    // this version has been sufficiently analyzed.
    size_t offset = (t.numbits + 7) / 8;
    for (size_t split = 0; split < sizeof(plain); split += offset) {
      SCOPED_TRACE(split);
      uint8_t out[sizeof(plain)];
      DES_cblock iv = cfb_iv;
      DES_ede3_cfb_encrypt(plain, out, t.numbits, split, &ks, &ks, &ks, &iv,
                           DES_ENCRYPT);
      DES_ede3_cfb_encrypt(plain + split, out + split, t.numbits,
                           sizeof(plain) - split, &ks, &ks, &ks, &iv,
                           DES_ENCRYPT);
      EXPECT_EQ(Bytes(out), Bytes(t.ciphertext));

      iv = cfb_iv;
      DES_ede3_cfb_encrypt(t.ciphertext, out, t.numbits, split, &ks, &ks, &ks,
                           &iv, DES_DECRYPT);
      DES_ede3_cfb_encrypt(t.ciphertext + split, out + split, t.numbits,
                           sizeof(plain) - split, &ks, &ks, &ks, &iv,
                           DES_DECRYPT);
      EXPECT_EQ(Bytes(out), Bytes(plain));
    }
  }
}

TEST(DESTest, CFB64) {
  DES_key_schedule ks;
  DES_set_key(&cfb_key, &ks);

  // Unlike the generic CFB API, the CFB64 API can be split within a block
  // boundary.
  for (size_t split = 0; split <= sizeof(plain); split++) {
    SCOPED_TRACE(split);
    uint8_t out[sizeof(plain)];
    DES_cblock iv = cfb_iv;
    int n = 0;
    DES_ede3_cfb64_encrypt(plain, out, split, &ks, &ks, &ks, &iv, &n,
                           DES_ENCRYPT);
    DES_ede3_cfb64_encrypt(plain + split, out + split, sizeof(plain) - split,
                           &ks, &ks, &ks, &iv, &n, DES_ENCRYPT);
    EXPECT_EQ(Bytes(out), Bytes(cfb_cipher64));

    n = 0;
    iv = cfb_iv;
    DES_ede3_cfb64_encrypt(cfb_cipher64, out, split, &ks, &ks, &ks, &iv, &n,
                           DES_DECRYPT);
    DES_ede3_cfb64_encrypt(cfb_cipher64 + split, out + split,
                           sizeof(cfb_cipher64) - split, &ks, &ks, &ks, &iv, &n,
                           DES_DECRYPT);
    EXPECT_EQ(Bytes(out), Bytes(plain));
  }
}
