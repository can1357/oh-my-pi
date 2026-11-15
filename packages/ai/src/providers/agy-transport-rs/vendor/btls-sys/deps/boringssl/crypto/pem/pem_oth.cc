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

#include <openssl/pem.h>

#include <stdio.h>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/rand.h>
#include <openssl/x509.h>

// Handle 'other' PEMs: not private keys

void *PEM_ASN1_read_bio(d2i_of_void *d2i, const char *name, BIO *bp, void **x,
                        pem_password_cb *cb, void *u) {
  const unsigned char *p = nullptr;
  unsigned char *data = nullptr;
  long len;
  char *ret = nullptr;

  if (!PEM_bytes_read_bio(&data, &len, nullptr, name, bp, cb, u)) {
    return nullptr;
  }
  p = data;
  ret = reinterpret_cast<char *>(d2i(x, &p, len));
  if (ret == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_ASN1_LIB);
  }
  OPENSSL_free(data);
  return ret;
}
