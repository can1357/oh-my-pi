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

#include <openssl/ssl.h>

#include <openssl/bio.h>

#include "../crypto/bio/internal.h"


static SSL *get_ssl(BIO *bio) { return reinterpret_cast<SSL *>(bio->ptr); }

static int ssl_read(BIO *bio, char *out, int outl) {
  SSL *ssl = get_ssl(bio);
  if (ssl == nullptr) {
    return 0;
  }

  BIO_clear_retry_flags(bio);

  const int ret = SSL_read(ssl, out, outl);

  switch (SSL_get_error(ssl, ret)) {
    case SSL_ERROR_WANT_READ:
      BIO_set_retry_read(bio);
      break;

    case SSL_ERROR_WANT_WRITE:
      BIO_set_retry_write(bio);
      break;

    case SSL_ERROR_WANT_ACCEPT:
      BIO_set_retry_special(bio);
      BIO_set_retry_reason(bio, BIO_RR_ACCEPT);
      break;

    case SSL_ERROR_WANT_CONNECT:
      BIO_set_retry_special(bio);
      BIO_set_retry_reason(bio, BIO_RR_CONNECT);
      break;

    case SSL_ERROR_NONE:
    case SSL_ERROR_SYSCALL:
    case SSL_ERROR_SSL:
    case SSL_ERROR_ZERO_RETURN:
    default:
      break;
  }

  return ret;
}

static int ssl_write(BIO *bio, const char *out, int outl) {
  SSL *ssl = get_ssl(bio);
  if (ssl == nullptr) {
    return 0;
  }

  BIO_clear_retry_flags(bio);

  const int ret = SSL_write(ssl, out, outl);

  switch (SSL_get_error(ssl, ret)) {
    case SSL_ERROR_WANT_WRITE:
      BIO_set_retry_write(bio);
      break;

    case SSL_ERROR_WANT_READ:
      BIO_set_retry_read(bio);
      break;

    case SSL_ERROR_WANT_CONNECT:
      BIO_set_retry_special(bio);
      BIO_set_retry_reason(bio, BIO_RR_CONNECT);
      break;

    case SSL_ERROR_NONE:
    case SSL_ERROR_SYSCALL:
    case SSL_ERROR_SSL:
    default:
      break;
  }

  return ret;
}

static long ssl_ctrl(BIO *bio, int cmd, long num, void *ptr) {
  SSL *ssl = get_ssl(bio);
  if (ssl == nullptr && cmd != BIO_C_SET_SSL) {
    return 0;
  }

  switch (cmd) {
    case BIO_C_SET_SSL:
      if (ssl != nullptr) {
        // OpenSSL allows reusing an SSL BIO with a different SSL object. We do
        // not support this.
        OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
        return 0;
      }

      // Note this differs from upstream OpenSSL, which synchronizes
      // |bio->next_bio| with |ssl|'s rbio here, and on |BIO_CTRL_PUSH|. We call
      // into the corresponding |BIO| directly. (We can implement the upstream
      // behavior if it ends up necessary.)
      bio->shutdown = static_cast<int>(num);
      bio->ptr = ptr;
      bio->init = 1;
      return 1;

    case BIO_CTRL_GET_CLOSE:
      return bio->shutdown;

    case BIO_CTRL_SET_CLOSE:
      bio->shutdown = static_cast<int>(num);
      return 1;

    case BIO_CTRL_WPENDING:
      return BIO_ctrl(SSL_get_wbio(ssl), cmd, num, ptr);

    case BIO_CTRL_PENDING:
      return SSL_pending(ssl);

    case BIO_CTRL_FLUSH: {
      BIO *wbio = SSL_get_wbio(ssl);
      BIO_clear_retry_flags(bio);
      long ret = BIO_ctrl(wbio, cmd, num, ptr);
      BIO_set_flags(bio, BIO_get_retry_flags(wbio));
      BIO_set_retry_reason(bio, BIO_get_retry_reason(wbio));
      return ret;
    }

    case BIO_CTRL_PUSH:
    case BIO_CTRL_POP:
    case BIO_CTRL_DUP:
      return -1;

    default:
      return BIO_ctrl(SSL_get_rbio(ssl), cmd, num, ptr);
  }
}

static int ssl_new(BIO *bio) { return 1; }

static int ssl_free(BIO *bio) {
  SSL *ssl = get_ssl(bio);

  if (ssl == nullptr) {
    return 1;
  }

  SSL_shutdown(ssl);
  if (bio->shutdown) {
    SSL_free(ssl);
  }

  return 1;
}

static long ssl_callback_ctrl(BIO *bio, int cmd, BIO_info_cb *fp) {
  SSL *ssl = get_ssl(bio);
  if (ssl == nullptr) {
    return 0;
  }

  switch (cmd) {
    case BIO_CTRL_SET_CALLBACK:
      return -1;

    default:
      return BIO_callback_ctrl(SSL_get_rbio(ssl), cmd, fp);
  }
}

static const BIO_METHOD ssl_method = {
    BIO_TYPE_SSL, "SSL",   ssl_write, ssl_read,          /*bgets=*/nullptr,
    ssl_ctrl,     ssl_new, ssl_free,  ssl_callback_ctrl,
};

const BIO_METHOD *BIO_f_ssl(void) { return &ssl_method; }

long BIO_set_ssl(BIO *bio, SSL *ssl, int take_owership) {
  return BIO_ctrl(bio, BIO_C_SET_SSL, take_owership, ssl);
}
