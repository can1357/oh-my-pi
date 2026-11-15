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

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/digest.h>
#include <openssl/dsa.h>
#include <openssl/err.h>

#include "../dsa/internal.h"
#include "internal.h"


namespace {

extern const EVP_PKEY_ASN1_METHOD dsa_asn1_meth;

static evp_decode_result_t dsa_pub_decode(const EVP_PKEY_ALG *alg,
                                          EVP_PKEY *out, CBS *params,
                                          CBS *key) {
  // See RFC 3279, section 2.3.2.

  // Decode parameters. RFC 3279 permits DSA parameters to be omitted, in which
  // case they are implicitly determined from the issuing certificate, or
  // somewhere unspecified and out-of-band. We do not support this mode.
  bssl::UniquePtr<DSA> dsa(DSA_parse_parameters(params));
  if (dsa == nullptr || CBS_len(params) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  dsa->pub_key = BN_new();
  if (dsa->pub_key == nullptr) {
    return evp_decode_error;
  }

  if (!BN_parse_asn1_unsigned(key, dsa->pub_key) || CBS_len(key) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  EVP_PKEY_assign_DSA(out, dsa.release());
  return evp_decode_ok;
}

static int dsa_pub_encode(CBB *out, const EVP_PKEY *key) {
  const DSA *dsa = reinterpret_cast<const DSA *>(key->pkey);
  const int has_params =
      dsa->p != nullptr && dsa->q != nullptr && dsa->g != nullptr;

  // See RFC 5480, section 2.
  CBB spki, algorithm, key_bitstring;
  if (!CBB_add_asn1(out, &spki, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1(&spki, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, dsa_asn1_meth.oid,
                            dsa_asn1_meth.oid_len) ||
      (has_params && !DSA_marshal_parameters(&algorithm, dsa)) ||
      !CBB_add_asn1(&spki, &key_bitstring, CBS_ASN1_BITSTRING) ||
      !CBB_add_u8(&key_bitstring, 0 /* padding */) ||
      !BN_marshal_asn1(&key_bitstring, dsa->pub_key) || !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static evp_decode_result_t dsa_priv_decode(const EVP_PKEY_ALG *alg,
                                           EVP_PKEY *out, CBS *params,
                                           CBS *key) {
  // See PKCS#11, v2.40, section 2.5.

  // Decode parameters.
  bssl::UniquePtr<DSA> dsa(DSA_parse_parameters(params));
  if (dsa == nullptr || CBS_len(params) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  dsa->priv_key = BN_new();
  if (dsa->priv_key == nullptr) {
    return evp_decode_error;
  }
  if (!BN_parse_asn1_unsigned(key, dsa->priv_key) || CBS_len(key) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  // To avoid DoS attacks when importing private keys, check bounds on |dsa|.
  // This bounds |dsa->priv_key| against |dsa->q| and bounds |dsa->q|'s bit
  // width.
  if (!dsa_check_key(dsa.get())) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return evp_decode_error;
  }

  // Calculate the public key.
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
  dsa->pub_key = BN_new();
  if (ctx == nullptr || dsa->pub_key == nullptr ||
      !BN_mod_exp_mont_consttime(dsa->pub_key, dsa->g, dsa->priv_key, dsa->p,
                                 ctx.get(), nullptr)) {
    return evp_decode_error;
  }

  EVP_PKEY_assign_DSA(out, dsa.release());
  return evp_decode_ok;
}

static int dsa_priv_encode(CBB *out, const EVP_PKEY *key) {
  const DSA *dsa = reinterpret_cast<const DSA *>(key->pkey);
  if (dsa == nullptr || dsa->priv_key == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_MISSING_PARAMETERS);
    return 0;
  }

  // See PKCS#11, v2.40, section 2.5.
  CBB pkcs8, algorithm, private_key;
  if (!CBB_add_asn1(out, &pkcs8, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&pkcs8, 0 /* version */) ||
      !CBB_add_asn1(&pkcs8, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, dsa_asn1_meth.oid,
                            dsa_asn1_meth.oid_len) ||
      !DSA_marshal_parameters(&algorithm, dsa) ||
      !CBB_add_asn1(&pkcs8, &private_key, CBS_ASN1_OCTETSTRING) ||
      !BN_marshal_asn1(&private_key, dsa->priv_key) || !CBB_flush(out)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}

static int int_dsa_size(const EVP_PKEY *pkey) {
  const DSA *dsa = reinterpret_cast<const DSA *>(pkey->pkey);
  return DSA_size(dsa);
}

static int dsa_bits(const EVP_PKEY *pkey) {
  const DSA *dsa = reinterpret_cast<const DSA *>(pkey->pkey);
  return BN_num_bits(DSA_get0_p(dsa));
}

static int dsa_missing_parameters(const EVP_PKEY *pkey) {
  const DSA *dsa = reinterpret_cast<const DSA *>(pkey->pkey);
  if (DSA_get0_p(dsa) == nullptr || DSA_get0_q(dsa) == nullptr ||
      DSA_get0_g(dsa) == nullptr) {
    return 1;
  }
  return 0;
}

static int dup_bn_into(BIGNUM **out, BIGNUM *src) {
  bssl::UniquePtr<BIGNUM> a(BN_dup(src));
  if (a == nullptr) {
    return 0;
  }
  BN_free(*out);
  *out = a.release();
  return 1;
}

static int dsa_copy_parameters(EVP_PKEY *to, const EVP_PKEY *from) {
  DSA *to_dsa = reinterpret_cast<DSA *>(to->pkey);
  const DSA *from_dsa = reinterpret_cast<const DSA *>(from->pkey);
  if (!dup_bn_into(&to_dsa->p, from_dsa->p) ||
      !dup_bn_into(&to_dsa->q, from_dsa->q) ||
      !dup_bn_into(&to_dsa->g, from_dsa->g)) {
    return 0;
  }

  return 1;
}

static int dsa_cmp_parameters(const EVP_PKEY *a, const EVP_PKEY *b) {
  const DSA *a_dsa = reinterpret_cast<const DSA *>(a->pkey);
  const DSA *b_dsa = reinterpret_cast<const DSA *>(b->pkey);
  return BN_cmp(DSA_get0_p(a_dsa), DSA_get0_p(b_dsa)) == 0 &&
         BN_cmp(DSA_get0_q(a_dsa), DSA_get0_q(b_dsa)) == 0 &&
         BN_cmp(DSA_get0_g(a_dsa), DSA_get0_g(b_dsa)) == 0;
}

static int dsa_pub_cmp(const EVP_PKEY *a, const EVP_PKEY *b) {
  const DSA *a_dsa = reinterpret_cast<const DSA *>(a->pkey);
  const DSA *b_dsa = reinterpret_cast<const DSA *>(b->pkey);
  return BN_cmp(DSA_get0_pub_key(b_dsa), DSA_get0_pub_key(a_dsa)) == 0;
}

static void int_dsa_free(EVP_PKEY *pkey) {
  DSA_free(reinterpret_cast<DSA *>(pkey->pkey));
  pkey->pkey = nullptr;
}

const EVP_PKEY_ASN1_METHOD dsa_asn1_meth = {
    EVP_PKEY_DSA,
    // 1.2.840.10040.4.1
    {0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01},
    7,

    /*pkey_method=*/nullptr,

    dsa_pub_decode,
    dsa_pub_encode,
    dsa_pub_cmp,

    dsa_priv_decode,
    dsa_priv_encode,

    /*set_priv_raw=*/nullptr,
    /*set_priv_seed=*/nullptr,
    /*set_pub_raw=*/nullptr,
    /*get_priv_raw=*/nullptr,
    /*get_priv_seed=*/nullptr,
    /*get_pub_raw=*/nullptr,
    /*set1_tls_encodedpoint=*/nullptr,
    /*get1_tls_encodedpoint=*/nullptr,

    /*pkey_opaque=*/nullptr,

    int_dsa_size,
    dsa_bits,

    dsa_missing_parameters,
    dsa_copy_parameters,
    dsa_cmp_parameters,

    int_dsa_free,
};

}  // namespace

const EVP_PKEY_ALG *EVP_pkey_dsa(void) {
  static const EVP_PKEY_ALG kAlg = {&dsa_asn1_meth};
  return &kAlg;
}

int EVP_PKEY_CTX_set_dsa_paramgen_bits(EVP_PKEY_CTX *ctx, int nbits) {
  // BoringSSL does not support DSA in |EVP_PKEY_CTX|.
  OPENSSL_PUT_ERROR(EVP, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
  return 0;
}

int EVP_PKEY_CTX_set_dsa_paramgen_q_bits(EVP_PKEY_CTX *ctx, int qbits) {
  // BoringSSL does not support DSA in |EVP_PKEY_CTX|.
  OPENSSL_PUT_ERROR(EVP, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
  return 0;
}

int EVP_PKEY_set1_DSA(EVP_PKEY *pkey, DSA *key) {
  if (EVP_PKEY_assign_DSA(pkey, key)) {
    DSA_up_ref(key);
    return 1;
  }
  return 0;
}

int EVP_PKEY_assign_DSA(EVP_PKEY *pkey, DSA *key) {
  if (key == nullptr) {
    return 0;
  }
  evp_pkey_set0(pkey, &dsa_asn1_meth, key);
  return 1;
}

DSA *EVP_PKEY_get0_DSA(const EVP_PKEY *pkey) {
  if (EVP_PKEY_id(pkey) != EVP_PKEY_DSA) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_EXPECTING_A_DSA_KEY);
    return nullptr;
  }
  return reinterpret_cast<DSA *>(pkey->pkey);
}

DSA *EVP_PKEY_get1_DSA(const EVP_PKEY *pkey) {
  DSA *dsa = EVP_PKEY_get0_DSA(pkey);
  if (dsa != nullptr) {
    DSA_up_ref(dsa);
  }
  return dsa;
}
