// Copyright 2022 The BoringSSL Authors
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

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_ARM) && \
    defined(OPENSSL_FREEBSD) && !defined(OPENSSL_STATIC_ARMCAP)
#include <sys/auxv.h>
#include <sys/types.h>

#include <openssl/mem.h>


void OPENSSL_cpuid_setup(void) {
  unsigned long hwcap = 0, hwcap2 = 0;

  // |elf_aux_info| may fail, in which case |hwcap| and |hwcap2| will be
  // left at zero. The rest of this function will then gracefully report
  // the features are absent.
  elf_aux_info(AT_HWCAP, &hwcap, sizeof(hwcap));
  elf_aux_info(AT_HWCAP2, &hwcap2, sizeof(hwcap2));

  // Matching OpenSSL, only report other features if NEON is present.
  if (hwcap & HWCAP_NEON) {
    OPENSSL_armcap_P |= ARMV7_NEON;

    if (hwcap2 & HWCAP2_AES) {
      OPENSSL_armcap_P |= ARMV8_AES;
    }
    if (hwcap2 & HWCAP2_PMULL) {
      OPENSSL_armcap_P |= ARMV8_PMULL;
    }
    if (hwcap2 & HWCAP2_SHA1) {
      OPENSSL_armcap_P |= ARMV8_SHA1;
    }
    if (hwcap2 & HWCAP2_SHA2) {
      OPENSSL_armcap_P |= ARMV8_SHA256;
    }
  }
}

#endif  // OPENSSL_ARM && OPENSSL_OPENBSD && !OPENSSL_STATIC_ARMCAP
