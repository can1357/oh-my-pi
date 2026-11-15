// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "internal.h"


namespace {
struct bio_bio_st {
  BIO *peer;  // NULL if buf == NULL.
              // If peer != NULL, then peer->ptr is also a bio_bio_st,
              // and its "peer" member points back to us.
              // peer != NULL iff init != 0 in the BIO.

  // This is for what we write (i.e. reading uses peer's struct):
  int closed;     // valid iff peer != NULL
  size_t len;     // valid iff buf != NULL; 0 if peer == NULL
  size_t offset;  // valid iff buf != NULL; 0 if len == 0
  size_t size;
  uint8_t *buf;  // "size" elements (if != NULL)

  size_t request;  // valid iff peer != NULL; 0 if len != 0,
                   // otherwise set by peer to number of bytes
                   // it (unsuccessfully) tried to read,
                   // never more than buffer space (size-len) warrants.
};
}  // namespace

static int bio_new(BIO *bio) {
  struct bio_bio_st *b =
      reinterpret_cast<bio_bio_st *>(OPENSSL_zalloc(sizeof *b));
  if (b == nullptr) {
    return 0;
  }

  b->size = 17 * 1024;  // enough for one TLS record (just a default)
  bio->ptr = b;
  return 1;
}

static void bio_destroy_pair(BIO *bio) {
  struct bio_bio_st *b = reinterpret_cast<bio_bio_st *>(bio->ptr);
  BIO *peer_bio;
  struct bio_bio_st *peer_b;

  if (b == nullptr) {
    return;
  }

  peer_bio = b->peer;
  if (peer_bio == nullptr) {
    return;
  }

  peer_b = reinterpret_cast<bio_bio_st *>(peer_bio->ptr);

  assert(peer_b != nullptr);
  assert(peer_b->peer == bio);

  peer_b->peer = nullptr;
  peer_bio->init = 0;
  assert(peer_b->buf != nullptr);
  peer_b->len = 0;
  peer_b->offset = 0;

  b->peer = nullptr;
  bio->init = 0;
  assert(b->buf != nullptr);
  b->len = 0;
  b->offset = 0;
}

static int bio_free(BIO *bio) {
  struct bio_bio_st *b = reinterpret_cast<bio_bio_st *>(bio->ptr);

  assert(b != nullptr);

  if (b->peer) {
    bio_destroy_pair(bio);
  }

  OPENSSL_free(b->buf);
  OPENSSL_free(b);

  return 1;
}

static int bio_read(BIO *bio, char *buf, int size_) {
  size_t size = size_;
  size_t rest;
  struct bio_bio_st *b, *peer_b;

  BIO_clear_retry_flags(bio);

  if (!bio->init) {
    return 0;
  }

  b = reinterpret_cast<bio_bio_st *>(bio->ptr);
  assert(b != nullptr);
  assert(b->peer != nullptr);
  peer_b = reinterpret_cast<bio_bio_st *>(b->peer->ptr);
  assert(peer_b != nullptr);
  assert(peer_b->buf != nullptr);

  peer_b->request = 0;  // will be set in "retry_read" situation

  if (buf == nullptr || size == 0) {
    return 0;
  }

  if (peer_b->len == 0) {
    if (peer_b->closed) {
      return 0;  // writer has closed, and no data is left
    } else {
      BIO_set_retry_read(bio);  // buffer is empty
      if (size <= peer_b->size) {
        peer_b->request = size;
      } else {
        // don't ask for more than the peer can
        // deliver in one write
        peer_b->request = peer_b->size;
      }
      return -1;
    }
  }

  // we can read
  if (peer_b->len < size) {
    size = peer_b->len;
  }

  // now read "size" bytes
  rest = size;

  assert(rest > 0);
  // one or two iterations
  do {
    size_t chunk;

    assert(rest <= peer_b->len);
    if (peer_b->offset + rest <= peer_b->size) {
      chunk = rest;
    } else {
      // wrap around ring buffer
      chunk = peer_b->size - peer_b->offset;
    }
    assert(peer_b->offset + chunk <= peer_b->size);

    OPENSSL_memcpy(buf, peer_b->buf + peer_b->offset, chunk);

    peer_b->len -= chunk;
    if (peer_b->len) {
      peer_b->offset += chunk;
      assert(peer_b->offset <= peer_b->size);
      if (peer_b->offset == peer_b->size) {
        peer_b->offset = 0;
      }
      buf += chunk;
    } else {
      // buffer now empty, no need to advance "buf"
      assert(chunk == rest);
      peer_b->offset = 0;
    }
    rest -= chunk;
  } while (rest);

  // |size| is bounded by the buffer size, which fits in |int|.
  return (int)size;
}

static int bio_write(BIO *bio, const char *buf, int num_) {
  size_t num = num_;
  size_t rest;
  struct bio_bio_st *b;

  BIO_clear_retry_flags(bio);

  if (!bio->init || buf == nullptr || num == 0) {
    return 0;
  }

  b = reinterpret_cast<bio_bio_st *>(bio->ptr);
  assert(b != nullptr);
  assert(b->peer != nullptr);
  assert(b->buf != nullptr);

  b->request = 0;
  if (b->closed) {
    // we already closed
    OPENSSL_PUT_ERROR(BIO, BIO_R_BROKEN_PIPE);
    return -1;
  }

  assert(b->len <= b->size);

  if (b->len == b->size) {
    BIO_set_retry_write(bio);  // buffer is full
    return -1;
  }

  // we can write
  if (num > b->size - b->len) {
    num = b->size - b->len;
  }

  // now write "num" bytes
  rest = num;

  assert(rest > 0);
  // one or two iterations
  do {
    size_t write_offset;
    size_t chunk;

    assert(b->len + rest <= b->size);

    write_offset = b->offset + b->len;
    if (write_offset >= b->size) {
      write_offset -= b->size;
    }
    // b->buf[write_offset] is the first byte we can write to.

    if (write_offset + rest <= b->size) {
      chunk = rest;
    } else {
      // wrap around ring buffer
      chunk = b->size - write_offset;
    }

    OPENSSL_memcpy(b->buf + write_offset, buf, chunk);

    b->len += chunk;

    assert(b->len <= b->size);

    rest -= chunk;
    buf += chunk;
  } while (rest);

  // |num| is bounded by the buffer size, which fits in |int|.
  return (int)num;
}

static int bio_make_pair(BIO *bio1, BIO *bio2, size_t writebuf1_len,
                         size_t writebuf2_len) {
  struct bio_bio_st *b1, *b2;

  assert(bio1 != nullptr);
  assert(bio2 != nullptr);

  b1 = reinterpret_cast<bio_bio_st *>(bio1->ptr);
  b2 = reinterpret_cast<bio_bio_st *>(bio2->ptr);

  if (b1->peer != nullptr || b2->peer != nullptr) {
    OPENSSL_PUT_ERROR(BIO, BIO_R_IN_USE);
    return 0;
  }

  if (b1->buf == nullptr) {
    if (writebuf1_len) {
      b1->size = writebuf1_len;
    }
    b1->buf = reinterpret_cast<uint8_t *>(OPENSSL_malloc(b1->size));
    if (b1->buf == nullptr) {
      return 0;
    }
    b1->len = 0;
    b1->offset = 0;
  }

  if (b2->buf == nullptr) {
    if (writebuf2_len) {
      b2->size = writebuf2_len;
    }
    b2->buf = reinterpret_cast<uint8_t *>(OPENSSL_malloc(b2->size));
    if (b2->buf == nullptr) {
      return 0;
    }
    b2->len = 0;
    b2->offset = 0;
  }

  b1->peer = bio2;
  b1->closed = 0;
  b1->request = 0;
  b2->peer = bio1;
  b2->closed = 0;
  b2->request = 0;

  bio1->init = 1;
  bio2->init = 1;

  return 1;
}

static long bio_ctrl(BIO *bio, int cmd, long num, void *ptr) {
  struct bio_bio_st *b = reinterpret_cast<bio_bio_st *>(bio->ptr);
  assert(b != nullptr);
  switch (cmd) {
    // Specific control codes first:
    case BIO_C_GET_WRITE_BUF_SIZE:
      // TODO(crbug.com/412584975): This can overflow on 64-bit Windows. Do we
      // need it? It implements |BIO_get_write_buf_size|, but we don't have the
      // wrapper.
      return static_cast<long>(b->size);

    case BIO_C_GET_WRITE_GUARANTEE:
      // How many bytes can the caller feed to the next write
      // without having to keep any?
      if (b->peer == nullptr || b->closed) {
        return 0;
      }
      // TODO(crbug.com/412584975): This can overflow on 64-bit Windows.
      return static_cast<long>(b->size - b->len);

    case BIO_C_GET_READ_REQUEST:
      // If the peer unsuccessfully tried to read, how many bytes
      // were requested?  (As with BIO_CTRL_PENDING, that number
      // can usually be treated as boolean.)
      //
      // TODO(crbug.com/412584975): This can overflow on 64-bit Windows.
      return static_cast<long>(b->request);

    case BIO_C_RESET_READ_REQUEST:
      // Reset request.  (Can be useful after read attempts
      // at the other side that are meant to be non-blocking,
      // e.g. when probing SSL_read to see if any data is
      // available.)
      b->request = 0;
      return 1;

    case BIO_C_SHUTDOWN_WR:
      // similar to shutdown(..., SHUT_WR)
      b->closed = 1;
      return 1;

    // Standard control codes:
    case BIO_CTRL_GET_CLOSE:
      return bio->shutdown;

    case BIO_CTRL_SET_CLOSE:
      bio->shutdown = static_cast<int>(num);
      return 1;

    case BIO_CTRL_PENDING:
      if (b->peer != nullptr) {
        struct bio_bio_st *peer_b =
            reinterpret_cast<bio_bio_st *>(b->peer->ptr);
        // TODO(crbug.com/412584975): This can overflow on 64-bit Windows.
        return static_cast<long>(peer_b->len);
      }
      return 0;

    case BIO_CTRL_WPENDING:
      if (b->buf == nullptr) {
        return 0;
      }
      // TODO(crbug.com/412584975): This can overflow on 64-bit Windows.
      return static_cast<long>(b->len);

    case BIO_CTRL_FLUSH:
      return 1;

    case BIO_CTRL_EOF: {
      if (b->peer) {
        auto *peer_b = reinterpret_cast<bio_bio_st *>(b->peer->ptr);
        assert(peer_b != nullptr);
        return peer_b->len == 0 && peer_b->closed;
      }
      return 1;
    }

    default:
      return 0;
  }
}


static const BIO_METHOD methods_biop = {
    BIO_TYPE_BIO,
    "BIO pair",
    bio_write,
    bio_read,
    /*gets=*/nullptr,
    bio_ctrl,
    bio_new,
    bio_free,
    /*callback_ctrl=*/nullptr,
};

static const BIO_METHOD *bio_s_bio(void) { return &methods_biop; }

int BIO_new_bio_pair(BIO **bio1_p, size_t writebuf1_len, BIO **bio2_p,
                     size_t writebuf2_len) {
  BIO *bio1 = BIO_new(bio_s_bio());
  BIO *bio2 = BIO_new(bio_s_bio());
  if (bio1 == nullptr || bio2 == nullptr ||
      !bio_make_pair(bio1, bio2, writebuf1_len, writebuf2_len)) {
    BIO_free(bio1);
    BIO_free(bio2);
    *bio1_p = nullptr;
    *bio2_p = nullptr;
    return 0;
  }

  *bio1_p = bio1;
  *bio2_p = bio2;
  return 1;
}

size_t BIO_ctrl_get_read_request(BIO *bio) {
  return BIO_ctrl(bio, BIO_C_GET_READ_REQUEST, 0, nullptr);
}

size_t BIO_ctrl_get_write_guarantee(BIO *bio) {
  return BIO_ctrl(bio, BIO_C_GET_WRITE_GUARANTEE, 0, nullptr);
}

int BIO_shutdown_wr(BIO *bio) {
  return (int)BIO_ctrl(bio, BIO_C_SHUTDOWN_WR, 0, nullptr);
}
