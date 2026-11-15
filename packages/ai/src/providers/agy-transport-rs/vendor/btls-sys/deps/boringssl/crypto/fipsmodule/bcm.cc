// Copyright 2017 The BoringSSL Authors
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

#if !defined(_GNU_SOURCE)
#define _GNU_SOURCE  // needed for syscall() on Linux.
#endif

#include <openssl/crypto.h>

#include <stdlib.h>
#if defined(BORINGSSL_FIPS)
#include <sys/mman.h>
#include <unistd.h>
#endif

#include <openssl/digest.h>
#include <openssl/hmac.h>
#include <openssl/sha2.h>

#include "../bcm_support.h"
#include "../internal.h"
#include "bcm_interface.h"

// TODO(crbug.com/362530616): When delocate is removed, build these files as
// separate compilation units again.
#include "aes/aes.cc.inc"
#include "aes/aes_nohw.cc.inc"
#include "aes/cbc.cc.inc"
#include "aes/cfb.cc.inc"
#include "aes/ctr.cc.inc"
#include "aes/gcm.cc.inc"
#include "aes/gcm_nohw.cc.inc"
#include "aes/key_wrap.cc.inc"
#include "aes/mode_wrappers.cc.inc"
#include "aes/ofb.cc.inc"
#include "bn/add.cc.inc"
#include "bn/asm/x86_64-gcc.cc.inc"
#include "bn/bn.cc.inc"
#include "bn/bytes.cc.inc"
#include "bn/cmp.cc.inc"
#include "bn/ctx.cc.inc"
#include "bn/div.cc.inc"
#include "bn/div_extra.cc.inc"
#include "bn/exponentiation.cc.inc"
#include "bn/gcd.cc.inc"
#include "bn/gcd_extra.cc.inc"
#include "bn/generic.cc.inc"
#include "bn/jacobi.cc.inc"
#include "bn/montgomery.cc.inc"
#include "bn/montgomery_inv.cc.inc"
#include "bn/mul.cc.inc"
#include "bn/prime.cc.inc"
#include "bn/random.cc.inc"
#include "bn/rsaz_exp.cc.inc"
#include "bn/shift.cc.inc"
#include "bn/sqrt.cc.inc"
#include "cipher/aead.cc.inc"
#include "cipher/cipher.cc.inc"
#include "cipher/e_aes.cc.inc"
#include "cipher/e_aesccm.cc.inc"
#include "cmac/cmac.cc.inc"
#include "dh/check.cc.inc"
#include "dh/dh.cc.inc"
#include "digest/digest.cc.inc"
#include "digest/digests.cc.inc"
#include "digestsign/digestsign.cc.inc"
#include "ec/ec.cc.inc"
#include "ec/ec_key.cc.inc"
#include "ec/ec_montgomery.cc.inc"
#include "ec/felem.cc.inc"
#include "ec/oct.cc.inc"
#include "ec/p224-64.cc.inc"
#include "ec/p256-nistz.cc.inc"
#include "ec/p256.cc.inc"
#include "ec/scalar.cc.inc"
#include "ec/simple.cc.inc"
#include "ec/simple_mul.cc.inc"
#include "ec/util.cc.inc"
#include "ec/wnaf.cc.inc"
#include "ecdh/ecdh.cc.inc"
#include "ecdsa/ecdsa.cc.inc"
#include "entropy/jitter.cc.inc"
#include "hkdf/hkdf.cc.inc"
#include "hmac/hmac.cc.inc"
#include "keccak/keccak.cc.inc"
#include "mldsa/mldsa.cc.inc"
#include "mlkem/mlkem.cc.inc"
#include "rand/ctrdrbg.cc.inc"
#include "rand/rand.cc.inc"
#include "rsa/blinding.cc.inc"
#include "rsa/padding.cc.inc"
#include "rsa/rsa.cc.inc"
#include "rsa/rsa_impl.cc.inc"
#include "self_check/fips.cc.inc"
#include "self_check/self_check.cc.inc"
#include "service_indicator/service_indicator.cc.inc"
#include "sha/sha1.cc.inc"
#include "sha/sha256.cc.inc"
#include "sha/sha512.cc.inc"
#include "slhdsa/fors.cc.inc"
#include "slhdsa/merkle.cc.inc"
#include "slhdsa/slhdsa.cc.inc"
#include "slhdsa/thash.cc.inc"
#include "slhdsa/wots.cc.inc"
#include "tls/kdf.cc.inc"


#if defined(BORINGSSL_FIPS)

#if !defined(OPENSSL_ASAN)

// These symbols are filled in by delocate.go (in static builds) or a linker
// script (in shared builds). They point to the start and end of the module, and
// the location of the integrity hash, respectively.
extern const uint8_t BORINGSSL_bcm_text_start[];
extern const uint8_t BORINGSSL_bcm_text_end[];
extern const uint8_t BORINGSSL_bcm_text_hash[];
#if defined(BORINGSSL_SHARED_LIBRARY)
extern const uint8_t BORINGSSL_bcm_rodata_start[];
extern const uint8_t BORINGSSL_bcm_rodata_end[];
#endif

// assert_within is used to sanity check that certain symbols are within the
// bounds of the integrity check. It checks that start <= symbol < end and
// aborts otherwise.
static void assert_within(const void *start, const void *symbol,
                          const void *end) {
  const uintptr_t start_val = (uintptr_t)start;
  const uintptr_t symbol_val = (uintptr_t)symbol;
  const uintptr_t end_val = (uintptr_t)end;

  if (start_val <= symbol_val && symbol_val < end_val) {
    return;
  }

  fprintf(CRYPTO_get_stderr(),
          "FIPS module doesn't span expected symbol. Expected %p <= %p < %p\n",
          start, symbol, end);
  BORINGSSL_FIPS_abort();
}

#if defined(OPENSSL_ANDROID) && defined(OPENSSL_AARCH64)
static void BORINGSSL_maybe_set_module_text_permissions(int permission) {
  // Android may be compiled in execute-only-memory mode, in which case the
  // .text segment cannot be read. That conflicts with the need for a FIPS
  // module to hash its own contents, therefore |mprotect| is used to make
  // the module's .text readable for the duration of the hashing process. In
  // other build configurations this is a no-op.
  const uintptr_t page_size = getpagesize();
  const uintptr_t page_start =
      ((uintptr_t)BORINGSSL_bcm_text_start) & ~(page_size - 1);

  if (mprotect((void *)page_start,
               ((uintptr_t)BORINGSSL_bcm_text_end) - page_start,
               permission) != 0) {
    perror("BoringSSL: mprotect");
  }
}
#else
static void BORINGSSL_maybe_set_module_text_permissions(int permission) {}
#endif  // !ANDROID

#endif  // !ASAN

static void __attribute__((constructor)) BORINGSSL_bcm_power_on_self_test(
    void) {
#if !defined(OPENSSL_ASAN)
  // Integrity tests cannot run under ASAN because it involves reading the full
  // .text section, which triggers the global-buffer overflow detection.
  if (!BORINGSSL_integrity_test()) {
    goto err;
  }
#endif  // OPENSSL_ASAN

  if (!boringssl_self_test_startup()) {
    goto err;
  }

  return;

err:
  BORINGSSL_FIPS_abort();
}

#if !defined(OPENSSL_ASAN)
int BORINGSSL_integrity_test(void) {
  const uint8_t *const start = BORINGSSL_bcm_text_start;
  const uint8_t *const end = BORINGSSL_bcm_text_end;

  assert_within(start, reinterpret_cast<const void *>(BCM_aes_encrypt), end);
  assert_within(start, reinterpret_cast<const void *>(RSA_sign), end);
  assert_within(start, reinterpret_cast<const void *>(BCM_rand_bytes), end);
  assert_within(start, reinterpret_cast<const void *>(EC_GROUP_cmp), end);
  assert_within(start, reinterpret_cast<const void *>(BCM_sha256_update), end);
  assert_within(start, reinterpret_cast<const void *>(ecdsa_verify_fixed), end);
  assert_within(start, reinterpret_cast<const void *>(EVP_AEAD_CTX_seal), end);

#if defined(BORINGSSL_SHARED_LIBRARY)
  const uint8_t *const rodata_start = BORINGSSL_bcm_rodata_start;
  const uint8_t *const rodata_end = BORINGSSL_bcm_rodata_end;
#else
  // In the static build, read-only data is placed within the .text segment.
  const uint8_t *const rodata_start = BORINGSSL_bcm_text_start;
  const uint8_t *const rodata_end = BORINGSSL_bcm_text_end;
#endif

  assert_within(rodata_start, kPrimes, rodata_end);
  assert_within(rodata_start, kP256Field, rodata_end);
  assert_within(rodata_start, kPKCS1SigPrefixes, rodata_end);

  uint8_t result[SHA256_DIGEST_LENGTH];
  const EVP_MD *const kHashFunction = EVP_sha256();
  if (!boringssl_self_test_sha256() || !boringssl_self_test_hmac_sha256()) {
    return 0;
  }

  static const uint8_t kHMACKey[64] = {0};
  unsigned result_len;
  HMAC_CTX hmac_ctx;
  HMAC_CTX_init(&hmac_ctx);
  if (!HMAC_Init_ex(&hmac_ctx, kHMACKey, sizeof(kHMACKey), kHashFunction,
                    nullptr /* no ENGINE */)) {
    fprintf(CRYPTO_get_stderr(), "HMAC_Init_ex failed.\n");
    return 0;
  }

  BORINGSSL_maybe_set_module_text_permissions(PROT_READ | PROT_EXEC);
#if defined(BORINGSSL_SHARED_LIBRARY)
  uint64_t length = end - start;
  HMAC_Update(&hmac_ctx, (const uint8_t *)&length, sizeof(length));
  HMAC_Update(&hmac_ctx, start, length);

  length = rodata_end - rodata_start;
  HMAC_Update(&hmac_ctx, (const uint8_t *)&length, sizeof(length));
  HMAC_Update(&hmac_ctx, rodata_start, length);
#else
  HMAC_Update(&hmac_ctx, start, end - start);
#endif
  BORINGSSL_maybe_set_module_text_permissions(PROT_EXEC);

  if (!HMAC_Final(&hmac_ctx, result, &result_len) ||
      result_len != sizeof(result)) {
    fprintf(CRYPTO_get_stderr(), "HMAC failed.\n");
    return 0;
  }
  HMAC_CTX_cleanse(&hmac_ctx);  // FIPS 140-3, AS05.10.

  const uint8_t *expected = BORINGSSL_bcm_text_hash;

  if (!BORINGSSL_check_test(expected, result, sizeof(result),
                            "FIPS integrity test")) {
#if !defined(BORINGSSL_FIPS_BREAK_TESTS)
    return 0;
#endif
  }

  OPENSSL_cleanse(result, sizeof(result));  // FIPS 140-3, AS05.10.
  return 1;
}

const uint8_t *FIPS_module_hash(void) { return BORINGSSL_bcm_text_hash; }

#endif  // OPENSSL_ASAN

void BORINGSSL_FIPS_abort(void) {
  for (;;) {
    abort();
    exit(1);
  }
}

#endif  // BORINGSSL_FIPS
