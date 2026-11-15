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

#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"


typedef struct x509_trust_st X509_TRUST;

struct x509_trust_st {
  int trust;
  int (*check_trust)(const X509_TRUST *, X509 *);
  int nid;
} /* X509_TRUST */;

static int trust_1oidany(const X509_TRUST *trust, X509 *x);
static int trust_compat(const X509_TRUST *trust, X509 *x);

static int obj_trust(int id, X509 *x);

static const X509_TRUST trstandard[] = {
    {X509_TRUST_COMPAT, trust_compat, 0},
    {X509_TRUST_SSL_CLIENT, trust_1oidany, NID_client_auth},
    {X509_TRUST_SSL_SERVER, trust_1oidany, NID_server_auth},
    {X509_TRUST_EMAIL, trust_1oidany, NID_email_protect},
    {X509_TRUST_OBJECT_SIGN, trust_1oidany, NID_code_sign},
    {X509_TRUST_TSA, trust_1oidany, NID_time_stamp}};

static const X509_TRUST *X509_TRUST_get0(int id) {
  for (const auto &t : trstandard) {
    if (t.trust == id) {
      return &t;
    }
  }
  return nullptr;
}

int X509_check_trust(X509 *x, int id, int flags) {
  if (id == -1) {
    return X509_TRUST_TRUSTED;
  }
  // We get this as a default value
  if (id == 0) {
    int rv = obj_trust(NID_anyExtendedKeyUsage, x);
    if (rv != X509_TRUST_UNTRUSTED) {
      return rv;
    }
    return trust_compat(nullptr, x);
  }
  const X509_TRUST *pt = X509_TRUST_get0(id);
  if (pt == nullptr) {
    // Unknown trust IDs are silently reintrepreted as NIDs. This is unreachable
    // from the certificate verifier itself, but wpa_supplicant relies on it.
    // Note this relies on commonly-used NIDs and trust IDs not colliding.
    return obj_trust(id, x);
  }
  return pt->check_trust(pt, x);
}

int X509_is_valid_trust_id(int trust) {
  return X509_TRUST_get0(trust) != nullptr;
}

static int trust_1oidany(const X509_TRUST *trust, X509 *x) {
  if (x->aux && (x->aux->trust || x->aux->reject)) {
    return obj_trust(trust->nid, x);
  }
  // we don't have any trust settings: for compatibility we return trusted
  // if it is self signed
  return trust_compat(trust, x);
}

static int trust_compat(const X509_TRUST *trust, X509 *x) {
  if (!x509v3_cache_extensions(x)) {
    return X509_TRUST_UNTRUSTED;
  }
  if (x->ex_flags & EXFLAG_SS) {
    return X509_TRUST_TRUSTED;
  } else {
    return X509_TRUST_UNTRUSTED;
  }
}

static int obj_trust(int id, X509 *x) {
  X509_CERT_AUX *ax = x->aux;
  if (!ax) {
    return X509_TRUST_UNTRUSTED;
  }
  for (size_t i = 0; i < sk_ASN1_OBJECT_num(ax->reject); i++) {
    const ASN1_OBJECT *obj = sk_ASN1_OBJECT_value(ax->reject, i);
    if (OBJ_obj2nid(obj) == id) {
      return X509_TRUST_REJECTED;
    }
  }
  for (size_t i = 0; i < sk_ASN1_OBJECT_num(ax->trust); i++) {
    const ASN1_OBJECT *obj = sk_ASN1_OBJECT_value(ax->trust, i);
    if (OBJ_obj2nid(obj) == id) {
      return X509_TRUST_TRUSTED;
    }
  }
  return X509_TRUST_UNTRUSTED;
}
