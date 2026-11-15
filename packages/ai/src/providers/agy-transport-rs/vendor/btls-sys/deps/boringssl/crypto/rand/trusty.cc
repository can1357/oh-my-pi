// Copyright 2023 The BoringSSL Authors
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

#include <openssl/rand.h>

#include "../bcm_support.h"
#include "internal.h"

#if defined(OPENSSL_RAND_TRUSTY)
#include <stdint.h>
#include <stdlib.h>

#include <sys/types.h>
#include <uapi/err.h>

#include <lib/rng/trusty_rng.h>

void CRYPTO_init_sysrand(void) {}

void CRYPTO_sysrand(uint8_t *out, size_t requested) {
  if (trusty_rng_hw_rand(out, requested) != NO_ERROR) {
    abort();
  }
}

void CRYPTO_sysrand_for_seed(uint8_t *out, size_t requested) {
  CRYPTO_sysrand(out, requested);
}

#endif  // OPENSSL_RAND_TRUSTY
