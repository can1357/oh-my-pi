// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/rsa.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>
#include <openssl/span.h>
#include <openssl/x509.h>

#include "../bytestring/internal.h"
#include "../fipsmodule/rsa/internal.h"
#include "../internal.h"
#include "internal.h"


static int parse_integer(CBS *cbs, BIGNUM **out) {
  assert(*out == nullptr);
  *out = BN_new();
  if (*out == nullptr) {
    return 0;
  }
  return BN_parse_asn1_unsigned(cbs, *out);
}

static int marshal_integer(CBB *cbb, BIGNUM *bn) {
  if (bn == nullptr) {
    // An RSA object may be missing some components.
    OPENSSL_PUT_ERROR(RSA, RSA_R_VALUE_MISSING);
    return 0;
  }
  return BN_marshal_asn1(cbb, bn);
}

RSA *RSA_parse_public_key(CBS *cbs) {
  RSA *ret = RSA_new();
  if (ret == nullptr) {
    return nullptr;
  }
  CBS child;
  if (!CBS_get_asn1(cbs, &child, CBS_ASN1_SEQUENCE) ||
      !parse_integer(&child, &ret->n) ||
      !parse_integer(&child, &ret->e) ||
      CBS_len(&child) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    RSA_free(ret);
    return nullptr;
  }

  if (!RSA_check_key(ret)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_RSA_PARAMETERS);
    RSA_free(ret);
    return nullptr;
  }

  return ret;
}

RSA *RSA_public_key_from_bytes(const uint8_t *in, size_t in_len) {
  CBS cbs;
  CBS_init(&cbs, in, in_len);
  RSA *ret = RSA_parse_public_key(&cbs);
  if (ret == nullptr || CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    RSA_free(ret);
    return nullptr;
  }
  return ret;
}

int RSA_marshal_public_key(CBB *cbb, const RSA *rsa) {
  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_SEQUENCE) ||
      !marshal_integer(&child, rsa->n) ||
      !marshal_integer(&child, rsa->e) ||
      !CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_ENCODE_ERROR);
    return 0;
  }
  return 1;
}

int RSA_public_key_to_bytes(uint8_t **out_bytes, size_t *out_len,
                            const RSA *rsa) {
  CBB cbb;
  CBB_zero(&cbb);
  if (!CBB_init(&cbb, 0) ||
      !RSA_marshal_public_key(&cbb, rsa) ||
      !CBB_finish(&cbb, out_bytes, out_len)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_ENCODE_ERROR);
    CBB_cleanup(&cbb);
    return 0;
  }
  return 1;
}

// kVersionTwoPrime is the value of the version field for a two-prime
// RSAPrivateKey structure (RFC 8017).
static const uint64_t kVersionTwoPrime = 0;

RSA *RSA_parse_private_key(CBS *cbs) {
  RSA *ret = RSA_new();
  if (ret == nullptr) {
    return nullptr;
  }

  CBS child;
  uint64_t version;
  if (!CBS_get_asn1(cbs, &child, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1_uint64(&child, &version)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    goto err;
  }

  if (version != kVersionTwoPrime) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_VERSION);
    goto err;
  }

  if (!parse_integer(&child, &ret->n) ||
      !parse_integer(&child, &ret->e) ||
      !parse_integer(&child, &ret->d) ||
      !parse_integer(&child, &ret->p) ||
      !parse_integer(&child, &ret->q) ||
      !parse_integer(&child, &ret->dmp1) ||
      !parse_integer(&child, &ret->dmq1) ||
      !parse_integer(&child, &ret->iqmp)) {
    goto err;
  }

  if (CBS_len(&child) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    goto err;
  }

  if (!RSA_check_key(ret)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_RSA_PARAMETERS);
    goto err;
  }

  return ret;

err:
  RSA_free(ret);
  return nullptr;
}

RSA *RSA_private_key_from_bytes(const uint8_t *in, size_t in_len) {
  CBS cbs;
  CBS_init(&cbs, in, in_len);
  RSA *ret = RSA_parse_private_key(&cbs);
  if (ret == nullptr || CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    RSA_free(ret);
    return nullptr;
  }
  return ret;
}

int RSA_marshal_private_key(CBB *cbb, const RSA *rsa) {
  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&child, kVersionTwoPrime) ||
      !marshal_integer(&child, rsa->n) ||
      !marshal_integer(&child, rsa->e) ||
      !marshal_integer(&child, rsa->d) ||
      !marshal_integer(&child, rsa->p) ||
      !marshal_integer(&child, rsa->q) ||
      !marshal_integer(&child, rsa->dmp1) ||
      !marshal_integer(&child, rsa->dmq1) ||
      !marshal_integer(&child, rsa->iqmp) ||
      !CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_ENCODE_ERROR);
    return 0;
  }
  return 1;
}

int RSA_private_key_to_bytes(uint8_t **out_bytes, size_t *out_len,
                             const RSA *rsa) {
  CBB cbb;
  CBB_zero(&cbb);
  if (!CBB_init(&cbb, 0) ||
      !RSA_marshal_private_key(&cbb, rsa) ||
      !CBB_finish(&cbb, out_bytes, out_len)) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_ENCODE_ERROR);
    CBB_cleanup(&cbb);
    return 0;
  }
  return 1;
}

RSA *d2i_RSAPublicKey(RSA **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, RSA_parse_public_key);
}

int i2d_RSAPublicKey(const RSA *in, uint8_t **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/256, outp,
      [&](CBB *cbb) -> bool { return RSA_marshal_public_key(cbb, in); });
}

RSA *d2i_RSAPrivateKey(RSA **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, RSA_parse_private_key);
}

int i2d_RSAPrivateKey(const RSA *in, uint8_t **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/512, outp,
      [&](CBB *cbb) -> bool { return RSA_marshal_private_key(cbb, in); });
}

RSA *RSAPublicKey_dup(const RSA *rsa) {
  uint8_t *der;
  size_t der_len;
  if (!RSA_public_key_to_bytes(&der, &der_len, rsa)) {
    return nullptr;
  }
  RSA *ret = RSA_public_key_from_bytes(der, der_len);
  OPENSSL_free(der);
  return ret;
}

RSA *RSAPrivateKey_dup(const RSA *rsa) {
  uint8_t *der;
  size_t der_len;
  if (!RSA_private_key_to_bytes(&der, &der_len, rsa)) {
    return nullptr;
  }
  RSA *ret = RSA_private_key_from_bytes(der, der_len);
  OPENSSL_free(der);
  return ret;
}

static const uint8_t kPSSParamsSHA256[] = {
    0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
    0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0xa1, 0x1c, 0x30,
    0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x08, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
    0x04, 0x02, 0x01, 0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x20};

static const uint8_t kPSSParamsSHA384[] = {
    0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
    0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0xa1, 0x1c, 0x30,
    0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x08, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
    0x04, 0x02, 0x02, 0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x30};

static const uint8_t kPSSParamsSHA512[] = {
    0x30, 0x34, 0xa0, 0x0f, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
    0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0xa1, 0x1c, 0x30,
    0x1a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x08, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
    0x04, 0x02, 0x03, 0x05, 0x00, 0xa2, 0x03, 0x02, 0x01, 0x40};

const EVP_MD *rsa_pss_params_get_md(rsa_pss_params_t params) {
  switch (params) {
    case rsa_pss_none:
      return nullptr;
    case rsa_pss_sha256:
      return EVP_sha256();
    case rsa_pss_sha384:
      return EVP_sha384();
    case rsa_pss_sha512:
      return EVP_sha512();
  }
  abort();
}

int rsa_marshal_pss_params(CBB *cbb, rsa_pss_params_t params) {
  bssl::Span<const uint8_t> bytes;
  switch (params) {
    case rsa_pss_none:
      OPENSSL_PUT_ERROR(RSA, ERR_R_INTERNAL_ERROR);
      return 0;
    case rsa_pss_sha256:
      bytes = kPSSParamsSHA256;
      break;
    case rsa_pss_sha384:
      bytes = kPSSParamsSHA384;
      break;
    case rsa_pss_sha512:
      bytes = kPSSParamsSHA512;
      break;
  }

  return CBB_add_bytes(cbb, bytes.data(), bytes.size());
}

// 1.2.840.113549.1.1.8
static const uint8_t kMGF1OID[] = {0x2a, 0x86, 0x48, 0x86, 0xf7,
                                   0x0d, 0x01, 0x01, 0x08};

int rsa_parse_pss_params(CBS *cbs, rsa_pss_params_t *out,
                         int allow_explicit_trailer) {
  // See RFC 4055, section 3.1.
  //
  // hashAlgorithm, maskGenAlgorithm, and saltLength all have DEFAULTs
  // corresponding to SHA-1. We do not support SHA-1 with PSS, so we do not
  // bother recognizing the omitted versions.
  CBS params, hash_wrapper, mask_wrapper, mask_alg, mask_oid, salt_wrapper;
  uint64_t salt_len;
  if (!CBS_get_asn1(cbs, &params, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&params, &hash_wrapper,
                    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 0) ||
      // |hash_wrapper| will be parsed below.
      !CBS_get_asn1(&params, &mask_wrapper,
                    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 1) ||
      !CBS_get_asn1(&mask_wrapper, &mask_alg, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&mask_alg, &mask_oid, CBS_ASN1_OBJECT) ||
      // We only support MGF-1.
      bssl::Span<const uint8_t>(mask_oid) != kMGF1OID ||
      // The remainder of |mask_alg| will be parsed below.
      CBS_len(&mask_wrapper) != 0 ||
      !CBS_get_asn1(&params, &salt_wrapper,
                    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 2) ||
      !CBS_get_asn1_uint64(&salt_wrapper, &salt_len) ||
      CBS_len(&salt_wrapper) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    return 0;
  }

  // The trailer field must be 1 (0xbc). This value is DEFAULT, so the structure
  // is required to omit it in DER.
  if (CBS_len(&params) != 0 && allow_explicit_trailer) {
    CBS trailer_wrapper;
    uint64_t trailer;
    if (!CBS_get_asn1(&params, &trailer_wrapper,
                      CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 3) ||
        !CBS_get_asn1_uint64(&trailer_wrapper, &trailer) ||  //
        trailer != 1) {
      OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
      return 0;
    }
  }
  if (CBS_len(&params) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    return 0;
  }

  int hash_nid = EVP_parse_digest_algorithm_nid(&hash_wrapper);
  if (hash_nid == NID_undef || CBS_len(&hash_wrapper) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    return 0;
  }

  // We only support combinations where the MGF-1 hash matches the overall hash.
  int mgf1_hash_nid = EVP_parse_digest_algorithm_nid(&mask_alg);
  if (mgf1_hash_nid != hash_nid || CBS_len(&mask_alg) != 0) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    return 0;
  }

  // We only support salt lengths that match the hash length.
  rsa_pss_params_t ret;
  uint64_t hash_len;
  switch (hash_nid) {
    case NID_sha256:
      ret = rsa_pss_sha256;
      hash_len = 32;
      break;
    case NID_sha384:
      ret = rsa_pss_sha384;
      hash_len = 48;
      break;
    case NID_sha512:
      ret = rsa_pss_sha512;
      hash_len = 64;
      break;
    default:
      OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
      return 0;
  }
  if (salt_len != hash_len) {
    OPENSSL_PUT_ERROR(RSA, RSA_R_BAD_ENCODING);
    return 0;
  }

  *out = ret;
  return 1;
}
