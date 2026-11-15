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

#include <stddef.h>
#include <stdint.h>

#include "../pki/cert_errors.h"
#include "../pki/parsed_certificate.h"
#include <openssl/base.h>
#include <openssl/pool.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  bssl::CertErrors errors;
  std::shared_ptr<const bssl::ParsedCertificate> cert =
      bssl::ParsedCertificate::Create(
          bssl::UniquePtr<CRYPTO_BUFFER>(
              CRYPTO_BUFFER_new(data, size, nullptr)),
          {}, &errors);

  // Severe errors must be provided iff the parsing failed.
  BSSL_CHECK(errors.ContainsAnyErrorWithSeverity(
                 bssl::CertError::SEVERITY_HIGH) == (cert == nullptr));

  return 0;
}
