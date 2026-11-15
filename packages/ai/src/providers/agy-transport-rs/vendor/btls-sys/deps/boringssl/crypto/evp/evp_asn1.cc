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

#include <string.h>

#include <array>

#include <openssl/bytestring.h>
#include <openssl/dsa.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/rsa.h>
#include <openssl/span.h>

#include "internal.h"
#include "../bytestring/internal.h"
#include "../internal.h"


EVP_PKEY *EVP_PKEY_from_subject_public_key_info(const uint8_t *in, size_t len,
                                                const EVP_PKEY_ALG *const *algs,
                                                size_t num_algs) {
  // Parse the SubjectPublicKeyInfo.
  CBS cbs, spki, algorithm, oid, key;
  CBS_init(&cbs, in, len);
  if (!CBS_get_asn1(&cbs, &spki, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&spki, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&algorithm, &oid, CBS_ASN1_OBJECT) ||
      !CBS_get_asn1(&spki, &key, CBS_ASN1_BITSTRING) ||
      CBS_len(&spki) != 0 ||  //
      CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }

  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr) {
    return nullptr;
  }
  for (const EVP_PKEY_ALG *alg : bssl::Span(algs, num_algs)) {
    if (alg->method->pub_decode == nullptr ||
        bssl::Span(alg->method->oid, alg->method->oid_len) != oid) {
      continue;
    }
    // Every key type we support encodes the key as a byte string with the same
    // conversion to BIT STRING, so perform that common conversion ahead of
    // time, but only after the OID is recognized as supported.
    CBS key_bytes = key;
    uint8_t padding;
    if (!CBS_get_u8(&key_bytes, &padding) || padding != 0) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return nullptr;
    }
    CBS params = algorithm;
    switch (alg->method->pub_decode(alg, ret.get(), &params, &key_bytes)) {
      case evp_decode_error:
        return nullptr;
      case evp_decode_ok:
        return ret.release();
      case evp_decode_unsupported:
        // Continue trying other algorithms.
        break;
    }
  }

  OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
  return nullptr;
}

int EVP_marshal_public_key(CBB *cbb, const EVP_PKEY *key) {
  if (key->ameth == nullptr || key->ameth->pub_encode == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    return 0;
  }

  return key->ameth->pub_encode(cbb, key);
}

EVP_PKEY *EVP_PKEY_from_private_key_info(const uint8_t *in, size_t len,
                                         const EVP_PKEY_ALG *const *algs,
                                         size_t num_algs) {
  // Parse the PrivateKeyInfo.
  CBS cbs, pkcs8, oid, algorithm, key;
  uint64_t version;
  CBS_init(&cbs, in, len);
  if (!CBS_get_asn1(&cbs, &pkcs8, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1_uint64(&pkcs8, &version) || version != 0 ||
      !CBS_get_asn1(&pkcs8, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&algorithm, &oid, CBS_ASN1_OBJECT) ||
      !CBS_get_asn1(&pkcs8, &key, CBS_ASN1_OCTETSTRING) ||
      // A PrivateKeyInfo ends with a SET of Attributes which we ignore.
      CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }

  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr) {
    return nullptr;
  }
  for (const EVP_PKEY_ALG *alg : bssl::Span(algs, num_algs)) {
    if (alg->method->priv_decode == nullptr ||
        bssl::Span(alg->method->oid, alg->method->oid_len) != oid) {
      continue;
    }
    CBS params = algorithm, key_copy = key;
    switch (alg->method->priv_decode(alg, ret.get(), &params, &key_copy)) {
      case evp_decode_error:
        return nullptr;
      case evp_decode_ok:
        return ret.release();
      case evp_decode_unsupported:
        // Continue trying other algorithms.
        break;
    }
  }

  OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
  return nullptr;
}

int EVP_marshal_private_key(CBB *cbb, const EVP_PKEY *key) {
  if (key->ameth == nullptr || key->ameth->priv_encode == nullptr) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_ALGORITHM);
    return 0;
  }

  return key->ameth->priv_encode(cbb, key);
}

EVP_PKEY *EVP_parse_public_key(CBS *cbs) {
  CBS elem;
  if (!CBS_get_asn1_element(cbs, &elem, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }

  auto algs = bssl::GetDefaultEVPAlgorithms();
  return EVP_PKEY_from_subject_public_key_info(CBS_data(&elem), CBS_len(&elem),
                                               algs.data(), algs.size());
}

EVP_PKEY *EVP_parse_private_key(CBS *cbs) {
  CBS elem;
  if (!CBS_get_asn1_element(cbs, &elem, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }

  auto algs = bssl::GetDefaultEVPAlgorithms();
  return EVP_PKEY_from_private_key_info(CBS_data(&elem), CBS_len(&elem),
                                        algs.data(), algs.size());
}

static bssl::UniquePtr<EVP_PKEY> old_priv_decode(CBS *cbs, int type) {
  bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
  if (ret == nullptr) {
    return nullptr;
  }

  switch (type) {
    case EVP_PKEY_EC: {
      bssl::UniquePtr<EC_KEY> ec_key(EC_KEY_parse_private_key(cbs, nullptr));
      if (ec_key == nullptr) {
        return nullptr;
      }
      EVP_PKEY_assign_EC_KEY(ret.get(), ec_key.release());
      return ret;
    }
    case EVP_PKEY_DSA: {
      bssl::UniquePtr<DSA> dsa(DSA_parse_private_key(cbs));
      if (dsa == nullptr) {
        return nullptr;
      }
      EVP_PKEY_assign_DSA(ret.get(), dsa.release());
      return ret;
    }
    case EVP_PKEY_RSA: {
      bssl::UniquePtr<RSA> rsa(RSA_parse_private_key(cbs));
      if (rsa == nullptr) {
        return nullptr;
      }
      EVP_PKEY_assign_RSA(ret.get(), rsa.release());
      return ret;
    }
    default:
      OPENSSL_PUT_ERROR(EVP, EVP_R_UNKNOWN_PUBLIC_KEY_TYPE);
      return nullptr;
  }
}

EVP_PKEY *d2i_PrivateKey(int type, EVP_PKEY **out, const uint8_t **inp,
                         long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [&](CBS *cbs) -> bssl::UniquePtr<EVP_PKEY> {
        // Parse with the legacy format.
        CBS copy = *cbs;
        bssl::UniquePtr<EVP_PKEY> ret = old_priv_decode(cbs, type);
        if (ret == nullptr) {
          // Try again with PKCS#8.
          ERR_clear_error();
          *cbs = copy;
          ret.reset(EVP_parse_private_key(cbs));
          if (ret == nullptr) {
            return nullptr;
          }
          if (EVP_PKEY_id(ret.get()) != type) {
            OPENSSL_PUT_ERROR(EVP, EVP_R_DIFFERENT_KEY_TYPES);
            return nullptr;
          }
        }
        return ret;
      });
}

// num_elements parses one SEQUENCE from |in| and returns the number of elements
// in it. On parse error, it returns zero.
static size_t num_elements(const uint8_t *in, size_t in_len) {
  CBS cbs, sequence;
  CBS_init(&cbs, in, (size_t)in_len);

  if (!CBS_get_asn1(&cbs, &sequence, CBS_ASN1_SEQUENCE)) {
    return 0;
  }

  size_t count = 0;
  while (CBS_len(&sequence) > 0) {
    if (!CBS_get_any_asn1_element(&sequence, nullptr, nullptr, nullptr)) {
      return 0;
    }

    count++;
  }

  return count;
}

EVP_PKEY *d2i_AutoPrivateKey(EVP_PKEY **out, const uint8_t **inp, long len) {
  if (len < 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }

  // Parse the input as a PKCS#8 PrivateKeyInfo.
  CBS cbs;
  CBS_init(&cbs, *inp, (size_t)len);
  EVP_PKEY *ret = EVP_parse_private_key(&cbs);
  if (ret != nullptr) {
    if (out != nullptr) {
      EVP_PKEY_free(*out);
      *out = ret;
    }
    *inp = CBS_data(&cbs);
    return ret;
  }
  ERR_clear_error();

  // Count the elements to determine the legacy key format.
  switch (num_elements(*inp, (size_t)len)) {
    case 4:
      return d2i_PrivateKey(EVP_PKEY_EC, out, inp, len);

    case 6:
      return d2i_PrivateKey(EVP_PKEY_DSA, out, inp, len);

    default:
      return d2i_PrivateKey(EVP_PKEY_RSA, out, inp, len);
  }
}

int i2d_PublicKey(const EVP_PKEY *key, uint8_t **outp) {
  switch (EVP_PKEY_id(key)) {
    case EVP_PKEY_RSA:
      return i2d_RSAPublicKey(EVP_PKEY_get0_RSA(key), outp);
    case EVP_PKEY_DSA:
      return i2d_DSAPublicKey(EVP_PKEY_get0_DSA(key), outp);
    case EVP_PKEY_EC:
      return i2o_ECPublicKey(EVP_PKEY_get0_EC_KEY(key), outp);
    default:
      OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_PUBLIC_KEY_TYPE);
      return -1;
  }
}

EVP_PKEY *d2i_PublicKey(int type, EVP_PKEY **out, const uint8_t **inp,
                        long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [&](CBS *cbs) -> bssl::UniquePtr<EVP_PKEY> {
        bssl::UniquePtr<EVP_PKEY> ret(EVP_PKEY_new());
        if (ret == nullptr) {
          return nullptr;
        }
        switch (type) {
          case EVP_PKEY_RSA: {
            bssl::UniquePtr<RSA> rsa(RSA_parse_public_key(cbs));
            if (rsa == nullptr) {
              return nullptr;
            }
            EVP_PKEY_assign_RSA(ret.get(), rsa.release());
            return ret;
          }

          // Unlike OpenSSL, we do not support EC keys with this API. The raw EC
          // public key serialization requires knowing the group. In OpenSSL,
          // calling this function with |EVP_PKEY_EC| and setting |out| to
          // nullptr does not work. It requires |*out| to include a
          // partially-initialized |EVP_PKEY| to extract the group.
          default:
            OPENSSL_PUT_ERROR(EVP, EVP_R_UNSUPPORTED_PUBLIC_KEY_TYPE);
            return nullptr;
        }
      });
}

EVP_PKEY *d2i_PUBKEY(EVP_PKEY **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, EVP_parse_public_key);
}

int i2d_PUBKEY(const EVP_PKEY *pkey, uint8_t **outp) {
  if (pkey == nullptr) {
    return 0;
  }
  return bssl::I2DFromCBB(
      /*initial_capacity=*/128, outp,
      [&](CBB *cbb) -> bool { return EVP_marshal_public_key(cbb, pkey); });
}

static bssl::UniquePtr<EVP_PKEY> parse_spki(
    CBS *cbs, bssl::Span<const EVP_PKEY_ALG *const> algs) {
  CBS spki;
  if (!CBS_get_asn1_element(cbs, &spki, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return nullptr;
  }
  return bssl::UniquePtr<EVP_PKEY>(EVP_PKEY_from_subject_public_key_info(
      CBS_data(&spki), CBS_len(&spki), algs.data(), algs.size()));
}

static bssl::UniquePtr<EVP_PKEY> parse_spki(CBS *cbs, const EVP_PKEY_ALG *alg) {
  return parse_spki(cbs, bssl::Span(&alg, 1));
}

RSA *d2i_RSA_PUBKEY(RSA **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<RSA> {
    bssl::UniquePtr<EVP_PKEY> pkey = parse_spki(cbs, EVP_pkey_rsa());
    if (pkey == nullptr) {
      return nullptr;
    }
    return bssl::UniquePtr<RSA>(EVP_PKEY_get1_RSA(pkey.get()));
  });
}

int i2d_RSA_PUBKEY(const RSA *rsa, uint8_t **outp) {
  if (rsa == nullptr) {
    return 0;
  }

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (pkey == nullptr ||
      !EVP_PKEY_set1_RSA(pkey.get(), const_cast<RSA *>(rsa))) {
    return -1;
  }

  return i2d_PUBKEY(pkey.get(), outp);
}

DSA *d2i_DSA_PUBKEY(DSA **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<DSA> {
    bssl::UniquePtr<EVP_PKEY> pkey = parse_spki(cbs, EVP_pkey_dsa());
    if (pkey == nullptr) {
      return nullptr;
    }
    return bssl::UniquePtr<DSA>(EVP_PKEY_get1_DSA(pkey.get()));
  });
}

int i2d_DSA_PUBKEY(const DSA *dsa, uint8_t **outp) {
  if (dsa == nullptr) {
    return 0;
  }

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (pkey == nullptr ||
      !EVP_PKEY_set1_DSA(pkey.get(), const_cast<DSA *>(dsa))) {
    return -1;
  }

  return i2d_PUBKEY(pkey.get(), outp);
}

EC_KEY *d2i_EC_PUBKEY(EC_KEY **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<EC_KEY> {
        const EVP_PKEY_ALG *const algs[] = {
            EVP_pkey_ec_p224(), EVP_pkey_ec_p256(), EVP_pkey_ec_p384(),
            EVP_pkey_ec_p521()};
        bssl::UniquePtr<EVP_PKEY> pkey = parse_spki(cbs, algs);
        if (pkey == nullptr) {
          return nullptr;
        }
        return bssl::UniquePtr<EC_KEY>(EVP_PKEY_get1_EC_KEY(pkey.get()));
      });
}

int i2d_EC_PUBKEY(const EC_KEY *ec_key, uint8_t **outp) {
  if (ec_key == nullptr) {
    return 0;
  }

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (pkey == nullptr ||
      !EVP_PKEY_set1_EC_KEY(pkey.get(), const_cast<EC_KEY *>(ec_key))) {
    return -1;
  }

  return i2d_PUBKEY(pkey.get(), outp);
}
