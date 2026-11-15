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

#include <openssl/buf.h>

#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"


BUF_MEM *BUF_MEM_new(void) {
  return reinterpret_cast<BUF_MEM *>(OPENSSL_zalloc(sizeof(BUF_MEM)));
}

void BUF_MEM_free(BUF_MEM *buf) {
  if (buf == nullptr) {
    return;
  }
  OPENSSL_free(buf->data);
  OPENSSL_free(buf);
}

int BUF_MEM_reserve(BUF_MEM *buf, size_t cap) {
  if (buf->max >= cap) {
    return 1;
  }

  size_t n = cap + 3;
  if (n < cap) {
    OPENSSL_PUT_ERROR(BUF, ERR_R_OVERFLOW);
    return 0;
  }
  n = n / 3;
  size_t alloc_size = n * 4;
  if (alloc_size / 4 != n) {
    OPENSSL_PUT_ERROR(BUF, ERR_R_OVERFLOW);
    return 0;
  }

  char *new_buf =
      reinterpret_cast<char *>(OPENSSL_realloc(buf->data, alloc_size));
  if (new_buf == nullptr) {
    return 0;
  }

  buf->data = new_buf;
  buf->max = alloc_size;
  return 1;
}

size_t BUF_MEM_grow(BUF_MEM *buf, size_t len) {
  if (!BUF_MEM_reserve(buf, len)) {
    return 0;
  }
  if (buf->length < len) {
    OPENSSL_memset(&buf->data[buf->length], 0, len - buf->length);
  }
  buf->length = len;
  return len;
}

size_t BUF_MEM_grow_clean(BUF_MEM *buf, size_t len) {
  return BUF_MEM_grow(buf, len);
}

int BUF_MEM_append(BUF_MEM *buf, const void *in, size_t len) {
  // Work around a C language bug. See https://crbug.com/1019588.
  if (len == 0) {
    return 1;
  }
  size_t new_len = buf->length + len;
  if (new_len < len) {
    OPENSSL_PUT_ERROR(BUF, ERR_R_OVERFLOW);
    return 0;
  }
  if (!BUF_MEM_reserve(buf, new_len)) {
    return 0;
  }
  OPENSSL_memcpy(buf->data + buf->length, in, len);
  buf->length = new_len;
  return 1;
}

char *BUF_strdup(const char *str) { return OPENSSL_strdup(str); }

size_t BUF_strnlen(const char *str, size_t max_len) {
  return OPENSSL_strnlen(str, max_len);
}

char *BUF_strndup(const char *str, size_t size) {
  return OPENSSL_strndup(str, size);
}

size_t BUF_strlcpy(char *dst, const char *src, size_t dst_size) {
  return OPENSSL_strlcpy(dst, src, dst_size);
}

size_t BUF_strlcat(char *dst, const char *src, size_t dst_size) {
  return OPENSSL_strlcat(dst, src, dst_size);
}

void *BUF_memdup(const void *data, size_t size) {
  return OPENSSL_memdup(data, size);
}
