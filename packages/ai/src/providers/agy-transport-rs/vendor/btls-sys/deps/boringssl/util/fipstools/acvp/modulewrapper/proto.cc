// Copyright 2025 The BoringSSL Authors
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

#include <string>

#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/uio.h>
#include <unistd.h>

#include <functional>
#include <memory>
#include <vector>

#include <openssl/span.h>

#include "../../../../crypto/internal.h"
#include "modulewrapper.h"


namespace bssl::acvp {

#if defined(OPENSSL_TRUSTY)
#include <trusty_log.h>
#define LOG_ERROR(...) TLOGE(__VA_ARGS__)
#define TLOG_TAG "modulewrapper"
#else
#define LOG_ERROR(...) fprintf(stderr, __VA_ARGS__)
#endif  // OPENSSL_TRUSTY

constexpr size_t kMaxArgLength = (1 << 20);

RequestBuffer::~RequestBuffer() = default;

class RequestBufferImpl : public RequestBuffer {
 public:
  ~RequestBufferImpl() = default;

  std::vector<uint8_t> buf;
  Span<const uint8_t> args[kMaxArgs];
};

// static
std::unique_ptr<RequestBuffer> RequestBuffer::New() {
  return std::make_unique<RequestBufferImpl>();
}

static bool ReadAll(int fd, void *in_data, size_t data_len) {
  uint8_t *data = reinterpret_cast<uint8_t *>(in_data);
  size_t done = 0;

  while (done < data_len) {
    ssize_t r;
    do {
      r = read(fd, &data[done], data_len - done);
    } while (r == -1 && errno == EINTR);

    if (r <= 0) {
      return false;
    }

    done += r;
  }

  return true;
}

Span<const Span<const uint8_t>> ParseArgsFromFd(int fd,
                                                RequestBuffer *in_buffer) {
  RequestBufferImpl *buffer = reinterpret_cast<RequestBufferImpl *>(in_buffer);
  uint32_t nums[1 + kMaxArgs];
  const Span<const Span<const uint8_t>> empty_span;

  if (!ReadAll(fd, nums, sizeof(uint32_t) * 2)) {
    return empty_span;
  }

  const size_t num_args = nums[0];
  if (num_args == 0) {
    LOG_ERROR("Invalid, zero-argument operation requested.\n");
    return empty_span;
  } else if (num_args > kMaxArgs) {
    LOG_ERROR("Operation requested with %zu args, but %zu is the limit.\n",
              num_args, kMaxArgs);
    return empty_span;
  }

  if (num_args > 1 &&
      !ReadAll(fd, &nums[2], sizeof(uint32_t) * (num_args - 1))) {
    return empty_span;
  }

  size_t need = 0;
  for (size_t i = 0; i < num_args; i++) {
    const size_t arg_length = nums[i + 1];
    if (i == 0 && arg_length > kMaxNameLength) {
      LOG_ERROR("Operation with name of length %zu exceeded limit of %zu.\n",
                arg_length, kMaxNameLength);
      return empty_span;
    } else if (arg_length > kMaxArgLength) {
      LOG_ERROR(
          "Operation with argument of length %zu exceeded limit of %zu.\n",
          arg_length, kMaxArgLength);
      return empty_span;
    }

    // This static_assert confirms that the following addition doesn't
    // overflow.
    static_assert((kMaxArgs - 1 * kMaxArgLength) + kMaxNameLength > (1 << 30),
                  "Argument limits permit excessive messages");
    need += arg_length;
  }

  if (need > buffer->buf.size()) {
    size_t alloced = need + (need >> 1);
    if (alloced < need) {
      abort();
    }
    buffer->buf.resize(alloced);
  }

  if (!ReadAll(fd, buffer->buf.data(), need)) {
    return empty_span;
  }

  size_t offset = 0;
  for (size_t i = 0; i < num_args; i++) {
    buffer->args[i] = Span<const uint8_t>(&buffer->buf[offset], nums[i + 1]);
    offset += nums[i + 1];
  }

  return Span<const Span<const uint8_t>>(buffer->args, num_args);
}

// g_reply_buffer contains buffered replies which will be flushed when acvp
// requests.
static std::vector<uint8_t> g_reply_buffer;

bool WriteReplyToBuffer(const std::vector<Span<const uint8_t>> &spans) {
  if (spans.size() > kMaxArgs) {
    abort();
  }

  uint8_t buf[4];
  CRYPTO_store_u32_le(buf, spans.size());
  g_reply_buffer.insert(g_reply_buffer.end(), buf, buf + sizeof(buf));
  for (const auto &span : spans) {
    CRYPTO_store_u32_le(buf, span.size());
    g_reply_buffer.insert(g_reply_buffer.end(), buf, buf + sizeof(buf));
  }
  for (const auto &span : spans) {
    g_reply_buffer.insert(g_reply_buffer.end(), span.begin(), span.end());
  }

  return true;
}

bool FlushBuffer(int fd) {
  size_t done = 0;

  while (done < g_reply_buffer.size()) {
    ssize_t n;
    do {
      n = write(fd, g_reply_buffer.data() + done, g_reply_buffer.size() - done);
    } while (n < 0 && errno == EINTR);

    if (n < 0) {
      return false;
    }
    done += static_cast<size_t>(n);
  }

  g_reply_buffer.clear();

  return true;
}

bool WriteReplyToFd(int fd, const std::vector<Span<const uint8_t>> &spans) {
  if (spans.size() > kMaxArgs) {
    abort();
  }

  uint32_t nums[1 + kMaxArgs];
  iovec iovs[kMaxArgs + 1];
  nums[0] = spans.size();
  iovs[0].iov_base = nums;
  iovs[0].iov_len = sizeof(uint32_t) * (1 + spans.size());

  size_t num_iov = 1;
  for (size_t i = 0; i < spans.size(); i++) {
    const auto &span = spans[i];
    nums[i + 1] = span.size();
    if (span.empty()) {
      continue;
    }

    iovs[num_iov].iov_base = const_cast<uint8_t *>(span.data());
    iovs[num_iov].iov_len = span.size();
    num_iov++;
  }

  size_t iov_done = 0;
  while (iov_done < num_iov) {
    ssize_t r;
    do {
      r = writev(fd, &iovs[iov_done], num_iov - iov_done);
    } while (r == -1 && errno == EINTR);

    if (r <= 0) {
      return false;
    }

    size_t written = r;
    for (size_t i = iov_done; i < num_iov && written > 0; i++) {
      iovec &iov = iovs[i];

      size_t done = written;
      if (done > iov.iov_len) {
        done = iov.iov_len;
      }

      iov.iov_base = reinterpret_cast<uint8_t *>(iov.iov_base) + done;
      iov.iov_len -= done;
      written -= done;

      if (iov.iov_len == 0) {
        iov_done++;
      }
    }

    assert(written == 0);
  }

  return true;
}

int RunModuleWrapper() {
  // modulewrapper buffers responses to the greatest degree allowed in order to
  // fully exercise the async handling in acvptool.
  std::unique_ptr<bssl::acvp::RequestBuffer> buffer =
      bssl::acvp::RequestBuffer::New();
  const bssl::acvp::ReplyCallback write_reply = std::bind(
      bssl::acvp::WriteReplyToFd, STDOUT_FILENO, std::placeholders::_1);
  const bssl::acvp::ReplyCallback buffer_reply =
      std::bind(bssl::acvp::WriteReplyToBuffer, std::placeholders::_1);

  for (;;) {
    const bssl::Span<const bssl::Span<const uint8_t>> args =
        ParseArgsFromFd(STDIN_FILENO, buffer.get());
    if (args.empty()) {
      return 1;
    }

    auto name = bssl::BytesAsStringView(args[0]);
    if (name == "flush") {
      if (!bssl::acvp::FlushBuffer(STDOUT_FILENO)) {
        abort();
      }
      continue;
    }

    const bssl::acvp::Handler handler = bssl::acvp::FindHandler(args);
    if (!handler) {
      return 2;
    }

    auto &reply_callback = name == "getConfig" ? write_reply : buffer_reply;
    if (!handler(args.subspan(1).data(), reply_callback)) {
      fprintf(stderr, "\'%s\' operation failed.\n", std::string(name).c_str());
      return 3;
    }
  }
}

}  // namespace bssl::acvp
