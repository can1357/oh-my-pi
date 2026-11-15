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

#include <openssl/asn1.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/span.h>

#include "../internal.h"
#include "internal.h"


ASN1_INTEGER *ASN1_INTEGER_dup(const ASN1_INTEGER *x) {
  return ASN1_STRING_dup(x);
}

int ASN1_INTEGER_cmp(const ASN1_INTEGER *x, const ASN1_INTEGER *y) {
  // Compare signs.
  int neg = x->type & V_ASN1_NEG;
  if (neg != (y->type & V_ASN1_NEG)) {
    return neg ? -1 : 1;
  }

  int ret = ASN1_STRING_cmp(x, y);
  if (neg) {
    // This could be |-ret|, but |ASN1_STRING_cmp| is not forbidden from
    // returning |INT_MIN|.
    if (ret < 0) {
      return 1;
    } else if (ret > 0) {
      return -1;
    } else {
      return 0;
    }
  }

  return ret;
}

// negate_twos_complement negates |len| bytes from |buf| in-place, interpreted
// as a signed, big-endian two's complement value.
static void negate_twos_complement(uint8_t *buf, size_t len) {
  uint8_t borrow = 0;
  for (size_t i = len - 1; i < len; i--) {
    uint8_t t = buf[i];
    buf[i] = 0u - borrow - t;
    borrow |= t != 0;
  }
}

static int is_all_zeros(const uint8_t *in, size_t len) {
  for (size_t i = 0; i < len; i++) {
    if (in[i] != 0) {
      return 0;
    }
  }
  return 1;
}

int asn1_marshal_integer(CBB *out, const ASN1_INTEGER *in, CBS_ASN1_TAG tag) {
  int len = i2c_ASN1_INTEGER(in, nullptr);
  if (len <= 0) {
    return 0;
  }
  tag = tag == 0 ? CBS_ASN1_INTEGER : tag;
  CBB child;
  uint8_t *ptr;
  return CBB_add_asn1(out, &child, tag) &&     //
         CBB_add_space(&child, &ptr, static_cast<size_t>(len)) &&   //
         i2c_ASN1_INTEGER(in, &ptr) == len &&  //
         CBB_flush(out);
}

int i2c_ASN1_INTEGER(const ASN1_INTEGER *in, unsigned char **outp) {
  if (in == nullptr) {
    return 0;
  }

  // |ASN1_INTEGER|s should be represented minimally, but it is possible to
  // construct invalid ones. Skip leading zeros so this does not produce an
  // invalid encoding or break invariants.
  CBS cbs;
  CBS_init(&cbs, in->data, in->length);
  while (CBS_len(&cbs) > 0 && CBS_data(&cbs)[0] == 0) {
    CBS_skip(&cbs, 1);
  }

  int is_negative = (in->type & V_ASN1_NEG) != 0;
  size_t pad;
  CBS copy = cbs;
  uint8_t msb;
  if (!CBS_get_u8(&copy, &msb)) {
    // Zero is represented as a single byte.
    is_negative = 0;
    pad = 1;
  } else if (is_negative) {
    // 0x80...01 through 0xff...ff have a two's complement of 0x7f...ff
    // through 0x00...01 and need an extra byte to be negative.
    // 0x01...00 through 0x80...00 have a two's complement of 0xfe...ff
    // through 0x80...00 and can be negated as-is.
    pad = msb > 0x80 ||
          (msb == 0x80 && !is_all_zeros(CBS_data(&copy), CBS_len(&copy)));
  } else {
    // If the high bit is set, the signed representation needs an extra
    // byte to be positive.
    pad = (msb & 0x80) != 0;
  }

  if (CBS_len(&cbs) > INT_MAX - pad) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_OVERFLOW);
    return 0;
  }
  int len = (int)(pad + CBS_len(&cbs));
  assert(len > 0);
  if (outp == nullptr) {
    return len;
  }

  if (pad) {
    (*outp)[0] = 0;
  }
  OPENSSL_memcpy(*outp + pad, CBS_data(&cbs), CBS_len(&cbs));
  if (is_negative) {
    negate_twos_complement(*outp, len);
    assert((*outp)[0] >= 0x80);
  } else {
    assert((*outp)[0] < 0x80);
  }
  *outp += len;
  return len;
}

static int asn1_parse_integer_contents(bssl::Span<const uint8_t> in,
                                       ASN1_INTEGER *out) {
  CBS cbs = in;
  int is_negative;
  if (!CBS_is_valid_asn1_integer(&cbs, &is_negative)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_INTEGER);
    return 0;
  }

  // Convert to |ASN1_INTEGER|'s sign-and-magnitude representation. First,
  // determine the size needed for a minimal result.
  if (is_negative) {
    // 0xff00...01 through 0xff7f..ff have a two's complement of 0x00ff...ff
    // through 0x000100...001 and need one leading zero removed. 0x8000...00
    // through 0xff00...00 have a two's complement of 0x8000...00 through
    // 0x0100...00 and will be minimally-encoded as-is.
    if (CBS_len(&cbs) > 0 && CBS_data(&cbs)[0] == 0xff &&
        !is_all_zeros(CBS_data(&cbs) + 1, CBS_len(&cbs) - 1)) {
      CBS_skip(&cbs, 1);
    }
  } else {
    // Remove the leading zero byte, if any.
    if (CBS_len(&cbs) > 0 && CBS_data(&cbs)[0] == 0x00) {
      CBS_skip(&cbs, 1);
    }
  }

  if (!ASN1_STRING_set(out, CBS_data(&cbs), CBS_len(&cbs))) {
    return 0;
  }

  if (is_negative) {
    out->type = V_ASN1_NEG_INTEGER;
    negate_twos_complement(out->data, out->length);
  } else {
    out->type = V_ASN1_INTEGER;
  }

  // The value should be minimally-encoded.
  assert(out->length == 0 || out->data[0] != 0);
  // Zero is not negative.
  assert(!is_negative || out->length > 0);
  return 1;
}

int asn1_parse_integer(CBS *cbs, ASN1_INTEGER *out, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_INTEGER : tag;
  CBS child;
  if (!CBS_get_asn1(cbs, &child, tag)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  return asn1_parse_integer_contents(child, out);
}

int asn1_parse_enumerated(CBS *cbs, ASN1_ENUMERATED *out, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_ENUMERATED : tag;
  if (!asn1_parse_integer(cbs, out, tag)) {
    return 0;
  }
  // Fix the type value.
  out->type =
      (out->type & V_ASN1_NEG) ? V_ASN1_NEG_ENUMERATED : V_ASN1_ENUMERATED;
  return 1;
}

ASN1_INTEGER *c2i_ASN1_INTEGER(ASN1_INTEGER **out, const unsigned char **inp,
                               long len) {
  if (len < 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_STRING_TOO_SHORT);
    return nullptr;
  }

  ASN1_INTEGER *ret = nullptr;
  if (out == nullptr || *out == nullptr) {
    ret = ASN1_INTEGER_new();
    if (ret == nullptr) {
      return nullptr;
    }
  } else {
    ret = *out;
  }

  if (!asn1_parse_integer_contents(bssl::Span(*inp, len), ret)) {
    if (ret != nullptr && (out == nullptr || *out != ret)) {
      ASN1_INTEGER_free(ret);
    }
    return nullptr;
  }

  *inp += len;
  if (out != nullptr) {
    *out = ret;
  }
  return ret;

}

int ASN1_INTEGER_set_int64(ASN1_INTEGER *a, int64_t v) {
  if (v >= 0) {
    return ASN1_INTEGER_set_uint64(a, (uint64_t)v);
  }

  if (!ASN1_INTEGER_set_uint64(a, 0 - (uint64_t)v)) {
    return 0;
  }

  a->type = V_ASN1_NEG_INTEGER;
  return 1;
}

int ASN1_ENUMERATED_set_int64(ASN1_ENUMERATED *a, int64_t v) {
  if (v >= 0) {
    return ASN1_ENUMERATED_set_uint64(a, (uint64_t)v);
  }

  if (!ASN1_ENUMERATED_set_uint64(a, 0 - (uint64_t)v)) {
    return 0;
  }

  a->type = V_ASN1_NEG_ENUMERATED;
  return 1;
}

int ASN1_INTEGER_set(ASN1_INTEGER *a, long v) {
  static_assert(sizeof(long) <= sizeof(int64_t), "long fits in int64_t");
  return ASN1_INTEGER_set_int64(a, v);
}

int ASN1_ENUMERATED_set(ASN1_ENUMERATED *a, long v) {
  static_assert(sizeof(long) <= sizeof(int64_t), "long fits in int64_t");
  return ASN1_ENUMERATED_set_int64(a, v);
}

static int asn1_string_set_uint64(ASN1_STRING *out, uint64_t v, int type) {
  uint8_t buf[sizeof(uint64_t)];
  CRYPTO_store_u64_be(buf, v);
  size_t leading_zeros;
  for (leading_zeros = 0; leading_zeros < sizeof(buf); leading_zeros++) {
    if (buf[leading_zeros] != 0) {
      break;
    }
  }

  if (!ASN1_STRING_set(out, buf + leading_zeros, sizeof(buf) - leading_zeros)) {
    return 0;
  }
  out->type = type;
  return 1;
}

int ASN1_INTEGER_set_uint64(ASN1_INTEGER *out, uint64_t v) {
  return asn1_string_set_uint64(out, v, V_ASN1_INTEGER);
}

int ASN1_ENUMERATED_set_uint64(ASN1_ENUMERATED *out, uint64_t v) {
  return asn1_string_set_uint64(out, v, V_ASN1_ENUMERATED);
}

static int asn1_string_get_abs_uint64(uint64_t *out, const ASN1_STRING *a,
                                      int type) {
  if ((a->type & ~V_ASN1_NEG) != type) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_INTEGER_TYPE);
    return 0;
  }
  uint8_t buf[sizeof(uint64_t)] = {0};
  if (a->length > (int)sizeof(buf)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_INTEGER);
    return 0;
  }
  OPENSSL_memcpy(buf + sizeof(buf) - a->length, a->data, a->length);
  *out = CRYPTO_load_u64_be(buf);
  return 1;
}

static int asn1_string_get_uint64(uint64_t *out, const ASN1_STRING *a,
                                  int type) {
  if (!asn1_string_get_abs_uint64(out, a, type)) {
    return 0;
  }
  if (a->type & V_ASN1_NEG) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_INTEGER);
    return 0;
  }
  return 1;
}

int ASN1_INTEGER_get_uint64(uint64_t *out, const ASN1_INTEGER *a) {
  return asn1_string_get_uint64(out, a, V_ASN1_INTEGER);
}

int ASN1_ENUMERATED_get_uint64(uint64_t *out, const ASN1_ENUMERATED *a) {
  return asn1_string_get_uint64(out, a, V_ASN1_ENUMERATED);
}

static int asn1_string_get_int64(int64_t *out, const ASN1_STRING *a, int type) {
  uint64_t v;
  if (!asn1_string_get_abs_uint64(&v, a, type)) {
    return 0;
  }
  int64_t i64;
  int fits_in_i64;
  // Check |v != 0| to handle manually-constructed negative zeros.
  if ((a->type & V_ASN1_NEG) && v != 0) {
    i64 = (int64_t)(0u - v);
    fits_in_i64 = i64 < 0;
  } else {
    i64 = (int64_t)v;
    fits_in_i64 = i64 >= 0;
  }
  if (!fits_in_i64) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_INTEGER);
    return 0;
  }
  *out = i64;
  return 1;
}

int ASN1_INTEGER_get_int64(int64_t *out, const ASN1_INTEGER *a) {
  return asn1_string_get_int64(out, a, V_ASN1_INTEGER);
}

int ASN1_ENUMERATED_get_int64(int64_t *out, const ASN1_ENUMERATED *a) {
  return asn1_string_get_int64(out, a, V_ASN1_ENUMERATED);
}

static long asn1_string_get_long(const ASN1_STRING *a, int type) {
  if (a == nullptr) {
    return 0;
  }

  int64_t v;
  if (!asn1_string_get_int64(&v, a, type) ||  //
      v < LONG_MIN || v > LONG_MAX) {
    // This function's return value does not distinguish overflow from -1.
    ERR_clear_error();
    return -1;
  }

  return (long)v;
}

long ASN1_INTEGER_get(const ASN1_INTEGER *a) {
  return asn1_string_get_long(a, V_ASN1_INTEGER);
}

long ASN1_ENUMERATED_get(const ASN1_ENUMERATED *a) {
  return asn1_string_get_long(a, V_ASN1_ENUMERATED);
}

static ASN1_STRING *bn_to_asn1_string(const BIGNUM *bn, ASN1_STRING *ai,
                                      int type) {
  ASN1_INTEGER *ret;
  if (ai == nullptr) {
    ret = ASN1_STRING_type_new(type);
  } else {
    ret = ai;
  }
  int len;
  if (ret == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_NESTED_ASN1_ERROR);
    goto err;
  }

  if (BN_is_negative(bn) && !BN_is_zero(bn)) {
    ret->type = type | V_ASN1_NEG;
  } else {
    ret->type = type;
  }

  len = BN_num_bytes(bn);
  if (!ASN1_STRING_set(ret, nullptr, len) ||
      !BN_bn2bin_padded(ret->data, len, bn)) {
    goto err;
  }
  return ret;

err:
  if (ret != ai) {
    ASN1_STRING_free(ret);
  }
  return nullptr;
}

ASN1_INTEGER *BN_to_ASN1_INTEGER(const BIGNUM *bn, ASN1_INTEGER *ai) {
  return bn_to_asn1_string(bn, ai, V_ASN1_INTEGER);
}

ASN1_ENUMERATED *BN_to_ASN1_ENUMERATED(const BIGNUM *bn, ASN1_ENUMERATED *ai) {
  return bn_to_asn1_string(bn, ai, V_ASN1_ENUMERATED);
}

static BIGNUM *asn1_string_to_bn(const ASN1_STRING *ai, BIGNUM *bn, int type) {
  if ((ai->type & ~V_ASN1_NEG) != type) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_INTEGER_TYPE);
    return nullptr;
  }

  BIGNUM *ret;
  if ((ret = BN_bin2bn(ai->data, ai->length, bn)) == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_BN_LIB);
  } else if (ai->type & V_ASN1_NEG) {
    BN_set_negative(ret, 1);
  }
  return ret;
}

BIGNUM *ASN1_INTEGER_to_BN(const ASN1_INTEGER *ai, BIGNUM *bn) {
  return asn1_string_to_bn(ai, bn, V_ASN1_INTEGER);
}

BIGNUM *ASN1_ENUMERATED_to_BN(const ASN1_ENUMERATED *ai, BIGNUM *bn) {
  return asn1_string_to_bn(ai, bn, V_ASN1_ENUMERATED);
}
