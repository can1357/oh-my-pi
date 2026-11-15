// Copyright 2018 The BoringSSL Authors
// Copyright (c) 2020, Arm Ltd.
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

#if defined(OPENSSL_AARCH64) && defined(OPENSSL_WINDOWS) && \
    !defined(OPENSSL_STATIC_ARMCAP) && !defined(OPENSSL_NO_ASM)

#include <windows.h>


void OPENSSL_cpuid_setup(void) {
  // We do not need to check for the presence of NEON, as Armv8-A always has it
  OPENSSL_armcap_P |= ARMV7_NEON;

  if (IsProcessorFeaturePresent(PF_ARM_V8_CRYPTO_INSTRUCTIONS_AVAILABLE)) {
    // These are all covered by one call in Windows
    OPENSSL_armcap_P |= ARMV8_AES;
    OPENSSL_armcap_P |= ARMV8_PMULL;
    OPENSSL_armcap_P |= ARMV8_SHA1;
    OPENSSL_armcap_P |= ARMV8_SHA256;
  }
  // As of writing, Windows does not have a |PF_*| value for ARMv8.2 SHA-512
  // extensions. When it does, add it here.
}

#endif  // OPENSSL_AARCH64 && OPENSSL_WINDOWS && !OPENSSL_STATIC_ARMCAP
