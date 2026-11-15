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

#include <openssl/x509.h>

#include <stdio.h>
#include <sys/types.h>

#include <openssl/asn1.h>
#include <openssl/bn.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/span.h>

#include "internal.h"


int x509_verify_signature(const X509_ALGOR *sigalg,
                          const ASN1_BIT_STRING *signature,
                          bssl::Span<const uint8_t> in, EVP_PKEY *pkey) {
  if (!pkey) {
    OPENSSL_PUT_ERROR(X509, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  size_t sig_len;
  if (signature->type == V_ASN1_BIT_STRING) {
    if (!ASN1_BIT_STRING_num_bytes(signature, &sig_len)) {
      OPENSSL_PUT_ERROR(X509, X509_R_INVALID_BIT_STRING_BITS_LEFT);
      return 0;
    }
  } else {
    sig_len = static_cast<size_t>(ASN1_STRING_length(signature));
  }

  bssl::ScopedEVP_MD_CTX ctx;
  if (!x509_digest_verify_init(ctx.get(), sigalg, pkey)) {
    return 0;
  }
  if (!EVP_DigestVerify(ctx.get(), ASN1_STRING_get0_data(signature), sig_len,
                        in.data(), in.size())) {
    OPENSSL_PUT_ERROR(X509, ERR_R_EVP_LIB);
    return 0;
  }
  return 1;
}

int ASN1_item_verify(const ASN1_ITEM *it, const X509_ALGOR *sigalg,
                     const ASN1_BIT_STRING *signature, void *asn,
                     EVP_PKEY *pkey) {
  uint8_t *in = nullptr;
  int in_len = ASN1_item_i2d(reinterpret_cast<ASN1_VALUE *>(asn), &in, it);
  if (in_len < 0) {
    return 0;
  }
  bssl::UniquePtr<uint8_t> free_in(in);
  return x509_verify_signature(sigalg, signature, bssl::Span(in, in_len), pkey);
}
