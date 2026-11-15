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
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/span.h>
#include <openssl/x509.h>

#include <limits.h>

#include "../internal.h"
#include "../mem_internal.h"
#include "internal.h"


int ASN1_item_sign(const ASN1_ITEM *it, X509_ALGOR *algor1, X509_ALGOR *algor2,
                   ASN1_BIT_STRING *signature, void *asn, EVP_PKEY *pkey,
                   const EVP_MD *type) {
  if (signature->type != V_ASN1_BIT_STRING) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
    return 0;
  }
  bssl::ScopedEVP_MD_CTX ctx;
  if (!EVP_DigestSignInit(ctx.get(), nullptr, type, nullptr, pkey)) {
    return 0;
  }
  return ASN1_item_sign_ctx(it, algor1, algor2, signature, asn, ctx.get());
}

int ASN1_item_sign_ctx(const ASN1_ITEM *it, X509_ALGOR *algor1,
                       X509_ALGOR *algor2, ASN1_BIT_STRING *signature,
                       void *asn, EVP_MD_CTX *ctx) {
  // Historically, this function called |EVP_MD_CTX_cleanup| on return. Some
  // callers rely on this to avoid memory leaks.
  bssl::Cleanup cleanup = [&] { EVP_MD_CTX_cleanup(ctx); };

  // Write out the requested copies of the AlgorithmIdentifier. This may modify
  // |asn|, so we must do it first.
  if ((algor1 != nullptr && !x509_digest_sign_algorithm(ctx, algor1)) ||
      (algor2 != nullptr && !x509_digest_sign_algorithm(ctx, algor2))) {
    return 0;
  }

  uint8_t *in = nullptr;
  int in_len = ASN1_item_i2d(reinterpret_cast<ASN1_VALUE *>(asn), &in, it);
  if (in_len < 0) {
    return 0;
  }
  bssl::UniquePtr<uint8_t> free_in(in);

  return x509_sign_to_bit_string(ctx, signature, bssl::Span(in, in_len));
}

int x509_sign_to_bit_string(EVP_MD_CTX *ctx, ASN1_BIT_STRING *out,
                            bssl::Span<const uint8_t> in) {
  if (out->type != V_ASN1_BIT_STRING) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_WRONG_TYPE);
    return 0;
  }

  EVP_PKEY *pkey = EVP_PKEY_CTX_get0_pkey(ctx->pctx);
  size_t sig_len = EVP_PKEY_size(pkey);
  if (sig_len > INT_MAX) {
    // Ensure the signature will fit in |out|.
    OPENSSL_PUT_ERROR(X509, ERR_R_OVERFLOW);
    return 0;
  }
  bssl::Array<uint8_t> sig;
  if (!sig.Init(sig_len)) {
    return 0;
  }

  if (!EVP_DigestSign(ctx, sig.data(), &sig_len, in.data(), in.size())) {
    OPENSSL_PUT_ERROR(X509, ERR_R_EVP_LIB);
    return 0;
  }
  sig.Shrink(sig_len);

  uint8_t *sig_data;
  sig.Release(&sig_data, &sig_len);
  ASN1_STRING_set0(out, sig_data, static_cast<int>(sig_len));
  out->flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);
  out->flags |= ASN1_STRING_FLAG_BITS_LEFT;
  return static_cast<int>(sig_len);
}
