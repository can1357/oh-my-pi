// Copyright 2016 The Chromium Authors
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

#include "parse_name.h"

#include <gtest/gtest.h>
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN

namespace {
// Loads test data from file. The filename is constructed from the parameters:
// |prefix| describes the type of data being tested, e.g. "ascii",
// "unicode_bmp", "unicode_supplementary", and "invalid".
// |value_type| indicates what ASN.1 type is used to encode the data.
// |suffix| indicates any additional modifications, such as caseswapping,
// whitespace adding, etc.
::testing::AssertionResult LoadTestData(const std::string &prefix,
                                        const std::string &value_type,
                                        const std::string &suffix,
                                        std::string *result) {
  std::string path = "testdata/verify_name_match_unittest/names/" + prefix +
                     "-" + value_type + "-" + suffix + ".pem";

  const PemBlockMapping mappings[] = {
      {"NAME", result},
  };

  return ReadTestDataFromPemFile(path, mappings);
}

}  // anonymous namespace

TEST(ParseNameTest, IA5SafeStringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0x6f, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_IA5STRING, der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Foo bar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("Foo bar", result);
}

TEST(ParseNameTest, IA5UnsafeStringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0xFF, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_IA5STRING, der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Fo\377 bar", result_unsafe);
  std::string result;
  ASSERT_FALSE(value.ValueAsString(&result));
}

TEST(ParseNameTest, PrintableSafeStringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0x6f, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_PRINTABLESTRING,
                          der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Foo bar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("Foo bar", result);
}

TEST(ParseNameTest, PrintableUnsafeStringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0x5f, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_PRINTABLESTRING,
                          der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Fo_ bar", result_unsafe);
  std::string result;
  ASSERT_FALSE(value.ValueAsString(&result));
}

TEST(ParseNameTest, PrintableStringUnsafeOptions) {
  const uint8_t der[] = {
      0x46, 0x6f, 0x5f, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_PRINTABLESTRING,
                          der::Input(der));
  std::string result;
  ASSERT_FALSE(value.ValueAsStringWithUnsafeOptions(
      X509NameAttribute::PrintableStringHandling::kDefault, &result));
  ASSERT_TRUE(value.ValueAsStringWithUnsafeOptions(
      X509NameAttribute::PrintableStringHandling::kAsUTF8Hack, &result));
  ASSERT_EQ("Fo_ bar", result);
}

TEST(ParseNameTest, TeletexSafeStringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0x6f, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_T61STRING, der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Foo bar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("Foo bar", result);
}

TEST(ParseNameTest, TeletexLatin1StringValue) {
  const uint8_t der[] = {
      0x46, 0x6f, 0xd6, 0x20, 0x62, 0x61, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_T61STRING, der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("Fo\xd6 bar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("FoÖ bar", result);
}

TEST(ParseNameTest, ConvertBmpString) {
  const uint8_t der[] = {
      0x00, 0x66, 0x00, 0x6f, 0x00, 0x6f, 0x00, 0x62, 0x00, 0x61, 0x00, 0x72,
  };
  X509NameAttribute value(der::Input(), CBS_ASN1_BMPSTRING, der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("foobar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("foobar", result);
}

// BmpString must encode characters in pairs of 2 bytes.
TEST(ParseNameTest, ConvertInvalidBmpString) {
  const uint8_t der[] = {0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72, 0x72};
  X509NameAttribute value(der::Input(), CBS_ASN1_BMPSTRING, der::Input(der));
  std::string result;
  ASSERT_FALSE(value.ValueAsStringUnsafe(&result));
  ASSERT_FALSE(value.ValueAsString(&result));
}

TEST(ParseNameTest, ConvertUniversalString) {
  const uint8_t der[] = {0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x6f,
                         0x00, 0x00, 0x00, 0x6f, 0x00, 0x00, 0x00, 0x62,
                         0x00, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00, 0x72};
  X509NameAttribute value(der::Input(), CBS_ASN1_UNIVERSALSTRING,
                          der::Input(der));
  std::string result_unsafe;
  ASSERT_TRUE(value.ValueAsStringUnsafe(&result_unsafe));
  ASSERT_EQ("foobar", result_unsafe);
  std::string result;
  ASSERT_TRUE(value.ValueAsString(&result));
  ASSERT_EQ("foobar", result);
}

// UniversalString must encode characters in pairs of 4 bytes.
TEST(ParseNameTest, ConvertInvalidUniversalString) {
  const uint8_t der[] = {0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72};
  X509NameAttribute value(der::Input(), CBS_ASN1_UNIVERSALSTRING,
                          der::Input(der));
  std::string result;
  ASSERT_FALSE(value.ValueAsStringUnsafe(&result));
  ASSERT_FALSE(value.ValueAsString(&result));
}

TEST(ParseNameTest, EmptyName) {
  const uint8_t der[] = {0x30, 0x00};
  der::Input rdn(der);
  RDNSequence atv;
  ASSERT_TRUE(ParseName(rdn, &atv));
  ASSERT_EQ(0u, atv.size());
}

TEST(ParseNameTest, ValidName) {
  const uint8_t der[] = {0x30, 0x3c, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55,
                         0x04, 0x06, 0x13, 0x02, 0x55, 0x53, 0x31, 0x14, 0x30,
                         0x12, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x13, 0x0b, 0x47,
                         0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x20, 0x49, 0x6e, 0x63,
                         0x2e, 0x31, 0x17, 0x30, 0x15, 0x06, 0x03, 0x55, 0x04,
                         0x03, 0x13, 0x0e, 0x47, 0x6f, 0x6f, 0x67, 0x6c, 0x65,
                         0x20, 0x54, 0x65, 0x73, 0x74, 0x20, 0x43, 0x41};
  der::Input rdn(der);
  RDNSequence atv;
  ASSERT_TRUE(ParseName(rdn, &atv));
  ASSERT_EQ(3u, atv.size());
  ASSERT_EQ(1u, atv[0].size());
  ASSERT_EQ(der::Input(kTypeCountryNameOid), atv[0][0].type);
  ASSERT_EQ("US", BytesAsStringView(atv[0][0].value));
  ASSERT_EQ(1u, atv[1].size());
  ASSERT_EQ(der::Input(kTypeOrganizationNameOid), atv[1][0].type);
  ASSERT_EQ("Google Inc.", BytesAsStringView(atv[1][0].value));
  ASSERT_EQ(1u, atv[2].size());
  ASSERT_EQ(der::Input(kTypeCommonNameOid), atv[2][0].type);
  ASSERT_EQ("Google Test CA", BytesAsStringView(atv[2][0].value));
}

TEST(ParseNameTest, InvalidNameExtraData) {
  std::string invalid;
  ASSERT_TRUE(
      LoadTestData("invalid", "AttributeTypeAndValue", "extradata", &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, InvalidNameEmpty) {
  std::string invalid;
  ASSERT_TRUE(
      LoadTestData("invalid", "AttributeTypeAndValue", "empty", &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, InvalidNameBadType) {
  std::string invalid;
  ASSERT_TRUE(LoadTestData("invalid", "AttributeTypeAndValue",
                           "badAttributeType", &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, InvalidNameNotSequence) {
  std::string invalid;
  ASSERT_TRUE(LoadTestData("invalid", "AttributeTypeAndValue", "setNotSequence",
                           &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, InvalidNameNotSet) {
  std::string invalid;
  ASSERT_TRUE(LoadTestData("invalid", "RDN", "sequenceInsteadOfSet", &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, InvalidNameEmptyRdn) {
  std::string invalid;
  ASSERT_TRUE(LoadTestData("invalid", "RDN", "empty", &invalid));
  RDNSequence atv;
  ASSERT_FALSE(ParseName(SequenceValueFromString(invalid), &atv));
}

TEST(ParseNameTest, RFC2253FormatBasic) {
  const uint8_t der[] = {0x30, 0x3b, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55,
                         0x04, 0x06, 0x13, 0x02, 0x47, 0x42, 0x31, 0x16, 0x30,
                         0x14, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x13, 0x0d, 0x49,
                         0x73, 0x6f, 0x64, 0x65, 0x20, 0x4c, 0x69, 0x6d, 0x69,
                         0x74, 0x65, 0x64, 0x31, 0x14, 0x30, 0x12, 0x06, 0x03,
                         0x55, 0x04, 0x03, 0x13, 0x0b, 0x53, 0x74, 0x65, 0x76,
                         0x65, 0x20, 0x4b, 0x69, 0x6c, 0x6c, 0x65};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("CN=Steve Kille,O=Isode Limited,C=GB", output);
}

TEST(ParseNameTest, RFC2253FormatMultiRDN) {
  const uint8_t der[] = {
      0x30, 0x44, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55, 0x04, 0x06, 0x13,
      0x02, 0x55, 0x53, 0x31, 0x14, 0x30, 0x12, 0x06, 0x03, 0x55, 0x04, 0x0a,
      0x13, 0x0b, 0x57, 0x69, 0x64, 0x67, 0x65, 0x74, 0x20, 0x49, 0x6e, 0x63,
      0x2e, 0x31, 0x1f, 0x30, 0x0c, 0x06, 0x03, 0x55, 0x04, 0x0b, 0x13, 0x05,
      0x53, 0x61, 0x6c, 0x65, 0x73, 0x30, 0x0f, 0x06, 0x03, 0x55, 0x04, 0x03,
      0x13, 0x08, 0x4a, 0x2e, 0x20, 0x53, 0x6d, 0x69, 0x74, 0x68};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("OU=Sales+CN=J. Smith,O=Widget Inc.,C=US", output);
}

TEST(ParseNameTest, RFC2253FormatQuoted) {
  const uint8_t der[] = {
      0x30, 0x40, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55, 0x04, 0x06,
      0x13, 0x02, 0x47, 0x42, 0x31, 0x1e, 0x30, 0x1c, 0x06, 0x03, 0x55,
      0x04, 0x0a, 0x13, 0x15, 0x53, 0x75, 0x65, 0x2c, 0x20, 0x47, 0x72,
      0x61, 0x62, 0x62, 0x69, 0x74, 0x20, 0x61, 0x6e, 0x64, 0x20, 0x52,
      0x75, 0x6e, 0x6e, 0x31, 0x11, 0x30, 0x0f, 0x06, 0x03, 0x55, 0x04,
      0x03, 0x13, 0x08, 0x4c, 0x2e, 0x20, 0x45, 0x61, 0x67, 0x6c, 0x65};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("CN=L. Eagle,O=Sue\\, Grabbit and Runn,C=GB", output);
}

TEST(ParseNameTest, RFC2253FormatNonPrintable) {
  const uint8_t der[] = {0x30, 0x33, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55,
                         0x04, 0x06, 0x13, 0x02, 0x47, 0x42, 0x31, 0x0d, 0x30,
                         0x0b, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x13, 0x04, 0x54,
                         0x65, 0x73, 0x74, 0x31, 0x15, 0x30, 0x13, 0x06, 0x03,
                         0x55, 0x04, 0x03, 0x13, 0x0c, 0x42, 0x65, 0x66, 0x6f,
                         0x72, 0x65, 0x0d, 0x41, 0x66, 0x74, 0x65, 0x72};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("CN=Before\\0DAfter,O=Test,C=GB", output);
}

TEST(ParseNameTest, RFC2253FormatUnknownOid) {
  const uint8_t der[] = {0x30, 0x30, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55,
                         0x04, 0x06, 0x13, 0x02, 0x47, 0x42, 0x31, 0x0d, 0x30,
                         0x0b, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x13, 0x04, 0x54,
                         0x65, 0x73, 0x74, 0x31, 0x12, 0x30, 0x10, 0x06, 0x08,
                         0x2b, 0x06, 0x01, 0x04, 0x01, 0x8b, 0x3a, 0x00, 0x13,
                         0x04, 0x04, 0x02, 0x48, 0x69};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("1.3.6.1.4.1.1466.0=#04024869,O=Test,C=GB", output);
}

TEST(ParseNameTest, RFC2253FormatLargeOid) {
  const uint8_t der[] = {0x30, 0x16, 0x31, 0x14, 0x30, 0x12, 0x06, 0x0a,
                         0x81, 0x0d, 0x06, 0x01, 0x99, 0x21, 0x01, 0x8b,
                         0x3a, 0x00, 0x13, 0x04, 0x74, 0x65, 0x73, 0x74};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("2.61.6.1.3233.1.1466.0=#74657374", output);
}

TEST(ParseNameTest, RFC2253FormatInvalidOid) {
  // Same DER as RFC2253FormatLargeOid but with the last byte of the OID
  // replaced with 0x80, which ends the OID with a truncated multi-byte
  // component.
  const uint8_t der[] = {0x30, 0x16, 0x31, 0x14, 0x30, 0x12, 0x06, 0x0a,
                         0x81, 0x0d, 0x06, 0x01, 0x99, 0x21, 0x01, 0x8b,
                         0x3a, 0x80, 0x13, 0x04, 0x74, 0x65, 0x73, 0x74};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  EXPECT_FALSE(ConvertToRFC2253(rdn, &output));
}

TEST(ParseNameTest, RFC2253FormatUTF8) {
  const uint8_t der[] = {0x30, 0x12, 0x31, 0x10, 0x30, 0x0e, 0x06,
                         0x03, 0x55, 0x04, 0x04, 0x13, 0x07, 0x4c,
                         0x75, 0xc4, 0x8d, 0x69, 0xc4, 0x87};
  der::Input rdn_input(der);
  RDNSequence rdn;
  ASSERT_TRUE(ParseName(rdn_input, &rdn));
  std::string output;
  ASSERT_TRUE(ConvertToRFC2253(rdn, &output));
  ASSERT_EQ("SN=Lu\\C4\\8Di\\C4\\87", output);
}

BSSL_NAMESPACE_END
