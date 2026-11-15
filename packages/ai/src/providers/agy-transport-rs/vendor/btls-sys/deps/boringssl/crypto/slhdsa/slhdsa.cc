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

#include <openssl/slhdsa.h>

#include <openssl/obj.h>

#include "../fipsmodule/bcm_interface.h"


static_assert(SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES ==
              BCM_SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES);
static_assert(SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES ==
              BCM_SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES);
static_assert(SLHDSA_SHA2_128S_SIGNATURE_BYTES ==
              BCM_SLHDSA_SHA2_128S_SIGNATURE_BYTES);

void SLHDSA_SHA2_128S_generate_key(
    uint8_t out_public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
    uint8_t out_private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES]) {
  BCM_slhdsa_sha2_128s_generate_key(out_public_key, out_private_key);
}

void SLHDSA_SHA2_128S_public_from_private(
    uint8_t out_public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
    const uint8_t private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES]) {
  BCM_slhdsa_sha2_128s_public_from_private(out_public_key, private_key);
}

int SLHDSA_SHA2_128S_sign(
    uint8_t out_signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES],
    const uint8_t private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES],
    const uint8_t *msg, size_t msg_len, const uint8_t *context,
    size_t context_len) {
  return bcm_success(BCM_slhdsa_sha2_128s_sign(out_signature, private_key, msg,
                                               msg_len, context, context_len));
}

int SLHDSA_SHA2_128S_verify(
    const uint8_t *signature, size_t signature_len,
    const uint8_t public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
    const uint8_t *msg, size_t msg_len, const uint8_t *context,
    size_t context_len) {
  return bcm_success(BCM_slhdsa_sha2_128s_verify(signature, signature_len,
                                                 public_key, msg, msg_len,
                                                 context, context_len));
}

int SLHDSA_SHA2_128S_prehash_sign(
    uint8_t out_signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES],
    const uint8_t private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES],
    const uint8_t *hashed_msg, size_t hashed_msg_len, int hash_nid,
    const uint8_t *context, size_t context_len) {
  if (hash_nid != NID_sha256) {
    return 0;
  }
  return bcm_success(BCM_slhdsa_sha2_128s_prehash_sign(
      out_signature, private_key, hashed_msg, hashed_msg_len, hash_nid, context,
      context_len));
}

int SLHDSA_SHA2_128S_prehash_verify(
    const uint8_t *signature, size_t signature_len,
    const uint8_t public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
    const uint8_t *hashed_msg, size_t hashed_msg_len, int hash_nid,
    const uint8_t *context, size_t context_len) {
  if (hash_nid != NID_sha256) {
    return 0;
  }
  return bcm_success(BCM_slhdsa_sha2_128s_prehash_verify(
      signature, signature_len, public_key, hashed_msg, hashed_msg_len,
      hash_nid, context, context_len));
}

int SLHDSA_SHA2_128S_prehash_warning_nonstandard_sign(
    uint8_t out_signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES],
    const uint8_t private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES],
    const uint8_t *hashed_msg, size_t hashed_msg_len, int hash_nid,
    const uint8_t *context, size_t context_len) {
  if (hash_nid != NID_sha384) {
    return 0;
  }
  return bcm_success(BCM_slhdsa_sha2_128s_prehash_sign(
      out_signature, private_key, hashed_msg, hashed_msg_len, hash_nid, context,
      context_len));
}

int SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
    const uint8_t *signature, size_t signature_len,
    const uint8_t public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
    const uint8_t *hashed_msg, size_t hashed_msg_len, int hash_nid,
    const uint8_t *context, size_t context_len) {
  if (hash_nid != NID_sha384) {
    return 0;
  }
  return bcm_success(BCM_slhdsa_sha2_128s_prehash_verify(
      signature, signature_len, public_key, hashed_msg, hashed_msg_len,
      hash_nid, context, context_len));
}
