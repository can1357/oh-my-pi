// Copyright 2017 The BoringSSL Authors
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

#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"

namespace {

struct ED25519_KEY {
  // key is the concatenation of the private seed and public key. It is stored
  // as a single 64-bit array to allow passing to |ED25519_sign|. If
  // |has_private| is false, the first 32 bytes are uninitialized and the public
  // key is in the last 32 bytes.
  uint8_t key[64];
  bool has_private;
};

extern const EVP_PKEY_ASN1_METHOD ed25519_asn1_meth;

#define ED25519_PUBLIC_KEY_OFFSET 32

static void ed25519_free(EVP_PKEY *pkey) {
  OPENSSL_free(pkey->pkey);
  pkey->pkey = nullptr;
}

static int ed25519_set_priv_raw(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
  if (len != 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  ED25519_KEY *key =
      reinterpret_cast<ED25519_KEY *>(OPENSSL_malloc(sizeof(ED25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  // The RFC 8032 encoding stores only the 32-byte seed, so we must recover the
  // full representation which we use from it.
  uint8_t pubkey_unused[32];
  ED25519_keypair_from_seed(pubkey_unused, key->key, in);
  key->has_private = true;
  evp_pkey_set0(pkey, &ed25519_asn1_meth, key);
  return 1;
}

static int ed25519_set_pub_raw(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
  if (len != 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  ED25519_KEY *key =
      reinterpret_cast<ED25519_KEY *>(OPENSSL_malloc(sizeof(ED25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  OPENSSL_memcpy(key->key + ED25519_PUBLIC_KEY_OFFSET, in, 32);
  key->has_private = false;
  evp_pkey_set0(pkey, &ed25519_asn1_meth, key);
  return 1;
}

static int ed25519_get_priv_raw(const EVP_PKEY *pkey, uint8_t *out,
                                size_t *out_len) {
  const ED25519_KEY *key = reinterpret_cast<const ED25519_KEY *>(pkey->pkey);
  if (!key->has_private) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
    return 0;
  }

  if (out == nullptr) {
    *out_len = 32;
    return 1;
  }

  if (*out_len < 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
    return 0;
  }

  // The raw private key format is the first 32 bytes of the private key.
  OPENSSL_memcpy(out, key->key, 32);
  *out_len = 32;
  return 1;
}

static int ed25519_get_pub_raw(const EVP_PKEY *pkey, uint8_t *out,
                               size_t *out_len) {
  const ED25519_KEY *key = reinterpret_cast<const ED25519_KEY *>(pkey->pkey);
  if (out == nullptr) {
    *out_len = 32;
    return 1;
  }

  if (*out_len < 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
    return 0;
  }

  OPENSSL_memcpy(out, key->key + ED25519_PUBLIC_KEY_OFFSET, 32);
  *out_len = 32;
  return 1;
}

static evp_decode_result_t ed25519_pub_decode(const EVP_PKEY_ALG *alg,
                                              EVP_PKEY *out, CBS *params,
                                              CBS *key) {
  // See RFC 8410, section 4.

  // The parameters must be omitted. Public keys have length 32.
  if (CBS_len(params) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  return ed25519_set_pub_raw(out, CBS_data(key), CBS_len(key))
             ? evp_decode_ok
             : evp_decode_error;
}

static int ed25519_pub_encode(CBB *out, const EVP_PKEY *pkey) {
  const ED25519_KEY *key = reinterpret_cast<const ED25519_KEY *>(pkey->pkey);

  // See RFC 8410, section 4.
  CBB spki, algorithm, key_bitstring;
  if (!CBB_add_asn1(out, &spki, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1(&spki, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, ed25519_asn1_meth.oid,
                            ed25519_asn1_meth.oid_len) ||
      !CBB_add_asn1(&spki, &key_bitstring, CBS_ASN1_BITSTRING) ||
      !CBB_add_u8(&key_bitstring, 0 /* padding */) ||
      !CBB_add_bytes(&key_bitstring, key->key + ED25519_PUBLIC_KEY_OFFSET,
                     32) ||
      !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static int ed25519_pub_cmp(const EVP_PKEY *a, const EVP_PKEY *b) {
  const ED25519_KEY *a_key = reinterpret_cast<const ED25519_KEY *>(a->pkey);
  const ED25519_KEY *b_key = reinterpret_cast<const ED25519_KEY *>(b->pkey);
  return OPENSSL_memcmp(a_key->key + ED25519_PUBLIC_KEY_OFFSET,
                        b_key->key + ED25519_PUBLIC_KEY_OFFSET, 32) == 0;
}

static evp_decode_result_t ed25519_priv_decode(const EVP_PKEY_ALG *alg,
                                               EVP_PKEY *out, CBS *params,
                                               CBS *key) {
  // See RFC 8410, section 7.

  // Parameters must be empty. The key is a 32-byte value wrapped in an extra
  // OCTET STRING layer.
  CBS inner;
  if (CBS_len(params) != 0 ||
      !CBS_get_asn1(key, &inner, CBS_ASN1_OCTETSTRING) || CBS_len(key) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  return ed25519_set_priv_raw(out, CBS_data(&inner), CBS_len(&inner))
             ? evp_decode_ok
             : evp_decode_error;
}

static int ed25519_priv_encode(CBB *out, const EVP_PKEY *pkey) {
  const ED25519_KEY *key = reinterpret_cast<const ED25519_KEY *>(pkey->pkey);
  if (!key->has_private) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
    return 0;
  }

  // See RFC 8410, section 7.
  CBB pkcs8, algorithm, private_key, inner;
  if (!CBB_add_asn1(out, &pkcs8, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&pkcs8, 0 /* version */) ||
      !CBB_add_asn1(&pkcs8, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, ed25519_asn1_meth.oid,
                            ed25519_asn1_meth.oid_len) ||
      !CBB_add_asn1(&pkcs8, &private_key, CBS_ASN1_OCTETSTRING) ||
      !CBB_add_asn1(&private_key, &inner, CBS_ASN1_OCTETSTRING) ||
      // The PKCS#8 encoding stores only the 32-byte seed which is the first 32
      // bytes of the private key.
      !CBB_add_bytes(&inner, key->key, 32) ||  //
      !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static int ed25519_size(const EVP_PKEY *pkey) { return 64; }

static int ed25519_bits(const EVP_PKEY *pkey) { return 253; }

const EVP_PKEY_ASN1_METHOD ed25519_asn1_meth = {
    EVP_PKEY_ED25519,
    {0x2b, 0x65, 0x70},
    3,
    &ed25519_pkey_meth,
    ed25519_pub_decode,
    ed25519_pub_encode,
    ed25519_pub_cmp,
    ed25519_priv_decode,
    ed25519_priv_encode,
    ed25519_set_priv_raw,
    /*set_priv_seed=*/nullptr,
    ed25519_set_pub_raw,
    ed25519_get_priv_raw,
    /*get_priv_seed=*/nullptr,
    ed25519_get_pub_raw,
    /*set1_tls_encodedpoint=*/nullptr,
    /*get1_tls_encodedpoint=*/nullptr,
    /*pkey_opaque=*/nullptr,
    ed25519_size,
    ed25519_bits,
    /*param_missing=*/nullptr,
    /*param_copy=*/nullptr,
    /*param_cmp=*/nullptr,
    ed25519_free,
};

// Ed25519 has no parameters to copy.
static int pkey_ed25519_copy(EVP_PKEY_CTX *dst, EVP_PKEY_CTX *src) { return 1; }

static int pkey_ed25519_keygen(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey) {
  ED25519_KEY *key =
      reinterpret_cast<ED25519_KEY *>(OPENSSL_malloc(sizeof(ED25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  uint8_t pubkey_unused[32];
  ED25519_keypair(pubkey_unused, key->key);
  key->has_private = true;

  evp_pkey_set0(pkey, &ed25519_asn1_meth, key);
  return 1;
}

static int pkey_ed25519_sign_message(EVP_PKEY_CTX *ctx, uint8_t *sig,
                                     size_t *siglen, const uint8_t *tbs,
                                     size_t tbslen) {
  const ED25519_KEY *key =
      reinterpret_cast<const ED25519_KEY *>(ctx->pkey->pkey);
  if (!key->has_private) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
    return 0;
  }

  if (sig == nullptr) {
    *siglen = 64;
    return 1;
  }

  if (*siglen < 64) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
    return 0;
  }

  if (!ED25519_sign(sig, tbs, tbslen, key->key)) {
    return 0;
  }

  *siglen = 64;
  return 1;
}

static int pkey_ed25519_verify_message(EVP_PKEY_CTX *ctx, const uint8_t *sig,
                                       size_t siglen, const uint8_t *tbs,
                                       size_t tbslen) {
  const ED25519_KEY *key =
      reinterpret_cast<const ED25519_KEY *>(ctx->pkey->pkey);
  if (siglen != 64 ||
      !ED25519_verify(tbs, tbslen, sig, key->key + ED25519_PUBLIC_KEY_OFFSET)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_SIGNATURE);
    return 0;
  }

  return 1;
}

}  // namespace

const EVP_PKEY_CTX_METHOD ed25519_pkey_meth = {
    /*pkey_id=*/EVP_PKEY_ED25519,
    /*init=*/nullptr,
    /*copy=*/pkey_ed25519_copy,
    /*cleanup=*/nullptr,
    /*keygen=*/pkey_ed25519_keygen,
    /*sign=*/nullptr,
    /*sign_message=*/pkey_ed25519_sign_message,
    /*verify=*/nullptr,
    /*verify_message=*/pkey_ed25519_verify_message,
    /*verify_recover=*/nullptr,
    /*encrypt=*/nullptr,
    /*decrypt=*/nullptr,
    /*derive=*/nullptr,
    /*paramgen=*/nullptr,
    /*ctrl=*/nullptr,
};

const EVP_PKEY_ALG *EVP_pkey_ed25519(void) {
  static const EVP_PKEY_ALG kAlg = {&ed25519_asn1_meth};
  return &kAlg;
}
