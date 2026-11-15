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

#include <openssl/evp.h>

#include <limits.h>

#include <openssl/digest.h>
#include <openssl/err.h>

#include "internal.h"


int EVP_SignInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type, ENGINE *impl) {
  return EVP_DigestInit_ex(ctx, type, impl);
}

int EVP_SignInit(EVP_MD_CTX *ctx, const EVP_MD *type) {
  return EVP_DigestInit(ctx, type);
}

int EVP_SignUpdate(EVP_MD_CTX *ctx, const void *data, size_t len) {
  return EVP_DigestUpdate(ctx, data, len);
}

int EVP_SignFinal(const EVP_MD_CTX *ctx, uint8_t *sig, unsigned *out_sig_len,
                  EVP_PKEY *pkey) {
  // Ensure the final result will fit in |unsigned|.
  size_t sig_len = EVP_PKEY_size(pkey);
  if (sig_len > UINT_MAX) {
    sig_len = UINT_MAX;
  }

  *out_sig_len = 0;
  uint8_t m[EVP_MAX_MD_SIZE];
  unsigned m_len;
  bssl::ScopedEVP_MD_CTX tmp_ctx;
  if (!EVP_MD_CTX_copy_ex(tmp_ctx.get(), ctx) ||
      !EVP_DigestFinal_ex(tmp_ctx.get(), m, &m_len)) {
    return 0;
  }

  bssl::UniquePtr<EVP_PKEY_CTX> pkctx(EVP_PKEY_CTX_new(pkey, nullptr));
  if (!pkctx ||  //
      !EVP_PKEY_sign_init(pkctx.get()) ||
      !EVP_PKEY_CTX_set_signature_md(pkctx.get(), ctx->digest) ||
      !EVP_PKEY_sign(pkctx.get(), sig, &sig_len, m, m_len)) {
    return 0;
  }
  *out_sig_len = static_cast<unsigned>(sig_len);
  return 1;
}

int EVP_VerifyInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type, ENGINE *impl) {
  return EVP_DigestInit_ex(ctx, type, impl);
}

int EVP_VerifyInit(EVP_MD_CTX *ctx, const EVP_MD *type) {
  return EVP_DigestInit(ctx, type);
}

int EVP_VerifyUpdate(EVP_MD_CTX *ctx, const void *data, size_t len) {
  return EVP_DigestUpdate(ctx, data, len);
}

int EVP_VerifyFinal(EVP_MD_CTX *ctx, const uint8_t *sig, size_t sig_len,
                    EVP_PKEY *pkey) {
  uint8_t m[EVP_MAX_MD_SIZE];
  unsigned m_len;
  bssl::ScopedEVP_MD_CTX tmp_ctx;
  if (!EVP_MD_CTX_copy_ex(tmp_ctx.get(), ctx) ||
      !EVP_DigestFinal_ex(tmp_ctx.get(), m, &m_len)) {
    return 0;
  }

  bssl::UniquePtr<EVP_PKEY_CTX> pkctx(EVP_PKEY_CTX_new(pkey, nullptr));
  if (!pkctx ||
      !EVP_PKEY_verify_init(pkctx.get()) ||
      !EVP_PKEY_CTX_set_signature_md(pkctx.get(), ctx->digest)) {
    return 0;
  }
  return EVP_PKEY_verify(pkctx.get(), sig, sig_len, m, m_len);
}

