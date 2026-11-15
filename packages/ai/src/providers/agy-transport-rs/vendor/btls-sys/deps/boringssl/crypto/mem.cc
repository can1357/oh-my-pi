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

#include <openssl/mem.h>

#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include <openssl/err.h>

#if defined(OPENSSL_WINDOWS)
#include <windows.h>
#endif

#if defined(BORINGSSL_MALLOC_FAILURE_TESTING)
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#endif

#include "internal.h"


#define OPENSSL_MALLOC_PREFIX 8
static_assert(OPENSSL_MALLOC_PREFIX >= sizeof(size_t), "size_t too large");

#if defined(OPENSSL_ASAN)
extern "C" {
void __asan_poison_memory_region(const volatile void *addr, size_t size);
void __asan_unpoison_memory_region(const volatile void *addr, size_t size);
}
#else
static void __asan_poison_memory_region(const void *addr, size_t size) {}
static void __asan_unpoison_memory_region(const void *addr, size_t size) {}
#endif

// Windows doesn't really support weak symbols as of May 2019, and Clang on
// Windows will emit strong symbols instead. See
// https://bugs.llvm.org/show_bug.cgi?id=37598
//
// EDK2 targets UEFI but builds as ELF and then translates the binary to
// COFF(!). Thus it builds with __ELF__ defined but cannot actually cope with
// weak symbols.
#if !defined(__EDK2_BORINGSSL__) && defined(__ELF__) && defined(__GNUC__)
#define WEAK_SYMBOL_FUNC(rettype, name, args) \
  extern "C" {                                \
  rettype name args __attribute__((weak));    \
  }
#else
#define WEAK_SYMBOL_FUNC(rettype, name, args) \
  static rettype(*const name) args = nullptr;
#endif

#if defined(BORINGSSL_DETECT_SDALLOCX)
// sdallocx is a sized |free| function. By passing the size (which we happen to
// always know in BoringSSL), the malloc implementation can save work. We cannot
// depend on |sdallocx| being available, however, so it's a weak symbol.
//
// This mechanism is kept opt-in because it assumes that, when |sdallocx| is
// defined, it is part of the same allocator as |malloc|. This is usually true
// but may break if |malloc| does not implement |sdallocx|, but some other
// allocator with |sdallocx| is imported which does.
WEAK_SYMBOL_FUNC(void, sdallocx, (void *ptr, size_t size, int flags))
#else
static void (*const sdallocx)(void *ptr, size_t size, int flags) = nullptr;
#endif

// The following three functions can be defined to override default heap
// allocation and freeing. If defined, it is the responsibility of
// |OPENSSL_memory_free| to zero out the memory before returning it to the
// system. |OPENSSL_memory_free| will not be passed NULL pointers.
//
// WARNING: These functions are called on every allocation and free in
// BoringSSL across the entire process. They may be called by any code in the
// process which calls BoringSSL, including in process initializers and thread
// destructors. When called, BoringSSL may hold pthreads locks. Any other code
// in the process which, directly or indirectly, calls BoringSSL may be on the
// call stack and may itself be using arbitrary synchronization primitives.
//
// As a result, these functions may not have the usual programming environment
// available to most C or C++ code. In particular, they may not call into
// BoringSSL, or any library which depends on BoringSSL. Any synchronization
// primitives used must tolerate every other synchronization primitive linked
// into the process, including pthreads locks. Failing to meet these constraints
// may result in deadlocks, crashes, or memory corruption.
WEAK_SYMBOL_FUNC(void *, OPENSSL_memory_alloc, (size_t size))
WEAK_SYMBOL_FUNC(void, OPENSSL_memory_free, (void *ptr))
WEAK_SYMBOL_FUNC(size_t, OPENSSL_memory_get_size, (void *ptr))

#if defined(BORINGSSL_MALLOC_FAILURE_TESTING)
static CRYPTO_MUTEX malloc_failure_lock = CRYPTO_MUTEX_INIT;
static uint64_t current_malloc_count = 0;
static uint64_t malloc_number_to_fail = 0;
static int malloc_failure_enabled = 0, break_on_malloc_fail = 0,
           any_malloc_failed = 0, disable_malloc_failures = 0;

static void malloc_exit_handler(void) {
  CRYPTO_MUTEX_lock_read(&malloc_failure_lock);
  if (any_malloc_failed) {
    // Signal to the test driver that some allocation failed, so it knows to
    // increment the counter and continue.
    _exit(88);
  }
  CRYPTO_MUTEX_unlock_read(&malloc_failure_lock);
}

static void init_malloc_failure(void) {
  const char *env = getenv("MALLOC_NUMBER_TO_FAIL");
  if (env != nullptr && env[0] != 0) {
    char *endptr;
    malloc_number_to_fail = strtoull(env, &endptr, 10);
    if (*endptr == 0) {
      malloc_failure_enabled = 1;
      atexit(malloc_exit_handler);
    }
  }
  break_on_malloc_fail = getenv("MALLOC_BREAK_ON_FAIL") != nullptr;
}

// should_fail_allocation returns one if the current allocation should fail and
// zero otherwise.
static int should_fail_allocation() {
  static CRYPTO_once_t once = CRYPTO_ONCE_INIT;
  CRYPTO_once(&once, init_malloc_failure);
  if (!malloc_failure_enabled || disable_malloc_failures) {
    return 0;
  }

  // We lock just so multi-threaded tests are still correct, but we won't test
  // every malloc exhaustively.
  CRYPTO_MUTEX_lock_write(&malloc_failure_lock);
  int should_fail = current_malloc_count == malloc_number_to_fail;
  current_malloc_count++;
  any_malloc_failed = any_malloc_failed || should_fail;
  CRYPTO_MUTEX_unlock_write(&malloc_failure_lock);

  if (should_fail && break_on_malloc_fail) {
    raise(SIGTRAP);
  }
  if (should_fail) {
    errno = ENOMEM;
  }
  return should_fail;
}

void OPENSSL_reset_malloc_counter_for_testing(void) {
  CRYPTO_MUTEX_lock_write(&malloc_failure_lock);
  current_malloc_count = 0;
  CRYPTO_MUTEX_unlock_write(&malloc_failure_lock);
}

void OPENSSL_disable_malloc_failures_for_testing(void) {
  CRYPTO_MUTEX_lock_write(&malloc_failure_lock);
  BSSL_CHECK(!disable_malloc_failures);
  disable_malloc_failures = 1;
  CRYPTO_MUTEX_unlock_write(&malloc_failure_lock);
}

void OPENSSL_enable_malloc_failures_for_testing(void) {
  CRYPTO_MUTEX_lock_write(&malloc_failure_lock);
  BSSL_CHECK(disable_malloc_failures);
  disable_malloc_failures = 0;
  CRYPTO_MUTEX_unlock_write(&malloc_failure_lock);
}

#else
static int should_fail_allocation(void) { return 0; }
#endif

void *OPENSSL_malloc(size_t size) {
  void *ptr = nullptr;
  if (should_fail_allocation()) {
    goto err;
  }

  if (OPENSSL_memory_alloc != nullptr) {
    assert(OPENSSL_memory_free != nullptr);
    assert(OPENSSL_memory_get_size != nullptr);
    void *ptr2 = OPENSSL_memory_alloc(size);
    if (ptr2 == nullptr && size != 0) {
      goto err;
    }
    return ptr2;
  }

  if (size + OPENSSL_MALLOC_PREFIX < size) {
    goto err;
  }

  ptr = malloc(size + OPENSSL_MALLOC_PREFIX);
  if (ptr == nullptr) {
    goto err;
  }

  *(size_t *)ptr = size;

  __asan_poison_memory_region(ptr, OPENSSL_MALLOC_PREFIX);
  return ((uint8_t *)ptr) + OPENSSL_MALLOC_PREFIX;

err:
  // This only works because ERR does not call OPENSSL_malloc.
  OPENSSL_PUT_ERROR(CRYPTO, ERR_R_MALLOC_FAILURE);
  return nullptr;
}

void *OPENSSL_zalloc(size_t size) {
  void *ret = OPENSSL_malloc(size);
  if (ret != nullptr) {
    OPENSSL_memset(ret, 0, size);
  }
  return ret;
}

void *OPENSSL_calloc(size_t num, size_t size) {
  if (size != 0 && num > SIZE_MAX / size) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
    return nullptr;
  }

  return OPENSSL_zalloc(num * size);
}

void OPENSSL_free(void *orig_ptr) {
  if (orig_ptr == nullptr) {
    return;
  }

  if (OPENSSL_memory_free != nullptr) {
    OPENSSL_memory_free(orig_ptr);
    return;
  }

  void *ptr = ((uint8_t *)orig_ptr) - OPENSSL_MALLOC_PREFIX;
  __asan_unpoison_memory_region(ptr, OPENSSL_MALLOC_PREFIX);

  size_t size = *(size_t *)ptr;
  OPENSSL_cleanse(ptr, size + OPENSSL_MALLOC_PREFIX);

// ASan knows to intercept malloc and free, but not sdallocx.
#if defined(OPENSSL_ASAN)
  (void)sdallocx;
  free(ptr);
#else
  if (sdallocx) {
    sdallocx(ptr, size + OPENSSL_MALLOC_PREFIX, 0 /* flags */);
  } else {
    free(ptr);
  }
#endif
}

void *OPENSSL_realloc(void *orig_ptr, size_t new_size) {
  if (orig_ptr == nullptr) {
    return OPENSSL_malloc(new_size);
  }

  size_t old_size;
  if (OPENSSL_memory_get_size != nullptr) {
    old_size = OPENSSL_memory_get_size(orig_ptr);
  } else {
    void *ptr = ((uint8_t *)orig_ptr) - OPENSSL_MALLOC_PREFIX;
    __asan_unpoison_memory_region(ptr, OPENSSL_MALLOC_PREFIX);
    old_size = *(size_t *)ptr;
    __asan_poison_memory_region(ptr, OPENSSL_MALLOC_PREFIX);
  }

  void *ret = OPENSSL_malloc(new_size);
  if (ret == nullptr) {
    return nullptr;
  }

  size_t to_copy = new_size;
  if (old_size < to_copy) {
    to_copy = old_size;
  }

  memcpy(ret, orig_ptr, to_copy);
  OPENSSL_free(orig_ptr);

  return ret;
}

void OPENSSL_cleanse(void *ptr, size_t len) {
#if defined(OPENSSL_WINDOWS)
  SecureZeroMemory(ptr, len);
#else
  OPENSSL_memset(ptr, 0, len);

#if !defined(OPENSSL_NO_ASM)
  /* As best as we can tell, this is sufficient to break any optimisations that
     might try to eliminate "superfluous" memsets. If there's an easy way to
     detect memset_s, it would be better to use that. */
  __asm__ __volatile__("" : : "r"(ptr) : "memory");
#endif
#endif  // !OPENSSL_NO_ASM
}

void OPENSSL_clear_free(void *ptr, size_t unused) { OPENSSL_free(ptr); }

int CRYPTO_secure_malloc_init(size_t size, size_t min_size) { return 0; }

int CRYPTO_secure_malloc_initialized(void) { return 0; }

size_t CRYPTO_secure_used(void) { return 0; }

void *OPENSSL_secure_malloc(size_t size) { return OPENSSL_malloc(size); }

void OPENSSL_secure_clear_free(void *ptr, size_t len) {
  OPENSSL_clear_free(ptr, len);
}

int CRYPTO_memcmp(const void *in_a, const void *in_b, size_t len) {
  const uint8_t *a = reinterpret_cast<const uint8_t *>(in_a);
  const uint8_t *b = reinterpret_cast<const uint8_t *>(in_b);
  uint8_t x = 0;

  for (size_t i = 0; i < len; i++) {
    x |= a[i] ^ b[i];
  }

  return x;
}

uint32_t OPENSSL_hash32(const void *ptr, size_t len) {
  // These are the FNV-1a parameters for 32 bits.
  static const uint32_t kPrime = 16777619u;
  static const uint32_t kOffsetBasis = 2166136261u;

  const uint8_t *in = reinterpret_cast<const uint8_t *>(ptr);
  uint32_t h = kOffsetBasis;

  for (size_t i = 0; i < len; i++) {
    h ^= in[i];
    h *= kPrime;
  }

  return h;
}

uint32_t OPENSSL_strhash(const char *s) { return OPENSSL_hash32(s, strlen(s)); }

size_t OPENSSL_strnlen(const char *s, size_t len) {
  for (size_t i = 0; i < len; i++) {
    if (s[i] == 0) {
      return i;
    }
  }

  return len;
}

char *OPENSSL_strdup(const char *s) {
  if (s == nullptr) {
    return nullptr;
  }
  // Copy the NUL terminator.
  return reinterpret_cast<char *>(OPENSSL_memdup(s, strlen(s) + 1));
}

int OPENSSL_isalpha(int c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

int OPENSSL_isdigit(int c) { return c >= '0' && c <= '9'; }

int OPENSSL_isxdigit(int c) {
  return OPENSSL_isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int OPENSSL_fromxdigit(uint8_t *out, int c) {
  if (OPENSSL_isdigit(c)) {
    *out = c - '0';
    return 1;
  }
  if ('a' <= c && c <= 'f') {
    *out = c - 'a' + 10;
    return 1;
  }
  if ('A' <= c && c <= 'F') {
    *out = c - 'A' + 10;
    return 1;
  }
  return 0;
}

int OPENSSL_isalnum(int c) { return OPENSSL_isalpha(c) || OPENSSL_isdigit(c); }

int OPENSSL_tolower(int c) {
  if (c >= 'A' && c <= 'Z') {
    return c + ('a' - 'A');
  }
  return c;
}

int OPENSSL_isspace(int c) {
  return c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' ||
         c == ' ';
}

int OPENSSL_strcasecmp(const char *a, const char *b) {
  for (size_t i = 0;; i++) {
    const int aa = OPENSSL_tolower(a[i]);
    const int bb = OPENSSL_tolower(b[i]);

    if (aa < bb) {
      return -1;
    } else if (aa > bb) {
      return 1;
    } else if (aa == 0) {
      return 0;
    }
  }
}

int OPENSSL_strncasecmp(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    const int aa = OPENSSL_tolower(a[i]);
    const int bb = OPENSSL_tolower(b[i]);

    if (aa < bb) {
      return -1;
    } else if (aa > bb) {
      return 1;
    } else if (aa == 0) {
      return 0;
    }
  }

  return 0;
}

int BIO_snprintf(char *buf, size_t n, const char *format, ...) {
  va_list args;
  va_start(args, format);
  int ret = BIO_vsnprintf(buf, n, format, args);
  va_end(args);
  return ret;
}

int BIO_vsnprintf(char *buf, size_t n, const char *format, va_list args) {
  return vsnprintf(buf, n, format, args);
}

int OPENSSL_vasprintf_internal(char **str, const char *format, va_list args,
                               int system_malloc) {
  void *(*allocate)(size_t) = system_malloc ? malloc : OPENSSL_malloc;
  void (*deallocate)(void *) = system_malloc ? free : OPENSSL_free;
  void *(*reallocate)(void *, size_t) =
      system_malloc ? realloc : OPENSSL_realloc;
  char *candidate = nullptr;
  size_t candidate_len = 64;  // TODO(bbe) what's the best initial size?
  int ret;

  if ((candidate = reinterpret_cast<char *>(allocate(candidate_len))) ==
      nullptr) {
    goto err;
  }
  va_list args_copy;
  va_copy(args_copy, args);
  ret = vsnprintf(candidate, candidate_len, format, args_copy);
  va_end(args_copy);
  if (ret < 0) {
    goto err;
  }
  if ((size_t)ret >= candidate_len) {
    // Too big to fit in allocation.
    char *tmp;

    candidate_len = (size_t)ret + 1;
    if ((tmp = reinterpret_cast<char *>(
             reallocate(candidate, candidate_len))) == nullptr) {
      goto err;
    }
    candidate = tmp;
    ret = vsnprintf(candidate, candidate_len, format, args);
  }
  // At this point this should not happen unless vsnprintf is insane.
  if (ret < 0 || (size_t)ret >= candidate_len) {
    goto err;
  }
  *str = candidate;
  return ret;

err:
  deallocate(candidate);
  *str = nullptr;
  errno = ENOMEM;
  return -1;
}

int OPENSSL_vasprintf(char **str, const char *format, va_list args) {
  return OPENSSL_vasprintf_internal(str, format, args, /*system_malloc=*/0);
}

int OPENSSL_asprintf(char **str, const char *format, ...) {
  va_list args;
  va_start(args, format);
  int ret = OPENSSL_vasprintf(str, format, args);
  va_end(args);
  return ret;
}

char *OPENSSL_strndup(const char *str, size_t size) {
  size = OPENSSL_strnlen(str, size);

  size_t alloc_size = size + 1;
  if (alloc_size < size) {
    // overflow
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_MALLOC_FAILURE);
    return nullptr;
  }
  char *ret = reinterpret_cast<char *>(OPENSSL_malloc(alloc_size));
  if (ret == nullptr) {
    return nullptr;
  }

  OPENSSL_memcpy(ret, str, size);
  ret[size] = '\0';
  return ret;
}

size_t OPENSSL_strlcpy(char *dst, const char *src, size_t dst_size) {
  size_t l = 0;

  for (; dst_size > 1 && *src; dst_size--) {
    *dst++ = *src++;
    l++;
  }

  if (dst_size) {
    *dst = 0;
  }

  return l + strlen(src);
}

size_t OPENSSL_strlcat(char *dst, const char *src, size_t dst_size) {
  size_t l = 0;
  for (; dst_size > 0 && *dst; dst_size--, dst++) {
    l++;
  }
  return l + OPENSSL_strlcpy(dst, src, dst_size);
}

void *OPENSSL_memdup(const void *data, size_t size) {
  if (size == 0) {
    return nullptr;
  }

  void *ret = OPENSSL_malloc(size);
  if (ret == nullptr) {
    return nullptr;
  }

  OPENSSL_memcpy(ret, data, size);
  return ret;
}

void *CRYPTO_malloc(size_t size, const char *file, int line) {
  return OPENSSL_malloc(size);
}

void *CRYPTO_realloc(void *ptr, size_t new_size, const char *file, int line) {
  return OPENSSL_realloc(ptr, new_size);
}

void CRYPTO_free(void *ptr, const char *file, int line) { OPENSSL_free(ptr); }
