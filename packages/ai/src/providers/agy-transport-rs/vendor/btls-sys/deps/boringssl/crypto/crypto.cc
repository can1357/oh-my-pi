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

#include <openssl/crypto.h>

#include <assert.h>
#include <stdio.h>

#include "bcm_support.h"
#include "fipsmodule/rand/internal.h"
#include "internal.h"


static_assert(sizeof(ossl_ssize_t) == sizeof(size_t),
              "ossl_ssize_t should be the same size as size_t");


// Our assembly does not use the GOT to reference symbols, which means
// references to visible symbols will often require a TEXTREL. This is
// undesirable, so all assembly-referenced symbols should be hidden. CPU
// capabilities are the only such symbols defined in C. Explicitly hide them,
// rather than rely on being built with -fvisibility=hidden.
#if defined(OPENSSL_WINDOWS)
#define HIDDEN
#else
#define HIDDEN __attribute__((visibility("hidden")))
#endif


// The capability variables are defined in this file in order to work around a
// linker bug. When linking with a .a, if no symbols in a .o are referenced
// then the .o is discarded, even if it has constructor functions.
//
// This still means that any binaries that don't include some functionality
// that tests the capability values will still skip the constructor but, so
// far, the init constructor function only sets the capability variables.

#if defined(BORINGSSL_DISPATCH_TEST)
// This value must be explicitly initialised to zero in order to work around a
// bug in libtool or the linker on OS X.
//
// If not initialised then it becomes a "common symbol". When put into an
// archive, linking on OS X will fail to resolve common symbols. By
// initialising it to zero, it becomes a "data symbol", which isn't so
// affected.
HIDDEN uint8_t BORINGSSL_function_hit[8] = {0};
#endif

#if defined(OPENSSL_X86) || defined(OPENSSL_X86_64)

// This value must be explicitly initialized to zero. See similar comment above.
HIDDEN uint32_t OPENSSL_ia32cap_P[4] = {0};

uint32_t OPENSSL_get_ia32cap(int idx) {
  OPENSSL_init_cpuid();
  return OPENSSL_ia32cap_P[idx];
}

#elif (defined(OPENSSL_ARM) || defined(OPENSSL_AARCH64)) && \
    !defined(OPENSSL_STATIC_ARMCAP)
HIDDEN uint32_t OPENSSL_armcap_P = 0;

uint32_t *OPENSSL_get_armcap_pointer_for_test(void) {
  OPENSSL_init_cpuid();
  return &OPENSSL_armcap_P;
}

uint32_t OPENSSL_get_armcap(void) {
  OPENSSL_init_cpuid();
  return OPENSSL_armcap_P;
}
#endif

#if defined(NEED_CPUID)
static CRYPTO_once_t once = CRYPTO_ONCE_INIT;
void OPENSSL_init_cpuid(void) { CRYPTO_once(&once, OPENSSL_cpuid_setup); }
#endif

void CRYPTO_library_init(void) {}

int CRYPTO_is_confidential_build(void) {
#if defined(BORINGSSL_CONFIDENTIAL)
  return 1;
#else
  return 0;
#endif
}

void CRYPTO_pre_sandbox_init(void) {
  // Read from /proc/cpuinfo if needed.
  OPENSSL_init_cpuid();
  // Open /dev/urandom if needed.
  CRYPTO_init_sysrand();
  // Set up MADV_WIPEONFORK state if needed.
  CRYPTO_get_fork_generation();
}

const char *SSLeay_version(int which) { return OpenSSL_version(which); }

const char *OpenSSL_version(int which) {
  switch (which) {
    case OPENSSL_VERSION:
      return "BoringSSL";
    case OPENSSL_CFLAGS:
      return "compiler: n/a";
    case OPENSSL_BUILT_ON:
      return "built on: n/a";
    case OPENSSL_PLATFORM:
      return "platform: n/a";
    case OPENSSL_DIR:
      return "OPENSSLDIR: n/a";
    default:
      return "not available";
  }
}

unsigned long SSLeay(void) { return OPENSSL_VERSION_NUMBER; }

unsigned long OpenSSL_version_num(void) { return OPENSSL_VERSION_NUMBER; }

int CRYPTO_malloc_init(void) { return 1; }

int OPENSSL_malloc_init(void) { return 1; }

void ENGINE_load_builtin_engines(void) {}

int ENGINE_register_all_complete(void) { return 1; }

void ENGINE_cleanup(void) {}

void OPENSSL_load_builtin_modules(void) {}

int OPENSSL_init_crypto(uint64_t opts, const OPENSSL_INIT_SETTINGS *settings) {
  return 1;
}

void OPENSSL_cleanup(void) {}

FILE *CRYPTO_get_stderr(void) { return stderr; }
