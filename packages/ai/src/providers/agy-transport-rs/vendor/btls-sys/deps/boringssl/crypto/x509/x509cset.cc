// Copyright 2001-2016 The OpenSSL Project Authors. All Rights Reserved.
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
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "../asn1/internal.h"
#include "../internal.h"
#include "internal.h"

int X509_CRL_set_version(X509_CRL *x, long version) {
  if (x == nullptr) {
    return 0;
  }

  if (version < X509_CRL_VERSION_1 || version > X509_CRL_VERSION_2) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_VERSION);
    return 0;
  }

  // v1(0) is default and is represented by omitting the version.
  if (version == X509_CRL_VERSION_1) {
    ASN1_INTEGER_free(x->crl->version);
    x->crl->version = nullptr;
    return 1;
  }

  if (x->crl->version == nullptr) {
    x->crl->version = ASN1_INTEGER_new();
    if (x->crl->version == nullptr) {
      return 0;
    }
  }
  return ASN1_INTEGER_set_int64(x->crl->version, version);
}

int X509_CRL_set_issuer_name(X509_CRL *x, const X509_NAME *name) {
  if ((x == nullptr) || (x->crl == nullptr)) {
    return 0;
  }
  return (X509_NAME_set(&x->crl->issuer, name));
}

int X509_CRL_set1_lastUpdate(X509_CRL *x, const ASN1_TIME *tm) {
  ASN1_TIME *in;

  if (x == nullptr) {
    return 0;
  }
  in = x->crl->lastUpdate;
  if (in != tm) {
    in = ASN1_STRING_dup(tm);
    if (in != nullptr) {
      ASN1_TIME_free(x->crl->lastUpdate);
      x->crl->lastUpdate = in;
    }
  }
  return in != nullptr;
}

int X509_CRL_set1_nextUpdate(X509_CRL *x, const ASN1_TIME *tm) {
  ASN1_TIME *in;

  if (x == nullptr) {
    return 0;
  }
  in = x->crl->nextUpdate;
  if (in != tm) {
    in = ASN1_STRING_dup(tm);
    if (in != nullptr) {
      ASN1_TIME_free(x->crl->nextUpdate);
      x->crl->nextUpdate = in;
    }
  }
  return in != nullptr;
}

int X509_CRL_sort(X509_CRL *c) {
  // Sort the data so it will be written in serial number order.
  sk_X509_REVOKED_sort(c->crl->revoked);
  asn1_encoding_clear(&c->crl->enc);
  return 1;
}

int X509_CRL_up_ref(X509_CRL *crl) {
  CRYPTO_refcount_inc(&crl->references);
  return 1;
}

long X509_CRL_get_version(const X509_CRL *crl) {
  return ASN1_INTEGER_get(crl->crl->version);
}

const ASN1_TIME *X509_CRL_get0_lastUpdate(const X509_CRL *crl) {
  return crl->crl->lastUpdate;
}

const ASN1_TIME *X509_CRL_get0_nextUpdate(const X509_CRL *crl) {
  return crl->crl->nextUpdate;
}

ASN1_TIME *X509_CRL_get_lastUpdate(X509_CRL *crl) {
  return crl->crl->lastUpdate;
}

ASN1_TIME *X509_CRL_get_nextUpdate(X509_CRL *crl) {
  return crl->crl->nextUpdate;
}

X509_NAME *X509_CRL_get_issuer(const X509_CRL *crl) { return crl->crl->issuer; }

STACK_OF(X509_REVOKED) *X509_CRL_get_REVOKED(X509_CRL *crl) {
  return crl->crl->revoked;
}

const STACK_OF(X509_EXTENSION) *X509_CRL_get0_extensions(const X509_CRL *crl) {
  return crl->crl->extensions;
}

void X509_CRL_get0_signature(const X509_CRL *crl, const ASN1_BIT_STRING **psig,
                             const X509_ALGOR **palg) {
  if (psig != nullptr) {
    *psig = crl->signature;
  }
  if (palg != nullptr) {
    *palg = crl->sig_alg;
  }
}

int X509_CRL_get_signature_nid(const X509_CRL *crl) {
  return OBJ_obj2nid(crl->sig_alg->algorithm);
}

const ASN1_TIME *X509_REVOKED_get0_revocationDate(const X509_REVOKED *revoked) {
  return revoked->revocationDate;
}

int X509_REVOKED_set_revocationDate(X509_REVOKED *revoked,
                                    const ASN1_TIME *tm) {
  ASN1_TIME *in;

  if (revoked == nullptr) {
    return 0;
  }
  in = revoked->revocationDate;
  if (in != tm) {
    in = ASN1_STRING_dup(tm);
    if (in != nullptr) {
      ASN1_TIME_free(revoked->revocationDate);
      revoked->revocationDate = in;
    }
  }
  return in != nullptr;
}

const ASN1_INTEGER *X509_REVOKED_get0_serialNumber(
    const X509_REVOKED *revoked) {
  return revoked->serialNumber;
}

int X509_REVOKED_set_serialNumber(X509_REVOKED *revoked,
                                  const ASN1_INTEGER *serial) {
  ASN1_INTEGER *in;

  if (serial->type != V_ASN1_INTEGER && serial->type != V_ASN1_NEG_INTEGER) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
    return 0;
  }

  if (revoked == nullptr) {
    return 0;
  }
  in = revoked->serialNumber;
  if (in != serial) {
    in = ASN1_INTEGER_dup(serial);
    if (in != nullptr) {
      ASN1_INTEGER_free(revoked->serialNumber);
      revoked->serialNumber = in;
    }
  }
  return in != nullptr;
}

const STACK_OF(X509_EXTENSION) *X509_REVOKED_get0_extensions(
    const X509_REVOKED *r) {
  return r->extensions;
}

int i2d_re_X509_CRL_tbs(X509_CRL *crl, unsigned char **outp) {
  asn1_encoding_clear(&crl->crl->enc);
  return i2d_X509_CRL_INFO(crl->crl, outp);
}

int i2d_X509_CRL_tbs(X509_CRL *crl, unsigned char **outp) {
  return i2d_X509_CRL_INFO(crl->crl, outp);
}

int X509_CRL_set1_signature_algo(X509_CRL *crl, const X509_ALGOR *algo) {
  return X509_ALGOR_copy(crl->sig_alg, algo) &&
         X509_ALGOR_copy(crl->crl->sig_alg, algo);
}

int X509_CRL_set1_signature_value(X509_CRL *crl, const uint8_t *sig,
                                  size_t sig_len) {
  if (!ASN1_STRING_set(crl->signature, sig, sig_len)) {
    return 0;
  }
  crl->signature->flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);
  crl->signature->flags |= ASN1_STRING_FLAG_BITS_LEFT;
  return 1;
}
