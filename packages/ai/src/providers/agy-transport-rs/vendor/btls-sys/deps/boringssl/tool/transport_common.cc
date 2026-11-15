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

// Suppress MSVC's STL warnings. It flags |std::copy| calls with a raw output
// pointer, on grounds that MSVC cannot check them. Unfortunately, there is no
// way to suppress the warning just on one line. The warning is flagged inside
// the STL itself, so suppressing at the |std::copy| call does not work.
#if !defined(_SCL_SECURE_NO_WARNINGS)
#define _SCL_SECURE_NO_WARNINGS
#endif

#include <openssl/base.h>

#include <string>
#include <vector>

#include <errno.h>
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#if !defined(OPENSSL_WINDOWS)
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#else
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

#include <io.h>
#include <winsock2.h>
#include <ws2tcpip.h>

OPENSSL_MSVC_PRAGMA(comment(lib, "Ws2_32.lib"))
#endif

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "../crypto/internal.h"
#include "internal.h"
#include "transport_common.h"


#if defined(OPENSSL_WINDOWS)
using socket_result_t = int;
#else
using socket_result_t = ssize_t;
static int closesocket(int sock) {
  return close(sock);
}
#endif

bool InitSocketLibrary() {
#if defined(OPENSSL_WINDOWS)
  WSADATA wsaData;
  int err = WSAStartup(MAKEWORD(2, 2), &wsaData);
  if (err != 0) {
    fprintf(stderr, "WSAStartup failed with error %d\n", err);
    return false;
  }
#endif
  return true;
}

static void SplitHostPort(std::string *out_hostname, std::string *out_port,
                          const std::string &hostname_and_port) {
  size_t colon_offset = hostname_and_port.find_last_of(':');
  const size_t bracket_offset = hostname_and_port.find_last_of(']');
  std::string hostname, port;

  // An IPv6 literal may have colons internally, guarded by square brackets.
  if (bracket_offset != std::string::npos &&
      colon_offset != std::string::npos && bracket_offset > colon_offset) {
    colon_offset = std::string::npos;
  }

  if (colon_offset == std::string::npos) {
    *out_hostname = hostname_and_port;
    *out_port = "443";
  } else {
    *out_hostname = hostname_and_port.substr(0, colon_offset);
    *out_port = hostname_and_port.substr(colon_offset + 1);
  }
}

static std::string GetLastSocketErrorString() {
#if defined(OPENSSL_WINDOWS)
  int error = WSAGetLastError();
  char *buffer;
  DWORD len = FormatMessageA(
      FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_ALLOCATE_BUFFER, 0, error, 0,
      reinterpret_cast<char *>(&buffer), 0, nullptr);
  if (len == 0) {
    char buf[256];
    snprintf(buf, sizeof(buf), "unknown error (0x%x)", error);
    return buf;
  }
  std::string ret(buffer, len);
  LocalFree(buffer);
  return ret;
#else
  return strerror(errno);
#endif
}

static void PrintSocketError(const char *function) {
  // On Windows, |perror| and |errno| are part of the C runtime, while sockets
  // are separate, so we must print errors manually.
  std::string error = GetLastSocketErrorString();
  fprintf(stderr, "%s: %s\n", function, error.c_str());
}

// Connect sets |*out_sock| to be a socket connected to the destination given
// in |hostname_and_port|, which should be of the form "www.example.com:123".
// It returns true on success and false otherwise.
bool Connect(int *out_sock, const std::string &hostname_and_port) {
  std::string hostname, port;
  SplitHostPort(&hostname, &port, hostname_and_port);

  // Handle IPv6 literals.
  if (hostname.size() >= 2 && hostname[0] == '[' &&
      hostname[hostname.size() - 1] == ']') {
    hostname = hostname.substr(1, hostname.size() - 2);
  }

  struct addrinfo hint, *result;
  OPENSSL_memset(&hint, 0, sizeof(hint));
  hint.ai_family = AF_UNSPEC;
  hint.ai_socktype = SOCK_STREAM;

  int ret = getaddrinfo(hostname.c_str(), port.c_str(), &hint, &result);
  if (ret != 0) {
#if defined(OPENSSL_WINDOWS)
    const char *error = gai_strerrorA(ret);
#else
    const char *error = gai_strerror(ret);
#endif
    fprintf(stderr, "getaddrinfo returned: %s\n", error);
    return false;
  }

  bool ok = false;
  char buf[256];

  *out_sock =
      socket(result->ai_family, result->ai_socktype, result->ai_protocol);
  if (*out_sock < 0) {
    PrintSocketError("socket");
    goto out;
  }

  switch (result->ai_family) {
    case AF_INET: {
      struct sockaddr_in *sin =
          reinterpret_cast<struct sockaddr_in *>(result->ai_addr);
      fprintf(stderr, "Connecting to %s:%d\n",
              inet_ntop(result->ai_family, &sin->sin_addr, buf, sizeof(buf)),
              ntohs(sin->sin_port));
      break;
    }
    case AF_INET6: {
      struct sockaddr_in6 *sin6 =
          reinterpret_cast<struct sockaddr_in6 *>(result->ai_addr);
      fprintf(stderr, "Connecting to [%s]:%d\n",
              inet_ntop(result->ai_family, &sin6->sin6_addr, buf, sizeof(buf)),
              ntohs(sin6->sin6_port));
      break;
    }
  }

  if (connect(*out_sock, result->ai_addr, result->ai_addrlen) != 0) {
    PrintSocketError("connect");
    goto out;
  }
  ok = true;

out:
  freeaddrinfo(result);
  return ok;
}

Listener::~Listener() {
  if (server_sock_ >= 0) {
    closesocket(server_sock_);
  }
}

bool Listener::Init(const std::string &port) {
  if (server_sock_ >= 0) {
    return false;
  }

  struct sockaddr_in6 addr;
  OPENSSL_memset(&addr, 0, sizeof(addr));

  addr.sin6_family = AF_INET6;
  // Windows' IN6ADDR_ANY_INIT does not have enough curly braces for clang-cl
  // (https://crbug.com/772108), while other platforms like NaCl are missing
  // in6addr_any, so use a mix of both.
#if defined(OPENSSL_WINDOWS)
  addr.sin6_addr = in6addr_any;
#else
  addr.sin6_addr = IN6ADDR_ANY_INIT;
#endif
  addr.sin6_port = htons(atoi(port.c_str()));

#if defined(OPENSSL_WINDOWS)
  const BOOL enable = TRUE;
#else
  const int enable = 1;
#endif

  server_sock_ = socket(addr.sin6_family, SOCK_STREAM, 0);
  if (server_sock_ < 0) {
    PrintSocketError("socket");
    return false;
  }

  if (setsockopt(server_sock_, SOL_SOCKET, SO_REUSEADDR, (const char *)&enable,
                 sizeof(enable)) < 0) {
    PrintSocketError("setsockopt");
    return false;
  }

  if (bind(server_sock_, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    PrintSocketError("connect");
    return false;
  }

  listen(server_sock_, SOMAXCONN);
  return true;
}

bool Listener::Accept(int *out_sock) {
  struct sockaddr_in6 addr;
  socklen_t addr_len = sizeof(addr);
  *out_sock = accept(server_sock_, (struct sockaddr *)&addr, &addr_len);
  return *out_sock >= 0;
}

bool VersionFromString(uint16_t *out_version, const std::string &version) {
  if (version == "tls1" || version == "tls1.0") {
    *out_version = TLS1_VERSION;
    return true;
  } else if (version == "tls1.1") {
    *out_version = TLS1_1_VERSION;
    return true;
  } else if (version == "tls1.2") {
    *out_version = TLS1_2_VERSION;
    return true;
  } else if (version == "tls1.3") {
    *out_version = TLS1_3_VERSION;
    return true;
  }
  return false;
}

void PrintConnectionInfo(BIO *bio, const SSL *ssl) {
  const SSL_CIPHER *cipher = SSL_get_current_cipher(ssl);

  BIO_printf(bio, "  Version: %s\n", SSL_get_version(ssl));
  BIO_printf(bio, "  Resumed session: %s\n",
             SSL_session_reused(ssl) ? "yes" : "no");
  BIO_printf(bio, "  Cipher: %s\n", SSL_CIPHER_standard_name(cipher));
  uint16_t group = SSL_get_group_id(ssl);
  if (group != 0) {
    BIO_printf(bio, "  ECDHE group: %s\n", SSL_get_group_name(group));
  }
  uint16_t sigalg = SSL_get_peer_signature_algorithm(ssl);
  if (sigalg != 0) {
    BIO_printf(bio, "  Signature algorithm: %s\n",
               SSL_get_signature_algorithm_name(
                   sigalg, SSL_version(ssl) != TLS1_2_VERSION));
  }
  BIO_printf(bio, "  Secure renegotiation: %s\n",
             SSL_get_secure_renegotiation_support(ssl) ? "yes" : "no");
  BIO_printf(bio, "  Extended master secret: %s\n",
             SSL_get_extms_support(ssl) ? "yes" : "no");

  const uint8_t *next_proto;
  unsigned next_proto_len;
  SSL_get0_next_proto_negotiated(ssl, &next_proto, &next_proto_len);
  BIO_printf(bio, "  Next protocol negotiated: %.*s\n",
             static_cast<int>(next_proto_len), next_proto);

  const uint8_t *alpn;
  unsigned alpn_len;
  SSL_get0_alpn_selected(ssl, &alpn, &alpn_len);
  BIO_printf(bio, "  ALPN protocol: %.*s\n", static_cast<int>(alpn_len), alpn);

  const char *host_name = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
  if (host_name != nullptr && SSL_is_server(ssl)) {
    BIO_printf(bio, "  Client sent SNI: %s\n", host_name);
  }

  if (!SSL_is_server(ssl)) {
    const uint8_t *ocsp_staple;
    size_t ocsp_staple_len;
    SSL_get0_ocsp_response(ssl, &ocsp_staple, &ocsp_staple_len);
    BIO_printf(bio, "  OCSP staple: %s\n", ocsp_staple_len > 0 ? "yes" : "no");

    const uint8_t *sct_list;
    size_t sct_list_len;
    SSL_get0_signed_cert_timestamp_list(ssl, &sct_list, &sct_list_len);
    BIO_printf(bio, "  SCT list: %s\n", sct_list_len > 0 ? "yes" : "no");
  }

  BIO_printf(
      bio, "  Early data: %s\n",
      (SSL_early_data_accepted(ssl) || SSL_in_early_data(ssl)) ? "yes" : "no");

  BIO_printf(bio, "  Encrypted ClientHello: %s\n",
             SSL_ech_accepted(ssl) ? "yes" : "no");

  // Print the server cert subject and issuer names.
  bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(ssl));
  if (peer != nullptr) {
    BIO_printf(bio, "  Cert subject: ");
    X509_NAME_print_ex(bio, X509_get_subject_name(peer.get()), 0,
                       XN_FLAG_ONELINE);
    BIO_printf(bio, "\n  Cert issuer: ");
    X509_NAME_print_ex(bio, X509_get_issuer_name(peer.get()), 0,
                       XN_FLAG_ONELINE);
    BIO_printf(bio, "\n");
  }
}

bool SocketSetNonBlocking(int sock, bool is_non_blocking) {
  bool ok;

#if defined(OPENSSL_WINDOWS)
  u_long arg = is_non_blocking;
  ok = 0 == ioctlsocket(sock, FIONBIO, &arg);
#else
  int flags = fcntl(sock, F_GETFL, 0);
  if (flags < 0) {
    return false;
  }
  if (is_non_blocking) {
    flags |= O_NONBLOCK;
  } else {
    flags &= ~O_NONBLOCK;
  }
  ok = 0 == fcntl(sock, F_SETFL, flags);
#endif
  if (!ok) {
    PrintSocketError("Failed to set socket non-blocking");
  }
  return ok;
}

enum class StdinWait {
  kStdinRead,
  kSocketWrite,
};

#if !defined(OPENSSL_WINDOWS)

// SocketWaiter abstracts waiting for either the socket or stdin to be readable
// between Windows and POSIX.
class SocketWaiter {
 public:
  explicit SocketWaiter(int sock) : sock_(sock) {}
  SocketWaiter(const SocketWaiter &) = delete;
  SocketWaiter &operator=(const SocketWaiter &) = delete;

  // Init initializes the SocketWaiter. It returns whether it succeeded.
  bool Init() { return true; }

  // Wait waits for at least on of the socket or stdin or be ready. On success,
  // it sets |*socket_ready| and |*stdin_ready| to whether the respective
  // objects are readable and returns true. On error, it returns false. stdin's
  // readiness may either be the socket being writable or stdin being readable,
  // depending on |stdin_wait|.
  bool Wait(StdinWait stdin_wait, bool *socket_ready, bool *stdin_ready) {
    *socket_ready = true;
    *stdin_ready = false;

    fd_set read_fds, write_fds;
    FD_ZERO(&read_fds);
    FD_ZERO(&write_fds);
    if (stdin_wait == StdinWait::kSocketWrite) {
      FD_SET(sock_, &write_fds);
    } else if (stdin_open_) {
      FD_SET(STDIN_FILENO, &read_fds);
    }
    FD_SET(sock_, &read_fds);
    if (select(sock_ + 1, &read_fds, &write_fds, NULL, NULL) <= 0) {
      perror("select");
      return false;
    }

    if (FD_ISSET(STDIN_FILENO, &read_fds) || FD_ISSET(sock_, &write_fds)) {
      *stdin_ready = true;
    }
    if (FD_ISSET(sock_, &read_fds)) {
      *socket_ready = true;
    }

    return true;
  }

  // ReadStdin reads at most |max_out| bytes from stdin. On success, it writes
  // them to |out| and sets |*out_len| to the number of bytes written. On error,
  // it returns false. This method may only be called after |Wait| returned
  // stdin was ready.
  bool ReadStdin(void *out, size_t *out_len, size_t max_out) {
    ssize_t n;
    do {
      n = read(STDIN_FILENO, out, max_out);
    } while (n == -1 && errno == EINTR);
    if (n <= 0) {
      stdin_open_ = false;
    }
    if (n < 0) {
      perror("read from stdin");
      return false;
    }
    *out_len = static_cast<size_t>(n);
    return true;
  }

 private:
   bool stdin_open_ = true;
   int sock_;
};

#else // OPENSSL_WINDOWs

class ScopedWSAEVENT {
 public:
  ScopedWSAEVENT() = default;
  ScopedWSAEVENT(WSAEVENT event) { reset(event); }
  ScopedWSAEVENT(const ScopedWSAEVENT &) = delete;
  ScopedWSAEVENT(ScopedWSAEVENT &&other) { *this = std::move(other); }

  ~ScopedWSAEVENT() { reset(); }

  ScopedWSAEVENT &operator=(const ScopedWSAEVENT &) = delete;
  ScopedWSAEVENT &operator=(ScopedWSAEVENT &&other) {
    reset(other.release());
    return *this;
  }

  explicit operator bool() const { return event_ != WSA_INVALID_EVENT; }
  WSAEVENT get() const { return event_; }

  WSAEVENT release() {
    WSAEVENT ret = event_;
    event_ = WSA_INVALID_EVENT;
    return ret;
  }

  void reset(WSAEVENT event = WSA_INVALID_EVENT) {
    if (event_ != WSA_INVALID_EVENT) {
      WSACloseEvent(event_);
    }
    event_ = event;
  }

 private:
  WSAEVENT event_ = WSA_INVALID_EVENT;
};

// SocketWaiter, on Windows, is more complicated. While |WaitForMultipleObjects|
// works for both sockets and stdin, the latter is often a line-buffered
// console. The |HANDLE| is considered readable if there are any console events
// available, but reading blocks until a full line is available.
//
// So that |Wait| reflects final stdin read, we spawn a stdin reader thread that
// writes to an in-memory buffer and signals a |WSAEVENT| to coordinate with the
// socket.
class SocketWaiter {
 public:
  explicit SocketWaiter(int sock) : sock_(sock) {}
  SocketWaiter(const SocketWaiter &) = delete;
  SocketWaiter &operator=(const SocketWaiter &) = delete;

  bool Init() {
    stdin_ = std::make_shared<StdinState>();
    stdin_->event.reset(WSACreateEvent());
    if (!stdin_->event) {
      PrintSocketError("Error in WSACreateEvent");
      return false;
    }

    // Spawn a thread to block on stdin.
    std::shared_ptr<StdinState> state = stdin_;
    std::thread thread([state]() {
      for (;;) {
        uint8_t buf[512];
        int ret = _read(0 /* stdin */, buf, sizeof(buf));
        if (ret <= 0) {
          if (ret < 0) {
            perror("read from stdin");
          }
          // Report the error or EOF to the caller.
          std::lock_guard<std::mutex> lock(state->lock);
          state->error = ret < 0;
          state->open = false;
          WSASetEvent(state->event.get());
          return;
        }

        size_t len = static_cast<size_t>(ret);
        size_t written = 0;
        while (written < len) {
          std::unique_lock<std::mutex> lock(state->lock);
          // Wait for there to be room in the buffer.
          state->cond.wait(lock, [&] { return !state->buffer_full(); });

          // Copy what we can and signal to the caller.
          size_t todo = std::min(len - written, state->buffer_remaining());
          state->buffer.insert(state->buffer.end(), buf + written,
                               buf + written + todo);
          written += todo;
          WSASetEvent(state->event.get());
        }
      }
    });
    thread.detach();
    return true;
  }

  bool Wait(StdinWait stdin_wait, bool *socket_ready, bool *stdin_ready) {
    *socket_ready = true;
    *stdin_ready = false;

    ScopedWSAEVENT sock_read_event(WSACreateEvent());
    if (!sock_read_event ||
        WSAEventSelect(sock_, sock_read_event.get(), FD_READ | FD_CLOSE) != 0) {
      PrintSocketError("Error waiting for socket read");
      return false;
    }

    DWORD count = 1;
    WSAEVENT events[3] = {sock_read_event.get(), WSA_INVALID_EVENT};
    ScopedWSAEVENT sock_write_event;
    if (stdin_wait == StdinWait::kSocketWrite) {
      sock_write_event.reset(WSACreateEvent());
      if (!sock_write_event || WSAEventSelect(sock_, sock_write_event.get(),
                                              FD_WRITE | FD_CLOSE) != 0) {
        PrintSocketError("Error waiting for socket write");
        return false;
      }
      events[1] = sock_write_event.get();
      count++;
    } else if (listen_stdin_) {
      events[1] = stdin_->event.get();
      count++;
    }

    switch (WSAWaitForMultipleEvents(count, events, FALSE /* wait all */,
                                     WSA_INFINITE, FALSE /* alertable */)) {
      case WSA_WAIT_EVENT_0 + 0:
        *socket_ready = true;
        return true;
      case WSA_WAIT_EVENT_0 + 1:
        *stdin_ready = true;
        return true;
      case WSA_WAIT_TIMEOUT:
        return true;
      default:
        PrintSocketError("Error waiting for events");
        return false;
    }
  }

  bool ReadStdin(void *out, size_t *out_len, size_t max_out) {
    std::lock_guard<std::mutex> locked(stdin_->lock);

    if (stdin_->buffer.empty()) {
      // |ReadStdin| may only be called when |Wait| signals it is ready, so
      // stdin must have reached EOF or error.
      assert(!stdin_->open);
      listen_stdin_ = false;
      if (stdin_->error) {
        return false;
      }
      *out_len = 0;
      return true;
    }

    bool was_full = stdin_->buffer_full();
    // Copy as many bytes as well fit.
    *out_len = std::min(max_out, stdin_->buffer.size());
    auto begin = stdin_->buffer.begin();
    auto end = stdin_->buffer.begin() + *out_len;
    std::copy(begin, end, static_cast<uint8_t *>(out));
    stdin_->buffer.erase(begin, end);
    // Notify the stdin thread if there is more space.
    if (was_full && !stdin_->buffer_full()) {
      stdin_->cond.notify_one();
    }
    // If stdin is now waiting for input, clear the event.
    if (stdin_->buffer.empty() && stdin_->open) {
      WSAResetEvent(stdin_->event.get());
    }
    return true;
  }

 private:
  struct StdinState {
    static constexpr size_t kMaxBuffer = 1024;

    StdinState() = default;
    StdinState(const StdinState &) = delete;
    StdinState &operator=(const StdinState &) = delete;

    size_t buffer_remaining() const { return kMaxBuffer - buffer.size(); }
    bool buffer_full() const { return buffer_remaining() == 0; }

    ScopedWSAEVENT event;
    // lock protects the following fields.
    std::mutex lock;
    // cond notifies the stdin thread that |buffer| is no longer full.
    std::condition_variable cond;
    std::deque<uint8_t> buffer;
    bool open = true;
    bool error = false;
  };

  int sock_;
  std::shared_ptr<StdinState> stdin_;
  // listen_stdin_ is set to false when we have consumed an EOF or error from
  // |stdin_|. This is separate from |stdin_->open| because the signal may not
  // have been consumed yet.
  bool listen_stdin_ = true;
};

#endif  // OPENSSL_WINDOWS

void PrintSSLError(FILE *file, const char *msg, int ssl_err, int ret) {
  switch (ssl_err) {
    case SSL_ERROR_SSL:
      fprintf(file, "%s: %s\n", msg, ERR_reason_error_string(ERR_peek_error()));
      break;
    case SSL_ERROR_SYSCALL:
      if (ret == 0) {
        fprintf(file, "%s: peer closed connection\n", msg);
      } else {
        std::string error = GetLastSocketErrorString();
        fprintf(file, "%s: %s\n", msg, error.c_str());
      }
      break;
    case SSL_ERROR_ZERO_RETURN:
      fprintf(file, "%s: received close_notify\n", msg);
      break;
    default:
      fprintf(file, "%s: unexpected error: %s\n", msg,
              SSL_error_description(ssl_err));
  }
  ERR_print_errors_fp(file);
}

bool TransferData(SSL *ssl, int sock) {
  if (!SocketSetNonBlocking(sock, true)) {
    return false;
  }

  SocketWaiter waiter(sock);
  if (!waiter.Init()) {
    return false;
  }

  uint8_t pending_write[512];
  size_t pending_write_len = 0;
  for (;;) {
    bool socket_ready = false;
    bool stdin_ready = false;
    if (!waiter.Wait(pending_write_len == 0 ? StdinWait::kStdinRead
                                            : StdinWait::kSocketWrite,
                     &socket_ready, &stdin_ready)) {
      return false;
    }

    if (stdin_ready) {
      if (pending_write_len == 0) {
        if (!waiter.ReadStdin(pending_write, &pending_write_len,
                              sizeof(pending_write))) {
          return false;
        }
        if (pending_write_len == 0) {
  #if !defined(OPENSSL_WINDOWS)
          shutdown(sock, SHUT_WR);
  #else
          shutdown(sock, SD_SEND);
  #endif
          continue;
        }
      }

      int ssl_ret =
          SSL_write(ssl, pending_write, static_cast<int>(pending_write_len));
      if (ssl_ret <= 0) {
        int ssl_err = SSL_get_error(ssl, ssl_ret);
        if (ssl_err == SSL_ERROR_WANT_WRITE) {
          continue;
        }
        PrintSSLError(stderr, "Error while writing", ssl_err, ssl_ret);
        return false;
      }
      if (ssl_ret != static_cast<int>(pending_write_len)) {
        fprintf(stderr, "Short write from SSL_write.\n");
        return false;
      }
      pending_write_len = 0;
    }

    if (socket_ready) {
      for (;;) {
        uint8_t buffer[512];
        int ssl_ret = SSL_read(ssl, buffer, sizeof(buffer));

        if (ssl_ret < 0) {
          int ssl_err = SSL_get_error(ssl, ssl_ret);
          if (ssl_err == SSL_ERROR_WANT_READ) {
            break;
          }
          PrintSSLError(stderr, "Error while reading", ssl_err, ssl_ret);
          return false;
        } else if (ssl_ret == 0) {
          return true;
        }

        size_t n;
        if (!WriteToFD(1, &n, buffer, ssl_ret)) {
          fprintf(stderr, "Error writing to stdout.\n");
          return false;
        }

        if (n != static_cast<size_t>(ssl_ret)) {
          fprintf(stderr, "Short write to stderr.\n");
          return false;
        }
      }
    }
  }
}

// SocketLineReader wraps a small buffer around a socket for line-orientated
// protocols.
class SocketLineReader {
 public:
  explicit SocketLineReader(int sock) : sock_(sock) {}

  // Next reads a '\n'- or '\r\n'-terminated line from the socket and, on
  // success, sets |*out_line| to it and returns true. Otherwise it returns
  // false.
  bool Next(std::string *out_line) {
    for (;;) {
      for (size_t i = 0; i < buf_len_; i++) {
        if (buf_[i] != '\n') {
          continue;
        }

        size_t length = i;
        if (i > 0 && buf_[i - 1] == '\r') {
          length--;
        }

        out_line->assign(buf_, length);
        buf_len_ -= i + 1;
        OPENSSL_memmove(buf_, &buf_[i + 1], buf_len_);

        return true;
      }

      if (buf_len_ == sizeof(buf_)) {
        fprintf(stderr, "Received line too long!\n");
        return false;
      }

      socket_result_t n;
      do {
        n = recv(sock_, &buf_[buf_len_], sizeof(buf_) - buf_len_, 0);
      } while (n == -1 && errno == EINTR);

      if (n < 0) {
        fprintf(stderr, "Read error from socket\n");
        return false;
      }

      buf_len_ += n;
    }
  }

  // ReadSMTPReply reads one or more lines that make up an SMTP reply. On
  // success, it sets |*out_code| to the reply's code (e.g. 250) and
  // |*out_content| to the body of the reply (e.g. "OK") and returns true.
  // Otherwise it returns false.
  //
  // See https://tools.ietf.org/html/rfc821#page-48
  bool ReadSMTPReply(unsigned *out_code, std::string *out_content) {
    out_content->clear();

    // kMaxLines is the maximum number of lines that we'll accept in an SMTP
    // reply.
    static const unsigned kMaxLines = 512;
    for (unsigned i = 0; i < kMaxLines; i++) {
      std::string line;
      if (!Next(&line)) {
        return false;
      }

      if (line.size() < 4) {
        fprintf(stderr, "Short line from SMTP server: %s\n", line.c_str());
        return false;
      }

      const std::string code_str = line.substr(0, 3);
      char *endptr;
      const unsigned long code = strtoul(code_str.c_str(), &endptr, 10);
      if (*endptr || code > UINT_MAX) {
        fprintf(stderr, "Failed to parse code from line: %s\n", line.c_str());
        return false;
      }

      if (i == 0) {
        *out_code = static_cast<unsigned>(code);
      } else if (code != *out_code) {
        fprintf(stderr,
                "Reply code varied within a single reply: was %u, now %u\n",
                *out_code, static_cast<unsigned>(code));
        return false;
      }

      if (line[3] == ' ') {
        // End of reply.
        *out_content += line.substr(4, std::string::npos);
        return true;
      } else if (line[3] == '-') {
        // Another line of reply will follow this one.
        *out_content += line.substr(4, std::string::npos);
        out_content->push_back('\n');
      } else {
        fprintf(stderr, "Bad character after code in SMTP reply: %s\n",
                line.c_str());
        return false;
      }
    }

    fprintf(stderr, "Rejected SMTP reply of more then %u lines\n", kMaxLines);
    return false;
  }

 private:
  const int sock_;
  char buf_[512];
  size_t buf_len_ = 0;
};

// SendAll writes |data_len| bytes from |data| to |sock|. It returns true on
// success and false otherwise.
static bool SendAll(int sock, const char *data, size_t data_len) {
  size_t done = 0;

  while (done < data_len) {
    socket_result_t n;
    do {
      n = send(sock, &data[done], data_len - done, 0);
    } while (n == -1 && errno == EINTR);

    if (n < 0) {
      fprintf(stderr, "Error while writing to socket\n");
      return false;
    }

    done += n;
  }

  return true;
}

bool DoSMTPStartTLS(int sock) {
  SocketLineReader line_reader(sock);

  unsigned code_220 = 0;
  std::string reply_220;
  if (!line_reader.ReadSMTPReply(&code_220, &reply_220)) {
    return false;
  }

  if (code_220 != 220) {
    fprintf(stderr, "Expected 220 line from SMTP server but got code %u\n",
            code_220);
    return false;
  }

  static const char kHelloLine[] = "EHLO BoringSSL\r\n";
  if (!SendAll(sock, kHelloLine, sizeof(kHelloLine) - 1)) {
    return false;
  }

  unsigned code_250 = 0;
  std::string reply_250;
  if (!line_reader.ReadSMTPReply(&code_250, &reply_250)) {
    return false;
  }

  if (code_250 != 250) {
    fprintf(stderr, "Expected 250 line after EHLO but got code %u\n", code_250);
    return false;
  }

  // https://tools.ietf.org/html/rfc1869#section-4.3
  if (("\n" + reply_250 + "\n").find("\nSTARTTLS\n") == std::string::npos) {
    fprintf(stderr, "Server does not support STARTTLS\n");
    return false;
  }

  static const char kSTARTTLSLine[] = "STARTTLS\r\n";
  if (!SendAll(sock, kSTARTTLSLine, sizeof(kSTARTTLSLine) - 1)) {
    return false;
  }

  if (!line_reader.ReadSMTPReply(&code_220, &reply_220)) {
    return false;
  }

  if (code_220 != 220) {
    fprintf(
        stderr,
        "Expected 220 line from SMTP server after STARTTLS, but got code %u\n",
        code_220);
    return false;
  }

  return true;
}

bool DoHTTPTunnel(int sock, const std::string &hostname_and_port) {
  std::string hostname, port;
  SplitHostPort(&hostname, &port, hostname_and_port);

  fprintf(stderr, "Establishing HTTP tunnel to %s:%s.\n", hostname.c_str(),
          port.c_str());
  char buf[1024];
  snprintf(buf, sizeof(buf), "CONNECT %s:%s HTTP/1.0\r\n\r\n", hostname.c_str(),
           port.c_str());
  if (!SendAll(sock, buf, strlen(buf))) {
    return false;
  }

  SocketLineReader line_reader(sock);

  // Read until an empty line, signaling the end of the HTTP response.
  std::string line;
  for (;;) {
    if (!line_reader.Next(&line)) {
      return false;
    }
    if (line.empty()) {
      return true;
    }
    fprintf(stderr, "%s\n", line.c_str());
  }
}
