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

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include <openssl/dsa.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>

#include "internal.h"


static X509_PKEY *X509_PKEY_new(void) {
  return reinterpret_cast<X509_PKEY *>(OPENSSL_zalloc(sizeof(X509_PKEY)));
}

static void X509_PKEY_free(X509_PKEY *x) {
  if (x == nullptr) {
    return;
  }

  EVP_PKEY_free(x->dec_pkey);
  OPENSSL_free(x);
}

static X509_INFO *X509_INFO_new(void) {
  return reinterpret_cast<X509_INFO *>(OPENSSL_zalloc(sizeof(X509_INFO)));
}

void X509_INFO_free(X509_INFO *x) {
  if (x == nullptr) {
    return;
  }

  X509_free(x->x509);
  X509_CRL_free(x->crl);
  X509_PKEY_free(x->x_pkey);
  OPENSSL_free(x->enc_data);
  OPENSSL_free(x);
}


STACK_OF(X509_INFO) *PEM_X509_INFO_read(FILE *fp, STACK_OF(X509_INFO) *sk,
                                        pem_password_cb *cb, void *u) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return nullptr;
  }
  STACK_OF(X509_INFO) *ret = PEM_X509_INFO_read_bio(b, sk, cb, u);
  BIO_free(b);
  return ret;
}

enum parse_result_t {
  parse_ok,
  parse_error,
  parse_new_entry,
};

static enum parse_result_t parse_x509(X509_INFO *info, const uint8_t *data,
                                      size_t len, int key_type) {
  if (info->x509 != nullptr) {
    return parse_new_entry;
  }
  info->x509 = d2i_X509(nullptr, &data, len);
  return info->x509 != nullptr ? parse_ok : parse_error;
}

static enum parse_result_t parse_x509_aux(X509_INFO *info, const uint8_t *data,
                                          size_t len, int key_type) {
  if (info->x509 != nullptr) {
    return parse_new_entry;
  }
  info->x509 = d2i_X509_AUX(nullptr, &data, len);
  return info->x509 != nullptr ? parse_ok : parse_error;
}

static enum parse_result_t parse_crl(X509_INFO *info, const uint8_t *data,
                                     size_t len, int key_type) {
  if (info->crl != nullptr) {
    return parse_new_entry;
  }
  info->crl = d2i_X509_CRL(nullptr, &data, len);
  return info->crl != nullptr ? parse_ok : parse_error;
}

static enum parse_result_t parse_key(X509_INFO *info, const uint8_t *data,
                                     size_t len, int key_type) {
  if (info->x_pkey != nullptr) {
    return parse_new_entry;
  }
  info->x_pkey = X509_PKEY_new();
  if (info->x_pkey == nullptr) {
    return parse_error;
  }
  info->x_pkey->dec_pkey = d2i_PrivateKey(key_type, nullptr, &data, len);
  return info->x_pkey->dec_pkey != nullptr ? parse_ok : parse_error;
}

STACK_OF(X509_INFO) *PEM_X509_INFO_read_bio(BIO *bp, STACK_OF(X509_INFO) *sk,
                                            pem_password_cb *cb, void *u) {
  X509_INFO *info = nullptr;
  char *name = nullptr, *header = nullptr;
  unsigned char *data = nullptr;
  long len;
  int ok = 0;
  STACK_OF(X509_INFO) *ret = nullptr;

  if (sk == nullptr) {
    ret = sk_X509_INFO_new_null();
    if (ret == nullptr) {
      return nullptr;
    }
  } else {
    ret = sk;
  }
  size_t orig_num = sk_X509_INFO_num(ret);

  info = X509_INFO_new();
  if (info == nullptr) {
    goto err;
  }

  for (;;) {
    if (!PEM_read_bio(bp, &name, &header, &data, &len)) {
      if (ERR_equals(ERR_peek_last_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE)) {
        ERR_clear_error();
        break;
      }
      goto err;
    }

    enum parse_result_t (*parse_function)(X509_INFO *, const uint8_t *, size_t,
                                          int) = nullptr;
    int key_type = EVP_PKEY_NONE;
    if (strcmp(name, PEM_STRING_X509) == 0 ||
        strcmp(name, PEM_STRING_X509_OLD) == 0) {
      parse_function = parse_x509;
    } else if (strcmp(name, PEM_STRING_X509_TRUSTED) == 0) {
      parse_function = parse_x509_aux;
    } else if (strcmp(name, PEM_STRING_X509_CRL) == 0) {
      parse_function = parse_crl;
    } else if (strcmp(name, PEM_STRING_RSA) == 0) {
      parse_function = parse_key;
      key_type = EVP_PKEY_RSA;
    } else if (strcmp(name, PEM_STRING_DSA) == 0) {
      parse_function = parse_key;
      key_type = EVP_PKEY_DSA;
    } else if (strcmp(name, PEM_STRING_ECPRIVATEKEY) == 0) {
      parse_function = parse_key;
      key_type = EVP_PKEY_EC;
    }

    // If a private key has a header, assume it is encrypted. This function does
    // not decrypt private keys.
    if (key_type != EVP_PKEY_NONE && strlen(header) > 10) {
      if (info->x_pkey != nullptr) {
        if (!sk_X509_INFO_push(ret, info)) {
          goto err;
        }
        info = X509_INFO_new();
        if (info == nullptr) {
          goto err;
        }
      }
      // Use an empty key as a placeholder.
      info->x_pkey = X509_PKEY_new();
      if (info->x_pkey == nullptr ||
          !PEM_get_EVP_CIPHER_INFO(header, &info->enc_cipher)) {
        goto err;
      }
      info->enc_data = (char *)data;
      info->enc_len = (int)len;
      data = nullptr;
    } else if (parse_function != nullptr) {
      EVP_CIPHER_INFO cipher;
      if (!PEM_get_EVP_CIPHER_INFO(header, &cipher) ||
          !PEM_do_header(&cipher, data, &len, cb, u)) {
        goto err;
      }
      enum parse_result_t result = parse_function(info, data, len, key_type);
      if (result == parse_new_entry) {
        if (!sk_X509_INFO_push(ret, info)) {
          goto err;
        }
        info = X509_INFO_new();
        if (info == nullptr) {
          goto err;
        }
        result = parse_function(info, data, len, key_type);
      }
      if (result != parse_ok) {
        OPENSSL_PUT_ERROR(PEM, ERR_R_ASN1_LIB);
        goto err;
      }
    }
    OPENSSL_free(name);
    OPENSSL_free(header);
    OPENSSL_free(data);
    name = nullptr;
    header = nullptr;
    data = nullptr;
  }

  // Push the last entry on the stack if not empty.
  if (info->x509 != nullptr || info->crl != nullptr ||
      info->x_pkey != nullptr || info->enc_data != nullptr) {
    if (!sk_X509_INFO_push(ret, info)) {
      goto err;
    }
    info = nullptr;
  }

  ok = 1;

err:
  X509_INFO_free(info);
  if (!ok) {
    while (sk_X509_INFO_num(ret) > orig_num) {
      X509_INFO_free(sk_X509_INFO_pop(ret));
    }
    if (ret != sk) {
      sk_X509_INFO_free(ret);
    }
    ret = nullptr;
  }

  OPENSSL_free(name);
  OPENSSL_free(header);
  OPENSSL_free(data);
  return ret;
}
