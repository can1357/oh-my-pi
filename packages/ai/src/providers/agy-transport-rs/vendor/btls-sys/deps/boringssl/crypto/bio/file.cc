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

#if defined(__linux) || defined(__sun) || defined(__hpux)
// Following definition aliases fopen to fopen64 on above mentioned
// platforms. This makes it possible to open and sequentially access
// files larger than 2GB from 32-bit application. It does not allow to
// traverse them beyond 2GB with fseek/ftell, but on the other hand *no*
// 32-bit platform permits that, not with fseek/ftell. Not to mention
// that breaking 2GB limit for seeking would require surgery to *our*
// API. But sequential access suffices for practical cases when you
// can run into large files, such as fingerprinting, so we can let API
// alone. For reference, the list of 32-bit platforms which allow for
// sequential access of large files without extra "magic" comprise *BSD,
// Darwin, IRIX...
#ifndef _FILE_OFFSET_BITS
#define _FILE_OFFSET_BITS 64
#endif
#endif

#include <openssl/bio.h>

#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"

#if defined(OPENSSL_WINDOWS)
#include <fcntl.h>
#include <io.h>
#endif

#define BIO_FP_READ 0x02
#define BIO_FP_WRITE 0x04
#define BIO_FP_APPEND 0x08

#if !defined(OPENSSL_NO_FILESYSTEM)
#define fopen_if_available fopen
#else
static FILE *fopen_if_available(const char *path, const char *mode) {
  errno = ENOENT;
  return nullptr;
}
#endif

BIO *BIO_new_file(const char *filename, const char *mode) {
  BIO *ret;
  FILE *file;

  file = fopen_if_available(filename, mode);
  if (file == nullptr) {
    OPENSSL_PUT_SYSTEM_ERROR();

    ERR_add_error_data(5, "fopen('", filename, "','", mode, "')");
    if (errno == ENOENT) {
      OPENSSL_PUT_ERROR(BIO, BIO_R_NO_SUCH_FILE);
    } else {
      OPENSSL_PUT_ERROR(BIO, BIO_R_SYS_LIB);
    }
    return nullptr;
  }

  ret = BIO_new_fp(file, BIO_CLOSE);
  if (ret == nullptr) {
    fclose(file);
    return nullptr;
  }

  return ret;
}

BIO *BIO_new_fp(FILE *stream, int flags) {
  BIO *ret = BIO_new(BIO_s_file());
  if (ret == nullptr) {
    return nullptr;
  }

  BIO_set_fp(ret, stream, flags);
  return ret;
}

static int file_free(BIO *bio) {
  if (!bio->shutdown) {
    return 1;
  }

  if (bio->init && bio->ptr != nullptr) {
    fclose(reinterpret_cast<FILE *>(bio->ptr));
    bio->ptr = nullptr;
  }
  bio->init = 0;

  return 1;
}

static int file_read(BIO *b, char *out, int outl) {
  if (!b->init) {
    return 0;
  }

  size_t ret = fread(out, 1, outl, (FILE *)b->ptr);
  if (ret == 0 && ferror((FILE *)b->ptr)) {
    OPENSSL_PUT_SYSTEM_ERROR();
    OPENSSL_PUT_ERROR(BIO, ERR_R_SYS_LIB);
    return -1;
  }

  // fread reads at most |outl| bytes, so |ret| fits in an int.
  return (int)ret;
}

static int file_write(BIO *b, const char *in, int inl) {
  if (!b->init) {
    return 0;
  }

  int ret = (int)fwrite(in, inl, 1, (FILE *)b->ptr);
  if (ret > 0) {
    ret = inl;
  }
  return ret;
}

static long file_ctrl(BIO *b, int cmd, long num, void *ptr) {
  FILE *fp = static_cast<FILE *>(b->ptr);
  switch (cmd) {
    case BIO_CTRL_RESET:
      num = 0;
      [[fallthrough]];
    case BIO_C_FILE_SEEK:
      return fseek(fp, num, 0);
    case BIO_CTRL_EOF:
      return feof(fp);
    case BIO_C_FILE_TELL:
    case BIO_CTRL_INFO:
      return ftell(fp);
    case BIO_C_SET_FILE_PTR:
      file_free(b);
      static_assert((BIO_CLOSE & BIO_FP_TEXT) == 0,
                    "BIO_CLOSE and BIO_FP_TEXT must not collide");
#if defined(OPENSSL_WINDOWS)
      // If |BIO_FP_TEXT| is not set, OpenSSL will switch the file to binary
      // mode. BoringSSL intentionally diverges here because it means code
      // tested under POSIX will inadvertently change the state of |FILE|
      // objects when wrapping them in a |BIO|.
      if (num & BIO_FP_TEXT) {
        _setmode(_fileno(reinterpret_cast<FILE *>(ptr)), _O_TEXT);
      }
#endif
      b->shutdown = static_cast<int>(num) & BIO_CLOSE;
      b->ptr = ptr;
      b->init = 1;
      return 1;
    case BIO_C_SET_FILENAME:
      file_free(b);
      b->shutdown = static_cast<int>(num) & BIO_CLOSE;
      const char *mode;
      if (num & BIO_FP_APPEND) {
        if (num & BIO_FP_READ) {
          mode = "ab+";
        } else {
          mode = "ab";
        }
      } else if ((num & BIO_FP_READ) && (num & BIO_FP_WRITE)) {
        mode = "rb+";
      } else if (num & BIO_FP_WRITE) {
        mode = "wb";
      } else if (num & BIO_FP_READ) {
        mode = "rb";
      } else {
        OPENSSL_PUT_ERROR(BIO, BIO_R_BAD_FOPEN_MODE);
        return 0;
      }
      fp = fopen_if_available(reinterpret_cast<const char *>(ptr), mode);
      if (fp == nullptr) {
        OPENSSL_PUT_SYSTEM_ERROR();
        ERR_add_error_data(5, "fopen('", ptr, "','", mode, "')");
        OPENSSL_PUT_ERROR(BIO, ERR_R_SYS_LIB);
        return 0;
      }
      b->ptr = fp;
      b->init = 1;
      return 1;
    case BIO_C_GET_FILE_PTR:
      // the ptr parameter is actually a FILE ** in this case.
      if (ptr != nullptr) {
        FILE **out = static_cast<FILE **>(ptr);
        *out = fp;
      }
      return 1;
    case BIO_CTRL_GET_CLOSE:
      return b->shutdown;
    case BIO_CTRL_SET_CLOSE:
      b->shutdown = static_cast<int>(num);
      return 1;
    case BIO_CTRL_FLUSH:
      return fflush(fp) == 0;
    default:
      return 0;
  }
}

static int file_gets(BIO *bp, char *buf, int size) {
  if (size == 0) {
    return 0;
  }

  if (!fgets(buf, size, (FILE *)bp->ptr)) {
    buf[0] = 0;
    // TODO(davidben): This doesn't distinguish error and EOF. This should check
    // |ferror| as in |file_read|.
    return 0;
  }

  return (int)strlen(buf);
}

static const BIO_METHOD methods_filep = {
    BIO_TYPE_FILE,      "FILE pointer", file_write,
    file_read,          file_gets,      file_ctrl,
    /*create=*/nullptr, file_free,      /*callback_ctrl=*/nullptr,
};

const BIO_METHOD *BIO_s_file(void) { return &methods_filep; }


int BIO_get_fp(BIO *bio, FILE **out_file) {
  return (int)BIO_ctrl(bio, BIO_C_GET_FILE_PTR, 0, (char *)out_file);
}

int BIO_set_fp(BIO *bio, FILE *file, int flags) {
  return (int)BIO_ctrl(bio, BIO_C_SET_FILE_PTR, flags, (char *)file);
}

int BIO_read_filename(BIO *bio, const char *filename) {
  return (int)BIO_ctrl(bio, BIO_C_SET_FILENAME, BIO_CLOSE | BIO_FP_READ,
                       (char *)filename);
}

int BIO_write_filename(BIO *bio, const char *filename) {
  return (int)BIO_ctrl(bio, BIO_C_SET_FILENAME, BIO_CLOSE | BIO_FP_WRITE,
                       (char *)filename);
}

int BIO_append_filename(BIO *bio, const char *filename) {
  return (int)BIO_ctrl(bio, BIO_C_SET_FILENAME, BIO_CLOSE | BIO_FP_APPEND,
                       (char *)filename);
}

int BIO_rw_filename(BIO *bio, const char *filename) {
  return (int)BIO_ctrl(bio, BIO_C_SET_FILENAME,
                       BIO_CLOSE | BIO_FP_READ | BIO_FP_WRITE,
                       (char *)filename);
}

long BIO_tell(BIO *bio) { return BIO_ctrl(bio, BIO_C_FILE_TELL, 0, nullptr); }

long BIO_seek(BIO *bio, long offset) {
  return BIO_ctrl(bio, BIO_C_FILE_SEEK, offset, nullptr);
}
