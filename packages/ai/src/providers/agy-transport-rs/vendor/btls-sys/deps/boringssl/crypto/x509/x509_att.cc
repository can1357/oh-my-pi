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
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "../asn1/internal.h"
#include "internal.h"


X509_ATTRIBUTE *X509_ATTRIBUTE_create_by_NID(X509_ATTRIBUTE **attr, int nid,
                                             int attrtype, const void *data,
                                             int len) {
  const ASN1_OBJECT *obj;

  obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_UNKNOWN_NID);
    return nullptr;
  }
  return X509_ATTRIBUTE_create_by_OBJ(attr, obj, attrtype, data, len);
}

X509_ATTRIBUTE *X509_ATTRIBUTE_create_by_OBJ(X509_ATTRIBUTE **attr,
                                             const ASN1_OBJECT *obj,
                                             int attrtype, const void *data,
                                             int len) {
  X509_ATTRIBUTE *ret;

  if ((attr == nullptr) || (*attr == nullptr)) {
    if ((ret = X509_ATTRIBUTE_new()) == nullptr) {
      return nullptr;
    }
  } else {
    ret = *attr;
  }

  if (!X509_ATTRIBUTE_set1_object(ret, obj)) {
    goto err;
  }
  if (!X509_ATTRIBUTE_set1_data(ret, attrtype, data, len)) {
    goto err;
  }

  if ((attr != nullptr) && (*attr == nullptr)) {
    *attr = ret;
  }
  return ret;
err:
  if ((attr == nullptr) || (ret != *attr)) {
    X509_ATTRIBUTE_free(ret);
  }
  return nullptr;
}

X509_ATTRIBUTE *X509_ATTRIBUTE_create_by_txt(X509_ATTRIBUTE **attr,
                                             const char *attrname, int type,
                                             const unsigned char *bytes,
                                             int len) {
  ASN1_OBJECT *obj;
  X509_ATTRIBUTE *nattr;

  obj = OBJ_txt2obj(attrname, 0);
  if (obj == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_FIELD_NAME);
    ERR_add_error_data(2, "name=", attrname);
    return nullptr;
  }
  nattr = X509_ATTRIBUTE_create_by_OBJ(attr, obj, type, bytes, len);
  ASN1_OBJECT_free(obj);
  return nattr;
}

int X509_ATTRIBUTE_set1_object(X509_ATTRIBUTE *attr, const ASN1_OBJECT *obj) {
  if ((attr == nullptr) || (obj == nullptr)) {
    return 0;
  }
  ASN1_OBJECT_free(attr->object);
  attr->object = OBJ_dup(obj);
  return attr->object != nullptr;
}

int X509_ATTRIBUTE_set1_data(X509_ATTRIBUTE *attr, int attrtype,
                             const void *data, int len) {
  if (!attr) {
    return 0;
  }

  if (attrtype == 0) {
    // Do nothing. This is used to create an empty value set in
    // |X509_ATTRIBUTE_create_by_*|. This is invalid, but supported by OpenSSL.
    return 1;
  }

  ASN1_TYPE *typ = ASN1_TYPE_new();
  if (typ == nullptr) {
    return 0;
  }

  // This function is several functions in one.
  if (attrtype & MBSTRING_FLAG) {
    // |data| is an encoded string. We must decode and re-encode it to |attr|'s
    // preferred ASN.1 type. Note |len| may be -1, in which case
    // |ASN1_STRING_set_by_NID| calls |strlen| automatically.
    ASN1_STRING *str =
        ASN1_STRING_set_by_NID(nullptr, reinterpret_cast<const uint8_t *>(data),
                               len, attrtype, OBJ_obj2nid(attr->object));
    if (str == nullptr) {
      OPENSSL_PUT_ERROR(X509, ERR_R_ASN1_LIB);
      goto err;
    }
    asn1_type_set0_string(typ, str);
  } else if (len != -1) {
    // |attrtype| must be a valid |ASN1_STRING| type. |data| and |len| is a
    // value in the corresponding |ASN1_STRING| representation.
    ASN1_STRING *str = ASN1_STRING_type_new(attrtype);
    if (str == nullptr || !ASN1_STRING_set(str, data, len)) {
      ASN1_STRING_free(str);
      goto err;
    }
    asn1_type_set0_string(typ, str);
  } else {
    // |attrtype| must be a valid |ASN1_TYPE| type. |data| is a pointer to an
    // object of the corresponding type.
    if (!ASN1_TYPE_set1(typ, attrtype, data)) {
      goto err;
    }
  }

  if (!sk_ASN1_TYPE_push(attr->set, typ)) {
    goto err;
  }
  return 1;

err:
  ASN1_TYPE_free(typ);
  return 0;
}

int X509_ATTRIBUTE_count(const X509_ATTRIBUTE *attr) {
  return (int)sk_ASN1_TYPE_num(attr->set);
}

ASN1_OBJECT *X509_ATTRIBUTE_get0_object(X509_ATTRIBUTE *attr) {
  if (attr == nullptr) {
    return nullptr;
  }
  return attr->object;
}

void *X509_ATTRIBUTE_get0_data(X509_ATTRIBUTE *attr, int idx, int attrtype,
                               void *unused) {
  ASN1_TYPE *ttmp;
  ttmp = X509_ATTRIBUTE_get0_type(attr, idx);
  if (!ttmp) {
    return nullptr;
  }
  if (attrtype != ASN1_TYPE_get(ttmp)) {
    OPENSSL_PUT_ERROR(X509, X509_R_WRONG_TYPE);
    return nullptr;
  }
  return (void *)asn1_type_value_as_pointer(ttmp);
}

ASN1_TYPE *X509_ATTRIBUTE_get0_type(X509_ATTRIBUTE *attr, int idx) {
  if (attr == nullptr) {
    return nullptr;
  }
  if (idx >= X509_ATTRIBUTE_count(attr)) {
    return nullptr;
  }
  return sk_ASN1_TYPE_value(attr->set, idx);
}
