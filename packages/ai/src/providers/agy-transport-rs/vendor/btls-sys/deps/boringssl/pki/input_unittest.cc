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

#include "input.h"

#include <gtest/gtest.h>

BSSL_NAMESPACE_BEGIN
namespace der::test {

constexpr uint8_t kInput[] = {'t', 'e', 's', 't'};
const uint8_t kInput2[] = {'t', 'e', 'a', 'l'};

TEST(InputTest, Equals) {
  Input test(kInput);
  Input test2(kInput);
  EXPECT_EQ(test, test2);

  uint8_t input_copy[std::size(kInput)] = {0};
  memcpy(input_copy, kInput, std::size(kInput));
  Input test_copy(input_copy);
  EXPECT_EQ(test, test_copy);

  Input test_truncated(kInput, std::size(kInput) - 1);
  EXPECT_NE(test, test_truncated);
  EXPECT_NE(test_truncated, test);
}

TEST(InputTest, LessThan) {
  Input test(kInput);
  EXPECT_FALSE(test < test);

  Input test2(kInput2);
  EXPECT_FALSE(test < test2);
  EXPECT_TRUE(test2 < test);

  Input test_truncated(kInput, std::size(kInput) - 1);
  EXPECT_FALSE(test < test_truncated);
  EXPECT_TRUE(test_truncated < test);
}

TEST(InputTest, AsString) {
  Input input(kInput);
  EXPECT_EQ(bssl::BytesAsStringView(kInput), input.AsString());
}

TEST(InputTest, StaticArray) {
  Input input(kInput);
  EXPECT_EQ(std::size(kInput), input.size());

  Input input2(kInput);
  EXPECT_EQ(input, input2);
}

TEST(InputTest, ConstExpr) {
  constexpr Input default_input;
  static_assert(default_input.size() == 0);
  static_assert(default_input.data() == nullptr);

  constexpr Input const_array_input(kInput);
  static_assert(const_array_input.size() == 4);
  static_assert(const_array_input.data() == kInput);
  static_assert(default_input < const_array_input);

  constexpr Input ptr_len_input(kInput, 2);
  static_assert(ptr_len_input.size() == 2);
  static_assert(ptr_len_input.data() == kInput);
  static_assert(ptr_len_input < const_array_input);

  Input runtime_input(kInput2, 2);
  EXPECT_EQ(runtime_input, ptr_len_input);
}

TEST(ByteReaderTest, NoReadPastEnd) {
  ByteReader reader(Input(nullptr, 0));
  uint8_t data;
  EXPECT_FALSE(reader.ReadByte(&data));
}

TEST(ByteReaderTest, ReadToEnd) {
  uint8_t out;
  ByteReader reader((Input(kInput)));
  for (uint8_t input : kInput) {
    ASSERT_TRUE(reader.ReadByte(&out));
    ASSERT_EQ(input, out);
  }
  EXPECT_FALSE(reader.ReadByte(&out));
}

TEST(ByteReaderTest, PartialReadFails) {
  Input out;
  ByteReader reader((Input(kInput)));
  EXPECT_FALSE(reader.ReadBytes(5, &out));
}

TEST(ByteReaderTest, HasMore) {
  Input out;
  ByteReader reader((Input(kInput)));

  ASSERT_TRUE(reader.HasMore());
  ASSERT_TRUE(reader.ReadBytes(std::size(kInput), &out));
  ASSERT_FALSE(reader.HasMore());
}

}  // namespace der::test
BSSL_NAMESPACE_END
