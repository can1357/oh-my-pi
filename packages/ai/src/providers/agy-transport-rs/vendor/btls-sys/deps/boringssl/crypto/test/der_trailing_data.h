// Copyright 2025 The BoringSSL Authors
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

#ifndef OPENSSL_HEADER_CRYPTO_TEST_DER_TRAILING_DATA_H
#define OPENSSL_HEADER_CRYPTO_TEST_DER_TRAILING_DATA_H

#include <functional>

#include <openssl/span.h>

// TestDERTrailingData decodes |in| as an arbitrary DER structure. It then calls
// |func| multiple times on different modified versions of |in|, each time with
// extra data appended to a different constructed element. The extra data will
// be a BER EOC, so this is guaranteed to make the structure invalid.
//
// |func| is expected to parse its argument and then assert with GTest that the
// parser failed. |n|, passed to |func|, is the number of the constructed
// element that was rewritten, following a pre-order numbering from zero. |func|
// should pass it to |SCOPED_TRACE| to aid debugging.
//
// TestDERTrailingData returns whether it successful rewrote |in| and called
// |func| for every constructed element.
bool TestDERTrailingData(
    bssl::Span<const uint8_t> in,
    std::function<void(bssl::Span<const uint8_t> rewritten, size_t n)> func);

#endif  // OPENSSL_HEADER_CRYPTO_TEST_DER_TRAILING_DATA_H
