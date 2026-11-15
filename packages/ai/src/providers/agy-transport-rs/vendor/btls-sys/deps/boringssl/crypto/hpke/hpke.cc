// Copyright 2020 The BoringSSL Authors
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

#include <openssl/hpke.h>

#include <assert.h>
#include <string.h>

#include <openssl/aead.h>
#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/digest.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/evp_errors.h>
#include <openssl/hkdf.h>
#include <openssl/mem.h>
#include <openssl/mlkem.h>
#include <openssl/rand.h>
#include <openssl/sha2.h>
#include <openssl/xwing.h>

#include "../fipsmodule/bcm_interface.h"
#include "../fipsmodule/ec/internal.h"
#include "../internal.h"


// This file implements RFC 9180.

#define MAX_SEED_LEN XWING_SEED_LEN
#define MAX_SHARED_SECRET_LEN SHA256_DIGEST_LENGTH

struct evp_hpke_kem_st {
  uint16_t id;
  size_t public_key_len;
  size_t private_key_len;
  size_t seed_len;
  size_t enc_len;
  int (*init_key)(EVP_HPKE_KEY *key, const uint8_t *priv_key,
                  size_t priv_key_len);
  int (*generate_key)(EVP_HPKE_KEY *key);
  int (*encap_with_seed)(const EVP_HPKE_KEM *kem, uint8_t *out_shared_secret,
                         size_t *out_shared_secret_len, uint8_t *out_enc,
                         size_t *out_enc_len, size_t max_enc,
                         const uint8_t *peer_public_key,
                         size_t peer_public_key_len, const uint8_t *seed,
                         size_t seed_len);
  int (*decap)(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
               size_t *out_shared_secret_len, const uint8_t *enc,
               size_t enc_len);
  int (*auth_encap_with_seed)(const EVP_HPKE_KEY *key,
                              uint8_t *out_shared_secret,
                              size_t *out_shared_secret_len, uint8_t *out_enc,
                              size_t *out_enc_len, size_t max_enc,
                              const uint8_t *peer_public_key,
                              size_t peer_public_key_len, const uint8_t *seed,
                              size_t seed_len);
  int (*auth_decap)(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                    size_t *out_shared_secret_len, const uint8_t *enc,
                    size_t enc_len, const uint8_t *peer_public_key,
                    size_t peer_public_key_len);
};

struct evp_hpke_kdf_st {
  uint16_t id;
  // We only support HKDF-based KDFs.
  const EVP_MD *(*hkdf_md_func)(void);
};

struct evp_hpke_aead_st {
  uint16_t id;
  const EVP_AEAD *(*aead_func)(void);
};


// Low-level labeled KDF functions.

static const char kHpkeVersionId[] = "HPKE-v1";

static int add_label_string(CBB *cbb, const char *label) {
  return CBB_add_bytes(cbb, (const uint8_t *)label, strlen(label));
}

static int hpke_labeled_extract(const EVP_MD *hkdf_md, uint8_t *out_key,
                                size_t *out_len, const uint8_t *salt,
                                size_t salt_len, const uint8_t *suite_id,
                                size_t suite_id_len, const char *label,
                                const uint8_t *ikm, size_t ikm_len) {
  // labeledIKM = concat("HPKE-v1", suite_id, label, IKM)
  CBB labeled_ikm;
  int ok = CBB_init(&labeled_ikm, 0) &&
           add_label_string(&labeled_ikm, kHpkeVersionId) &&
           CBB_add_bytes(&labeled_ikm, suite_id, suite_id_len) &&
           add_label_string(&labeled_ikm, label) &&
           CBB_add_bytes(&labeled_ikm, ikm, ikm_len) &&
           HKDF_extract(out_key, out_len, hkdf_md, CBB_data(&labeled_ikm),
                        CBB_len(&labeled_ikm), salt, salt_len);
  CBB_cleanup(&labeled_ikm);
  return ok;
}

static int hpke_labeled_expand(const EVP_MD *hkdf_md, uint8_t *out_key,
                               size_t out_len, const uint8_t *prk,
                               size_t prk_len, const uint8_t *suite_id,
                               size_t suite_id_len, const char *label,
                               const uint8_t *info, size_t info_len) {
  // labeledInfo = concat(I2OSP(L, 2), "HPKE-v1", suite_id, label, info)
  CBB labeled_info;
  int ok = CBB_init(&labeled_info, 0) &&  //
           CBB_add_u16(&labeled_info, out_len) &&
           add_label_string(&labeled_info, kHpkeVersionId) &&
           CBB_add_bytes(&labeled_info, suite_id, suite_id_len) &&
           add_label_string(&labeled_info, label) &&
           CBB_add_bytes(&labeled_info, info, info_len) &&
           HKDF_expand(out_key, out_len, hkdf_md, prk, prk_len,
                       CBB_data(&labeled_info), CBB_len(&labeled_info));
  CBB_cleanup(&labeled_info);
  return ok;
}


// KEM implementations.

// dhkem_extract_and_expand implements the ExtractAndExpand operation in the
// DHKEM construction. See section 4.1 of RFC 9180.
static int dhkem_extract_and_expand(uint16_t kem_id, const EVP_MD *hkdf_md,
                                    uint8_t *out_key, size_t out_len,
                                    const uint8_t *dh, size_t dh_len,
                                    const uint8_t *kem_context,
                                    size_t kem_context_len) {
  // concat("KEM", I2OSP(kem_id, 2))
  uint8_t suite_id[5] = {'K', 'E', 'M', static_cast<uint8_t>(kem_id >> 8),
                         static_cast<uint8_t>(kem_id & 0xff)};
  uint8_t prk[EVP_MAX_MD_SIZE];
  size_t prk_len;
  return hpke_labeled_extract(hkdf_md, prk, &prk_len, nullptr, 0, suite_id,
                              sizeof(suite_id), "eae_prk", dh, dh_len) &&
         hpke_labeled_expand(hkdf_md, out_key, out_len, prk, prk_len, suite_id,
                             sizeof(suite_id), "shared_secret", kem_context,
                             kem_context_len);
}

static int x25519_init_key(EVP_HPKE_KEY *key, const uint8_t *priv_key,
                           size_t priv_key_len) {
  if (priv_key_len != X25519_PRIVATE_KEY_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  OPENSSL_memcpy(key->private_key, priv_key, priv_key_len);
  X25519_public_from_private(key->public_key, priv_key);
  return 1;
}

static int x25519_generate_key(EVP_HPKE_KEY *key) {
  X25519_keypair(key->public_key, key->private_key);
  return 1;
}

static int x25519_encap_with_seed(
    const EVP_HPKE_KEM *kem, uint8_t *out_shared_secret,
    size_t *out_shared_secret_len, uint8_t *out_enc, size_t *out_enc_len,
    size_t max_enc, const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *seed, size_t seed_len) {
  if (max_enc < X25519_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  if (seed_len != X25519_PRIVATE_KEY_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }
  X25519_public_from_private(out_enc, seed);

  uint8_t dh[X25519_SHARED_KEY_LEN];
  if (peer_public_key_len != X25519_PUBLIC_VALUE_LEN ||
      !X25519(dh, seed, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[2 * X25519_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, out_enc, X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + X25519_PUBLIC_VALUE_LEN, peer_public_key,
                 X25519_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_enc_len = X25519_PUBLIC_VALUE_LEN;
  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int x25519_decap(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                        size_t *out_shared_secret_len, const uint8_t *enc,
                        size_t enc_len) {
  uint8_t dh[X25519_SHARED_KEY_LEN];
  if (enc_len != X25519_PUBLIC_VALUE_LEN ||
      !X25519(dh, key->private_key, enc)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[2 * X25519_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, enc, X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + X25519_PUBLIC_VALUE_LEN, key->public_key,
                 X25519_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int x25519_auth_encap_with_seed(
    const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
    size_t *out_shared_secret_len, uint8_t *out_enc, size_t *out_enc_len,
    size_t max_enc, const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *seed, size_t seed_len) {
  if (max_enc < X25519_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  if (seed_len != X25519_PRIVATE_KEY_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }
  X25519_public_from_private(out_enc, seed);

  uint8_t dh[2 * X25519_SHARED_KEY_LEN];
  if (peer_public_key_len != X25519_PUBLIC_VALUE_LEN ||
      !X25519(dh, seed, peer_public_key) ||
      !X25519(dh + X25519_SHARED_KEY_LEN, key->private_key, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[3 * X25519_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, out_enc, X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + X25519_PUBLIC_VALUE_LEN, peer_public_key,
                 X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + 2 * X25519_PUBLIC_VALUE_LEN, key->public_key,
                 X25519_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_enc_len = X25519_PUBLIC_VALUE_LEN;
  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int x25519_auth_decap(const EVP_HPKE_KEY *key,
                             uint8_t *out_shared_secret,
                             size_t *out_shared_secret_len, const uint8_t *enc,
                             size_t enc_len, const uint8_t *peer_public_key,
                             size_t peer_public_key_len) {
  uint8_t dh[2 * X25519_SHARED_KEY_LEN];
  if (enc_len != X25519_PUBLIC_VALUE_LEN ||
      peer_public_key_len != X25519_PUBLIC_VALUE_LEN ||
      !X25519(dh, key->private_key, enc) ||
      !X25519(dh + X25519_SHARED_KEY_LEN, key->private_key, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[3 * X25519_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, enc, X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + X25519_PUBLIC_VALUE_LEN, key->public_key,
                 X25519_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + 2 * X25519_PUBLIC_VALUE_LEN, peer_public_key,
                 X25519_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

const EVP_HPKE_KEM *EVP_hpke_x25519_hkdf_sha256(void) {
  static const EVP_HPKE_KEM kKEM = {
      /*id=*/EVP_HPKE_DHKEM_X25519_HKDF_SHA256,
      /*public_key_len=*/X25519_PUBLIC_VALUE_LEN,
      /*private_key_len=*/X25519_PRIVATE_KEY_LEN,
      /*seed_len=*/X25519_PRIVATE_KEY_LEN,
      /*enc_len=*/X25519_PUBLIC_VALUE_LEN,
      x25519_init_key,
      x25519_generate_key,
      x25519_encap_with_seed,
      x25519_decap,
      x25519_auth_encap_with_seed,
      x25519_auth_decap,
  };
  return &kKEM;
}

#define P256_PRIVATE_KEY_LEN 32
#define P256_PUBLIC_KEY_LEN 65
#define P256_PUBLIC_VALUE_LEN 65
#define P256_SEED_LEN 32
#define P256_SHARED_KEY_LEN 32

static int p256_public_from_private(uint8_t out_pub[P256_PUBLIC_VALUE_LEN],
                                    const uint8_t priv[P256_PRIVATE_KEY_LEN]) {
  const EC_GROUP *const group = EC_group_p256();
  const uint8_t kAllZeros[P256_PRIVATE_KEY_LEN] = {0};
  EC_SCALAR private_scalar;
  EC_JACOBIAN public_point;
  EC_AFFINE public_point_affine;

  if (CRYPTO_memcmp(kAllZeros, priv, sizeof(kAllZeros)) == 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  if (!ec_scalar_from_bytes(group, &private_scalar, priv,
                            P256_PRIVATE_KEY_LEN) ||
      !ec_point_mul_scalar_base(group, &public_point, &private_scalar) ||
      !ec_jacobian_to_affine(group, &public_point_affine, &public_point)) {
    return 0;
  }

  size_t out_len_x, out_len_y;
  out_pub[0] = POINT_CONVERSION_UNCOMPRESSED;
  ec_felem_to_bytes(group, &out_pub[1], &out_len_x, &public_point_affine.X);
  ec_felem_to_bytes(group, &out_pub[33], &out_len_y, &public_point_affine.Y);
  return 1;
}

static int p256_init_key(EVP_HPKE_KEY *key, const uint8_t *priv_key,
                         size_t priv_key_len) {
  if (priv_key_len != P256_PRIVATE_KEY_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  if (!p256_public_from_private(key->public_key, priv_key)) {
    return 0;
  }

  OPENSSL_memcpy(key->private_key, priv_key, priv_key_len);
  return 1;
}

static int p256_private_key_from_seed(uint8_t out_priv[P256_PRIVATE_KEY_LEN],
                                      const uint8_t seed[P256_SEED_LEN]) {
  // https://www.rfc-editor.org/rfc/rfc9180.html#name-derivekeypair
  const uint8_t suite_id[5] = {'K', 'E', 'M',
                               EVP_HPKE_DHKEM_P256_HKDF_SHA256 >> 8,
                               EVP_HPKE_DHKEM_P256_HKDF_SHA256 & 0xff};

  uint8_t dkp_prk[32];
  size_t dkp_prk_len;
  if (!hpke_labeled_extract(EVP_sha256(), dkp_prk, &dkp_prk_len, nullptr, 0,
                            suite_id, sizeof(suite_id), "dkp_prk", seed,
                            P256_SEED_LEN)) {
    return 0;
  }
  assert(dkp_prk_len == sizeof(dkp_prk));

  const EC_GROUP *const group = EC_group_p256();
  EC_SCALAR private_scalar;

  for (unsigned counter = 0; counter < 256; counter++) {
    const uint8_t counter_byte = counter & 0xff;
    if (!hpke_labeled_expand(EVP_sha256(), out_priv, P256_PRIVATE_KEY_LEN,
                             dkp_prk, sizeof(dkp_prk), suite_id,
                             sizeof(suite_id), "candidate", &counter_byte,
                             sizeof(counter_byte))) {
      return 0;
    }

    // This checks that the scalar is less than the order.
    if (ec_scalar_from_bytes(group, &private_scalar, out_priv,
                             P256_PRIVATE_KEY_LEN)) {
      return 1;
    }
  }

  // This happens with probability of 2^-(32*256).
  OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
  return 0;
}

static int p256_generate_key(EVP_HPKE_KEY *key) {
  uint8_t seed[P256_SEED_LEN];
  RAND_bytes(seed, sizeof(seed));
  if (!p256_private_key_from_seed(key->private_key, seed) ||
      !p256_public_from_private(key->public_key, key->private_key)) {
    return 0;
  }
  return 1;
}

static int p256(uint8_t out_dh[P256_SHARED_KEY_LEN],
                const uint8_t my_private[P256_PRIVATE_KEY_LEN],
                const uint8_t their_public[P256_PUBLIC_VALUE_LEN]) {
  const EC_GROUP *const group = EC_group_p256();
  EC_SCALAR private_scalar;
  EC_FELEM x, y;
  EC_JACOBIAN shared_point, their_point;
  EC_AFFINE their_point_affine, shared_point_affine;

  if (their_public[0] != POINT_CONVERSION_UNCOMPRESSED ||
      !ec_felem_from_bytes(group, &x, &their_public[1], 32) ||
      !ec_felem_from_bytes(group, &y, &their_public[33], 32) ||
      !ec_point_set_affine_coordinates(group, &their_point_affine, &x, &y) ||
      !ec_scalar_from_bytes(group, &private_scalar, my_private,
                            P256_PRIVATE_KEY_LEN)) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
    return 0;
  }

  ec_affine_to_jacobian(group, &their_point, &their_point_affine);
  if (!ec_point_mul_scalar(group, &shared_point, &their_point,
                           &private_scalar) ||
      !ec_jacobian_to_affine(group, &shared_point_affine, &shared_point)) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
    return 0;
  }

  size_t out_len;
  ec_felem_to_bytes(group, out_dh, &out_len, &shared_point_affine.X);
  assert(out_len == P256_SHARED_KEY_LEN);
  return 1;
}

static int p256_encap_with_seed(const EVP_HPKE_KEM *kem,
                                uint8_t *out_shared_secret,
                                size_t *out_shared_secret_len, uint8_t *out_enc,
                                size_t *out_enc_len, size_t max_enc,
                                const uint8_t *peer_public_key,
                                size_t peer_public_key_len, const uint8_t *seed,
                                size_t seed_len) {
  if (max_enc < P256_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  if (seed_len != P256_SEED_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }
  uint8_t private_key[P256_PRIVATE_KEY_LEN];
  if (!p256_private_key_from_seed(private_key, seed)) {
    return 0;
  }
  p256_public_from_private(out_enc, private_key);

  uint8_t dh[P256_SHARED_KEY_LEN];
  if (peer_public_key_len != P256_PUBLIC_VALUE_LEN ||
      !p256(dh, private_key, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[2 * P256_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, out_enc, P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + P256_PUBLIC_VALUE_LEN, peer_public_key,
                 P256_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_enc_len = P256_PUBLIC_VALUE_LEN;
  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int p256_decap(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                      size_t *out_shared_secret_len, const uint8_t *enc,
                      size_t enc_len) {
  uint8_t dh[P256_SHARED_KEY_LEN];
  if (enc_len != P256_PUBLIC_VALUE_LEN ||  //
      !p256(dh, key->private_key, enc)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[2 * P256_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, enc, P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + P256_PUBLIC_VALUE_LEN, key->public_key,
                 P256_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int p256_auth_encap_with_seed(
    const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
    size_t *out_shared_secret_len, uint8_t *out_enc, size_t *out_enc_len,
    size_t max_enc, const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *seed, size_t seed_len) {
  if (max_enc < P256_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  if (seed_len != P256_SEED_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }
  uint8_t private_key[P256_PRIVATE_KEY_LEN];
  if (!p256_private_key_from_seed(private_key, seed)) {
    return 0;
  }
  p256_public_from_private(out_enc, private_key);

  uint8_t dh[2 * P256_SHARED_KEY_LEN];
  if (peer_public_key_len != P256_PUBLIC_VALUE_LEN ||
      !p256(dh, private_key, peer_public_key) ||
      !p256(dh + P256_SHARED_KEY_LEN, key->private_key, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[3 * P256_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, out_enc, P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + P256_PUBLIC_VALUE_LEN, peer_public_key,
                 P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + 2 * P256_PUBLIC_VALUE_LEN, key->public_key,
                 P256_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_enc_len = P256_PUBLIC_VALUE_LEN;
  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

static int p256_auth_decap(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                           size_t *out_shared_secret_len, const uint8_t *enc,
                           size_t enc_len, const uint8_t *peer_public_key,
                           size_t peer_public_key_len) {
  uint8_t dh[2 * P256_SHARED_KEY_LEN];
  if (enc_len != P256_PUBLIC_VALUE_LEN ||
      peer_public_key_len != P256_PUBLIC_VALUE_LEN ||
      !p256(dh, key->private_key, enc) ||
      !p256(dh + P256_SHARED_KEY_LEN, key->private_key, peer_public_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_PEER_KEY);
    return 0;
  }

  uint8_t kem_context[3 * P256_PUBLIC_VALUE_LEN];
  OPENSSL_memcpy(kem_context, enc, P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + P256_PUBLIC_VALUE_LEN, key->public_key,
                 P256_PUBLIC_VALUE_LEN);
  OPENSSL_memcpy(kem_context + 2 * P256_PUBLIC_VALUE_LEN, peer_public_key,
                 P256_PUBLIC_VALUE_LEN);
  if (!dhkem_extract_and_expand(key->kem->id, EVP_sha256(), out_shared_secret,
                                SHA256_DIGEST_LENGTH, dh, sizeof(dh),
                                kem_context, sizeof(kem_context))) {
    return 0;
  }

  *out_shared_secret_len = SHA256_DIGEST_LENGTH;
  return 1;
}

const EVP_HPKE_KEM *EVP_hpke_p256_hkdf_sha256(void) {
  static const EVP_HPKE_KEM kKEM = {
      /*id=*/EVP_HPKE_DHKEM_P256_HKDF_SHA256,
      /*public_key_len=*/P256_PUBLIC_KEY_LEN,
      /*private_key_len=*/P256_PRIVATE_KEY_LEN,
      /*seed_len=*/P256_SEED_LEN,
      /*enc_len=*/P256_PUBLIC_VALUE_LEN,
      p256_init_key,
      p256_generate_key,
      p256_encap_with_seed,
      p256_decap,
      p256_auth_encap_with_seed,
      p256_auth_decap,
  };
  return &kKEM;
}

#define XWING_PRIVATE_KEY_LEN XWING_PRIVATE_KEY_BYTES
#define XWING_PUBLIC_KEY_LEN XWING_PUBLIC_KEY_BYTES
#define XWING_PUBLIC_VALUE_LEN XWING_CIPHERTEXT_BYTES
#define XWING_SEED_LEN 64
#define XWING_SHARED_KEY_LEN XWING_SHARED_SECRET_BYTES

static int xwing_init_key(EVP_HPKE_KEY *key, const uint8_t *priv_key,
                          size_t priv_key_len) {
  CBS cbs;
  CBS_init(&cbs, priv_key, priv_key_len);
  XWING_private_key private_key;
  if (!XWING_parse_private_key(&private_key, &cbs) || CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  if (!XWING_public_from_private(key->public_key, &private_key)) {
    return 0;
  }

  if (priv_key_len > sizeof(key->private_key)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }
  OPENSSL_memcpy(key->private_key, priv_key, priv_key_len);
  return 1;
}

static int xwing_generate_key(EVP_HPKE_KEY *key) {
  XWING_private_key private_key;
  if (!XWING_generate_key(key->public_key, &private_key)) {
    return 0;
  }

  CBB cbb;
  CBB_init_fixed(&cbb, key->private_key, XWING_PRIVATE_KEY_LEN);
  if (!XWING_marshal_private_key(&cbb, &private_key) ||
      CBB_len(&cbb) != XWING_PRIVATE_KEY_LEN) {
    return 0;
  }

  return 1;
}

static int xwing_encap_with_seed(const EVP_HPKE_KEM *kem,
                                 uint8_t *out_shared_secret,
                                 size_t *out_shared_secret_len,
                                 uint8_t *out_enc, size_t *out_enc_len,
                                 size_t max_enc, const uint8_t *peer_public_key,
                                 size_t peer_public_key_len,
                                 const uint8_t *seed, size_t seed_len) {
  if (max_enc < XWING_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  if (peer_public_key_len != XWING_PUBLIC_KEY_LEN ||
      seed_len != XWING_SEED_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  if (!XWING_encap_external_entropy(out_enc, out_shared_secret, peer_public_key,
                                    seed)) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
    return 0;
  }

  *out_enc_len = XWING_PUBLIC_VALUE_LEN;
  *out_shared_secret_len = XWING_SHARED_KEY_LEN;
  return 1;
}

static int xwing_decap(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                       size_t *out_shared_secret_len, const uint8_t *enc,
                       size_t enc_len) {
  if (enc_len != XWING_PUBLIC_VALUE_LEN) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  CBS cbs;
  CBS_init(&cbs, key->private_key, XWING_PRIVATE_KEY_LEN);
  XWING_private_key private_key;
  if (!XWING_parse_private_key(&private_key, &cbs)) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
    return 0;
  }

  if (!XWING_decap(out_shared_secret, enc, &private_key)) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
    return 0;
  }

  *out_shared_secret_len = XWING_SHARED_KEY_LEN;
  return 1;
}

const EVP_HPKE_KEM *EVP_hpke_xwing(void) {
  static const EVP_HPKE_KEM kKEM = {
      /*id=*/EVP_HPKE_XWING,
      /*public_key_len=*/XWING_PUBLIC_KEY_LEN,
      /*private_key_len=*/XWING_PRIVATE_KEY_LEN,
      /*seed_len=*/XWING_SEED_LEN,
      /*enc_len=*/XWING_PUBLIC_VALUE_LEN,
      xwing_init_key,
      xwing_generate_key,
      xwing_encap_with_seed,
      xwing_decap,
      // X-Wing doesn't support authenticated encapsulation/decapsulation:
      // https://datatracker.ietf.org/doc/html/draft-connolly-cfrg-xwing-kem-08#name-use-in-hpke
      /* auth_encap_with_seed= */ nullptr,
      /* auth_decap= */ nullptr,
  };
  return &kKEM;
}

namespace {

template <uint16_t KEM_ID, size_t PUBLIC_KEY_BYTES, size_t CIPHERTEXT_BYTES,
          size_t ENCAP_ENTROPY_BYTES,

          typename PrivateKey, typename PublicKey,

          int (*PrivateKeyFromSeed)(PrivateKey *, const uint8_t *, size_t),
          void (*PublicFromPrivate)(PublicKey *, const PrivateKey *),
          int (*MarshalPublicKey)(CBB *, const PublicKey *),
          void (*GenerateKey)(uint8_t *, uint8_t *, PrivateKey *),
          int (*ParsePublicKey)(PublicKey *, CBS *),
          bcm_infallible (*BCMEncapExternalEntropy)(
              uint8_t *, uint8_t *, const PublicKey *, const uint8_t *),
          int (*Decap)(uint8_t *, const uint8_t *, size_t, const PrivateKey *)>
struct MLKEMHPKE {
  // These sizes are common across both ML-KEM-768 and ML-KEM-1024.
  static constexpr size_t PRIVATE_KEY_LEN = MLKEM_SEED_BYTES;
  static constexpr size_t SHARED_KEY_LEN = MLKEM_SHARED_SECRET_BYTES;

  static constexpr uint16_t ID = KEM_ID;
  static constexpr size_t PUBLIC_KEY_LEN = PUBLIC_KEY_BYTES;
  static constexpr size_t SEED_LEN = ENCAP_ENTROPY_BYTES;
  static constexpr size_t ENC_LEN = CIPHERTEXT_BYTES;

  static int InitKey(EVP_HPKE_KEY *key, const uint8_t *priv_key,
                     size_t priv_key_len) {
    PrivateKey expanded_private_key;
    if (!PrivateKeyFromSeed(&expanded_private_key, priv_key, priv_key_len)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }
    PublicKey public_key;
    PublicFromPrivate(&public_key, &expanded_private_key);
    CBB cbb;
    static_assert(sizeof(key->public_key) >= PUBLIC_KEY_BYTES,
                  "EVP_HPKE_KEY public_key is too small for ML-KEM.");
    if (!CBB_init_fixed(&cbb, key->public_key, PUBLIC_KEY_BYTES) ||
        !MarshalPublicKey(&cbb, &public_key)) {
      return 0;
    }

    static_assert(sizeof(key->private_key) >= PRIVATE_KEY_LEN,
                  "EVP_HPKE_KEY private_key is too small for ML-KEM");
    OPENSSL_memcpy(key->private_key, priv_key, priv_key_len);
    return 1;
  }

  static int HpkeGenerateKey(EVP_HPKE_KEY *key) {
    static_assert(sizeof(key->public_key) >= PUBLIC_KEY_BYTES,
                  "EVP_HPKE_KEY public_key is too small for ML-KEM.");
    static_assert(sizeof(key->private_key) >= PRIVATE_KEY_LEN,
                  "EVP_HPKE_KEY private_key is too small for ML-KEM");
    PrivateKey expanded_private_key;
    GenerateKey(key->public_key, key->private_key, &expanded_private_key);

    return 1;
  }

  static int EncapWithSeed(const EVP_HPKE_KEM *kem, uint8_t *out_shared_secret,
                           size_t *out_shared_secret_len, uint8_t *out_enc,
                           size_t *out_enc_len, size_t max_enc,
                           const uint8_t *peer_public_key,
                           size_t peer_public_key_len, const uint8_t *seed,
                           size_t seed_len) {
    if (max_enc < CIPHERTEXT_BYTES) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
      return 0;
    }
    if (peer_public_key_len != PUBLIC_KEY_BYTES ||
        seed_len != ENCAP_ENTROPY_BYTES) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }

    CBS cbs;
    CBS_init(&cbs, peer_public_key, peer_public_key_len);
    PublicKey public_key;
    if (!ParsePublicKey(&public_key, &cbs)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }
    // The public ML-KEM interface doesn't support providing the encap entropy
    // so the BCM function is used here.
    BCMEncapExternalEntropy(out_enc, out_shared_secret, &public_key, seed);

    *out_enc_len = CIPHERTEXT_BYTES;
    *out_shared_secret_len = SHARED_KEY_LEN;
    return 1;
  }

  static int HpkeDecap(const EVP_HPKE_KEY *key, uint8_t *out_shared_secret,
                       size_t *out_shared_secret_len, const uint8_t *enc,
                       size_t enc_len) {
    PrivateKey private_key;
    if (!PrivateKeyFromSeed(&private_key, key->private_key, PRIVATE_KEY_LEN)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }

    if (!Decap(out_shared_secret, enc, enc_len, &private_key)) {
      OPENSSL_PUT_ERROR(EVP, ERR_R_INTERNAL_ERROR);
      return 0;
    }

    *out_shared_secret_len = SHARED_KEY_LEN;
    return 1;
  }
};

using MLKEM768HPKE =
    MLKEMHPKE<EVP_HPKE_MLKEM768, MLKEM768_PUBLIC_KEY_BYTES,
              MLKEM768_CIPHERTEXT_BYTES, BCM_MLKEM_ENCAP_ENTROPY,

              MLKEM768_private_key, MLKEM768_public_key,

              MLKEM768_private_key_from_seed, MLKEM768_public_from_private,
              MLKEM768_marshal_public_key, MLKEM768_generate_key,
              MLKEM768_parse_public_key, BCM_mlkem768_encap_external_entropy,
              MLKEM768_decap>;

using MLKEM1024HPKE =
    MLKEMHPKE<EVP_HPKE_MLKEM1024, MLKEM1024_PUBLIC_KEY_BYTES,
              MLKEM1024_CIPHERTEXT_BYTES, BCM_MLKEM_ENCAP_ENTROPY,

              MLKEM1024_private_key, MLKEM1024_public_key,

              MLKEM1024_private_key_from_seed, MLKEM1024_public_from_private,
              MLKEM1024_marshal_public_key, MLKEM1024_generate_key,
              MLKEM1024_parse_public_key, BCM_mlkem1024_encap_external_entropy,
              MLKEM1024_decap>;

template <typename MLKEM>
static const EVP_HPKE_KEM kMLKEM = {
    /*id=*/MLKEM::ID,
    /*public_key_len=*/MLKEM::PUBLIC_KEY_LEN,
    /*private_key_len=*/MLKEM::PRIVATE_KEY_LEN,
    /*seed_len=*/MLKEM::SEED_LEN,
    /*enc_len=*/MLKEM::ENC_LEN,
    MLKEM::InitKey,
    MLKEM::HpkeGenerateKey,
    MLKEM::EncapWithSeed,
    MLKEM::HpkeDecap,
    // ML-KEM doesn't support authenticated encapsulation/decapsulation:
    // https://datatracker.ietf.org/doc/draft-ietf-hpke-pq/01/
    /*auth_encap_with_seed=*/nullptr,
    /*auth_decap=*/nullptr,
};

}  // namespace

const EVP_HPKE_KEM *EVP_hpke_mlkem768(void) { return &kMLKEM<MLKEM768HPKE>; }
const EVP_HPKE_KEM *EVP_hpke_mlkem1024(void) { return &kMLKEM<MLKEM1024HPKE>; }

uint16_t EVP_HPKE_KEM_id(const EVP_HPKE_KEM *kem) { return kem->id; }

size_t EVP_HPKE_KEM_public_key_len(const EVP_HPKE_KEM *kem) {
  return kem->public_key_len;
}

size_t EVP_HPKE_KEM_private_key_len(const EVP_HPKE_KEM *kem) {
  return kem->private_key_len;
}

size_t EVP_HPKE_KEM_enc_len(const EVP_HPKE_KEM *kem) { return kem->enc_len; }

void EVP_HPKE_KEY_zero(EVP_HPKE_KEY *key) {
  OPENSSL_memset(key, 0, sizeof(EVP_HPKE_KEY));
}

void EVP_HPKE_KEY_cleanup(EVP_HPKE_KEY *key) {
  // Nothing to clean up for now, but we may introduce a cleanup process in the
  // future.
}

EVP_HPKE_KEY *EVP_HPKE_KEY_new(void) {
  EVP_HPKE_KEY *key =
      reinterpret_cast<EVP_HPKE_KEY *>(OPENSSL_malloc(sizeof(EVP_HPKE_KEY)));
  if (key == nullptr) {
    return nullptr;
  }
  EVP_HPKE_KEY_zero(key);
  return key;
}

void EVP_HPKE_KEY_free(EVP_HPKE_KEY *key) {
  if (key != nullptr) {
    EVP_HPKE_KEY_cleanup(key);
    OPENSSL_free(key);
  }
}

int EVP_HPKE_KEY_copy(EVP_HPKE_KEY *dst, const EVP_HPKE_KEY *src) {
  // For now, |EVP_HPKE_KEY| is trivially copyable.
  OPENSSL_memcpy(dst, src, sizeof(EVP_HPKE_KEY));
  return 1;
}

void EVP_HPKE_KEY_move(EVP_HPKE_KEY *out, EVP_HPKE_KEY *in) {
  EVP_HPKE_KEY_cleanup(out);
  // For now, |EVP_HPKE_KEY| is trivially movable.
  // Note that Rust may move this structure. See
  // bssl-crypto/src/scoped.rs:EvpHpkeKey.
  OPENSSL_memcpy(out, in, sizeof(EVP_HPKE_KEY));
  EVP_HPKE_KEY_zero(in);
}

int EVP_HPKE_KEY_init(EVP_HPKE_KEY *key, const EVP_HPKE_KEM *kem,
                      const uint8_t *priv_key, size_t priv_key_len) {
  EVP_HPKE_KEY_zero(key);
  key->kem = kem;
  if (!kem->init_key(key, priv_key, priv_key_len)) {
    key->kem = nullptr;
    return 0;
  }
  return 1;
}

int EVP_HPKE_KEY_generate(EVP_HPKE_KEY *key, const EVP_HPKE_KEM *kem) {
  EVP_HPKE_KEY_zero(key);
  key->kem = kem;
  if (!kem->generate_key(key)) {
    key->kem = nullptr;
    return 0;
  }
  return 1;
}

const EVP_HPKE_KEM *EVP_HPKE_KEY_kem(const EVP_HPKE_KEY *key) {
  return key->kem;
}

int EVP_HPKE_KEY_public_key(const EVP_HPKE_KEY *key, uint8_t *out,
                            size_t *out_len, size_t max_out) {
  if (max_out < key->kem->public_key_len) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  OPENSSL_memcpy(out, key->public_key, key->kem->public_key_len);
  *out_len = key->kem->public_key_len;
  return 1;
}

int EVP_HPKE_KEY_private_key(const EVP_HPKE_KEY *key, uint8_t *out,
                             size_t *out_len, size_t max_out) {
  if (max_out < key->kem->private_key_len) {
    OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_BUFFER_SIZE);
    return 0;
  }
  OPENSSL_memcpy(out, key->private_key, key->kem->private_key_len);
  *out_len = key->kem->private_key_len;
  return 1;
}


// Supported KDFs and AEADs.

const EVP_HPKE_KDF *EVP_hpke_hkdf_sha256(void) {
  static const EVP_HPKE_KDF kKDF = {EVP_HPKE_HKDF_SHA256, &EVP_sha256};
  return &kKDF;
}

uint16_t EVP_HPKE_KDF_id(const EVP_HPKE_KDF *kdf) { return kdf->id; }

const EVP_MD *EVP_HPKE_KDF_hkdf_md(const EVP_HPKE_KDF *kdf) {
  return kdf->hkdf_md_func();
}

const EVP_HPKE_AEAD *EVP_hpke_aes_128_gcm(void) {
  static const EVP_HPKE_AEAD kAEAD = {EVP_HPKE_AES_128_GCM,
                                      &EVP_aead_aes_128_gcm};
  return &kAEAD;
}

const EVP_HPKE_AEAD *EVP_hpke_aes_256_gcm(void) {
  static const EVP_HPKE_AEAD kAEAD = {EVP_HPKE_AES_256_GCM,
                                      &EVP_aead_aes_256_gcm};
  return &kAEAD;
}

const EVP_HPKE_AEAD *EVP_hpke_chacha20_poly1305(void) {
  static const EVP_HPKE_AEAD kAEAD = {EVP_HPKE_CHACHA20_POLY1305,
                                      &EVP_aead_chacha20_poly1305};
  return &kAEAD;
}

uint16_t EVP_HPKE_AEAD_id(const EVP_HPKE_AEAD *aead) { return aead->id; }

const EVP_AEAD *EVP_HPKE_AEAD_aead(const EVP_HPKE_AEAD *aead) {
  return aead->aead_func();
}


// HPKE implementation.

// This is strlen("HPKE") + 3 * sizeof(uint16_t).
#define HPKE_SUITE_ID_LEN 10

// The suite_id for non-KEM pieces of HPKE is defined as concat("HPKE",
// I2OSP(kem_id, 2), I2OSP(kdf_id, 2), I2OSP(aead_id, 2)).
static int hpke_build_suite_id(const EVP_HPKE_CTX *ctx,
                               uint8_t out[HPKE_SUITE_ID_LEN]) {
  CBB cbb;
  CBB_init_fixed(&cbb, out, HPKE_SUITE_ID_LEN);
  return add_label_string(&cbb, "HPKE") &&   //
         CBB_add_u16(&cbb, ctx->kem->id) &&  //
         CBB_add_u16(&cbb, ctx->kdf->id) &&  //
         CBB_add_u16(&cbb, ctx->aead->id);
}

#define HPKE_MODE_BASE 0
#define HPKE_MODE_AUTH 2

static int hpke_key_schedule(EVP_HPKE_CTX *ctx, uint8_t mode,
                             const uint8_t *shared_secret,
                             size_t shared_secret_len, const uint8_t *info,
                             size_t info_len) {
  uint8_t suite_id[HPKE_SUITE_ID_LEN];
  if (!hpke_build_suite_id(ctx, suite_id)) {
    return 0;
  }

  // psk_id_hash = LabeledExtract("", "psk_id_hash", psk_id)
  // TODO(davidben): Precompute this value and store it with the EVP_HPKE_KDF.
  const EVP_MD *hkdf_md = ctx->kdf->hkdf_md_func();
  uint8_t psk_id_hash[EVP_MAX_MD_SIZE];
  size_t psk_id_hash_len;
  if (!hpke_labeled_extract(hkdf_md, psk_id_hash, &psk_id_hash_len, nullptr, 0,
                            suite_id, sizeof(suite_id), "psk_id_hash", nullptr,
                            0)) {
    return 0;
  }

  // info_hash = LabeledExtract("", "info_hash", info)
  uint8_t info_hash[EVP_MAX_MD_SIZE];
  size_t info_hash_len;
  if (!hpke_labeled_extract(hkdf_md, info_hash, &info_hash_len, nullptr, 0,
                            suite_id, sizeof(suite_id), "info_hash", info,
                            info_len)) {
    return 0;
  }

  // key_schedule_context = concat(mode, psk_id_hash, info_hash)
  uint8_t context[sizeof(uint8_t) + 2 * EVP_MAX_MD_SIZE];
  size_t context_len;
  CBB context_cbb;
  CBB_init_fixed(&context_cbb, context, sizeof(context));
  if (!CBB_add_u8(&context_cbb, mode) ||
      !CBB_add_bytes(&context_cbb, psk_id_hash, psk_id_hash_len) ||
      !CBB_add_bytes(&context_cbb, info_hash, info_hash_len) ||
      !CBB_finish(&context_cbb, nullptr, &context_len)) {
    return 0;
  }

  // secret = LabeledExtract(shared_secret, "secret", psk)
  uint8_t secret[EVP_MAX_MD_SIZE];
  size_t secret_len;
  if (!hpke_labeled_extract(hkdf_md, secret, &secret_len, shared_secret,
                            shared_secret_len, suite_id, sizeof(suite_id),
                            "secret", nullptr, 0)) {
    return 0;
  }

  // key = LabeledExpand(secret, "key", key_schedule_context, Nk)
  const EVP_AEAD *aead = EVP_HPKE_AEAD_aead(ctx->aead);
  uint8_t key[EVP_AEAD_MAX_KEY_LENGTH];
  const size_t kKeyLen = EVP_AEAD_key_length(aead);
  if (!hpke_labeled_expand(hkdf_md, key, kKeyLen, secret, secret_len, suite_id,
                           sizeof(suite_id), "key", context, context_len) ||
      !EVP_AEAD_CTX_init(&ctx->aead_ctx, aead, key, kKeyLen,
                         EVP_AEAD_DEFAULT_TAG_LENGTH, nullptr)) {
    return 0;
  }

  // base_nonce = LabeledExpand(secret, "base_nonce", key_schedule_context, Nn)
  if (!hpke_labeled_expand(hkdf_md, ctx->base_nonce,
                           EVP_AEAD_nonce_length(aead), secret, secret_len,
                           suite_id, sizeof(suite_id), "base_nonce", context,
                           context_len)) {
    return 0;
  }

  // exporter_secret = LabeledExpand(secret, "exp", key_schedule_context, Nh)
  if (!hpke_labeled_expand(hkdf_md, ctx->exporter_secret, EVP_MD_size(hkdf_md),
                           secret, secret_len, suite_id, sizeof(suite_id),
                           "exp", context, context_len)) {
    return 0;
  }

  return 1;
}

void EVP_HPKE_CTX_zero(EVP_HPKE_CTX *ctx) {
  OPENSSL_memset(ctx, 0, sizeof(EVP_HPKE_CTX));
  EVP_AEAD_CTX_zero(&ctx->aead_ctx);
}

void EVP_HPKE_CTX_cleanup(EVP_HPKE_CTX *ctx) {
  EVP_AEAD_CTX_cleanup(&ctx->aead_ctx);
}

EVP_HPKE_CTX *EVP_HPKE_CTX_new(void) {
  EVP_HPKE_CTX *ctx =
      reinterpret_cast<EVP_HPKE_CTX *>(OPENSSL_malloc(sizeof(EVP_HPKE_CTX)));
  if (ctx == nullptr) {
    return nullptr;
  }
  EVP_HPKE_CTX_zero(ctx);
  return ctx;
}

void EVP_HPKE_CTX_free(EVP_HPKE_CTX *ctx) {
  if (ctx != nullptr) {
    EVP_HPKE_CTX_cleanup(ctx);
    OPENSSL_free(ctx);
  }
}

int EVP_HPKE_CTX_setup_sender(EVP_HPKE_CTX *ctx, uint8_t *out_enc,
                              size_t *out_enc_len, size_t max_enc,
                              const EVP_HPKE_KEM *kem, const EVP_HPKE_KDF *kdf,
                              const EVP_HPKE_AEAD *aead,
                              const uint8_t *peer_public_key,
                              size_t peer_public_key_len, const uint8_t *info,
                              size_t info_len) {
  uint8_t seed[MAX_SEED_LEN];
  RAND_bytes(seed, kem->seed_len);
  return EVP_HPKE_CTX_setup_sender_with_seed_for_testing(
      ctx, out_enc, out_enc_len, max_enc, kem, kdf, aead, peer_public_key,
      peer_public_key_len, info, info_len, seed, kem->seed_len);
}

int EVP_HPKE_CTX_setup_sender_with_seed_for_testing(
    EVP_HPKE_CTX *ctx, uint8_t *out_enc, size_t *out_enc_len, size_t max_enc,
    const EVP_HPKE_KEM *kem, const EVP_HPKE_KDF *kdf, const EVP_HPKE_AEAD *aead,
    const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *info, size_t info_len, const uint8_t *seed,
    size_t seed_len) {
  EVP_HPKE_CTX_zero(ctx);
  ctx->is_sender = 1;
  ctx->kem = kem;
  ctx->kdf = kdf;
  ctx->aead = aead;
  uint8_t shared_secret[MAX_SHARED_SECRET_LEN];
  size_t shared_secret_len;
  if (!kem->encap_with_seed(kem, shared_secret, &shared_secret_len, out_enc,
                            out_enc_len, max_enc, peer_public_key,
                            peer_public_key_len, seed, seed_len) ||
      !hpke_key_schedule(ctx, HPKE_MODE_BASE, shared_secret, shared_secret_len,
                         info, info_len)) {
    EVP_HPKE_CTX_cleanup(ctx);
    return 0;
  }
  return 1;
}

int EVP_HPKE_CTX_setup_recipient(EVP_HPKE_CTX *ctx, const EVP_HPKE_KEY *key,
                                 const EVP_HPKE_KDF *kdf,
                                 const EVP_HPKE_AEAD *aead, const uint8_t *enc,
                                 size_t enc_len, const uint8_t *info,
                                 size_t info_len) {
  EVP_HPKE_CTX_zero(ctx);
  ctx->is_sender = 0;
  ctx->kem = key->kem;
  ctx->kdf = kdf;
  ctx->aead = aead;
  uint8_t shared_secret[MAX_SHARED_SECRET_LEN];
  size_t shared_secret_len;
  if (!key->kem->decap(key, shared_secret, &shared_secret_len, enc, enc_len) ||
      !hpke_key_schedule(ctx, HPKE_MODE_BASE, shared_secret, shared_secret_len,
                         info, info_len)) {
    EVP_HPKE_CTX_cleanup(ctx);
    return 0;
  }
  return 1;
}


int EVP_HPKE_CTX_setup_auth_sender(
    EVP_HPKE_CTX *ctx, uint8_t *out_enc, size_t *out_enc_len, size_t max_enc,
    const EVP_HPKE_KEY *key, const EVP_HPKE_KDF *kdf, const EVP_HPKE_AEAD *aead,
    const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *info, size_t info_len) {
  uint8_t seed[MAX_SEED_LEN];
  RAND_bytes(seed, key->kem->seed_len);
  return EVP_HPKE_CTX_setup_auth_sender_with_seed_for_testing(
      ctx, out_enc, out_enc_len, max_enc, key, kdf, aead, peer_public_key,
      peer_public_key_len, info, info_len, seed, key->kem->seed_len);
}

int EVP_HPKE_CTX_setup_auth_sender_with_seed_for_testing(
    EVP_HPKE_CTX *ctx, uint8_t *out_enc, size_t *out_enc_len, size_t max_enc,
    const EVP_HPKE_KEY *key, const EVP_HPKE_KDF *kdf, const EVP_HPKE_AEAD *aead,
    const uint8_t *peer_public_key, size_t peer_public_key_len,
    const uint8_t *info, size_t info_len, const uint8_t *seed,
    size_t seed_len) {
  if (key->kem->auth_encap_with_seed == nullptr) {
    // Not all HPKE KEMs support AuthEncap.
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  EVP_HPKE_CTX_zero(ctx);
  ctx->is_sender = 1;
  ctx->kem = key->kem;
  ctx->kdf = kdf;
  ctx->aead = aead;
  uint8_t shared_secret[MAX_SHARED_SECRET_LEN];
  size_t shared_secret_len;
  if (!key->kem->auth_encap_with_seed(
          key, shared_secret, &shared_secret_len, out_enc, out_enc_len, max_enc,
          peer_public_key, peer_public_key_len, seed, seed_len) ||
      !hpke_key_schedule(ctx, HPKE_MODE_AUTH, shared_secret, shared_secret_len,
                         info, info_len)) {
    EVP_HPKE_CTX_cleanup(ctx);
    return 0;
  }
  return 1;
}

int EVP_HPKE_CTX_setup_auth_recipient(
    EVP_HPKE_CTX *ctx, const EVP_HPKE_KEY *key, const EVP_HPKE_KDF *kdf,
    const EVP_HPKE_AEAD *aead, const uint8_t *enc, size_t enc_len,
    const uint8_t *info, size_t info_len, const uint8_t *peer_public_key,
    size_t peer_public_key_len) {
  if (key->kem->auth_decap == nullptr) {
    // Not all HPKE KEMs support AuthDecap.
    OPENSSL_PUT_ERROR(EVP, EVP_R_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE);
    return 0;
  }

  EVP_HPKE_CTX_zero(ctx);
  ctx->is_sender = 0;
  ctx->kem = key->kem;
  ctx->kdf = kdf;
  ctx->aead = aead;
  uint8_t shared_secret[MAX_SHARED_SECRET_LEN];
  size_t shared_secret_len;
  if (!key->kem->auth_decap(key, shared_secret, &shared_secret_len, enc,
                            enc_len, peer_public_key, peer_public_key_len) ||
      !hpke_key_schedule(ctx, HPKE_MODE_AUTH, shared_secret, shared_secret_len,
                         info, info_len)) {
    EVP_HPKE_CTX_cleanup(ctx);
    return 0;
  }
  return 1;
}

static void hpke_nonce(const EVP_HPKE_CTX *ctx, uint8_t *out_nonce,
                       size_t nonce_len) {
  assert(nonce_len >= 8);

  // Write padded big-endian bytes of |ctx->seq| to |out_nonce|.
  OPENSSL_memset(out_nonce, 0, nonce_len);
  uint64_t seq_copy = ctx->seq;
  for (size_t i = 0; i < 8; i++) {
    out_nonce[nonce_len - i - 1] = seq_copy & 0xff;
    seq_copy >>= 8;
  }

  // XOR the encoded sequence with the |ctx->base_nonce|.
  for (size_t i = 0; i < nonce_len; i++) {
    out_nonce[i] ^= ctx->base_nonce[i];
  }
}

int EVP_HPKE_CTX_open(EVP_HPKE_CTX *ctx, uint8_t *out, size_t *out_len,
                      size_t max_out_len, const uint8_t *in, size_t in_len,
                      const uint8_t *ad, size_t ad_len) {
  if (ctx->is_sender) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }
  if (ctx->seq == UINT64_MAX) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_OVERFLOW);
    return 0;
  }

  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH];
  const size_t nonce_len = EVP_AEAD_nonce_length(ctx->aead_ctx.aead);
  hpke_nonce(ctx, nonce, nonce_len);

  if (!EVP_AEAD_CTX_open(&ctx->aead_ctx, out, out_len, max_out_len, nonce,
                         nonce_len, in, in_len, ad, ad_len)) {
    return 0;
  }
  ctx->seq++;
  return 1;
}

int EVP_HPKE_CTX_seal(EVP_HPKE_CTX *ctx, uint8_t *out, size_t *out_len,
                      size_t max_out_len, const uint8_t *in, size_t in_len,
                      const uint8_t *ad, size_t ad_len) {
  if (!ctx->is_sender) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }
  if (ctx->seq == UINT64_MAX) {
    OPENSSL_PUT_ERROR(EVP, ERR_R_OVERFLOW);
    return 0;
  }

  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH];
  const size_t nonce_len = EVP_AEAD_nonce_length(ctx->aead_ctx.aead);
  hpke_nonce(ctx, nonce, nonce_len);

  if (!EVP_AEAD_CTX_seal(&ctx->aead_ctx, out, out_len, max_out_len, nonce,
                         nonce_len, in, in_len, ad, ad_len)) {
    return 0;
  }
  ctx->seq++;
  return 1;
}

int EVP_HPKE_CTX_export(const EVP_HPKE_CTX *ctx, uint8_t *out,
                        size_t secret_len, const uint8_t *context,
                        size_t context_len) {
  uint8_t suite_id[HPKE_SUITE_ID_LEN];
  if (!hpke_build_suite_id(ctx, suite_id)) {
    return 0;
  }
  const EVP_MD *hkdf_md = ctx->kdf->hkdf_md_func();
  if (!hpke_labeled_expand(hkdf_md, out, secret_len, ctx->exporter_secret,
                           EVP_MD_size(hkdf_md), suite_id, sizeof(suite_id),
                           "sec", context, context_len)) {
    return 0;
  }
  return 1;
}

size_t EVP_HPKE_CTX_max_overhead(const EVP_HPKE_CTX *ctx) {
  assert(ctx->is_sender);
  return EVP_AEAD_max_overhead(EVP_AEAD_CTX_aead(&ctx->aead_ctx));
}

const EVP_HPKE_KEM *EVP_HPKE_CTX_kem(const EVP_HPKE_CTX *ctx) {
  return ctx->kem;
}

const EVP_HPKE_AEAD *EVP_HPKE_CTX_aead(const EVP_HPKE_CTX *ctx) {
  return ctx->aead;
}

const EVP_HPKE_KDF *EVP_HPKE_CTX_kdf(const EVP_HPKE_CTX *ctx) {
  return ctx->kdf;
}
