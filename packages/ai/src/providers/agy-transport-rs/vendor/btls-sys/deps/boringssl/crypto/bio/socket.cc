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

#include <openssl/bio.h>

#if !defined(OPENSSL_NO_SOCK)

#include <fcntl.h>
#include <string.h>

#if !defined(OPENSSL_WINDOWS)
#include <unistd.h>
#else
#include <winsock2.h>
OPENSSL_MSVC_PRAGMA(comment(lib, "Ws2_32.lib"))
#endif

#include "internal.h"


#if !defined(OPENSSL_WINDOWS)
static int closesocket(int sock) {
  return close(sock);
}
#endif

static int sock_free(BIO *bio) {
  if (bio->shutdown) {
    if (bio->init) {
      closesocket(bio->num);
    }
    bio->init = 0;
    bio->flags = 0;
  }
  return 1;
}

static int sock_read(BIO *b, char *out, int outl) {
  if (out == nullptr) {
    return 0;
  }

  bio_clear_socket_error();
#if defined(OPENSSL_WINDOWS)
  int ret = recv(b->num, out, outl, 0);
#else
  int ret = (int)read(b->num, out, outl);
#endif
  BIO_clear_retry_flags(b);
  if (ret <= 0) {
    if (bio_socket_should_retry(ret)) {
      BIO_set_retry_read(b);
    }
  }
  return ret;
}

static int sock_write(BIO *b, const char *in, int inl) {
  bio_clear_socket_error();
#if defined(OPENSSL_WINDOWS)
  int ret = send(b->num, in, inl, 0);
#else
  int ret = (int)write(b->num, in, inl);
#endif
  BIO_clear_retry_flags(b);
  if (ret <= 0) {
    if (bio_socket_should_retry(ret)) {
      BIO_set_retry_write(b);
    }
  }
  return ret;
}

static long sock_ctrl(BIO *b, int cmd, long num, void *ptr) {
  switch (cmd) {
    case BIO_C_SET_FD:
      sock_free(b);
      b->num = *static_cast<int *>(ptr);
      b->shutdown = static_cast<int>(num);
      b->init = 1;
      return 1;
    case BIO_C_GET_FD:
      if (b->init) {
        int *out = static_cast<int*>(ptr);
        if (out != nullptr) {
          *out = b->num;
        }
        return b->num;
      }
      return -1;
    case BIO_CTRL_GET_CLOSE:
      return b->shutdown;
    case BIO_CTRL_SET_CLOSE:
      b->shutdown = static_cast<int>(num);
      return 1;
    case BIO_CTRL_FLUSH:
      return 1;
    default:
      return 0;
  }
}

static const BIO_METHOD methods_sockp = {
    BIO_TYPE_SOCKET,
    "socket",
    sock_write,
    sock_read,
    nullptr /* gets, */,
    sock_ctrl,
    nullptr /* create */,
    sock_free,
    nullptr /* callback_ctrl */,
};

const BIO_METHOD *BIO_s_socket(void) { return &methods_sockp; }

BIO *BIO_new_socket(int fd, int close_flag) {
  BIO *ret;

  ret = BIO_new(BIO_s_socket());
  if (ret == nullptr) {
    return nullptr;
  }
  BIO_set_fd(ret, fd, close_flag);
  return ret;
}

// These functions are provided solely for compatibility with software that
// tries to copy and then modify |BIO_s_socket|. See bio.h for details.
// PostgreSQL's use makes several fragile assumptions on |BIO_s_socket|:
//
// - We do not store anything in |BIO_set_data|. (Broken in upstream OpenSSL,
//   which broke PostgreSQL.)
// - We do not store anything in |BIO_set_app_data|.
// - |BIO_s_socket| is implemented internally using the non-|size_t|-clean
//   I/O functions rather than the |size_t|-clean ones.
// - |BIO_METHOD| never gains another function pointer that is used in concert
//   with any of the functions here.
//
// Some other projects doing similar things use |BIO_meth_get_read| and
// |BIO_meth_get_write| and in turn assume that |BIO_s_socket| has not been
// ported to the |size_t|-clean |BIO_read_ex| and |BIO_write_ex|. (Not yet
// implemented in BoringSSL.)
//
// This is hopelessly fragile. PostgreSQL 18 will include a fix to stop using
// these APIs, but older versions and other software remain impacted, so we
// implement these functions, but only support |BIO_s_socket|. For now they just
// return the underlying functions, but if we ever need to break the above
// assumptions, we can return an older, frozen version of |BIO_s_socket|.
// Limiting to exactly one allowed |BIO_METHOD| lets us do this.
//
// These functions are also deprecated in upstream OpenSSL. See
// https://github.com/openssl/openssl/issues/26047
//
// TODO(davidben): Once Folly and all versions of PostgreSQL we care about are
// updated or patched, remove these functions.

int (*BIO_meth_get_write(const BIO_METHOD *method))(BIO *, const char *, int) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->bwrite;
}

int (*BIO_meth_get_read(const BIO_METHOD *method))(BIO *, char *, int) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->bread;
}

int (*BIO_meth_get_gets(const BIO_METHOD *method))(BIO *, char *, int) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->bgets;
}

int (*BIO_meth_get_puts(const BIO_METHOD *method))(BIO *, const char *) {
  BSSL_CHECK(method == BIO_s_socket());
  return nullptr;
}

long (*BIO_meth_get_ctrl(const BIO_METHOD *method))(BIO *, int, long, void *) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->ctrl;
}

int (*BIO_meth_get_create(const BIO_METHOD *method))(BIO *) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->create;
}

int (*BIO_meth_get_destroy(const BIO_METHOD *method))(BIO *) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->destroy;
}

long (*BIO_meth_get_callback_ctrl(const BIO_METHOD *method))(BIO *, int,
                                                             bio_info_cb) {
  BSSL_CHECK(method == BIO_s_socket());
  return method->callback_ctrl;
}

#endif  // OPENSSL_NO_SOCK
