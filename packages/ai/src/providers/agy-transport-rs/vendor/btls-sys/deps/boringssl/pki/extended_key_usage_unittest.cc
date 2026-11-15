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

#include <algorithm>

#include <gtest/gtest.h>
#include "extended_key_usage.h"
#include "input.h"

BSSL_NAMESPACE_BEGIN

namespace {

// Helper method to check if an EKU is present in a std::vector of EKUs.
bool HasEKU(const std::vector<der::Input> &list, der::Input eku) {
  for (const auto &oid : list) {
    if (oid == eku) {
      return true;
    }
  }
  return false;
}

// Check that we can read multiple EKUs from an extension.
TEST(ExtendedKeyUsageTest, ParseEKUExtension) {
  // clang-format off
  const uint8_t raw_extension_value[] = {
      0x30, 0x14,  // SEQUENCE (20 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,  // 1.3.6.1.5.5.7.3.1
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02  // 1.3.6.1.5.5.7.3.2
      // end of SEQUENCE
  };
  // clang-format on
  der::Input extension_value(raw_extension_value);

  std::vector<der::Input> ekus;
  EXPECT_TRUE(ParseEKUExtension(extension_value, &ekus));

  EXPECT_EQ(2u, ekus.size());
  EXPECT_TRUE(HasEKU(ekus, der::Input(kServerAuth)));
  EXPECT_TRUE(HasEKU(ekus, der::Input(kClientAuth)));
}

// Check that an extension with the same OID present multiple times doesn't
// cause an error.
TEST(ExtendedKeyUsageTest, RepeatedOid) {
  // clang-format off
  const uint8_t extension_bytes[] = {
      0x30, 0x14,  // SEQUENCE (20 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,  // 1.3.6.1.5.5.7.3.1
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01  // 1.3.6.1.5.5.7.3.1
  };
  // clang-format on
  der::Input extension(extension_bytes);

  std::vector<der::Input> ekus;
  EXPECT_TRUE(ParseEKUExtension(extension, &ekus));
  EXPECT_EQ(2u, ekus.size());
  for (const auto &eku : ekus) {
    EXPECT_EQ(der::Input(kServerAuth), eku);
  }
}

// Check that parsing an EKU extension which contains a private OID doesn't
// cause an error.
TEST(ExtendedKeyUsageTest, ParseEKUExtensionGracefullyHandlesPrivateOids) {
  // clang-format off
  const uint8_t extension_bytes[] = {
    0x30, 0x13,  // SEQUENCE (19 bytes)
    0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
    0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,  // 1.3.6.1.5.5.7.3.1
    0x06, 0x07,  // OBJECT IDENTIFIER (7 bytes)
    0x2B, 0x06, 0x01, 0x04, 0x01, 0xD6, 0x79  // 1.3.6.1.4.1.11129
  };
  // clang-format on
  der::Input extension(extension_bytes);

  std::vector<der::Input> ekus;
  EXPECT_TRUE(ParseEKUExtension(extension, &ekus));
  EXPECT_EQ(2u, ekus.size());
  EXPECT_TRUE(HasEKU(ekus, der::Input(kServerAuth)));

  const uint8_t google_oid[] = {0x2B, 0x06, 0x01, 0x04, 0x01, 0xD6, 0x79};
  der::Input google(google_oid);
  EXPECT_TRUE(HasEKU(ekus, google));
}

// Test a variety of bad inputs.

// If the extension value has data following the sequence of oids, parsing it
// should fail.
TEST(ExtendedKeyUsageTest, ExtraData) {
  // clang-format off
  const uint8_t extra_data[] = {
      0x30, 0x14,  // SEQUENCE (20 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,  // 1.3.6.1.5.5.7.3.1
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02,  // 1.3.6.1.5.5.7.3.2
      // end of SEQUENCE
      0x02, 0x01,  // INTEGER (1 byte)
      0x01  // 1
  };
  // clang-format on

  std::vector<der::Input> ekus;
  EXPECT_FALSE(ParseEKUExtension(der::Input(extra_data), &ekus));
}

// Check that ParseEKUExtension only accepts a sequence containing only oids.
// This test case has an integer in the sequence (which should fail). A key
// difference between this test case and ExtendedKeyUsageTest.ExtraData is where
// the sequence ends - in this test case the integer is still part of the
// sequence, while in ExtendedKeyUsageTest.ExtraData the integer is after the
// sequence.
TEST(ExtendedKeyUsageTest, NotAnOid) {
  // clang-format off
  const uint8_t not_an_oid[] = {
      0x30, 0x0d,  // SEQUENCE (13 bytes)
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,  // 1.3.6.1.5.5.7.3.1
      0x02, 0x01,  // INTEGER (1 byte)
      0x01  // 1
      // end of SEQUENCE
  };
  // clang-format on

  std::vector<der::Input> ekus;
  EXPECT_FALSE(ParseEKUExtension(der::Input(not_an_oid), &ekus));
}

// Checks that the list of oids passed to ParseEKUExtension are in a sequence,
// instead of one or more oid tag-length-values concatenated together.
TEST(ExtendedKeyUsageTest, NotASequence) {
  // clang-format off
  const uint8_t not_a_sequence[] = {
      0x06, 0x08,  // OBJECT IDENTIFIER (8 bytes)
      0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01  // 1.3.6.1.5.5.7.3.1
  };
  // clang-format on

  std::vector<der::Input> ekus;
  EXPECT_FALSE(ParseEKUExtension(der::Input(not_a_sequence), &ekus));
}

// A sequence passed into ParseEKUExtension must have at least one oid in it.
TEST(ExtendedKeyUsageTest, EmptySequence) {
  const uint8_t empty_sequence[] = {0x30, 0x00};  // SEQUENCE (0 bytes)

  std::vector<der::Input> ekus;
  EXPECT_FALSE(ParseEKUExtension(der::Input(empty_sequence), &ekus));
}

// The extension value must not be empty.
TEST(ExtendedKeyUsageTest, EmptyExtension) {
  std::vector<der::Input> ekus;
  EXPECT_FALSE(ParseEKUExtension(der::Input(), &ekus));
}

}  // namespace

BSSL_NAMESPACE_END
