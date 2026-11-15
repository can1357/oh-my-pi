// Copyright 2024 The BoringSSL Authors
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

#include <openssl/mlkem.h>

#include "../fipsmodule/bcm_interface.h"


void MLKEM768_generate_key(
    uint8_t out_encoded_public_key[MLKEM768_PUBLIC_KEY_BYTES],
    uint8_t optional_out_seed[MLKEM_SEED_BYTES],
    struct MLKEM768_private_key *out_private_key) {
  BCM_mlkem768_generate_key(out_encoded_public_key, optional_out_seed,
                            out_private_key);
}

int MLKEM768_private_key_from_seed(struct MLKEM768_private_key *out_private_key,
                                   const uint8_t *seed, size_t seed_len) {
  return bcm_success(
      BCM_mlkem768_private_key_from_seed(out_private_key, seed, seed_len));
}

void MLKEM768_public_from_private(
    struct MLKEM768_public_key *out_public_key,
    const struct MLKEM768_private_key *private_key) {
  (void)BCM_mlkem768_public_from_private(out_public_key, private_key);
}

void MLKEM768_encap(uint8_t out_ciphertext[MLKEM768_CIPHERTEXT_BYTES],
                    uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
                    const struct MLKEM768_public_key *public_key) {
  (void)BCM_mlkem768_encap(out_ciphertext, out_shared_secret, public_key);
}

int MLKEM768_decap(uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
                   const uint8_t *ciphertext, size_t ciphertext_len,
                   const struct MLKEM768_private_key *private_key) {
  return bcm_success(BCM_mlkem768_decap(out_shared_secret, ciphertext,
                                        ciphertext_len, private_key));
}

int MLKEM768_marshal_public_key(CBB *out,
                                const struct MLKEM768_public_key *public_key) {
  return bcm_success(BCM_mlkem768_marshal_public_key(out, public_key));
}

int MLKEM768_parse_public_key(struct MLKEM768_public_key *out_public_key,
                              CBS *in) {
  return bcm_success(BCM_mlkem768_parse_public_key(out_public_key, in));
}


void MLKEM1024_generate_key(
    uint8_t out_encoded_public_key[MLKEM1024_PUBLIC_KEY_BYTES],
    uint8_t optional_out_seed[MLKEM_SEED_BYTES],
    struct MLKEM1024_private_key *out_private_key) {
  (void)BCM_mlkem1024_generate_key(out_encoded_public_key, optional_out_seed,
                                   out_private_key);
}

int MLKEM1024_private_key_from_seed(
    struct MLKEM1024_private_key *out_private_key, const uint8_t *seed,
    size_t seed_len) {
  return bcm_success(
      BCM_mlkem1024_private_key_from_seed(out_private_key, seed, seed_len));
}

void MLKEM1024_public_from_private(
    struct MLKEM1024_public_key *out_public_key,
    const struct MLKEM1024_private_key *private_key) {
  (void)BCM_mlkem1024_public_from_private(out_public_key, private_key);
}

void MLKEM1024_encap(uint8_t out_ciphertext[MLKEM1024_CIPHERTEXT_BYTES],
                     uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
                     const struct MLKEM1024_public_key *public_key) {
  (void)BCM_mlkem1024_encap(out_ciphertext, out_shared_secret, public_key);
}

int MLKEM1024_decap(uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
                    const uint8_t *ciphertext, size_t ciphertext_len,
                    const struct MLKEM1024_private_key *private_key) {
  return bcm_success(BCM_mlkem1024_decap(out_shared_secret, ciphertext,
                                         ciphertext_len, private_key));
}

int MLKEM1024_marshal_public_key(
    CBB *out, const struct MLKEM1024_public_key *public_key) {
  return bcm_success(BCM_mlkem1024_marshal_public_key(out, public_key));
}

int MLKEM1024_parse_public_key(struct MLKEM1024_public_key *out_public_key,
                               CBS *in) {
  return bcm_success(BCM_mlkem1024_parse_public_key(out_public_key, in));
}
