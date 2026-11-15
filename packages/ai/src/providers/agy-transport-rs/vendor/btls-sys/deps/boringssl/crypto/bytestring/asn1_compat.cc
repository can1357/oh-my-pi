// Copyright 2016 The BoringSSL Authors
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


#include <openssl/bytestring.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <openssl/mem.h>

#include "internal.h"
#include "../internal.h"


int CBB_finish_i2d(CBB *cbb, uint8_t **outp) {
  assert(!cbb->is_child);
  assert(cbb->u.base.can_resize);

  uint8_t *der;
  size_t der_len;
  if (!CBB_finish(cbb, &der, &der_len)) {
    CBB_cleanup(cbb);
    return -1;
  }
  if (der_len > INT_MAX) {
    OPENSSL_free(der);
    return -1;
  }
  if (outp != nullptr) {
    if (*outp == nullptr) {
      *outp = der;
      der = nullptr;
    } else {
      OPENSSL_memcpy(*outp, der, der_len);
      *outp += der_len;
    }
  }
  OPENSSL_free(der);
  return (int)der_len;
}
