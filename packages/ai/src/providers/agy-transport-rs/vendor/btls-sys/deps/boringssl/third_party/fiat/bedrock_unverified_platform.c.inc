#ifndef BEDROCK_UNVERIFIED_PLATFORM_INC_H_
#define BEDROCK_UNVERIFIED_PLATFORM_INC_H_

// This file is a manually maintained and audited replacement for
// bedrock_polyfill_platform.c.inc with tests in bedrock_platform_test.cc

#include "../../crypto/internal.h"

#if defined(OPENSSL_64_BIT)
#define BR_WORD_MAX UINT64_MAX
typedef uint64_t br_word_t;
typedef int64_t br_signed_t;
#elif defined(OPENSSL_32_BIT)
#define BR_WORD_MAX UINT32_MAX
typedef uint32_t br_word_t;
typedef int32_t br_signed_t;
#else
#error "Must define either OPENSSL_32_BIT or OPENSSL_64_BIT"
#endif

static_assert(sizeof(br_word_t) == sizeof(crypto_word_t));

// Scalar memory operations

#include "../../third_party/fiat/bedrock_unverified_bareminimum.c.inc"

// Bulk memory operations

static inline void br_memcpy(br_word_t d, br_word_t s, br_word_t n) {
  OPENSSL_memcpy((void *)d, (const void *)s, n);
}

static inline void br_memset(br_word_t d, br_word_t v, br_word_t n) {
  OPENSSL_memset((void *)d, v, n);
}

static inline void br_memcxor(uintptr_t d, uintptr_t s, uintptr_t n, uintptr_t mask) {
  constant_time_conditional_memxor((void*)d, (void*)s, n, mask);
}

// CPU Arithmetic

static inline br_word_t br_full_add(br_word_t x, br_word_t y, br_word_t carry,
                                    br_word_t *_sum) {
  br_word_t carry_out = 0;
  static_assert(sizeof(br_word_t) == sizeof(crypto_word_t));
  *_sum = CRYPTO_addc_w(x, y, carry, &carry_out);
  return carry_out;
}

static inline br_word_t br_full_sub(br_word_t x, br_word_t y, br_word_t borrow,
                                    br_word_t *_diff) {
  br_word_t borrow_out = 0;
  static_assert(sizeof(br_word_t) == sizeof(crypto_word_t));
  *_diff = CRYPTO_subc_w(x, y, borrow, &borrow_out);
  return borrow_out;
}

static inline br_word_t br_full_mul(br_word_t a, br_word_t b, br_word_t *_low) {
#if BR_WORD_MAX == UINT32_MAX
  uint64_t r = (uint64_t)a * b;
  *_low = r;
  return r >> 32;
#elif defined(BORINGSSL_HAS_UINT128)
  uint128_t r = (uint128_t)a * b;
  *_low = r;
  return r >> 64;
#elif defined(_M_X64)
  uint64_t hi;
  *_low = _umul128(a, b, &hi);
  return hi;
#elif defined(_M_ARM64)
  *_low = a * b;
  return __umulh(a, b);
#else
#error "need 64 x 64 -> 128 multiplication"
#endif
}

// Constant-time computations

static inline br_word_t br_value_barrier(br_word_t a) {
  static_assert(sizeof(br_word_t) == sizeof(crypto_word_t));
  return value_barrier_w(a);
}

static inline br_word_t br_declassify(br_word_t a) {
  static_assert(sizeof(br_word_t) == sizeof(crypto_word_t));
  return constant_time_declassify_w(a);
}

static inline br_word_t br_broadcast_negative(br_word_t x) {
  return br_value_barrier((br_signed_t)x >> (sizeof(br_word_t) * 8 - 1));
}

static inline br_word_t br_broadcast_nonzero(br_word_t x) {
  return br_broadcast_negative(x | (0u - x));
}

static inline br_word_t br_cmov(br_word_t c, br_word_t vnz, br_word_t vz) {
#if !defined(OPENSSL_NO_ASM) && (defined(__GNUC__) || defined(__clang__)) && \
    defined(__x86_64__)
  __asm__(
      "testq %[c], %[c]\n"
      "cmovzq %[vz], %[vnz]"
      : [vnz] "+r"(vnz)
      : [vz] "r"(vz), [c] "r"(c)
      : "cc");
  return vnz;
#elif !defined(OPENSSL_NO_ASM) && (defined(__GNUC__) || defined(__clang__)) && \
    defined(__i386__)
  __asm__(
      "testl %[c], %[c]\n"  // test%z[c] gives "invalid operand" on clang 16.0.6
      "cmovzl %[vz], %[vnz]"
      : [vnz] "+r"(vnz)
      : [vz] "r"(vz), [c] "r"(c)
      : "cc");
  return vnz;
#else
  br_word_t m = br_broadcast_nonzero(c);
  return (m & vnz) | (~m & vz);
#endif
}

#endif  // BEDROCK_UNVERIFIED_PLATFORM_INC_H_
