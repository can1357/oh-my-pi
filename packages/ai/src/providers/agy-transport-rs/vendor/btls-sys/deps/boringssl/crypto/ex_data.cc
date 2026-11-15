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

#include <openssl/ex_data.h>

#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/mem.h>

#include "internal.h"


struct crypto_ex_data_func_st {
  long argl;   // Arbitrary long
  void *argp;  // Arbitrary void pointer
  CRYPTO_EX_free *free_func;
  // next points to the next |CRYPTO_EX_DATA_FUNCS| or NULL if this is the last
  // one. It may only be read if synchronized with a read from |num_funcs|.
  CRYPTO_EX_DATA_FUNCS *next;
};

int CRYPTO_get_ex_new_index_ex(CRYPTO_EX_DATA_CLASS *ex_data_class, long argl,
                               void *argp, CRYPTO_EX_free *free_func) {
  CRYPTO_EX_DATA_FUNCS *funcs = reinterpret_cast<CRYPTO_EX_DATA_FUNCS *>(
      OPENSSL_malloc(sizeof(CRYPTO_EX_DATA_FUNCS)));
  if (funcs == nullptr) {
    return -1;
  }

  funcs->argl = argl;
  funcs->argp = argp;
  funcs->free_func = free_func;
  funcs->next = nullptr;

  CRYPTO_MUTEX_lock_write(&ex_data_class->lock);

  uint32_t num_funcs = ex_data_class->num_funcs.load();
  // The index must fit in |int|.
  if (num_funcs > (size_t)(INT_MAX - ex_data_class->num_reserved)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
    CRYPTO_MUTEX_unlock_write(&ex_data_class->lock);
    return -1;
  }

  // Append |funcs| to the linked list.
  if (ex_data_class->last == nullptr) {
    assert(num_funcs == 0);
    ex_data_class->funcs = funcs;
    ex_data_class->last = funcs;
  } else {
    ex_data_class->last->next = funcs;
    ex_data_class->last = funcs;
  }

  ex_data_class->num_funcs.store(num_funcs + 1);
  CRYPTO_MUTEX_unlock_write(&ex_data_class->lock);
  return (int)num_funcs + ex_data_class->num_reserved;
}

int CRYPTO_set_ex_data(CRYPTO_EX_DATA *ad, int index, void *val) {
  if (index < 0) {
    // A caller that can accidentally pass in an invalid index into this
    // function will hit an memory error if |index| happened to be valid, and
    // expected |val| to be of a different type.
    abort();
  }

  if (ad->sk == nullptr) {
    ad->sk = sk_void_new_null();
    if (ad->sk == nullptr) {
      return 0;
    }
  }

  // Add NULL values until the stack is long enough.
  for (size_t i = sk_void_num(ad->sk); i <= (size_t)index; i++) {
    if (!sk_void_push(ad->sk, nullptr)) {
      return 0;
    }
  }

  sk_void_set(ad->sk, (size_t)index, val);
  return 1;
}

void *CRYPTO_get_ex_data(const CRYPTO_EX_DATA *ad, int idx) {
  if (ad->sk == nullptr || idx < 0 || (size_t)idx >= sk_void_num(ad->sk)) {
    return nullptr;
  }
  return sk_void_value(ad->sk, idx);
}

void CRYPTO_new_ex_data(CRYPTO_EX_DATA *ad) { ad->sk = nullptr; }

void CRYPTO_free_ex_data(CRYPTO_EX_DATA_CLASS *ex_data_class,
                         CRYPTO_EX_DATA *ad) {
  if (ad->sk == nullptr) {
    // Nothing to do.
    return;
  }

  uint32_t num_funcs = ex_data_class->num_funcs.load();
  // |CRYPTO_get_ex_new_index_ex| will not allocate indices beyond |INT_MAX|.
  assert(num_funcs <= (size_t)(INT_MAX - ex_data_class->num_reserved));

  // Defer dereferencing |ex_data_class->funcs| and |funcs->next|. It must come
  // after the |num_funcs| comparison to be correctly synchronized.
  CRYPTO_EX_DATA_FUNCS *const *funcs = &ex_data_class->funcs;
  for (uint32_t i = 0; i < num_funcs; i++) {
    if ((*funcs)->free_func != nullptr) {
      int index = (int)i + ex_data_class->num_reserved;
      void *ptr = CRYPTO_get_ex_data(ad, index);
      (*funcs)->free_func(/*parent=*/nullptr, ptr, /*ad*/ nullptr, index,
                          (*funcs)->argl, (*funcs)->argp);
    }
    funcs = &(*funcs)->next;
  }

  sk_void_free(ad->sk);
  ad->sk = nullptr;
}

void CRYPTO_cleanup_all_ex_data(void) {}
