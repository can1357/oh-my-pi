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

#include <openssl/asn1.h>

#include <openssl/bio.h>

int i2a_ASN1_INTEGER(BIO *bp, const ASN1_INTEGER *a) {
  int i, n = 0;
  static const char *h = "0123456789ABCDEF";
  char buf[2];

  if (a == nullptr) {
    return 0;
  }

  if (a->type & V_ASN1_NEG) {
    if (BIO_write(bp, "-", 1) != 1) {
      goto err;
    }
    n = 1;
  }

  if (a->length == 0) {
    if (BIO_write(bp, "00", 2) != 2) {
      goto err;
    }
    n += 2;
  } else {
    for (i = 0; i < a->length; i++) {
      if ((i != 0) && (i % 35 == 0)) {
        if (BIO_write(bp, "\\\n", 2) != 2) {
          goto err;
        }
        n += 2;
      }
      buf[0] = h[((unsigned char)a->data[i] >> 4) & 0x0f];
      buf[1] = h[((unsigned char)a->data[i]) & 0x0f];
      if (BIO_write(bp, buf, 2) != 2) {
        goto err;
      }
      n += 2;
    }
  }
  return n;
err:
  return -1;
}

int i2a_ASN1_ENUMERATED(BIO *bp, const ASN1_ENUMERATED *a) {
  return i2a_ASN1_INTEGER(bp, a);
}
