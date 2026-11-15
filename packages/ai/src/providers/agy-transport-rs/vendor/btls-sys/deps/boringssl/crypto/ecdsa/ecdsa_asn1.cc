// Copyright 2002-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ecdsa.h>

#include <limits.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../bytestring/internal.h"
#include "../fipsmodule/ecdsa/internal.h"
#include "../internal.h"


static ECDSA_SIG *ecdsa_sig_from_fixed(const EC_KEY *key, const uint8_t *in,
                                       size_t len) {
  const EC_GROUP *group = EC_KEY_get0_group(key);
  if (group == nullptr) {
    OPENSSL_PUT_ERROR(ECDSA, ERR_R_PASSED_NULL_PARAMETER);
    return nullptr;
  }
  size_t scalar_len = BN_num_bytes(EC_GROUP_get0_order(group));
  if (len != 2 * scalar_len) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_BAD_SIGNATURE);
    return nullptr;
  }
  ECDSA_SIG *ret = ECDSA_SIG_new();
  if (ret == nullptr || !BN_bin2bn(in, scalar_len, ret->r) ||
      !BN_bin2bn(in + scalar_len, scalar_len, ret->s)) {
    ECDSA_SIG_free(ret);
    return nullptr;
  }
  return ret;
}

static int ecdsa_sig_to_fixed(const EC_KEY *key, uint8_t *out, size_t *out_len,
                              size_t max_out, const ECDSA_SIG *sig) {
  const EC_GROUP *group = EC_KEY_get0_group(key);
  if (group == nullptr) {
    OPENSSL_PUT_ERROR(ECDSA, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }
  size_t scalar_len = BN_num_bytes(EC_GROUP_get0_order(group));
  if (max_out < 2 * scalar_len) {
    OPENSSL_PUT_ERROR(EC, EC_R_BUFFER_TOO_SMALL);
    return 0;
  }
  if (BN_is_negative(sig->r) || !BN_bn2bin_padded(out, scalar_len, sig->r) ||
      BN_is_negative(sig->s) ||
      !BN_bn2bin_padded(out + scalar_len, scalar_len, sig->s)) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_BAD_SIGNATURE);
    return 0;
  }
  *out_len = 2 * scalar_len;
  return 1;
}

int ECDSA_sign(int type, const uint8_t *digest, size_t digest_len, uint8_t *sig,
               unsigned int *out_sig_len, const EC_KEY *eckey) {
  if (eckey->ecdsa_meth && eckey->ecdsa_meth->sign) {
    return eckey->ecdsa_meth->sign(digest, digest_len, sig, out_sig_len,
                                   (EC_KEY *)eckey /* cast away const */);
  }

  *out_sig_len = 0;
  uint8_t fixed[ECDSA_MAX_FIXED_LEN];
  size_t fixed_len;
  if (!ecdsa_sign_fixed(digest, digest_len, fixed, &fixed_len, sizeof(fixed),
                        eckey)) {
    return 0;
  }

  // TODO(davidben): We can actually do better and go straight from the DER
  // format to the fixed-width format without a malloc.
  bssl::UniquePtr<ECDSA_SIG> s(ecdsa_sig_from_fixed(eckey, fixed, fixed_len));
  if (s == nullptr) {
    return 0;
  }

  CBB cbb;
  CBB_init_fixed(&cbb, sig, ECDSA_size(eckey));
  size_t len;
  if (!ECDSA_SIG_marshal(&cbb, s.get()) || !CBB_finish(&cbb, nullptr, &len)) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_ENCODE_ERROR);
    return 0;
  }
  *out_sig_len = static_cast<unsigned>(len);
  return 1;
}

int ECDSA_verify(int type, const uint8_t *digest, size_t digest_len,
                 const uint8_t *sig, size_t sig_len, const EC_KEY *eckey) {
  // Decode the ECDSA signature.
  //
  // TODO(davidben): We can actually do better and go straight from the DER
  // format to the fixed-width format without a malloc.
  int ret = 0;
  uint8_t *der = nullptr;
  bssl::UniquePtr<ECDSA_SIG> s(ECDSA_SIG_from_bytes(sig, sig_len));
  if (s == nullptr) {
    goto err;
  }

  // Defend against potential laxness in the DER parser.
  size_t der_len;
  if (!ECDSA_SIG_to_bytes(&der, &der_len, s.get()) || der_len != sig_len ||
      OPENSSL_memcmp(sig, der, sig_len) != 0) {
    // This should never happen. crypto/bytestring is strictly DER.
    OPENSSL_PUT_ERROR(ECDSA, ERR_R_INTERNAL_ERROR);
    goto err;
  }

  uint8_t fixed[ECDSA_MAX_FIXED_LEN];
  size_t fixed_len;
  ret = ecdsa_sig_to_fixed(eckey, fixed, &fixed_len, sizeof(fixed), s.get()) &&
        ecdsa_verify_fixed(digest, digest_len, fixed, fixed_len, eckey);

err:
  OPENSSL_free(der);
  return ret;
}


size_t ECDSA_size(const EC_KEY *key) {
  if (key == nullptr) {
    return 0;
  }

  const EC_GROUP *group = EC_KEY_get0_group(key);
  if (group == nullptr) {
    return 0;
  }

  size_t group_order_size = BN_num_bytes(EC_GROUP_get0_order(group));
  return ECDSA_SIG_max_len(group_order_size);
}

ECDSA_SIG *ECDSA_SIG_new(void) {
  ECDSA_SIG *sig =
      reinterpret_cast<ECDSA_SIG *>(OPENSSL_malloc(sizeof(ECDSA_SIG)));
  if (sig == nullptr) {
    return nullptr;
  }
  sig->r = BN_new();
  sig->s = BN_new();
  if (sig->r == nullptr || sig->s == nullptr) {
    ECDSA_SIG_free(sig);
    return nullptr;
  }
  return sig;
}

void ECDSA_SIG_free(ECDSA_SIG *sig) {
  if (sig == nullptr) {
    return;
  }

  BN_free(sig->r);
  BN_free(sig->s);
  OPENSSL_free(sig);
}

const BIGNUM *ECDSA_SIG_get0_r(const ECDSA_SIG *sig) { return sig->r; }

const BIGNUM *ECDSA_SIG_get0_s(const ECDSA_SIG *sig) { return sig->s; }

void ECDSA_SIG_get0(const ECDSA_SIG *sig, const BIGNUM **out_r,
                    const BIGNUM **out_s) {
  if (out_r != nullptr) {
    *out_r = sig->r;
  }
  if (out_s != nullptr) {
    *out_s = sig->s;
  }
}

int ECDSA_SIG_set0(ECDSA_SIG *sig, BIGNUM *r, BIGNUM *s) {
  if (r == nullptr || s == nullptr) {
    return 0;
  }
  BN_free(sig->r);
  BN_free(sig->s);
  sig->r = r;
  sig->s = s;
  return 1;
}

int ECDSA_do_verify(const uint8_t *digest, size_t digest_len,
                    const ECDSA_SIG *sig, const EC_KEY *eckey) {
  uint8_t fixed[ECDSA_MAX_FIXED_LEN];
  size_t fixed_len;
  return ecdsa_sig_to_fixed(eckey, fixed, &fixed_len, sizeof(fixed), sig) &&
         ecdsa_verify_fixed(digest, digest_len, fixed, fixed_len, eckey);
}

// This function is only exported for testing and is not called in production
// code.
ECDSA_SIG *ECDSA_sign_with_nonce_and_leak_private_key_for_testing(
    const uint8_t *digest, size_t digest_len, const EC_KEY *eckey,
    const uint8_t *nonce, size_t nonce_len) {
  uint8_t sig[ECDSA_MAX_FIXED_LEN];
  size_t sig_len;
  if (!ecdsa_sign_fixed_with_nonce_for_known_answer_test(
          digest, digest_len, sig, &sig_len, sizeof(sig), eckey, nonce,
          nonce_len)) {
    return nullptr;
  }

  return ecdsa_sig_from_fixed(eckey, sig, sig_len);
}

ECDSA_SIG *ECDSA_do_sign(const uint8_t *digest, size_t digest_len,
                         const EC_KEY *eckey) {
  uint8_t sig[ECDSA_MAX_FIXED_LEN];
  size_t sig_len;
  if (!ecdsa_sign_fixed(digest, digest_len, sig, &sig_len, sizeof(sig),
                        eckey)) {
    return nullptr;
  }

  return ecdsa_sig_from_fixed(eckey, sig, sig_len);
}

ECDSA_SIG *ECDSA_SIG_parse(CBS *cbs) {
  ECDSA_SIG *ret = ECDSA_SIG_new();
  if (ret == nullptr) {
    return nullptr;
  }
  CBS child;
  if (!CBS_get_asn1(cbs, &child, CBS_ASN1_SEQUENCE) ||
      !BN_parse_asn1_unsigned(&child, ret->r) ||
      !BN_parse_asn1_unsigned(&child, ret->s) || CBS_len(&child) != 0) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_BAD_SIGNATURE);
    ECDSA_SIG_free(ret);
    return nullptr;
  }
  return ret;
}

ECDSA_SIG *ECDSA_SIG_from_bytes(const uint8_t *in, size_t in_len) {
  CBS cbs;
  CBS_init(&cbs, in, in_len);
  ECDSA_SIG *ret = ECDSA_SIG_parse(&cbs);
  if (ret == nullptr || CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_BAD_SIGNATURE);
    ECDSA_SIG_free(ret);
    return nullptr;
  }
  return ret;
}

int ECDSA_SIG_marshal(CBB *cbb, const ECDSA_SIG *sig) {
  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_SEQUENCE) ||
      !BN_marshal_asn1(&child, sig->r) || !BN_marshal_asn1(&child, sig->s) ||
      !CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_ENCODE_ERROR);
    return 0;
  }
  return 1;
}

int ECDSA_SIG_to_bytes(uint8_t **out_bytes, size_t *out_len,
                       const ECDSA_SIG *sig) {
  CBB cbb;
  CBB_zero(&cbb);
  if (!CBB_init(&cbb, 0) || !ECDSA_SIG_marshal(&cbb, sig) ||
      !CBB_finish(&cbb, out_bytes, out_len)) {
    OPENSSL_PUT_ERROR(ECDSA, ECDSA_R_ENCODE_ERROR);
    CBB_cleanup(&cbb);
    return 0;
  }
  return 1;
}

// der_len_len returns the number of bytes needed to represent a length of |len|
// in DER.
static size_t der_len_len(size_t len) {
  if (len < 0x80) {
    return 1;
  }
  size_t ret = 1;
  while (len > 0) {
    ret++;
    len >>= 8;
  }
  return ret;
}

size_t ECDSA_SIG_max_len(size_t order_len) {
  // Compute the maximum length of an |order_len| byte integer. Defensively
  // assume that the leading 0x00 is included.
  size_t integer_len = 1 /* tag */ + der_len_len(order_len + 1) + 1 + order_len;
  if (integer_len < order_len) {
    return 0;
  }
  // An ECDSA signature is two INTEGERs.
  size_t value_len = 2 * integer_len;
  if (value_len < integer_len) {
    return 0;
  }
  // Add the header.
  size_t ret = 1 /* tag */ + der_len_len(value_len) + value_len;
  if (ret < value_len) {
    return 0;
  }
  return ret;
}

ECDSA_SIG *d2i_ECDSA_SIG(ECDSA_SIG **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, ECDSA_SIG_parse);
}

int i2d_ECDSA_SIG(const ECDSA_SIG *sig, uint8_t **outp) {
  return bssl::I2DFromCBB(
      /*initial_capacity=*/64, outp,
      [&](CBB *cbb) -> bool { return ECDSA_SIG_marshal(cbb, sig); });
}
