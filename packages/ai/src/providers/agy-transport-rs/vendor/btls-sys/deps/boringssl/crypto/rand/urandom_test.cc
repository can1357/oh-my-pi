// Copyright 2019 The BoringSSL Authors
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

#include <gtest/gtest.h>
#include <stdlib.h>

#include <optional>

#include <openssl/bytestring.h>
#include <openssl/ctrdrbg.h>
#include <openssl/rand.h>

#include "../bcm_support.h"
#include "../fipsmodule/rand/internal.h"
#include "../internal.h"
#include "internal.h"
#include "getrandom_fillin.h"


#if (defined(OPENSSL_X86_64) || defined(OPENSSL_AARCH64)) &&               \
    !defined(BORINGSSL_SHARED_LIBRARY) && defined(OPENSSL_RAND_URANDOM) && \
    defined(USE_NR_getrandom)

#include <elf.h>
#include <linux/random.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/user.h>

namespace {

#if !defined(PTRACE_O_EXITKILL)
#define PTRACE_O_EXITKILL (1 << 20)
#endif

#if defined(OPENSSL_ANDROID)
static const bool kIsAndroid = true;
#else
static const bool kIsAndroid = false;
#endif

#if defined(BORINGSSL_FIPS)
static const bool kIsFIPS = true;
#else
static const bool kIsFIPS = false;
#endif

static const bool kUsesDaemon = kIsFIPS && kIsAndroid;

// kDaemonWriteLength is the number of bytes that the entropy daemon writes.
static const size_t kDaemonWriteLength = 496;

// This test can be run with $OPENSSL_ia32cap=~0x4000000000000000 in order to
// simulate the absence of RDRAND of machines that have it.

// Event represents a system call from urandom.c that is observed by the ptrace
// code in |GetTrace|.
struct Event {
  enum class Syscall {
    kGetRandom,
    kOpen,
    kUrandomRead,
    kSocket,
    kConnect,
    kSocketRead,
    kSocketClose,
    kAbort,
  };

  explicit Event(Syscall syscall) : type(syscall) {}

  bool operator==(const Event &other) const {
    return type == other.type &&      //
           length == other.length &&  //
           flags == other.flags &&    //
           filename == other.filename;
  }

  static Event GetRandom(size_t length, unsigned flags) {
    Event e(Syscall::kGetRandom);
    e.length = length;
    e.flags = flags;
    return e;
  }

  static Event Open(const std::string &filename) {
    Event e(Syscall::kOpen);
    e.filename = filename;
    return e;
  }

  static Event UrandomRead(size_t length) {
    Event e(Syscall::kUrandomRead);
    e.length = length;
    return e;
  }

  static Event Socket() {
    Event e(Syscall::kSocket);
    return e;
  }

  static Event Connect() {
    Event e(Syscall::kConnect);
    return e;
  }

  static Event SocketRead(size_t length) {
    Event e(Syscall::kSocketRead);
    e.length = length;
    return e;
  }

  static Event SocketClose() {
    Event e(Syscall::kSocketClose);
    return e;
  }

  static Event Abort() {
    Event e(Syscall::kAbort);
    return e;
  }

  std::string String() const {
    char buf[256];

    switch (type) {
      case Syscall::kGetRandom:
        snprintf(buf, sizeof(buf), "getrandom(_, %zu, %u)", length, flags);
        break;

      case Syscall::kOpen:
        snprintf(buf, sizeof(buf), "open(%s, _)", filename.c_str());
        break;

      case Syscall::kUrandomRead:
        snprintf(buf, sizeof(buf), "read(urandom_fd, _, %zu)", length);
        break;

      case Syscall::kSocket:
        return "socket(UNIX, STREAM, _)";

      case Syscall::kConnect:
        return "connect(sock, _, _)";

      case Syscall::kSocketRead:
        snprintf(buf, sizeof(buf), "read(sock_fd, _, %zu)", length);
        break;

      case Syscall::kSocketClose:
        return "close(sock)";

      case Syscall::kAbort:
        return "abort()";
    }

    return std::string(buf);
  }

  const Syscall type;
  size_t length = 0;
  unsigned flags = 0;
  std::string filename;
};

static std::string ToString(const std::vector<Event> &trace) {
  std::string ret;
  for (const auto &event : trace) {
    if (!ret.empty()) {
      ret += ", ";
    }
    ret += event.String();
  }
  return ret;
}

// The following are flags to tell |GetTrace| to inject faults, using ptrace,
// into the entropy-related system calls.

// getrandom gives |ENOSYS|.
static const unsigned NO_GETRANDOM = 1;
// opening /dev/urandom fails.
static const unsigned NO_URANDOM = 2;
// getrandom always returns |EAGAIN| if given |GRNG_NONBLOCK|.
static const unsigned GETRANDOM_NOT_READY = 4;
// getrandom gives |EINVAL| unless |NO_GETRANDOM| is set.
static const unsigned GETRANDOM_ERROR = 8;
// Reading from /dev/urandom gives |EINVAL|.
static const unsigned URANDOM_ERROR = 16;
static const unsigned SOCKET_ERROR = 32;
static const unsigned CONNECT_ERROR = 64;
static const unsigned SOCKET_READ_ERROR = 128;
static const unsigned SOCKET_READ_SHORT = 256;
static const unsigned NEXT_FLAG = 512;

// regs_read fetches the registers of |child_pid| and writes them to |out_regs|.
// That structure will contain at least the following members:
//   syscall: the syscall number, if registers were read just before entering
//       one.
//   args[0..2]: syscall arguments, if registers were read just before
//       entering one.
//   ret: the syscall return value, if registers were read just after finishing
//       one.
//
// This call returns true on success and false otherwise.
static bool regs_read(struct regs *out_regs, int child_pid);

// regs_set_ret sets the return value of the system call that |child_pid| has
// just finished, to |ret|. It returns true on success and false otherwise.
static bool regs_set_ret(int child_pid, int ret);

// regs_break_syscall causes the system call that |child_pid| is about to enter
// to fail to run.
static bool regs_break_syscall(int child_pid, const struct regs *orig_regs);

struct regs {
  uintptr_t syscall;
  uintptr_t args[3];
  uintptr_t ret;
  struct user_regs_struct regs;
};

#if defined(OPENSSL_X86_64)

static bool regs_read(struct regs *out_regs, int child_pid) {
  if (ptrace(PTRACE_GETREGS, child_pid, nullptr, &out_regs->regs) != 0) {
    return false;
  }

  out_regs->syscall = out_regs->regs.orig_rax;
  out_regs->ret = out_regs->regs.rax;
  out_regs->args[0] = out_regs->regs.rdi;
  out_regs->args[1] = out_regs->regs.rsi;
  out_regs->args[2] = out_regs->regs.rdx;
  return true;
}

static bool regs_set_ret(int child_pid, int ret) {
  struct regs regs;
  if (!regs_read(&regs, child_pid)) {
    return false;
  }
  regs.regs.rax = ret;
  return ptrace(PTRACE_SETREGS, child_pid, nullptr, &regs.regs) == 0;
}

static bool regs_break_syscall(int child_pid, const struct regs *orig_regs) {
  // Replace the syscall number with -1 to cause the kernel to fail the call.
  struct user_regs_struct regs = orig_regs->regs;
  regs.orig_rax = -1;
  return ptrace(PTRACE_SETREGS, child_pid, nullptr, &regs) == 0;
}

#elif defined(OPENSSL_AARCH64)

static bool regs_read(struct regs *out_regs, int child_pid) {
  struct iovec io;
  io.iov_base = &out_regs->regs;
  io.iov_len = sizeof(out_regs->regs);
  if (ptrace(PTRACE_GETREGSET, child_pid, NT_PRSTATUS, &io) != 0) {
    return false;
  }

  out_regs->syscall = out_regs->regs.regs[8];
  out_regs->ret = out_regs->regs.regs[0];
  out_regs->args[0] = out_regs->regs.regs[0];
  out_regs->args[1] = out_regs->regs.regs[1];
  out_regs->args[2] = out_regs->regs.regs[2];

  return true;
}

static bool set_regset(int child_pid, int regset, const void *data,
                       size_t len) {
  struct iovec io;
  io.iov_base = const_cast<void *>(data);
  io.iov_len = len;
  return ptrace(PTRACE_SETREGSET, child_pid, reinterpret_cast<void *>(regset),
                &io) == 0;
}

static bool regs_set_ret(int child_pid, int ret) {
  struct regs regs;
  if (!regs_read(&regs, child_pid)) {
    return false;
  }
  regs.regs.regs[0] = ret;
  return set_regset(child_pid, NT_PRSTATUS, &regs.regs, sizeof(regs.regs));
}

static bool regs_break_syscall(int child_pid, const struct regs *orig_regs) {
  // Replace the syscall number with -1 to cause the kernel to fail the call.
  int syscall = -1;
  return set_regset(child_pid, NT_ARM_SYSTEM_CALL, &syscall, sizeof(syscall));
}

#endif

// memcpy_to_remote copies |n| bytes from |in_src| in the local address space,
// to |dest| in the address space of |child_pid|.
static void memcpy_to_remote(int child_pid, uint64_t dest, const void *in_src,
                             size_t n) {
  const uint8_t *src = reinterpret_cast<const uint8_t *>(in_src);

  // ptrace always works with ill-defined "words", which appear to be 64-bit
  // on 64-bit systems.
#if !defined(OPENSSL_64_BIT)
#error "This code probably doesn't work"
#endif

  while (n) {
    const uintptr_t aligned_addr = dest & ~7;
    const uintptr_t offset = dest - aligned_addr;
    const size_t space = 8 - offset;
    size_t todo = n;
    if (todo > space) {
      todo = space;
    }

    uint64_t word;
    if (offset == 0 && todo == 8) {
      word = CRYPTO_load_u64_le(src);
    } else {
      uint8_t bytes[8];
      CRYPTO_store_u64_le(
          bytes, ptrace(PTRACE_PEEKDATA, child_pid,
                        reinterpret_cast<void *>(aligned_addr), nullptr));
      memcpy(&bytes[offset], src, todo);
      word = CRYPTO_load_u64_le(bytes);
    }

    ASSERT_EQ(0, ptrace(PTRACE_POKEDATA, child_pid,
                        reinterpret_cast<void *>(aligned_addr),
                        reinterpret_cast<void *>(word)));

    src += todo;
    n -= todo;
    dest += todo;
  }
}

static uint8_t get_byte_from_remote(int child_pid, uint64_t ptr) {
  // ptrace always works with ill-defined "words", which appear to be 64-bit
  // on 64-bit systems.
#if !defined(OPENSSL_64_BIT)
#error "This code probably doesn't work"
#endif

  const uintptr_t aligned_addr = ptr & ~7;
  const uintptr_t offset = ptr - aligned_addr;

  uint64_t word = ptrace(PTRACE_PEEKDATA, child_pid,
                         reinterpret_cast<void *>(aligned_addr), 0);
  uint8_t bytes[8];
  CRYPTO_store_u64_le(bytes, word);
  return bytes[offset];
}

static std::string get_string_from_remote(int child_pid, uint64_t ptr) {
  std::string ret;

  for (;;) {
    const uint8_t byte = get_byte_from_remote(child_pid, ptr);
    if (byte == 0) {
      break;
    }
    ret.push_back((char)byte);
    ptr++;
  }

  return ret;
}

// GetTrace runs |thunk| in a forked process and observes the resulting system
// calls using ptrace. It simulates a variety of failures based on the contents
// of |flags| and records the observed events by appending to |out_trace|.
static void GetTrace(std::vector<Event> *out_trace, unsigned flags,
                     std::function<void()> thunk) {
  const int child_pid = fork();
  ASSERT_NE(-1, child_pid);

  if (child_pid == 0) {
    // Child process
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) {
      perror("PTRACE_TRACEME");
      _exit(1);
    }
    raise(SIGSTOP);
    thunk();
    _exit(0);
  }

  // Parent process
  int status;
  ASSERT_EQ(child_pid, waitpid(child_pid, &status, 0));
  ASSERT_TRUE(WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP)
      << "Child was not stopped with SIGSTOP: " << status;

  // Set options so that:
  //   a) the child process is killed once this process dies.
  //   b) System calls result in a WSTOPSIG value of (SIGTRAP | 0x80) rather
  //      than just SIGTRAP. (This doesn't matter here, but it's recommended
  //      practice so that it's distinct from the signal itself.)
  ASSERT_EQ(0, ptrace(PTRACE_SETOPTIONS, child_pid, nullptr,
                      PTRACE_O_EXITKILL | PTRACE_O_TRACESYSGOOD))
      << strerror(errno);

  // urandom_fd tracks the file descriptor number for /dev/urandom in the child
  // process, if it opens it.
  int urandom_fd = -1;

  // sock_fd tracks the file descriptor number for the socket to the entropy
  // daemon, if one is opened.
  int sock_fd = -1;

  for (;;) {
    // Advance the child to the next system call.
    ASSERT_EQ(0, ptrace(PTRACE_SYSCALL, child_pid, 0, 0));
    ASSERT_EQ(child_pid, waitpid(child_pid, &status, 0));

    // The child may have aborted rather than made a system call.
    if (WIFSTOPPED(status) && WSTOPSIG(status) == SIGABRT) {
      out_trace->push_back(Event::Abort());
      break;
    }

    // Otherwise the only valid ptrace event is a system call stop.
    ASSERT_TRUE(WIFSTOPPED(status) && WSTOPSIG(status) == (SIGTRAP | 0x80))
        << "Child was not stopped with a syscall stop: " << status;

    struct regs regs;
    ASSERT_TRUE(regs_read(&regs, child_pid));

    bool is_opening_urandom = false;
    bool is_socket_call = false;
    bool is_socket_read = false;
    uint64_t socket_read_bytes = 0;
    // force_result is unset to indicate that the system call should run
    // normally. Otherwise it's, e.g. -EINVAL, to indicate that the system call
    // should not run and that the given value should be injected on return.
    std::optional<int> force_result;

    switch (regs.syscall) {
      case __NR_getrandom:
        if (flags & NO_GETRANDOM) {
          force_result = -ENOSYS;
        } else if (flags & GETRANDOM_ERROR) {
          force_result = -EINVAL;
        } else if (flags & GETRANDOM_NOT_READY) {
          if (regs.args[2] & GRND_NONBLOCK) {
            force_result = -EAGAIN;
          }
        }
        out_trace->push_back(
            Event::GetRandom(/*length=*/regs.args[1], /*flags=*/regs.args[2]));
        break;

      case __NR_openat:
#if defined(OPENSSL_X86_64)
      case __NR_open:
#endif
      {
        uintptr_t filename_ptr =
            (regs.syscall == __NR_openat) ? regs.args[1] : regs.args[0];
        const std::string filename =
            get_string_from_remote(child_pid, filename_ptr);
        if (filename.find("/dev/__properties__/") == 0) {
          // Android may try opening these files as part of SELinux support.
          // They are ignored here.
        } else {
          out_trace->push_back(Event::Open(filename));
        }
        is_opening_urandom = (filename == "/dev/urandom");
        if (is_opening_urandom && (flags & NO_URANDOM)) {
          force_result = -ENOENT;
        }
        break;
      }

      case __NR_read: {
        const int read_fd = regs.args[0];
        if (urandom_fd >= 0 && urandom_fd == read_fd) {
          out_trace->push_back(Event::UrandomRead(/*length=*/regs.args[2]));
          if (flags & URANDOM_ERROR) {
            force_result = -EINVAL;
          }
        } else if (sock_fd >= 0 && sock_fd == read_fd) {
          uint64_t length = regs.args[2];
          out_trace->push_back(Event::SocketRead(length));
          if (flags & SOCKET_READ_ERROR) {
            force_result = -EINVAL;
          } else {
            is_socket_read = true;
            socket_read_bytes = length;

            if (flags & SOCKET_READ_SHORT) {
              ASSERT_GT(socket_read_bytes, 0u);
              socket_read_bytes--;
              flags &= ~SOCKET_READ_SHORT;
            }
          }
        }
        break;
      }

      case __NR_close: {
        if (sock_fd >= 0 && static_cast<int>(regs.args[0]) == sock_fd) {
          out_trace->push_back(Event::SocketClose());
          sock_fd = -1;
        }
        break;
      }

      case __NR_socket: {
        const int family = regs.args[0];
        const int type = regs.args[1];
        if (family == AF_UNIX && type == SOCK_STREAM) {
          out_trace->push_back(Event::Socket());
          is_socket_call = true;
          if (flags & SOCKET_ERROR) {
            force_result = -EINVAL;
          }
        }
        break;
      }

      case __NR_connect: {
        const int connect_fd = regs.args[0];
        if (sock_fd >= 0 && connect_fd == sock_fd) {
          out_trace->push_back(Event::Connect());
          if (flags & CONNECT_ERROR) {
            force_result = -EINVAL;
          } else {
            // The test system might not have an entropy daemon running so
            // inject a success result.
            force_result = 0;
          }
        }

        break;
      }
    }

    if (force_result.has_value()) {
      ASSERT_TRUE(regs_break_syscall(child_pid, &regs));
    }

    ASSERT_EQ(0, ptrace(PTRACE_SYSCALL, child_pid, 0, 0));
    ASSERT_EQ(child_pid, waitpid(child_pid, &status, 0));
    // If the system call was exit/exit_group, the process may be terminated
    // rather than have exited the system call.
    if (WIFEXITED(status)) {
      ASSERT_EQ(0, WEXITSTATUS(status));
      return;
    }

    // Otherwise the next state must be a system call exit stop. This is
    // indistinguishable from a system call entry, we just have to keep track
    // and know that these events happen in pairs.
    ASSERT_TRUE(WIFSTOPPED(status) && WSTOPSIG(status) == (SIGTRAP | 0x80));

    if (force_result.has_value()) {
      ASSERT_TRUE(regs_set_ret(child_pid, force_result.value()));
    } else if (is_opening_urandom) {
      ASSERT_TRUE(regs_read(&regs, child_pid));
      urandom_fd = regs.ret;
    } else if (is_socket_call) {
      ASSERT_TRUE(regs_read(&regs, child_pid));
      sock_fd = regs.ret;
    } else if (is_socket_read) {
      // Simulate a response from the entropy daemon since it might not be
      // running on the current system.
      uint8_t entropy[kDaemonWriteLength];
      ASSERT_LE(socket_read_bytes, sizeof(entropy));

      for (size_t i = 0; i < sizeof(entropy); i++) {
        entropy[i] = i & 0xff;
      }
      memcpy_to_remote(child_pid, regs.args[1], entropy, socket_read_bytes);

      ASSERT_TRUE(regs_set_ret(child_pid, socket_read_bytes));
    }
  }
}

// TestFunction is the function that |GetTrace| is asked to trace.
static void TestFunction() {
  uint8_t byte;
  RAND_bytes(&byte, sizeof(byte));
  RAND_bytes(&byte, sizeof(byte));
}

static bool have_fork_detection() { return CRYPTO_get_fork_generation() != 0; }

static bool AppendDaemonEvents(std::vector<Event> *events, unsigned flags) {
  events->push_back(Event::Socket());
  if (flags & SOCKET_ERROR) {
    return false;
  }

  bool ret = false;
  events->push_back(Event::Connect());
  if (flags & CONNECT_ERROR) {
    goto out;
  }

  events->push_back(Event::SocketRead(kDaemonWriteLength));
  if (flags & SOCKET_READ_ERROR) {
    goto out;
  }

  if (flags & SOCKET_READ_SHORT) {
    events->push_back(Event::SocketRead(1));
  }

  ret = true;

out:
  events->push_back(Event::SocketClose());
  return ret;
}

// TestFunctionPRNGModel is a model of how the urandom.c code will behave when
// |TestFunction| is run. It should return the same trace of events that
// |GetTrace| will observe the real code making.
static std::vector<Event> TestFunctionPRNGModel(unsigned flags) {
  std::vector<Event> ret;
  bool getrandom_ready = false;
  bool used_daemon = false;

  if (have_fork_detection()) {
    used_daemon = kUsesDaemon && AppendDaemonEvents(&ret, flags);
  }

  // Probe for getrandom support
  ret.push_back(Event::GetRandom(1, GRND_NONBLOCK));
  std::function<void()> wait_for_entropy;
  std::function<bool(size_t)> sysrand;

  if (flags & NO_GETRANDOM) {
    if (kIsFIPS) {
      // FIPS builds require getrandom.
      ret.push_back(Event::Abort());
      return ret;
    }

    ret.push_back(Event::Open("/dev/urandom"));
    if (flags & NO_URANDOM) {
      ret.push_back(Event::Abort());
      return ret;
    }

    sysrand = [&ret, flags](size_t len) {
      ret.push_back(Event::UrandomRead(len));
      if (flags & URANDOM_ERROR) {
        ret.push_back(Event::Abort());
        return false;
      }
      return true;
    };
  } else {
    if (flags & GETRANDOM_ERROR) {
      ret.push_back(Event::Abort());
      return ret;
    }

    getrandom_ready = (flags & GETRANDOM_NOT_READY) == 0;
    wait_for_entropy = [&ret, &getrandom_ready] {
      if (getrandom_ready) {
        return;
      }

      ret.push_back(Event::GetRandom(1, GRND_NONBLOCK));
      ret.push_back(Event::GetRandom(1, 0));
      getrandom_ready = true;
    };
    sysrand = [&ret, &wait_for_entropy](size_t len) {
      wait_for_entropy();
      ret.push_back(Event::GetRandom(len, 0));
      return true;
    };
  }

  const size_t kSeedLength =
      CTR_DRBG_SEED_LEN * (kIsFIPS ? 10 : 1) + (kIsFIPS ? 16 : 0);
  const size_t kAdditionalDataLength = 32;

  if (!have_rdrand()) {
    if (!have_fork_detection()) {
      if (!sysrand(kAdditionalDataLength)) {
        return ret;
      }
      used_daemon = kUsesDaemon && AppendDaemonEvents(&ret, flags);
    }
    if (// Initialise CRNGT. If the daemon is used, the OS is used for the
        // personalisation data of length |CTR_DRBG_SEED_LEN|. Otherwise, it
        // used for the seed itself, including FIPS overread.
        !sysrand(used_daemon ? CTR_DRBG_SEED_LEN : kSeedLength) ||
        // Second additional data, when other fork-safety measures have failed.
        (!have_fork_detection() && !sysrand(kAdditionalDataLength))) {
      return ret;
    }
  } else if (
      // First additional data, when other fork-safety measures have failed. If
      // fast RDRAND isn't available then we use OS entropy.
      (!have_fast_rdrand() && !have_fork_detection() &&
       !sysrand(kAdditionalDataLength)) ||
      // OS entropy for the seed, or personalisation data if RDRAND was used.
      !sysrand(CTR_DRBG_SEED_LEN) ||
      // Second additional data, when other fork-safety measures have failed.
      (!have_fast_rdrand() && !have_fork_detection() &&
       !sysrand(kAdditionalDataLength))) {
    return ret;
  }

  return ret;
}

// Tests that |TestFunctionPRNGModel| is a correct model for the code in
// urandom.c, at least to the limits of the the |Event| type.
TEST(URandomTest, Test) {
  char buf[256];

  // Some Android systems lack getrandom.
  uint8_t scratch[1];
  const bool has_getrandom =
      (syscall(__NR_getrandom, scratch, sizeof(scratch), GRND_NONBLOCK) != -1 ||
       errno != ENOSYS);

#define TRACE_FLAG(flag)                                         \
  snprintf(buf, sizeof(buf), #flag ": %d", (flags & flag) != 0); \
  SCOPED_TRACE(buf);

  for (unsigned flags = 0; flags < NEXT_FLAG; flags++) {
    if (!kUsesDaemon && (flags & (SOCKET_ERROR | CONNECT_ERROR |
                                  SOCKET_READ_ERROR | SOCKET_READ_SHORT))) {
      // These cases are meaningless unless the code will try to use the entropy
      // daemon.
      continue;
    }

    if (!has_getrandom && !(flags & NO_GETRANDOM)) {
      continue;
    }

    TRACE_FLAG(NO_GETRANDOM);
    TRACE_FLAG(NO_URANDOM);
    TRACE_FLAG(GETRANDOM_NOT_READY);
    TRACE_FLAG(GETRANDOM_ERROR);
    TRACE_FLAG(URANDOM_ERROR);
    TRACE_FLAG(SOCKET_ERROR);
    TRACE_FLAG(CONNECT_ERROR);
    TRACE_FLAG(SOCKET_READ_ERROR);
    TRACE_FLAG(SOCKET_READ_SHORT);

    const std::vector<Event> expected_trace = TestFunctionPRNGModel(flags);
    std::vector<Event> actual_trace;
    GetTrace(&actual_trace, flags, TestFunction);

    if (expected_trace != actual_trace) {
      ADD_FAILURE() << "Expected: " << ToString(expected_trace)
                    << "\nFound:    " << ToString(actual_trace);
    }
  }
}

}  // namespace

int main(int argc, char **argv) {
  ::testing::InitGoogleTest(&argc, argv);

  if (getenv("BORINGSSL_IGNORE_MADV_WIPEONFORK")) {
    CRYPTO_fork_detect_force_madv_wipeonfork_for_testing(0);
  } else {
    CRYPTO_fork_detect_force_madv_wipeonfork_for_testing(1);
  }

  return RUN_ALL_TESTS();
}

#else

int main(int argc, char **argv) {
  printf("PASS\n");
  return 0;
}

#endif  // (X86_64 || AARCH64) && !SHARED_LIBRARY &&
        // !UNSAFE_DETERMINISTIC_MODE && USE_NR_getrandom
