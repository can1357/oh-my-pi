// Copyright 2002-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/bn.h>
#include <openssl/dsa.h>


struct wrapped_callback {
  void (*callback)(int, int, void *);
  void *arg;
};

// callback_wrapper converts an “old” style generation callback to the newer
// |BN_GENCB| form.
static int callback_wrapper(int event, int n, BN_GENCB *gencb) {
  struct wrapped_callback *wrapped = (struct wrapped_callback *) gencb->arg;
  wrapped->callback(event, n, wrapped->arg);
  return 1;
}

DSA *DSA_generate_parameters(int bits, uint8_t *seed_in, int seed_len,
                             int *counter_ret, unsigned long *h_ret,
                             void (*callback)(int, int, void *), void *cb_arg) {
  if (bits < 0 || seed_len < 0) {
      return nullptr;
  }

  bssl::UniquePtr<DSA> ret(DSA_new());
  if (ret == nullptr) {
    return nullptr;
  }

  BN_GENCB gencb_storage;
  BN_GENCB *cb = nullptr;
  struct wrapped_callback wrapped;
  if (callback != nullptr) {
    wrapped.callback = callback;
    wrapped.arg = cb_arg;

    cb = &gencb_storage;
    BN_GENCB_set(cb, callback_wrapper, &wrapped);
  }

  if (!DSA_generate_parameters_ex(ret.get(), bits, seed_in, seed_len,
                                  counter_ret, h_ret, cb)) {
    return nullptr;
  }

  return ret.release();
}
