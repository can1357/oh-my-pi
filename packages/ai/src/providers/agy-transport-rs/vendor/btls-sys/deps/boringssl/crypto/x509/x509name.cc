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

#include <string.h>

#include <openssl/asn1.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"


int X509_NAME_get_text_by_NID(const X509_NAME *name, int nid, char *buf,
                              int len) {
  const ASN1_OBJECT *obj;

  obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    return -1;
  }
  return (X509_NAME_get_text_by_OBJ(name, obj, buf, len));
}

int X509_NAME_get_text_by_OBJ(const X509_NAME *name, const ASN1_OBJECT *obj,
                              char *buf, int len) {
  int i = X509_NAME_get_index_by_OBJ(name, obj, -1);
  if (i < 0) {
    return -1;
  }
  const ASN1_STRING *data =
      X509_NAME_ENTRY_get_data(X509_NAME_get_entry(name, i));
  unsigned char *text = nullptr;
  int ret = -1;
  int text_len = ASN1_STRING_to_UTF8(&text, data);
  // Fail if we could not encode as UTF-8.
  if (text_len < 0) {
    goto out;
  }
  CBS cbs;
  CBS_init(&cbs, text, text_len);
  // Fail if the UTF-8 encoding contains a 0 byte because this is returned as a
  // C string and callers very often do not check.
  if (CBS_contains_zero_byte(&cbs)) {
    goto out;
  }
  // We still support the "pass NULL to find out how much" API
  if (buf != nullptr) {
    if (text_len >= len || len <= 0 ||
        !CBS_copy_bytes(&cbs, (uint8_t *)buf, text_len)) {
      goto out;
    }
    // It must be a C string
    buf[text_len] = '\0';
  }
  ret = text_len;

out:
  OPENSSL_free(text);
  return ret;
}

int X509_NAME_entry_count(const X509_NAME *name) {
  if (name == nullptr) {
    return 0;
  }
  return (int)sk_X509_NAME_ENTRY_num(name->entries);
}

int X509_NAME_get_index_by_NID(const X509_NAME *name, int nid, int lastpos) {
  const ASN1_OBJECT *obj;

  obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    return -2;
  }
  return X509_NAME_get_index_by_OBJ(name, obj, lastpos);
}

// NOTE: you should be passing -1, not 0 as lastpos
int X509_NAME_get_index_by_OBJ(const X509_NAME *name, const ASN1_OBJECT *obj,
                               int lastpos) {
  if (name == nullptr) {
    return -1;
  }
  if (lastpos < 0) {
    lastpos = -1;
  }
  const STACK_OF(X509_NAME_ENTRY) *sk = name->entries;
  int n = (int)sk_X509_NAME_ENTRY_num(sk);
  for (lastpos++; lastpos < n; lastpos++) {
    const X509_NAME_ENTRY *ne = sk_X509_NAME_ENTRY_value(sk, lastpos);
    if (OBJ_cmp(ne->object, obj) == 0) {
      return lastpos;
    }
  }
  return -1;
}

X509_NAME_ENTRY *X509_NAME_get_entry(const X509_NAME *name, int loc) {
  if (name == nullptr || loc < 0 ||
      sk_X509_NAME_ENTRY_num(name->entries) <= (size_t)loc) {
    return nullptr;
  } else {
    return (sk_X509_NAME_ENTRY_value(name->entries, loc));
  }
}

X509_NAME_ENTRY *X509_NAME_delete_entry(X509_NAME *name, int loc) {
  if (name == nullptr || loc < 0 ||
      sk_X509_NAME_ENTRY_num(name->entries) <= (size_t)loc) {
    return nullptr;
  }

  STACK_OF(X509_NAME_ENTRY) *sk = name->entries;
  X509_NAME_ENTRY *ret = sk_X509_NAME_ENTRY_delete(sk, loc);
  size_t n = sk_X509_NAME_ENTRY_num(sk);
  x509_name_invalidate_cache(name);
  if ((size_t)loc == n) {
    return ret;
  }

  int set_prev;
  if (loc != 0) {
    set_prev = sk_X509_NAME_ENTRY_value(sk, loc - 1)->set;
  } else {
    set_prev = ret->set - 1;
  }
  int set_next = sk_X509_NAME_ENTRY_value(sk, loc)->set;

  // If we removed a singleton RDN, update the RDN indices so they are
  // consecutive again.
  if (set_prev + 1 < set_next) {
    for (size_t i = loc; i < n; i++) {
      sk_X509_NAME_ENTRY_value(sk, i)->set--;
    }
  }
  return ret;
}

int X509_NAME_add_entry_by_OBJ(X509_NAME *name, const ASN1_OBJECT *obj,
                               int type, const unsigned char *bytes,
                               ossl_ssize_t len, int loc, int set) {
  X509_NAME_ENTRY *ne =
      X509_NAME_ENTRY_create_by_OBJ(nullptr, obj, type, bytes, len);
  if (!ne) {
    return 0;
  }
  int ret = X509_NAME_add_entry(name, ne, loc, set);
  X509_NAME_ENTRY_free(ne);
  return ret;
}

int X509_NAME_add_entry_by_NID(X509_NAME *name, int nid, int type,
                               const unsigned char *bytes, ossl_ssize_t len,
                               int loc, int set) {
  X509_NAME_ENTRY *ne =
      X509_NAME_ENTRY_create_by_NID(nullptr, nid, type, bytes, len);
  if (!ne) {
    return 0;
  }
  int ret = X509_NAME_add_entry(name, ne, loc, set);
  X509_NAME_ENTRY_free(ne);
  return ret;
}

int X509_NAME_add_entry_by_txt(X509_NAME *name, const char *field, int type,
                               const unsigned char *bytes, ossl_ssize_t len,
                               int loc, int set) {
  X509_NAME_ENTRY *ne =
      X509_NAME_ENTRY_create_by_txt(nullptr, field, type, bytes, len);
  if (!ne) {
    return 0;
  }
  int ret = X509_NAME_add_entry(name, ne, loc, set);
  X509_NAME_ENTRY_free(ne);
  return ret;
}

// if set is -1, append to previous set, 0 'a new one', and 1, prepend to the
// guy we are about to stomp on.
int X509_NAME_add_entry(X509_NAME *name, const X509_NAME_ENTRY *entry, int loc,
                        int set) {
  if (name == nullptr) {
    return 0;
  }
  if (name->entries == nullptr) {
    name->entries = sk_X509_NAME_ENTRY_new_null();
    if (name->entries == nullptr) {
      return 0;
    }
  }

  STACK_OF(X509_NAME_ENTRY) *sk = name->entries;
  int n = (int)sk_X509_NAME_ENTRY_num(sk);
  if (loc > n) {
    loc = n;
  } else if (loc < 0) {
    loc = n;
  }

  bool inc = set == 0;
  x509_name_invalidate_cache(name);

  if (set == -1) {
    if (loc == 0) {
      set = 0;
      inc = 1;
    } else {
      set = sk_X509_NAME_ENTRY_value(sk, loc - 1)->set;
    }
  } else {  // if (set >= 0)
    if (loc >= n) {
      if (loc != 0) {
        set = sk_X509_NAME_ENTRY_value(sk, loc - 1)->set + 1;
      } else {
        set = 0;
      }
    } else {
      set = sk_X509_NAME_ENTRY_value(sk, loc)->set;
    }
  }

  bssl::UniquePtr<X509_NAME_ENTRY> new_entry(X509_NAME_ENTRY_dup(entry));
  if (new_entry == nullptr) {
    return 0;
  }
  new_entry->set = set;
  if (!sk_X509_NAME_ENTRY_insert(sk, new_entry.get(), loc)) {
    return 0;
  }
  new_entry.release(); // |sk| took ownership.
  if (inc) {
    n = (int)sk_X509_NAME_ENTRY_num(sk);
    for (int i = loc + 1; i < n; i++) {
      sk_X509_NAME_ENTRY_value(sk, i)->set += 1;
    }
  }
  return 1;
}

X509_NAME_ENTRY *X509_NAME_ENTRY_create_by_txt(X509_NAME_ENTRY **ne,
                                               const char *field, int type,
                                               const unsigned char *bytes,
                                               ossl_ssize_t len) {
  ASN1_OBJECT *obj;
  X509_NAME_ENTRY *nentry;

  obj = OBJ_txt2obj(field, 0);
  if (obj == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_FIELD_NAME);
    ERR_add_error_data(2, "name=", field);
    return nullptr;
  }
  nentry = X509_NAME_ENTRY_create_by_OBJ(ne, obj, type, bytes, len);
  ASN1_OBJECT_free(obj);
  return nentry;
}

X509_NAME_ENTRY *X509_NAME_ENTRY_create_by_NID(X509_NAME_ENTRY **ne, int nid,
                                               int type,
                                               const unsigned char *bytes,
                                               ossl_ssize_t len) {
  const ASN1_OBJECT *obj = OBJ_nid2obj(nid);
  if (obj == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_UNKNOWN_NID);
    return nullptr;
  }
  return X509_NAME_ENTRY_create_by_OBJ(ne, obj, type, bytes, len);
}

X509_NAME_ENTRY *X509_NAME_ENTRY_create_by_OBJ(X509_NAME_ENTRY **ne,
                                               const ASN1_OBJECT *obj, int type,
                                               const unsigned char *bytes,
                                               ossl_ssize_t len) {
  X509_NAME_ENTRY *ret;

  if ((ne == nullptr) || (*ne == nullptr)) {
    if ((ret = X509_NAME_ENTRY_new()) == nullptr) {
      return nullptr;
    }
  } else {
    ret = *ne;
  }

  if (!X509_NAME_ENTRY_set_object(ret, obj)) {
    goto err;
  }
  if (!X509_NAME_ENTRY_set_data(ret, type, bytes, len)) {
    goto err;
  }

  if ((ne != nullptr) && (*ne == nullptr)) {
    *ne = ret;
  }
  return ret;
err:
  if ((ne == nullptr) || (ret != *ne)) {
    X509_NAME_ENTRY_free(ret);
  }
  return nullptr;
}

int X509_NAME_ENTRY_set_object(X509_NAME_ENTRY *ne, const ASN1_OBJECT *obj) {
  if ((ne == nullptr) || (obj == nullptr)) {
    OPENSSL_PUT_ERROR(X509, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  ASN1_OBJECT_free(ne->object);
  ne->object = OBJ_dup(obj);
  return ((ne->object == nullptr) ? 0 : 1);
}

int X509_NAME_ENTRY_set_data(X509_NAME_ENTRY *ne, int type,
                             const unsigned char *bytes, ossl_ssize_t len) {
  if ((ne == nullptr) || ((bytes == nullptr) && (len != 0))) {
    return 0;
  }
  if ((type > 0) && (type & MBSTRING_FLAG)) {
    ASN1_STRING *dst = &ne->value;
    return ASN1_STRING_set_by_NID(&dst, bytes, len, type,
                                  OBJ_obj2nid(ne->object)) != nullptr;
  }
  if (len < 0) {
    len = strlen((const char *)bytes);
  }
  if (!ASN1_STRING_set(&ne->value, bytes, len)) {
    return 0;
  }
  if (type != V_ASN1_UNDEF) {
    ne->value.type = type;
  }
  return 1;
}

ASN1_OBJECT *X509_NAME_ENTRY_get_object(const X509_NAME_ENTRY *ne) {
  if (ne == nullptr) {
    return nullptr;
  }
  return ne->object;
}

ASN1_STRING *X509_NAME_ENTRY_get_data(const X509_NAME_ENTRY *ne) {
  if (ne == nullptr) {
    return nullptr;
  }
  // This function is not const-correct for OpenSSL compatibility.
  return const_cast<ASN1_STRING*>(&ne->value);
}
