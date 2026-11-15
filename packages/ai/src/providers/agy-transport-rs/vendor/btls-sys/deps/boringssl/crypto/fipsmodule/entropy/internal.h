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

#ifndef OPENSSL_HEADER_CRYPTO_FIPSMODULE_ENTROPY_INTERNAL_H
#define OPENSSL_HEADER_CRYPTO_FIPSMODULE_ENTROPY_INTERNAL_H

#include <openssl/base.h>

#if defined(OPENSSL_LINUX) || defined(OPENSSL_MACOS)

BSSL_NAMESPACE_BEGIN
namespace entropy {

// GetSeed fills `out` with random bytes from the jitter source.
OPENSSL_EXPORT bool GetSeed(uint8_t out[48]);

// GetSamples fetches `n` raw delta time samples.
OPENSSL_EXPORT bool GetSamples(uint64_t *out, size_t n);

// GetVersion returns the version of the entropy module.
int GetVersion();

}  // namespace entropy
BSSL_NAMESPACE_END

#endif  // LINUX || MACOS
#endif  // OPENSSL_HEADER_CRYPTO_FIPSMODULE_ENTROPY_INTERNAL_H
