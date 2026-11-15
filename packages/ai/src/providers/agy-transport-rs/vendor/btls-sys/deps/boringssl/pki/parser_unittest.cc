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

#include "parser.h"

#include <gtest/gtest.h>
#include "input.h"
#include "parse_values.h"

BSSL_NAMESPACE_BEGIN
namespace der::test {

TEST(ParserTest, ConsumesAllBytesOfTLV) {
  const uint8_t der[] = {0x04 /* OCTET STRING */, 0x00};
  Parser parser((Input(der)));
  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_EQ(CBS_ASN1_OCTETSTRING, tag);
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, CanReadRawTLV) {
  const uint8_t der[] = {0x02, 0x01, 0x01};
  Parser parser((Input(der)));
  Input tlv;
  ASSERT_TRUE(parser.ReadRawTLV(&tlv));
  ByteReader tlv_reader(tlv);
  size_t tlv_len = tlv_reader.BytesLeft();
  ASSERT_EQ(3u, tlv_len);
  Input tlv_data;
  ASSERT_TRUE(tlv_reader.ReadBytes(tlv_len, &tlv_data));
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, IgnoresContentsOfInnerValues) {
  // This is a SEQUENCE which has one member. The member is another SEQUENCE
  // with an invalid encoding - its length is too long.
  const uint8_t der[] = {0x30, 0x02, 0x30, 0x7e};
  Parser parser((Input(der)));
  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
}

TEST(ParserTest, FailsIfLengthOverlapsAnotherTLV) {
  // This DER encoding has 2 top-level TLV tuples. The first is a SEQUENCE;
  // the second is an INTEGER. The SEQUENCE contains an INTEGER, but its length
  // is longer than what it has contents for.
  const uint8_t der[] = {0x30, 0x02, 0x02, 0x01, 0x02, 0x01, 0x01};
  Parser parser((Input(der)));

  Parser inner_sequence;
  ASSERT_TRUE(parser.ReadSequence(&inner_sequence));
  uint64_t int_value;
  ASSERT_TRUE(parser.ReadUint64(&int_value));
  ASSERT_EQ(1u, int_value);
  ASSERT_FALSE(parser.HasMore());

  // Try to read the INTEGER from the SEQUENCE, which should fail.
  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(inner_sequence.ReadTagAndValue(&tag, &value));
}

TEST(ParserTest, ReadOptionalTagPresent) {
  // DER encoding of 2 top-level TLV values:
  // INTEGER { 1 }
  // OCTET_STRING { `02` }
  const uint8_t der[] = {0x02, 0x01, 0x01, 0x04, 0x01, 0x02};
  Parser parser((Input(der)));

  Input value;
  bool present;
  ASSERT_TRUE(parser.ReadOptionalTag(CBS_ASN1_INTEGER, &value, &present));
  ASSERT_TRUE(present);
  const uint8_t expected_int_value[] = {0x01};
  ASSERT_EQ(Input(expected_int_value), value);

  CBS_ASN1_TAG tag;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_EQ(CBS_ASN1_OCTETSTRING, tag);
  const uint8_t expected_octet_string_value[] = {0x02};
  ASSERT_EQ(Input(expected_octet_string_value), value);

  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, ReadOptionalTag2Present) {
  // DER encoding of 2 top-level TLV values:
  // INTEGER { 1 }
  // OCTET_STRING { `02` }
  const uint8_t der[] = {0x02, 0x01, 0x01, 0x04, 0x01, 0x02};
  Parser parser((Input(der)));

  std::optional<Input> optional_value;
  ASSERT_TRUE(parser.ReadOptionalTag(CBS_ASN1_INTEGER, &optional_value));
  ASSERT_TRUE(optional_value.has_value());
  const uint8_t expected_int_value[] = {0x01};
  ASSERT_EQ(Input(expected_int_value), *optional_value);

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_EQ(CBS_ASN1_OCTETSTRING, tag);
  const uint8_t expected_octet_string_value[] = {0x02};
  ASSERT_EQ(Input(expected_octet_string_value), value);

  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, ReadOptionalTagNotPresent) {
  // DER encoding of 1 top-level TLV value:
  // OCTET_STRING { `02` }
  const uint8_t der[] = {0x04, 0x01, 0x02};
  Parser parser((Input(der)));

  Input value;
  bool present;
  ASSERT_TRUE(parser.ReadOptionalTag(CBS_ASN1_INTEGER, &value, &present));
  ASSERT_FALSE(present);

  CBS_ASN1_TAG tag;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_EQ(CBS_ASN1_OCTETSTRING, tag);
  const uint8_t expected_octet_string_value[] = {0x02};
  ASSERT_EQ(Input(expected_octet_string_value), value);

  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, ReadOptionalTag2NotPresent) {
  // DER encoding of 1 top-level TLV value:
  // OCTET_STRING { `02` }
  const uint8_t der[] = {0x04, 0x01, 0x02};
  Parser parser((Input(der)));

  std::optional<Input> optional_value;
  ASSERT_TRUE(parser.ReadOptionalTag(CBS_ASN1_INTEGER, &optional_value));
  ASSERT_FALSE(optional_value.has_value());

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_EQ(CBS_ASN1_OCTETSTRING, tag);
  const uint8_t expected_octet_string_value[] = {0x02};
  ASSERT_EQ(Input(expected_octet_string_value), value);

  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, CanSkipOptionalTagAtEndOfInput) {
  const uint8_t der[] = {0x02 /* INTEGER */, 0x01, 0x01};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  bool present;
  ASSERT_TRUE(parser.ReadOptionalTag(CBS_ASN1_INTEGER, &value, &present));
  ASSERT_FALSE(present);
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, SkipOptionalTagDoesntConsumePresentNonMatchingTLVs) {
  const uint8_t der[] = {0x02 /* INTEGER */, 0x01, 0x01};
  Parser parser((Input(der)));

  bool present;
  ASSERT_TRUE(parser.SkipOptionalTag(CBS_ASN1_OCTETSTRING, &present));
  ASSERT_FALSE(present);
  ASSERT_TRUE(parser.SkipOptionalTag(CBS_ASN1_INTEGER, &present));
  ASSERT_TRUE(present);
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, TagNumbersAboveThirtySupported) {
  // Context-specific class, tag number 31, length 0.
  const uint8_t der[] = {0x9f, 0x1f, 0x00};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
  EXPECT_EQ(CBS_ASN1_CONTEXT_SPECIFIC | 31u, tag);
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, ParseTags) {
  {
    // Universal primitive tag, tag number 4.
    const uint8_t der[] = {0x04, 0x00};
    Parser parser((Input(der)));

    CBS_ASN1_TAG tag;
    Input value;
    ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
    EXPECT_EQ(CBS_ASN1_OCTETSTRING, tag);
  }

  {
    // Universal constructed tag, tag number 16.
    const uint8_t der[] = {0x30, 0x00};
    Parser parser((Input(der)));

    CBS_ASN1_TAG tag;
    Input value;
    ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
    EXPECT_EQ(CBS_ASN1_SEQUENCE, tag);
  }

  {
    // Application primitive tag, tag number 1.
    const uint8_t der[] = {0x41, 0x00};
    Parser parser((Input(der)));

    CBS_ASN1_TAG tag;
    Input value;
    ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
    EXPECT_EQ(CBS_ASN1_APPLICATION | 1, tag);
  }

  {
    // Context-specific constructed tag, tag number 30.
    const uint8_t der[] = {0xbe, 0x00};
    Parser parser((Input(der)));

    CBS_ASN1_TAG tag;
    Input value;
    ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
    EXPECT_EQ(CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 30, tag);
  }

  {
    // Private primitive tag, tag number 15.
    const uint8_t der[] = {0xcf, 0x00};
    Parser parser((Input(der)));

    CBS_ASN1_TAG tag;
    Input value;
    ASSERT_TRUE(parser.ReadTagAndValue(&tag, &value));
    EXPECT_EQ(CBS_ASN1_PRIVATE | 15, tag);
  }
}

TEST(ParserTest, IncompleteEncodingTagOnly) {
  const uint8_t der[] = {0x01};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_TRUE(parser.HasMore());
}

TEST(ParserTest, IncompleteEncodingLengthTruncated) {
  // Tag: octet string; length: long form, should have 2 total octets, but
  // the last one is missing. (There's also no value.)
  const uint8_t der[] = {0x04, 0x81};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_TRUE(parser.HasMore());
}

TEST(ParserTest, IncompleteEncodingValueShorterThanLength) {
  // Tag: octet string; length: 2; value: first octet 'T', second octet missing.
  const uint8_t der[] = {0x04, 0x02, 0x84};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_TRUE(parser.HasMore());
}

TEST(ParserTest, LengthMustBeEncodedWithMinimumNumberOfOctets) {
  const uint8_t der[] = {0x01, 0x81, 0x01, 0x00};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_TRUE(parser.HasMore());
}

TEST(ParserTest, LengthMustNotHaveLeadingZeroes) {
  // Tag: octet string; length: 3 bytes of length encoding a value of 128
  // (it should be encoded in only 2 bytes). Value: 128 bytes of 0.
  const uint8_t der[] = {
      0x04, 0x83, 0x80, 0x81, 0x80,  // group the 0s separately
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  Parser parser((Input(der)));

  CBS_ASN1_TAG tag;
  Input value;
  ASSERT_FALSE(parser.ReadTagAndValue(&tag, &value));
  ASSERT_TRUE(parser.HasMore());
}

TEST(ParserTest, ReadConstructedFailsForNonConstructedTags) {
  // Tag number is for SEQUENCE, but the constructed bit isn't set.
  const uint8_t der[] = {0x10, 0x00};
  Parser parser((Input(der)));

  CBS_ASN1_TAG expected_tag = 0x10;
  Parser sequence_parser;
  ASSERT_FALSE(parser.ReadConstructed(expected_tag, &sequence_parser));

  // Check that we didn't fail above because of a tag mismatch or an improperly
  // encoded TLV.
  Input value;
  ASSERT_TRUE(parser.ReadTag(expected_tag, &value));
  ASSERT_FALSE(parser.HasMore());
}

TEST(ParserTest, CannotAdvanceAfterReadOptionalTag) {
  const uint8_t der[] = {0x02, 0x01, 0x01};
  Parser parser((Input(der)));

  Input value;
  bool present;
  ASSERT_TRUE(parser.ReadOptionalTag(0x04, &value, &present));
  ASSERT_FALSE(present);
  ASSERT_FALSE(parser.Advance());
}

// Reads a valid BIT STRING with 1 unused bit.
TEST(ParserTest, ReadBitString) {
  const uint8_t der[] = {0x03, 0x03, 0x01, 0xAA, 0xBE};
  Parser parser((Input(der)));

  std::optional<BitString> bit_string = parser.ReadBitString();
  ASSERT_TRUE(bit_string.has_value());
  EXPECT_FALSE(parser.HasMore());

  EXPECT_EQ(1u, bit_string->unused_bits());
  ASSERT_EQ(2u, bit_string->bytes().size());
  EXPECT_EQ(0xAA, bit_string->bytes()[0]);
  EXPECT_EQ(0xBE, bit_string->bytes()[1]);
}

// Tries reading a BIT STRING. This should fail because the tag is not for a
// BIT STRING.
TEST(ParserTest, ReadBitStringBadTag) {
  const uint8_t der[] = {0x05, 0x03, 0x01, 0xAA, 0xBE};
  Parser parser((Input(der)));

  std::optional<BitString> bit_string = parser.ReadBitString();
  EXPECT_FALSE(bit_string.has_value());
}

}  // namespace der::test
BSSL_NAMESPACE_END
