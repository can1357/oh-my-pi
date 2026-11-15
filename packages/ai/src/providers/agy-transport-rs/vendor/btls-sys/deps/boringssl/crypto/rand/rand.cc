// Copyright 2017 The BoringSSL Authors
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

#include <limits.h>

#include <openssl/rand.h>

#include "../bcm_support.h"
#include "../fipsmodule/bcm_interface.h"


int RAND_bytes(uint8_t *buf, size_t len) {
  BCM_rand_bytes(buf, len);
  return 1;
}

int RAND_pseudo_bytes(uint8_t *buf, size_t len) { return RAND_bytes(buf, len); }

void RAND_seed(const void *buf, int num) {
  // OpenSSH calls |RAND_seed| before jailing on the assumption that any needed
  // file descriptors etc will be opened.
  uint8_t unused;
  RAND_bytes(&unused, sizeof(unused));
}

int RAND_load_file(const char *path, long num) {
  if (num < 0) {  // read the "whole file"
    return 1;
  } else if (num <= INT_MAX) {
    return (int)num;
  } else {
    return INT_MAX;
  }
}

const char *RAND_file_name(char *buf, size_t num) { return nullptr; }

void RAND_add(const void *buf, int num, double entropy) {}

int RAND_egd(const char *path) { return 255; }

int RAND_poll(void) { return 1; }

int RAND_status(void) { return 1; }

static const struct rand_meth_st kSSLeayMethod = {
    RAND_seed, RAND_bytes,        RAND_cleanup,
    RAND_add,  RAND_pseudo_bytes, RAND_status,
};

RAND_METHOD *RAND_SSLeay(void) { return (RAND_METHOD *)&kSSLeayMethod; }

RAND_METHOD *RAND_OpenSSL(void) { return RAND_SSLeay(); }

const RAND_METHOD *RAND_get_rand_method(void) { return RAND_SSLeay(); }

int RAND_set_rand_method(const RAND_METHOD *method) { return 1; }

void RAND_cleanup(void) {}

void RAND_get_system_entropy_for_custom_prng(uint8_t *buf, size_t len) {
  if (len > 256) {
    abort();
  }
  CRYPTO_sysrand_for_seed(buf, len);
}
