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

#if !defined(OPENSSL_NO_POSIX_IO)

#include <errno.h>
#include <string.h>

#if !defined(OPENSSL_WINDOWS)
#include <unistd.h>
#else
#include <io.h>
#endif

#include <openssl/err.h>
#include <openssl/mem.h>

#include "internal.h"
#include "../internal.h"


#if defined(OPENSSL_WINDOWS)
  #define BORINGSSL_CLOSE _close
  #define BORINGSSL_LSEEK _lseek
  #define BORINGSSL_READ _read
  #define BORINGSSL_WRITE _write
#else
  #define BORINGSSL_CLOSE close
  #define BORINGSSL_LSEEK lseek
  #define BORINGSSL_READ read
  #define BORINGSSL_WRITE write
#endif

BIO *BIO_new_fd(int fd, int close_flag) {
  BIO *ret = BIO_new(BIO_s_fd());
  if (ret == nullptr) {
    return nullptr;
  }
  BIO_set_fd(ret, fd, close_flag);
  return ret;
}

static int fd_new(BIO *bio) {
  // num is used to store the file descriptor.
  bio->num = -1;
  return 1;
}

static int fd_free(BIO *bio) {
  if (bio->shutdown) {
    if (bio->init) {
      BORINGSSL_CLOSE(bio->num);
    }
    bio->init = 0;
  }
  return 1;
}

static int fd_read(BIO *b, char *out, int outl) {
  int ret = 0;

  ret = (int)BORINGSSL_READ(b->num, out, outl);
  BIO_clear_retry_flags(b);
  if (ret <= 0) {
    if (bio_errno_should_retry(ret)) {
      BIO_set_retry_read(b);
    }
  }

  return ret;
}

static int fd_write(BIO *b, const char *in, int inl) {
  int ret = (int)BORINGSSL_WRITE(b->num, in, inl);
  BIO_clear_retry_flags(b);
  if (ret <= 0) {
    if (bio_errno_should_retry(ret)) {
      BIO_set_retry_write(b);
    }
  }

  return ret;
}

static long fd_ctrl(BIO *b, int cmd, long num, void *ptr) {
  switch (cmd) {
    case BIO_CTRL_RESET:
      num = 0;
      [[fallthrough]];
    case BIO_C_FILE_SEEK:
      if (b->init) {
        return (long)BORINGSSL_LSEEK(b->num, num, SEEK_SET);
      }
      return 0;
    case BIO_C_FILE_TELL:
    case BIO_CTRL_INFO:
      if (b->init) {
        return (long)BORINGSSL_LSEEK(b->num, 0, SEEK_CUR);
      }
      return 0;
    case BIO_C_SET_FD:
      fd_free(b);
      b->num = *static_cast<int *>(ptr);
      b->shutdown = static_cast<int>(num);
      b->init = 1;
      return 1;
    case BIO_C_GET_FD:
      if (b->init) {
        int *out = static_cast<int *>(ptr);
        if (out != nullptr) {
          *out = b->num;
        }
        return b->num;
      } else {
        return -1;
      }
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

static int fd_gets(BIO *bp, char *buf, int size) {
  if (size <= 0) {
    return 0;
  }

  char *ptr = buf;
  char *end = buf + size - 1;
  while (ptr < end && fd_read(bp, ptr, 1) > 0) {
    char c = ptr[0];
    ptr++;
    if (c == '\n') {
      break;
    }
  }

  ptr[0] = '\0';

  // The output length is bounded by |size|.
  return (int)(ptr - buf);
}

static const BIO_METHOD methods_fdp = {
    BIO_TYPE_FD, "file descriptor", fd_write,
    fd_read,     fd_gets,           fd_ctrl,
    fd_new,      fd_free,           /*callback_ctrl=*/nullptr,
};

const BIO_METHOD *BIO_s_fd(void) { return &methods_fdp; }

#endif  // OPENSSL_NO_POSIX_IO

int BIO_set_fd(BIO *bio, int fd, int close_flag) {
  return (int)BIO_int_ctrl(bio, BIO_C_SET_FD, close_flag, fd);
}

int BIO_get_fd(BIO *bio, int *out_fd) {
  return (int)BIO_ctrl(bio, BIO_C_GET_FD, 0, (char *) out_fd);
}
