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

#include <openssl/engine.h>

#include <assert.h>
#include <string.h>

#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/rsa.h>

#include "../internal.h"


struct engine_st {
  RSA_METHOD *rsa_method;
  ECDSA_METHOD *ecdsa_method;
};

ENGINE *ENGINE_new(void) {
  return reinterpret_cast<ENGINE *>(OPENSSL_zalloc(sizeof(ENGINE)));
}

int ENGINE_free(ENGINE *engine) {
  // Methods are currently required to be static so are not unref'ed.
  OPENSSL_free(engine);
  return 1;
}

// set_method takes a pointer to a method and its given size and sets
// |*out_member| to point to it. This function might want to be extended in the
// future to support making a copy of the method so that a stable ABI for
// ENGINEs can be supported. But, for the moment, all *_METHODS must be
// static.
static int set_method(void **out_member, const void *method, size_t method_size,
                      size_t compiled_size) {
  const struct openssl_method_common_st *common =
      reinterpret_cast<const openssl_method_common_st *>(method);
  if (method_size != compiled_size || !common->is_static) {
    return 0;
  }

  *out_member = (void *)method;
  return 1;
}

int ENGINE_set_RSA_method(ENGINE *engine, const RSA_METHOD *method,
                          size_t method_size) {
  return set_method((void **)&engine->rsa_method, method, method_size,
                    sizeof(RSA_METHOD));
}

RSA_METHOD *ENGINE_get_RSA_method(const ENGINE *engine) {
  return engine->rsa_method;
}

int ENGINE_set_ECDSA_method(ENGINE *engine, const ECDSA_METHOD *method,
                            size_t method_size) {
  return set_method((void **)&engine->ecdsa_method, method, method_size,
                    sizeof(ECDSA_METHOD));
}

ECDSA_METHOD *ENGINE_get_ECDSA_method(const ENGINE *engine) {
  return engine->ecdsa_method;
}

void METHOD_ref(void *method_in) {
  assert(((struct openssl_method_common_st *)method_in)->is_static);
}

void METHOD_unref(void *method_in) {
  struct openssl_method_common_st *method =
      reinterpret_cast<openssl_method_common_st *>(method_in);

  if (method == nullptr) {
    return;
  }
  assert(method->is_static);
}

OPENSSL_DECLARE_ERROR_REASON(ENGINE, OPERATION_NOT_SUPPORTED)
