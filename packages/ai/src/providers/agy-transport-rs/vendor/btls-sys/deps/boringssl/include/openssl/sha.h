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

#ifndef OPENSSL_HEADER_SHA_H
#define OPENSSL_HEADER_SHA_H

#include <openssl/base.h>  // IWYU pragma: export

// `sha.h` historically included SHA-1 and SHA-2 hash functions. So, for
// backward compatibility `sha2.h` is included here. New uses of this header
// should include sha2.h unless SHA-1 family functions are required.
#include <openssl/sha2.h>  // IWYU pragma: export

#if defined(__cplusplus)
extern "C" {
#endif


// The SHA family of hash functions (SHA-1 and SHA-2).


// SHA-1.

// SHA_CBLOCK is the block size of SHA-1.
#define SHA_CBLOCK 64

// SHA_DIGEST_LENGTH is the length of a SHA-1 digest.
#define SHA_DIGEST_LENGTH 20

// SHA1_Init initialises |sha| and returns one.
OPENSSL_EXPORT int SHA1_Init(SHA_CTX *sha);

// SHA1_Update adds |len| bytes from |data| to |sha| and returns one.
OPENSSL_EXPORT int SHA1_Update(SHA_CTX *sha, const void *data, size_t len);

// SHA1_Final adds the final padding to |sha| and writes the resulting digest to
// |out|, which must have at least |SHA_DIGEST_LENGTH| bytes of space. It
// returns one.
OPENSSL_EXPORT int SHA1_Final(uint8_t out[SHA_DIGEST_LENGTH], SHA_CTX *sha);

// SHA1 writes the digest of |len| bytes from |data| to |out| and returns
// |out|. There must be at least |SHA_DIGEST_LENGTH| bytes of space in
// |out|.
OPENSSL_EXPORT uint8_t *SHA1(const uint8_t *data, size_t len,
                             uint8_t out[SHA_DIGEST_LENGTH]);

// SHA1_Transform is a low-level function that performs a single, SHA-1 block
// transformation using the state from |sha| and |SHA_CBLOCK| bytes from
// |block|.
OPENSSL_EXPORT void SHA1_Transform(SHA_CTX *sha,
                                   const uint8_t block[SHA_CBLOCK]);

struct sha_state_st {
#if defined(__cplusplus) || defined(OPENSSL_WINDOWS)
  uint32_t h[5];
#else
  // wpa_supplicant accesses |h0|..|h4| so we must support those names for
  // compatibility with it until it can be updated. Anonymous unions are only
  // standard in C11, so disable this workaround in C++.
  union {
    uint32_t h[5];
    struct {
      uint32_t h0;
      uint32_t h1;
      uint32_t h2;
      uint32_t h3;
      uint32_t h4;
    };
  };
#endif
  uint32_t Nl, Nh;
  uint8_t data[SHA_CBLOCK];
  unsigned num;
} /* SHA_CTX */;

// CRYPTO_fips_186_2_prf derives |out_len| bytes from |xkey| using the PRF
// defined in FIPS 186-2, Appendix 3.1, with change notice 1 applied. The b
// parameter is 160 and seed, XKEY, is also 160 bits. The optional XSEED user
// input is all zeros.
//
// The PRF generates a sequence of 320-bit numbers. Each number is encoded as a
// 40-byte string in big-endian and then concatenated to form |out|. If
// |out_len| is not a multiple of 40, the result is truncated. This matches the
// construction used in Section 7 of RFC 4186 and Section 7 of RFC 4187.
//
// This PRF is based on SHA-1, a weak hash function, and should not be used
// in new protocols. It is provided for compatibility with some legacy EAP
// methods.
OPENSSL_EXPORT void CRYPTO_fips_186_2_prf(
    uint8_t *out, size_t out_len, const uint8_t xkey[SHA_DIGEST_LENGTH]);


#if defined(__cplusplus)
}  // extern C
#endif

#endif  // OPENSSL_HEADER_SHA_H
