// Copyright 2020 The BoringSSL Authors
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

#if !defined(_GNU_SOURCE)
#define _GNU_SOURCE  // needed for madvise() and MAP_ANONYMOUS on Linux.
#endif

#include "../bcm_support.h"
#include "../internal.h"
#include "internal.h"

#if defined(OPENSSL_FORK_DETECTION_MADVISE)
#include <assert.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>
#if defined(MADV_WIPEONFORK)
static_assert(MADV_WIPEONFORK == 18);
#else
#define MADV_WIPEONFORK 18
#endif
#elif defined(OPENSSL_FORK_DETECTION_PTHREAD_ATFORK)
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>
#endif  // OPENSSL_FORK_DETECTION_PTHREAD_ATFORK

#if defined(OPENSSL_FORK_DETECTION_MADVISE)
static int g_force_madv_wipeonfork;
static int g_force_madv_wipeonfork_enabled;
static CRYPTO_once_t g_fork_detect_once = CRYPTO_ONCE_INIT;
static CRYPTO_MUTEX g_fork_detect_lock = CRYPTO_MUTEX_INIT;
static bssl::Atomic<uint32_t> *g_fork_detect_addr;
static uint64_t g_fork_generation;

static void init_fork_detect(void) {
  if (g_force_madv_wipeonfork) {
    return;
  }

  long page_size = sysconf(_SC_PAGESIZE);
  if (page_size <= 0) {
    return;
  }

  void *addr = mmap(nullptr, (size_t)page_size, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (addr == MAP_FAILED) {
    return;
  }

  // Some versions of qemu (up to at least 5.0.0-rc4, see linux-user/syscall.c)
  // ignore |madvise| calls and just return zero (i.e. success). But we need to
  // know whether MADV_WIPEONFORK actually took effect. Therefore try an invalid
  // call to check that the implementation of |madvise| is actually rejecting
  // unknown |advice| values.
  if (madvise(addr, (size_t)page_size, -1) == 0 ||
      madvise(addr, (size_t)page_size, MADV_WIPEONFORK) != 0) {
    munmap(addr, (size_t)page_size);
    return;
  }

  auto *const atomic = reinterpret_cast<bssl::Atomic<uint32_t> *>(addr);
  atomic->store(1);
  g_fork_detect_addr = atomic;
  g_fork_generation = 1;
}

uint64_t CRYPTO_get_fork_generation(void) {
  CRYPTO_once(&g_fork_detect_once, init_fork_detect);

  // In a single-threaded process, there are obviously no races because there's
  // only a single mutator in the address space.
  //
  // In a multi-threaded environment, |CRYPTO_once| ensures that the flag byte
  // is initialised atomically, even if multiple threads enter this function
  // concurrently.
  //
  // Additionally, while the kernel will only clear WIPEONFORK at a point when a
  // child process is single-threaded, the child may become multi-threaded
  // before it observes this. Therefore, we must synchronize the logic below.

  bssl::Atomic<uint32_t> *const flag_ptr = g_fork_detect_addr;
  if (flag_ptr == nullptr) {
    // Our kernel is too old to support |MADV_WIPEONFORK| or
    // |g_force_madv_wipeonfork| is set.
    if (g_force_madv_wipeonfork && g_force_madv_wipeonfork_enabled) {
      // A constant generation number to simulate support, even if the kernel
      // doesn't support it.
      return 42;
    }
    // With Linux and clone(), we do not believe that pthread_atfork() is
    // sufficient for detecting all forms of address space duplication. At this
    // point we have a kernel that does not support MADV_WIPEONFORK. We could
    // return the generation number from pthread_atfork() here and it would
    // probably be safe in almost any situation, but to ensure safety we return
    // 0 and force an entropy draw on every call.
    return 0;
  }

  // In the common case, try to observe the flag without taking a lock. This
  // avoids cacheline contention in the PRNG.
  uint64_t *const generation_ptr = &g_fork_generation;
  if (flag_ptr->load() != 0) {
    // If we observe a non-zero flag, it is safe to read |generation_ptr|
    // without a lock. The flag and generation number are fixed for this copy of
    // the address space.
    return *generation_ptr;
  }

  // The flag was zero. The generation number must be incremented, but other
  // threads may have concurrently observed the zero, so take a lock before
  // incrementing.
  CRYPTO_MUTEX *const lock = &g_fork_detect_lock;
  CRYPTO_MUTEX_lock_write(lock);
  uint64_t current_generation = *generation_ptr;
  if (flag_ptr->load() == 0) {
    // A fork has occurred.
    current_generation++;
    if (current_generation == 0) {
      // Zero means fork detection isn't supported, so skip that value.
      current_generation = 1;
    }

    // We must update |generation_ptr| before |flag_ptr|. Other threads may
    // observe |flag_ptr| without taking a lock.
    *generation_ptr = current_generation;
    flag_ptr->store(1);
  }
  CRYPTO_MUTEX_unlock_write(lock);

  return current_generation;
}

void CRYPTO_fork_detect_force_madv_wipeonfork_for_testing(int on) {
  g_force_madv_wipeonfork = 1;
  g_force_madv_wipeonfork_enabled = on;
}

#elif defined(OPENSSL_FORK_DETECTION_PTHREAD_ATFORK)

static CRYPTO_once_t g_pthread_fork_detection_once = CRYPTO_ONCE_INIT;
static uint64_t g_atfork_fork_generation;

static void we_are_forked(void) {
  // Immediately after a fork, the process must be single-threaded.
  uint64_t value = g_atfork_fork_generation + 1;
  if (value == 0) {
    value = 1;
  }
  g_atfork_fork_generation = value;
}

static void init_pthread_fork_detection(void) {
  if (pthread_atfork(nullptr, nullptr, we_are_forked) != 0) {
    abort();
  }
  g_atfork_fork_generation = 1;
}

uint64_t CRYPTO_get_fork_generation(void) {
  CRYPTO_once(&g_pthread_fork_detection_once, init_pthread_fork_detection);

  return g_atfork_fork_generation;
}

#elif defined(OPENSSL_DOES_NOT_FORK)

// These platforms are guaranteed not to fork, and therefore do not require
// fork detection support. Returning a constant non zero value makes BoringSSL
// assume address space duplication is not a concern and adding entropy to
// every RAND_bytes call is not needed.
uint64_t CRYPTO_get_fork_generation(void) { return 0xc0ffee; }

#else

// These platforms may fork, but we do not have a mitigation mechanism in
// place.  Returning a constant zero value makes BoringSSL assume that address
// space duplication could have occurred on any call entropy must be added to
// every RAND_bytes call.
uint64_t CRYPTO_get_fork_generation(void) { return 0; }

#endif
