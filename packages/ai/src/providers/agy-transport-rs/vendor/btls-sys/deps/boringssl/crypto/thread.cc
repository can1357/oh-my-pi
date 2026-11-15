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

#include <openssl/thread.h>


int CRYPTO_num_locks(void) { return 1; }

void CRYPTO_set_locking_callback(void (*func)(int mode, int lock_num,
                                              const char *file, int line)) {}

void (*CRYPTO_get_locking_callback(void))(int mode, int lock_num,
                                          const char *file, int line) {
  return nullptr;
}

void CRYPTO_set_add_lock_callback(int (*func)(int *num, int mount, int lock_num,
                                              const char *file, int line)) {}

const char *CRYPTO_get_lock_name(int lock_num) {
  return "No old-style OpenSSL locks anymore";
}

int CRYPTO_THREADID_set_callback(void (*func)(CRYPTO_THREADID *)) { return 1; }

void CRYPTO_THREADID_set_numeric(CRYPTO_THREADID *id, unsigned long val) {}

void CRYPTO_THREADID_set_pointer(CRYPTO_THREADID *id, void *ptr) {}

void CRYPTO_THREADID_current(CRYPTO_THREADID *id) {}

void CRYPTO_set_id_callback(unsigned long (*func)(void)) {}

void CRYPTO_set_dynlock_create_callback(struct CRYPTO_dynlock_value *(
    *dyn_create_function)(const char *file, int line)) {}

void CRYPTO_set_dynlock_lock_callback(void (*dyn_lock_function)(
    int mode, struct CRYPTO_dynlock_value *l, const char *file, int line)) {}

void CRYPTO_set_dynlock_destroy_callback(void (*dyn_destroy_function)(
    struct CRYPTO_dynlock_value *l, const char *file, int line)) {}

struct CRYPTO_dynlock_value *(*CRYPTO_get_dynlock_create_callback(void))(
    const char *file, int line) {
  return nullptr;
}

void (*CRYPTO_get_dynlock_lock_callback(void))(int mode,
                                               struct CRYPTO_dynlock_value *l,
                                               const char *file, int line) {
  return nullptr;
}

void (*CRYPTO_get_dynlock_destroy_callback(void))(
    struct CRYPTO_dynlock_value *l, const char *file, int line) {
  return nullptr;
}
