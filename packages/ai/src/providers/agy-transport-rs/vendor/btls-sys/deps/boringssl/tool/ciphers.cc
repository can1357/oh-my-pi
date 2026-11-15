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

#include <string>
#include <vector>

#include <stdint.h>
#include <stdlib.h>

#include <openssl/ssl.h>

#include "internal.h"


bool Ciphers(const std::vector<std::string> &args) {
  bool openssl_name = false;
  if (args.size() == 2 && args[0] == "-openssl-name") {
    openssl_name = true;
  } else if (args.size() != 1) {
    fprintf(stderr,
            "Usage: bssl ciphers [-openssl-name] <cipher suite string>\n");
    return false;
  }

  const std::string &ciphers_string = args.back();

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  if (!SSL_CTX_set_strict_cipher_list(ctx.get(), ciphers_string.c_str())) {
    fprintf(stderr, "Failed to parse cipher suite config.\n");
    ERR_print_errors_fp(stderr);
    return false;
  }

  STACK_OF(SSL_CIPHER) *ciphers = SSL_CTX_get_ciphers(ctx.get());

  bool last_in_group = false;
  for (size_t i = 0; i < sk_SSL_CIPHER_num(ciphers); i++) {
    bool in_group = SSL_CTX_cipher_in_group(ctx.get(), i);
    const SSL_CIPHER *cipher = sk_SSL_CIPHER_value(ciphers, i);

    if (in_group && !last_in_group) {
      printf("[\n  ");
    } else if (last_in_group) {
      printf("  ");
    }

    printf("%s\n", openssl_name ? SSL_CIPHER_get_name(cipher)
                                : SSL_CIPHER_standard_name(cipher));

    if (!in_group && last_in_group) {
      printf("]\n");
    }
    last_in_group = in_group;
  }

  return true;
}
