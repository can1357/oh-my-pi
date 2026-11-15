// Copyright 2023 The Chromium Authors
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

#include "ip_util.h"

#include <string.h>

#include <gtest/gtest.h>
#include "input.h"

BSSL_NAMESPACE_BEGIN

TEST(IPUtilTest, IsValidNetmask) {
  uint8_t kWrongSize[3] = {0xff, 0xff, 0xff};
  EXPECT_FALSE(IsValidNetmask(der::Input(kWrongSize)));

  // All zeros is a valid netmask.
  uint8_t kZeroIPv4[4] = {0};
  EXPECT_TRUE(IsValidNetmask(der::Input(kZeroIPv4)));
  uint8_t kZeroIPv6[16] = {0};
  EXPECT_TRUE(IsValidNetmask(der::Input(kZeroIPv6)));

  // Test all valid non-zero IPv4 netmasks.
  for (int i = 0; i < 4; i++) {
    uint8_t addr[4] = {0};
    memset(addr, 0xff, i);
    for (int shift = 0; shift < 8; shift++) {
      addr[i] = 0xff << shift;
      EXPECT_TRUE(IsValidNetmask(der::Input(addr)));
    }
  }

  // Test all valid non-zero IPv6 netmasks.
  for (int i = 0; i < 16; i++) {
    uint8_t addr[16] = {0};
    memset(addr, 0xff, i);
    for (int shift = 0; shift < 8; shift++) {
      addr[i] = 0xff << shift;
      EXPECT_TRUE(IsValidNetmask(der::Input(addr)));
    }
  }

  // Error within a byte.
  uint8_t kInvalidIPv4[4] = {0xff, 0xff, 0x81, 0x00};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv4)));
  uint8_t kInvalidIPv6[16] = {0xff, 0xff, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00,
                              0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv6)));

  // Error at the end.
  uint8_t kInvalidIPv4_2[4] = {0xff, 0xff, 0x80, 0x01};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv4_2)));
  uint8_t kInvalidIPv6_2[16] = {0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
                                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv6_2)));

  // Leading zero.
  uint8_t kInvalidIPv4_3[4] = {0x00, 0xff, 0x80, 0x00};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv4_3)));
  uint8_t kInvalidIPv6_3[16] = {0x00, 0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
                                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
  EXPECT_FALSE(IsValidNetmask(der::Input(kInvalidIPv6_3)));
}

TEST(IPUtilTest, IPAddressMatchesWithNetmask) {
  // Under a zero mask, any two addresses are equal.
  {
    uint8_t kMask[4] = {0};
    uint8_t kAddr1[4] = {1, 2, 3, 4};
    uint8_t kAddr2[4] = {255, 254, 253, 252};
    EXPECT_TRUE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr1), der::Input(kMask)));
    EXPECT_TRUE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr2), der::Input(kMask)));
  }

  // Under an all ones mask, all bits of the address are checked.
  {
    uint8_t kMask[4] = {0xff, 0xff, 0xff, 0xff};
    uint8_t kAddr1[4] = {1, 2, 3, 4};
    uint8_t kAddr2[4] = {255, 254, 253, 252};
    uint8_t kAddr3[4] = {1, 2, 3, 5};
    EXPECT_TRUE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr1), der::Input(kMask)));
    EXPECT_FALSE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr2), der::Input(kMask)));
    EXPECT_FALSE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr3), der::Input(kMask)));
  }

  // In general, only masked bits are considered.
  {
    uint8_t kMask[4] = {0xff, 0xff, 0x80, 0x00};
    uint8_t kAddr1[4] = {1, 2, 3, 4};
    uint8_t kAddr2[4] = {1, 2, 0x7f, 0xff};
    uint8_t kAddr3[4] = {2, 2, 3, 4};
    EXPECT_TRUE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr1), der::Input(kMask)));
    EXPECT_TRUE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr2), der::Input(kMask)));
    EXPECT_FALSE(IPAddressMatchesWithNetmask(
        der::Input(kAddr1), der::Input(kAddr3), der::Input(kMask)));
  }
}

BSSL_NAMESPACE_END
