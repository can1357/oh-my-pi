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

#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <string.h>

#include <openssl/asn1.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"


static CRYPTO_EX_DATA_CLASS g_ex_data_class =
    CRYPTO_EX_DATA_CLASS_INIT_WITH_APP_DATA;

BIO *BIO_new(const BIO_METHOD *method) {
  BIO *ret = reinterpret_cast<BIO *>(OPENSSL_zalloc(sizeof(BIO)));
  if (ret == nullptr) {
    return nullptr;
  }

  ret->method = method;
  ret->shutdown = 1;
  ret->references = 1;
  CRYPTO_new_ex_data(&ret->ex_data);

  if (method->create != nullptr && !method->create(ret)) {
    OPENSSL_free(ret);
    return nullptr;
  }

  return ret;
}

int BIO_free(BIO *bio) {
  BIO *next_bio;

  for (; bio != nullptr; bio = next_bio) {
    if (!CRYPTO_refcount_dec_and_test_zero(&bio->references)) {
      return 0;
    }

    next_bio = BIO_pop(bio);

    if (bio->method != nullptr && bio->method->destroy != nullptr) {
      bio->method->destroy(bio);
    }

    CRYPTO_free_ex_data(&g_ex_data_class, &bio->ex_data);
    OPENSSL_free(bio);
  }
  return 1;
}

int BIO_up_ref(BIO *bio) {
  CRYPTO_refcount_inc(&bio->references);
  return 1;
}

void BIO_vfree(BIO *bio) { BIO_free(bio); }

void BIO_free_all(BIO *bio) { BIO_free(bio); }

int BIO_read(BIO *bio, void *buf, int len) {
  if (bio == nullptr || bio->method == nullptr ||
      bio->method->bread == nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNSUPPORTED_METHOD);
    return -2;
  }
  if (!bio->init) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNINITIALIZED);
    return -2;
  }
  if (len <= 0) {
    return 0;
  }
  int ret = bio->method->bread(bio, reinterpret_cast<char *>(buf), len);
  if (ret > 0) {
    bio->num_read += ret;
  }
  return ret;
}

int BIO_gets(BIO *bio, char *buf, int len) {
  if (bio == nullptr || bio->method == nullptr ||
      bio->method->bgets == nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNSUPPORTED_METHOD);
    return -2;
  }
  if (!bio->init) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNINITIALIZED);
    return -2;
  }
  if (len <= 0) {
    return 0;
  }
  int ret = bio->method->bgets(bio, buf, len);
  if (ret > 0) {
    bio->num_read += ret;
  }
  return ret;
}

int BIO_write(BIO *bio, const void *in, int inl) {
  if (bio == nullptr || bio->method == nullptr ||
      bio->method->bwrite == nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNSUPPORTED_METHOD);
    return -2;
  }
  if (!bio->init) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNINITIALIZED);
    return -2;
  }
  if (inl <= 0) {
    return 0;
  }
  int ret = bio->method->bwrite(bio, reinterpret_cast<const char *>(in), inl);
  if (ret > 0) {
    bio->num_write += ret;
  }
  return ret;
}

int BIO_write_all(BIO *bio, const void *data, size_t len) {
  const uint8_t *data_u8 = reinterpret_cast<const uint8_t *>(data);
  while (len > 0) {
    int ret = BIO_write(bio, data_u8, len > INT_MAX ? INT_MAX : (int)len);
    if (ret <= 0) {
      return 0;
    }
    data_u8 += ret;
    len -= ret;
  }
  return 1;
}

int BIO_puts(BIO *bio, const char *in) {
  size_t len = strlen(in);
  if (len > INT_MAX) {
    // |BIO_write| and the return value both assume the string fits in |int|.
    OPENSSL_PUT_ERROR(BIO, ERR_R_OVERFLOW);
    return -1;
  }
  return BIO_write(bio, in, (int)len);
}

int BIO_flush(BIO *bio) {
  return (int)BIO_ctrl(bio, BIO_CTRL_FLUSH, 0, nullptr);
}

long BIO_ctrl(BIO *bio, int cmd, long larg, void *parg) {
  if (bio == nullptr) {
    return 0;
  }

  if (bio->method == nullptr || bio->method->ctrl == nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNSUPPORTED_METHOD);
    return -2;
  }

  return bio->method->ctrl(bio, cmd, larg, parg);
}

char *BIO_ptr_ctrl(BIO *b, int cmd, long larg) {
  char *p = nullptr;

  if (BIO_ctrl(b, cmd, larg, (void *)&p) <= 0) {
    return nullptr;
  }

  return p;
}

long BIO_int_ctrl(BIO *b, int cmd, long larg, int iarg) {
  int i = iarg;

  return BIO_ctrl(b, cmd, larg, (void *)&i);
}

int BIO_reset(BIO *bio) {
  return (int)BIO_ctrl(bio, BIO_CTRL_RESET, 0, nullptr);
}

int BIO_eof(BIO *bio) { return (int)BIO_ctrl(bio, BIO_CTRL_EOF, 0, nullptr); }

void BIO_set_flags(BIO *bio, int flags) { bio->flags |= flags; }

int BIO_test_flags(const BIO *bio, int flags) { return bio->flags & flags; }

int BIO_should_read(const BIO *bio) {
  return BIO_test_flags(bio, BIO_FLAGS_READ);
}

int BIO_should_write(const BIO *bio) {
  return BIO_test_flags(bio, BIO_FLAGS_WRITE);
}

int BIO_should_retry(const BIO *bio) {
  return BIO_test_flags(bio, BIO_FLAGS_SHOULD_RETRY);
}

int BIO_should_io_special(const BIO *bio) {
  return BIO_test_flags(bio, BIO_FLAGS_IO_SPECIAL);
}

int BIO_get_retry_reason(const BIO *bio) { return bio->retry_reason; }

void BIO_set_retry_reason(BIO *bio, int reason) { bio->retry_reason = reason; }

void BIO_clear_flags(BIO *bio, int flags) { bio->flags &= ~flags; }

void BIO_set_retry_read(BIO *bio) {
  bio->flags |= BIO_FLAGS_READ | BIO_FLAGS_SHOULD_RETRY;
}

void BIO_set_retry_write(BIO *bio) {
  bio->flags |= BIO_FLAGS_WRITE | BIO_FLAGS_SHOULD_RETRY;
}

static const int kRetryFlags = BIO_FLAGS_RWS | BIO_FLAGS_SHOULD_RETRY;

int BIO_get_retry_flags(BIO *bio) { return bio->flags & kRetryFlags; }

void BIO_clear_retry_flags(BIO *bio) {
  bio->flags &= ~kRetryFlags;
  bio->retry_reason = 0;
}

int BIO_method_type(const BIO *bio) { return bio->method->type; }

void BIO_copy_next_retry(BIO *bio) {
  BIO_clear_retry_flags(bio);
  BIO_set_flags(bio, BIO_get_retry_flags(bio->next_bio));
  bio->retry_reason = bio->next_bio->retry_reason;
}

long BIO_callback_ctrl(BIO *bio, int cmd, BIO_info_cb *fp) {
  if (bio == nullptr) {
    return 0;
  }

  if (bio->method == nullptr || bio->method->callback_ctrl == nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_UNSUPPORTED_METHOD);
    return 0;
  }

  return bio->method->callback_ctrl(bio, cmd, fp);
}

size_t BIO_pending(const BIO *bio) {
  const long r = BIO_ctrl((BIO *)bio, BIO_CTRL_PENDING, 0, nullptr);
  assert(r >= 0);

  if (r < 0) {
    return 0;
  }
  return r;
}

size_t BIO_ctrl_pending(const BIO *bio) { return BIO_pending(bio); }

size_t BIO_wpending(const BIO *bio) {
  const long r = BIO_ctrl((BIO *)bio, BIO_CTRL_WPENDING, 0, nullptr);
  assert(r >= 0);

  if (r < 0) {
    return 0;
  }
  return r;
}

int BIO_set_close(BIO *bio, int close_flag) {
  return (int)BIO_ctrl(bio, BIO_CTRL_SET_CLOSE, close_flag, nullptr);
}

OPENSSL_EXPORT uint64_t BIO_number_read(const BIO *bio) {
  return bio->num_read;
}

OPENSSL_EXPORT uint64_t BIO_number_written(const BIO *bio) {
  return bio->num_write;
}

BIO *BIO_push(BIO *bio, BIO *appended_bio) {
  BIO *last_bio;

  if (bio == nullptr) {
    return bio;
  }

  last_bio = bio;
  while (last_bio->next_bio != nullptr) {
    last_bio = last_bio->next_bio;
  }

  last_bio->next_bio = appended_bio;
  return bio;
}

BIO *BIO_pop(BIO *bio) {
  BIO *ret;

  if (bio == nullptr) {
    return nullptr;
  }
  ret = bio->next_bio;
  bio->next_bio = nullptr;
  return ret;
}

BIO *BIO_next(BIO *bio) {
  if (!bio) {
    return nullptr;
  }
  return bio->next_bio;
}

BIO *BIO_find_type(BIO *bio, int type) {
  int method_type, mask;

  if (!bio) {
    return nullptr;
  }
  mask = type & 0xff;

  do {
    if (bio->method != nullptr) {
      method_type = bio->method->type;

      if (!mask) {
        if (method_type & type) {
          return bio;
        }
      } else if (method_type == type) {
        return bio;
      }
    }
    bio = bio->next_bio;
  } while (bio != nullptr);

  return nullptr;
}

int BIO_indent(BIO *bio, unsigned indent, unsigned max_indent) {
  if (indent > max_indent) {
    indent = max_indent;
  }

  while (indent--) {
    if (BIO_puts(bio, " ") != 1) {
      return 0;
    }
  }
  return 1;
}

static int print_bio(const char *str, size_t len, void *bio) {
  return BIO_write_all((BIO *)bio, str, len);
}

void ERR_print_errors(BIO *bio) { ERR_print_errors_cb(print_bio, bio); }

// bio_read_all reads everything from |bio| and prepends |prefix| to it. On
// success, |*out| is set to an allocated buffer (which should be freed with
// |OPENSSL_free|), |*out_len| is set to its length and one is returned. The
// buffer will contain |prefix| followed by the contents of |bio|. On failure,
// zero is returned.
//
// The function will fail if the size of the output would equal or exceed
// |max_len|.
static int bio_read_all(BIO *bio, uint8_t **out, size_t *out_len,
                        const uint8_t *prefix, size_t prefix_len,
                        size_t max_len) {
  static const size_t kChunkSize = 4096;

  size_t len = prefix_len + kChunkSize;
  if (len > max_len) {
    len = max_len;
  }
  if (len < prefix_len) {
    return 0;
  }
  *out = reinterpret_cast<uint8_t *>(OPENSSL_malloc(len));
  if (*out == nullptr) {
    return 0;
  }
  OPENSSL_memcpy(*out, prefix, prefix_len);
  size_t done = prefix_len;

  for (;;) {
    if (done == len) {
      OPENSSL_free(*out);
      return 0;
    }
    size_t todo = len - done;
    if (todo > INT_MAX) {
      todo = INT_MAX;
    }
    const int n = BIO_read(bio, *out + done, (int)todo);
    if (n == 0) {
      *out_len = done;
      return 1;
    } else if (n == -1) {
      OPENSSL_free(*out);
      return 0;
    }

    done += n;
    if (len < max_len && len - done < kChunkSize / 2) {
      len += kChunkSize;
      if (len < kChunkSize || len > max_len) {
        len = max_len;
      }
      uint8_t *new_buf =
          reinterpret_cast<uint8_t *>(OPENSSL_realloc(*out, len));
      if (new_buf == nullptr) {
        OPENSSL_free(*out);
        return 0;
      }
      *out = new_buf;
    }
  }
}

// bio_read_full reads |len| bytes |bio| and writes them into |out|. It
// tolerates partial reads from |bio| and returns one on success or zero if a
// read fails before |len| bytes are read. On failure, it additionally sets
// |*out_eof_on_first_read| to whether the error was due to |bio| returning zero
// on the first read. |out_eof_on_first_read| may be NULL to discard the value.
static int bio_read_full(BIO *bio, uint8_t *out, int *out_eof_on_first_read,
                         size_t len) {
  int first_read = 1;
  while (len > 0) {
    int todo = len <= INT_MAX ? (int)len : INT_MAX;
    int ret = BIO_read(bio, out, todo);
    if (ret <= 0) {
      if (out_eof_on_first_read != nullptr) {
        *out_eof_on_first_read = first_read && ret == 0;
      }
      return 0;
    }
    out += ret;
    len -= (size_t)ret;
    first_read = 0;
  }

  return 1;
}

// For compatibility with existing |d2i_*_bio| callers, |BIO_read_asn1| uses
// |ERR_LIB_ASN1| errors.
OPENSSL_DECLARE_ERROR_REASON(ASN1, ASN1_R_DECODE_ERROR)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ASN1_R_HEADER_TOO_LONG)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ASN1_R_NOT_ENOUGH_DATA)
OPENSSL_DECLARE_ERROR_REASON(ASN1, ASN1_R_TOO_LONG)

int BIO_read_asn1(BIO *bio, uint8_t **out, size_t *out_len, size_t max_len) {
  uint8_t header[6];

  static const size_t kInitialHeaderLen = 2;
  int eof_on_first_read;
  if (!bio_read_full(bio, header, &eof_on_first_read, kInitialHeaderLen)) {
    if (eof_on_first_read) {
      // Historically, OpenSSL returned |ASN1_R_HEADER_TOO_LONG| when
      // |d2i_*_bio| could not read anything. CPython conditions on this to
      // determine if |bio| was empty.
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_HEADER_TOO_LONG);
    } else {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NOT_ENOUGH_DATA);
    }
    return 0;
  }

  const uint8_t tag = header[0];
  const uint8_t length_byte = header[1];

  if ((tag & 0x1f) == 0x1f) {
    // Long form tags are not supported.
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }

  size_t len, header_len;
  if ((length_byte & 0x80) == 0) {
    // Short form length.
    len = length_byte;
    header_len = kInitialHeaderLen;
  } else {
    const size_t num_bytes = length_byte & 0x7f;

    if ((tag & 0x20 /* constructed */) != 0 && num_bytes == 0) {
      // indefinite length.
      if (!bio_read_all(bio, out, out_len, header, kInitialHeaderLen,
                        max_len)) {
        OPENSSL_PUT_ERROR(ASN1, ASN1_R_NOT_ENOUGH_DATA);
        return 0;
      }
      return 1;
    }

    if (num_bytes == 0 || num_bytes > 4) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }

    if (!bio_read_full(bio, header + kInitialHeaderLen, nullptr, num_bytes)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_NOT_ENOUGH_DATA);
      return 0;
    }
    header_len = kInitialHeaderLen + num_bytes;

    uint32_t len32 = 0;
    for (unsigned i = 0; i < num_bytes; i++) {
      len32 <<= 8;
      len32 |= header[kInitialHeaderLen + i];
    }

    if (len32 < 128) {
      // Length should have used short-form encoding.
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }

    if ((len32 >> ((num_bytes - 1) * 8)) == 0) {
      // Length should have been at least one byte shorter.
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return 0;
    }

    len = len32;
  }

  if (len + header_len < len || len + header_len > max_len || len > INT_MAX) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_TOO_LONG);
    return 0;
  }
  len += header_len;
  *out_len = len;

  *out = reinterpret_cast<uint8_t *>(OPENSSL_malloc(len));
  if (*out == nullptr) {
    return 0;
  }
  OPENSSL_memcpy(*out, header, header_len);
  if (!bio_read_full(bio, (*out) + header_len, nullptr, len - header_len)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_NOT_ENOUGH_DATA);
    OPENSSL_free(*out);
    return 0;
  }

  return 1;
}

void BIO_set_retry_special(BIO *bio) {
  bio->flags |= BIO_FLAGS_READ | BIO_FLAGS_IO_SPECIAL;
}

int BIO_set_write_buffer_size(BIO *bio, int buffer_size) { return 0; }

static CRYPTO_MUTEX g_index_lock = CRYPTO_MUTEX_INIT;
static int g_index = BIO_TYPE_START;

int BIO_get_new_index(void) {
  CRYPTO_MUTEX_lock_write(&g_index_lock);
  // If |g_index| exceeds 255, it will collide with the flags bits.
  int ret = g_index > 255 ? -1 : g_index++;
  CRYPTO_MUTEX_unlock_write(&g_index_lock);
  return ret;
}

BIO_METHOD *BIO_meth_new(int type, const char *name) {
  BIO_METHOD *method =
      reinterpret_cast<BIO_METHOD *>(OPENSSL_zalloc(sizeof(BIO_METHOD)));
  if (method == nullptr) {
    return nullptr;
  }
  method->type = type;
  method->name = name;
  return method;
}

void BIO_meth_free(BIO_METHOD *method) { OPENSSL_free(method); }

int BIO_meth_set_create(BIO_METHOD *method, int (*create_func)(BIO *)) {
  method->create = create_func;
  return 1;
}

int BIO_meth_set_destroy(BIO_METHOD *method, int (*destroy_func)(BIO *)) {
  method->destroy = destroy_func;
  return 1;
}

int BIO_meth_set_write(BIO_METHOD *method,
                       int (*write_func)(BIO *, const char *, int)) {
  method->bwrite = write_func;
  return 1;
}

int BIO_meth_set_read(BIO_METHOD *method,
                      int (*read_func)(BIO *, char *, int)) {
  method->bread = read_func;
  return 1;
}

int BIO_meth_set_gets(BIO_METHOD *method,
                      int (*gets_func)(BIO *, char *, int)) {
  method->bgets = gets_func;
  return 1;
}

int BIO_meth_set_ctrl(BIO_METHOD *method,
                      long (*ctrl_func)(BIO *, int, long, void *)) {
  method->ctrl = ctrl_func;
  return 1;
}

int BIO_meth_set_callback_ctrl(BIO_METHOD *method,
                               long (*callback_ctrl_func)(BIO *, int,
                                                          BIO_info_cb *)) {
  method->callback_ctrl = callback_ctrl_func;
  return 1;
}

void BIO_set_data(BIO *bio, void *ptr) { bio->ptr = ptr; }

void *BIO_get_data(BIO *bio) { return bio->ptr; }

void BIO_set_init(BIO *bio, int init) { bio->init = init; }

int BIO_get_init(BIO *bio) { return bio->init; }

void BIO_set_shutdown(BIO *bio, int shutdown) { bio->shutdown = shutdown; }

int BIO_get_shutdown(BIO *bio) { return bio->shutdown; }

int BIO_meth_set_puts(BIO_METHOD *method, int (*puts)(BIO *, const char *)) {
  // Ignore the parameter. We implement |BIO_puts| using |BIO_write|.
  return 1;
}

int BIO_get_ex_new_index(long argl, void *argp,      //
                         CRYPTO_EX_unused *unused,   //
                         CRYPTO_EX_dup *dup_unused,  //
                         CRYPTO_EX_free *free_func) {
  return CRYPTO_get_ex_new_index_ex(&g_ex_data_class, argl, argp, free_func);
}

int BIO_set_ex_data(BIO *bio, int idx, void *data) {
  return CRYPTO_set_ex_data(&bio->ex_data, idx, data);
}

void *BIO_get_ex_data(const BIO *bio, int idx) {
  return CRYPTO_get_ex_data(&bio->ex_data, idx);
}
