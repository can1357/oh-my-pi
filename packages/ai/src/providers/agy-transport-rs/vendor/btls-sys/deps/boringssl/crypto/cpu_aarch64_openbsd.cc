// Copyright (c) 2022, Robert Nagy <robert.nagy@gmail.com>
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

#include <openssl/cpu.h>

#if defined(OPENSSL_AARCH64) && defined(OPENSSL_OPENBSD) && \
    !defined(OPENSSL_STATIC_ARMCAP) && !defined(OPENSSL_NO_ASM)

#include <machine/armreg.h>
#include <machine/cpu.h>
#include <sys/sysctl.h>

#include "internal.h"


void OPENSSL_cpuid_setup(void) {
  int isar0_mib[] = {CTL_MACHDEP, CPU_ID_AA64ISAR0};
  uint64_t cpu_id = 0;
  size_t len = sizeof(cpu_id);

  if (sysctl(isar0_mib, 2, &cpu_id, &len, nullptr, 0) < 0) {
    return;
  }

  OPENSSL_armcap_P |= ARMV7_NEON;

  if (ID_AA64ISAR0_AES(cpu_id) >= ID_AA64ISAR0_AES_BASE) {
    OPENSSL_armcap_P |= ARMV8_AES;
  }

  if (ID_AA64ISAR0_AES(cpu_id) >= ID_AA64ISAR0_AES_PMULL) {
    OPENSSL_armcap_P |= ARMV8_PMULL;
  }

  if (ID_AA64ISAR0_SHA1(cpu_id) >= ID_AA64ISAR0_SHA1_BASE) {
    OPENSSL_armcap_P |= ARMV8_SHA1;
  }

  if (ID_AA64ISAR0_SHA2(cpu_id) >= ID_AA64ISAR0_SHA2_BASE) {
    OPENSSL_armcap_P |= ARMV8_SHA256;
  }

  if (ID_AA64ISAR0_SHA2(cpu_id) >= ID_AA64ISAR0_SHA2_512) {
    OPENSSL_armcap_P |= ARMV8_SHA512;
  }
}

#endif  // OPENSSL_AARCH64 && OPENSSL_OPENBSD && !OPENSSL_STATIC_ARMCAP
