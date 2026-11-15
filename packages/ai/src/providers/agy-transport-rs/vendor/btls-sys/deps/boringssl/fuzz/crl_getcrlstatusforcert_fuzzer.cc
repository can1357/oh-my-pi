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

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

#include "../pki/crl.h"
#include "../pki/input.h"
#include <openssl/sha2.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const bssl::der::Input input_der(data, size);

  uint8_t data_hash[SHA256_DIGEST_LENGTH];
  SHA256(data, size, data_hash);
  const bssl::CrlVersion crl_version =
      (data_hash[0] % 2) ? bssl::CrlVersion::V2 : bssl::CrlVersion::V1;
  const size_t serial_len = data_hash[1] % (sizeof(data_hash) - 2);
  assert(serial_len + 2 < sizeof(data_hash));
  const bssl::der::Input cert_serial(
      reinterpret_cast<const uint8_t*>(data_hash + 2), serial_len);

  bssl::GetCRLStatusForCert(cert_serial, crl_version,
                           std::make_optional(input_der));

  return 0;
}
