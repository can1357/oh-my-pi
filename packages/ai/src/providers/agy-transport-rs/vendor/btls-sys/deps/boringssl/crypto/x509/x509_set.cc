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
#include <openssl/cipher.h>
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


long X509_get_version(const X509 *x509) { return x509->version; }

int X509_set_version(X509 *x, long version) {
  if (x == nullptr) {
    return 0;
  }

  if (version < X509_VERSION_1 || version > X509_VERSION_3) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_VERSION);
    return 0;
  }

  x->version = static_cast<uint8_t>(version);
  return 1;
}

int X509_set_serialNumber(X509 *x, const ASN1_INTEGER *serial) {
  if (serial->type != V_ASN1_INTEGER && serial->type != V_ASN1_NEG_INTEGER) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
    return 0;
  }

  return ASN1_STRING_copy(&x->serialNumber, serial);
}

int X509_set_issuer_name(X509 *x, const X509_NAME *name) {
  if (x == nullptr) {
    return 0;
  }
  return x509_name_copy(&x->issuer, name);
}

int X509_set_subject_name(X509 *x, const X509_NAME *name) {
  if (x == nullptr) {
    return 0;
  }
  return x509_name_copy(&x->subject, name);
}

int X509_set1_notBefore(X509 *x, const ASN1_TIME *tm) {
  // TODO(crbug.com/42290309): Check that |tm->type| is correct.
  return ASN1_STRING_copy(&x->notBefore, tm);
}

int X509_set_notBefore(X509 *x, const ASN1_TIME *tm) {
  return X509_set1_notBefore(x, tm);
}

const ASN1_TIME *X509_get0_notBefore(const X509 *x) { return &x->notBefore; }

ASN1_TIME *X509_getm_notBefore(X509 *x) {
  // Note this function takes a const |X509| pointer in OpenSSL. We require
  // non-const as this allows mutating |x|. If it comes up for compatibility,
  // we can relax this.
  return &x->notBefore;
}

ASN1_TIME *X509_get_notBefore(const X509 *x509) {
  // In OpenSSL, this function is an alias for |X509_getm_notBefore|, but our
  // |X509_getm_notBefore| is const-correct. |X509_get_notBefore| was
  // originally a macro, so it needs to capture both get0 and getm use cases.
  return const_cast<ASN1_TIME *>(&x509->notBefore);
}

int X509_set1_notAfter(X509 *x, const ASN1_TIME *tm) {
  // TODO(crbug.com/42290309): Check that |tm->type| is correct.
  return ASN1_STRING_copy(&x->notAfter, tm);
}

int X509_set_notAfter(X509 *x, const ASN1_TIME *tm) {
  return X509_set1_notAfter(x, tm);
}

const ASN1_TIME *X509_get0_notAfter(const X509 *x) { return &x->notAfter; }

ASN1_TIME *X509_getm_notAfter(X509 *x) {
  // Note this function takes a const |X509| pointer in OpenSSL. We require
  // non-const as this allows mutating |x|. If it comes up for compatibility,
  // we can relax this.
  return &x->notAfter;
}

ASN1_TIME *X509_get_notAfter(const X509 *x509) {
  // In OpenSSL, this function is an alias for |X509_getm_notAfter|, but our
  // |X509_getm_notAfter| is const-correct. |X509_get_notAfter| was
  // originally a macro, so it needs to capture both get0 and getm use cases.
  return const_cast<ASN1_TIME *>(&x509->notAfter);
  }

void X509_get0_uids(const X509 *x509, const ASN1_BIT_STRING **out_issuer_uid,
                    const ASN1_BIT_STRING **out_subject_uid) {
  if (out_issuer_uid != nullptr) {
    *out_issuer_uid = x509->issuerUID;
  }
  if (out_subject_uid != nullptr) {
    *out_subject_uid = x509->subjectUID;
  }
}

int X509_set_pubkey(X509 *x, EVP_PKEY *pkey) {
  if (x == nullptr) {
    return 0;
  }
  return x509_pubkey_set1(&x->key, pkey);
}

const STACK_OF(X509_EXTENSION) *X509_get0_extensions(const X509 *x) {
  return x->extensions;
}

const X509_ALGOR *X509_get0_tbs_sigalg(const X509 *x) {
  return &x->tbs_sig_alg;
}

X509_PUBKEY *X509_get_X509_PUBKEY(const X509 *x509) {
  // This function is not const-correct for OpenSSL compatibility.
  return const_cast<X509_PUBKEY *>(&x509->key);
}
