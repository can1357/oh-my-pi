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

#ifndef OPENSSL_HEADER_XWING_H
#define OPENSSL_HEADER_XWING_H

#include <openssl/base.h>  // IWYU pragma: export

#if defined(__cplusplus)
extern "C" {
#endif


// X-Wing.
//
// This implements the X-Wing key encapsulation mechanism from
// https://datatracker.ietf.org/doc/html/draft-connolly-cfrg-xwing-kem-06.


// XWING_private_key contains an X-Wing private key. The contents of this object
// should never leave the address space since the format is unstable.
struct XWING_private_key {
  union {
    uint8_t bytes[512 * (3 + 3 + 9) + 32 + 32 + 32 + 32 + 32];
    uint16_t alignment;
  } opaque;
};

// XWING_PUBLIC_KEY_BYTES is the number of bytes in an encoded X-Wing public
// key.
#define XWING_PUBLIC_KEY_BYTES 1216

// XWING_PRIVATE_KEY_BYTES is the number of bytes in an encoded X-Wing private
// key.
#define XWING_PRIVATE_KEY_BYTES 32

// XWING_CIPHERTEXT_BYTES is the number of bytes in the X-Wing ciphertext.
#define XWING_CIPHERTEXT_BYTES 1120

// XWING_SHARED_SECRET_BYTES is the number of bytes in an X-Wing shared secret.
#define XWING_SHARED_SECRET_BYTES 32


// XWING_generate_key generates a random public/private key pair, writes the
// encoded public key to |out_encoded_public_key| and the private key to
// |out_private_key|. Returns one on success and zero on error.
OPENSSL_EXPORT int XWING_generate_key(
    uint8_t out_encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    struct XWING_private_key *out_private_key);

// XWING_public_from_private sets |out_encoded_public_key| to the public key
// that corresponds to |private_key|. Returns one on success and zero on error.
OPENSSL_EXPORT int XWING_public_from_private(
    uint8_t out_encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    const struct XWING_private_key *private_key);

// XWING_encap encapsulates a random shared secret for |encoded_public_key|,
// writes the ciphertext to |out_ciphertext|, and writes the random shared
// secret to |out_shared_secret|. Returns one on success and zero on error.
OPENSSL_EXPORT int XWING_encap(
    uint8_t out_ciphertext[XWING_CIPHERTEXT_BYTES],
    uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
    const uint8_t encoded_public_key[XWING_PUBLIC_KEY_BYTES]);

// XWING_encap_external_entropy encapsulates the shared secret for the given
// |eseed| entropy using |encoded_public_key|, writes the ciphertext to
// |out_ciphertext|, and writes the random shared secret to |out_shared_secret|.
// Returns one on success and zero on error.
OPENSSL_EXPORT int XWING_encap_external_entropy(
    uint8_t out_ciphertext[XWING_CIPHERTEXT_BYTES],
    uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
    const uint8_t encoded_public_key[XWING_PUBLIC_KEY_BYTES],
    const uint8_t eseed[64]);

// XWING_decap decapsulates a shared secret from |ciphertext| using
// |private_key| and writes it to |out_shared_secret|. Returns one on success
// and zero on error.
OPENSSL_EXPORT int XWING_decap(
    uint8_t out_shared_secret[XWING_SHARED_SECRET_BYTES],
    const uint8_t ciphertext[XWING_CIPHERTEXT_BYTES],
    const struct XWING_private_key *private_key);

// Serialisation of keys.

// XWING_marshal_private_key serializes |private_key| to |out| in the standard
// format for X-Wing private keys. It returns one on success or zero on
// allocation error.
OPENSSL_EXPORT int XWING_marshal_private_key(
    CBB *out, const struct XWING_private_key *private_key);

// XWING_parse_private_key parses a private key in the standard format for
// X-Wing private keys from |in| and writes the result to |out_public_key|. It
// returns one on success or zero on parse error or if there are trailing bytes
// in |in|.
OPENSSL_EXPORT int XWING_parse_private_key(
    struct XWING_private_key *out_private_key, CBS *in);


#if defined(__cplusplus)
}  // extern C
#endif

#endif  // OPENSSL_HEADER_XWING_H
