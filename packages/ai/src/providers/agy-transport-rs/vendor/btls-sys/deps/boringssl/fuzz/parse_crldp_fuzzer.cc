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

#include <stddef.h>
#include <stdint.h>

#include "../pki/parse_certificate.h"
#include "../pki/input.h"
#include <openssl/base.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  std::vector<bssl::ParsedDistributionPoint> distribution_points;

  bool success = ParseCrlDistributionPoints(bssl::der::Input(data, size),
                                            &distribution_points);

  if (success) {
    // A valid CRLDistributionPoints must have at least 1 element.
    BSSL_CHECK(!distribution_points.empty());
  }

  return 0;
}
