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

#if !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE  // Needed for getentropy on musl and glibc
#endif

#include <openssl/rand.h>

#include "../bcm_support.h"
#include "internal.h"

#if defined(OPENSSL_RAND_GETENTROPY)

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#if defined(OPENSSL_MACOS) || defined(OPENSSL_FUCHSIA)
#include <sys/random.h>
#endif

void CRYPTO_init_sysrand(void) {}

// CRYPTO_sysrand puts |requested| random bytes into |out|.
void CRYPTO_sysrand(uint8_t *out, size_t requested) {
  while (requested > 0) {
    // |getentropy| can only request 256 bytes at a time.
    size_t todo = requested <= 256 ? requested : 256;
    if (getentropy(out, todo) != 0) {
      perror("getentropy() failed");
      abort();
    }

    out += todo;
    requested -= todo;
  }
}

void CRYPTO_sysrand_for_seed(uint8_t *out, size_t requested) {
  CRYPTO_sysrand(out, requested);
}

#endif  // OPENSSL_RAND_GETENTROPY
