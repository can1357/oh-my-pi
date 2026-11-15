// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <stdio.h>
#include <string.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/conf.h>
#include <openssl/err.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


static STACK_OF(CONF_VALUE) *i2v_BASIC_CONSTRAINTS(
    const X509V3_EXT_METHOD *method, void *ext, STACK_OF(CONF_VALUE) *extlist);
static void *v2i_BASIC_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                   const X509V3_CTX *ctx,
                                   const STACK_OF(CONF_VALUE) *values);

const X509V3_EXT_METHOD v3_bcons = {
    NID_basic_constraints,
    0,
    ASN1_ITEM_ref(BASIC_CONSTRAINTS),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2v_BASIC_CONSTRAINTS,
    v2i_BASIC_CONSTRAINTS,
    nullptr,
    nullptr,
    nullptr,
};

ASN1_SEQUENCE(BASIC_CONSTRAINTS) = {
    ASN1_OPT(BASIC_CONSTRAINTS, ca, ASN1_FBOOLEAN),
    ASN1_OPT(BASIC_CONSTRAINTS, pathlen, ASN1_INTEGER),
} ASN1_SEQUENCE_END(BASIC_CONSTRAINTS)

IMPLEMENT_ASN1_FUNCTIONS_const(BASIC_CONSTRAINTS)

static STACK_OF(CONF_VALUE) *i2v_BASIC_CONSTRAINTS(
    const X509V3_EXT_METHOD *method, void *ext, STACK_OF(CONF_VALUE) *extlist) {
  const BASIC_CONSTRAINTS *bcons =
      reinterpret_cast<const BASIC_CONSTRAINTS *>(ext);
  X509V3_add_value_bool("CA", bcons->ca, &extlist);
  X509V3_add_value_int("pathlen", bcons->pathlen, &extlist);
  return extlist;
}

static void *v2i_BASIC_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                   const X509V3_CTX *ctx,
                                   const STACK_OF(CONF_VALUE) *values) {
  BASIC_CONSTRAINTS *bcons = nullptr;
  if (!(bcons = BASIC_CONSTRAINTS_new())) {
    return nullptr;
  }
  for (size_t i = 0; i < sk_CONF_VALUE_num(values); i++) {
    const CONF_VALUE *val = sk_CONF_VALUE_value(values, i);
    if (!strcmp(val->name, "CA")) {
      if (!X509V3_get_value_bool(val, &bcons->ca)) {
        goto err;
      }
    } else if (!strcmp(val->name, "pathlen")) {
      if (!X509V3_get_value_int(val, &bcons->pathlen)) {
        goto err;
      }
    } else {
      OPENSSL_PUT_ERROR(X509V3, X509V3_R_INVALID_NAME);
      X509V3_conf_err(val);
      goto err;
    }
  }
  return bcons;
err:
  BASIC_CONSTRAINTS_free(bcons);
  return nullptr;
}
