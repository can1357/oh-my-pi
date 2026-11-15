// Copyright 2010 The Chromium Authors
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

#include "pem.h"

#include <array>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

BSSL_NAMESPACE_BEGIN

TEST(PEMTokenizerTest, BasicParsing) {
  const char data[] =
      "-----BEGIN EXPECTED-BLOCK-----\n"
      "TWF0Y2hlc0FjY2VwdGVkQmxvY2tUeXBl\n"
      "-----END EXPECTED-BLOCK-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("EXPECTED-BLOCK");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("EXPECTED-BLOCK", tokenizer.block_type());
  EXPECT_EQ("MatchesAcceptedBlockType", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, CarriageReturnLineFeeds) {
  const char data[] =
      "-----BEGIN EXPECTED-BLOCK-----\r\n"
      "TWF0Y2hlc0FjY2VwdGVkQmxvY2tUeXBl\r\n"
      "-----END EXPECTED-BLOCK-----\r\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("EXPECTED-BLOCK");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("EXPECTED-BLOCK", tokenizer.block_type());
  EXPECT_EQ("MatchesAcceptedBlockType", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, NoAcceptedBlockTypes) {
  const char data[] =
      "-----BEGIN UNEXPECTED-BLOCK-----\n"
      "SWdub3Jlc1JlamVjdGVkQmxvY2tUeXBl\n"
      "-----END UNEXPECTED-BLOCK-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("EXPECTED-BLOCK");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, MultipleAcceptedBlockTypes) {
  const char data[] =
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----END BLOCK-ONE-----\n"
      "-----BEGIN BLOCK-TWO-----\n"
      "RW5jb2RlZERhdGFUd28=\n"
      "-----END BLOCK-TWO-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("BLOCK-ONE");
  accepted_types.push_back("BLOCK-TWO");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("BLOCK-ONE", tokenizer.block_type());
  EXPECT_EQ("EncodedDataOne", tokenizer.data());

  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("BLOCK-TWO", tokenizer.block_type());
  EXPECT_EQ("EncodedDataTwo", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, MissingFooter) {
  const char data[] =
      "-----BEGIN MISSING-FOOTER-----\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----END MISSING-FOOTER-----\n"
      "-----BEGIN MISSING-FOOTER-----\n"
      "RW5jb2RlZERhdGFUd28=\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("MISSING-FOOTER");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("MISSING-FOOTER", tokenizer.block_type());
  EXPECT_EQ("EncodedDataOne", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, NestedEncoding) {
  const char data[] =
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----BEGIN BLOCK-TWO-----\n"
      "RW5jb2RlZERhdGFUd28=\n"
      "-----END BLOCK-TWO-----\n"
      "-----END BLOCK-ONE-----\n"
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFUaHJlZQ==\n"
      "-----END BLOCK-ONE-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("BLOCK-ONE");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("BLOCK-ONE", tokenizer.block_type());
  EXPECT_EQ("EncodedDataThree", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, EmptyAcceptedTypes) {
  const char data[] =
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----END BLOCK-ONE-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, BlockWithHeader) {
  const char data[] =
      "-----BEGIN BLOCK-ONE-----\n"
      "Header-One: Data data data\n"
      "Header-Two: \n"
      "  continuation\n"
      "Header-Three: Mix-And,Match\n"
      "\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----END BLOCK-ONE-----\n"
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFUd28=\n"
      "-----END BLOCK-ONE-----\n";
  std::string_view string_piece(data);
  std::vector<std::string> accepted_types;
  accepted_types.push_back("BLOCK-ONE");

  PEMTokenizer tokenizer(string_piece, accepted_types);
  EXPECT_TRUE(tokenizer.GetNext());

  EXPECT_EQ("BLOCK-ONE", tokenizer.block_type());
  EXPECT_EQ("EncodedDataTwo", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMTokenizerTest, SpanConstructor) {
  const std::string_view data =
      "-----BEGIN EXPECTED-BLOCK-----\n"
      "U3BhbkNvbnN0cnVjdG9y\n"
      "-----END EXPECTED-BLOCK-----\n";
  const std::array<std::string_view, 1> accepted_types = { "EXPECTED-BLOCK" };
  PEMTokenizer tokenizer(data, bssl::Span(accepted_types));
  EXPECT_TRUE(tokenizer.GetNext());
  EXPECT_EQ("EXPECTED-BLOCK", tokenizer.block_type());
  EXPECT_EQ("SpanConstructor", tokenizer.data());

  EXPECT_FALSE(tokenizer.GetNext());
}

TEST(PEMDecodeTest, BasicSingle) {
  const std::string_view data =
      "-----BEGIN SINGLE-----\n"
      "YmxvY2sgYm9keQ=="
      "-----END SINGLE-----\n"
      "-----BEGIN WRONG-----\n"
      "d3JvbmcgYmxvY2sgYm9keQ=="
      "-----END WRONG-----\n";
  std::optional<std::string> result = PEMDecodeSingle(data, "SINGLE");
  ASSERT_TRUE(result);
  EXPECT_EQ(*result, "block body");
}

TEST(PEMDecodeTest, BasicMulti) {
  const std::string_view data =
      "-----BEGIN MULTI-1-----\n"
      "YmxvY2sgYm9keSAx"
      "-----END MULTI-1-----\n"
      "-----BEGIN WRONG-----\n"
      "d3JvbmcgYmxvY2sgYm9keQ=="
      "-----END WRONG-----\n"
      "-----BEGIN MULTI-2-----\n"
      "YmxvY2sgYm9keSAy"
      "-----END MULTI-2-----\n";
  const std::array<std::string_view, 2> accepted_types = {"MULTI-1", "MULTI-2"};
  std::vector<PEMToken> result = PEMDecode(data, accepted_types);
  EXPECT_EQ(result.size(), 2u);
  EXPECT_EQ(result[0].type, "MULTI-1");
  EXPECT_EQ(result[0].data, "block body 1");
  EXPECT_EQ(result[1].type, "MULTI-2");
  EXPECT_EQ(result[1].data, "block body 2");
}

TEST(PEMDecodeTest, TypeMismatchSingle) {
  const std::string_view data =
      "-----BEGIN WRONG-----\n"
      "d3JvbmcgYmxvY2sgYm9keQ=="
      "-----END WRONG-----\n";
  std::optional<std::string> result = PEMDecodeSingle(data, "SINGLE");
  EXPECT_FALSE(result);
}

TEST(PEMDecodeTest, TooManySingle) {
  const std::string_view data =
      "-----BEGIN SINGLE-----\n"
      "YmV0dGVyIG5vdCBzZWUgdGhpcw=="
      "-----END SINGLE-----\n"
      "-----BEGIN SINGLE-----\n"
      "b3IgdGhpcw=="
      "-----END SINGLE-----\n";
  std::optional<std::string> result = PEMDecodeSingle(data, "SINGLE");
  EXPECT_FALSE(result);
}

TEST(PEMEncodeTest, Basic) {
  EXPECT_EQ(
      "-----BEGIN BLOCK-ONE-----\n"
      "RW5jb2RlZERhdGFPbmU=\n"
      "-----END BLOCK-ONE-----\n",
      PEMEncode("EncodedDataOne", "BLOCK-ONE"));
  EXPECT_EQ(
      "-----BEGIN BLOCK-TWO-----\n"
      "RW5jb2RlZERhdGFUd28=\n"
      "-----END BLOCK-TWO-----\n",
      PEMEncode("EncodedDataTwo", "BLOCK-TWO"));
}

TEST(PEMEncodeTest, Empty) {
  EXPECT_EQ(
      "-----BEGIN EMPTY-----\n"
      "-----END EMPTY-----\n",
      PEMEncode("", "EMPTY"));
}

TEST(PEMEncodeTest, Wrapping) {
  EXPECT_EQ(
      "-----BEGIN SINGLE LINE-----\n"
      "MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktM\n"
      "-----END SINGLE LINE-----\n",
      PEMEncode("1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
                "SINGLE LINE"));

  EXPECT_EQ(
      "-----BEGIN WRAPPED LINE-----\n"
      "MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktM\nTQ==\n"
      "-----END WRAPPED LINE-----\n",
      PEMEncode("1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM",
                "WRAPPED LINE"));
}

BSSL_NAMESPACE_END
