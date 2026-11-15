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
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


int X509_REQ_set_version(X509_REQ *x, long version) {
  if (x == nullptr) {
    return 0;
  }
  if (version != X509_REQ_VERSION_1) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_VERSION);
    return 0;
  }
  return ASN1_INTEGER_set_int64(x->req_info->version, version);
}

int X509_REQ_set_subject_name(X509_REQ *x, X509_NAME *name) {
  if ((x == nullptr) || (x->req_info == nullptr)) {
    return 0;
  }
  return (X509_NAME_set(&x->req_info->subject, name));
}

int X509_REQ_set_pubkey(X509_REQ *x, EVP_PKEY *pkey) {
  if ((x == nullptr) || (x->req_info == nullptr)) {
    return 0;
  }
  return (X509_PUBKEY_set(&x->req_info->pubkey, pkey));
}

int X509_REQ_set1_signature_algo(X509_REQ *req, const X509_ALGOR *algo) {
  return X509_ALGOR_copy(req->sig_alg, algo);
}

int X509_REQ_set1_signature_value(X509_REQ *req, const uint8_t *sig,
                                  size_t sig_len) {
  if (!ASN1_STRING_set(req->signature, sig, sig_len)) {
    return 0;
  }
  req->signature->flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);
  req->signature->flags |= ASN1_STRING_FLAG_BITS_LEFT;
  return 1;
}
