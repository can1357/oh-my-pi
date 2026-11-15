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

#include <limits.h>
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/span.h>

#include "../internal.h"
#include "internal.h"


int ASN1_BIT_STRING_set(ASN1_BIT_STRING *x, const unsigned char *d,
                        ossl_ssize_t len) {
  return ASN1_STRING_set(x, d, len);
}

int asn1_bit_string_length(const ASN1_BIT_STRING *str,
                           uint8_t *out_padding_bits) {
  int len = str->length;
  if (str->flags & ASN1_STRING_FLAG_BITS_LEFT) {
    // If the string is already empty, it cannot have padding bits.
    *out_padding_bits = len == 0 ? 0 : str->flags & 0x07;
    return len;
  }

  // TODO(https://crbug.com/boringssl/447): If we move this logic to
  // |ASN1_BIT_STRING_set_bit|, can we remove this representation?
  while (len > 0 && str->data[len - 1] == 0) {
    len--;
  }
  uint8_t padding_bits = 0;
  if (len > 0) {
    uint8_t last = str->data[len - 1];
    assert(last != 0);
    for (; padding_bits < 7; padding_bits++) {
      if (last & (1 << padding_bits)) {
        break;
      }
    }
  }
  *out_padding_bits = padding_bits;
  return len;
}

int ASN1_BIT_STRING_num_bytes(const ASN1_BIT_STRING *str, size_t *out) {
  uint8_t padding_bits;
  int len = asn1_bit_string_length(str, &padding_bits);
  if (padding_bits != 0) {
    return 0;
  }
  *out = len;
  return 1;
}

int i2c_ASN1_BIT_STRING(const ASN1_BIT_STRING *a, unsigned char **pp) {
  if (a == nullptr) {
    return 0;
  }

  uint8_t bits;
  int len = asn1_bit_string_length(a, &bits);
  if (len > INT_MAX - 1) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_OVERFLOW);
    return 0;
  }
  int ret = 1 + len;
  if (pp == nullptr) {
    return ret;
  }

  uint8_t *p = *pp;
  *(p++) = bits;
  OPENSSL_memcpy(p, a->data, len);
  if (len > 0) {
    p[len - 1] &= (0xff << bits);
  }
  p += len;
  *pp = p;
  return ret;
}

int asn1_marshal_bit_string(CBB *out, const ASN1_BIT_STRING *in,
                            CBS_ASN1_TAG tag) {
  int len = i2c_ASN1_BIT_STRING(in, nullptr);
  if (len <= 0) {
    return 0;
  }
  tag = tag == 0 ? CBS_ASN1_BITSTRING : tag;
  CBB child;
  uint8_t *ptr;
  return CBB_add_asn1(out, &child, tag) &&                         //
         CBB_add_space(&child, &ptr, static_cast<size_t>(len)) &&  //
         i2c_ASN1_BIT_STRING(in, &ptr) == len &&                   //
         CBB_flush(out);
}

static int asn1_parse_bit_string_contents(bssl::Span<const uint8_t> in,
                                          ASN1_BIT_STRING *out) {
  CBS cbs = in;
  uint8_t padding;
  if (!CBS_get_u8(&cbs, &padding)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_STRING_TOO_SHORT);
    return 0;
  }

  if (padding > 7) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_BIT_STRING_BITS_LEFT);
    return 0;
  }

  // Unused bits in a BIT STRING must be zero.
  uint8_t padding_mask = (1 << padding) - 1;
  if (padding != 0) {
    CBS copy = cbs;
    uint8_t last;
    if (!CBS_get_last_u8(&copy, &last) || (last & padding_mask) != 0) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_BIT_STRING_PADDING);
      return 0;
    }
  }

  if (!ASN1_STRING_set(out, CBS_data(&cbs), CBS_len(&cbs))) {
    return 0;
  }

  out->type = V_ASN1_BIT_STRING;
  // |ASN1_STRING_FLAG_BITS_LEFT| and the bottom 3 bits encode |padding|.
  out->flags &= ~0x07;
  out->flags |= ASN1_STRING_FLAG_BITS_LEFT | padding;
  return 1;
}

ASN1_BIT_STRING *c2i_ASN1_BIT_STRING(ASN1_BIT_STRING **a,
                                     const unsigned char **pp, long len) {
  if (len < 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_STRING_TOO_SHORT);
    return nullptr;
  }

  ASN1_BIT_STRING *ret = nullptr;
  if (a == nullptr || *a == nullptr) {
    if ((ret = ASN1_BIT_STRING_new()) == nullptr) {
      return nullptr;
    }
  } else {
    ret = *a;
  }

  if (!asn1_parse_bit_string_contents(bssl::Span(*pp, len), ret)) {
    if (ret != nullptr && (a == nullptr || *a != ret)) {
      ASN1_BIT_STRING_free(ret);
    }
    return nullptr;
  }

  if (a != nullptr) {
    *a = ret;
  }
  *pp += len;
  return ret;
}

int asn1_parse_bit_string(CBS *cbs, ASN1_BIT_STRING *out, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_BITSTRING : tag;
  CBS child;
  if (!CBS_get_asn1(cbs, &child, tag)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  return asn1_parse_bit_string_contents(child, out);
}

int asn1_parse_bit_string_with_bad_length(CBS *cbs, ASN1_BIT_STRING *out) {
  CBS child;
  CBS_ASN1_TAG tag;
  size_t header_len;
  int indefinite;
  if (!CBS_get_any_ber_asn1_element(cbs, &child, &tag, &header_len,
                                    /*out_ber_found=*/nullptr,
                                    &indefinite) ||
      tag != CBS_ASN1_BITSTRING || indefinite ||  //
      !CBS_skip(&child, header_len)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  return asn1_parse_bit_string_contents(child, out);
}

// These next 2 functions from Goetz Babin-Ebell <babinebell@trustcenter.de>
int ASN1_BIT_STRING_set_bit(ASN1_BIT_STRING *a, int n, int value) {
  int w, v, iv;
  unsigned char *c;

  w = n / 8;
  v = 1 << (7 - (n & 0x07));
  iv = ~v;
  if (!value) {
    v = 0;
  }

  if (a == nullptr) {
    return 0;
  }

  a->flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);  // clear, set on write

  if ((a->length < (w + 1)) || (a->data == nullptr)) {
    if (!value) {
      return 1;  // Don't need to set
    }
    if (a->data == nullptr) {
      c = (unsigned char *)OPENSSL_malloc(w + 1);
    } else {
      c = (unsigned char *)OPENSSL_realloc(a->data, w + 1);
    }
    if (c == nullptr) {
      return 0;
    }
    if (w + 1 - a->length > 0) {
      OPENSSL_memset(c + a->length, 0, w + 1 - a->length);
    }
    a->data = c;
    a->length = w + 1;
  }
  a->data[w] = ((a->data[w]) & iv) | v;
  while ((a->length > 0) && (a->data[a->length - 1] == 0)) {
    a->length--;
  }
  return 1;
}

int ASN1_BIT_STRING_get_bit(const ASN1_BIT_STRING *a, int n) {
  int w, v;

  w = n / 8;
  v = 1 << (7 - (n & 0x07));
  if ((a == nullptr) || (a->length < (w + 1)) || (a->data == nullptr)) {
    return 0;
  }
  return ((a->data[w] & v) != 0);
}

// Checks if the given bit string contains only bits specified by
// the flags vector. Returns 0 if there is at least one bit set in 'a'
// which is not specified in 'flags', 1 otherwise.
// 'len' is the length of 'flags'.
int ASN1_BIT_STRING_check(const ASN1_BIT_STRING *a, const unsigned char *flags,
                          int flags_len) {
  int i, ok;
  // Check if there is one bit set at all.
  if (!a || !a->data) {
    return 1;
  }

  // Check each byte of the internal representation of the bit string.
  ok = 1;
  for (i = 0; i < a->length && ok; ++i) {
    unsigned char mask = i < flags_len ? ~flags[i] : 0xff;
    // We are done if there is an unneeded bit set.
    ok = (a->data[i] & mask) == 0;
  }
  return ok;
}
