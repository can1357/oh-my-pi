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

#include <limits.h>
#include <stdio.h>
#include <string.h>

#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


char *i2s_ASN1_OCTET_STRING(const X509V3_EXT_METHOD *method,
                            const ASN1_OCTET_STRING *oct) {
  return x509v3_bytes_to_hex(oct->data, oct->length);
}

ASN1_OCTET_STRING *s2i_ASN1_OCTET_STRING(const X509V3_EXT_METHOD *method,
                                         const X509V3_CTX *ctx,
                                         const char *str) {
  size_t len;
  uint8_t *data = x509v3_hex_to_bytes(str, &len);
  ASN1_OCTET_STRING *oct;
  if (data == nullptr) {
    return nullptr;
  }
  if (len > INT_MAX) {
    OPENSSL_PUT_ERROR(X509V3, ERR_R_OVERFLOW);
    goto err;
  }

  oct = ASN1_OCTET_STRING_new();
  if (oct == nullptr) {
    goto err;
  }
  ASN1_STRING_set0(oct, data, (int)len);
  return oct;

err:
  OPENSSL_free(data);
  return nullptr;
}

static char *i2s_ASN1_OCTET_STRING_cb(const X509V3_EXT_METHOD *method,
                                      void *ext) {
  return i2s_ASN1_OCTET_STRING(method,
                               reinterpret_cast<ASN1_OCTET_STRING *>(ext));
}

static void *s2i_skey_id(const X509V3_EXT_METHOD *method, const X509V3_CTX *ctx,
                         const char *str) {
  ASN1_OCTET_STRING *oct;
  const ASN1_BIT_STRING *pk;
  unsigned char pkey_dig[EVP_MAX_MD_SIZE];
  unsigned int diglen;

  if (strcmp(str, "hash")) {
    return s2i_ASN1_OCTET_STRING(method, ctx, str);
  }

  if (!(oct = ASN1_OCTET_STRING_new())) {
    return nullptr;
  }

  if (ctx && (ctx->flags == X509V3_CTX_TEST)) {
    return oct;
  }

  if (!ctx || (!ctx->subject_req && !ctx->subject_cert)) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_NO_PUBLIC_KEY);
    goto err;
  }

  if (ctx->subject_req) {
    pk = &ctx->subject_req->req_info->pubkey->public_key;
  } else {
    pk = &ctx->subject_cert->key.public_key;
  }

  if (!EVP_Digest(pk->data, pk->length, pkey_dig, &diglen, EVP_sha1(),
                  nullptr)) {
    goto err;
  }

  if (!ASN1_OCTET_STRING_set(oct, pkey_dig, diglen)) {
    goto err;
  }

  return oct;

err:
  ASN1_OCTET_STRING_free(oct);
  return nullptr;
}

const X509V3_EXT_METHOD v3_skey_id = {
    NID_subject_key_identifier,
    0,
    ASN1_ITEM_ref(ASN1_OCTET_STRING),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    i2s_ASN1_OCTET_STRING_cb,
    s2i_skey_id,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
};
