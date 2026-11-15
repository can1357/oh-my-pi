// Copyright 2018 The BoringSSL Authors
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

#include "internal.h"

#if defined(OPENSSL_AARCH64) && defined(OPENSSL_FUCHSIA) && \
    !defined(OPENSSL_STATIC_ARMCAP) && !defined(OPENSSL_NO_ASM)

#include <zircon/features.h>
#include <zircon/syscalls.h>
#include <zircon/types.h>


void OPENSSL_cpuid_setup(void) {
  uint32_t hwcap;
  zx_status_t rc = zx_system_get_features(ZX_FEATURE_KIND_CPU, &hwcap);
  if (rc != ZX_OK || (hwcap & ZX_ARM64_FEATURE_ISA_ASIMD) == 0) {
    // If NEON/ASIMD is missing, don't report other features either. This
    // matches OpenSSL, and the other features depend on SIMD registers.
    return;
  }

  OPENSSL_armcap_P |= ARMV7_NEON;

  if (hwcap & ZX_ARM64_FEATURE_ISA_AES) {
    OPENSSL_armcap_P |= ARMV8_AES;
  }
  if (hwcap & ZX_ARM64_FEATURE_ISA_PMULL) {
    OPENSSL_armcap_P |= ARMV8_PMULL;
  }
  if (hwcap & ZX_ARM64_FEATURE_ISA_SHA1) {
    OPENSSL_armcap_P |= ARMV8_SHA1;
  }
  if (hwcap & ZX_ARM64_FEATURE_ISA_SHA256) {
    OPENSSL_armcap_P |= ARMV8_SHA256;
  }
  if (hwcap & ZX_ARM64_FEATURE_ISA_SHA512) {
    OPENSSL_armcap_P |= ARMV8_SHA512;
  }
}

#endif  // OPENSSL_AARCH64 && OPENSSL_FUCHSIA && !OPENSSL_STATIC_ARMCAP
