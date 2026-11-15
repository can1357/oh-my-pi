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

#include <stdio.h>

#include <openssl/asn1t.h>
#include <openssl/x509.h>


struct X509_sig_st {
  X509_ALGOR *algor;
  ASN1_OCTET_STRING *digest;
} /* X509_SIG */;

ASN1_SEQUENCE(X509_SIG) = {
    ASN1_SIMPLE(X509_SIG, algor, X509_ALGOR),
    ASN1_SIMPLE(X509_SIG, digest, ASN1_OCTET_STRING),
} ASN1_SEQUENCE_END(X509_SIG)

IMPLEMENT_ASN1_FUNCTIONS_const(X509_SIG)

void X509_SIG_get0(const X509_SIG *sig, const X509_ALGOR **out_alg,
                   const ASN1_OCTET_STRING **out_digest) {
  if (out_alg != nullptr) {
    *out_alg = sig->algor;
  }
  if (out_digest != nullptr) {
    *out_digest = sig->digest;
  }
}

void X509_SIG_getm(X509_SIG *sig, X509_ALGOR **out_alg,
                   ASN1_OCTET_STRING **out_digest) {
  if (out_alg != nullptr) {
    *out_alg = sig->algor;
  }
  if (out_digest != nullptr) {
    *out_digest = sig->digest;
  }
}
