// Copyright 2015 The BoringSSL Authors
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

// Ensure we can't call OPENSSL_malloc circularly.
#define _BORINGSSL_PROHIBIT_OPENSSL_MALLOC
#include "internal.h"

#if defined(OPENSSL_PTHREADS)

#include <assert.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

void CRYPTO_MUTEX_init(CRYPTO_MUTEX *lock) {
  if (pthread_rwlock_init(lock, nullptr) != 0) {
    abort();
  }
}

void CRYPTO_MUTEX_lock_read(CRYPTO_MUTEX *lock) {
  if (pthread_rwlock_rdlock(lock) != 0) {
    abort();
  }
}

void CRYPTO_MUTEX_lock_write(CRYPTO_MUTEX *lock) {
  if (pthread_rwlock_wrlock(lock) != 0) {
    abort();
  }
}

void CRYPTO_MUTEX_unlock_read(CRYPTO_MUTEX *lock) {
  if (pthread_rwlock_unlock(lock) != 0) {
    abort();
  }
}

void CRYPTO_MUTEX_unlock_write(CRYPTO_MUTEX *lock) {
  if (pthread_rwlock_unlock(lock) != 0) {
    abort();
  }
}

void CRYPTO_MUTEX_cleanup(CRYPTO_MUTEX *lock) { pthread_rwlock_destroy(lock); }

void CRYPTO_once(CRYPTO_once_t *once, void (*init)(void)) {
  if (pthread_once(once, init) != 0) {
    abort();
  }
}

static pthread_mutex_t g_destructors_lock = PTHREAD_MUTEX_INITIALIZER;
static thread_local_destructor_t g_destructors[NUM_OPENSSL_THREAD_LOCALS];

// thread_local_destructor is called when a thread exits. It releases thread
// local data for that thread only.
static void thread_local_destructor(void *arg) {
  if (arg == nullptr) {
    return;
  }

  thread_local_destructor_t destructors[NUM_OPENSSL_THREAD_LOCALS];
  if (pthread_mutex_lock(&g_destructors_lock) != 0) {
    return;
  }
  OPENSSL_memcpy(destructors, g_destructors, sizeof(destructors));
  pthread_mutex_unlock(&g_destructors_lock);

  unsigned i;
  void **pointers = reinterpret_cast<void **>(arg);
  for (i = 0; i < NUM_OPENSSL_THREAD_LOCALS; i++) {
    if (destructors[i] != nullptr) {
      destructors[i](pointers[i]);
    }
  }

  free(pointers);
}

static pthread_once_t g_thread_local_init_once = PTHREAD_ONCE_INIT;
static pthread_key_t g_thread_local_key;
static int g_thread_local_key_created = 0;

static void thread_local_init(void) {
  g_thread_local_key_created =
      pthread_key_create(&g_thread_local_key, thread_local_destructor) == 0;
}

void *CRYPTO_get_thread_local(thread_local_data_t index) {
  CRYPTO_once(&g_thread_local_init_once, thread_local_init);
  if (!g_thread_local_key_created) {
    return nullptr;
  }

  void **pointers =
      reinterpret_cast<void **>(pthread_getspecific(g_thread_local_key));
  if (pointers == nullptr) {
    return nullptr;
  }
  return pointers[index];
}

int CRYPTO_set_thread_local(thread_local_data_t index, void *value,
                            thread_local_destructor_t destructor) {
  CRYPTO_once(&g_thread_local_init_once, thread_local_init);
  if (!g_thread_local_key_created) {
    destructor(value);
    return 0;
  }

  void **pointers =
      reinterpret_cast<void **>(pthread_getspecific(g_thread_local_key));
  if (pointers == nullptr) {
    pointers = reinterpret_cast<void **>(
        malloc(sizeof(void *) * NUM_OPENSSL_THREAD_LOCALS));
    if (pointers == nullptr) {
      destructor(value);
      return 0;
    }
    OPENSSL_memset(pointers, 0, sizeof(void *) * NUM_OPENSSL_THREAD_LOCALS);
    if (pthread_setspecific(g_thread_local_key, pointers) != 0) {
      free(pointers);
      destructor(value);
      return 0;
    }
  }

  if (pthread_mutex_lock(&g_destructors_lock) != 0) {
    destructor(value);
    return 0;
  }
  g_destructors[index] = destructor;
  pthread_mutex_unlock(&g_destructors_lock);

  pointers[index] = value;
  return 1;
}

#endif  // OPENSSL_PTHREADS
