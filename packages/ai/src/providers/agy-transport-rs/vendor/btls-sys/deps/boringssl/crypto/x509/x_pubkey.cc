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

#include <limits.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/span.h>

#include "../asn1/internal.h"
#include "../bytestring/internal.h"
#include "../evp/internal.h"
#include "../internal.h"
#include "../mem_internal.h"
#include "internal.h"


void x509_pubkey_init(X509_PUBKEY *key) {
  OPENSSL_memset(key, 0, sizeof(X509_PUBKEY));
  x509_algor_init(&key->algor);
  asn1_string_init(&key->public_key, V_ASN1_BIT_STRING);
}

X509_PUBKEY *X509_PUBKEY_new(void) {
  bssl::UniquePtr<X509_PUBKEY> ret = bssl::MakeUnique<X509_PUBKEY>();
  if (ret == nullptr) {
    return nullptr;
  }
  x509_pubkey_init(ret.get());
  return ret.release();
}

void x509_pubkey_cleanup(X509_PUBKEY *key) {
  x509_algor_cleanup(&key->algor);
  asn1_string_cleanup(&key->public_key);
  EVP_PKEY_free(key->pkey);
}

void X509_PUBKEY_free(X509_PUBKEY *key) {
  if (key != nullptr) {
    x509_pubkey_cleanup(key);
    OPENSSL_free(key);
  }
}

static void x509_pubkey_changed(X509_PUBKEY *pub,
                                bssl::Span<const EVP_PKEY_ALG *const> algs) {
  EVP_PKEY_free(pub->pkey);
  pub->pkey = nullptr;

  // Re-encode the |X509_PUBKEY| to DER and parse it with EVP's APIs. If the
  // operation fails, clear errors. An |X509_PUBKEY| whose key we cannot parse
  // is still a valid SPKI. It just cannot be converted to an |EVP_PKEY|.
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 64) || !x509_marshal_public_key(cbb.get(), pub)) {
    ERR_clear_error();
    return;
  }
  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_from_subject_public_key_info(
      CBB_data(cbb.get()), CBB_len(cbb.get()), algs.data(), algs.size()));
  if (pkey == nullptr) {
    ERR_clear_error();
    return;
  }

  pub->pkey = pkey.release();
}

int x509_parse_public_key(CBS *cbs, X509_PUBKEY *out,
                          bssl::Span<const EVP_PKEY_ALG *const> algs) {
  CBS seq;
  if (!CBS_get_asn1(cbs, &seq, CBS_ASN1_SEQUENCE) ||
      !x509_parse_algorithm(&seq, &out->algor) ||
      !asn1_parse_bit_string(&seq, &out->public_key, /*tag=*/0) ||
      CBS_len(&seq) != 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  x509_pubkey_changed(out, algs);
  return 1;
}

static int x509_parse_public_key_default(CBS *cbs, X509_PUBKEY *out) {
  return x509_parse_public_key(cbs, out, bssl::GetDefaultEVPAlgorithms());
}

int x509_marshal_public_key(CBB *cbb, const X509_PUBKEY *in) {
  CBB seq;
  return CBB_add_asn1(cbb, &seq, CBS_ASN1_SEQUENCE) &&
         x509_marshal_algorithm(&seq, &in->algor) &&
         asn1_marshal_bit_string(&seq, &in->public_key, /*tag=*/0) &&
         CBB_flush(cbb);
}

X509_PUBKEY *d2i_X509_PUBKEY(X509_PUBKEY **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<X509_PUBKEY> {
        bssl::UniquePtr<X509_PUBKEY> ret(X509_PUBKEY_new());
        if (ret == nullptr || !x509_parse_public_key_default(cbs, ret.get())) {
          return nullptr;
        }
        return ret;
      });
}

int i2d_X509_PUBKEY(const X509_PUBKEY *key, uint8_t **outp) {
  return bssl::I2DFromCBB(/*initial_capacity=*/32, outp, [&](CBB *cbb) -> bool {
    return x509_marshal_public_key(cbb, key);
  });
}

// TODO(crbug.com/42290417): Remove this when |X509| and |X509_REQ| no longer
// depend on the tables.
IMPLEMENT_EXTERN_ASN1_SIMPLE(X509_PUBKEY, X509_PUBKEY_new, X509_PUBKEY_free,
                             CBS_ASN1_SEQUENCE, x509_parse_public_key_default,
                             i2d_X509_PUBKEY)

int x509_pubkey_set1(X509_PUBKEY *key, EVP_PKEY *pkey) {
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 64) ||
      !EVP_marshal_public_key(cbb.get(), pkey)) {
    OPENSSL_PUT_ERROR(X509, X509_R_PUBLIC_KEY_ENCODE_ERROR);
    return 0;
  }

  CBS cbs;
  CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
  // TODO(crbug.com/42290364): Use an |EVP_PKEY_ALG| derived from |pkey|.
  // |X509_PUBKEY_get0| does not currently work when setting, say, an
  // |EVP_PKEY_RSA_PSS| key.
  return x509_parse_public_key(&cbs, key, bssl::GetDefaultEVPAlgorithms());
}

int X509_PUBKEY_set(X509_PUBKEY **x, EVP_PKEY *pkey) {
  bssl::UniquePtr<X509_PUBKEY> new_key(X509_PUBKEY_new());
  if (new_key == nullptr || !x509_pubkey_set1(new_key.get(), pkey)) {
    return 0;
  }
  X509_PUBKEY_free(*x);
  *x = new_key.release();
  return 1;
}

EVP_PKEY *X509_PUBKEY_get0(const X509_PUBKEY *key) {
  if (key == nullptr) {
    return nullptr;
  }

  if (key->pkey == nullptr) {
    OPENSSL_PUT_ERROR(X509, X509_R_PUBLIC_KEY_DECODE_ERROR);
    return nullptr;
  }

  return key->pkey;
}

EVP_PKEY *X509_PUBKEY_get(const X509_PUBKEY *key) {
  EVP_PKEY *pkey = X509_PUBKEY_get0(key);
  if (pkey != nullptr) {
    EVP_PKEY_up_ref(pkey);
  }
  return pkey;
}

int X509_PUBKEY_set0_param(X509_PUBKEY *pub, ASN1_OBJECT *obj, int param_type,
                           void *param_value, uint8_t *key, int key_len) {
  if (!X509_ALGOR_set0(&pub->algor, obj, param_type, param_value)) {
    return 0;
  }

  ASN1_STRING_set0(&pub->public_key, key, key_len);
  // Set the number of unused bits to zero.
  pub->public_key.flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);
  pub->public_key.flags |= ASN1_STRING_FLAG_BITS_LEFT;

  x509_pubkey_changed(pub, bssl::GetDefaultEVPAlgorithms());
  return 1;
}

int X509_PUBKEY_get0_param(ASN1_OBJECT **out_obj, const uint8_t **out_key,
                           int *out_key_len, X509_ALGOR **out_alg,
                           X509_PUBKEY *pub) {
  if (out_obj != nullptr) {
    *out_obj = pub->algor.algorithm;
  }
  if (out_key != nullptr) {
    *out_key = pub->public_key.data;
    *out_key_len = pub->public_key.length;
  }
  if (out_alg != nullptr) {
    *out_alg = &pub->algor;
  }
  return 1;
}

const ASN1_BIT_STRING *X509_PUBKEY_get0_public_key(const X509_PUBKEY *pub) {
  return &pub->public_key;
}
