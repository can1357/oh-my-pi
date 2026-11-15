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

#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


static char *i2s_ASN1_INTEGER_cb(const X509V3_EXT_METHOD *method, void *ext) {
  return i2s_ASN1_INTEGER(method, reinterpret_cast<ASN1_INTEGER *>(ext));
}

static void *s2i_asn1_int(const X509V3_EXT_METHOD *meth, const X509V3_CTX *ctx,
                          const char *value) {
  return s2i_ASN1_INTEGER(meth, value);
}

const X509V3_EXT_METHOD v3_crl_num = {
    NID_crl_number,
    0,
    ASN1_ITEM_ref(ASN1_INTEGER),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2s_ASN1_INTEGER_cb,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
};

const X509V3_EXT_METHOD v3_delta_crl = {
    NID_delta_crl,
    0,
    ASN1_ITEM_ref(ASN1_INTEGER),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2s_ASN1_INTEGER_cb,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
};

const X509V3_EXT_METHOD v3_inhibit_anyp = {
    NID_inhibit_any_policy,
    0,
    ASN1_ITEM_ref(ASN1_INTEGER),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2s_ASN1_INTEGER_cb,
    s2i_asn1_int,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
};
