// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/base.h>

#if !defined(OPENSSL_NO_ASM) && \
    (defined(OPENSSL_X86) || defined(OPENSSL_X86_64))

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#if defined(_MSC_VER)
#include <immintrin.h>
#include <intrin.h>
#endif

#include "internal.h"


// OPENSSL_cpuid runs the cpuid instruction. |leaf| is passed in as EAX and ECX
// is set to zero. It writes EAX, EBX, ECX, and EDX to |*out_eax| through
// |*out_edx|.
static void OPENSSL_cpuid(uint32_t *out_eax, uint32_t *out_ebx,
                          uint32_t *out_ecx, uint32_t *out_edx, uint32_t leaf) {
#if defined(_MSC_VER)
  int tmp[4];
  __cpuid(tmp, (int)leaf);
  *out_eax = (uint32_t)tmp[0];
  *out_ebx = (uint32_t)tmp[1];
  *out_ecx = (uint32_t)tmp[2];
  *out_edx = (uint32_t)tmp[3];
#elif defined(__pic__) && defined(OPENSSL_32_BIT)
  // Inline assembly may not clobber the PIC register. For 32-bit, this is EBX.
  // See https://gcc.gnu.org/bugzilla/show_bug.cgi?id=47602.
  __asm__ volatile(
      "xor %%ecx, %%ecx\n"
      "mov %%ebx, %%edi\n"
      "cpuid\n"
      "xchg %%edi, %%ebx\n"
      : "=a"(*out_eax), "=D"(*out_ebx), "=c"(*out_ecx), "=d"(*out_edx)
      : "a"(leaf));
#else
  __asm__ volatile(
      "xor %%ecx, %%ecx\n"
      "cpuid\n"
      : "=a"(*out_eax), "=b"(*out_ebx), "=c"(*out_ecx), "=d"(*out_edx)
      : "a"(leaf));
#endif
}

// OPENSSL_xgetbv returns the value of an Intel Extended Control Register (XCR).
// Currently only XCR0 is defined by Intel so |xcr| should always be zero.
static uint64_t OPENSSL_xgetbv(uint32_t xcr) {
#if defined(_MSC_VER)
  return (uint64_t)_xgetbv(xcr);
#else
  uint32_t eax, edx;
  __asm__ volatile("xgetbv" : "=a"(eax), "=d"(edx) : "c"(xcr));
  return (((uint64_t)edx) << 32) | eax;
#endif
}

static bool os_supports_avx512(uint64_t xcr0) {
#if defined(__APPLE__)
  // The Darwin kernel had a bug where it could corrupt the opmask registers.
  // See
  // https://community.intel.com/t5/Software-Tuning-Performance/MacOS-Darwin-kernel-bug-clobbers-AVX-512-opmask-register-state/m-p/1327259
  // Darwin also does not initially set the XCR0 bits for AVX512, but they are
  // set if the thread tries to use AVX512 anyway.  Thus, to safely and
  // consistently use AVX512 on macOS we'd need to check the kernel version as
  // well as detect AVX512 support using a macOS-specific method.  We don't
  // bother with this, especially given Apple's transition to arm64.
  return false;
#else
  return (xcr0 & 0xe6) == 0xe6;
#endif
}

// handle_cpu_env applies the value from |in| to the CPUID values in |out[0]|
// and |out[1]|. See the comment in |OPENSSL_cpuid_setup| about this. The
// |is_last| argument specifies whether the value is at the end of the string.
// Otherwise it may be followed by a colon.
static void handle_cpu_env(uint32_t out[2], const char *in, bool is_last) {
  const int invert_op = in[0] == '~';
  const int or_op = in[0] == '|';
  const int skip_first_byte = invert_op || or_op;
  const int hex = in[skip_first_byte] == '0' && in[skip_first_byte + 1] == 'x';
  const int base = hex ? 16 : 10;

  const char *start = in + skip_first_byte;
  char *end;
  errno = 0;
  // We need to parse 64-bit values with `strtoull`.
  static_assert(sizeof(unsigned long long) == sizeof(uint64_t));
  unsigned long long v = strtoull(start, &end, base);

  if (end == start || (*end != '\0' && (is_last || *end != ':')) ||
      (v == ULLONG_MAX && errno == ERANGE)) {
    return;
  }

  if (invert_op) {
    out[0] &= ~v;
    out[1] &= ~(v >> 32);
  } else if (or_op) {
    out[0] |= v;
    out[1] |= (v >> 32);
  } else {
    out[0] = v;
    out[1] = v >> 32;
  }
}

void OPENSSL_adjust_ia32cap(uint32_t cap[4], const char *env) {
  // OPENSSL_ia32cap can contain zero, one or two values, separated with a ':'.
  // Each value is a 64-bit, unsigned value which may start with "0x" to
  // indicate a hex value. Prior to the 64-bit value, a '~' or '|' may be given.
  //
  // If the '~' prefix is present:
  //   the value is inverted and ANDed with the probed CPUID result
  // If the '|' prefix is present:
  //   the value is ORed with the probed CPUID result
  // Otherwise:
  //   the value is taken as the result of the CPUID
  //
  // The first value determines OPENSSL_ia32cap_P[0] and [1]. The second [2]
  // and [3].
  handle_cpu_env(cap, env, /*is_last=*/false);
  env = strchr(env, ':');
  if (env != nullptr) {
    handle_cpu_env(cap + 2, env + 1, /*is_last=*/true);
  }
}

void OPENSSL_cpuid_setup(void) {
  // Determine the vendor and maximum input value.
  uint32_t eax, ebx, ecx, edx;
  OPENSSL_cpuid(&eax, &ebx, &ecx, &edx, 0);

  uint32_t num_ids = eax;

  int is_intel = ebx == 0x756e6547 /* Genu */ &&  //
                 edx == 0x49656e69 /* ineI */ &&  //
                 ecx == 0x6c65746e /* ntel */;
  int is_amd = ebx == 0x68747541 /* Auth */ &&  //
               edx == 0x69746e65 /* enti */ &&  //
               ecx == 0x444d4163 /* cAMD */;

  uint32_t extended_features[2] = {0};
  if (num_ids >= 7) {
    OPENSSL_cpuid(&eax, &ebx, &ecx, &edx, 7);
    extended_features[0] = ebx;
    extended_features[1] = ecx;
  }

  OPENSSL_cpuid(&eax, &ebx, &ecx, &edx, 1);

  const uint32_t base_family = (eax >> 8) & 15;
  const uint32_t base_model = (eax >> 4) & 15;

  uint32_t family = base_family;
  uint32_t model = base_model;
  if (base_family == 15) {
    const uint32_t ext_family = (eax >> 20) & 255;
    family += ext_family;
  }
  if (base_family == 6 || base_family == 15) {
    const uint32_t ext_model = (eax >> 16) & 15;
    model |= ext_model << 4;
  }

  if (is_amd) {
    if (family < 0x17 || (family == 0x17 && 0x70 <= model && model <= 0x7f)) {
      // Disable RDRAND on AMD families before 0x17 (Zen) due to reported
      // failures after suspend.
      // https://bugzilla.redhat.com/show_bug.cgi?id=1150286
      // Also disable for family 0x17, models 0x70–0x7f, due to possible RDRAND
      // failures there too.
      ecx &= ~(1u << 30);
    }
  }

  // Reserved bit #30 is repurposed to signal an Intel CPU.
  if (is_intel) {
    edx |= (1u << 30);
  } else {
    edx &= ~(1u << 30);
  }

  uint64_t xcr0 = 0;
  if (ecx & (1u << 27)) {
    // XCR0 may only be queried if the OSXSAVE bit is set.
    xcr0 = OPENSSL_xgetbv(0);
  }
  // See Intel manual, volume 1, section 14.3.
  if ((xcr0 & 6) != 6) {
    // YMM registers cannot be used.
    ecx &= ~(1u << 28);                   // AVX
    ecx &= ~(1u << 12);                   // FMA
    ecx &= ~(1u << 11);                   // AMD XOP
    extended_features[0] &= ~(1u << 5);   // AVX2
    extended_features[1] &= ~(1u << 9);   // VAES
    extended_features[1] &= ~(1u << 10);  // VPCLMULQDQ
  }
  // See Intel manual, volume 1, sections 15.2 ("Detection of AVX-512 Foundation
  // Instructions") through 15.4 ("Detection of Intel AVX-512 Instruction Groups
  // Operating at 256 and 128-bit Vector Lengths").
  if (!os_supports_avx512(xcr0)) {
    // Without XCR0.111xx11x, no AVX512 feature can be used. This includes ZMM
    // registers, masking, SIMD registers 16-31 (even if accessed as YMM or
    // XMM), and EVEX-coded instructions (even on YMM or XMM). Even if only
    // XCR0.ZMM_Hi256 is missing, it isn't valid to use AVX512 features on
    // shorter vectors, since AVX512 ties everything to the availability of
    // 512-bit vectors. See the above-mentioned sections of the Intel manual,
    // which say that *all* these XCR0 bits must be checked even when just using
    // 128-bit or 256-bit vectors, and also volume 2a section 2.7.11 ("#UD
    // Equations for EVEX") which says that all EVEX-coded instructions raise an
    // undefined-instruction exception if any of these XCR0 bits is zero.
    extended_features[0] &= ~(1u << 16);  // AVX512F
    extended_features[0] &= ~(1u << 17);  // AVX512DQ
    extended_features[0] &= ~(1u << 21);  // AVX512IFMA
    extended_features[0] &= ~(1u << 26);  // AVX512PF
    extended_features[0] &= ~(1u << 27);  // AVX512ER
    extended_features[0] &= ~(1u << 28);  // AVX512CD
    extended_features[0] &= ~(1u << 30);  // AVX512BW
    extended_features[0] &= ~(1u << 31);  // AVX512VL
    extended_features[1] &= ~(1u << 1);   // AVX512VBMI
    extended_features[1] &= ~(1u << 6);   // AVX512VBMI2
    extended_features[1] &= ~(1u << 11);  // AVX512VNNI
    extended_features[1] &= ~(1u << 12);  // AVX512BITALG
    extended_features[1] &= ~(1u << 14);  // AVX512VPOPCNTDQ
  }

  // Repurpose the bit for the removed MPX feature to indicate when using zmm
  // registers should be avoided even when they are supported. (When set, AVX512
  // features can still be used, but only using ymm or xmm registers.) Skylake
  // suffered from severe downclocking when zmm registers were used, which
  // affected unrelated code running on the system, making zmm registers not too
  // useful outside of benchmarks. The situation improved significantly by Ice
  // Lake, but a small amount of downclocking remained. (See
  // https://lore.kernel.org/linux-crypto/e8ce1146-3952-6977-1d0e-a22758e58914@intel.com/)
  // We take a conservative approach of not allowing zmm registers until after
  // Ice Lake and Tiger Lake, i.e. until Sapphire Rapids on the server side.
  //
  // AMD CPUs, which support AVX512 starting with Zen 4, have not been reported
  // to have any downclocking problem when zmm registers are used.
  if (is_intel && family == 6 &&
      (model == 85 ||    // Skylake, Cascade Lake, Cooper Lake (server)
       model == 106 ||   // Ice Lake (server)
       model == 108 ||   // Ice Lake (micro server)
       model == 125 ||   // Ice Lake (client)
       model == 126 ||   // Ice Lake (mobile)
       model == 140 ||   // Tiger Lake (mobile)
       model == 141)) {  // Tiger Lake (client)
    extended_features[0] |= 1u << 14;
  } else {
    extended_features[0] &= ~(1u << 14);
  }

  OPENSSL_ia32cap_P[0] = edx;
  OPENSSL_ia32cap_P[1] = ecx;
  OPENSSL_ia32cap_P[2] = extended_features[0];
  OPENSSL_ia32cap_P[3] = extended_features[1];

  const char *env = getenv("OPENSSL_ia32cap");
  if (env != nullptr) {
    OPENSSL_adjust_ia32cap(OPENSSL_ia32cap_P, env);
  }
}

#endif  // !OPENSSL_NO_ASM && (OPENSSL_X86 || OPENSSL_X86_64)
