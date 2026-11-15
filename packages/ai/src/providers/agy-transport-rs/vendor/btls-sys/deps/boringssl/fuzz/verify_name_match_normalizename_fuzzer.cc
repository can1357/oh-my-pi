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

#include "../pki/verify_name_match.h"

#include "../pki/cert_errors.h"
#include "../pki/input.h"

// Entry point for LibFuzzer.
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  bssl::der::Input in(data, size);
  std::string normalized_der;
  bssl::CertErrors errors;
  bool success = bssl::NormalizeName(in, &normalized_der, &errors);
  if (success) {
    // If the input was successfully normalized, re-normalizing it should
    // produce the same output again.
    std::string renormalized_der;
    bool renormalize_success = bssl::NormalizeName(
        bssl::der::Input(normalized_der), &renormalized_der, &errors);
    if (!renormalize_success) {
      abort();
    }
    if (normalized_der != renormalized_der) {
      abort();
    }
  }
  return 0;
}
