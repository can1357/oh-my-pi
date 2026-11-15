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

#include <openssl/crypto.h>

#include "internal.h"


#if defined(FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION)
static bssl::Atomic<uint32_t> fuzzer_mode_enabled = 0;

int CRYPTO_fuzzer_mode_enabled(void) { return fuzzer_mode_enabled.load(); }

void CRYPTO_set_fuzzer_mode(int enabled) {
  fuzzer_mode_enabled.store(!!enabled);
}
#endif  // FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
