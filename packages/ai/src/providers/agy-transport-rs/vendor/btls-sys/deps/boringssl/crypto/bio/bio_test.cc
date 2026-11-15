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

#include <algorithm>
#include <string>
#include <utility>

#include <gtest/gtest.h>

#include <openssl/bio.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"
#include "../test/file_util.h"
#include "../test/test_util.h"

#if !defined(OPENSSL_WINDOWS)
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#else
#include <fcntl.h>
#include <io.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

namespace {

#if !defined(OPENSSL_WINDOWS)
using Socket = int;
#define INVALID_SOCKET (-1)
static int closesocket(int sock) { return close(sock); }
static std::string LastSocketError() { return strerror(errno); }
static const int kOpenReadOnlyBinary = O_RDONLY;
static const int kOpenReadOnlyText = O_RDONLY;
#else
using Socket = SOCKET;
static std::string LastSocketError() {
  char buf[DECIMAL_SIZE(int) + 1];
  snprintf(buf, sizeof(buf), "%d", WSAGetLastError());
  return buf;
}
static const int kOpenReadOnlyBinary = _O_RDONLY | _O_BINARY;
static const int kOpenReadOnlyText = O_RDONLY | _O_TEXT;
#endif

class OwnedSocket {
 public:
  OwnedSocket() = default;
  explicit OwnedSocket(Socket sock) : sock_(sock) {}
  OwnedSocket(OwnedSocket &&other) { *this = std::move(other); }
  ~OwnedSocket() { reset(); }
  OwnedSocket &operator=(OwnedSocket &&other) {
    reset(other.release());
    return *this;
  }

  bool is_valid() const { return sock_ != INVALID_SOCKET; }
  Socket get() const { return sock_; }
  Socket release() { return std::exchange(sock_, INVALID_SOCKET); }

  void reset(Socket sock = INVALID_SOCKET) {
    if (is_valid()) {
      closesocket(sock_);
    }

    sock_ = sock;
  }

 private:
  Socket sock_ = INVALID_SOCKET;
};

struct SockaddrStorage {
  int family() const { return storage.ss_family; }

  sockaddr *addr_mut() { return reinterpret_cast<sockaddr *>(&storage); }
  const sockaddr *addr() const {
    return reinterpret_cast<const sockaddr *>(&storage);
  }

  sockaddr_in ToIPv4() const {
    if (family() != AF_INET || len != sizeof(sockaddr_in)) {
      abort();
    }
    // These APIs were seemingly designed before C's strict aliasing rule, and
    // C++'s strict union handling. Make a copy so the compiler does not read
    // this as an aliasing violation.
    sockaddr_in ret;
    OPENSSL_memcpy(&ret, &storage, sizeof(ret));
    return ret;
  }

  sockaddr_in6 ToIPv6() const {
    if (family() != AF_INET6 || len != sizeof(sockaddr_in6)) {
      abort();
    }
    // These APIs were seemingly designed before C's strict aliasing rule, and
    // C++'s strict union handling. Make a copy so the compiler does not read
    // this as an aliasing violation.
    sockaddr_in6 ret;
    OPENSSL_memcpy(&ret, &storage, sizeof(ret));
    return ret;
  }

  sockaddr_storage storage = {};
  socklen_t len = sizeof(storage);
};

static OwnedSocket Bind(int family, const sockaddr *addr, socklen_t addr_len) {
  OwnedSocket sock(socket(family, SOCK_STREAM, 0));
  if (!sock.is_valid()) {
    return OwnedSocket();
  }

  if (bind(sock.get(), addr, addr_len) != 0) {
    return OwnedSocket();
  }

  return sock;
}

static OwnedSocket ListenLoopback(int backlog) {
  // Try binding to IPv6.
  sockaddr_in6 sin6;
  OPENSSL_memset(&sin6, 0, sizeof(sin6));
  sin6.sin6_family = AF_INET6;
  if (inet_pton(AF_INET6, "::1", &sin6.sin6_addr) != 1) {
    return OwnedSocket();
  }
  OwnedSocket sock =
      Bind(AF_INET6, reinterpret_cast<const sockaddr *>(&sin6), sizeof(sin6));
  if (!sock.is_valid()) {
    // Try binding to IPv4.
    sockaddr_in sin;
    OPENSSL_memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    if (inet_pton(AF_INET, "127.0.0.1", &sin.sin_addr) != 1) {
      return OwnedSocket();
    }
    sock = Bind(AF_INET, reinterpret_cast<const sockaddr *>(&sin), sizeof(sin));
  }
  if (!sock.is_valid()) {
    return OwnedSocket();
  }

  if (listen(sock.get(), backlog) != 0) {
    return OwnedSocket();
  }

  return sock;
}

static bool SocketSetNonBlocking(Socket sock) {
#if defined(OPENSSL_WINDOWS)
  u_long arg = 1;
  return ioctlsocket(sock, FIONBIO, &arg) == 0;
#else
  int flags = fcntl(sock, F_GETFL, 0);
  if (flags < 0) {
    return false;
  }
  flags |= O_NONBLOCK;
  return fcntl(sock, F_SETFL, flags) == 0;
#endif
}

enum class WaitType { kRead, kWrite };

static bool WaitForSocket(Socket sock, WaitType wait_type) {
  // Use an arbitrary 5 second timeout, so the test doesn't hang indefinitely if
  // there's an issue.
  static const int kTimeoutSeconds = 5;
#if defined(OPENSSL_WINDOWS)
  fd_set read_set, write_set;
  FD_ZERO(&read_set);
  FD_ZERO(&write_set);
  fd_set *wait_set = wait_type == WaitType::kRead ? &read_set : &write_set;
  FD_SET(sock, wait_set);
  timeval timeout;
  timeout.tv_sec = kTimeoutSeconds;
  timeout.tv_usec = 0;
  if (select(0 /* unused on Windows */, &read_set, &write_set, nullptr,
             &timeout) <= 0) {
    return false;
  }
  return FD_ISSET(sock, wait_set);
#else
  short events = wait_type == WaitType::kRead ? POLLIN : POLLOUT;
  pollfd fd = {/*fd=*/sock, events, /*revents=*/0};
  return poll(&fd, 1, kTimeoutSeconds * 1000) == 1 && (fd.revents & events);
#endif
}

TEST(BIOTest, SocketConnect) {
  static const char kTestMessage[] = "test";
  OwnedSocket listening_sock = ListenLoopback(/*backlog=*/1);
  ASSERT_TRUE(listening_sock.is_valid()) << LastSocketError();

  SockaddrStorage addr;
  ASSERT_EQ(getsockname(listening_sock.get(), addr.addr_mut(), &addr.len), 0)
      << LastSocketError();

  char hostname[80];
  if (addr.family() == AF_INET6) {
    snprintf(hostname, sizeof(hostname), "[::1]:%d",
             ntohs(addr.ToIPv6().sin6_port));
  } else {
    snprintf(hostname, sizeof(hostname), "127.0.0.1:%d",
             ntohs(addr.ToIPv4().sin_port));
  }

  // Connect to it with a connect BIO.
  bssl::UniquePtr<BIO> bio(BIO_new_connect(hostname));
  ASSERT_TRUE(bio);

  // Write a test message to the BIO. This is assumed to be smaller than the
  // transport buffer.
  ASSERT_EQ(static_cast<int>(sizeof(kTestMessage)),
            BIO_write(bio.get(), kTestMessage, sizeof(kTestMessage)))
      << LastSocketError();

  // Accept the socket.
  OwnedSocket sock(accept(listening_sock.get(), addr.addr_mut(), &addr.len));
  ASSERT_TRUE(sock.is_valid()) << LastSocketError();

  // Check the same message is read back out.
  char buf[sizeof(kTestMessage)];
  ASSERT_EQ(static_cast<int>(sizeof(kTestMessage)),
            recv(sock.get(), buf, sizeof(buf), 0))
      << LastSocketError();
  EXPECT_EQ(Bytes(kTestMessage, sizeof(kTestMessage)), Bytes(buf, sizeof(buf)));
}

TEST(BIOTest, SocketNonBlocking) {
  OwnedSocket listening_sock = ListenLoopback(/*backlog=*/1);
  ASSERT_TRUE(listening_sock.is_valid()) << LastSocketError();

  // Connect to |listening_sock|.
  SockaddrStorage addr;
  ASSERT_EQ(getsockname(listening_sock.get(), addr.addr_mut(), &addr.len), 0)
      << LastSocketError();
  OwnedSocket connect_sock(socket(addr.family(), SOCK_STREAM, 0));
  ASSERT_TRUE(connect_sock.is_valid()) << LastSocketError();
  ASSERT_EQ(connect(connect_sock.get(), addr.addr(), addr.len), 0)
      << LastSocketError();
  ASSERT_TRUE(SocketSetNonBlocking(connect_sock.get())) << LastSocketError();
  bssl::UniquePtr<BIO> connect_bio(
      BIO_new_socket(connect_sock.get(), BIO_NOCLOSE));
  ASSERT_TRUE(connect_bio);

  // Make a corresponding accepting socket.
  OwnedSocket accept_sock(
      accept(listening_sock.get(), addr.addr_mut(), &addr.len));
  ASSERT_TRUE(accept_sock.is_valid()) << LastSocketError();
  ASSERT_TRUE(SocketSetNonBlocking(accept_sock.get())) << LastSocketError();
  bssl::UniquePtr<BIO> accept_bio(
      BIO_new_socket(accept_sock.get(), BIO_NOCLOSE));
  ASSERT_TRUE(accept_bio);

  // Exchange data through the socket.
  static const char kTestMessage[] = "hello, world";

  // Reading from |accept_bio| should not block.
  char buf[sizeof(kTestMessage)];
  int ret = BIO_read(accept_bio.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, -1);
  EXPECT_TRUE(BIO_should_read(accept_bio.get())) << LastSocketError();

  // Writing to |connect_bio| should eventually overflow the transport buffers
  // and also give a retryable error.
  int bytes_written = 0;
  for (;;) {
    ret = BIO_write(connect_bio.get(), kTestMessage, sizeof(kTestMessage));
    if (ret <= 0) {
      EXPECT_EQ(ret, -1);
      EXPECT_TRUE(BIO_should_write(connect_bio.get())) << LastSocketError();
      break;
    }
    bytes_written += ret;
  }
  EXPECT_GT(bytes_written, 0);

  // |accept_bio| should readable. Drain it. Note data is not always available
  // from loopback immediately, notably on macOS, so wait for the socket first.
  int bytes_read = 0;
  while (bytes_read < bytes_written) {
    ASSERT_TRUE(WaitForSocket(accept_sock.get(), WaitType::kRead))
        << LastSocketError();
    ret = BIO_read(accept_bio.get(), buf, sizeof(buf));
    ASSERT_GT(ret, 0);
    bytes_read += ret;
  }

  // |connect_bio| should become writeable again.
  ASSERT_TRUE(WaitForSocket(accept_sock.get(), WaitType::kWrite))
      << LastSocketError();
  ret = BIO_write(connect_bio.get(), kTestMessage, sizeof(kTestMessage));
  EXPECT_EQ(static_cast<int>(sizeof(kTestMessage)), ret);

  ASSERT_TRUE(WaitForSocket(accept_sock.get(), WaitType::kRead))
      << LastSocketError();
  ret = BIO_read(accept_bio.get(), buf, sizeof(buf));
  EXPECT_EQ(static_cast<int>(sizeof(kTestMessage)), ret);
  EXPECT_EQ(Bytes(buf), Bytes(kTestMessage));

  // Close one socket. We should get an EOF out the other.
  connect_bio.reset();
  connect_sock.reset();

  ASSERT_TRUE(WaitForSocket(accept_sock.get(), WaitType::kRead))
      << LastSocketError();
  ret = BIO_read(accept_bio.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, 0) << LastSocketError();
  EXPECT_FALSE(BIO_should_read(accept_bio.get()));
}

TEST(BIOTest, Printf) {
  // Test a short output, a very long one, and various sizes around
  // 256 (the size of the buffer) to ensure edge cases are correct.
  static const size_t kLengths[] = {5, 250, 251, 252, 253, 254, 1023};

  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(bio);

  for (size_t length : kLengths) {
    SCOPED_TRACE(length);

    std::string in(length, 'a');

    int ret = BIO_printf(bio.get(), "test %s", in.c_str());
    ASSERT_GE(ret, 0);
    EXPECT_EQ(5 + length, static_cast<size_t>(ret));

    const uint8_t *contents;
    size_t len;
    ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
    EXPECT_EQ("test " + in, bssl::BytesAsStringView(bssl::Span(contents, len)));

    ASSERT_TRUE(BIO_reset(bio.get()));
  }
}

TEST(BIOTest, ReadASN1) {
  static const size_t kLargeASN1PayloadLen = 8000;

  struct ASN1Test {
    bool should_succeed;
    std::vector<uint8_t> input;
    // suffix_len is the number of zeros to append to |input|.
    size_t suffix_len;
    // expected_len, if |should_succeed| is true, is the expected length of the
    // ASN.1 element.
    size_t expected_len;
    size_t max_len;
  } kASN1Tests[] = {
      {true, {0x30, 2, 1, 2, 0, 0}, 0, 4, 100},
      {false /* truncated */, {0x30, 3, 1, 2}, 0, 0, 100},
      {false /* should be short len */, {0x30, 0x81, 1, 1}, 0, 0, 100},
      {false /* zero padded */, {0x30, 0x82, 0, 1, 1}, 0, 0, 100},

      // Test a large payload.
      {true,
       {0x30, 0x82, kLargeASN1PayloadLen >> 8, kLargeASN1PayloadLen & 0xff},
       kLargeASN1PayloadLen,
       4 + kLargeASN1PayloadLen,
       kLargeASN1PayloadLen * 2},
      {false /* max_len too short */,
       {0x30, 0x82, kLargeASN1PayloadLen >> 8, kLargeASN1PayloadLen & 0xff},
       kLargeASN1PayloadLen,
       4 + kLargeASN1PayloadLen,
       3 + kLargeASN1PayloadLen},

      // Test an indefinite-length input.
      {true,
       {0x30, 0x80},
       kLargeASN1PayloadLen + 2,
       2 + kLargeASN1PayloadLen + 2,
       kLargeASN1PayloadLen * 2},
      {false /* max_len too short */,
       {0x30, 0x80},
       kLargeASN1PayloadLen + 2,
       2 + kLargeASN1PayloadLen + 2,
       2 + kLargeASN1PayloadLen + 1},
  };

  for (const auto &t : kASN1Tests) {
    std::vector<uint8_t> input = t.input;
    input.resize(input.size() + t.suffix_len, 0);

    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(input.data(), input.size()));
    ASSERT_TRUE(bio);

    uint8_t *out;
    size_t out_len;
    int ok = BIO_read_asn1(bio.get(), &out, &out_len, t.max_len);
    if (!ok) {
      out = nullptr;
    }
    bssl::UniquePtr<uint8_t> out_storage(out);

    ASSERT_EQ(t.should_succeed, (ok == 1));
    if (t.should_succeed) {
      EXPECT_EQ(Bytes(input.data(), t.expected_len), Bytes(out, out_len));
    }
  }
}

TEST(BIOTest, MemReadOnly) {
  // A memory BIO created from |BIO_new_mem_buf| is a read-only buffer.
  static const char kData[] = "abcdefghijklmno";
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(kData, strlen(kData)));
  ASSERT_TRUE(bio);

  // Writing to read-only buffers should fail.
  EXPECT_EQ(BIO_write(bio.get(), kData, strlen(kData)), -1);

  const uint8_t *contents;
  size_t len;
  ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
  EXPECT_EQ(Bytes(contents, len), Bytes(kData));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Read less than the whole buffer.
  char buf[6];
  int ret = BIO_read(bio.get(), buf, sizeof(buf));
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("abcdef"));

  ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
  EXPECT_EQ(Bytes(contents, len), Bytes("ghijklmno"));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  ret = BIO_read(bio.get(), buf, sizeof(buf));
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("ghijkl"));

  ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
  EXPECT_EQ(Bytes(contents, len), Bytes("mno"));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Read the remainder of the buffer.
  ret = BIO_read(bio.get(), buf, sizeof(buf));
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("mno"));

  ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
  EXPECT_EQ(Bytes(contents, len), Bytes(""));
  EXPECT_EQ(BIO_eof(bio.get()), 1);

  // By default, reading from a consumed read-only buffer returns EOF.
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), 0);
  EXPECT_FALSE(BIO_should_read(bio.get()));

  // A memory BIO can be configured to return an error instead of EOF. This is
  // error is returned as retryable. (This is not especially useful here. It
  // makes more sense for a writable BIO.)
  EXPECT_EQ(BIO_set_mem_eof_return(bio.get(), -1), 1);
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), -1);
  EXPECT_TRUE(BIO_should_read(bio.get()));

  // Read exactly the right number of bytes, to test the boundary condition is
  // correct.
  bio.reset(BIO_new_mem_buf("abc", 3));
  ASSERT_TRUE(bio);
  ret = BIO_read(bio.get(), buf, 3);
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("abc"));
  EXPECT_EQ(BIO_eof(bio.get()), 1);
}

TEST(BIOTest, MemWritable) {
  // A memory BIO created from |BIO_new| is writable.
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(bio);

  auto check_bio_contents = [&](Bytes b) {
    const uint8_t *contents;
    size_t len;
    ASSERT_TRUE(BIO_mem_contents(bio.get(), &contents, &len));
    EXPECT_EQ(Bytes(contents, len), b);

    char *contents_c;
    long len_l = BIO_get_mem_data(bio.get(), &contents_c);
    ASSERT_GE(len_l, 0);
    EXPECT_EQ(Bytes(contents_c, len_l), b);

    BUF_MEM *buf;
    ASSERT_EQ(BIO_get_mem_ptr(bio.get(), &buf), 1);
    EXPECT_EQ(Bytes(buf->data, buf->length), b);
  };

  // It is initially empty.
  check_bio_contents(Bytes(""));
  EXPECT_EQ(BIO_eof(bio.get()), 1);

  // Reading from it should default to returning a retryable error.
  char buf[32];
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), -1);
  EXPECT_TRUE(BIO_should_read(bio.get()));

  // This can be configured to return an EOF.
  EXPECT_EQ(BIO_set_mem_eof_return(bio.get(), 0), 1);
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), 0);
  EXPECT_FALSE(BIO_should_read(bio.get()));

  // Restore the default. A writable memory |BIO| is typically used in this mode
  // so additional data can be written when exhausted.
  EXPECT_EQ(BIO_set_mem_eof_return(bio.get(), -1), 1);

  // Writes append to the buffer.
  ASSERT_EQ(BIO_write(bio.get(), "abcdef", 6), 6);
  check_bio_contents(Bytes("abcdef"));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Writes can include embedded NULs.
  ASSERT_EQ(BIO_write(bio.get(), "\0ghijk", 6), 6);
  check_bio_contents(Bytes("abcdef\0ghijk", 12));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Do a partial read.
  int ret = BIO_read(bio.get(), buf, 4);
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("abcd"));
  check_bio_contents(Bytes("ef\0ghijk", 8));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Reads and writes may alternate.
  ASSERT_EQ(BIO_write(bio.get(), "lmnopq", 6), 6);
  check_bio_contents(Bytes("ef\0ghijklmnopq", 14));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // Reads may consume embedded NULs.
  ret = BIO_read(bio.get(), buf, 4);
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("ef\0g", 4));
  check_bio_contents(Bytes("hijklmnopq"));
  EXPECT_EQ(BIO_eof(bio.get()), 0);

  // The read buffer exceeds the |BIO|, so we consume everything.
  ret = BIO_read(bio.get(), buf, sizeof(buf));
  ASSERT_GT(ret, 0);
  EXPECT_EQ(Bytes(buf, ret), Bytes("hijklmnopq"));
  check_bio_contents(Bytes(""));
  EXPECT_EQ(BIO_eof(bio.get()), 1);

  // The |BIO| is now empty.
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), -1);
  EXPECT_TRUE(BIO_should_read(bio.get()));

  // Repeat the above, reading exactly the right number of bytes, to test the
  // boundary condition is correct.
  ASSERT_EQ(BIO_write(bio.get(), "abc", 3), 3);
  ret = BIO_read(bio.get(), buf, 3);
  EXPECT_EQ(Bytes(buf, ret), Bytes("abc"));
  EXPECT_EQ(BIO_read(bio.get(), buf, sizeof(buf)), -1);
  EXPECT_TRUE(BIO_should_read(bio.get()));
  EXPECT_EQ(BIO_eof(bio.get()), 1);
}

TEST(BIOTest, Gets) {
  const struct {
    std::string bio;
    int gets_len;
    std::string gets_result;
  } kGetsTests[] = {
      // BIO_gets should stop at the first newline. If the buffer is too small,
      // stop there instead. Note the buffer size
      // includes a trailing NUL.
      {"123456789\n123456789", 5, "1234"},
      {"123456789\n123456789", 9, "12345678"},
      {"123456789\n123456789", 10, "123456789"},
      {"123456789\n123456789", 11, "123456789\n"},
      {"123456789\n123456789", 12, "123456789\n"},
      {"123456789\n123456789", 256, "123456789\n"},

      // If we run out of buffer, read the whole buffer.
      {"12345", 5, "1234"},
      {"12345", 6, "12345"},
      {"12345", 10, "12345"},

      // NUL bytes do not terminate gets.
      {std::string("abc\0def\nghi", 11), 256, std::string("abc\0def\n", 8)},

      // An output size of one means we cannot read any bytes. Only the trailing
      // NUL is included.
      {"12345", 1, ""},

      // Empty line.
      {"\nabcdef", 256, "\n"},
      // Empty BIO.
      {"", 256, ""},
  };
  for (const auto &t : kGetsTests) {
    SCOPED_TRACE(t.bio);
    SCOPED_TRACE(t.gets_len);

    auto check_bio_gets = [&](BIO *bio) {
      std::vector<char> buf(t.gets_len, 'a');
      int ret = BIO_gets(bio, buf.data(), t.gets_len);
      ASSERT_GE(ret, 0);
      // |BIO_gets| should write a NUL terminator, not counted in the return
      // value.
      EXPECT_EQ(Bytes(buf.data(), ret + 1),
                Bytes(t.gets_result.data(), t.gets_result.size() + 1));

      // The remaining data should still be in the BIO.
      buf.resize(t.bio.size() + 1);
      ret = BIO_read(bio, buf.data(), static_cast<int>(buf.size()));
      ASSERT_GE(ret, 0);
      EXPECT_EQ(Bytes(buf.data(), ret),
                Bytes(t.bio.substr(t.gets_result.size())));
    };

    {
      SCOPED_TRACE("memory");
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(t.bio.data(), t.bio.size()));
      ASSERT_TRUE(bio);
      check_bio_gets(bio.get());
    }

    if (!bssl::SkipTempFileTests()) {
      bssl::TemporaryFile file;
      ASSERT_TRUE(file.Init(t.bio));

      // TODO(crbug.com/boringssl/585): If the line has an embedded NUL, file
      // BIOs do not currently report the answer correctly.
      if (t.bio.find('\0') == std::string::npos) {
        SCOPED_TRACE("file");

        // Test |BIO_new_file|.
        bssl::UniquePtr<BIO> bio(BIO_new_file(file.path().c_str(), "rb"));
        ASSERT_TRUE(bio);
        check_bio_gets(bio.get());

        // Test |BIO_read_filename|.
        bio.reset(BIO_new(BIO_s_file()));
        ASSERT_TRUE(bio);
        ASSERT_TRUE(BIO_read_filename(bio.get(), file.path().c_str()));
        check_bio_gets(bio.get());

        // Test |BIO_NOCLOSE|.
        bssl::ScopedFILE file_obj = file.Open("rb");
        ASSERT_TRUE(file_obj);
        bio.reset(BIO_new_fp(file_obj.get(), BIO_NOCLOSE));
        ASSERT_TRUE(bio);
        check_bio_gets(bio.get());

        // Test |BIO_CLOSE|.
        file_obj = file.Open("rb");
        ASSERT_TRUE(file_obj);
        bio.reset(BIO_new_fp(file_obj.get(), BIO_CLOSE));
        ASSERT_TRUE(bio);
        file_obj.release();  // |BIO_new_fp| took ownership on success.
        check_bio_gets(bio.get());
      }

      {
        SCOPED_TRACE("fd");

        // Test |BIO_NOCLOSE|.
        bssl::ScopedFD fd = file.OpenFD(kOpenReadOnlyBinary);
        ASSERT_TRUE(fd.is_valid());
        bssl::UniquePtr<BIO> bio(BIO_new_fd(fd.get(), BIO_NOCLOSE));
        ASSERT_TRUE(bio);
        check_bio_gets(bio.get());

        // Test |BIO_CLOSE|.
        fd = file.OpenFD(kOpenReadOnlyBinary);
        ASSERT_TRUE(fd.is_valid());
        bio.reset(BIO_new_fd(fd.get(), BIO_CLOSE));
        ASSERT_TRUE(bio);
        fd.release();  // |BIO_new_fd| took ownership on success.
        check_bio_gets(bio.get());
      }
    }
  }

  // Negative and zero lengths should not output anything, even a trailing NUL.
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf("12345", -1));
  ASSERT_TRUE(bio);
  char c = 'a';
  EXPECT_EQ(0, BIO_gets(bio.get(), &c, -1));
  EXPECT_EQ(0, BIO_gets(bio.get(), &c, 0));
  EXPECT_EQ(c, 'a');
}

// Test that, on Windows, file BIOs correctly handle text vs binary mode.
TEST(BIOTest, FileMode) {
  if (bssl::SkipTempFileTests()) {
    GTEST_SKIP();
  }

  bssl::TemporaryFile temp;
  ASSERT_TRUE(temp.Init("hello\r\nworld"));

  auto expect_file_contents = [](BIO *bio, const std::string &str) {
    // Read more than expected, to make sure we've reached the end of the file.
    std::vector<char> buf(str.size() + 100);
    int len = BIO_read(bio, buf.data(), static_cast<int>(buf.size()));
    ASSERT_GT(len, 0);
    EXPECT_EQ(Bytes(buf.data(), len), Bytes(str));
  };
  auto expect_binary_mode = [&](BIO *bio) {
    expect_file_contents(bio, "hello\r\nworld");
  };
  auto expect_text_mode = [&](BIO *bio) {
#if defined(OPENSSL_WINDOWS)
    expect_file_contents(bio, "hello\nworld");
#else
    expect_file_contents(bio, "hello\r\nworld");
#endif
  };

  // |BIO_read_filename| should open in binary mode.
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_file()));
  ASSERT_TRUE(bio);
  ASSERT_TRUE(BIO_read_filename(bio.get(), temp.path().c_str()));
  expect_binary_mode(bio.get());

  // |BIO_new_file| should use the specified mode.
  bio.reset(BIO_new_file(temp.path().c_str(), "rb"));
  ASSERT_TRUE(bio);
  expect_binary_mode(bio.get());

  bio.reset(BIO_new_file(temp.path().c_str(), "r"));
  ASSERT_TRUE(bio);
  expect_text_mode(bio.get());

  // |BIO_new_fp| inherits the file's existing mode by default.
  bssl::ScopedFILE file = temp.Open("rb");
  ASSERT_TRUE(file);
  bio.reset(BIO_new_fp(file.get(), BIO_NOCLOSE));
  ASSERT_TRUE(bio);
  expect_binary_mode(bio.get());

  file = temp.Open("r");
  ASSERT_TRUE(file);
  bio.reset(BIO_new_fp(file.get(), BIO_NOCLOSE));
  ASSERT_TRUE(bio);
  expect_text_mode(bio.get());

  // However, |BIO_FP_TEXT| changes the file to be text mode, no matter how it
  // was opened.
  file = temp.Open("rb");
  ASSERT_TRUE(file);
  bio.reset(BIO_new_fp(file.get(), BIO_NOCLOSE | BIO_FP_TEXT));
  ASSERT_TRUE(bio);
  expect_text_mode(bio.get());

  file = temp.Open("r");
  ASSERT_TRUE(file);
  bio.reset(BIO_new_fp(file.get(), BIO_NOCLOSE | BIO_FP_TEXT));
  ASSERT_TRUE(bio);
  expect_text_mode(bio.get());

  // |BIO_new_fd| inherits the FD's existing mode.
  bssl::ScopedFD fd = temp.OpenFD(kOpenReadOnlyBinary);
  ASSERT_TRUE(fd.is_valid());
  bio.reset(BIO_new_fd(fd.get(), BIO_NOCLOSE));
  ASSERT_TRUE(bio);
  expect_binary_mode(bio.get());

  fd = temp.OpenFD(kOpenReadOnlyText);
  ASSERT_TRUE(fd.is_valid());
  bio.reset(BIO_new_fd(fd.get(), BIO_NOCLOSE));
  ASSERT_TRUE(bio);
  expect_text_mode(bio.get());
}

// Run through the tests twice, swapping |bio1| and |bio2|, for symmetry.
class BIOPairTest : public testing::TestWithParam<bool> {};

TEST_P(BIOPairTest, TestPair) {
  BIO *bio1_raw, *bio2_raw;
  ASSERT_TRUE(BIO_new_bio_pair(&bio1_raw, 10, &bio2_raw, 10));
  bssl::UniquePtr<BIO> bio1(bio1_raw), bio2(bio2_raw);

  if (GetParam()) {
    std::swap(bio1, bio2);
  }

  // Check initial states.
  EXPECT_EQ(10u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(0u, BIO_ctrl_get_read_request(bio1.get()));
  EXPECT_FALSE(BIO_eof(bio1.get()));
  EXPECT_EQ(0u, BIO_pending(bio1.get()));
  EXPECT_EQ(0u, BIO_wpending(bio1.get()));

  // Data written in one end may be read out the other.
  uint8_t buf[20];
  EXPECT_EQ(5, BIO_write(bio1.get(), "12345", 5));
  EXPECT_EQ(5u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(5u, BIO_pending(bio2.get()));
  EXPECT_EQ(5u, BIO_wpending(bio1.get()));
  ASSERT_EQ(5, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("12345"), Bytes(buf, 5));
  EXPECT_EQ(10u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(0u, BIO_pending(bio2.get()));
  EXPECT_EQ(0u, BIO_wpending(bio1.get()));

  // Attempting to write more than 10 bytes will write partially.
  EXPECT_EQ(10, BIO_write(bio1.get(), "1234567890___", 13));
  EXPECT_EQ(0u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(-1, BIO_write(bio1.get(), "z", 1));
  EXPECT_TRUE(BIO_should_write(bio1.get()));
  ASSERT_EQ(10, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("1234567890"), Bytes(buf, 10));
  EXPECT_EQ(10u, BIO_ctrl_get_write_guarantee(bio1.get()));

  // Unsuccessful reads update the read request.
  EXPECT_EQ(-1, BIO_read(bio2.get(), buf, 5));
  EXPECT_TRUE(BIO_should_read(bio2.get()));
  EXPECT_EQ(5u, BIO_ctrl_get_read_request(bio1.get()));

  // The read request is clamped to the size of the buffer.
  EXPECT_EQ(-1, BIO_read(bio2.get(), buf, 20));
  EXPECT_TRUE(BIO_should_read(bio2.get()));
  EXPECT_EQ(10u, BIO_ctrl_get_read_request(bio1.get()));

  // Data may be written and read in chunks.
  EXPECT_EQ(5, BIO_write(bio1.get(), "12345", 5));
  EXPECT_EQ(5u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(5, BIO_write(bio1.get(), "67890___", 8));
  EXPECT_EQ(0u, BIO_ctrl_get_write_guarantee(bio1.get()));
  ASSERT_EQ(3, BIO_read(bio2.get(), buf, 3));
  EXPECT_EQ(Bytes("123"), Bytes(buf, 3));
  EXPECT_EQ(3u, BIO_ctrl_get_write_guarantee(bio1.get()));
  ASSERT_EQ(7, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("4567890"), Bytes(buf, 7));
  EXPECT_EQ(10u, BIO_ctrl_get_write_guarantee(bio1.get()));

  // Successful reads reset the read request.
  EXPECT_EQ(0u, BIO_ctrl_get_read_request(bio1.get()));

  // Test writes and reads starting in the middle of the ring buffer and
  // wrapping to front.
  EXPECT_EQ(8, BIO_write(bio1.get(), "abcdefgh", 8));
  EXPECT_EQ(2u, BIO_ctrl_get_write_guarantee(bio1.get()));
  ASSERT_EQ(3, BIO_read(bio2.get(), buf, 3));
  EXPECT_EQ(Bytes("abc"), Bytes(buf, 3));
  EXPECT_EQ(5u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(5, BIO_write(bio1.get(), "ijklm___", 8));
  EXPECT_EQ(0u, BIO_ctrl_get_write_guarantee(bio1.get()));
  ASSERT_EQ(10, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("defghijklm"), Bytes(buf, 10));
  EXPECT_EQ(10u, BIO_ctrl_get_write_guarantee(bio1.get()));

  // Data may flow from both ends in parallel.
  EXPECT_EQ(5, BIO_write(bio1.get(), "12345", 5));
  EXPECT_EQ(5, BIO_write(bio2.get(), "67890", 5));
  ASSERT_EQ(5, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("12345"), Bytes(buf, 5));
  ASSERT_EQ(5, BIO_read(bio1.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("67890"), Bytes(buf, 5));

  // Closing the write end causes an EOF on the read half, after draining.
  EXPECT_EQ(5, BIO_write(bio1.get(), "12345", 5));
  EXPECT_TRUE(BIO_shutdown_wr(bio1.get()));
  EXPECT_FALSE(BIO_eof(bio2.get()));
  EXPECT_EQ(5u, BIO_pending(bio2.get()));
  EXPECT_EQ(5u, BIO_wpending(bio1.get()));
  ASSERT_EQ(5, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("12345"), Bytes(buf, 5));
  EXPECT_TRUE(BIO_eof(bio2.get()));
  EXPECT_EQ(0u, BIO_pending(bio2.get()));
  EXPECT_EQ(0u, BIO_wpending(bio1.get()));
  EXPECT_EQ(0, BIO_read(bio2.get(), buf, sizeof(buf)));
  EXPECT_TRUE(BIO_eof(bio2.get()));
  EXPECT_EQ(0u, BIO_pending(bio2.get()));
  EXPECT_EQ(0u, BIO_wpending(bio1.get()));

  // A closed write end may not be written to.
  EXPECT_EQ(0u, BIO_ctrl_get_write_guarantee(bio1.get()));
  EXPECT_EQ(-1, BIO_write(bio1.get(), "_____", 5));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_BIO, BIO_R_BROKEN_PIPE));

  // The other end is still functional.
  EXPECT_EQ(5, BIO_write(bio2.get(), "12345", 5));
  ASSERT_EQ(5, BIO_read(bio1.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes("12345"), Bytes(buf, 5));
  EXPECT_FALSE(BIO_eof(bio1.get()));

  // Destroying |bio2| implicitly closes it, and discards unread data.
  EXPECT_EQ(5, BIO_write(bio2.get(), "12345", 5));
  bio2 = nullptr;

  // |bio1| no longer has the "init" flag set, so reads and writes will fail at
  // the BIO framework.
  EXPECT_FALSE(BIO_get_init(bio1.get()));
  EXPECT_EQ(-2, BIO_write(bio1.get(), "12345", 5));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_BIO, BIO_R_UNINITIALIZED));
  EXPECT_EQ(-2, BIO_read(bio1.get(), buf, sizeof(buf)));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_BIO, BIO_R_UNINITIALIZED));

  // Although in this disconnected state, |BIO_ctrl| works. |bio1| should
  // report EOF when it has no peer.
  EXPECT_TRUE(BIO_eof(bio1.get()));

  // BIO_ctrl_get_write_guarantee should return 0 because there is no one to
  // write to.
  EXPECT_EQ(0u, BIO_ctrl_get_write_guarantee(bio1.get()));
}

INSTANTIATE_TEST_SUITE_P(All, BIOPairTest, testing::Values(false, true));

}  // namespace
