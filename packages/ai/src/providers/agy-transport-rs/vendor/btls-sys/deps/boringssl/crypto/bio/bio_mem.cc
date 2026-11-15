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

#include <limits.h>
#include <string.h>

#include <openssl/buf.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"


BIO *BIO_new_mem_buf(const void *buf, ossl_ssize_t len) {
  BIO *ret;
  BUF_MEM *b;
  const size_t size = len < 0 ? strlen((char *)buf) : (size_t)len;

  if (!buf && len != 0) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_NULL_PARAMETER);
    return nullptr;
  }

  ret = BIO_new(BIO_s_mem());
  if (ret == nullptr) {
    return nullptr;
  }

  b = (BUF_MEM *)ret->ptr;
  // BIO_FLAGS_MEM_RDONLY ensures |b->data| is not written to.
  b->data = reinterpret_cast<char *>(const_cast<void *>(buf));
  b->length = size;
  b->max = size;

  ret->flags |= BIO_FLAGS_MEM_RDONLY;

  // |num| is used to store the value that this BIO will return when it runs
  // out of data. If it's negative then the retry flags will also be set. Since
  // this is static data, retrying won't help
  ret->num = 0;

  return ret;
}

static int mem_new(BIO *bio) {
  BUF_MEM *b;

  b = BUF_MEM_new();
  if (b == nullptr) {
    return 0;
  }

  // |shutdown| is used to store the close flag: whether the BIO has ownership
  // of the BUF_MEM.
  bio->shutdown = 1;
  bio->init = 1;
  bio->num = -1;
  bio->ptr = (char *)b;

  return 1;
}

static int mem_free(BIO *bio) {
  if (!bio->shutdown || !bio->init || bio->ptr == nullptr) {
    return 1;
  }

  BUF_MEM *b = (BUF_MEM *)bio->ptr;
  if (bio->flags & BIO_FLAGS_MEM_RDONLY) {
    b->data = nullptr;
  }
  BUF_MEM_free(b);
  bio->ptr = nullptr;
  return 1;
}

static int mem_read(BIO *bio, char *out, int outl) {
  BIO_clear_retry_flags(bio);
  if (outl <= 0) {
    return 0;
  }

  BUF_MEM *b = reinterpret_cast<BUF_MEM *>(bio->ptr);
  int ret = outl;
  if ((size_t)ret > b->length) {
    ret = (int)b->length;
  }

  if (ret > 0) {
    OPENSSL_memcpy(out, b->data, ret);
    b->length -= ret;
    if (bio->flags & BIO_FLAGS_MEM_RDONLY) {
      b->data += ret;
    } else {
      OPENSSL_memmove(b->data, &b->data[ret], b->length);
    }
  } else if (b->length == 0) {
    ret = bio->num;
    if (ret != 0) {
      BIO_set_retry_read(bio);
    }
  }
  return ret;
}

static int mem_write(BIO *bio, const char *in, int inl) {
  BIO_clear_retry_flags(bio);
  if (inl <= 0) {
    return 0;  // Successfully write zero bytes.
  }

  if (bio->flags & BIO_FLAGS_MEM_RDONLY) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_WRITE_TO_READ_ONLY_BIO);
    return -1;
  }

  BUF_MEM *b = reinterpret_cast<BUF_MEM *>(bio->ptr);
  if (!BUF_MEM_append(b, in, inl)) {
    return -1;
  }

  return inl;
}

static int mem_gets(BIO *bio, char *buf, int size) {
  BIO_clear_retry_flags(bio);
  if (size <= 0) {
    return 0;
  }

  // The buffer size includes space for the trailing NUL, so we can read at most
  // one fewer byte.
  BUF_MEM *b = reinterpret_cast<BUF_MEM *>(bio->ptr);
  int ret = size - 1;
  if ((size_t)ret > b->length) {
    ret = (int)b->length;
  }

  // Stop at the first newline.
  const char *newline =
      reinterpret_cast<char *>(OPENSSL_memchr(b->data, '\n', ret));
  if (newline != nullptr) {
    ret = (int)(newline - b->data + 1);
  }

  ret = mem_read(bio, buf, ret);
  if (ret >= 0) {
    buf[ret] = '\0';
  }
  return ret;
}

static long mem_ctrl(BIO *bio, int cmd, long num, void *ptr) {
  BUF_MEM *b = static_cast<BUF_MEM *>(bio->ptr);
  switch (cmd) {
    case BIO_CTRL_RESET:
      if (b->data != nullptr) {
        // For read only case reset to the start again
        if (bio->flags & BIO_FLAGS_MEM_RDONLY) {
          b->data -= b->max - b->length;
          b->length = b->max;
        } else {
          OPENSSL_memset(b->data, 0, b->max);
          b->length = 0;
        }
      }
      return 1;
    case BIO_CTRL_EOF:
      return b->length == 0;
    case BIO_C_SET_BUF_MEM_EOF_RETURN:
      bio->num = static_cast<int>(num);
      return 1;
    case BIO_CTRL_INFO:
      if (ptr != nullptr) {
        char **out = reinterpret_cast<char **>(ptr);
        *out = b->data;
      }
      // This API can overflow on 64-bit Windows, where |long| is smaller than
      // |ptrdiff_t|. |BIO_mem_contents| is the overflow-safe API.
      return static_cast<long>(b->length);
    case BIO_C_SET_BUF_MEM:
      mem_free(bio);
      bio->shutdown = static_cast<int>(num);
      bio->ptr = ptr;
      return 1;
    case BIO_C_GET_BUF_MEM_PTR:
      if (ptr != nullptr) {
        BUF_MEM **out = reinterpret_cast<BUF_MEM **>(ptr);
        *out = b;
      }
      return 1;
    case BIO_CTRL_GET_CLOSE:
      return bio->shutdown;
    case BIO_CTRL_SET_CLOSE:
      bio->shutdown = static_cast<int>(num);
      return 1;
    case BIO_CTRL_WPENDING:
      return 0;
    case BIO_CTRL_PENDING:
      // TODO(crbug.com/412584975): This can overflow on 64-bit Windows.
      return static_cast<long>(b->length);
    case BIO_CTRL_FLUSH:
      return 1;
    default:
      return 0;
  }
}

static const BIO_METHOD mem_method = {
    BIO_TYPE_MEM, "memory buffer", mem_write,
    mem_read,     mem_gets,        mem_ctrl,
    mem_new,      mem_free,        /*callback_ctrl=*/nullptr,
};

const BIO_METHOD *BIO_s_mem(void) { return &mem_method; }

int BIO_mem_contents(const BIO *bio, const uint8_t **out_contents,
                     size_t *out_len) {
  const BUF_MEM *b;
  if (bio->method != &mem_method) {
    return 0;
  }

  b = (BUF_MEM *)bio->ptr;
  *out_contents = (uint8_t *)b->data;
  *out_len = b->length;
  return 1;
}

long BIO_get_mem_data(BIO *bio, char **contents) {
  return BIO_ctrl(bio, BIO_CTRL_INFO, 0, contents);
}

int BIO_get_mem_ptr(BIO *bio, BUF_MEM **out) {
  return (int)BIO_ctrl(bio, BIO_C_GET_BUF_MEM_PTR, 0, out);
}

int BIO_set_mem_buf(BIO *bio, BUF_MEM *b, int take_ownership) {
  return (int)BIO_ctrl(bio, BIO_C_SET_BUF_MEM, take_ownership, b);
}

int BIO_set_mem_eof_return(BIO *bio, int eof_value) {
  return (int)BIO_ctrl(bio, BIO_C_SET_BUF_MEM_EOF_RETURN, eof_value, nullptr);
}
