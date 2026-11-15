// Copyright 2019 The BoringSSL Authors
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

struct X25519_KEY {
  uint8_t pub[32];
  uint8_t priv[32];
  bool has_private;
};

extern const EVP_PKEY_ASN1_METHOD x25519_asn1_meth;

static void x25519_free(EVP_PKEY *pkey) {
  OPENSSL_free(pkey->pkey);
  pkey->pkey = nullptr;
}

static int x25519_set_priv_raw(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
  if (len != 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  X25519_KEY *key =
      reinterpret_cast<X25519_KEY *>(OPENSSL_malloc(sizeof(X25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  OPENSSL_memcpy(key->priv, in, 32);
  X25519_public_from_private(key->pub, key->priv);
  key->has_private = true;

  evp_pkey_set0(pkey, &x25519_asn1_meth, key);
  return 1;
}

static int x25519_set_pub_raw(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
  if (len != 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  X25519_KEY *key =
      reinterpret_cast<X25519_KEY *>(OPENSSL_malloc(sizeof(X25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  OPENSSL_memcpy(key->pub, in, 32);
  key->has_private = false;

  evp_pkey_set0(pkey, &x25519_asn1_meth, key);
  return 1;
}

static int x25519_get_priv_raw(const EVP_PKEY *pkey, uint8_t *out,
                               size_t *out_len) {
  const X25519_KEY *key = reinterpret_cast<X25519_KEY *>(pkey->pkey);
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

  OPENSSL_memcpy(out, key->priv, 32);
  *out_len = 32;
  return 1;
}

static int x25519_get_pub_raw(const EVP_PKEY *pkey, uint8_t *out,
                              size_t *out_len) {
  const X25519_KEY *key = reinterpret_cast<X25519_KEY *>(pkey->pkey);
  if (out == nullptr) {
    *out_len = 32;
    return 1;
  }

  if (*out_len < 32) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
    return 0;
  }

  OPENSSL_memcpy(out, key->pub, 32);
  *out_len = 32;
  return 1;
}

static int x25519_set1_tls_encodedpoint(EVP_PKEY *pkey, const uint8_t *in,
                                        size_t len) {
  return x25519_set_pub_raw(pkey, in, len);
}

static size_t x25519_get1_tls_encodedpoint(const EVP_PKEY *pkey,
                                           uint8_t **out_ptr) {
  const X25519_KEY *key = reinterpret_cast<X25519_KEY *>(pkey->pkey);
  if (key == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NO_KEY_SET);
    return 0;
  }

  *out_ptr = reinterpret_cast<uint8_t *>(OPENSSL_memdup(key->pub, 32));
  return *out_ptr == nullptr ? 0 : 32;
}

static evp_decode_result_t x25519_pub_decode(const EVP_PKEY_ALG *alg,
                                             EVP_PKEY *out, CBS *params,
                                             CBS *key) {
  // See RFC 8410, section 4.

  // The parameters must be omitted. Public keys have length 32.
  if (CBS_len(params) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  return x25519_set_pub_raw(out, CBS_data(key), CBS_len(key))
             ? evp_decode_ok
             : evp_decode_error;
}

static int x25519_pub_encode(CBB *out, const EVP_PKEY *pkey) {
  const X25519_KEY *key = reinterpret_cast<X25519_KEY *>(pkey->pkey);

  // See RFC 8410, section 4.
  CBB spki, algorithm, key_bitstring;
  if (!CBB_add_asn1(out, &spki, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1(&spki, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, x25519_asn1_meth.oid,
                            x25519_asn1_meth.oid_len) ||
      !CBB_add_asn1(&spki, &key_bitstring, CBS_ASN1_BITSTRING) ||
      !CBB_add_u8(&key_bitstring, 0 /* padding */) ||
      !CBB_add_bytes(&key_bitstring, key->pub, 32) ||  //
      !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static int x25519_pub_cmp(const EVP_PKEY *a, const EVP_PKEY *b) {
  const X25519_KEY *a_key = reinterpret_cast<const X25519_KEY *>(a->pkey);
  const X25519_KEY *b_key = reinterpret_cast<const X25519_KEY *>(b->pkey);
  return OPENSSL_memcmp(a_key->pub, b_key->pub, 32) == 0;
}

static evp_decode_result_t x25519_priv_decode(const EVP_PKEY_ALG *alg,
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

  return x25519_set_priv_raw(out, CBS_data(&inner), CBS_len(&inner))
             ? evp_decode_ok
             : evp_decode_error;
}

static int x25519_priv_encode(CBB *out, const EVP_PKEY *pkey) {
  const X25519_KEY *key = reinterpret_cast<const X25519_KEY *>(pkey->pkey);
  if (!key->has_private) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
    return 0;
  }

  // See RFC 8410, section 7.
  CBB pkcs8, algorithm, private_key, inner;
  if (!CBB_add_asn1(out, &pkcs8, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&pkcs8, 0 /* version */) ||
      !CBB_add_asn1(&pkcs8, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, x25519_asn1_meth.oid,
                            x25519_asn1_meth.oid_len) ||
      !CBB_add_asn1(&pkcs8, &private_key, CBS_ASN1_OCTETSTRING) ||
      !CBB_add_asn1(&private_key, &inner, CBS_ASN1_OCTETSTRING) ||
      // The PKCS#8 encoding stores only the 32-byte seed which is the first 32
      // bytes of the private key.
      !CBB_add_bytes(&inner, key->priv, 32) ||  //
      !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static int x25519_size(const EVP_PKEY *pkey) { return 32; }

static int x25519_bits(const EVP_PKEY *pkey) { return 253; }

const EVP_PKEY_ASN1_METHOD x25519_asn1_meth = {
    EVP_PKEY_X25519,
    {0x2b, 0x65, 0x6e},
    3,
    &x25519_pkey_meth,
    x25519_pub_decode,
    x25519_pub_encode,
    x25519_pub_cmp,
    x25519_priv_decode,
    x25519_priv_encode,
    x25519_set_priv_raw,
    /*set_priv_seed=*/nullptr,
    x25519_set_pub_raw,
    x25519_get_priv_raw,
    /*get_priv_seed=*/nullptr,
    x25519_get_pub_raw,
    x25519_set1_tls_encodedpoint,
    x25519_get1_tls_encodedpoint,
    /*pkey_opaque=*/nullptr,
    x25519_size,
    x25519_bits,
    /*param_missing=*/nullptr,
    /*param_copy=*/nullptr,
    /*param_cmp=*/nullptr,
    x25519_free,
};

}  // namespace

const EVP_PKEY_ALG *EVP_pkey_x25519(void) {
  static const EVP_PKEY_ALG kAlg = {&x25519_asn1_meth};
  return &kAlg;
}

// X25519 has no parameters to copy.
static int pkey_x25519_copy(EVP_PKEY_CTX *dst, EVP_PKEY_CTX *src) { return 1; }

static int pkey_x25519_keygen(EVP_PKEY_CTX *ctx, EVP_PKEY *pkey) {
  X25519_KEY *key =
      reinterpret_cast<X25519_KEY *>(OPENSSL_malloc(sizeof(X25519_KEY)));
  if (key == nullptr) {
    return 0;
  }

  X25519_keypair(key->pub, key->priv);
  key->has_private = true;
  evp_pkey_set0(pkey, &x25519_asn1_meth, key);
  return 1;
}

static int pkey_x25519_derive(EVP_PKEY_CTX *ctx, uint8_t *out,
                              size_t *out_len) {
  if (ctx->pkey == nullptr || ctx->peerkey == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_KEYS_NOT_SET);
    return 0;
  }

  const X25519_KEY *our_key =
      reinterpret_cast<const X25519_KEY *>(ctx->pkey->pkey);
  const X25519_KEY *peer_key =
      reinterpret_cast<const X25519_KEY *>(ctx->peerkey->pkey);
  if (our_key == nullptr || peer_key == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_KEYS_NOT_SET);
    return 0;
  }

  if (!our_key->has_private) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
    return 0;
  }

  if (out != nullptr) {
    if (*out_len < 32) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
      return 0;
    }
    if (!X25519(out, our_key->priv, peer_key->pub)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
      return 0;
    }
  }

  *out_len = 32;
  return 1;
}

static int pkey_x25519_ctrl(EVP_PKEY_CTX *ctx, int type, int p1, void *p2) {
  switch (type) {
    case EVP_PKEY_CTRL_PEER_KEY:
      // |EVP_PKEY_derive_set_peer| requires the key implement this command,
      // even if it is a no-op.
      return 1;

    default:
      OPENSSL_PUT_ERROR(EVP, EVP_R_COMMAND_NOT_SUPPORTED);
      return 0;
  }
}

const EVP_PKEY_CTX_METHOD x25519_pkey_meth = {
    /*pkey_id=*/EVP_PKEY_X25519,
    /*init=*/nullptr,
    /*copy=*/pkey_x25519_copy,
    /*cleanup=*/nullptr,
    /*keygen=*/pkey_x25519_keygen,
    /*sign=*/nullptr,
    /*sign_message=*/nullptr,
    /*verify=*/nullptr,
    /*verify_message=*/nullptr,
    /*verify_recover=*/nullptr,
    /*encrypt=*/nullptr,
    /*decrypt=*/nullptr,
    /*derive=*/pkey_x25519_derive,
    /*paramgen=*/nullptr,
    /*ctrl=*/pkey_x25519_ctrl,
};
