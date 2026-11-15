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
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "internal.h"


int X509v3_get_ext_count(const STACK_OF(X509_EXTENSION) *x) {
  if (x == nullptr) {
    return 0;
  }
  return (int)sk_X509_EXTENSION_num(x);
}

int X509v3_get_ext_by_NID(const STACK_OF(X509_EXTENSION) *x, int nid,
                          int lastpos) {
  const ASN1_OBJECT *obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    return -1;
  }
  return X509v3_get_ext_by_OBJ(x, obj, lastpos);
}

int X509v3_get_ext_by_OBJ(const STACK_OF(X509_EXTENSION) *sk,
                          const ASN1_OBJECT *obj, int lastpos) {
  if (sk == nullptr) {
    return -1;
  }
  lastpos++;
  if (lastpos < 0) {
    lastpos = 0;
  }
  int n = (int)sk_X509_EXTENSION_num(sk);
  for (; lastpos < n; lastpos++) {
    const X509_EXTENSION *ex = sk_X509_EXTENSION_value(sk, lastpos);
    if (OBJ_cmp(ex->object, obj) == 0) {
      return lastpos;
    }
  }
  return -1;
}

int X509v3_get_ext_by_critical(const STACK_OF(X509_EXTENSION) *sk, int crit,
                               int lastpos) {
  if (sk == nullptr) {
    return -1;
  }

  lastpos++;
  if (lastpos < 0) {
    lastpos = 0;
  }

  crit = !!crit;
  int n = (int)sk_X509_EXTENSION_num(sk);
  for (; lastpos < n; lastpos++) {
    const X509_EXTENSION *ex = sk_X509_EXTENSION_value(sk, lastpos);
    if (X509_EXTENSION_get_critical(ex) == crit) {
      return lastpos;
    }
  }
  return -1;
}

X509_EXTENSION *X509v3_get_ext(const STACK_OF(X509_EXTENSION) *x, int loc) {
  if (x == nullptr || loc < 0 || sk_X509_EXTENSION_num(x) <= (size_t)loc) {
    return nullptr;
  } else {
    return sk_X509_EXTENSION_value(x, loc);
  }
}

X509_EXTENSION *X509v3_delete_ext(STACK_OF(X509_EXTENSION) *x, int loc) {
  X509_EXTENSION *ret;

  if (x == nullptr || loc < 0 || sk_X509_EXTENSION_num(x) <= (size_t)loc) {
    return nullptr;
  }
  ret = sk_X509_EXTENSION_delete(x, loc);
  return ret;
}

STACK_OF(X509_EXTENSION) *X509v3_add_ext(STACK_OF(X509_EXTENSION) **x,
                                         const X509_EXTENSION *ex, int loc) {
  X509_EXTENSION *new_ex = nullptr;
  STACK_OF(X509_EXTENSION) *sk = nullptr;
  int free_sk = 0, n;

  if (x == nullptr) {
    OPENSSL_PUT_ERROR(X509, ERR_R_PASSED_NULL_PARAMETER);
    goto err;
  }

  if (*x == nullptr) {
    if ((sk = sk_X509_EXTENSION_new_null()) == nullptr) {
      goto err;
    }
    free_sk = 1;
  } else {
    sk = *x;
  }

  n = (int)sk_X509_EXTENSION_num(sk);
  if (loc > n) {
    loc = n;
  } else if (loc < 0) {
    loc = n;
  }

  if ((new_ex = X509_EXTENSION_dup(ex)) == nullptr) {
    goto err;
  }
  if (!sk_X509_EXTENSION_insert(sk, new_ex, loc)) {
    goto err;
  }
  if (*x == nullptr) {
    *x = sk;
  }
  return sk;

err:
  X509_EXTENSION_free(new_ex);
  if (free_sk) {
    sk_X509_EXTENSION_free(sk);
  }
  return nullptr;
}

X509_EXTENSION *X509_EXTENSION_create_by_NID(X509_EXTENSION **ex, int nid,
                                             int crit,
                                             const ASN1_OCTET_STRING *data) {
  const ASN1_OBJECT *obj;
  X509_EXTENSION *ret;

  obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_UNKNOWN_NID);
    return nullptr;
  }
  ret = X509_EXTENSION_create_by_OBJ(ex, obj, crit, data);
  return ret;
}

X509_EXTENSION *X509_EXTENSION_create_by_OBJ(X509_EXTENSION **ex,
                                             const ASN1_OBJECT *obj, int crit,
                                             const ASN1_OCTET_STRING *data) {
  X509_EXTENSION *ret;

  if ((ex == nullptr) || (*ex == nullptr)) {
    if ((ret = X509_EXTENSION_new()) == nullptr) {
      return nullptr;
    }
  } else {
    ret = *ex;
  }

  if (!X509_EXTENSION_set_object(ret, obj)) {
    goto err;
  }
  if (!X509_EXTENSION_set_critical(ret, crit)) {
    goto err;
  }
  if (!X509_EXTENSION_set_data(ret, data)) {
    goto err;
  }

  if ((ex != nullptr) && (*ex == nullptr)) {
    *ex = ret;
  }
  return ret;
err:
  if ((ex == nullptr) || (ret != *ex)) {
    X509_EXTENSION_free(ret);
  }
  return nullptr;
}

int X509_EXTENSION_set_object(X509_EXTENSION *ex, const ASN1_OBJECT *obj) {
  if ((ex == nullptr) || (obj == nullptr)) {
    return 0;
  }
  ASN1_OBJECT_free(ex->object);
  ex->object = OBJ_dup(obj);
  return ex->object != nullptr;
}

int X509_EXTENSION_set_critical(X509_EXTENSION *ex, int crit) {
  if (ex == nullptr) {
    return 0;
  }
  // The critical field is DEFAULT FALSE, so non-critical extensions should omit
  // the value.
  ex->critical = crit ? ASN1_BOOLEAN_TRUE : ASN1_BOOLEAN_NONE;
  return 1;
}

int X509_EXTENSION_set_data(X509_EXTENSION *ex, const ASN1_OCTET_STRING *data) {
  int i;

  if (ex == nullptr) {
    return 0;
  }
  i = ASN1_OCTET_STRING_set(ex->value, data->data, data->length);
  if (!i) {
    return 0;
  }
  return 1;
}

ASN1_OBJECT *X509_EXTENSION_get_object(const X509_EXTENSION *ex) {
  if (ex == nullptr) {
    return nullptr;
  }
  return ex->object;
}

ASN1_OCTET_STRING *X509_EXTENSION_get_data(const X509_EXTENSION *ex) {
  if (ex == nullptr) {
    return nullptr;
  }
  return ex->value;
}

int X509_EXTENSION_get_critical(const X509_EXTENSION *ex) {
  if (ex == nullptr) {
    return 0;
  }
  if (ex->critical > 0) {
    return 1;
  }
  return 0;
}
