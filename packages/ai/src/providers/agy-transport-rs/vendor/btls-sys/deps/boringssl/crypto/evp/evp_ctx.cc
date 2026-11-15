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

#include <openssl/evp.h>

#include <string.h>

#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "../mem_internal.h"
#include "internal.h"


// |EVP_PKEY_RSA_PSS| is intentionally omitted from this list. These are types
// that can be created without an |EVP_PKEY|, and we do not support
// |EVP_PKEY_RSA_PSS| keygen.
static const EVP_PKEY_CTX_METHOD *const evp_methods[] = {
    &rsa_pkey_meth,    &ec_pkey_meth,   &ed25519_pkey_meth,
    &x25519_pkey_meth, &hkdf_pkey_meth,
};

static const EVP_PKEY_CTX_METHOD *evp_pkey_meth_find(int type) {
  for (auto method : evp_methods) {
    if (method->pkey_id == type) {
      return method;
    }
  }

  return nullptr;
}

static EVP_PKEY_CTX *evp_pkey_ctx_new(EVP_PKEY *pkey,
                                      const EVP_PKEY_CTX_METHOD *pmeth) {
  bssl::UniquePtr<EVP_PKEY_CTX> ret = bssl::MakeUnique<EVP_PKEY_CTX>();
  if (!ret) {
    return nullptr;
  }

  ret->pmeth = pmeth;
  ret->operation = EVP_PKEY_OP_UNDEFINED;
  ret->pkey = bssl::UpRef(pkey);

  if (pmeth->init && pmeth->init(ret.get()) <= 0) {
    ret->pmeth = nullptr;  // Don't call |pmeth->cleanup|.
    return nullptr;
  }

  return ret.release();
}

EVP_PKEY_CTX *EVP_PKEY_CTX_new(EVP_PKEY *pkey, ENGINE *e) {
  if (pkey == nullptr || pkey->ameth == nullptr) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_PASSED_NULL_PARAMETER);
    return nullptr;
  }

  const EVP_PKEY_CTX_METHOD *pkey_method = pkey->ameth->pkey_method;
  if (pkey_method == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    ERR_add_error_dataf("algorithm %d", pkey->ameth->pkey_id);
    return nullptr;
  }

  return evp_pkey_ctx_new(pkey, pkey_method);
}

EVP_PKEY_CTX *EVP_PKEY_CTX_new_id(int id, ENGINE *e) {
  const EVP_PKEY_CTX_METHOD *pkey_method = evp_pkey_meth_find(id);
  if (pkey_method == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    ERR_add_error_dataf("algorithm %d", id);
    return nullptr;
  }

  return evp_pkey_ctx_new(nullptr, pkey_method);
}

evp_pkey_ctx_st::~evp_pkey_ctx_st() {
  if (pmeth && pmeth->cleanup) {
    pmeth->cleanup(this);
  }
}

void EVP_PKEY_CTX_free(EVP_PKEY_CTX *ctx) { bssl::Delete(ctx); }

EVP_PKEY_CTX *EVP_PKEY_CTX_dup(EVP_PKEY_CTX *ctx) {
  if (!ctx->pmeth || !ctx->pmeth->copy) {
    return nullptr;
  }

  bssl::UniquePtr<EVP_PKEY_CTX> ret = bssl::MakeUnique<EVP_PKEY_CTX>();
  if (!ret) {
    return nullptr;
  }

  ret->pmeth = ctx->pmeth;
  ret->operation = ctx->operation;
  ret->pkey = bssl::UpRef(ctx->pkey);
  ret->peerkey = bssl::UpRef(ctx->peerkey);
  if (ctx->pmeth->copy(ret.get(), ctx) <= 0) {
    ret->pmeth = nullptr;  // Don't call |pmeth->cleanup|.
    OPENSSL_PUT_ERROR(EVP, ERR_LIB_EVP);
    return nullptr;
  }

  return ret.release();
}

EVP_PKEY *EVP_PKEY_CTX_get0_pkey(EVP_PKEY_CTX *ctx) { return ctx->pkey.get(); }

int EVP_PKEY_CTX_ctrl(EVP_PKEY_CTX *ctx, int keytype, int optype, int cmd,
                      int p1, void *p2) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->ctrl) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_COMMAND_NOT_SUPPORTED);
    return 0;
  }
  if (keytype != -1 && ctx->pmeth->pkey_id != keytype) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  if (ctx->operation == EVP_PKEY_OP_UNDEFINED) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NO_OPERATION_SET);
    return 0;
  }

  if (optype != -1 && !(ctx->operation & optype)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_OPERATION);
    return 0;
  }

  return ctx->pmeth->ctrl(ctx, cmd, p1, p2);
}

int EVP_PKEY_sign_init(EVP_PKEY_CTX *ctx) {
  if (ctx == nullptr || ctx->pmeth == nullptr ||
      (ctx->pmeth->sign == nullptr && ctx->pmeth->sign_message == nullptr)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  ctx->operation = EVP_PKEY_OP_SIGN;
  return 1;
}

int EVP_PKEY_sign(EVP_PKEY_CTX *ctx, uint8_t *sig, size_t *sig_len,
                  const uint8_t *digest, size_t digest_len) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->sign) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_SIGN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->sign(ctx, sig, sig_len, digest, digest_len);
}

int EVP_PKEY_verify_init(EVP_PKEY_CTX *ctx) {
  if (ctx == nullptr || ctx->pmeth == nullptr ||
      (ctx->pmeth->verify == nullptr &&
       ctx->pmeth->verify_message == nullptr)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_VERIFY;
  return 1;
}

int EVP_PKEY_verify(EVP_PKEY_CTX *ctx, const uint8_t *sig, size_t sig_len,
                    const uint8_t *digest, size_t digest_len) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->verify) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_VERIFY) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->verify(ctx, sig, sig_len, digest, digest_len);
}

int EVP_PKEY_encrypt_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->encrypt) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_ENCRYPT;
  return 1;
}

int EVP_PKEY_encrypt(EVP_PKEY_CTX *ctx, uint8_t *out, size_t *outlen,
                     const uint8_t *in, size_t inlen) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->encrypt) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_ENCRYPT) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->encrypt(ctx, out, outlen, in, inlen);
}

int EVP_PKEY_decrypt_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->decrypt) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_DECRYPT;
  return 1;
}

int EVP_PKEY_decrypt(EVP_PKEY_CTX *ctx, uint8_t *out, size_t *outlen,
                     const uint8_t *in, size_t inlen) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->decrypt) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_DECRYPT) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->decrypt(ctx, out, outlen, in, inlen);
}

int EVP_PKEY_verify_recover_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->verify_recover) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_VERIFYRECOVER;
  return 1;
}

int EVP_PKEY_verify_recover(EVP_PKEY_CTX *ctx, uint8_t *out, size_t *out_len,
                            const uint8_t *sig, size_t sig_len) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->verify_recover) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_VERIFYRECOVER) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->verify_recover(ctx, out, out_len, sig, sig_len);
}

int EVP_PKEY_derive_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->derive) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_DERIVE;
  return 1;
}

int EVP_PKEY_derive_set_peer(EVP_PKEY_CTX *ctx, EVP_PKEY *peer) {
  int ret;
  if (!ctx || !ctx->pmeth ||
      !(ctx->pmeth->derive || ctx->pmeth->encrypt || ctx->pmeth->decrypt) ||
      !ctx->pmeth->ctrl) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_DERIVE &&
      ctx->operation != EVP_PKEY_OP_ENCRYPT &&
      ctx->operation != EVP_PKEY_OP_DECRYPT) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }

  ret = ctx->pmeth->ctrl(ctx, EVP_PKEY_CTRL_PEER_KEY, 0, peer);

  if (ret <= 0) {
    return 0;
  }

  if (ret == 2) {
    return 1;
  }

  if (!ctx->pkey) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NO_KEY_SET);
    return 0;
  }

  if (EVP_PKEY_id(ctx->pkey.get()) != EVP_PKEY_id(peer)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DIFFERENT_KEY_TYPES);
    return 0;
  }

  // ran@cryptocom.ru: For clarity.  The error is if parameters in peer are
  // present (!missing) but don't match.  EVP_PKEY_cmp_parameters may return
  // 1 (match), 0 (don't match) and -2 (comparison is not defined).  -1
  // (different key types) is impossible here because it is checked earlier.
  // -2 is OK for us here, as well as 1, so we can check for 0 only.
  if (!EVP_PKEY_missing_parameters(peer) &&
      !EVP_PKEY_cmp_parameters(ctx->pkey.get(), peer)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DIFFERENT_PARAMETERS);
    return 0;
  }

  ctx->peerkey = bssl::UpRef(peer);
  ret = ctx->pmeth->ctrl(ctx, EVP_PKEY_CTRL_PEER_KEY, 1, peer);
  if (ret <= 0) {
    ctx->peerkey = nullptr;
    return 0;
  }

  return 1;
}

int EVP_PKEY_derive(EVP_PKEY_CTX *ctx, uint8_t *key, size_t *out_key_len) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->derive) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_DERIVE) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }
  return ctx->pmeth->derive(ctx, key, out_key_len);
}

int EVP_PKEY_keygen_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->keygen) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_KEYGEN;
  return 1;
}

int EVP_PKEY_keygen(EVP_PKEY_CTX *ctx, EVP_PKEY **out_pkey) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->keygen) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_KEYGEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }

  if (!out_pkey) {
    return 0;
  }

  if (!*out_pkey) {
    *out_pkey = EVP_PKEY_new();
    if (!*out_pkey) {
      OPENSSL_PUT_ERROR(EVP, ERR_LIB_EVP);
      return 0;
    }
  }

  if (!ctx->pmeth->keygen(ctx, *out_pkey)) {
    EVP_PKEY_free(*out_pkey);
    *out_pkey = nullptr;
    return 0;
  }
  return 1;
}

int EVP_PKEY_paramgen_init(EVP_PKEY_CTX *ctx) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->paramgen) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  ctx->operation = EVP_PKEY_OP_PARAMGEN;
  return 1;
}

int EVP_PKEY_paramgen(EVP_PKEY_CTX *ctx, EVP_PKEY **out_pkey) {
  if (!ctx || !ctx->pmeth || !ctx->pmeth->paramgen) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }
  if (ctx->operation != EVP_PKEY_OP_PARAMGEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATON_NOT_INITIALIZED);
    return 0;
  }

  if (!out_pkey) {
    return 0;
  }

  if (!*out_pkey) {
    *out_pkey = EVP_PKEY_new();
    if (!*out_pkey) {
      OPENSSL_PUT_ERROR(EVP, ERR_LIB_EVP);
      return 0;
    }
  }

  if (!ctx->pmeth->paramgen(ctx, *out_pkey)) {
    EVP_PKEY_free(*out_pkey);
    *out_pkey = nullptr;
    return 0;
  }
  return 1;
}
