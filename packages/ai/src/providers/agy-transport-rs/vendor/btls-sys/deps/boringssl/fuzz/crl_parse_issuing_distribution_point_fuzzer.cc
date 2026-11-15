// Copyright 2019 The Chromium Authors
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
#include <stdlib.h>

#include "../pki/crl.h"
#include "../pki/input.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  bssl::der::Input idp_der(data, size);

  std::unique_ptr<bssl::GeneralNames> distribution_point_names;
  bssl::ContainedCertsType only_contains_cert_type;

  if (bssl::ParseIssuingDistributionPoint(idp_der, &distribution_point_names,
                                         &only_contains_cert_type)) {
    bool has_distribution_point_names =
        distribution_point_names &&
        distribution_point_names->present_name_types != bssl::GENERAL_NAME_NONE;
    if (!has_distribution_point_names &&
        only_contains_cert_type == bssl::ContainedCertsType::ANY_CERTS) {
      abort();
    }
  }
  return 0;
}
