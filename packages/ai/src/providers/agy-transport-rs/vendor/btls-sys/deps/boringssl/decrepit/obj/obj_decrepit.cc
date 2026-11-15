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

#include <openssl/obj.h>

#include <assert.h>
#include <string.h>

#include <openssl/evp.h>

#include "../../crypto/internal.h"


struct wrapped_callback {
  void (*callback)(const OBJ_NAME *, void *arg);
  void *arg;
};

static void cipher_callback(const EVP_CIPHER *cipher, const char *name,
                            const char *unused, void *arg) {
  const struct wrapped_callback *wrapped = (struct wrapped_callback *)arg;
  OBJ_NAME obj_name;

  OPENSSL_memset(&obj_name, 0, sizeof(obj_name));
  obj_name.type = OBJ_NAME_TYPE_CIPHER_METH;
  obj_name.name = name;
  obj_name.data = (const char *)cipher;

  wrapped->callback(&obj_name, wrapped->arg);
}

static void md_callback(const EVP_MD *md, const char *name, const char *unused,
                        void *arg) {
  const struct wrapped_callback *wrapped = (struct wrapped_callback*) arg;
  OBJ_NAME obj_name;

  OPENSSL_memset(&obj_name, 0, sizeof(obj_name));
  obj_name.type = OBJ_NAME_TYPE_MD_METH;
  obj_name.name = name;
  obj_name.data = (const char *)md;

  wrapped->callback(&obj_name, wrapped->arg);
}

void OBJ_NAME_do_all_sorted(int type,
                            void (*callback)(const OBJ_NAME *, void *arg),
                            void *arg) {
  struct wrapped_callback wrapped;
  wrapped.callback = callback;
  wrapped.arg = arg;

  if (type == OBJ_NAME_TYPE_CIPHER_METH) {
    EVP_CIPHER_do_all_sorted(cipher_callback, &wrapped);
  } else if (type == OBJ_NAME_TYPE_MD_METH) {
    EVP_MD_do_all_sorted(md_callback, &wrapped);
  } else {
    assert(0);
  }
}

void OBJ_NAME_do_all(int type, void (*callback)(const OBJ_NAME *, void *arg),
                     void *arg) {
  OBJ_NAME_do_all_sorted(type, callback, arg);
}
