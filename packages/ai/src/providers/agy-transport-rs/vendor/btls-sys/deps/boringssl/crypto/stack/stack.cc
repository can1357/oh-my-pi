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

#include <openssl/stack.h>

#include <assert.h>
#include <limits.h>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../internal.h"


struct stack_st {
  // num contains the number of valid pointers in |data|.
  size_t num;
  void **data;
  // sorted is non-zero if the values pointed to by |data| are in ascending
  // order, based on |comp|.
  int sorted;
  // num_alloc contains the number of pointers allocated in the buffer pointed
  // to by |data|, which may be larger than |num|.
  size_t num_alloc;
  // comp is an optional comparison function.
  OPENSSL_sk_cmp_func comp;
};

// kMinSize is the number of pointers that will be initially allocated in a new
// stack.
static const size_t kMinSize = 4;

OPENSSL_STACK *OPENSSL_sk_new(OPENSSL_sk_cmp_func comp) {
  OPENSSL_STACK *ret =
      reinterpret_cast<OPENSSL_STACK *>(OPENSSL_zalloc(sizeof(OPENSSL_STACK)));
  if (ret == nullptr) {
    return nullptr;
  }

  ret->data =
      reinterpret_cast<void **>(OPENSSL_calloc(kMinSize, sizeof(void *)));
  if (ret->data == nullptr) {
    goto err;
  }

  ret->comp = comp;
  ret->num_alloc = kMinSize;

  return ret;

err:
  OPENSSL_free(ret);
  return nullptr;
}

OPENSSL_STACK *OPENSSL_sk_new_null(void) { return OPENSSL_sk_new(nullptr); }

size_t OPENSSL_sk_num(const OPENSSL_STACK *sk) {
  if (sk == nullptr) {
    return 0;
  }
  return sk->num;
}

void OPENSSL_sk_zero(OPENSSL_STACK *sk) {
  if (sk == nullptr || sk->num == 0) {
    return;
  }
  OPENSSL_memset(sk->data, 0, sizeof(void *) * sk->num);
  sk->num = 0;
  sk->sorted = 0;
}

void *OPENSSL_sk_value(const OPENSSL_STACK *sk, size_t i) {
  if (!sk || i >= sk->num) {
    return nullptr;
  }
  return sk->data[i];
}

void *OPENSSL_sk_set(OPENSSL_STACK *sk, size_t i, void *value) {
  if (!sk || i >= sk->num) {
    return nullptr;
  }
  return sk->data[i] = value;
}

void OPENSSL_sk_free(OPENSSL_STACK *sk) {
  if (sk == nullptr) {
    return;
  }
  OPENSSL_free(sk->data);
  OPENSSL_free(sk);
}

void OPENSSL_sk_pop_free_ex(OPENSSL_STACK *sk,
                            OPENSSL_sk_call_free_func call_free_func,
                            OPENSSL_sk_free_func free_func) {
  if (sk == nullptr) {
    return;
  }

  for (size_t i = 0; i < sk->num; i++) {
    if (sk->data[i] != nullptr) {
      call_free_func(free_func, sk->data[i]);
    }
  }
  OPENSSL_sk_free(sk);
}

// Historically, |sk_pop_free| called the function as |OPENSSL_sk_free_func|
// directly. This is undefined in C. Some callers called |sk_pop_free| directly,
// so we must maintain a compatibility version for now.
static void call_free_func_legacy(OPENSSL_sk_free_func func, void *ptr) {
  func(ptr);
}

void sk_pop_free(OPENSSL_STACK *sk, OPENSSL_sk_free_func free_func) {
  OPENSSL_sk_pop_free_ex(sk, call_free_func_legacy, free_func);
}

size_t OPENSSL_sk_insert(OPENSSL_STACK *sk, void *p, size_t where) {
  if (sk == nullptr) {
    return 0;
  }

  if (sk->num >= INT_MAX) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
    return 0;
  }

  if (sk->num_alloc <= sk->num + 1) {
    // Attempt to double the size of the array.
    size_t new_alloc = sk->num_alloc << 1;
    size_t alloc_size = new_alloc * sizeof(void *);
    void **data;

    // If the doubling overflowed, try to increment.
    if (new_alloc < sk->num_alloc || alloc_size / sizeof(void *) != new_alloc) {
      new_alloc = sk->num_alloc + 1;
      alloc_size = new_alloc * sizeof(void *);
    }

    // If the increment also overflowed, fail.
    if (new_alloc < sk->num_alloc || alloc_size / sizeof(void *) != new_alloc) {
      return 0;
    }

    data = reinterpret_cast<void **>(OPENSSL_realloc(sk->data, alloc_size));
    if (data == nullptr) {
      return 0;
    }

    sk->data = data;
    sk->num_alloc = new_alloc;
  }

  if (where >= sk->num) {
    sk->data[sk->num] = p;
  } else {
    OPENSSL_memmove(&sk->data[where + 1], &sk->data[where],
                    sizeof(void *) * (sk->num - where));
    sk->data[where] = p;
  }

  sk->num++;
  sk->sorted = 0;

  return sk->num;
}

void *OPENSSL_sk_delete(OPENSSL_STACK *sk, size_t where) {
  void *ret;

  if (!sk || where >= sk->num) {
    return nullptr;
  }

  ret = sk->data[where];

  if (where != sk->num - 1) {
    OPENSSL_memmove(&sk->data[where], &sk->data[where + 1],
                    sizeof(void *) * (sk->num - where - 1));
  }

  sk->num--;
  return ret;
}

void *OPENSSL_sk_delete_ptr(OPENSSL_STACK *sk, const void *p) {
  if (sk == nullptr) {
    return nullptr;
  }

  for (size_t i = 0; i < sk->num; i++) {
    if (sk->data[i] == p) {
      return OPENSSL_sk_delete(sk, i);
    }
  }

  return nullptr;
}

void OPENSSL_sk_delete_if(OPENSSL_STACK *sk,
                          OPENSSL_sk_call_delete_if_func call_func,
                          OPENSSL_sk_delete_if_func func, void *data) {
  if (sk == nullptr) {
    return;
  }

  size_t new_num = 0;
  for (size_t i = 0; i < sk->num; i++) {
    if (!call_func(func, sk->data[i], data)) {
      sk->data[new_num] = sk->data[i];
      new_num++;
    }
  }
  sk->num = new_num;
}

int OPENSSL_sk_find(const OPENSSL_STACK *sk, size_t *out_index, const void *p,
                    OPENSSL_sk_call_cmp_func call_cmp_func) {
  if (sk == nullptr) {
    return 0;
  }

  if (sk->comp == nullptr) {
    // Use pointer equality when no comparison function has been set.
    for (size_t i = 0; i < sk->num; i++) {
      if (sk->data[i] == p) {
        if (out_index) {
          *out_index = i;
        }
        return 1;
      }
    }
    return 0;
  }

  if (p == nullptr) {
    return 0;
  }

  if (!OPENSSL_sk_is_sorted(sk)) {
    for (size_t i = 0; i < sk->num; i++) {
      if (call_cmp_func(sk->comp, p, sk->data[i]) == 0) {
        if (out_index) {
          *out_index = i;
        }
        return 1;
      }
    }
    return 0;
  }

  // The stack is sorted, so binary search to find the element.
  //
  // |lo| and |hi| maintain a half-open interval of where the answer may be. All
  // indices such that |lo <= idx < hi| are candidates.
  size_t lo = 0, hi = sk->num;
  while (lo < hi) {
    // Bias |mid| towards |lo|. See the |r == 0| case below.
    size_t mid = lo + (hi - lo - 1) / 2;
    assert(lo <= mid && mid < hi);
    int r = call_cmp_func(sk->comp, p, sk->data[mid]);
    if (r > 0) {
      lo = mid + 1;  // |mid| is too low.
    } else if (r < 0) {
      hi = mid;  // |mid| is too high.
    } else {
      // |mid| matches. However, this function returns the earliest match, so we
      // can only return if the range has size one.
      if (hi - lo == 1) {
        if (out_index != nullptr) {
          *out_index = mid;
        }
        return 1;
      }
      // The sample is biased towards |lo|. |mid| can only be |hi - 1| if
      // |hi - lo| was one, so this makes forward progress.
      assert(mid + 1 < hi);
      hi = mid + 1;
    }
  }

  assert(lo == hi);
  return 0;  // Not found.
}

void *OPENSSL_sk_shift(OPENSSL_STACK *sk) {
  if (sk == nullptr) {
    return nullptr;
  }
  if (sk->num == 0) {
    return nullptr;
  }
  return OPENSSL_sk_delete(sk, 0);
}

size_t OPENSSL_sk_push(OPENSSL_STACK *sk, void *p) {
  return OPENSSL_sk_insert(sk, p, sk->num);
}

void *OPENSSL_sk_pop(OPENSSL_STACK *sk) {
  if (sk == nullptr) {
    return nullptr;
  }
  if (sk->num == 0) {
    return nullptr;
  }
  return OPENSSL_sk_delete(sk, sk->num - 1);
}

OPENSSL_STACK *OPENSSL_sk_dup(const OPENSSL_STACK *sk) {
  if (sk == nullptr) {
    return nullptr;
  }

  OPENSSL_STACK *ret =
      reinterpret_cast<OPENSSL_STACK *>(OPENSSL_zalloc(sizeof(OPENSSL_STACK)));
  if (ret == nullptr) {
    return nullptr;
  }

  ret->data = reinterpret_cast<void **>(
      OPENSSL_memdup(sk->data, sizeof(void *) * sk->num_alloc));
  if (ret->data == nullptr) {
    goto err;
  }

  ret->num = sk->num;
  ret->sorted = sk->sorted;
  ret->num_alloc = sk->num_alloc;
  ret->comp = sk->comp;
  return ret;

err:
  OPENSSL_sk_free(ret);
  return nullptr;
}

static size_t parent_idx(size_t idx) {
  assert(idx > 0);
  return (idx - 1) / 2;
}

static size_t left_idx(size_t idx) {
  // The largest possible index is |PTRDIFF_MAX|, not |SIZE_MAX|. If
  // |ptrdiff_t|, a signed type, is the same size as |size_t|, this cannot
  // overflow.
  assert(idx <= PTRDIFF_MAX);
  static_assert(PTRDIFF_MAX <= (SIZE_MAX - 1) / 2, "2 * idx + 1 may overflow");
  return 2 * idx + 1;
}

// down_heap fixes the subtree rooted at |i|. |i|'s children must each satisfy
// the heap property. Only the first |num| elements of |sk| are considered.
static void down_heap(OPENSSL_STACK *sk, OPENSSL_sk_call_cmp_func call_cmp_func,
                      size_t i, size_t num) {
  assert(i < num && num <= sk->num);
  for (;;) {
    size_t left = left_idx(i);
    if (left >= num) {
      break;  // No left child.
    }

    // Swap |i| with the largest of its children.
    size_t next = i;
    if (call_cmp_func(sk->comp, sk->data[next], sk->data[left]) < 0) {
      next = left;
    }
    size_t right = left + 1;  // Cannot overflow because |left < num|.
    if (right < num &&
        call_cmp_func(sk->comp, sk->data[next], sk->data[right]) < 0) {
      next = right;
    }

    if (i == next) {
      break;  // |i| is already larger than its children.
    }

    void *tmp = sk->data[i];
    sk->data[i] = sk->data[next];
    sk->data[next] = tmp;
    i = next;
  }
}

void OPENSSL_sk_sort(OPENSSL_STACK *sk,
                     OPENSSL_sk_call_cmp_func call_cmp_func) {
  if (sk == nullptr || sk->comp == nullptr || sk->sorted) {
    return;
  }

  if (sk->num >= 2) {
    // |qsort| lacks a context parameter in the comparison function for us to
    // pass in |call_cmp_func| and |sk->comp|. While we could cast |sk->comp| to
    // the expected type, it is undefined behavior in C can trip sanitizers.
    // |qsort_r| and |qsort_s| avoid this, but using them is impractical. See
    // https://stackoverflow.com/a/39561369
    //
    // Use our own heap sort instead. This is not performance-sensitive, so we
    // optimize for simplicity and size. First, build a max-heap in place.
    for (size_t i = parent_idx(sk->num - 1); i < sk->num; i--) {
      down_heap(sk, call_cmp_func, i, sk->num);
    }

    // Iteratively remove the maximum element to populate the result in reverse.
    for (size_t i = sk->num - 1; i > 0; i--) {
      void *tmp = sk->data[0];
      sk->data[0] = sk->data[i];
      sk->data[i] = tmp;
      down_heap(sk, call_cmp_func, 0, i);
    }
  }
  sk->sorted = 1;
}

int OPENSSL_sk_is_sorted(const OPENSSL_STACK *sk) {
  if (!sk) {
    return 1;
  }
  // Zero- and one-element lists are always sorted.
  return sk->sorted || (sk->comp != nullptr && sk->num < 2);
}

OPENSSL_sk_cmp_func OPENSSL_sk_set_cmp_func(OPENSSL_STACK *sk,
                                            OPENSSL_sk_cmp_func comp) {
  OPENSSL_sk_cmp_func old = sk->comp;

  if (sk->comp != comp) {
    sk->sorted = 0;
  }
  sk->comp = comp;

  return old;
}

OPENSSL_STACK *OPENSSL_sk_deep_copy(const OPENSSL_STACK *sk,
                                    OPENSSL_sk_call_copy_func call_copy_func,
                                    OPENSSL_sk_copy_func copy_func,
                                    OPENSSL_sk_call_free_func call_free_func,
                                    OPENSSL_sk_free_func free_func) {
  OPENSSL_STACK *ret = OPENSSL_sk_dup(sk);
  if (ret == nullptr) {
    return nullptr;
  }

  for (size_t i = 0; i < ret->num; i++) {
    if (ret->data[i] == nullptr) {
      continue;
    }
    ret->data[i] = call_copy_func(copy_func, ret->data[i]);
    if (ret->data[i] == nullptr) {
      for (size_t j = 0; j < i; j++) {
        if (ret->data[j] != nullptr) {
          call_free_func(free_func, ret->data[j]);
        }
      }
      OPENSSL_sk_free(ret);
      return nullptr;
    }
  }

  return ret;
}

OPENSSL_STACK *sk_new_null(void) { return OPENSSL_sk_new_null(); }

size_t sk_num(const OPENSSL_STACK *sk) { return OPENSSL_sk_num(sk); }

void *sk_value(const OPENSSL_STACK *sk, size_t i) {
  return OPENSSL_sk_value(sk, i);
}

void sk_free(OPENSSL_STACK *sk) { OPENSSL_sk_free(sk); }

size_t sk_push(OPENSSL_STACK *sk, void *p) { return OPENSSL_sk_push(sk, p); }

void *sk_pop(OPENSSL_STACK *sk) { return OPENSSL_sk_pop(sk); }

void sk_pop_free_ex(OPENSSL_STACK *sk, OPENSSL_sk_call_free_func call_free_func,
                    OPENSSL_sk_free_func free_func) {
  OPENSSL_sk_pop_free_ex(sk, call_free_func, free_func);
}
