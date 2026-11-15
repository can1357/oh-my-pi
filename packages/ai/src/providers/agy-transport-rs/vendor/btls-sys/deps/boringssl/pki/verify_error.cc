// Copyright 2024 The BoringSSL Authors
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

#include <openssl/base.h>
#include <openssl/pki/verify_error.h>

BSSL_NAMESPACE_BEGIN

VerifyError::VerifyError(StatusCode code, ptrdiff_t offset,
                         std::string diagnostic)
    : offset_(offset), code_(code), diagnostic_(std::move(diagnostic)) {}

const std::string &VerifyError::DiagnosticString() const { return diagnostic_; }

ptrdiff_t VerifyError::Index() const { return offset_; }

VerifyError::StatusCode VerifyError::Code() const { return code_; }

BSSL_NAMESPACE_END
