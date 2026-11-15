// Copyright 2025 The BoringSSL Authors
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

#include <openssl/xwing.h>

#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/mlkem.h>
#include <openssl/rand.h>

#include "../fipsmodule/bcm_interface.h"
#include "../fipsmodule/keccak/internal.h"


struct private_key {
  MLKEM768_private_key mlkem_private_key;
  uint8_t x25519_private_key[32];
  uint8_t seed[XWING_PRIVATE_KEY_BYTES];
};

static_assert(sizeof(XWING_private_key) == sizeof(private_key));
static_assert(alignof(XWING_private_key) == alignof(private_key));

static const private_key *private_key_from_external(
    const XWING_private_key *external) {
  return reinterpret_cast<const private_key *>(external);
}
static private_key *private_key_from_external(XWING_private_key *external) {
  return reinterpret_cast<private_key *>(external);
}

static void xwing_expand_private_key(private_key *inout_private_key) {
  BORINGSSL_keccak_st context;
  BORINGSSL_keccak_init(&context, boringssl_shake256);
  BORINGSSL_keccak_absorb(&context, inout_private_key->seed,
                          sizeof(inout_private_key->seed));

  // ML-KEM-768
  uint8_t mlkem_seed[64];
  BORINGSSL_keccak_squeeze(&context, mlkem_seed, sizeof(mlkem_seed));
  MLKEM768_private_key_from_seed(&inout_private_key->mlkem_private_key,
                                 mlkem_seed, sizeof(mlkem_seed));

  // X25519
  BORINGSSL_keccak_squeeze(&context, inout_private_key->x25519_private_key,
                           sizeof(inout_private_key->x25519_private_key));
}

static int xwing_parse_private_key(private_key *out_private_key, CBS *in) {
  if (!CBS_copy_bytes(in, out_private_key->seed,
                      sizeof(out_private_key->seed))) {
    return 0;
  }

  xwing_expand_private_key(out_private_key);
  return 1;
}

static int xwing_marshal_private_key(CBB *out, const private_key *private_key) {
  return CBB_add_bytes(out, private_key->seed, sizeof(private_key->seed));
}

static int xwing_public_from_private(
    uint8_t out_encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    const private_key *private_key) {
  CBB cbb;
  if (!CBB_init_fixed(&cbb, out_encoded_public_key, XWING_PUBLIC_KEY_BYTES)) {
    return 0;
  }

  // ML-KEM-768
  MLKEM768_public_key mlkem_public_key;
  MLKEM768_public_from_private(&mlkem_public_key,
                               &private_key->mlkem_private_key);

  if (!MLKEM768_marshal_public_key(&cbb, &mlkem_public_key)) {
    return 0;
  }

  // X25519
  uint8_t *buf;
  if (!CBB_add_space(&cbb, &buf, 32)) {
    return 0;
  }
  X25519_public_from_private(buf, private_key->x25519_private_key);

  if (CBB_len(&cbb) != XWING_PUBLIC_KEY_BYTES) {
    return 0;
  }
  return 1;
}

static void xwing_combiner(
    uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
    const uint8_t mlkem_shared_secret[MLKEM_SHARED_SECRET_BYTES],
    const uint8_t x25519_shared_secret[32], const uint8_t x25519_ciphertext[32],
    const uint8_t x25519_public_key[32]) {
  BORINGSSL_keccak_st context;
  BORINGSSL_keccak_init(&context, boringssl_sha3_256);

  BORINGSSL_keccak_absorb(&context, mlkem_shared_secret,
                          MLKEM_SHARED_SECRET_BYTES);
  BORINGSSL_keccak_absorb(&context, x25519_shared_secret, 32);
  BORINGSSL_keccak_absorb(&context, x25519_ciphertext, 32);
  BORINGSSL_keccak_absorb(&context, x25519_public_key, 32);

  uint8_t xwing_label[6] = {0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c};
  BORINGSSL_keccak_absorb(&context, xwing_label, sizeof(xwing_label));

  BORINGSSL_keccak_squeeze(&context, out_shared_secret,
                           XWING_SHARED_SECRET_BYTES);
}

// Public API.

int XWING_parse_private_key(struct XWING_private_key *out_private_key,
                            CBS *in) {
  if (!xwing_parse_private_key(private_key_from_external(out_private_key),
                               in) ||
      CBS_len(in) != 0) {
    return 0;
  }
  return 1;
}

int XWING_marshal_private_key(CBB *out,
                              const struct XWING_private_key *private_key) {
  return xwing_marshal_private_key(out, private_key_from_external(private_key));
}

int XWING_generate_key(uint8_t out_encoded_public_key[XWING_PUBLIC_KEY_BYTES],
                       struct XWING_private_key *out_private_key) {
  private_key *private_key = private_key_from_external(out_private_key);
  RAND_bytes(private_key->seed, sizeof(private_key->seed));

  xwing_expand_private_key(private_key);

  return XWING_public_from_private(out_encoded_public_key, out_private_key);
}

int XWING_public_from_private(
    uint8_t out_encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    const struct XWING_private_key *private_key) {
  return xwing_public_from_private(out_encoded_public_key,
                                   private_key_from_external(private_key));
}

int XWING_encap(uint8_t out_ciphertext[XWING_CIPHERTEXT_BYTES],
                uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
                const uint8_t encoded_public_key[XWING_PUBLIC_KEY_BYTES]) {
  uint8_t eseed[64];
  RAND_bytes(eseed, sizeof(eseed));

  return XWING_encap_external_entropy(out_ciphertext, out_shared_secret,
                                      encoded_public_key, eseed);
}

int XWING_encap_external_entropy(
    uint8_t out_ciphertext[XWING_CIPHERTEXT_BYTES],
    uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
    const uint8_t encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    const uint8_t eseed[64]) {
  // X25519
  static_assert(XWING_PUBLIC_KEY_BYTES >= MLKEM768_PUBLIC_KEY_BYTES + 32);
  const uint8_t *x25519_public_key =
      encoded_public_key + MLKEM768_PUBLIC_KEY_BYTES;
  const uint8_t *x25519_ephemeral_private_key = eseed + 32;
  uint8_t *x25519_ciphertext = out_ciphertext + MLKEM768_CIPHERTEXT_BYTES;
  X25519_public_from_private(x25519_ciphertext, x25519_ephemeral_private_key);

  uint8_t x25519_shared_secret[32];
  if (!X25519(x25519_shared_secret, x25519_ephemeral_private_key,
              x25519_public_key)) {
    return 0;
  }

  // ML-KEM-768
  CBS mlkem_cbs;
  static_assert(MLKEM768_PUBLIC_KEY_BYTES <= XWING_PUBLIC_KEY_BYTES);
  CBS_init(&mlkem_cbs, encoded_public_key, MLKEM768_PUBLIC_KEY_BYTES);

  MLKEM768_public_key mlkem_public_key;
  if (!MLKEM768_parse_public_key(&mlkem_public_key, &mlkem_cbs)) {
    return 0;
  }

  uint8_t *mlkem_ciphertext = out_ciphertext;
  uint8_t mlkem_shared_secret[MLKEM_SHARED_SECRET_BYTES];
  BCM_mlkem768_encap_external_entropy(mlkem_ciphertext, mlkem_shared_secret,
                                      &mlkem_public_key, eseed);

  // Combine the shared secrets
  xwing_combiner(out_shared_secret, mlkem_shared_secret, x25519_shared_secret,
                 x25519_ciphertext, x25519_public_key);
  return 1;
}

static int xwing_decap(uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
                       const uint8_t ciphertext[XWING_CIPHERTEXT_BYTES],
                       const private_key *private_key) {
  static_assert(XWING_CIPHERTEXT_BYTES >= MLKEM768_CIPHERTEXT_BYTES + 32);
  const uint8_t *mlkem_ciphertext = ciphertext;
  const uint8_t *x25519_ciphertext = ciphertext + MLKEM768_CIPHERTEXT_BYTES;

  // ML-KEM-768
  uint8_t mlkem_shared_secret[MLKEM_SHARED_SECRET_BYTES];
  if (!MLKEM768_decap(mlkem_shared_secret, mlkem_ciphertext,
                      MLKEM768_CIPHERTEXT_BYTES,
                      &private_key->mlkem_private_key)) {
    goto err;
  }

  // X25519
  uint8_t x25519_public_key[32];
  X25519_public_from_private(x25519_public_key,
                             private_key->x25519_private_key);

  uint8_t x25519_shared_secret[32];
  if (!X25519(x25519_shared_secret, private_key->x25519_private_key,
              x25519_ciphertext)) {
    goto err;
  }

  // Combine the shared secrets
  xwing_combiner(out_shared_secret, mlkem_shared_secret, x25519_shared_secret,
                 x25519_ciphertext, x25519_public_key);
  return 1;

err:
  // In case of error, fill the shared secret with random bytes so that if the
  // caller forgets to check the return code:
  // - no intermediate information leaks,
  // - the shared secret is unpredictable, so for example any data encrypted
  //   with it wouldn't be trivially decryptable by an attacker.
  RAND_bytes(out_shared_secret, XWING_SHARED_SECRET_BYTES);
  return 0;
}

int XWING_decap(uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
                const uint8_t ciphertext[XWING_CIPHERTEXT_BYTES],
                const struct XWING_private_key *private_key) {
  return xwing_decap(out_shared_secret, ciphertext,
                     private_key_from_external(private_key));
}
