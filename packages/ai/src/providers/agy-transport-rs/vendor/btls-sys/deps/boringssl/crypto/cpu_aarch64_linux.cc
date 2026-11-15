// Copyright 2016 The BoringSSL Authors
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

#if defined(OPENSSL_AARCH64) && defined(OPENSSL_LINUX) && \
    !defined(OPENSSL_STATIC_ARMCAP) && !defined(OPENSSL_NO_ASM)

#include <sys/auxv.h>


void OPENSSL_cpuid_setup(void) {
  unsigned long hwcap = getauxval(AT_HWCAP);

  // See /usr/include/asm/hwcap.h on an aarch64 installation for the source of
  // these values.
  static const unsigned long kNEON = 1 << 1;
  static const unsigned long kAES = 1 << 3;
  static const unsigned long kPMULL = 1 << 4;
  static const unsigned long kSHA1 = 1 << 5;
  static const unsigned long kSHA256 = 1 << 6;
  static const unsigned long kSHA512 = 1 << 21;

  if ((hwcap & kNEON) == 0) {
    // Matching OpenSSL, if NEON is missing, don't report other features
    // either.
    return;
  }

  OPENSSL_armcap_P |= ARMV7_NEON;

  if (hwcap & kAES) {
    OPENSSL_armcap_P |= ARMV8_AES;
  }
  if (hwcap & kPMULL) {
    OPENSSL_armcap_P |= ARMV8_PMULL;
  }
  if (hwcap & kSHA1) {
    OPENSSL_armcap_P |= ARMV8_SHA1;
  }
  if (hwcap & kSHA256) {
    OPENSSL_armcap_P |= ARMV8_SHA256;
  }
  if (hwcap & kSHA512) {
    OPENSSL_armcap_P |= ARMV8_SHA512;
  }
}

#endif  // OPENSSL_AARCH64 && OPENSSL_LINUX && !OPENSSL_STATIC_ARMCAP
