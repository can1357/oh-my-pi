// Copyright 2014 The BoringSSL Authors
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
#include "../internal.h"
#include "internal.h"

#if defined(OPENSSL_RAND_WINDOWS)

#include <limits.h>
#include <stdlib.h>

#include <windows.h>

#if WINAPI_FAMILY_PARTITION(WINAPI_PARTITION_APP) && \
    !WINAPI_FAMILY_PARTITION(WINAPI_PARTITION_DESKTOP)
#include <bcrypt.h>
OPENSSL_MSVC_PRAGMA(comment(lib, "bcrypt.lib"))
#endif  // WINAPI_PARTITION_APP && !WINAPI_PARTITION_DESKTOP

#if WINAPI_FAMILY_PARTITION(WINAPI_PARTITION_APP) && \
    !WINAPI_FAMILY_PARTITION(WINAPI_PARTITION_DESKTOP)

void CRYPTO_init_sysrand(void) {}

void CRYPTO_sysrand(uint8_t *out, size_t requested) {
  while (requested > 0) {
    ULONG output_bytes_this_pass = ULONG_MAX;
    if (requested < output_bytes_this_pass) {
      output_bytes_this_pass = (ULONG)requested;
    }
    if (!BCRYPT_SUCCESS(BCryptGenRandom(
            /*hAlgorithm=*/nullptr, out, output_bytes_this_pass,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
      abort();
    }
    requested -= output_bytes_this_pass;
    out += output_bytes_this_pass;
  }
}

#else

// See: https://learn.microsoft.com/en-us/windows/win32/seccng/processprng
typedef BOOL (WINAPI *ProcessPrngFunction)(PBYTE pbData, SIZE_T cbData);
static ProcessPrngFunction g_processprng_fn = nullptr;

static void init_processprng(void) {
  HMODULE hmod = LoadLibraryW(L"bcryptprimitives");
  if (hmod == nullptr) {
    abort();
  }
  g_processprng_fn = (ProcessPrngFunction)GetProcAddress(hmod, "ProcessPrng");
  if (g_processprng_fn == nullptr) {
    abort();
  }
}

void CRYPTO_init_sysrand(void) {
  static CRYPTO_once_t once = CRYPTO_ONCE_INIT;
  CRYPTO_once(&once, init_processprng);
}

void CRYPTO_sysrand(uint8_t *out, size_t requested) {
  CRYPTO_init_sysrand();
  // On non-UWP configurations, use ProcessPrng instead of BCryptGenRandom
  // to avoid accessing resources that may be unavailable inside the
  // Chromium sandbox. See https://crbug.com/74242
  if (!g_processprng_fn(out, requested)) {
    abort();
  }
}

#endif  // WINAPI_PARTITION_APP && !WINAPI_PARTITION_DESKTOP

void CRYPTO_sysrand_for_seed(uint8_t *out, size_t requested) {
  CRYPTO_sysrand(out, requested);
}

#endif  // OPENSSL_RAND_WINDOWS
