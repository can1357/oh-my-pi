// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/x509.h>

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/nid.h>

#include "internal.h"

// OCSP extensions and a couple of CRL entry extensions

static int i2r_ocsp_acutoff(const X509V3_EXT_METHOD *method, void *nonce,
                            BIO *out, int indent);

static int i2r_ocsp_nocheck(const X509V3_EXT_METHOD *method, void *nocheck,
                            BIO *out, int indent);
static void *s2i_ocsp_nocheck(const X509V3_EXT_METHOD *method,
                              const X509V3_CTX *ctx, const char *str);

const X509V3_EXT_METHOD v3_crl_invdate = {
    NID_invalidity_date,
    0,
    ASN1_ITEM_ref(ASN1_GENERALIZEDTIME),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2r_ocsp_acutoff,
    nullptr,
    nullptr,
};

const X509V3_EXT_METHOD v3_ocsp_nocheck = {
    NID_id_pkix_OCSP_noCheck,
    0,
    ASN1_ITEM_ref(ASN1_NULL),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    s2i_ocsp_nocheck,
    nullptr,
    nullptr,
    i2r_ocsp_nocheck,
    nullptr,
    nullptr,
};

static int i2r_ocsp_acutoff(const X509V3_EXT_METHOD *method, void *cutoff,
                            BIO *bp, int ind) {
  if (BIO_printf(bp, "%*s", ind, "") <= 0) {
    return 0;
  }
  if (!ASN1_GENERALIZEDTIME_print(
          bp, reinterpret_cast<ASN1_GENERALIZEDTIME *>(cutoff))) {
    return 0;
  }
  return 1;
}

// Nocheck is just a single NULL. Don't print anything and always set it

static int i2r_ocsp_nocheck(const X509V3_EXT_METHOD *method, void *nocheck,
                            BIO *out, int indent) {
  return 1;
}

static void *s2i_ocsp_nocheck(const X509V3_EXT_METHOD *method,
                              const X509V3_CTX *ctx, const char *str) {
  return ASN1_NULL_new();
}
