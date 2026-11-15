// Copyright 2014 The BoringSSL Authors
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

#include "async_bio.h"

#include <errno.h>
#include <string.h>

#include <openssl/bio.h>
#include <openssl/mem.h>

#include "../../crypto/internal.h"


namespace {

struct AsyncBio {
  bool datagram = false;
  size_t read_quota = 0;
  size_t write_quota = 0;
};

static int AsyncBioMethodType() {
  static int type = [] {
    int idx = BIO_get_new_index();
    BSSL_CHECK(idx > 0);
    return idx | BIO_TYPE_FILTER;
  }();
  return type;
}

AsyncBio *GetData(BIO *bio) {
  if (BIO_method_type(bio) != AsyncBioMethodType()) {
    return nullptr;
  }
  return static_cast<AsyncBio *>(BIO_get_data(bio));
}

static int AsyncWrite(BIO *bio, const char *in, int inl) {
  AsyncBio *a = GetData(bio);
  BIO *next = BIO_next(bio);
  if (a == nullptr || next == nullptr) {
    return 0;
  }

  BIO_clear_retry_flags(bio);

  if (a->write_quota == 0) {
    BIO_set_retry_write(bio);
    errno = EAGAIN;
    return -1;
  }

  if (!a->datagram && static_cast<size_t>(inl) > a->write_quota) {
    inl = static_cast<int>(a->write_quota);
  }
  int ret = BIO_write(next, in, inl);
  if (ret <= 0) {
    BIO_copy_next_retry(bio);
  } else {
    a->write_quota -= (a->datagram ? 1 : ret);
  }
  return ret;
}

static int AsyncRead(BIO *bio, char *out, int outl) {
  AsyncBio *a = GetData(bio);
  BIO *next = BIO_next(bio);
  if (a == nullptr || next == nullptr) {
    return 0;
  }

  BIO_clear_retry_flags(bio);

  if (a->read_quota == 0) {
    BIO_set_retry_read(bio);
    errno = EAGAIN;
    return -1;
  }

  if (!a->datagram && static_cast<size_t>(outl) > a->read_quota) {
    outl = static_cast<int>(a->read_quota);
  }
  int ret = BIO_read(next, out, outl);
  if (ret <= 0) {
    BIO_copy_next_retry(bio);
  } else {
    a->read_quota -= (a->datagram ? 1 : ret);
  }
  return ret;
}

static long AsyncCtrl(BIO *bio, int cmd, long num, void *ptr) {
  AsyncBio *a = GetData(bio);
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return 0;
  }
  BIO_clear_retry_flags(bio);
  // Model an async flush as consuming one byte of write quota.
  if (cmd == BIO_CTRL_FLUSH && a->write_quota == 0) {
    BIO_set_retry_write(bio);
    errno = EAGAIN;
    return -1;
  }
  long ret = BIO_ctrl(next, cmd, num, ptr);
  if (cmd == BIO_CTRL_FLUSH && ret > 0) {
    a->write_quota--;
  }
  BIO_copy_next_retry(bio);
  return ret;
}

static int AsyncNew(BIO *bio) {
  BIO_set_data(bio, new AsyncBio);
  BIO_set_init(bio, 1);
  return 1;
}

static int AsyncFree(BIO *bio) {
  if (bio == nullptr) {
    return 0;
  }

  delete GetData(bio);
  BIO_set_data(bio, nullptr);
  BIO_set_init(bio, 0);
  return 1;
}

static long AsyncCallbackCtrl(BIO *bio, int cmd, BIO_info_cb *fp) {
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return 0;
  }
  return BIO_callback_ctrl(next, cmd, fp);
}

static const BIO_METHOD *AsyncBioMethod() {
  static const BIO_METHOD *method = [] {
    BIO_METHOD *ret = BIO_meth_new(AsyncBioMethodType(), "async bio");
    BSSL_CHECK(ret);
    BSSL_CHECK(BIO_meth_set_write(ret, AsyncWrite));
    BSSL_CHECK(BIO_meth_set_read(ret, AsyncRead));
    BSSL_CHECK(BIO_meth_set_ctrl(ret, AsyncCtrl));
    BSSL_CHECK(BIO_meth_set_create(ret, AsyncNew));
    BSSL_CHECK(BIO_meth_set_destroy(ret, AsyncFree));
    BSSL_CHECK(BIO_meth_set_callback_ctrl(ret, AsyncCallbackCtrl));
    return ret;
  }();
  return method;
}

}  // namespace

bssl::UniquePtr<BIO> AsyncBioCreate() {
  return bssl::UniquePtr<BIO>(BIO_new(AsyncBioMethod()));
}

bssl::UniquePtr<BIO> AsyncBioCreateDatagram() {
  bssl::UniquePtr<BIO> ret(BIO_new(AsyncBioMethod()));
  if (!ret) {
    return nullptr;
  }
  GetData(ret.get())->datagram = true;
  return ret;
}

void AsyncBioAllowRead(BIO *bio, size_t count) {
  AsyncBio *a = GetData(bio);
  if (a == nullptr) {
    return;
  }
  a->read_quota += count;
}

void AsyncBioAllowWrite(BIO *bio, size_t count) {
  AsyncBio *a = GetData(bio);
  if (a == nullptr) {
    return;
  }
  a->write_quota += count;
}
