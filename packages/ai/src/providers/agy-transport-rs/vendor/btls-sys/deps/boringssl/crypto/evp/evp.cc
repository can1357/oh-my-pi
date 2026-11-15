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

#include <assert.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>

#include "../internal.h"
#include "internal.h"


// Node depends on |EVP_R_NOT_XOF_OR_INVALID_LENGTH|.
//
// TODO(davidben): Fix Node to not touch the error queue itself and remove this.
OPENSSL_DECLARE_ERROR_REASON(EVP, NOT_XOF_OR_INVALID_LENGTH)

// The HPKE module uses the EVP error namespace, but it lives in another
// directory.
OPENSSL_DECLARE_ERROR_REASON(EVP, EMPTY_PSK)

EVP_PKEY *EVP_PKEY_new(void) {
  EVP_PKEY *ret =
      reinterpret_cast<EVP_PKEY *>(OPENSSL_zalloc(sizeof(EVP_PKEY)));
  if (ret == nullptr) {
    return nullptr;
  }

  ret->references = 1;
  return ret;
}

void EVP_PKEY_free(EVP_PKEY *pkey) {
  if (pkey == nullptr) {
    return;
  }

  if (!CRYPTO_refcount_dec_and_test_zero(&pkey->references)) {
    return;
  }

  evp_pkey_set0(pkey, nullptr, nullptr);
  OPENSSL_free(pkey);
}

int EVP_PKEY_up_ref(EVP_PKEY *pkey) {
  CRYPTO_refcount_inc(&pkey->references);
  return 1;
}

int EVP_PKEY_is_opaque(const EVP_PKEY *pkey) {
  if (pkey->ameth && pkey->ameth->pkey_opaque) {
    return pkey->ameth->pkey_opaque(pkey);
  }
  return 0;
}

int EVP_PKEY_cmp(const EVP_PKEY *a, const EVP_PKEY *b) {
  if (EVP_PKEY_id(a) != EVP_PKEY_id(b)) {
    return -1;
  }

  if (a->ameth) {
    int ret;
    // Compare parameters if the algorithm has them
    if (a->ameth->param_cmp) {
      ret = a->ameth->param_cmp(a, b);
      if (ret <= 0) {
        return ret;
      }
    }

    if (a->ameth->pub_cmp) {
      return a->ameth->pub_cmp(a, b);
    }
  }

  return -2;
}

int EVP_PKEY_copy_parameters(EVP_PKEY *to, const EVP_PKEY *from) {
  if (EVP_PKEY_id(to) == EVP_PKEY_NONE) {
    // TODO(crbug.com/42290409): This shouldn't leave |to| in a half-empty state
    // on error. The complexity here largely comes from parameterless DSA keys,
    // which we no longer support, so this function can probably be trimmed
    // down.
    evp_pkey_set0(to, from->ameth, nullptr);
  } else if (EVP_PKEY_id(to) != EVP_PKEY_id(from)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DIFFERENT_KEY_TYPES);
    return 0;
  }

  if (EVP_PKEY_missing_parameters(from)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_MISSING_PARAMETERS);
    return 0;
  }

  // Once set, parameters may not change.
  if (!EVP_PKEY_missing_parameters(to)) {
    if (EVP_PKEY_cmp_parameters(to, from) == 1) {
      return 1;
    }
    OPENSSL_PUT_ERROR(EVP, EVP_R_DIFFERENT_PARAMETERS);
    return 0;
  }

  if (from->ameth && from->ameth->param_copy) {
    return from->ameth->param_copy(to, from);
  }

  // TODO(https://crbug.com/42290406): If the algorithm takes no parameters,
  // copying them should vacuously succeed. Better yet, simplify this whole
  // notion of parameter copying above.
  return 0;
}

int EVP_PKEY_missing_parameters(const EVP_PKEY *pkey) {
  if (pkey->ameth && pkey->ameth->param_missing) {
    return pkey->ameth->param_missing(pkey);
  }
  return 0;
}

int EVP_PKEY_size(const EVP_PKEY *pkey) {
  if (pkey && pkey->ameth && pkey->ameth->pkey_size) {
    return pkey->ameth->pkey_size(pkey);
  }
  return 0;
}

int EVP_PKEY_bits(const EVP_PKEY *pkey) {
  if (pkey && pkey->ameth && pkey->ameth->pkey_bits) {
    return pkey->ameth->pkey_bits(pkey);
  }
  return 0;
}

int EVP_PKEY_id(const EVP_PKEY *pkey) {
  return pkey->ameth != nullptr ? pkey->ameth->pkey_id : EVP_PKEY_NONE;
}

void evp_pkey_set0(EVP_PKEY *pkey, const EVP_PKEY_ASN1_METHOD *method,
                   void *pkey_data) {
  if (pkey->ameth && pkey->ameth->pkey_free) {
    pkey->ameth->pkey_free(pkey);
  }
  pkey->ameth = method;
  pkey->pkey = pkey_data;
}

int EVP_PKEY_type(int nid) {
  // In OpenSSL, this was used to map between type aliases. BoringSSL supports
  // no type aliases, so this function is just the identity.
  return nid;
}

int EVP_PKEY_assign(EVP_PKEY *pkey, int type, void *key) {
  // This function can only be used to assign RSA, DSA, EC, and DH keys. Other
  // key types have internal representations which are not exposed through the
  // public API.
  switch (type) {
    case EVP_PKEY_RSA:
      return EVP_PKEY_assign_RSA(pkey, reinterpret_cast<RSA *>(key));
    case EVP_PKEY_DSA:
      return EVP_PKEY_assign_DSA(pkey, reinterpret_cast<DSA *>(key));
    case EVP_PKEY_EC:
      return EVP_PKEY_assign_EC_KEY(pkey, reinterpret_cast<EC_KEY *>(key));
    case EVP_PKEY_DH:
      return EVP_PKEY_assign_DH(pkey, reinterpret_cast<DH *>(key));
  }

  OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
  ERR_add_error_dataf("algorithm %d", type);
  return 0;
}

int EVP_PKEY_set_type(EVP_PKEY *pkey, int type) {
  if (pkey && pkey->pkey) {
    // Some callers rely on |pkey| getting cleared even if |type| is
    // unsupported, usually setting |type| to |EVP_PKEY_NONE|.
    evp_pkey_set0(pkey, nullptr, nullptr);
  }

  // This function broadly isn't useful. It initializes |EVP_PKEY| for a type,
  // but forgets to put anything in the |pkey|. The one pattern where it does
  // anything is |EVP_PKEY_X25519|, where it's needed to make
  // |EVP_PKEY_set1_tls_encodedpoint| work, so we support only that.
  const EVP_PKEY_ALG *alg;
  if (type == EVP_PKEY_X25519) {
    alg = EVP_pkey_x25519();
  } else {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    ERR_add_error_dataf("algorithm %d", type);
    return 0;
  }

  if (pkey) {
    evp_pkey_set0(pkey, alg->method, nullptr);
  }

  return 1;
}

EVP_PKEY *EVP_PKEY_from_raw_private_key(const EVP_PKEY_ALG *alg,
                                        const uint8_t *in, size_t len) {
  if (alg->method->set_priv_raw == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    return nullptr;
  }
  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr || !alg->method->set_priv_raw(ret.get(), in, len)) {
    return nullptr;
  }
  return ret.release();
}

EVP_PKEY *EVP_PKEY_from_private_seed(const EVP_PKEY_ALG *alg, const uint8_t *in,
                                     size_t len) {
  if (alg->method->set_priv_seed == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    return nullptr;
  }
  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr || !alg->method->set_priv_seed(ret.get(), in, len)) {
    return nullptr;
  }
  return ret.release();
}

EVP_PKEY *EVP_PKEY_from_raw_public_key(const EVP_PKEY_ALG *alg,
                                       const uint8_t *in, size_t len) {
  if (alg->method->set_pub_raw == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    return nullptr;
  }
  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr || !alg->method->set_pub_raw(ret.get(), in, len)) {
    return nullptr;
  }
  return ret.release();
}

EVP_PKEY *EVP_PKEY_new_raw_private_key(int type, ENGINE *unused,
                                       const uint8_t *in, size_t len) {
  // To avoid pulling in all key types, look for specifically the key types that
  // support |set_priv_raw|.
  switch (type) {
    case EVP_PKEY_X25519:
      return EVP_PKEY_from_raw_private_key(EVP_pkey_x25519(), in, len);
    case EVP_PKEY_ED25519:
      return EVP_PKEY_from_raw_private_key(EVP_pkey_ed25519(), in, len);
    default:
      OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
      return nullptr;
  }
}

EVP_PKEY *EVP_PKEY_new_raw_public_key(int type, ENGINE *unused,
                                      const uint8_t *in, size_t len) {
  // To avoid pulling in all key types, look for specifically the key types that
  // support |set_pub_raw|.
  switch (type) {
    case EVP_PKEY_X25519:
      return EVP_PKEY_from_raw_public_key(EVP_pkey_x25519(), in, len);
    case EVP_PKEY_ED25519:
      return EVP_PKEY_from_raw_public_key(EVP_pkey_ed25519(), in, len);
    default:
      OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
      return nullptr;
  }
}

int EVP_PKEY_get_raw_private_key(const EVP_PKEY *pkey, uint8_t *out,
                                 size_t *out_len) {
  if (pkey->ameth->get_priv_raw == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  return pkey->ameth->get_priv_raw(pkey, out, out_len);
}

int EVP_PKEY_get_private_seed(const EVP_PKEY *pkey, uint8_t *out,
                              size_t *out_len) {
  if (pkey->ameth->get_priv_seed == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  return pkey->ameth->get_priv_seed(pkey, out, out_len);
}

int EVP_PKEY_get_raw_public_key(const EVP_PKEY *pkey, uint8_t *out,
                                size_t *out_len) {
  if (pkey->ameth->get_pub_raw == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  return pkey->ameth->get_pub_raw(pkey, out, out_len);
}

int EVP_PKEY_cmp_parameters(const EVP_PKEY *a, const EVP_PKEY *b) {
  if (EVP_PKEY_id(a) != EVP_PKEY_id(b)) {
    return -1;
  }
  if (a->ameth && a->ameth->param_cmp) {
    return a->ameth->param_cmp(a, b);
  }
  // TODO(https://crbug.com/boringssl/536): If the algorithm doesn't use
  // parameters, they should compare as vacuously equal.
  return -2;
}

int EVP_PKEY_CTX_set_signature_md(EVP_PKEY_CTX *ctx, const EVP_MD *md) {
  return EVP_PKEY_CTX_ctrl(ctx, -1, EVP_PKEY_OP_TYPE_SIG, EVP_PKEY_CTRL_MD, 0,
                           (void *)md);
}

int EVP_PKEY_CTX_get_signature_md(EVP_PKEY_CTX *ctx, const EVP_MD **out_md) {
  return EVP_PKEY_CTX_ctrl(ctx, -1, EVP_PKEY_OP_TYPE_SIG, EVP_PKEY_CTRL_GET_MD,
                           0, (void *)out_md);
}

void *EVP_PKEY_get0(const EVP_PKEY *pkey) {
  // Node references, but never calls this function, so for now we return NULL.
  // If other projects require complete support, call |EVP_PKEY_get0_RSA|, etc.,
  // rather than reading |pkey->pkey| directly. This avoids problems if our
  // internal representation does not match the type the caller expects from
  // OpenSSL.
  return nullptr;
}

void OpenSSL_add_all_algorithms(void) {}

void OPENSSL_add_all_algorithms_conf(void) {}

void OpenSSL_add_all_ciphers(void) {}

void OpenSSL_add_all_digests(void) {}

void EVP_cleanup(void) {}

int EVP_PKEY_set1_tls_encodedpoint(EVP_PKEY *pkey, const uint8_t *in,
                                   size_t len) {
  if (pkey->ameth->set1_tls_encodedpoint == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  return pkey->ameth->set1_tls_encodedpoint(pkey, in, len);
}

size_t EVP_PKEY_get1_tls_encodedpoint(const EVP_PKEY *pkey, uint8_t **out_ptr) {
  if (pkey->ameth->get1_tls_encodedpoint == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  return pkey->ameth->get1_tls_encodedpoint(pkey, out_ptr);
}

int EVP_PKEY_base_id(const EVP_PKEY *pkey) {
  // OpenSSL has two notions of key type because it supports multiple OIDs for
  // the same algorithm: NID_rsa vs NID_rsaEncryption and five distinct spelling
  // of DSA. We do not support these, so the base ID is simply the ID.
  return EVP_PKEY_id(pkey);
}
