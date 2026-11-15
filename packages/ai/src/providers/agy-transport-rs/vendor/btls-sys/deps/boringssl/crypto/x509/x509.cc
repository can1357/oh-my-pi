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

#include <openssl/x509.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/mem.h>


// |X509_R_UNSUPPORTED_ALGORITHM| is no longer emitted, but continue to define
// it to avoid downstream churn.
OPENSSL_DECLARE_ERROR_REASON(X509, UNSUPPORTED_ALGORITHM)

int X509_signature_dump(BIO *bp, const ASN1_STRING *sig, int indent) {
  const uint8_t *s;
  int i, n;

  n = sig->length;
  s = sig->data;
  for (i = 0; i < n; i++) {
    if ((i % 18) == 0) {
      if (BIO_write(bp, "\n", 1) <= 0 || BIO_indent(bp, indent, indent) <= 0) {
        return 0;
      }
    }
    if (BIO_printf(bp, "%02x%s", s[i], ((i + 1) == n) ? "" : ":") <= 0) {
      return 0;
    }
  }
  if (BIO_write(bp, "\n", 1) != 1) {
    return 0;
  }

  return 1;
}
