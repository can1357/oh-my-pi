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

#include <openssl/asn1t.h>
#include <openssl/conf.h>
#include <openssl/err.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


static void *v2i_EXTENDED_KEY_USAGE(const X509V3_EXT_METHOD *method,
                                    const X509V3_CTX *ctx,
                                    const STACK_OF(CONF_VALUE) *nval);
static STACK_OF(CONF_VALUE) *i2v_EXTENDED_KEY_USAGE(
    const X509V3_EXT_METHOD *method, void *eku, STACK_OF(CONF_VALUE) *extlist);

const X509V3_EXT_METHOD v3_ext_ku = {
    NID_ext_key_usage,
    0,
    ASN1_ITEM_ref(EXTENDED_KEY_USAGE),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2v_EXTENDED_KEY_USAGE,
    v2i_EXTENDED_KEY_USAGE,
    nullptr,
    nullptr,
    nullptr,
};

ASN1_ITEM_TEMPLATE(EXTENDED_KEY_USAGE) = ASN1_EX_TEMPLATE_TYPE(
    ASN1_TFLG_SEQUENCE_OF, 0, EXTENDED_KEY_USAGE, ASN1_OBJECT)
ASN1_ITEM_TEMPLATE_END(EXTENDED_KEY_USAGE)

IMPLEMENT_ASN1_FUNCTIONS_const(EXTENDED_KEY_USAGE)

static STACK_OF(CONF_VALUE) *i2v_EXTENDED_KEY_USAGE(
    const X509V3_EXT_METHOD *method, void *a, STACK_OF(CONF_VALUE) *ext_list) {
  const EXTENDED_KEY_USAGE *eku =
      reinterpret_cast<const EXTENDED_KEY_USAGE *>(a);
  for (size_t i = 0; i < sk_ASN1_OBJECT_num(eku); i++) {
    const ASN1_OBJECT *obj = sk_ASN1_OBJECT_value(eku, i);
    char obj_tmp[80];
    i2t_ASN1_OBJECT(obj_tmp, 80, obj);
    X509V3_add_value(nullptr, obj_tmp, &ext_list);
  }
  return ext_list;
}

static void *v2i_EXTENDED_KEY_USAGE(const X509V3_EXT_METHOD *method,
                                    const X509V3_CTX *ctx,
                                    const STACK_OF(CONF_VALUE) *nval) {
  EXTENDED_KEY_USAGE *extku = sk_ASN1_OBJECT_new_null();
  if (extku == nullptr) {
    return nullptr;
  }

  for (size_t i = 0; i < sk_CONF_VALUE_num(nval); i++) {
    const CONF_VALUE *val = sk_CONF_VALUE_value(nval, i);
    const char *extval;
    if (val->value) {
      extval = val->value;
    } else {
      extval = val->name;
    }
    ASN1_OBJECT *obj = OBJ_txt2obj(extval, 0);
    if (obj == nullptr || !sk_ASN1_OBJECT_push(extku, obj)) {
      ASN1_OBJECT_free(obj);
      sk_ASN1_OBJECT_pop_free(extku, ASN1_OBJECT_free);
      OPENSSL_PUT_ERROR(X509V3, X509V3_R_INVALID_OBJECT_IDENTIFIER);
      X509V3_conf_err(val);
      return nullptr;
    }
  }

  return extku;
}
