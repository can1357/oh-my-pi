// Copyright 2015 The Chromium Authors
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

#include "signature_algorithm.h"

#include <memory>

#include <gtest/gtest.h>
#include "input.h"
#include "parser.h"

BSSL_NAMESPACE_BEGIN

namespace {

// Parses a SignatureAlgorithm given an empty DER input.
TEST(SignatureAlgorithmTest, ParseDerEmpty) {
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input()));
}

// Parses a SignatureAlgorithm given invalid DER input.
TEST(SignatureAlgorithmTest, ParseDerBogus) {
  const uint8_t kData[] = {0x00};
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a SignatureAlgorithm with an unsupported algorithm OID.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER 66 (bogus)
TEST(SignatureAlgorithmTest, ParseDerRsaPssUnsupportedAlgorithmOid) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x03,  // SEQUENCE (3 bytes)
      0x06, 0x01,  // OBJECT IDENTIFIER (1 bytes)
      0x42,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a sha1WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSAEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha1);
}

// Parses a sha1WithRSAEncryption which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSAEncryptionNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha1);
}

// Parses a sha1WithRSAEncryption which contains an unexpected parameters
// field. Instead of being NULL it is an integer.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
//       INTEGER  0
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSAEncryptionNonNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0E,  // SEQUENCE (14 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
      0x02, 0x01, 0x00,  // INTEGER (1 byte)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a sha1WithRSASignature which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.3.14.3.2.29
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSASignatureNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2b, 0x0e, 0x03, 0x02, 0x1d,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha1);
}

// Parses a sha1WithRSASignature which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.3.14.3.2.29
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSASignatureNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x07,  // SEQUENCE (7 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2b, 0x0e, 0x03, 0x02, 0x1d,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha1);
}

// Parses a sha1WithRSAEncryption which contains values after the sequence.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
//       NULL
//   INTEGER  0
TEST(SignatureAlgorithmTest, ParseDerSha1WithRsaEncryptionDataAfterSequence) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
      0x05, 0x00,  // NULL (0 bytes)
      0x02, 0x01, 0x00,  // INTEGER (1 byte)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a sha1WithRSAEncryption which contains a bad NULL parameters field.
// Normally NULL is encoded as {0x05, 0x00} (tag for NULL and length of 0). Here
// NULL is encoded as having a length of 1 instead, followed by data 0x09.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha1WithRSAEncryptionBadNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0E,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
      0x05, 0x01, 0x09,  // NULL (1 byte)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a sha1WithRSAEncryption which contains a NULL parameters field,
// followed by an integer.
//
//   SEQUENCE (3 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.5
//       NULL
//       INTEGER  0
TEST(SignatureAlgorithmTest,
     ParseDerSha1WithRSAEncryptionNullParamsThenInteger) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x10,  // SEQUENCE (16 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x05,
      0x05, 0x00,  // NULL (0 bytes)
      0x02, 0x01, 0x00,  // INTEGER (1 byte)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a SignatureAlgorithm given DER which does not encode a sequence.
//
//   INTEGER 0
TEST(SignatureAlgorithmTest, ParseDerNotASequence) {
  // clang-format off
  const uint8_t kData[] = {
      0x02, 0x01, 0x00,  // INTEGER (1 byte)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a sha256WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.11
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha256WithRSAEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha256);
}

// Parses a sha256WithRSAEncryption which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.11
TEST(SignatureAlgorithmTest, ParseDerSha256WithRSAEncryptionNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha256);
}

// Parses a sha384WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.12
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha384WithRSAEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha384);
}

// Parses a sha384WithRSAEncryption which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.12
TEST(SignatureAlgorithmTest, ParseDerSha384WithRSAEncryptionNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha384);
}

// Parses a sha512WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.13
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha512WithRSAEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha512);
}

// Parses a sha512WithRSAEncryption which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.13
TEST(SignatureAlgorithmTest, ParseDerSha512WithRSAEncryptionNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPkcs1Sha512);
}

// Parses a sha224WithRSAEncryption which contains a NULL parameters field.
// This fails because the parsing code does not enumerate this OID (even though
// it is in fact valid).
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.14
//       NULL
TEST(SignatureAlgorithmTest, ParseDerSha224WithRSAEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0e,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a ecdsa-with-SHA1 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.1
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA1NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x07,  // OBJECT IDENTIFIER (7 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x01,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kEcdsaSha1);
}

// Parses a ecdsa-with-SHA1 which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.1
//       NULL
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA1NullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x07,  // OBJECT IDENTIFIER (7 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a ecdsa-with-SHA256 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.2
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA256NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0A,  // SEQUENCE (10 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kEcdsaSha256);
}

// Parses a ecdsa-with-SHA256 which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.2
//       NULL
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA256NullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0C,  // SEQUENCE (12 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a ecdsa-with-SHA384 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.3
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA384NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0A,  // SEQUENCE (10 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kEcdsaSha384);
}

// Parses a ecdsa-with-SHA384 which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.3
//       NULL
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA384NullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0C,  // SEQUENCE (12 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a ecdsa-with-SHA512 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.4
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA512NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0A,  // SEQUENCE (10 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04,
  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kEcdsaSha512);
}

// Parses a ecdsa-with-SHA512 which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.10045.4.3.4
//       NULL
TEST(SignatureAlgorithmTest, ParseDerEcdsaWithSHA512NullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0C,  // SEQUENCE (12 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses SHA256 and a salt length of 32.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (4 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER 2.16.840.1.101.3.4.2.1
//                   NULL
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER 2.16.840.1.101.3.4.2.1
//                       NULL
//           [2] (1 elem)
//               INTEGER  32
TEST(SignatureAlgorithmTest, ParseDerRsaPss) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x41,  // SEQUENCE (65 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x34,  // SEQUENCE (52 bytes)
      0xA0, 0x0F,  // [0] (15 bytes)
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
      0xA1, 0x1C,  // [1] (28 bytes)
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
      0xA2, 0x03,  // [2] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x20,

  };
  // clang-format on
  EXPECT_EQ(ParseSignatureAlgorithm(der::Input(kData)),
            SignatureAlgorithm::kRsaPssSha256);
}

// Parses a rsaPss algorithm that has an empty parameters. This encodes the
// default, SHA-1, which we do not support.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (0 elem)
TEST(SignatureAlgorithmTest, ParseDerRsaPssEmptyParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x00,  // SEQUENCE (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has NULL parameters. This fails.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has no parameters. This fails.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
TEST(SignatureAlgorithmTest, ParseDerRsaPssNoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has data after the parameters sequence.
//
//   SEQUENCE (3 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (0 elem)
//       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssDataAfterParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0F,  // SEQUENCE (15 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x00,  // SEQUENCE (0 bytes)
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has unrecognized data (NULL) within the
// parameters sequence.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (2 elem)
//           [2] (1 elem)
//               INTEGER  23
//           NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssNullInsideParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x14,  // SEQUENCE (62 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x07,  // SEQUENCE (5 bytes)
      0xA2, 0x03,  // [2] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x17,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has an unsupported trailer value (2). Only
// trailer values of 1 are allowed by RFC 4055.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [3] (1 elem)
//               INTEGER  2
TEST(SignatureAlgorithmTest, ParseDerRsaPssUnsupportedTrailer) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x12,  // SEQUENCE (18 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x05,  // SEQUENCE (5 bytes)
      0xA3, 0x03,  // [3] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x02,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that has extra data appearing after the trailer in
// the [3] section.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [3] (2 elem)
//               INTEGER  1
//               NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssBadTrailer) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x14,  // SEQUENCE (20 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x07,  // SEQUENCE (7 bytes)
      0xA3, 0x05,  // [3] (5 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x01,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses SHA384 for the hash, and leaves the rest
// as defaults, specifying a SHA-1 MGF-1 hash. This fails because we require
// the hashes match.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  2.16.840.1.101.3.4.2.2
//                   NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssNonDefaultHash) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x1E,  // SEQUENCE (30 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x11,  // SEQUENCE (17 bytes)
      0xA0, 0x0F,  // [0] (15 bytes)
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses an invalid hash algorithm (twiddled the
// bytes for the SHA-384 OID a bit).
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [0] (1 elem)
//               SEQUENCE (1 elem)
//                   OBJECT IDENTIFIER  2.16.840.2.103.19.4.2.2
TEST(SignatureAlgorithmTest, ParseDerRsaPssUnsupportedHashOid) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x1C,  // SEQUENCE (28 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x0F,  // SEQUENCE (15 bytes)
      0xA0, 0x0D,  // [0] (13 bytes)
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x02, 0x67, 0x13, 0x04, 0x02, 0x02,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses SHA512 MGF1 for the mask gen, and
// defaults (SHA-1) for the rest. This fails because we require the hashes
// match.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  2.16.840.1.101.3.4.2.3
//                       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssNonDefaultMaskGen) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x2B,  // SEQUENCE (43 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x1E,  // SEQUENCE (30 bytes)
      0xA1, 0x1C,  // [1] (28 bytes)
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses a mask gen with an unrecognized OID
// (twiddled some of the bits).
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113618.1.2.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  2.16.840.1.101.3.4.2.3
//                       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssUnsupportedMaskGen) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x2B,  // SEQUENCE (43 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x1E,  // SEQUENCE (30 bytes)
      0xA1, 0x1C,  // [1] (28 bytes)
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x52, 0x01, 0x02, 0x08,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses SHA256 for the hash, and SHA512 for the
// MGF1. This fails because we require the hashes match.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (2 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER 2.16.840.1.101.3.4.2.1
//                   NULL
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  2.16.840.1.101.3.4.2.3
//                       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssNonDefaultHashAndMaskGen) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x3C,  // SEQUENCE (60 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x2F,  // SEQUENCE (47 bytes)
      0xA0, 0x0F,  // [0] (15 bytes)
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
      0xA1, 0x1C,  // [1] (28 bytes)
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that uses SHA256 for the hash, and SHA256 for the
// MGF1, and a salt length of 10. This fails because we require a standard salt
// length.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (3 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER 2.16.840.1.101.3.4.2.1
//                   NULL
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  2.16.840.1.101.3.4.2.1
//                       NULL
//           [2] (1 elem)
//               INTEGER  10
TEST(SignatureAlgorithmTest, ParseDerRsaPssNonDefaultHashAndMaskGenAndSalt) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x41,  // SEQUENCE (65 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x34,  // SEQUENCE (52 bytes)
      0xA0, 0x0F,  // [0] (15 bytes)
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
      0xA1, 0x1C,  // [1] (28 bytes)
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00,  // NULL (0 bytes)
      0xA2, 0x03,  // [2] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x0A,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that specifies default hash (SHA1).
// It is invalid to specify the default.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.3.14.3.2.26
//                   NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssSpecifiedDefaultHash) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0xA0, 0x0B,  // [0] (11 bytes)
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2B, 0x0E, 0x03, 0x02, 0x1A,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that specifies default mask gen algorithm (SHA1).
// It is invalid to specify the default.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  1.3.14.3.2.26
//                       NULL
TEST(SignatureAlgorithmTest, ParseDerRsaPssSpecifiedDefaultMaskGen) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x27,  // SEQUENCE (39 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x1A,  // SEQUENCE (26 bytes)
      0xA1, 0x18,  // [1] (24 bytes)
      0x30, 0x16,  // SEQUENCE (22 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2B, 0x0E, 0x03, 0x02, 0x1A,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that specifies default salt length.
// It is invalid to specify the default.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (1 elem)
//           [2] (1 elem)
//               INTEGER  20
TEST(SignatureAlgorithmTest, ParseDerRsaPssSpecifiedDefaultSaltLength) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x12,  // SEQUENCE (18 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x05,  // SEQUENCE (5 bytes)
      0xA2, 0x03,  // [2] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x14,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that specifies default trailer field.
// It is invalid to specify the default.
TEST(SignatureAlgorithmTest, ParseDerRsaPssSpecifiedDefaultTrailerField) {
  // SEQUENCE {
  //   # rsassa-pss
  //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
  //   SEQUENCE {
  //     [0] {
  //       SEQUENCE {
  //         # sha256
  //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
  //         NULL {}
  //       }
  //     }
  //     [1] {
  //       SEQUENCE {
  //         # mgf1
  //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
  //         SEQUENCE {
  //           # sha256
  //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
  //           NULL {}
  //         }
  //       }
  //     }
  //     [2] {
  //       INTEGER { 32 }
  //     }
  //     [3] {
  //       INTEGER { 1 }
  //     }
  //   }
  // }
  const uint8_t kData[] = {
      0x30, 0x46, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
      0x0a, 0x30, 0x39, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
      0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
      0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x20, 0xa3, 0x03, 0x02, 0x01, 0x01};
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a rsaPss algorithm that specifies multiple default parameter values.
// It is invalid to specify a default value.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.10
//       SEQUENCE (3 elem)
//           [0] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.3.14.3.2.26
//                   NULL
//           [1] (1 elem)
//               SEQUENCE (2 elem)
//                   OBJECT IDENTIFIER  1.2.840.113549.1.1.8
//                   SEQUENCE (2 elem)
//                       OBJECT IDENTIFIER  1.3.14.3.2.26
//                       NULL
//           [2] (1 elem)
//               INTEGER  20
//           [3] (1 elem)
//               INTEGER  1
TEST(SignatureAlgorithmTest, ParseDerRsaPssMultipleDefaultParameterValues) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x3E,  // SEQUENCE (62 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A,
      0x30, 0x31,  // SEQUENCE (49 bytes)
      0xA0, 0x0B,  // [0] (11 bytes)
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2B, 0x0E, 0x03, 0x02, 0x1A,
      0x05, 0x00,  // NULL (0 bytes)
      0xA1, 0x18,  // [1] (24 bytes)
      0x30, 0x16,  // SEQUENCE (22 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08,
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x05,  // OBJECT IDENTIFIER (5 bytes)
      0x2B, 0x0E, 0x03, 0x02, 0x1A,
      0x05, 0x00,  // NULL (0 bytes)
      0xA2, 0x03,  // [2] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x14,
      0xA3, 0x03,  // [3] (3 bytes)
      0x02, 0x01,  // INTEGER (1 byte)
      0x01,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

TEST(SignatureAlgorithmTest, ParseRsaPss) {
  // Test data generated with https://github.com/google/der-ascii.
  struct {
    std::vector<uint8_t> data;
    SignatureAlgorithm expected;
  } kValidTests[] = {
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha256
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha256
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 32 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x20},
       SignatureAlgorithm::kRsaPssSha256},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha384
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.2 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha384
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.2 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 48 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x30},
       SignatureAlgorithm::kRsaPssSha384},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha512
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.3 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha512
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.3 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 64 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x40},
       SignatureAlgorithm::kRsaPssSha512},

      // The same inputs as above, but the NULLs in the digest algorithms are
      // omitted.
      {{0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x0a, 0x30, 0x30, 0xa0, 0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60,
        0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0xa1, 0x1a, 0x30,
        0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x08, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
        0x04, 0x02, 0x01, 0xa2, 0x03, 0x02, 0x01, 0x20},
       SignatureAlgorithm::kRsaPssSha256},
      {{0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x0a, 0x30, 0x30, 0xa0, 0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60,
        0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0xa1, 0x1a, 0x30,
        0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x08, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
        0x04, 0x02, 0x02, 0xa2, 0x03, 0x02, 0x01, 0x30},
       SignatureAlgorithm::kRsaPssSha384},
      {{0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x0a, 0x30, 0x30, 0xa0, 0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60,
        0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0xa1, 0x1a, 0x30,
        0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x08, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
        0x04, 0x02, 0x03, 0xa2, 0x03, 0x02, 0x01, 0x40},
       SignatureAlgorithm::kRsaPssSha512}};
  for (const auto &t : kValidTests) {
    EXPECT_EQ(ParseSignatureAlgorithm(der::Input(t.data)), t.expected);
  }

  struct {
    std::vector<uint8_t> data;
  } kInvalidTests[] = {
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha256
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha384
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.2 }
      //           NULL {}
      //         }
      //       }
      //     }
      //   }
      // }
      {{0x30, 0x3c, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x0a, 0x30, 0x2f, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60,
        0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa1,
        0x1c, 0x30, 0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
        0x01, 0x01, 0x08, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
        0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00}},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # md5
      //         OBJECT_IDENTIFIER { 1.2.840.113549.2.5 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # md5
      //           OBJECT_IDENTIFIER { 1.2.840.113549.2.5 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 16 }
      //     }
      //   }
      // }
      {{0x30, 0x3f, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x0a, 0x30, 0x32, 0xa0, 0x0e, 0x30, 0x0c, 0x06, 0x08, 0x2a,
        0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0xa1, 0x1b,
        0x30, 0x19, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x08, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7,
        0x0d, 0x02, 0x05, 0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x10}},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   # SHA-1 with salt length 20 is the default.
      //   SEQUENCE {}
      // }
      {{0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x00}},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [2] {
      //       INTEGER { 21 }
      //     }
      //   }
      // }
      {{0x30, 0x12, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
        0x01, 0x01, 0x0a, 0x30, 0x05, 0xa2, 0x03, 0x02, 0x01, 0x15}},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha256
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha256
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.1 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 33 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x21}},
      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha384
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.2 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha384
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.2 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 49 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x31}},

      // SEQUENCE {
      //   # rsassa-pss
      //   OBJECT_IDENTIFIER { 1.2.840.113549.1.1.10 }
      //   SEQUENCE {
      //     [0] {
      //       SEQUENCE {
      //         # sha512
      //         OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.3 }
      //         NULL {}
      //       }
      //     }
      //     [1] {
      //       SEQUENCE {
      //         # mgf1
      //         OBJECT_IDENTIFIER { 1.2.840.113549.1.1.8 }
      //         SEQUENCE {
      //           # sha512
      //           OBJECT_IDENTIFIER { 2.16.840.1.101.3.4.2.3 }
      //           NULL {}
      //         }
      //       }
      //     }
      //     [2] {
      //       INTEGER { 65 }
      //     }
      //   }
      // }
      {{0x30, 0x41, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x0a, 0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0xa1, 0x1c, 0x30, 0x1a,
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08, 0x30,
        0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
        0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x41}},
  };
  for (const auto &t : kInvalidTests) {
    EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(t.data)));
  }
}

// Parses a md5WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.4
//       NULL
TEST(SignatureAlgorithmTest, ParseDerMd5WithRsaEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x04,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a md4WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.3
//       NULL
TEST(SignatureAlgorithmTest, ParseDerMd4WithRsaEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a md2WithRSAEncryption which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.113549.1.1.2
//       NULL
TEST(SignatureAlgorithmTest, ParseDerMd2WithRsaEncryptionNullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0D,  // SEQUENCE (13 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x02,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a dsaWithSha1 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  1.2.840.10040.4.3
TEST(SignatureAlgorithmTest, ParseDerDsaWithSha1NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x09,  // SEQUENCE (9 bytes)
      0x06, 0x07,  // OBJECT IDENTIFIER (7 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x03,
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a dsaWithSha1 which contains a NULL parameters field.
//
//   SEQUENCE (2 elem)
//       OBJECT IDENTIFIER  1.2.840.10040.4.3
//       NULL
TEST(SignatureAlgorithmTest, ParseDerDsaWithSha1NullParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (9 bytes)
      0x06, 0x07,  // OBJECT IDENTIFIER (7 bytes)
      0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x03,
      0x05, 0x00,  // NULL (0 bytes)
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

// Parses a dsaWithSha256 which contains no parameters field.
//
//   SEQUENCE (1 elem)
//       OBJECT IDENTIFIER  2.16.840.1.101.3.4.3.2
TEST(SignatureAlgorithmTest, ParseDerDsaWithSha256NoParams) {
  // clang-format off
  const uint8_t kData[] = {
      0x30, 0x0B,  // SEQUENCE (11 bytes)
      0x06, 0x09,  // OBJECT IDENTIFIER (9 bytes)
      0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x02
  };
  // clang-format on
  EXPECT_FALSE(ParseSignatureAlgorithm(der::Input(kData)));
}

}  // namespace

BSSL_NAMESPACE_END
