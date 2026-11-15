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
#include <openssl/obj.h>

#include "../bytestring/internal.h"
#include "../internal.h"
#include "internal.h"


int asn1_marshal_object(CBB *out, const ASN1_OBJECT *in, CBS_ASN1_TAG tag) {
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  if (in->length <= 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_ILLEGAL_OBJECT);
    return 0;
  }

  tag = tag == 0 ? CBS_ASN1_OBJECT : tag;
  return CBB_add_asn1_element(out, tag, in->data, in->length);
}

int i2d_ASN1_OBJECT(const ASN1_OBJECT *in, unsigned char **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/static_cast<size_t>(in->length) + 2, outp,
      [&](CBB *cbb) -> bool {
        return asn1_marshal_object(cbb, in, /*tag=*/0);
      });
}

int i2t_ASN1_OBJECT(char *buf, int buf_len, const ASN1_OBJECT *a) {
  return OBJ_obj2txt(buf, buf_len, a, 0);
}

static int write_str(BIO *bp, const char *str) {
  size_t len = strlen(str);
  if (len > INT_MAX) {
    OPENSSL_PUT_ERROR(ASN1, ERR_R_OVERFLOW);
    return -1;
  }
  return BIO_write(bp, str, (int)len) == (int)len ? (int)len : -1;
}

int i2a_ASN1_OBJECT(BIO *bp, const ASN1_OBJECT *a) {
  if (a == nullptr || a->data == nullptr) {
    return write_str(bp, "NULL");
  }

  char buf[80], *allocated = nullptr;
  const char *str = buf;
  int len = i2t_ASN1_OBJECT(buf, sizeof(buf), a);
  if (len > (int)sizeof(buf) - 1) {
    // The input was truncated. Allocate a buffer that fits.
    allocated = reinterpret_cast<char *>(OPENSSL_malloc(len + 1));
    if (allocated == nullptr) {
      return -1;
    }
    len = i2t_ASN1_OBJECT(allocated, len + 1, a);
    str = allocated;
  }
  if (len <= 0) {
    str = "<INVALID>";
  }

  int ret = write_str(bp, str);
  OPENSSL_free(allocated);
  return ret;
}

ASN1_OBJECT *d2i_ASN1_OBJECT(ASN1_OBJECT **out, const unsigned char **inp,
                             long len) {
  return bssl::D2IFromCBS(out, inp, len, [](CBS *cbs) -> ASN1_OBJECT * {
    CBS child;
    if (!CBS_get_asn1(cbs, &child, CBS_ASN1_OBJECT)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return nullptr;
    }
    const uint8_t *contents = CBS_data(&child);
    return c2i_ASN1_OBJECT(nullptr, &contents, CBS_len(&child));
  });
}

ASN1_OBJECT *c2i_ASN1_OBJECT(ASN1_OBJECT **out, const unsigned char **inp,
                             long len) {
  return bssl::D2IFromCBS(out, inp, len, [](CBS *cbs) -> ASN1_OBJECT * {
    if (!CBS_is_valid_asn1_oid(cbs)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_OBJECT_ENCODING);
      return nullptr;
    }
    ASN1_OBJECT *ret =
        ASN1_OBJECT_create(NID_undef, CBS_data(cbs), CBS_len(cbs),
                           /*sn=*/nullptr, /*ln=*/nullptr);
    if (ret != nullptr) {
      // |c2i_ASN1_OBJECT| consumes its whole input on success.
      BSSL_CHECK(CBS_skip(cbs, CBS_len(cbs)));
    }
    return ret;
  });
}

ASN1_OBJECT *asn1_parse_object(CBS *cbs, CBS_ASN1_TAG tag) {
  tag = tag == 0 ? CBS_ASN1_OBJECT : tag;
  CBS child;
  if (!CBS_get_asn1(cbs, &child, tag)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return nullptr;
  }
  if (!CBS_is_valid_asn1_oid(&child)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_INVALID_OBJECT_ENCODING);
    return nullptr;
  }
  return ASN1_OBJECT_create(NID_undef, CBS_data(&child), CBS_len(&child),
                            /*sn=*/nullptr, /*ln=*/nullptr);
}

ASN1_OBJECT *ASN1_OBJECT_new(void) {
  ASN1_OBJECT *ret;

  ret = (ASN1_OBJECT *)OPENSSL_malloc(sizeof(ASN1_OBJECT));
  if (ret == nullptr) {
    return nullptr;
  }
  ret->length = 0;
  ret->data = nullptr;
  ret->nid = 0;
  ret->sn = nullptr;
  ret->ln = nullptr;
  ret->flags = ASN1_OBJECT_FLAG_DYNAMIC;
  return ret;
}

void ASN1_OBJECT_free(ASN1_OBJECT *a) {
  if (a == nullptr) {
    return;
  }
  if (a->flags & ASN1_OBJECT_FLAG_DYNAMIC_STRINGS) {
    OPENSSL_free((void *)a->sn);
    OPENSSL_free((void *)a->ln);
    a->sn = a->ln = nullptr;
  }
  if (a->flags & ASN1_OBJECT_FLAG_DYNAMIC_DATA) {
    OPENSSL_free((void *)a->data);
    a->data = nullptr;
    a->length = 0;
  }
  if (a->flags & ASN1_OBJECT_FLAG_DYNAMIC) {
    OPENSSL_free(a);
  }
}

ASN1_OBJECT *ASN1_OBJECT_create(int nid, const unsigned char *data, size_t len,
                                const char *sn, const char *ln) {
  if (len > INT_MAX) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_STRING_TOO_LONG);
    return nullptr;
  }

  ASN1_OBJECT o;
  o.sn = sn;
  o.ln = ln;
  o.data = data;
  o.nid = nid;
  o.length = (int)len;
  o.flags = ASN1_OBJECT_FLAG_DYNAMIC | ASN1_OBJECT_FLAG_DYNAMIC_STRINGS |
            ASN1_OBJECT_FLAG_DYNAMIC_DATA;
  return OBJ_dup(&o);
}
