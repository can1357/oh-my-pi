#include <openssl/base.h>
#include "bedrock_unverified_platform.c.inc"

#if defined(BORINGSSL_HAS_UINT128)
#include "p256_64.h"
#elif defined(OPENSSL_64_BIT)
#include "p256_64_msvc.h"
#else
#include "p256_field_32.br.c.inc"
#include "p256_32.h"
// the 32-bit Bedrock-generated field halving calls Fiat-C code for add, sub
static inline void p256_coord_add(br_word_t out, br_word_t x, br_word_t y) {
  fiat_p256_add((uint32_t*)out, (const uint32_t*)x, (const uint32_t*)y);
}
static inline void p256_coord_sub(br_word_t out, br_word_t x, br_word_t y) {
  fiat_p256_sub((uint32_t*)out, (const uint32_t*)x, (const uint32_t*)y);
}
#endif

// the Bedrock-generated point operations call Fiat-C or Fiat-x86 mul, sqr
static inline void p256_coord_mul(br_word_t out, br_word_t x, br_word_t y) {
  fiat_p256_mul((br_word_t*)out, (const br_word_t*)x, (const br_word_t*)y);
}
static inline void p256_coord_sqr(br_word_t out, br_word_t x) {
  fiat_p256_square((br_word_t*)out, (const br_word_t*)x);
}
