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

#include "packeted_bio.h"

#include <assert.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#include <functional>
#include <utility>
#include <vector>

#include <openssl/bio.h>
#include <openssl/mem.h>

#include "../../crypto/internal.h"


namespace {

constexpr uint8_t kOpcodePacket = 'P';
constexpr uint8_t kOpcodeTimeout = 'T';
constexpr uint8_t kOpcodeTimeoutAck = 't';
constexpr uint8_t kOpcodeMTU = 'M';
constexpr uint8_t kOpcodeExpectNextTimeout = 'E';

struct PacketedBio {
  PacketedBio(timeval *clock_arg,
              std::function<bool(timeval *)> get_timeout_arg,
              std::function<bool(uint32_t)> set_mtu_arg)
      : clock(clock_arg),
        get_timeout(std::move(get_timeout_arg)),
        set_mtu(std::move(set_mtu_arg)) {
    OPENSSL_memset(&timeout, 0, sizeof(timeout));
  }

  bool HasTimeout() const {
    return timeout.tv_sec != 0 || timeout.tv_usec != 0;
  }

  timeval timeout;
  timeval *clock;
  std::function<bool(timeval *)> get_timeout;
  std::function<bool(uint32_t)> set_mtu;
};

static int PacketedBioMethodType() {
  static int type = [] {
    int idx = BIO_get_new_index();
    BSSL_CHECK(idx > 0);
    return idx | BIO_TYPE_FILTER;
  }();
  return type;
}

PacketedBio *GetData(BIO *bio) {
  if (BIO_method_type(bio) != PacketedBioMethodType()) {
    return nullptr;
  }
  return static_cast<PacketedBio *>(BIO_get_data(bio));
}

// ReadAll reads |len| bytes from |bio| into |out|. It returns 1 on success and
// 0 or -1 on error.
static int ReadAll(BIO *bio, uint8_t *out, size_t len) {
  while (len > 0) {
    int chunk_len = INT_MAX;
    if (len <= INT_MAX) {
      chunk_len = (int)len;
    }
    int ret = BIO_read(bio, out, chunk_len);
    if (ret <= 0) {
      return ret;
    }
    out += ret;
    len -= ret;
  }
  return 1;
}

static int PacketedWrite(BIO *bio, const char *in, int inl) {
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return -1;
  }

  BIO_clear_retry_flags(bio);

  // Write the header.
  uint8_t header[5];
  header[0] = kOpcodePacket;
  header[1] = (inl >> 24) & 0xff;
  header[2] = (inl >> 16) & 0xff;
  header[3] = (inl >> 8) & 0xff;
  header[4] = inl & 0xff;
  int ret = BIO_write(next, header, sizeof(header));
  if (ret <= 0) {
    BIO_copy_next_retry(bio);
    return ret;
  }

  // Write the buffer.
  ret = BIO_write(next, in, inl);
  if (ret < 0 || (inl > 0 && ret == 0)) {
    BIO_copy_next_retry(bio);
    return ret;
  }
  assert(ret == inl);
  return ret;
}

static int PacketedRead(BIO *bio, char *out, int outl) {
  PacketedBio *data = GetData(bio);
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return -1;
  }

  BIO_clear_retry_flags(bio);

  for (;;) {
    // Read the opcode.
    uint8_t opcode;
    int ret = ReadAll(next, &opcode, sizeof(opcode));
    if (ret <= 0) {
      BIO_copy_next_retry(bio);
      return ret;
    }

    if (opcode == kOpcodeTimeout) {
      // The caller is required to advance any pending timeouts before
      // continuing.
      if (data->HasTimeout()) {
        fprintf(stderr, "Unprocessed timeout!\n");
        return -1;
      }

      // Process the timeout.
      uint8_t buf[8];
      ret = ReadAll(next, buf, sizeof(buf));
      if (ret <= 0) {
        BIO_copy_next_retry(bio);
        return ret;
      }
      uint64_t timeout = CRYPTO_load_u64_be(buf);
      timeout /= 1000;  // Convert nanoseconds to microseconds.

      data->timeout.tv_usec = timeout % 1000000;
      data->timeout.tv_sec = timeout / 1000000;

      // Send an ACK to the peer.
      ret = BIO_write(next, &kOpcodeTimeoutAck, 1);
      if (ret <= 0) {
        return ret;
      }
      assert(ret == 1);

      // Signal to the caller to retry the read, after advancing the clock.
      BIO_set_retry_read(bio);
      return -1;
    }

    if (opcode == kOpcodeMTU) {
      uint8_t buf[4];
      ret = ReadAll(next, buf, sizeof(buf));
      if (ret <= 0) {
        BIO_copy_next_retry(bio);
        return ret;
      }
      uint32_t mtu = CRYPTO_load_u32_be(buf);
      if (!data->set_mtu(mtu)) {
        fprintf(stderr, "Error setting MTU\n");
        return -1;
      }
      // Continue reading.
      continue;
    }

    if (opcode == kOpcodeExpectNextTimeout) {
      uint8_t buf[8];
      ret = ReadAll(next, buf, sizeof(buf));
      if (ret <= 0) {
        BIO_copy_next_retry(bio);
        return ret;
      }
      uint64_t expected = CRYPTO_load_u64_be(buf);
      timeval timeout;
      bool has_timeout = data->get_timeout(&timeout);
      if (expected == UINT64_MAX) {
        if (has_timeout) {
          fprintf(stderr,
                  "Expected no timeout, but got %" PRIu64 ".%06" PRIu64 "s.\n",
                  static_cast<uint64_t>(timeout.tv_sec),
                  static_cast<uint64_t>(timeout.tv_usec));
          return -1;
        }
      } else {
        expected /= 1000;  // Convert nanoseconds to microseconds.
        uint64_t expected_sec = expected / 1000000;
        uint64_t expected_usec = expected % 1000000;
        if (!has_timeout) {
          fprintf(stderr,
                  "Expected timeout of %" PRIu64 ".%06" PRIu64
                  "s, but got none.\n",
                  expected_sec, expected_usec);
          return -1;
        }
        if (static_cast<uint64_t>(timeout.tv_sec) != expected_sec ||
            static_cast<uint64_t>(timeout.tv_usec) != expected_usec) {
          fprintf(stderr,
                  "Expected timeout of %" PRIu64 ".%06" PRIu64
                  "s, but got %" PRIu64 ".%06" PRIu64 "s.\n",
                  expected_sec, expected_usec,
                  static_cast<uint64_t>(timeout.tv_sec),
                  static_cast<uint64_t>(timeout.tv_usec));
          return -1;
        }
      }
      // Continue reading.
      continue;
    }

    if (opcode != kOpcodePacket) {
      fprintf(stderr, "Unknown opcode, %u\n", opcode);
      return -1;
    }

    // Read the length prefix.
    uint8_t len_bytes[4];
    ret = ReadAll(next, len_bytes, sizeof(len_bytes));
    if (ret <= 0) {
      BIO_copy_next_retry(bio);
      return ret;
    }

    std::vector<uint8_t> buf(CRYPTO_load_u32_be(len_bytes), 0);
    ret = ReadAll(next, buf.data(), buf.size());
    if (ret <= 0) {
      fprintf(stderr, "Packeted BIO was truncated\n");
      return -1;
    }

    if (static_cast<size_t>(outl) > buf.size()) {
      outl = static_cast<int>(buf.size());
    }
    OPENSSL_memcpy(out, buf.data(), outl);
    return outl;
  }
}

static long PacketedCtrl(BIO *bio, int cmd, long num, void *ptr) {
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return 0;
  }

  BIO_clear_retry_flags(bio);
  long ret = BIO_ctrl(next, cmd, num, ptr);
  BIO_copy_next_retry(bio);
  return ret;
}

static int PacketedNew(BIO *bio) {
  BIO_set_init(bio, 1);
  return 1;
}

static int PacketedFree(BIO *bio) {
  if (bio == nullptr) {
    return 0;
  }

  delete GetData(bio);
  return 1;
}

static long PacketedCallbackCtrl(BIO *bio, int cmd, BIO_info_cb *fp) {
  BIO *next = BIO_next(bio);
  if (next == nullptr) {
    return 0;
  }
  return BIO_callback_ctrl(next, cmd, fp);
}

static const BIO_METHOD *PacketedBioMethod() {
  static const BIO_METHOD *method = [] {
    BIO_METHOD *ret = BIO_meth_new(PacketedBioMethodType(), "packeted bio");
    BSSL_CHECK(ret);
    BSSL_CHECK(BIO_meth_set_write(ret, PacketedWrite));
    BSSL_CHECK(BIO_meth_set_read(ret, PacketedRead));
    BSSL_CHECK(BIO_meth_set_ctrl(ret, PacketedCtrl));
    BSSL_CHECK(BIO_meth_set_create(ret, PacketedNew));
    BSSL_CHECK(BIO_meth_set_destroy(ret, PacketedFree));
    BSSL_CHECK(BIO_meth_set_callback_ctrl(ret, PacketedCallbackCtrl));
    return ret;
  }();
  return method;
}

}  // namespace

bssl::UniquePtr<BIO> PacketedBioCreate(
    timeval *clock, std::function<bool(timeval *)> get_timeout,
    std::function<bool(uint32_t)> set_mtu) {
  bssl::UniquePtr<BIO> bio(BIO_new(PacketedBioMethod()));
  if (!bio) {
    return nullptr;
  }
  BIO_set_data(bio.get(), new PacketedBio(clock, std::move(get_timeout),
                                          std::move(set_mtu)));
  return bio;
}

bool PacketedBioAdvanceClock(BIO *bio) {
  PacketedBio *data = GetData(bio);
  if (data == nullptr) {
    return false;
  }

  if (!data->HasTimeout()) {
    return false;
  }

  data->clock->tv_usec += data->timeout.tv_usec;
  data->clock->tv_sec += data->clock->tv_usec / 1000000;
  data->clock->tv_usec %= 1000000;
  data->clock->tv_sec += data->timeout.tv_sec;
  OPENSSL_memset(&data->timeout, 0, sizeof(data->timeout));
  return true;
}

timeval *PacketedBioGetClock(BIO *bio) {
  PacketedBio *data = GetData(bio);
  if (data == nullptr) {
    return nullptr;
  }
  return data->clock;
}
