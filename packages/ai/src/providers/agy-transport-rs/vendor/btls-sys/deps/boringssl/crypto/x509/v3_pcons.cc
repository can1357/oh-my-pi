// Copyright 2003-2016 The OpenSSL Project Authors. All Rights Reserved.
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


static STACK_OF(CONF_VALUE) *i2v_POLICY_CONSTRAINTS(
    const X509V3_EXT_METHOD *method, void *bcons,
    STACK_OF(CONF_VALUE) *extlist);
static void *v2i_POLICY_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                    const X509V3_CTX *ctx,
                                    const STACK_OF(CONF_VALUE) *values);

const X509V3_EXT_METHOD v3_policy_constraints = {
    NID_policy_constraints,
    0,
    ASN1_ITEM_ref(POLICY_CONSTRAINTS),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2v_POLICY_CONSTRAINTS,
    v2i_POLICY_CONSTRAINTS,
    nullptr,
    nullptr,
    nullptr};

ASN1_SEQUENCE(POLICY_CONSTRAINTS) = {
    ASN1_IMP_OPT(POLICY_CONSTRAINTS, requireExplicitPolicy, ASN1_INTEGER, 0),
    ASN1_IMP_OPT(POLICY_CONSTRAINTS, inhibitPolicyMapping, ASN1_INTEGER, 1),
} ASN1_SEQUENCE_END(POLICY_CONSTRAINTS)

IMPLEMENT_ASN1_ALLOC_FUNCTIONS(POLICY_CONSTRAINTS)

static STACK_OF(CONF_VALUE) *i2v_POLICY_CONSTRAINTS(
    const X509V3_EXT_METHOD *method, void *a, STACK_OF(CONF_VALUE) *extlist) {
  const POLICY_CONSTRAINTS *pcons = reinterpret_cast<POLICY_CONSTRAINTS *>(a);
  X509V3_add_value_int("Require Explicit Policy", pcons->requireExplicitPolicy,
                       &extlist);
  X509V3_add_value_int("Inhibit Policy Mapping", pcons->inhibitPolicyMapping,
                       &extlist);
  return extlist;
}

static void *v2i_POLICY_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                    const X509V3_CTX *ctx,
                                    const STACK_OF(CONF_VALUE) *values) {
  POLICY_CONSTRAINTS *pcons = nullptr;
  if (!(pcons = POLICY_CONSTRAINTS_new())) {
    return nullptr;
  }
  for (size_t i = 0; i < sk_CONF_VALUE_num(values); i++) {
    const CONF_VALUE *val = sk_CONF_VALUE_value(values, i);
    if (!strcmp(val->name, "requireExplicitPolicy")) {
      if (!X509V3_get_value_int(val, &pcons->requireExplicitPolicy)) {
        goto err;
      }
    } else if (!strcmp(val->name, "inhibitPolicyMapping")) {
      if (!X509V3_get_value_int(val, &pcons->inhibitPolicyMapping)) {
        goto err;
      }
    } else {
      OPENSSL_PUT_ERROR(X509V3, X509V3_R_INVALID_NAME);
      X509V3_conf_err(val);
      goto err;
    }
  }
  if (!pcons->inhibitPolicyMapping && !pcons->requireExplicitPolicy) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_ILLEGAL_EMPTY_EXTENSION);
    goto err;
  }

  return pcons;
err:
  POLICY_CONSTRAINTS_free(pcons);
  return nullptr;
}
