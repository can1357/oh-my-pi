// Copyright 2004-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <stdint.h>
#include <string.h>


// This is a copy of the SHA-384 code for the purpose of isolating the jitter
// entropy source certification from any changes to the normal implementation.

namespace bssl::entropy {
namespace {

constexpr size_t kSHA384Block = 128;
constexpr size_t kSHA384DigestLength = (384 / 8);

struct SHA512_CTX {
  uint64_t h[8];
  uint64_t Nl, Nh;
  uint8_t p[kSHA384Block];
  unsigned num, md_len;
};

uint64_t CRYPTO_bswap8(uint64_t x) { return __builtin_bswap64(x); }

uint64_t CRYPTO_load_u64_be(const void *ptr) {
  uint64_t ret;
  memcpy(&ret, ptr, sizeof(ret));
  return CRYPTO_bswap8(ret);
}

void CRYPTO_store_u64_be(void *out, uint64_t v) {
  v = CRYPTO_bswap8(v);
  memcpy(out, &v, sizeof(v));
}

uint64_t CRYPTO_rotr_u64(uint64_t value, int shift) {
  return (value >> shift) | (value << ((-shift) & 63));
}

void sha512_update(SHA512_CTX *c, const void *in_data, size_t len);
void sha512_final_impl(uint8_t *out, size_t md_len, SHA512_CTX *sha);

void SHA384_Init(SHA512_CTX *sha) {
  sha->h[0] = UINT64_C(0xcbbb9d5dc1059ed8);
  sha->h[1] = UINT64_C(0x629a292a367cd507);
  sha->h[2] = UINT64_C(0x9159015a3070dd17);
  sha->h[3] = UINT64_C(0x152fecd8f70e5939);
  sha->h[4] = UINT64_C(0x67332667ffc00b31);
  sha->h[5] = UINT64_C(0x8eb44a8768581511);
  sha->h[6] = UINT64_C(0xdb0c2e0d64f98fa7);
  sha->h[7] = UINT64_C(0x47b5481dbefa4fa4);

  sha->Nl = 0;
  sha->Nh = 0;
  sha->num = 0;
  sha->md_len = kSHA384DigestLength;
  return;
}

void SHA384_Final(uint8_t out[kSHA384DigestLength], SHA512_CTX *sha) {
  // This function must be paired with |SHA384_Init|, which sets
  // |sha->md_len| to |kSHA384DigestLength|.
  sha512_final_impl(out, kSHA384DigestLength, sha);
  return;
}

void SHA384_Update(SHA512_CTX *sha, const void *data, size_t len) {
  return sha512_update(sha, data, len);
}

void sha512_block_data_order(uint64_t state[8], const uint8_t *in,
                             size_t num_blocks);

void sha512_final_impl(uint8_t *out, size_t md_len, SHA512_CTX *sha) {
  uint8_t *p = sha->p;
  size_t n = sha->num;

  p[n] = 0x80;  // There always is a room for one
  n++;
  if (n > (sizeof(sha->p) - 16)) {
    memset(p + n, 0, sizeof(sha->p) - n);
    n = 0;
    sha512_block_data_order(sha->h, p, 1);
  }

  memset(p + n, 0, sizeof(sha->p) - 16 - n);
  CRYPTO_store_u64_be(p + sizeof(sha->p) - 16, sha->Nh);
  CRYPTO_store_u64_be(p + sizeof(sha->p) - 8, sha->Nl);

  sha512_block_data_order(sha->h, p, 1);

  const size_t out_words = md_len / 8;
  for (size_t i = 0; i < out_words; i++) {
    CRYPTO_store_u64_be(out, sha->h[i]);
    out += 8;
  }
}

const uint64_t K512[80] = {
    UINT64_C(0x428a2f98d728ae22), UINT64_C(0x7137449123ef65cd),
    UINT64_C(0xb5c0fbcfec4d3b2f), UINT64_C(0xe9b5dba58189dbbc),
    UINT64_C(0x3956c25bf348b538), UINT64_C(0x59f111f1b605d019),
    UINT64_C(0x923f82a4af194f9b), UINT64_C(0xab1c5ed5da6d8118),
    UINT64_C(0xd807aa98a3030242), UINT64_C(0x12835b0145706fbe),
    UINT64_C(0x243185be4ee4b28c), UINT64_C(0x550c7dc3d5ffb4e2),
    UINT64_C(0x72be5d74f27b896f), UINT64_C(0x80deb1fe3b1696b1),
    UINT64_C(0x9bdc06a725c71235), UINT64_C(0xc19bf174cf692694),
    UINT64_C(0xe49b69c19ef14ad2), UINT64_C(0xefbe4786384f25e3),
    UINT64_C(0x0fc19dc68b8cd5b5), UINT64_C(0x240ca1cc77ac9c65),
    UINT64_C(0x2de92c6f592b0275), UINT64_C(0x4a7484aa6ea6e483),
    UINT64_C(0x5cb0a9dcbd41fbd4), UINT64_C(0x76f988da831153b5),
    UINT64_C(0x983e5152ee66dfab), UINT64_C(0xa831c66d2db43210),
    UINT64_C(0xb00327c898fb213f), UINT64_C(0xbf597fc7beef0ee4),
    UINT64_C(0xc6e00bf33da88fc2), UINT64_C(0xd5a79147930aa725),
    UINT64_C(0x06ca6351e003826f), UINT64_C(0x142929670a0e6e70),
    UINT64_C(0x27b70a8546d22ffc), UINT64_C(0x2e1b21385c26c926),
    UINT64_C(0x4d2c6dfc5ac42aed), UINT64_C(0x53380d139d95b3df),
    UINT64_C(0x650a73548baf63de), UINT64_C(0x766a0abb3c77b2a8),
    UINT64_C(0x81c2c92e47edaee6), UINT64_C(0x92722c851482353b),
    UINT64_C(0xa2bfe8a14cf10364), UINT64_C(0xa81a664bbc423001),
    UINT64_C(0xc24b8b70d0f89791), UINT64_C(0xc76c51a30654be30),
    UINT64_C(0xd192e819d6ef5218), UINT64_C(0xd69906245565a910),
    UINT64_C(0xf40e35855771202a), UINT64_C(0x106aa07032bbd1b8),
    UINT64_C(0x19a4c116b8d2d0c8), UINT64_C(0x1e376c085141ab53),
    UINT64_C(0x2748774cdf8eeb99), UINT64_C(0x34b0bcb5e19b48a8),
    UINT64_C(0x391c0cb3c5c95a63), UINT64_C(0x4ed8aa4ae3418acb),
    UINT64_C(0x5b9cca4f7763e373), UINT64_C(0x682e6ff3d6b2b8a3),
    UINT64_C(0x748f82ee5defb2fc), UINT64_C(0x78a5636f43172f60),
    UINT64_C(0x84c87814a1f0ab72), UINT64_C(0x8cc702081a6439ec),
    UINT64_C(0x90befffa23631e28), UINT64_C(0xa4506cebde82bde9),
    UINT64_C(0xbef9a3f7b2c67915), UINT64_C(0xc67178f2e372532b),
    UINT64_C(0xca273eceea26619c), UINT64_C(0xd186b8c721c0c207),
    UINT64_C(0xeada7dd6cde0eb1e), UINT64_C(0xf57d4f7fee6ed178),
    UINT64_C(0x06f067aa72176fba), UINT64_C(0x0a637dc5a2c898a6),
    UINT64_C(0x113f9804bef90dae), UINT64_C(0x1b710b35131c471b),
    UINT64_C(0x28db77f523047d84), UINT64_C(0x32caab7b40c72493),
    UINT64_C(0x3c9ebe0a15c9bebc), UINT64_C(0x431d67c49c100d4c),
    UINT64_C(0x4cc5d4becb3e42b6), UINT64_C(0x597f299cfc657e2a),
    UINT64_C(0x5fcb6fab3ad6faec), UINT64_C(0x6c44198c4a475817),
};

#define Sigma0(x)                                        \
  (CRYPTO_rotr_u64((x), 28) ^ CRYPTO_rotr_u64((x), 34) ^ \
   CRYPTO_rotr_u64((x), 39))
#define Sigma1(x)                                        \
  (CRYPTO_rotr_u64((x), 14) ^ CRYPTO_rotr_u64((x), 18) ^ \
   CRYPTO_rotr_u64((x), 41))
#define sigma0(x) \
  (CRYPTO_rotr_u64((x), 1) ^ CRYPTO_rotr_u64((x), 8) ^ ((x) >> 7))
#define sigma1(x) \
  (CRYPTO_rotr_u64((x), 19) ^ CRYPTO_rotr_u64((x), 61) ^ ((x) >> 6))

#define Ch(x, y, z) (((x) & (y)) ^ ((~(x)) & (z)))
#define Maj(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))

#define ROUND_00_15(i, a, b, c, d, e, f, g, h)   \
  do {                                           \
    T1 += h + Sigma1(e) + Ch(e, f, g) + K512[i]; \
    h = Sigma0(a) + Maj(a, b, c);                \
    d += T1;                                     \
    h += T1;                                     \
  } while (0)

#define ROUND_16_80(i, j, a, b, c, d, e, f, g, h, X)   \
  do {                                                 \
    s0 = X[(j + 1) & 0x0f];                            \
    s0 = sigma0(s0);                                   \
    s1 = X[(j + 14) & 0x0f];                           \
    s1 = sigma1(s1);                                   \
    T1 = X[(j) & 0x0f] += s0 + s1 + X[(j + 9) & 0x0f]; \
    ROUND_00_15(i + j, a, b, c, d, e, f, g, h);        \
  } while (0)

void sha512_block_data_order(uint64_t state[8], const uint8_t *in, size_t num) {
  uint64_t a, b, c, d, e, f, g, h, s0, s1, T1;
  uint64_t X[16];
  int i;

  while (num--) {
    a = state[0];
    b = state[1];
    c = state[2];
    d = state[3];
    e = state[4];
    f = state[5];
    g = state[6];
    h = state[7];

    T1 = X[0] = CRYPTO_load_u64_be(in);
    ROUND_00_15(0, a, b, c, d, e, f, g, h);
    T1 = X[1] = CRYPTO_load_u64_be(in + 8);
    ROUND_00_15(1, h, a, b, c, d, e, f, g);
    T1 = X[2] = CRYPTO_load_u64_be(in + 2 * 8);
    ROUND_00_15(2, g, h, a, b, c, d, e, f);
    T1 = X[3] = CRYPTO_load_u64_be(in + 3 * 8);
    ROUND_00_15(3, f, g, h, a, b, c, d, e);
    T1 = X[4] = CRYPTO_load_u64_be(in + 4 * 8);
    ROUND_00_15(4, e, f, g, h, a, b, c, d);
    T1 = X[5] = CRYPTO_load_u64_be(in + 5 * 8);
    ROUND_00_15(5, d, e, f, g, h, a, b, c);
    T1 = X[6] = CRYPTO_load_u64_be(in + 6 * 8);
    ROUND_00_15(6, c, d, e, f, g, h, a, b);
    T1 = X[7] = CRYPTO_load_u64_be(in + 7 * 8);
    ROUND_00_15(7, b, c, d, e, f, g, h, a);
    T1 = X[8] = CRYPTO_load_u64_be(in + 8 * 8);
    ROUND_00_15(8, a, b, c, d, e, f, g, h);
    T1 = X[9] = CRYPTO_load_u64_be(in + 9 * 8);
    ROUND_00_15(9, h, a, b, c, d, e, f, g);
    T1 = X[10] = CRYPTO_load_u64_be(in + 10 * 8);
    ROUND_00_15(10, g, h, a, b, c, d, e, f);
    T1 = X[11] = CRYPTO_load_u64_be(in + 11 * 8);
    ROUND_00_15(11, f, g, h, a, b, c, d, e);
    T1 = X[12] = CRYPTO_load_u64_be(in + 12 * 8);
    ROUND_00_15(12, e, f, g, h, a, b, c, d);
    T1 = X[13] = CRYPTO_load_u64_be(in + 13 * 8);
    ROUND_00_15(13, d, e, f, g, h, a, b, c);
    T1 = X[14] = CRYPTO_load_u64_be(in + 14 * 8);
    ROUND_00_15(14, c, d, e, f, g, h, a, b);
    T1 = X[15] = CRYPTO_load_u64_be(in + 15 * 8);
    ROUND_00_15(15, b, c, d, e, f, g, h, a);

    for (i = 16; i < 80; i += 16) {
      ROUND_16_80(i, 0, a, b, c, d, e, f, g, h, X);
      ROUND_16_80(i, 1, h, a, b, c, d, e, f, g, X);
      ROUND_16_80(i, 2, g, h, a, b, c, d, e, f, X);
      ROUND_16_80(i, 3, f, g, h, a, b, c, d, e, X);
      ROUND_16_80(i, 4, e, f, g, h, a, b, c, d, X);
      ROUND_16_80(i, 5, d, e, f, g, h, a, b, c, X);
      ROUND_16_80(i, 6, c, d, e, f, g, h, a, b, X);
      ROUND_16_80(i, 7, b, c, d, e, f, g, h, a, X);
      ROUND_16_80(i, 8, a, b, c, d, e, f, g, h, X);
      ROUND_16_80(i, 9, h, a, b, c, d, e, f, g, X);
      ROUND_16_80(i, 10, g, h, a, b, c, d, e, f, X);
      ROUND_16_80(i, 11, f, g, h, a, b, c, d, e, X);
      ROUND_16_80(i, 12, e, f, g, h, a, b, c, d, X);
      ROUND_16_80(i, 13, d, e, f, g, h, a, b, c, X);
      ROUND_16_80(i, 14, c, d, e, f, g, h, a, b, X);
      ROUND_16_80(i, 15, b, c, d, e, f, g, h, a, X);
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;

    in += 16 * 8;
  }
}

#undef Sigma0
#undef Sigma1
#undef sigma0
#undef sigma1
#undef Ch
#undef Maj
#undef ROUND_00_15
#undef ROUND_16_80

void sha512_update(SHA512_CTX *c, const void *in_data, size_t len) {
  uint64_t l;
  uint8_t *p = c->p;
  const uint8_t *data = reinterpret_cast<const uint8_t *>(in_data);

  if (len == 0) {
    return;
  }

  l = (c->Nl + (((uint64_t)len) << 3)) & UINT64_C(0xffffffffffffffff);
  if (l < c->Nl) {
    c->Nh++;
  }
  if (sizeof(len) >= 8) {
    c->Nh += (((uint64_t)len) >> 61);
  }
  c->Nl = l;

  if (c->num != 0) {
    size_t n = sizeof(c->p) - c->num;

    if (len < n) {
      memcpy(p + c->num, data, len);
      c->num += (unsigned int)len;
      return;
    } else {
      memcpy(p + c->num, data, n), c->num = 0;
      len -= n;
      data += n;
      sha512_block_data_order(c->h, p, 1);
    }
  }

  if (len >= sizeof(c->p)) {
    sha512_block_data_order(c->h, data, len / sizeof(c->p));
    data += len;
    len %= sizeof(c->p);
    data -= len;
  }

  if (len != 0) {
    memcpy(p, data, len);
    c->num = (int)len;
  }

  return;
}

}  // namespace
}  // namespace bssl::entropy
