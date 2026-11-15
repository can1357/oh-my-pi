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

#include <string.h>

#include <openssl/des.h>

#include "../../crypto/des/internal.h"
#include "../../crypto/internal.h"


// The input and output encrypted as though 64bit cfb mode is being used. The
// extra state information to record how much of the 64bit block we have used
// is contained in *num;
void DES_ede3_cfb64_encrypt(const uint8_t *in, uint8_t *out,
                            long length, DES_key_schedule *ks1,
                            DES_key_schedule *ks2, DES_key_schedule *ks3,
                            DES_cblock *ivec, int *num, int enc) {
  uint32_t v0, v1;
  long l = length;
  int n = *num;
  uint32_t ti[2];
  uint8_t *iv, c, cc;

  iv = ivec->bytes;
  if (enc) {
    while (l--) {
      if (n == 0) {
        c2l(iv, v0);
        c2l(iv, v1);

        ti[0] = v0;
        ti[1] = v1;
        DES_encrypt3(ti, ks1, ks2, ks3);
        v0 = ti[0];
        v1 = ti[1];

        iv = ivec->bytes;
        l2c(v0, iv);
        l2c(v1, iv);
        iv = ivec->bytes;
      }
      c = *(in++) ^ iv[n];
      *(out++) = c;
      iv[n] = c;
      n = (n + 1) & 0x07;
    }
  } else {
    while (l--) {
      if (n == 0) {
        c2l(iv, v0);
        c2l(iv, v1);

        ti[0] = v0;
        ti[1] = v1;
        DES_encrypt3(ti, ks1, ks2, ks3);
        v0 = ti[0];
        v1 = ti[1];

        iv = ivec->bytes;
        l2c(v0, iv);
        l2c(v1, iv);
        iv = ivec->bytes;
      }
      cc = *(in++);
      c = iv[n];
      iv[n] = cc;
      *(out++) = c ^ cc;
      n = (n + 1) & 0x07;
    }
  }
  v0 = v1 = ti[0] = ti[1] = c = cc = 0;
  *num = n;
}

// This is compatible with the single key CFB-r for DES, even thought that's
// not what EVP needs.

void DES_ede3_cfb_encrypt(const uint8_t *in, uint8_t *out, int numbits,
                          long length, DES_key_schedule *ks1,
                          DES_key_schedule *ks2, DES_key_schedule *ks3,
                          DES_cblock *ivec, int enc) {
  uint32_t d0, d1, v0, v1;
  unsigned long l = length, n = ((unsigned int)numbits + 7) / 8;
  int num = numbits, i;
  uint32_t ti[2];
  uint8_t *iv;
  uint8_t ovec[16];

  if (num > 64) {
    return;
  }

  iv = ivec->bytes;
  c2l(iv, v0);
  c2l(iv, v1);

  if (enc) {
    while (l >= n) {
      l -= n;
      ti[0] = v0;
      ti[1] = v1;
      DES_encrypt3(ti, ks1, ks2, ks3);
      c2ln(in, d0, d1, n);
      in += n;
      d0 ^= ti[0];
      d1 ^= ti[1];
      l2cn(d0, d1, out, n);
      out += n;
      // 30-08-94 - eay - changed because l>>32 and l<<32 are bad under
      // gcc :-(
      if (num == 32) {
        v0 = v1;
        v1 = d0;
      } else if (num == 64) {
        v0 = d0;
        v1 = d1;
      } else {
        iv = &ovec[0];
        l2c(v0, iv);
        l2c(v1, iv);
        l2c(d0, iv);
        l2c(d1, iv);
        // shift ovec left most of the bits...
        OPENSSL_memmove(ovec, ovec + num / 8, 8 + (num % 8 ? 1 : 0));
        // now the remaining bits
        if (num % 8 != 0) {
          for (i = 0; i < 8; ++i) {
            ovec[i] <<= num % 8;
            ovec[i] |= ovec[i + 1] >> (8 - num % 8);
          }
        }
        iv = &ovec[0];
        c2l(iv, v0);
        c2l(iv, v1);
      }
    }
  } else {
    while (l >= n) {
      l -= n;
      ti[0] = v0;
      ti[1] = v1;
      DES_encrypt3(ti, ks1, ks2, ks3);
      c2ln(in, d0, d1, n);
      in += n;
      // 30-08-94 - eay - changed because l>>32 and l<<32 are bad under
      // gcc :-(
      if (num == 32) {
        v0 = v1;
        v1 = d0;
      } else if (num == 64) {
        v0 = d0;
        v1 = d1;
      } else {
        iv = &ovec[0];
        l2c(v0, iv);
        l2c(v1, iv);
        l2c(d0, iv);
        l2c(d1, iv);
        // shift ovec left most of the bits...
        OPENSSL_memmove(ovec, ovec + num / 8, 8 + (num % 8 ? 1 : 0));
        // now the remaining bits
        if (num % 8 != 0) {
          for (i = 0; i < 8; ++i) {
            ovec[i] <<= num % 8;
            ovec[i] |= ovec[i + 1] >> (8 - num % 8);
          }
        }
        iv = &ovec[0];
        c2l(iv, v0);
        c2l(iv, v1);
      }
      d0 ^= ti[0];
      d1 ^= ti[1];
      l2cn(d0, d1, out, n);
      out += n;
    }
  }

  iv = ivec->bytes;
  l2c(v0, iv);
  l2c(v1, iv);
  v0 = v1 = d0 = d1 = ti[0] = ti[1] = 0;
}
