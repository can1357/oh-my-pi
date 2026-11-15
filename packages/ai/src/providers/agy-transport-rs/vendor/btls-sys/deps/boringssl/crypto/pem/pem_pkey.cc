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
#include <string.h>

#include <openssl/dh.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/pkcs8.h>
#include <openssl/rand.h>
#include <openssl/x509.h>

EVP_PKEY *PEM_read_bio_PrivateKey(BIO *bp, EVP_PKEY **x, pem_password_cb *cb,
                                  void *u) {
  char *nm = nullptr;
  const unsigned char *p = nullptr;
  unsigned char *data = nullptr;
  long len;
  EVP_PKEY *ret = nullptr;

  if (!PEM_bytes_read_bio(&data, &len, &nm, PEM_STRING_EVP_PKEY, bp, cb, u)) {
    return nullptr;
  }
  p = data;

  if (strcmp(nm, PEM_STRING_PKCS8INF) == 0) {
    PKCS8_PRIV_KEY_INFO *p8inf;
    p8inf = d2i_PKCS8_PRIV_KEY_INFO(nullptr, &p, len);
    if (!p8inf) {
      goto p8err;
    }
    ret = EVP_PKCS82PKEY(p8inf);
    if (x) {
      if (*x) {
        EVP_PKEY_free((EVP_PKEY *)*x);
      }
      *x = ret;
    }
    PKCS8_PRIV_KEY_INFO_free(p8inf);
  } else if (strcmp(nm, PEM_STRING_PKCS8) == 0) {
    PKCS8_PRIV_KEY_INFO *p8inf;
    X509_SIG *p8;
    int pass_len;
    char psbuf[PEM_BUFSIZE];
    p8 = d2i_X509_SIG(nullptr, &p, len);
    if (!p8) {
      goto p8err;
    }

    pass_len = 0;
    if (!cb) {
      cb = PEM_def_callback;
    }
    pass_len = cb(psbuf, PEM_BUFSIZE, 0, u);
    if (pass_len < 0) {
      OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_PASSWORD_READ);
      X509_SIG_free(p8);
      goto err;
    }
    p8inf = PKCS8_decrypt(p8, psbuf, pass_len);
    X509_SIG_free(p8);
    OPENSSL_cleanse(psbuf, pass_len);
    if (!p8inf) {
      goto p8err;
    }
    ret = EVP_PKCS82PKEY(p8inf);
    if (x) {
      if (*x) {
        EVP_PKEY_free((EVP_PKEY *)*x);
      }
      *x = ret;
    }
    PKCS8_PRIV_KEY_INFO_free(p8inf);
  } else if (strcmp(nm, PEM_STRING_RSA) == 0) {
    // TODO(davidben): d2i_PrivateKey parses PKCS#8 along with the
    // standalone format. This and the cases below probably should not
    // accept PKCS#8.
    ret = d2i_PrivateKey(EVP_PKEY_RSA, x, &p, len);
  } else if (strcmp(nm, PEM_STRING_EC) == 0) {
    ret = d2i_PrivateKey(EVP_PKEY_EC, x, &p, len);
  } else if (strcmp(nm, PEM_STRING_DSA) == 0) {
    ret = d2i_PrivateKey(EVP_PKEY_DSA, x, &p, len);
  }
p8err:
  if (ret == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_ASN1_LIB);
  }

err:
  OPENSSL_free(nm);
  OPENSSL_free(data);
  return ret;
}

int PEM_write_bio_PrivateKey(BIO *bp, EVP_PKEY *x, const EVP_CIPHER *enc,
                             const unsigned char *pass, int pass_len,
                             pem_password_cb *cb, void *u) {
  return PEM_write_bio_PKCS8PrivateKey(bp, x, enc, (const char *)pass, pass_len,
                                       cb, u);
}

EVP_PKEY *PEM_read_PrivateKey(FILE *fp, EVP_PKEY **x, pem_password_cb *cb,
                              void *u) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return nullptr;
  }
  EVP_PKEY *ret = PEM_read_bio_PrivateKey(b, x, cb, u);
  BIO_free(b);
  return ret;
}

int PEM_write_PrivateKey(FILE *fp, EVP_PKEY *x, const EVP_CIPHER *enc,
                         const unsigned char *pass, int pass_len,
                         pem_password_cb *cb, void *u) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return 0;
  }
  int ret = PEM_write_bio_PrivateKey(b, x, enc, pass, pass_len, cb, u);
  BIO_free(b);
  return ret;
}
