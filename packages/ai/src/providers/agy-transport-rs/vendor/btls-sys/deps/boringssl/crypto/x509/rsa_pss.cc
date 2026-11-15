// Copyright 2006-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <assert.h>
#include <limits.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/obj.h>
#include <openssl/rsa.h>

#include "../rsa/internal.h"
#include "internal.h"


static int rsa_pss_cb(int operation, ASN1_VALUE **pval, const ASN1_ITEM *it,
                      void *exarg) {
  if (operation == ASN1_OP_FREE_PRE) {
    RSA_PSS_PARAMS *pss = (RSA_PSS_PARAMS *)*pval;
    X509_ALGOR_free(pss->maskHash);
  }
  return 1;
}

ASN1_SEQUENCE_cb(RSA_PSS_PARAMS, rsa_pss_cb) = {
    ASN1_EXP_OPT(RSA_PSS_PARAMS, hashAlgorithm, X509_ALGOR, 0),
    ASN1_EXP_OPT(RSA_PSS_PARAMS, maskGenAlgorithm, X509_ALGOR, 1),
    ASN1_EXP_OPT(RSA_PSS_PARAMS, saltLength, ASN1_INTEGER, 2),
    ASN1_EXP_OPT(RSA_PSS_PARAMS, trailerField, ASN1_INTEGER, 3),
} ASN1_SEQUENCE_END_cb(RSA_PSS_PARAMS, RSA_PSS_PARAMS)

IMPLEMENT_ASN1_FUNCTIONS_const(RSA_PSS_PARAMS)


static int rsa_pss_decode(const X509_ALGOR *alg, rsa_pss_params_t *out) {
  if (alg->parameter == nullptr || alg->parameter->type != V_ASN1_SEQUENCE) {
    return 0;
  }

  // Although a syntax error in DER, we tolerate an explicitly-encoded trailer.
  // See the certificates in cl/362617931.
  CBS cbs;
  CBS_init(&cbs, alg->parameter->value.sequence->data,
           alg->parameter->value.sequence->length);
  return rsa_parse_pss_params(&cbs, out, /*allow_explicit_trailer=*/true) &&
         CBS_len(&cbs) == 0;
}

int x509_rsa_ctx_to_pss(EVP_MD_CTX *ctx, X509_ALGOR *algor) {
  const EVP_MD *sigmd, *mgf1md;
  int saltlen;
  if (!EVP_PKEY_CTX_get_signature_md(ctx->pctx, &sigmd) ||
      !EVP_PKEY_CTX_get_rsa_mgf1_md(ctx->pctx, &mgf1md) ||
      !EVP_PKEY_CTX_get_rsa_pss_saltlen(ctx->pctx, &saltlen)) {
    return 0;
  }

  if (sigmd != mgf1md) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_PSS_PARAMETERS);
    return 0;
  }
  int md_len = (int)EVP_MD_size(sigmd);
  if (saltlen != RSA_PSS_SALTLEN_DIGEST && saltlen != md_len) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_PSS_PARAMETERS);
    return 0;
  }

  rsa_pss_params_t params;
  switch (EVP_MD_type(sigmd)) {
    case NID_sha256:
      params = rsa_pss_sha256;
      break;
    case NID_sha384:
      params = rsa_pss_sha384;
      break;
    case NID_sha512:
      params = rsa_pss_sha512;
      break;
    default:
      OPENSSL_PUT_ERROR(X509, X509_R_INVALID_PSS_PARAMETERS);
      return 0;
  }

  // Encode |params| to an |ASN1_STRING|.
  uint8_t buf[128];   // The largest param fits comfortably in 128 bytes.
  CBB cbb;
  CBB_init_fixed(&cbb, buf, sizeof(buf));
  if (!rsa_marshal_pss_params(&cbb, params)) {
    return 0;
  }
  bssl::UniquePtr<ASN1_STRING> params_str(
      ASN1_STRING_type_new(V_ASN1_SEQUENCE));
  if (params_str == nullptr ||
      !ASN1_STRING_set(params_str.get(), CBB_data(&cbb), CBB_len(&cbb))) {
    return 0;
  }

  if (!X509_ALGOR_set0(algor, OBJ_nid2obj(NID_rsassaPss), V_ASN1_SEQUENCE,
                       params_str.get())) {
    return 0;
  }
  params_str.release();  // |X509_ALGOR_set0| took ownership.
  return 1;
}

int x509_rsa_pss_to_ctx(EVP_MD_CTX *ctx, const X509_ALGOR *sigalg,
                        EVP_PKEY *pkey) {
  assert(OBJ_obj2nid(sigalg->algorithm) == NID_rsassaPss);
  rsa_pss_params_t params;
  if (!rsa_pss_decode(sigalg, &params)) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_PSS_PARAMETERS);
    return 0;
  }

  const EVP_MD *md = rsa_pss_params_get_md(params);
  EVP_PKEY_CTX *pctx;
  if (!EVP_DigestVerifyInit(ctx, &pctx, md, nullptr, pkey) ||
      !EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING) ||
      !EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST) ||
      !EVP_PKEY_CTX_set_rsa_mgf1_md(pctx, md)) {
    return 0;
  }

  return 1;
}

int x509_print_rsa_pss_params(BIO *bp, const X509_ALGOR *sigalg, int indent,
                              ASN1_PCTX *pctx) {
  assert(OBJ_obj2nid(sigalg->algorithm) == NID_rsassaPss);
  rsa_pss_params_t params;
  if (!rsa_pss_decode(sigalg, &params)) {
    return BIO_puts(bp, " (INVALID PSS PARAMETERS)\n") <= 0;
  }

  const char *hash_str = nullptr;
  uint32_t salt_len = 0;
  switch (params) {
    case rsa_pss_none:
      // |rsa_pss_decode| will never return this.
      OPENSSL_PUT_ERROR(X509, ERR_R_INTERNAL_ERROR);
      return 0;
    case rsa_pss_sha256:
      hash_str = "sha256";
      salt_len = 32;
      break;
    case rsa_pss_sha384:
      hash_str = "sha384";
      salt_len = 48;
      break;
    case rsa_pss_sha512:
      hash_str = "sha512";
      salt_len = 64;
      break;
  }

  if (BIO_puts(bp, "\n") <= 0 ||       //
      !BIO_indent(bp, indent, 128) ||  //
      BIO_printf(bp, "Hash Algorithm: %s\n", hash_str) <= 0 ||
      !BIO_indent(bp, indent, 128) ||  //
      BIO_printf(bp, "Mask Algorithm: mgf1 with %s\n", hash_str) <= 0 ||
      !BIO_indent(bp, indent, 128) ||  //
      BIO_printf(bp, "Salt Length: 0x%x\n", salt_len) <= 0 ||
      !BIO_indent(bp, indent, 128) ||  //
      BIO_puts(bp, "Trailer Field: 0xBC (default)\n") <= 0) {
    return 0;
  }

  return 1;
}
