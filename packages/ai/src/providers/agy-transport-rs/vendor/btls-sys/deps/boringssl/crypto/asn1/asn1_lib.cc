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

#include "../internal.h"
#include "internal.h"


// Cross-module errors from crypto/x509/i2d_pr.c.
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNSUPPORTED_PUBLIC_KEY_TYPE)

// Cross-module errors from crypto/x509/algorithm.c.
OPENSSL_DECLARE_ERROR_REASON(ASN1, CONTEXT_NOT_INITIALISED)
OPENSSL_DECLARE_ERROR_REASON(ASN1, DIGEST_AND_KEY_TYPE_NOT_SUPPORTED)
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNKNOWN_MESSAGE_DIGEST_ALGORITHM)
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNKNOWN_SIGNATURE_ALGORITHM)
OPENSSL_DECLARE_ERROR_REASON(ASN1, WRONG_PUBLIC_KEY_TYPE)
// Cross-module errors from crypto/x509/asn1_gen.c. TODO(davidben): Remove
// these once asn1_gen.c is gone.
OPENSSL_DECLARE_ERROR_REASON(ASN1, DEPTH_EXCEEDED)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_BITSTRING_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_BOOLEAN)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_HEX)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_IMPLICIT_TAG)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_INTEGER)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_NESTED_TAGGING)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_NULL_VALUE)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_OBJECT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ILLEGAL_TIME_VALUE)
OPENSSL_DECLARE_ERROR_REASON(ASN1, INTEGER_NOT_ASCII_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, INVALID_MODIFIER)
OPENSSL_DECLARE_ERROR_REASON(ASN1, INVALID_NUMBER)
OPENSSL_DECLARE_ERROR_REASON(ASN1, LIST_ERROR)
OPENSSL_DECLARE_ERROR_REASON(ASN1, MISSING_VALUE)
OPENSSL_DECLARE_ERROR_REASON(ASN1, NOT_ASCII_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, OBJECT_NOT_ASCII_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, SEQUENCE_OR_SET_NEEDS_CONFIG)
OPENSSL_DECLARE_ERROR_REASON(ASN1, TIME_NOT_ASCII_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNKNOWN_FORMAT)
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNKNOWN_TAG)
OPENSSL_DECLARE_ERROR_REASON(ASN1, UNSUPPORTED_TYPE)

// Limit |ASN1_STRING|s to 64 MiB of data. Most of this module, as well as
// downstream code, does not correctly handle overflow. We cap string fields
// more tightly than strictly necessary to fit in |int|. This is not expected to
// impact real world uses of this field.
//
// In particular, this limit is small enough that the bit count of a BIT STRING
// comfortably fits in an |int|, with room for arithmetic.
#define ASN1_STRING_MAX (64 * 1024 * 1024)

static void asn1_put_length(unsigned char **pp, int length);

int ASN1_get_object(const unsigned char **inp, long *out_len, int *out_tag,
                    int *out_class, long in_len) {
  if (in_len < 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_HEADER_TOO_LONG);
    return 0x80;
  }

  CBS_ASN1_TAG tag;
  CBS cbs, body;
  CBS_init(&cbs, *inp, (size_t)in_len);
  if (!CBS_get_any_asn1(&cbs, &body, &tag) ||
      // Bound the length to comfortably fit in an int. Lengths in this
      // module often switch between int and long without overflow checks.
      CBS_len(&body) > INT_MAX / 2) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_HEADER_TOO_LONG);
    return 0x80;
  }

  // Convert between tag representations.
  int tag_class = (tag & CBS_ASN1_CLASS_MASK) >> CBS_ASN1_TAG_SHIFT;
  int constructed = (tag & CBS_ASN1_CONSTRUCTED) >> CBS_ASN1_TAG_SHIFT;
  int tag_number = tag & CBS_ASN1_TAG_NUMBER_MASK;

  // To avoid ambiguity with V_ASN1_NEG, impose a limit on universal tags.
  if (tag_class == V_ASN1_UNIVERSAL && tag_number > V_ASN1_MAX_UNIVERSAL) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_HEADER_TOO_LONG);
    return 0x80;
  }

  *inp = CBS_data(&body);
  *out_len = CBS_len(&body);
  *out_tag = tag_number;
  *out_class = tag_class;
  return constructed;
}

// class 0 is constructed constructed == 2 for indefinite length constructed
void ASN1_put_object(unsigned char **pp, int constructed, int length, int tag,
                     int xclass) {
  unsigned char *p = *pp;
  int i, ttag;

  i = (constructed) ? V_ASN1_CONSTRUCTED : 0;
  i |= (xclass & V_ASN1_PRIVATE);
  if (tag < 31) {
    *(p++) = i | (tag & V_ASN1_PRIMITIVE_TAG);
  } else {
    *(p++) = i | V_ASN1_PRIMITIVE_TAG;
    for (i = 0, ttag = tag; ttag > 0; i++) {
      ttag >>= 7;
    }
    ttag = i;
    while (i-- > 0) {
      p[i] = tag & 0x7f;
      if (i != (ttag - 1)) {
        p[i] |= 0x80;
      }
      tag >>= 7;
    }
    p += ttag;
  }
  if (constructed == 2) {
    *(p++) = 0x80;
  } else {
    asn1_put_length(&p, length);
  }
  *pp = p;
}

int ASN1_put_eoc(unsigned char **pp) {
  // This function is no longer used in the library, but some external code
  // uses it.
  unsigned char *p = *pp;
  *p++ = 0;
  *p++ = 0;
  *pp = p;
  return 2;
}

static void asn1_put_length(unsigned char **pp, int length) {
  unsigned char *p = *pp;
  int i, l;
  if (length <= 127) {
    *(p++) = (unsigned char)length;
  } else {
    l = length;
    for (i = 0; l > 0; i++) {
      l >>= 8;
    }
    *(p++) = i | 0x80;
    l = i;
    while (i-- > 0) {
      p[i] = length & 0xff;
      length >>= 8;
    }
    p += l;
  }
  *pp = p;
}

int ASN1_object_size(int constructed, int length, int tag) {
  int ret = 1;
  if (length < 0) {
    return -1;
  }
  if (tag >= 31) {
    while (tag > 0) {
      tag >>= 7;
      ret++;
    }
  }
  if (constructed == 2) {
    ret += 3;
  } else {
    ret++;
    if (length > 127) {
      int tmplen = length;
      while (tmplen > 0) {
        tmplen >>= 8;
        ret++;
      }
    }
  }
  if (ret >= INT_MAX - length) {
    return -1;
  }
  return ret + length;
}

int ASN1_STRING_copy(ASN1_STRING *dst, const ASN1_STRING *str) {
  if (str == nullptr) {
    return 0;
  }
  if (dst == str) {
    return 1;
  }
  if (!ASN1_STRING_set(dst, str->data, str->length)) {
    return 0;
  }
  dst->type = str->type;
  dst->flags = str->flags;
  return 1;
}

ASN1_STRING *ASN1_STRING_dup(const ASN1_STRING *str) {
  ASN1_STRING *ret;
  if (!str) {
    return nullptr;
  }
  ret = ASN1_STRING_new();
  if (!ret) {
    return nullptr;
  }
  if (!ASN1_STRING_copy(ret, str)) {
    ASN1_STRING_free(ret);
    return nullptr;
  }
  return ret;
}

int ASN1_STRING_set(ASN1_STRING *str, const void *_data, ossl_ssize_t len_s) {
  const char *data = reinterpret_cast<const char *>(_data);
  size_t len;
  if (len_s < 0) {
    if (data == nullptr) {
      return 0;
    }
    len = strlen(data);
  } else {
    len = (size_t)len_s;
  }

  static_assert(ASN1_STRING_MAX < INT_MAX, "len will not overflow int");
  if (len > ASN1_STRING_MAX) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_OVERFLOW);
    return 0;
  }

  if (str->length <= (int)len || str->data == nullptr) {
    unsigned char *c = str->data;
    if (c == nullptr) {
      str->data = reinterpret_cast<uint8_t *>(OPENSSL_malloc(len + 1));
    } else {
      str->data = reinterpret_cast<uint8_t *>(OPENSSL_realloc(c, len + 1));
    }

    if (str->data == nullptr) {
      str->data = c;
      return 0;
    }
  }
  str->length = (int)len;
  if (data != nullptr) {
    OPENSSL_memcpy(str->data, data, len);
    // Historically, OpenSSL would NUL-terminate most (but not all)
    // |ASN1_STRING|s, in case anyone accidentally passed |str->data| into a
    // function expecting a C string. We retain this behavior for compatibility,
    // but code must not rely on this. See CVE-2021-3712.
    str->data[len] = '\0';
  }
  return 1;
}

void ASN1_STRING_set0(ASN1_STRING *str, void *data, int len) {
  OPENSSL_free(str->data);
  str->data = reinterpret_cast<uint8_t *>(data);
  str->length = len;
}

ASN1_STRING *ASN1_STRING_new(void) {
  return (ASN1_STRING_type_new(V_ASN1_OCTET_STRING));
}

ASN1_STRING *ASN1_STRING_type_new(int type) {
  ASN1_STRING *ret;

  ret = (ASN1_STRING *)OPENSSL_malloc(sizeof(ASN1_STRING));
  if (ret == nullptr) {
    return nullptr;
  }
  ret->length = 0;
  ret->type = type;
  ret->data = nullptr;
  ret->flags = 0;
  return ret;
}

void asn1_string_init(ASN1_STRING *str, int type) {
  OPENSSL_memset(str, 0, sizeof(ASN1_STRING));
  str->type = type;
}

void asn1_string_cleanup(ASN1_STRING *str) {
  OPENSSL_free(str->data);
  str->data = nullptr;
}

void ASN1_STRING_free(ASN1_STRING *str) {
  if (str == nullptr) {
    return;
  }
  asn1_string_cleanup(str);
  OPENSSL_free(str);
}

int ASN1_STRING_cmp(const ASN1_STRING *a, const ASN1_STRING *b) {
  // Capture padding bits and implicit truncation in BIT STRINGs.
  int a_length = a->length, b_length = b->length;
  uint8_t a_padding = 0, b_padding = 0;
  if (a->type == V_ASN1_BIT_STRING) {
    a_length = asn1_bit_string_length(a, &a_padding);
  }
  if (b->type == V_ASN1_BIT_STRING) {
    b_length = asn1_bit_string_length(b, &b_padding);
  }

  if (a_length < b_length) {
    return -1;
  }
  if (a_length > b_length) {
    return 1;
  }
  // In a BIT STRING, the number of bits is 8 * length - padding. Invert this
  // comparison so we compare by lengths.
  if (a_padding > b_padding) {
    return -1;
  }
  if (a_padding < b_padding) {
    return 1;
  }

  int ret = OPENSSL_memcmp(a->data, b->data, a_length);
  if (ret != 0) {
    return ret;
  }

  // Comparing the type first is more natural, but this matches OpenSSL.
  if (a->type < b->type) {
    return -1;
  }
  if (a->type > b->type) {
    return 1;
  }
  return 0;
}

int ASN1_STRING_length(const ASN1_STRING *str) { return str->length; }

int ASN1_STRING_type(const ASN1_STRING *str) { return str->type; }

unsigned char *ASN1_STRING_data(ASN1_STRING *str) { return str->data; }

const unsigned char *ASN1_STRING_get0_data(const ASN1_STRING *str) {
  return str->data;
}

int asn1_parse_octet_string(CBS *cbs, ASN1_STRING *out, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_OCTETSTRING : tag;
  CBS child;
  if (!CBS_get_asn1(cbs, &child, tag)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  if (!ASN1_STRING_set(out, CBS_data(&child), CBS_len(&child))) {
    return 0;
  }
  out->type = V_ASN1_OCTET_STRING;
  return 1;
}

int asn1_marshal_octet_string(CBB *out, const ASN1_STRING *in,
                              CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_OCTETSTRING : tag;
  return CBB_add_asn1_element(out, tag, ASN1_STRING_get0_data(in),
                              ASN1_STRING_length(in));
}

static int asn1_parse_character_string(CBS *cbs, ASN1_STRING *out,
                                       CBS_ASN1_TAG tag, int str_type,
                                       int (*get_char)(CBS *cbs, uint32_t *),
                                       int bad_char_err) {
  CBS child;
  if (!CBS_get_asn1(cbs, &child, tag)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  CBS copy = child;
  while (CBS_len(&copy) != 0) {
    uint32_t c;
    if (!get_char(&copy, &c)) {
      OPENSSL_PUT_ERROR(ASN1, bad_char_err);
      return 0;
    }
  }
  if (!ASN1_STRING_set(out, CBS_data(&child), CBS_len(&child))) {
    return 0;
  }
  out->type = str_type;
  return 1;
}

int asn1_parse_bmp_string(CBS *cbs, ASN1_BMPSTRING *out, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_BMPSTRING : tag;
  return asn1_parse_character_string(cbs, out, tag, V_ASN1_BMPSTRING,
                                     &CBS_get_ucs2_be,
                                     ASN1_R_INVALID_BMPSTRING);
}

int asn1_parse_universal_string(CBS *cbs, ASN1_UNIVERSALSTRING *out,
                                CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_UNIVERSALSTRING : tag;
  return asn1_parse_character_string(cbs, out, tag, V_ASN1_UNIVERSALSTRING,
                                     &CBS_get_utf32_be,
                                     ASN1_R_INVALID_UNIVERSALSTRING);
}

int asn1_parse_utf8_string(CBS *cbs, ASN1_UNIVERSALSTRING *out,
                           CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_UTF8STRING : tag;
  return asn1_parse_character_string(cbs, out, tag, V_ASN1_UTF8STRING,
                                     &CBS_get_utf8, ASN1_R_INVALID_UTF8STRING);
}
