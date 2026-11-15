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

#include "internal.h"

#include <assert.h>
#include <stdlib.h>


void CRYPTO_refcount_inc(CRYPTO_refcount_t *count) {
  uint32_t expected = count->load();

  while (expected != CRYPTO_REFCOUNT_MAX) {
    uint32_t new_value = expected + 1;
    if (count->compare_exchange_weak(expected, new_value)) {
      break;
    }
  }
}

int CRYPTO_refcount_dec_and_test_zero(CRYPTO_refcount_t *count) {
  uint32_t expected = count->load();

  for (;;) {
    if (expected == 0) {
      abort();
    } else if (expected == CRYPTO_REFCOUNT_MAX) {
      return 0;
    } else {
      const uint32_t new_value = expected - 1;
      if (count->compare_exchange_weak(expected, new_value)) {
        return new_value == 0;
      }
    }
  }
}
