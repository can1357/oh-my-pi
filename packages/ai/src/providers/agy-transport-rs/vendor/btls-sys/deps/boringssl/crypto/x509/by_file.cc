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

#include <stdlib.h>

#include <openssl/err.h>
#include <openssl/pem.h>

#include "internal.h"


static int by_file_ctrl(X509_LOOKUP *ctx, int cmd, const char *argc, long argl,
                        char **ret);
static const X509_LOOKUP_METHOD x509_file_lookup = {
    nullptr,       // new
    nullptr,       // free
    by_file_ctrl,  // ctrl
    nullptr,       // get_by_subject
};

const X509_LOOKUP_METHOD *X509_LOOKUP_file(void) { return &x509_file_lookup; }

static int by_file_ctrl(X509_LOOKUP *ctx, int cmd, const char *argp, long argl,
                        char **ret) {
  if (cmd != X509_L_FILE_LOAD) {
    return 0;
  }
  const char *file = argp;
  int type = argl;
  if (argl == X509_FILETYPE_DEFAULT) {
    if ((file = getenv(X509_get_default_cert_file_env())) == nullptr) {
      file = X509_get_default_cert_file();
    }
    type = X509_FILETYPE_PEM;
  }
  if (X509_load_cert_crl_file(ctx, file, type) != 0) {
    return 1;
  }
  if (argl == X509_FILETYPE_DEFAULT) {
    OPENSSL_PUT_ERROR(X509, X509_R_LOADING_DEFAULTS);
  }
  return 0;
}

int X509_load_cert_file(X509_LOOKUP *ctx, const char *file, int type) {
  int ret = 0;
  BIO *in = nullptr;
  int i, count = 0;
  X509 *x = nullptr;

  in = BIO_new(BIO_s_file());

  if ((in == nullptr) || (BIO_read_filename(in, file) <= 0)) {
    OPENSSL_PUT_ERROR(X509, ERR_R_SYS_LIB);
    goto err;
  }

  if (type == X509_FILETYPE_PEM) {
    for (;;) {
      x = PEM_read_bio_X509_AUX(in, nullptr, nullptr, nullptr);
      if (x == nullptr) {
        if (ERR_equals(ERR_peek_last_error(), ERR_LIB_PEM,
                       PEM_R_NO_START_LINE) &&
            count > 0) {
          ERR_clear_error();
          break;
        }
        OPENSSL_PUT_ERROR(X509, ERR_R_PEM_LIB);
        goto err;
      }
      i = X509_STORE_add_cert(ctx->store_ctx, x);
      if (!i) {
        goto err;
      }
      count++;
      X509_free(x);
      x = nullptr;
    }
    ret = count;
  } else if (type == X509_FILETYPE_ASN1) {
    x = d2i_X509_bio(in, nullptr);
    if (x == nullptr) {
      OPENSSL_PUT_ERROR(X509, ERR_R_ASN1_LIB);
      goto err;
    }
    i = X509_STORE_add_cert(ctx->store_ctx, x);
    if (!i) {
      goto err;
    }
    ret = i;
  } else {
    OPENSSL_PUT_ERROR(X509, X509_R_BAD_X509_FILETYPE);
    goto err;
  }

  if (ret == 0) {
    OPENSSL_PUT_ERROR(X509, X509_R_NO_CERTIFICATE_FOUND);
  }

err:
  X509_free(x);
  BIO_free(in);
  return ret;
}

int X509_load_crl_file(X509_LOOKUP *ctx, const char *file, int type) {
  int ret = 0;
  BIO *in = nullptr;
  int i, count = 0;
  X509_CRL *x = nullptr;

  in = BIO_new(BIO_s_file());

  if ((in == nullptr) || (BIO_read_filename(in, file) <= 0)) {
    OPENSSL_PUT_ERROR(X509, ERR_R_SYS_LIB);
    goto err;
  }

  if (type == X509_FILETYPE_PEM) {
    for (;;) {
      x = PEM_read_bio_X509_CRL(in, nullptr, nullptr, nullptr);
      if (x == nullptr) {
        if (ERR_equals(ERR_peek_last_error(), ERR_LIB_PEM,
                       PEM_R_NO_START_LINE) &&
            count > 0) {
          ERR_clear_error();
          break;
        }
        OPENSSL_PUT_ERROR(X509, ERR_R_PEM_LIB);
        goto err;
      }
      i = X509_STORE_add_crl(ctx->store_ctx, x);
      if (!i) {
        goto err;
      }
      count++;
      X509_CRL_free(x);
      x = nullptr;
    }
    ret = count;
  } else if (type == X509_FILETYPE_ASN1) {
    x = d2i_X509_CRL_bio(in, nullptr);
    if (x == nullptr) {
      OPENSSL_PUT_ERROR(X509, ERR_R_ASN1_LIB);
      goto err;
    }
    i = X509_STORE_add_crl(ctx->store_ctx, x);
    if (!i) {
      goto err;
    }
    ret = i;
  } else {
    OPENSSL_PUT_ERROR(X509, X509_R_BAD_X509_FILETYPE);
    goto err;
  }

  if (ret == 0) {
    OPENSSL_PUT_ERROR(X509, X509_R_NO_CRL_FOUND);
  }

err:
  X509_CRL_free(x);
  BIO_free(in);
  return ret;
}

int X509_load_cert_crl_file(X509_LOOKUP *ctx, const char *file, int type) {
  STACK_OF(X509_INFO) *inf;
  X509_INFO *itmp;
  BIO *in;
  size_t i;
  int count = 0;

  if (type != X509_FILETYPE_PEM) {
    return X509_load_cert_file(ctx, file, type);
  }
  in = BIO_new_file(file, "rb");
  if (!in) {
    OPENSSL_PUT_ERROR(X509, ERR_R_SYS_LIB);
    return 0;
  }
  inf = PEM_X509_INFO_read_bio(in, nullptr, nullptr, nullptr);
  BIO_free(in);
  if (!inf) {
    OPENSSL_PUT_ERROR(X509, ERR_R_PEM_LIB);
    return 0;
  }
  for (i = 0; i < sk_X509_INFO_num(inf); i++) {
    itmp = sk_X509_INFO_value(inf, i);
    if (itmp->x509) {
      if (!X509_STORE_add_cert(ctx->store_ctx, itmp->x509)) {
        goto err;
      }
      count++;
    }
    if (itmp->crl) {
      if (!X509_STORE_add_crl(ctx->store_ctx, itmp->crl)) {
        goto err;
      }
      count++;
    }
  }

  if (count == 0) {
    OPENSSL_PUT_ERROR(X509, X509_R_NO_CERTIFICATE_OR_CRL_FOUND);
  }

err:
  sk_X509_INFO_pop_free(inf, X509_INFO_free);
  return count;
}

int X509_LOOKUP_load_file(X509_LOOKUP *lookup, const char *name, int type) {
  return X509_LOOKUP_ctrl(lookup, X509_L_FILE_LOAD, name, type, nullptr);
}
