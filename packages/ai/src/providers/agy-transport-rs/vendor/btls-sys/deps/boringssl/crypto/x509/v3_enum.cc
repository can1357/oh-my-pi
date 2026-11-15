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

#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include "internal.h"


typedef BIT_STRING_BITNAME ENUMERATED_NAMES;

static const ENUMERATED_NAMES crl_reasons[] = {
    {CRL_REASON_UNSPECIFIED, "Unspecified", "unspecified"},
    {CRL_REASON_KEY_COMPROMISE, "Key Compromise", "keyCompromise"},
    {CRL_REASON_CA_COMPROMISE, "CA Compromise", "CACompromise"},
    {CRL_REASON_AFFILIATION_CHANGED, "Affiliation Changed",
     "affiliationChanged"},
    {CRL_REASON_SUPERSEDED, "Superseded", "superseded"},
    {CRL_REASON_CESSATION_OF_OPERATION, "Cessation Of Operation",
     "cessationOfOperation"},
    {CRL_REASON_CERTIFICATE_HOLD, "Certificate Hold", "certificateHold"},
    {CRL_REASON_REMOVE_FROM_CRL, "Remove From CRL", "removeFromCRL"},
    {CRL_REASON_PRIVILEGE_WITHDRAWN, "Privilege Withdrawn",
     "privilegeWithdrawn"},
    {CRL_REASON_AA_COMPROMISE, "AA Compromise", "AACompromise"},
    {-1, nullptr, nullptr}};

static char *i2s_ASN1_ENUMERATED_TABLE(const X509V3_EXT_METHOD *method,
                                       void *ext) {
  const ASN1_ENUMERATED *e = reinterpret_cast<const ASN1_ENUMERATED *>(ext);
  long strval = ASN1_ENUMERATED_get(e);
  for (const ENUMERATED_NAMES *enam =
           reinterpret_cast<const ENUMERATED_NAMES *>(method->usr_data);
       enam->lname; enam++) {
    if (strval == enam->bitnum) {
      return OPENSSL_strdup(enam->lname);
    }
  }
  return i2s_ASN1_ENUMERATED(method, e);
}

const X509V3_EXT_METHOD v3_crl_reason = {
    NID_crl_reason,
    0,
    ASN1_ITEM_ref(ASN1_ENUMERATED),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2s_ASN1_ENUMERATED_TABLE,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    (void *)crl_reasons,
};
