// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#ifndef OPENSSL_HEADER_CRYPTO_FIPSMODULE_DIGEST_MD32_COMMON_H
#define OPENSSL_HEADER_CRYPTO_FIPSMODULE_DIGEST_MD32_COMMON_H

#include <openssl/base.h>
#include <openssl/span.h>

#include <assert.h>

#include "../../internal.h"

BSSL_NAMESPACE_BEGIN


// This is a generic 32-bit "collector" for message digest algorithms. It
// collects input character stream into chunks of 32-bit values and invokes the
// block function that performs the actual hash calculations.
//
// To make use of this mechanism, the hash context should be defined with the
// following parameters.
//
//     typedef struct <name>_state_st {
//       uint32_t h[<chaining length> / sizeof(uint32_t)];
//       uint32_t Nl, Nh;
//       uint8_t data[<block size>];
//       unsigned num;
//       ...
//     } <NAME>_CTX;
//
// <chaining length> is the output length of the hash in bytes, before
// any truncation (e.g. 64 for SHA-224 and SHA-256, 128 for SHA-384 and
// SHA-512).
//
// |h| is the hash state and is updated by a function of type
// |crypto_md32_block_func|. |data| is the partial unprocessed block and has
// |num| bytes. |Nl| and |Nh| maintain the number of bits processed so far.
//
// The template parameter is then a traits struct defined as follows:
//
//     struct HashTraits {
//       // HashContext is the hash type defined above.
//       using HashContext = <NAME>_CTX;
//
//       // kBlockSize is the block size of the hash function.
//       static constexpr size_t kBlockSize = <block size>;
//
//       // kLengthIsBigEndian determines whether the final length is encoded in
//       // big or little endian.
//       static constexpr bool kLengthIsBigEndian = ...;
//
//       // HashBlocks incorporates |num_blocks| blocks of input from |data|
//       // into |state|. It is assumed the caller has sized |state| and |data|
//       // for the hash function.
//       static void HashBlocks(uint32_t *state, const uint8_t *data,
//                              size_t num_blocks) {
//         <name>_block_data_order(state, data, num_blocks);
//       }
//     };
//
// The reason for this formulation is to encourage the compiler to specialize
// all the code for the block size and block function.

// crypto_md32_update hashes |in| to |ctx|.
template <typename Traits>
inline void crypto_md32_update(typename Traits::HashContext *ctx,
                               Span<const uint8_t> in) {
  static_assert(Traits::kBlockSize == sizeof(ctx->data), "block size is wrong");
  if (in.empty()) {
    return;
  }

  uint32_t l = ctx->Nl + ((static_cast<uint32_t>(in.size())) << 3);
  if (l < ctx->Nl) {
    // Handle carries.
    ctx->Nh++;
  }
  ctx->Nh += static_cast<uint32_t>(in.size() >> 29);
  ctx->Nl = l;

  size_t n = ctx->num;
  if (n != 0) {
    if (in.size() >= Traits::kBlockSize ||
        in.size() + n >= Traits::kBlockSize) {
      OPENSSL_memcpy(ctx->data + n, in.data(), Traits::kBlockSize - n);
      Traits::HashBlocks(ctx->h, ctx->data, 1);
      in = in.subspan(Traits::kBlockSize - n);
      ctx->num = 0;
      // Keep |data| zeroed when unused.
      OPENSSL_memset(ctx->data, 0, Traits::kBlockSize);
    } else {
      OPENSSL_memcpy(ctx->data + n, in.data(), in.size());
      ctx->num += static_cast<unsigned>(in.size());
      return;
    }
  }

  n = in.size() / Traits::kBlockSize;
  if (n > 0) {
    Traits::HashBlocks(ctx->h, in.data(), n);
    in = in.subspan(n * Traits::kBlockSize);
  }

  if (!in.empty()) {
    ctx->num = static_cast<unsigned>(in.size());
    OPENSSL_memcpy(ctx->data, in.data(), in.size());
  }
}

// crypto_md32_final incorporates the partial block and trailing length into the
// digest state in |ctx|. The trailing length is encoded in little-endian if
// |is_big_endian| is zero and big-endian otherwise. |data| must be a buffer of
// length |block_size| with the first |*num| bytes containing a partial block.
// |Nh| and |Nl| contain the total number of bits processed. On return, this
// function clears the partial block in |data| and
// |*num|.
//
// This function does not serialize |h| into a final digest. This is the
// responsibility of the caller.
template <typename Traits>
inline void crypto_md32_final(typename Traits::HashContext *ctx) {
  static_assert(Traits::kBlockSize == sizeof(ctx->data), "block size is wrong");
  // |data| always has room for at least one byte. A full block would have
  // been consumed.
  size_t n = ctx->num;
  assert(n < Traits::kBlockSize);
  ctx->data[n] = 0x80;
  n++;

  // Fill the block with zeros if there isn't room for a 64-bit length.
  if (n > Traits::kBlockSize - 8) {
    OPENSSL_memset(ctx->data + n, 0, Traits::kBlockSize - n);
    n = 0;
    Traits::HashBlocks(ctx->h, ctx->data, 1);
  }
  OPENSSL_memset(ctx->data + n, 0, Traits::kBlockSize - 8 - n);

  // Append a 64-bit length to the block and process it.
  if constexpr (Traits::kLengthIsBigEndian) {
    CRYPTO_store_u32_be(ctx->data + Traits::kBlockSize - 8, ctx->Nh);
    CRYPTO_store_u32_be(ctx->data + Traits::kBlockSize - 4, ctx->Nl);
  } else {
    CRYPTO_store_u32_le(ctx->data + Traits::kBlockSize - 8, ctx->Nl);
    CRYPTO_store_u32_le(ctx->data + Traits::kBlockSize - 4, ctx->Nh);
  }
  Traits::HashBlocks(ctx->h, ctx->data, 1);
  ctx->num = 0;
  OPENSSL_memset(ctx->data, 0, Traits::kBlockSize);
}


BSSL_NAMESPACE_END

#endif  // OPENSSL_HEADER_CRYPTO_FIPSMODULE_DIGEST_MD32_COMMON_H
