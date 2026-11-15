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

BSSL_NAMESPACE_BEGIN

bool IsValidNetmask(der::Input mask) {
  if (mask.size() != kIPv4AddressSize && mask.size() != kIPv6AddressSize) {
    return false;
  }

  for (size_t i = 0; i < mask.size(); i++) {
    uint8_t b = mask[i];
    if (b != 0xff) {
      // b must be all ones followed by all zeros, so ~b must be all zeros
      // followed by all ones.
      uint8_t inv = ~b;
      if ((inv & (inv + 1)) != 0) {
        return false;
      }
      // The remaining bytes must be all zeros.
      for (size_t j = i + 1; j < mask.size(); j++) {
        if (mask[j] != 0) {
          return false;
        }
      }
      return true;
    }
  }

  return true;
}

bool IPAddressMatchesWithNetmask(der::Input addr1, der::Input addr2,
                                 der::Input mask) {
  if (addr1.size() != addr2.size() || addr1.size() != mask.size()) {
    return false;
  }
  for (size_t i = 0; i < addr1.size(); i++) {
    if ((addr1[i] & mask[i]) != (addr2[i] & mask[i])) {
      return false;
    }
  }
  return true;
}

BSSL_NAMESPACE_END
